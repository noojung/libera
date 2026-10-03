import Foundation
import LiberaCore

/// A row of the inspector's file table: an entry of the archive, or a folder
/// only implied by the paths below it.
struct BrowserEntry: Identifiable {
    let id: String
    let name: String
    let path: String
    let isDirectory: Bool
    /// Nil for a folder the archive has no entry of its own for.
    let entry: InspectedEntry?
}

/// The files that share one 7z solid block.
struct SolidBlockSummary: Identifiable {
    let id: UInt32
    let fileCount: UInt64
    let uncompressedSize: UInt64
    let compressedSize: UInt64
    let codec: String?
    let ratio: Double?
    var entries: [InspectedEntry]
}

/// What a password the inspector asks for is meant to open.
enum InspectorPrompt: Equatable {
    case listing(path: String, incorrect: Bool)
    case entry(InspectedEntry, incorrect: Bool)

    var incorrect: Bool {
        switch self {
        case let .listing(_, incorrect), let .entry(_, incorrect): incorrect
        }
    }
}

struct PreviewState {
    let entry: InspectedEntry
    var loading = true
    var result: ArchivePreview?
    /// A key under `inspector.preview.errors.`.
    var errorCode: String?
}

/// The inspector's archive and how far into it the user has browsed,
/// following ArchiveInspector.tsx.
@MainActor final class InspectorModel: ObservableObject {
    static let pageSize = 500

    @Published private(set) var archivePath = ""
    @Published private(set) var inspection: ArchiveInspection?
    @Published private(set) var loading = false
    @Published private(set) var errorKey: String?
    @Published private(set) var currentPath = ""
    @Published var searchQuery = "" {
        didSet { visibleCount = Self.pageSize }
    }
    @Published var visibleCount = pageSize
    @Published var volumesExpanded = false
    @Published var blocksPanelOpen = false
    @Published var expandedBlocks: Set<UInt32> = []
    @Published private(set) var selectedBlock: UInt32?
    @Published private(set) var prompt: InspectorPrompt?
    @Published private(set) var preview: PreviewState?

    /// Sorting and search follow the UI's language.
    var language = AppLanguage.en
    /// Shows the unsupported-format dialog, which belongs to the app.
    var onUnsupported: () -> Void = {}

    private var password: String?
    private var inspectionTask: Task<Void, Never>?
    private var previewTask: Task<Void, Never>?
    private var generation = 0
    private var cache: (key: String, entries: [BrowserEntry])?

    var isSearching: Bool { !searchQuery.trimmingCharacters(in: .whitespaces).isEmpty }

    /// A split set's volumes; one file reads as no set at all.
    var splitVolumes: [ArchiveVolume]? {
        guard let volumes = inspection?.volumes, volumes.count > 1 else { return nil }
        return volumes
    }

    var breadcrumbs: [String] { currentPath.isEmpty ? [] : currentPath.components(separatedBy: "/") }

    /// Opens an archive, replacing whatever was shown. A newer request wins
    /// over a slower older one.
    func open(_ path: String, password: String? = nil) {
        guard isSupportedArchivePath(path: path) else { return onUnsupported() }
        inspectionTask?.cancel()
        closePreview()
        loading = true
        inspectionTask = Task {
            do {
                let result = try await Libera.inspect(path, password: password)
                guard !Task.isCancelled else { return }
                generation += 1
                errorKey = nil
                searchQuery = ""
                currentPath = ""
                volumesExpanded = false
                blocksPanelOpen = false
                expandedBlocks = []
                selectedBlock = nil
                inspection = result
                archivePath = result.archivePath.isEmpty ? path : result.archivePath
                self.password = password
                prompt = nil
            } catch let error as LiberaError where error == .PasswordRequired || error == .WrongPassword {
                guard !Task.isCancelled else { return }
                errorKey = nil
                archivePath = path
                inspection = nil
                prompt = .listing(path: path, incorrect: error == .WrongPassword)
            } catch LiberaError.UnsupportedArchive {
                guard !Task.isCancelled else { return }
                onUnsupported()
            } catch {
                guard !Task.isCancelled else { return }
                archivePath = path
                inspection = nil
                errorKey = Failure(error, during: .inspection).messageKey
            }
            loading = false
        }
    }

    /// Reads an entry for the preview dialog, asking for the password when it
    /// turns out to be encrypted.
    func preview(_ entry: InspectedEntry, password override: String? = nil, rawBytes: Bool) {
        guard !entry.isDirectory else { return }
        previewTask?.cancel()
        let path = archivePath
        let password = override ?? self.password
        preview = PreviewState(entry: entry)
        previewTask = Task {
            do {
                let result = try await Libera.preview(path, entryIndex: entry.index, password: password, includeRawBytes: rawBytes)
                guard !Task.isCancelled else { return }
                if override != nil { self.password = override }
                prompt = nil
                preview?.result = result
                preview?.loading = false
            } catch let error as LiberaError where error == .PasswordRequired || error == .WrongPassword {
                // The dialog keeps loading behind the prompt.
                guard !Task.isCancelled else { return }
                prompt = .entry(entry, incorrect: error == .WrongPassword)
            } catch {
                guard !Task.isCancelled else { return }
                preview?.errorCode = Failure(error, during: .preview).code
                preview?.loading = false
            }
        }
    }

    func closePreview() {
        previewTask?.cancel()
        previewTask = nil
        preview = nil
    }

    func answerPrompt(_ password: String?, rawBytes: Bool) {
        guard let prompt else { return }
        self.prompt = nil
        switch prompt {
        case let .listing(path, _):
            if let password { open(path, password: password) }
        case let .entry(entry, _):
            if let password { preview(entry, password: password, rawBytes: rawBytes) } else { closePreview() }
        }
    }

    func move(to path: String) {
        currentPath = path
        searchQuery = ""
    }

    /// Opens the blocks panel at one block.
    func focusBlock(_ id: UInt32) {
        blocksPanelOpen = true
        expandedBlocks.insert(id)
        selectedBlock = id
    }

    func toggleBlock(_ id: UInt32) {
        if expandedBlocks.contains(id) { expandedBlocks.remove(id) } else { expandedBlocks.insert(id) }
    }

    /// The current folder's children, or everything under it that matches
    /// the search.
    var allDisplayedEntries: [BrowserEntry] {
        let key = "\(generation)\u{0}\(currentPath)\u{0}\(searchQuery)\u{0}\(language.rawValue)"
        if let cache, cache.key == key { return cache.entries }
        let entries = computeEntries()
        cache = (key, entries)
        return entries
    }

    var displayedEntries: ArraySlice<BrowserEntry> { allDisplayedEntries.prefix(visibleCount) }

    var solidBlocks: [SolidBlockSummary] {
        var blocks: [UInt32: SolidBlockSummary] = [:]
        for entry in inspection?.entries ?? [] {
            guard let block = entry.solidBlock else { continue }
            if blocks[block.id] == nil {
                blocks[block.id] = SolidBlockSummary(
                    id: block.id, fileCount: block.fileCount, uncompressedSize: block.uncompressedSize,
                    compressedSize: block.compressedSize, codec: entry.codec, ratio: entry.ratio, entries: []
                )
            }
            blocks[block.id]?.entries.append(entry)
        }
        return blocks.values.sorted { $0.id < $1.id }
    }

    private func computeEntries() -> [BrowserEntry] {
        let entries = inspection?.entries ?? []
        let prefix = currentPath.isEmpty ? "" : currentPath + "/"
        guard isSearching else { return Self.children(of: entries, prefix: prefix, current: currentPath, locale: locale) }
        let query = normalizedSearchText(searchQuery)
        return entries.compactMap { entry in
            let path = Self.normalized(entry.path)
            guard prefix.isEmpty || path.hasPrefix(prefix) else { return nil }
            guard normalizedSearchText(entry.name).contains(query) || normalizedSearchText(entry.path).contains(query) else { return nil }
            return BrowserEntry(id: "\(entry.index)", name: entry.name, path: entry.path, isDirectory: entry.isDirectory, entry: entry)
        }
    }

    private var locale: Locale { Locale(identifier: language.rawValue) }

    private func normalizedSearchText(_ text: String) -> String {
        text.precomposedStringWithCanonicalMapping.lowercased(with: locale)
    }

    /// Folders first, then files, each in the language's order, ignoring case.
    private static func children(of entries: [InspectedEntry], prefix: String, current: String, locale: Locale) -> [BrowserEntry] {
        var folders = Set<String>()
        var files: [BrowserEntry] = []
        for entry in entries {
            let path = normalized(entry.path)
            guard !path.isEmpty, path != current, prefix.isEmpty || path.hasPrefix(prefix) else { continue }
            let segments = path.dropFirst(prefix.count).split(separator: "/", omittingEmptySubsequences: false)
            guard let first = segments.first.map(String.init) else { continue }
            if segments.count > 1 || entry.isDirectory {
                folders.insert(first)
            } else {
                files.append(BrowserEntry(id: "\(entry.index)", name: first, path: entry.path, isDirectory: false, entry: entry))
            }
        }
        func ordered(_ a: String, _ b: String) -> Bool {
            a.compare(b, options: [.caseInsensitive, .diacriticInsensitive], range: nil, locale: locale) == .orderedAscending
        }
        let folderRows = folders.sorted(by: ordered).map {
            BrowserEntry(id: "folder:\(prefix)\($0)", name: $0, path: prefix + $0, isDirectory: true, entry: nil)
        }
        return folderRows + files.sorted { ordered($0.name, $1.name) }
    }

    /// Forward slashes, no leading `./`, no trailing slash.
    static func normalized(_ path: String) -> String {
        var path = path.replacingOccurrences(of: "\\", with: "/")
        if path.hasPrefix("./") { path.removeFirst(2) }
        while path.hasSuffix("/") { path.removeLast() }
        return path
    }

    /// A path shown during a search, relative to the current folder.
    func relativeDisplayPath(_ path: String) -> String {
        let normalized = Self.normalized(path)
        let prefix = currentPath.isEmpty ? "" : currentPath + "/"
        let relative = !prefix.isEmpty && normalized.hasPrefix(prefix) ? String(normalized.dropFirst(prefix.count)) : normalized
        return relative.components(separatedBy: "/").joined(separator: " > ")
    }
}

#if DEBUG
extension InspectorModel {
    /// Shows an inspection without reading any archive, for previews.
    func showForPreview(_ inspection: ArchiveInspection) {
        generation += 1
        self.inspection = inspection
        archivePath = inspection.archivePath
    }
}
#endif
