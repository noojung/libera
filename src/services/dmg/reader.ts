import fs from 'fs'
import path from 'path'
import { Worker } from 'worker_threads'
import { MAX_ARCHIVE_ENTRIES, securityError, throwIfAborted } from '../extractionSafety'

export interface DmgEntry {
  path: string
  isDirectory: boolean
  isLink: boolean
  linkTarget?: string
  size: number
  mode?: number
  date?: string
}

export function isDmgArchivePath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.dmg')
}

function unixMode(value: string | undefined): number | undefined {
  if (!value) return undefined
  if (/^[0-7]{5,7}$/.test(value)) return Number.parseInt(value, 8)
  const match = /([dl-])([rwxstST-]{9})$/.exec(value)
  if (!match) return undefined
  let mode = match[1] === 'd' ? 0o040000 : match[1] === 'l' ? 0o120000 : 0o100000
  for (let i = 0; i < 9; i++) {
    if (match[2][i] !== '-' && match[2][i] !== 'S' && match[2][i] !== 'T') mode |= 1 << (8 - i)
  }
  return mode
}

export function parseDmgListing(listing: string, maxEntries: number): DmgEntry[] {
  const entries: DmgEntry[] = []
  const names = new Set<string>()
  for (const block of listing.replace(/^[\r\n]+|[\r\n]+$/g, '').split(/\r?\n\r?\n/)) {
    if (!block) continue
    const properties = new Map<string, string>()
    for (const line of block.split(/\r?\n/)) {
      const match = /^([^=]+?) = (.*)$/.exec(line)
      if (!match || properties.has(match[1])) throw securityError('Ambiguous DMG entry metadata')
      properties.set(match[1], match[2])
    }
    const name = properties.get('Path')
    if (!name || /[\0\r\n]/.test(name) || names.has(name)) throw securityError('Invalid or duplicate DMG entry path')
    names.add(name)
    if (names.size > maxEntries) throw securityError('DMG contains too many entries', 'TOO_MANY_ENTRIES')
    // Resource forks and extended attributes are not regular payload files.
    if (properties.get('Alternate Stream') === '+') continue
    const mode = unixMode(properties.get('Mode'))
    if ((properties.get('Mode') && mode === undefined) ||
        (mode !== undefined && ![0o040000, 0o100000, 0o120000].includes(mode & 0o170000))) {
      throw securityError('Unsupported DMG file type')
    }
    // APFS reports Mode rather than a Folder property. Raw DMG partitions
    // expose neither, and must not be mistaken for extracted payload files.
    if (mode === undefined && !['+', '-'].includes(properties.get('Folder') ?? '')) {
      throw new Error('Unsupported DMG filesystem: cannot list the files inside this disk image')
    }
    const isDirectory = properties.get('Folder') === '+' || (mode !== undefined && (mode & 0o170000) === 0o040000)
    const sizeText = properties.get('Size')
    const size = isDirectory ? 0 : Number(sizeText)
    if (!isDirectory && (!sizeText || !/^\d+$/.test(sizeText) || !Number.isSafeInteger(size))) {
      throw securityError('Invalid DMG entry size')
    }
    entries.push({ path: name, size, isDirectory, mode, isLink: Boolean(properties.get('Symbolic Link')) || (mode !== undefined && (mode & 0o170000) === 0o120000),
      linkTarget: properties.get('Symbolic Link') || undefined,
      date: properties.get('Modified') || undefined })
  }
  return entries
}

/** Isolated, cancellable WASM reader, shared by listing, preview and extraction. */
export class DmgReader {
  entries: DmgEntry[] = []
  private readonly acknowledgement = new Int32Array(new SharedArrayBuffer(4))
  private readonly worker: Worker
  private closed = false
  private closing?: Promise<void>

  private constructor(archivePath: string) {
    const packagedRoot = path.resolve(__dirname, '../worker/dmg')
    const packaged = fs.existsSync(path.join(packagedRoot, 'worker.cjs'))
    this.worker = new Worker(packaged ? path.join(packagedRoot, 'worker.cjs') : path.resolve('src/services/dmg/worker.cjs'), {
      trackUnmanagedFds: true,
      workerData: {
        archivePath: path.resolve(archivePath),
        enginePath: packaged ? path.join(packagedRoot, '7zz.cjs') : require.resolve('7z-wasm'),
        acknowledgement: this.acknowledgement.buffer
      }
    })
  }

  static async open(archivePath: string, maxEntries = MAX_ARCHIVE_ENTRIES, signal?: AbortSignal): Promise<DmgReader> {
    throwIfAborted(signal)
    const reader = new DmgReader(archivePath)
    try {
      const listing = await reader.run({ kind: 'list', maxBytes: 64 * 1024 * 1024 }, undefined, signal)
      reader.entries = parseDmgListing(listing ?? '', maxEntries)
      return reader
    } catch (error) {
      await reader.close()
      throw error
    }
  }

  private run(request: { kind: string; maxBytes: number; entryPath?: string }, onData?: (bytes: Buffer) => Promise<void>, signal?: AbortSignal): Promise<string | undefined> {
    throwIfAborted(signal)
    if (this.closed) return Promise.reject(new Error('DMG reader is closed'))
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener('abort', abort)
        this.worker.off('message', message)
        this.worker.off('error', fail)
        this.worker.off('exit', exit)
      }
      const fail = (error: Error) => { cleanup(); void this.close(); reject(error) }
      const abort = () => {
        try { throwIfAborted(signal) } catch (error) { fail(error as Error) }
      }
      const exit = (code: number) => fail(new Error(`DMG worker exited unexpectedly (${code})`))
      const message = async (event: { kind: string; bytes?: Uint8Array; listing?: string; message?: string }) => {
        if (event.kind === 'data') {
          try {
            await onData!(Buffer.from(event.bytes!))
            Atomics.store(this.acknowledgement, 0, 1)
            Atomics.notify(this.acknowledgement, 0)
          } catch (error) { fail(error as Error) }
        } else if (event.kind === 'error') fail(new Error(event.message))
        else if (event.kind === 'done') { cleanup(); resolve(event.listing) }
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.worker.on('message', message)
      this.worker.once('error', fail)
      this.worker.once('exit', exit)
      this.worker.postMessage(request)
    })
  }

  async read(entry: DmgEntry, maxBytes: number, onData: (bytes: Buffer) => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (entry.isDirectory) throw new Error('Cannot read a DMG directory')
    await this.run({ kind: 'read', entryPath: entry.path, maxBytes }, onData, signal)
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = this.worker.terminate().then(() => undefined)
    return this.closing
  }
}
