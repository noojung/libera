import Foundation
import LiberaCore

enum Screen: String, CaseIterable {
    case compress, extract, inspect, queue

    var titleKey: String { "titleBar." + (self == .inspect ? "inspector" : rawValue) }

    var icon: String {
        switch self {
        case .compress: "archive"
        case .extract: "layers"
        case .inspect: "search"
        case .queue: "list-todo"
        }
    }
}

/// The dialogs the app opens over its screens.
enum Sheet: String, Identifiable {
    case about, licenses, supportedFormats, unsupportedFormat

    var id: String { rawValue }
}

/// What the app shows and what each screen has been handed, mirroring the
/// state App.tsx keeps.
@MainActor final class AppModel: ObservableObject {
    let settings: AppSettings
    let queue: JobQueue

    @Published var screen: Screen = .compress
    /// Open dialogs, the last on top. A detail view opened from another -
    /// licenses from About, say - returns to it when closed.
    @Published private(set) var sheets: [Sheet] = []
    @Published var compressItems: [SelectedItem] = []
    @Published var extractItems: [SelectedItem] = []
    /// Why some of the last archives offered for extraction were left out.
    @Published var extractInputErrorKey: String?

    init(settings: AppSettings, queue: JobQueue? = nil) {
        self.settings = settings
        self.queue = queue ?? JobQueue()
    }

    var sheet: Sheet? { sheets.last }

    func present(_ sheet: Sheet) {
        if sheets.last != sheet { sheets.append(sheet) }
    }

    func dismissSheet() {
        _ = sheets.popLast()
    }

    func addCompressInputs(_ paths: [String]) async {
        let stats = await Task.detached { itemStats(paths: paths) }.value
        var seen = Set(compressItems.map(\.path))
        compressItems += stats.filter { seen.insert($0.path).inserted }.map(SelectedItem.init)
    }

    /// Keeps the archives among `paths`, each split set once however many of
    /// its volumes arrive, and says why anything else was left out.
    func addExtractInputs(_ paths: [String]) async {
        let stats = await Task.detached { itemStats(paths: paths) }.value
        let accepted = stats.filter { !$0.isDirectory && isSupportedArchivePath(path: $0.path) }
        var seen = Set<String>()
        let candidates = accepted.filter { seen.insert(ArchivePaths.volumeGroupKey($0.path)).inserted }

        let (resolved, failure) = await Task.detached { () -> ([ResolvedArchive], Failure?) in
            var resolved: [ResolvedArchive] = []
            var failure: Failure?
            for candidate in candidates {
                do {
                    resolved.append(try resolveExtractionInput(path: candidate.path))
                } catch {
                    failure = failure ?? Failure(error, during: .extraction)
                }
            }
            return (resolved, failure)
        }.value

        let errorKey = failure?.messageKey ?? (accepted.count < stats.count ? "dropZone.invalidExtractInput" : nil)
        let unsupported = errorKey == "dropZone.invalidExtractInput" || errorKey == "errors.unsupportedArchive"
        extractInputErrorKey = unsupported ? nil : errorKey
        if unsupported { present(.unsupportedFormat) }

        var groups = Set(extractItems.map { ArchivePaths.volumeGroupKey($0.path) })
        extractItems += resolved.filter { groups.insert(ArchivePaths.volumeGroupKey($0.path)).inserted }.map(SelectedItem.init)
    }

    func clearExtractItems() {
        extractItems = []
        extractInputErrorKey = nil
    }

    /// Hands the selection to the queue, which owns it from here on.
    func startCompress(_ options: CompressionOptions) {
        guard !compressItems.isEmpty else { return }
        queue.compress(compressItems, options: options)
        compressItems = []
        screen = .queue
    }

    func startExtract(_ request: ExtractionRequest) {
        guard !extractItems.isEmpty else { return }
        queue.extract(extractItems, request: request)
        clearExtractItems()
        screen = .queue
    }
}
