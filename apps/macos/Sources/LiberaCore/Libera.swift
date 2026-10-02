import Foundation

/// libera-core's jobs as async calls. The core blocks until a job ends, so each
/// one runs on a thread of its own, and cancelling the calling task cancels
/// the job through its `CancelToken`.
public enum Libera {
    public static func compress(
        _ options: CompressionOptions,
        onProgress: @escaping @Sendable (ProgressData) -> Void = { _ in }
    ) async throws -> CompressionResult {
        try await run(onProgress) { listener, token in
            try compressArchive(options: options, listener: listener, cancel: token)
        }
    }

    public static func extract(
        _ options: ExtractionOptions,
        onProgress: @escaping @Sendable (ProgressData) -> Void = { _ in }
    ) async throws -> ExtractionResult {
        try await run(onProgress) { listener, token in
            try extractArchive(options: options, listener: listener, cancel: token)
        }
    }

    /// The levels `format`'s writer distinguishes, in slider order. The core
    /// hands them over as bytes, which UniFFI turns into `Data`.
    public static func levels(for format: ArchiveFormat) -> [UInt8] {
        Array(compressionLevels(format: format))
    }

    private static func run<Output: Sendable>(
        _ onProgress: @escaping @Sendable (ProgressData) -> Void,
        _ job: @escaping @Sendable (ProgressListener, CancelToken) throws -> Output
    ) async throws -> Output {
        let token = CancelToken()
        let listener = ClosureListener(onProgress)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    continuation.resume(with: Result { try job(listener, token) })
                }
            }
        } onCancel: {
            token.cancel()
        }
    }
}

private final class ClosureListener: ProgressListener {
    private let handler: @Sendable (ProgressData) -> Void

    init(_ handler: @escaping @Sendable (ProgressData) -> Void) {
        self.handler = handler
    }

    func onProgress(progress: ProgressData) {
        handler(progress)
    }
}
