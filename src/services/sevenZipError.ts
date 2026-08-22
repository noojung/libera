export type SevenZipErrorCode =
  | 'SEVEN_ZIP_PASSWORD_REQUIRED'
  | 'SEVEN_ZIP_WRONG_PASSWORD'
  | 'SEVEN_ZIP_CANCELLED'
  | 'SEVEN_ZIP_FAILED'

export class SevenZipError extends Error {
  constructor(
    public readonly code: SevenZipErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SevenZipError'
  }
}
