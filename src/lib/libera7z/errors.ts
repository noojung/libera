export type Libera7zErrorCode =
  | 'INVALID_ARCHIVE'
  | 'UNSUPPORTED_METHOD'
  | 'UNSUPPORTED_FEATURE'
  | 'CRC_MISMATCH'
  | 'LIMIT_EXCEEDED'
  | 'CANCELLED'

export class Libera7zError extends Error {
  constructor(
    public readonly code: Libera7zErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'Libera7zError'
  }
}

export function invalidArchive(message: string): Libera7zError {
  return new Libera7zError('INVALID_ARCHIVE', message)
}

export function unsupportedFeature(message: string): Libera7zError {
  return new Libera7zError('UNSUPPORTED_FEATURE', message)
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Libera7zError('CANCELLED', '7z operation was cancelled')
}
