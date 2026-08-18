import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { resolveSevenZipBinaryPath, SevenZipUnavailableError } from './sevenZipBinary'

// Driving the bundled 7-Zip executable. Everything that knows about argv
// shapes, exit codes and the progress chatter on stdout lives here so the
// format adapters can stay declarative.

export type SevenZipErrorCode =
  | 'SEVEN_ZIP_UNAVAILABLE'
  | 'SEVEN_ZIP_PASSWORD_REQUIRED'
  | 'SEVEN_ZIP_WRONG_PASSWORD'
  | 'SEVEN_ZIP_CANCELLED'
  | 'SEVEN_ZIP_FAILED'

export class SevenZipError extends Error {
  constructor(
    public readonly code: SevenZipErrorCode,
    message: string,
    public readonly exitCode?: number
  ) {
    super(message)
    this.name = 'SevenZipError'
  }
}

export interface SevenZipProgress {
  percent: number
  currentFile?: string
}

export interface SevenZipRunOptions {
  signal?: AbortSignal
  /** Suppresses the informational banner so stdout carries only entry data. */
  quiet?: boolean
  onProgress?: (progress: SevenZipProgress) => void
  onLine?: (line: string) => void
  timeoutMs?: number
}

export interface SevenZipRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * 7-Zip redraws its progress in place with carriage returns and backspaces
 * rather than emitting whole lines, so those have to count as separators or
 * the percentage never surfaces until the process exits.
 */
export function splitSevenZipChunks(text: string): string[] {
  return text.split(/[\r\n\b]+/)
}

const PROGRESS_PATTERN = /(\d{1,3})%/
const LOG_LINE_PATTERN = /^[-+] (.+)$/

/**
 * Reads one redraw fragment. 7-Zip writes `<percent>%`, optionally followed by
 * a running file count and a name; `-bb1` emits the filename separately as
 * `- name` (extract) or `+ name` (add), which is the more reliable source.
 */
export function parseSevenZipProgressLine(chunk: string): SevenZipProgress | null {
  const trimmed = chunk.trim()
  if (!trimmed) return null

  const logMatch = LOG_LINE_PATTERN.exec(trimmed)
  if (logMatch) return { percent: -1, currentFile: logMatch[1] }

  const percentMatch = PROGRESS_PATTERN.exec(trimmed)
  if (!percentMatch) return null

  const percent = Number(percentMatch[1])
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null
  return { percent }
}

const WRONG_PASSWORD_PATTERNS = [
  /wrong password/i,
  /can ?not open encrypted archive/i,
  /data error in encrypted file/i
]

export function isWrongSevenZipPasswordText(text: string): boolean {
  return WRONG_PASSWORD_PATTERNS.some(pattern => pattern.test(text))
}

/**
 * Maps a finished process onto an error, or null when it succeeded. Exit 1 is
 * 7-Zip's "warning" status (an unreadable input file, say) and is deliberately
 * treated as success, matching how the archiver path tolerates warnings.
 *
 * A header-encrypted archive reports a missing password and a wrong password
 * with exactly the same text, so the two are told apart by whether the caller
 * supplied one at all.
 */
export function classifySevenZipExit(
  exitCode: number,
  stderr: string,
  suppliedPassword: boolean
): SevenZipError | null {
  if (exitCode === 0 || exitCode === 1) return null
  if (exitCode === 255) return new SevenZipError('SEVEN_ZIP_CANCELLED', '7-Zip was stopped', exitCode)

  if (isWrongSevenZipPasswordText(stderr)) {
    return suppliedPassword
      ? new SevenZipError('SEVEN_ZIP_WRONG_PASSWORD', 'Wrong archive password', exitCode)
      : new SevenZipError('SEVEN_ZIP_PASSWORD_REQUIRED', 'The archive needs a password', exitCode)
  }

  const detail = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' ') || `exit code ${exitCode}`
  return new SevenZipError('SEVEN_ZIP_FAILED', `7-Zip failed: ${detail}`, exitCode)
}

/**
 * Always passes `-y` and a `-p` argument even when there is no password: given
 * an encrypted archive and no `-p`, 7-Zip prompts on the console and, with
 * stdio piped, waits forever. `stdin: 'ignore'` is the second line of defence.
 */
export function buildSevenZipArguments(args: string[], password: string | undefined): string[] {
  return ['-y', `-p${password ?? ''}`, ...args]
}

export interface SevenZipSpawn {
  child: ChildProcessWithoutNullStreams
  binaryPath: string
}

export async function spawnSevenZip(
  args: string[],
  password: string | undefined,
  stdoutMode: 'pipe' | 'inherit' = 'pipe'
): Promise<SevenZipSpawn> {
  const binaryPath = await resolveSevenZipBinaryPath()
  const child = spawn(binaryPath, buildSevenZipArguments(args, password), {
    stdio: ['ignore', stdoutMode, 'pipe'],
    windowsHide: true
  }) as ChildProcessWithoutNullStreams
  return { child, binaryPath }
}

/**
 * Runs 7-Zip to completion, buffering stdout. Cancellation kills the child
 * explicitly rather than relying on spawn's `signal` option, so that callers
 * can clean up partial output deterministically once this settles.
 */
export async function runSevenZip(
  args: string[],
  password: string | undefined,
  options: SevenZipRunOptions = {}
): Promise<SevenZipRunResult> {
  // An already-aborted signal never fires its 'abort' event, so the cheap
  // check has to happen before anything is spawned.
  if (options.signal?.aborted) throw new SevenZipError('SEVEN_ZIP_CANCELLED', '7-Zip was cancelled')

  const { child } = await spawnSevenZip(args, password)

  let stdout = ''
  let stderr = ''
  let pendingChunk = ''
  let cancelled = false
  let timedOut = false

  const emitChunks = (text: string) => {
    if (!options.onProgress && !options.onLine) return
    pendingChunk += text
    const chunks = splitSevenZipChunks(pendingChunk)
    pendingChunk = chunks.pop() ?? ''
    for (const chunk of chunks) {
      options.onLine?.(chunk)
      const progress = parseSevenZipProgressLine(chunk)
      if (progress) options.onProgress?.(progress)
    }
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (text: string) => {
    stdout += text
    emitChunks(text)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text: string) => {
    stderr += text
  })

  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  const onAbort = () => {
    cancelled = true
    kill()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true
        kill()
      }, options.timeoutMs)
    : null

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', code => resolve(code ?? 0))
    })

    if (cancelled) throw new SevenZipError('SEVEN_ZIP_CANCELLED', '7-Zip was cancelled')
    if (timedOut) throw new SevenZipError('SEVEN_ZIP_FAILED', '7-Zip timed out')

    const failure = classifySevenZipExit(exitCode, stderr, password !== undefined)
    if (failure) throw failure

    return { stdout, stderr, exitCode }
  } catch (error) {
    if (error instanceof SevenZipError || error instanceof SevenZipUnavailableError) throw error
    throw new SevenZipError('SEVEN_ZIP_FAILED', `7-Zip could not be run: ${(error as Error).message}`)
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
