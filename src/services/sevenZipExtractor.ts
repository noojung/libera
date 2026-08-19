import { promises as fsPromises } from 'fs'
import type { ProgressCallback } from './compressor'
import { classifySevenZipExit, spawnSevenZip } from './sevenZip'
import { listSevenZipEntries, type SevenZipEntry } from './sevenZipList'
import {
  archivePermissions,
  buildExtractionPlan,
  createOwnedSymlink,
  createOwnedWebWriter,
  ensureSafeDirectory,
  ensureSafeParentDirectories,
  ExtractionMeter,
  ExtractionTransaction,
  extractionError,
  matchesSelectedEntry,
  propagateQuarantine,
  restoresSymbolicLinks,
  restoresUnixMode,
  securityError,
  throwIfAborted,
  topLevelSegment,
  validateSelectedDestinations,
  type ExtractionPolicy,
  type PlannedEntry
} from './extractionSafety'

// Extracting .7z. 7-Zip writes files itself when told to, which would put
// every safety check in this app out of the loop, so it is asked for one
// stdout stream instead: `x -so` emits each entry's contents back to back in
// listing order, and the listing gives their exact sizes. Splitting that
// stream at the declared boundaries means the ordinary writers, meter and
// transaction do the work, exactly as they do for ZIP.
//
// Reading precisely the declared byte count is also what catches an archive
// whose headers understate a size: the stream then ends short or runs long,
// and both are refused below.

const STREAM_HIGH_WATER_MARK = 8 * 1024 * 1024

/** Pulls exactly the requested byte counts out of a stream, in order. */
export class StreamSplitter {
  private readonly chunks: Buffer[] = []
  private queuedBytes = 0
  private paused = false
  private ended = false
  private waiting: (() => void) | null = null
  private failure: Error | null = null

  constructor(private readonly source: NodeJS.ReadableStream) {
    source.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk)
      this.queuedBytes += chunk.length
      if (!this.paused && this.queuedBytes >= STREAM_HIGH_WATER_MARK) {
        this.paused = true
        source.pause()
      }
      this.wake()
    })
    source.on('end', () => {
      this.ended = true
      this.wake()
    })
    source.on('error', (error: Error) => {
      this.failure = error
      this.ended = true
      this.wake()
    })
  }

  private wake(): void {
    const waiting = this.waiting
    this.waiting = null
    waiting?.()
  }

  private async fill(): Promise<void> {
    if (this.ended || this.queuedBytes > 0) return
    await new Promise<void>(resolve => {
      this.waiting = resolve
    })
  }

  /** Yields an entry's bytes, stopping early only if the stream runs out. */
  async *take(byteCount: number): AsyncGenerator<Buffer> {
    let remaining = byteCount
    while (remaining > 0) {
      if (this.queuedBytes === 0) {
        await this.fill()
        if (this.failure) throw this.failure
        if (this.queuedBytes === 0 && this.ended) return
      }

      const head = this.chunks[0]
      const take = Math.min(remaining, head.length)
      const chunk = take === head.length ? this.chunks.shift()! : head.subarray(0, take)
      if (take !== head.length) this.chunks[0] = head.subarray(take)
      this.queuedBytes -= take
      remaining -= take

      if (this.paused && this.queuedBytes < STREAM_HIGH_WATER_MARK) {
        this.paused = false
        this.source.resume()
      }

      yield chunk
    }
  }

  async read(byteCount: number): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of this.take(byteCount)) chunks.push(chunk)
    return Buffer.concat(chunks)
  }

  /** True when the stream held exactly what the listing accounted for. */
  async isExhausted(): Promise<boolean> {
    await this.fill()
    if (this.failure) throw this.failure
    return this.queuedBytes === 0 && this.ended
  }
}

const CHILD_EXIT_GRACE_MS = 5_000

interface SevenZipStream {
  splitter: StreamSplitter
  finish: () => Promise<void>
  kill: () => Promise<void>
}

/**
 * Starts `x -so`. Nothing is written to disk by 7-Zip itself; `-bso0 -bse0`
 * keep its own chatter off the stream so stdout is pure entry content.
 */
async function openContentStream(
  archivePath: string,
  password: string | undefined,
  entryPaths: string[],
  signal: AbortSignal | undefined
): Promise<SevenZipStream> {
  const { child } = await spawnSevenZip(
    ['x', '-so', '-bso0', '-bse0', '--', archivePath, ...entryPaths],
    password
  )

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text: string) => {
    stderr += text
  })

  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => resolve(code ?? 0))
  })
  const settled = exited.catch(() => undefined)

  const detach = () => signal?.removeEventListener('abort', onAbort)

  const kill = async () => {
    detach()
    if (child.exitCode === null && child.signalCode === null) {
      child.stdout.destroy()
      child.kill()
    }
    await Promise.race([
      settled,
      new Promise<void>(resolve => setTimeout(resolve, CHILD_EXIT_GRACE_MS).unref())
    ])
  }
  const onAbort = () => {
    void kill()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  return {
    splitter: new StreamSplitter(child.stdout),
    kill,
    finish: async () => {
      detach()
      const exitCode = await exited
      const failure = classifySevenZipExit(exitCode, stderr, password !== undefined)
      if (failure) throw failure
    }
  }
}

/**
 * Reads the targets of every symbolic link that will be extracted. A link's
 * target is its entry content, and the plan has to validate it before anything
 * is created, so they are fetched in one pass of their own rather than being
 * discovered midway through writing.
 */
async function readLinkTargets(
  archivePath: string,
  password: string | undefined,
  links: SevenZipEntry[],
  signal: AbortSignal | undefined
): Promise<Map<string, string>> {
  const targets = new Map<string, string>()
  if (links.length === 0) return targets

  const stream = await openContentStream(archivePath, password, links.map(link => link.path), signal)
  try {
    for (const link of links) {
      const raw = await stream.splitter.read(link.size)
      if (raw.length !== link.size) throw securityError(`symlink entry is truncated: ${link.path}`)
      targets.set(link.path, raw.toString('utf8'))
    }
    await stream.finish()
  } finally {
    await stream.kill()
  }

  return targets
}

export async function extractSevenZipArchive(
  archivePath: string,
  targetRoot: string,
  selectedEntries: string[] | undefined,
  password: string | undefined,
  startTime: number,
  policy: ExtractionPolicy,
  diskBudget: number,
  transaction: ExtractionTransaction,
  signal?: AbortSignal,
  onProgress?: ProgressCallback
): Promise<{ targetDir: string; extractedCount: number; durationMs: number }> {
  const listing = await listSevenZipEntries(archivePath, {
    password,
    signal,
    maxEntries: policy.maxEntries
  })

  const selectedPaths = selectedEntries ? new Set(selectedEntries) : null
  const isSelected = (entry: SevenZipEntry) => matchesSelectedEntry(entry.path, selectedPaths)

  // Only links that will actually be extracted are worth a lookup; on Windows
  // none are, and the plan then rejects them with the usual message.
  const linkTargets = restoresSymbolicLinks
    ? await readLinkTargets(
        archivePath,
        password,
        listing.entries.filter(entry => entry.isSymlink && !entry.isDirectory && isSelected(entry)),
        signal
      )
    : new Map<string, string>()

  const plan = buildExtractionPlan(
    listing.entries.map(entry => ({
      archivePath: entry.path,
      isDirectory: entry.isDirectory,
      size: entry.isDirectory ? 0 : entry.size,
      isLink: entry.isSymlink,
      linkTarget: linkTargets.get(entry.path),
      mode: restoresUnixMode ? entry.mode : undefined
    })),
    targetRoot,
    selectedPaths,
    policy
  )

  if (plan.selectedTotalBytes > diskBudget) {
    throw extractionError('INSUFFICIENT_DISK_SPACE', 'Not enough disk space for extraction and the configured reserve')
  }
  await validateSelectedDestinations(targetRoot, plan.entries)

  const topLevelNames = new Set(
    plan.entries.filter(entry => entry.shouldExtract).map(entry => topLevelSegment(entry.archivePath))
  )

  // Directories first, so no file arrives before the folder that holds it.
  for (const entry of plan.entries) {
    if (entry.shouldExtract && entry.isDirectory) {
      await ensureSafeDirectory(targetRoot, entry.outputPath, transaction)
    }
  }

  const meter = new ExtractionMeter(policy, diskBudget, plan.selectedTotalBytes, onProgress)
  // 7-Zip streams in listing order whatever order the arguments are in, so the
  // plan is consumed in that order too.
  const streamed = plan.entries.filter(entry => entry.shouldExtract && !entry.isDirectory)

  if (streamed.length > 0) {
    const selectionArguments = selectedPaths ? streamed.map(entry => entry.archivePath) : []
    const stream = await openContentStream(archivePath, password, selectionArguments, signal)

    try {
      for (const entry of streamed) {
        throwIfAborted(signal)
        await ensureSafeParentDirectories(targetRoot, entry.outputPath, transaction)

        if (entry.isLink) {
          // The target was read and validated before anything was created; its
          // bytes still have to be drained to keep the boundaries aligned.
          await stream.splitter.read(entry.size)
          meter.consume(entry.size, 0, entry.archivePath)
          await createOwnedSymlink(entry.outputPath, entry.linkTarget!, transaction)
          continue
        }

        await writeFileEntry(stream.splitter, entry, transaction, meter)
      }

      // Anything left over means a declared size was too small and the entry
      // boundaries have drifted, so nothing written can be trusted.
      if (!(await stream.splitter.isExhausted())) {
        throw securityError(`archive declares less content than it contains: ${archivePath}`)
      }
      await stream.finish()
    } finally {
      await stream.kill()
    }
  }

  meter.complete()
  await propagateQuarantine(archivePath, targetRoot, topLevelNames)

  return { targetDir: targetRoot, extractedCount: streamed.length, durationMs: Date.now() - startTime }
}

async function writeFileEntry(
  splitter: StreamSplitter,
  entry: PlannedEntry,
  transaction: ExtractionTransaction,
  meter: ExtractionMeter
): Promise<void> {
  let fileBytes = 0
  const output = await createOwnedWebWriter(entry.outputPath, transaction, byteLength => {
    fileBytes = meter.consume(byteLength, fileBytes, entry.archivePath)
  })
  const writer = output.writable.getWriter()

  try {
    for await (const chunk of splitter.take(entry.size)) {
      await writer.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    }
    await writer.close()
  } catch (error) {
    await writer.abort().catch(() => undefined)
    throw error
  } finally {
    await output.close()
  }

  if (fileBytes !== entry.size) {
    throw securityError(`archive declares ${entry.size} bytes but supplied ${fileBytes}: ${entry.archivePath}`)
  }

  // Widened only once the contents are complete, matching the ZIP path.
  const mode = entry.mode !== undefined ? archivePermissions(entry.mode) : undefined
  if (mode !== undefined) await fsPromises.chmod(entry.outputPath, mode)
}
