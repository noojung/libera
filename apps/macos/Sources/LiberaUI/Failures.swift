import Foundation
import LiberaCore

/// What a job was doing when it failed, which picks the generic message for
/// an error with no message of its own.
enum Operation {
    case compression, extraction, inspection, preview
}

/// An error as the renderer reports it: a code naming a message under
/// `errors.` (or `inspector.preview.errors.` for a preview), and the core's
/// own text for diagnostics.
struct Failure: Equatable {
    let code: String
    let detail: String

    init(code: String, detail: String = "") {
        self.code = code
        self.detail = detail
    }

    /// The same classification main.ts's `classifyError` makes.
    init(_ error: Error, during operation: Operation) {
        detail = error.localizedDescription
        guard let error = error as? LiberaError else {
            code = Self.generic(operation)
            return
        }
        code = Self.code(error, operation) ?? Self.generic(operation)
    }

    var messageKey: String { "errors.\(code)" }

    private static func code(_ error: LiberaError, _ operation: Operation) -> String? {
        switch error {
        case .PasswordRequired: return "passwordRequired"
        case .WrongPassword: return "wrongArchivePassword"
        case .SplitVolumeMissing: return "splitVolumeMissing"
        case .SplitVolumeMismatch: return "splitVolumeMismatch"
        case .SplitVolumeUnreadable: return "splitVolumeUnreadable"
        case .EntryNotFound: return "entryNotFound"
        case .EntryNotPreviewable: return "entryNotPreviewable"
        case .NotText: return "notText"
        case .UnsupportedImage: return "unsupportedImage"
        case .InvalidImage: return "invalidImage"
        case .ImageTooLarge: return "imageTooLarge"
        case .ImageDimensionsTooLarge: return "imageDimensionsTooLarge"
        case .PreviewCancelled: return "previewCancelled"
        default: break
        }
        // A preview has messages for the reasons above alone.
        if operation == .preview { return nil }
        switch error {
        case .CompressionCancelled: return "compressionCancelled"
        case .ExtractionCancelled: return "extractionCancelled"
        case .InsufficientDiskSpace: return "insufficientDiskSpace"
        case .DestinationFileTooLarge: return "destinationFileTooLarge"
        case .TooManyEntries: return "tooManyEntries"
        case .ArchiveTooLarge: return "archiveTooLarge"
        case .FileTooLarge: return "fileTooLarge"
        case .DestinationExists: return "destinationExists"
        case .UnsafeArchive: return "unsafeArchive"
        case .SplitSizeTooSmall: return "splitSizeTooSmall"
        case .SplitNotSupportedForFormat: return "splitNotSupportedForFormat"
        case .SplitTooManyVolumes: return "splitTooManyVolumes"
        case .UnsupportedArchive: return "unsupportedArchive"
        case .ArchiveMissing: return "archiveMissing"
        case .InvalidSingleFileInput: return "invalidSingleFileInput"
        default: return nil
        }
    }

    private static func generic(_ operation: Operation) -> String {
        switch operation {
        case .compression: "genericCompression"
        case .extraction: "genericExtraction"
        case .inspection: "genericInspection"
        case .preview: "genericPreview"
        }
    }
}
