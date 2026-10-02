import AppKit
import LiberaCore
import UniformTypeIdentifiers

/// The open and save panels, shown as sheets on the main window.
@MainActor enum FilePanels {
    /// Files, or files and folders, to compress.
    static func chooseInputs(title: String, folders: Bool) async -> [String] {
        let panel = NSOpenPanel()
        panel.message = title
        panel.canChooseFiles = true
        panel.canChooseDirectories = folders
        panel.allowsMultipleSelection = true
        return await present(panel) == .OK ? panel.urls.map(\.path) : []
    }

    /// Archives to extract. A filter takes literal extensions, so of a split
    /// set only the volume one would reach for first is offered.
    static func chooseArchives(title: String) async -> [String] {
        let panel = NSOpenPanel()
        panel.message = title
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = ArchivePaths.extractDialogExtensions.compactMap { UTType(filenameExtension: $0) }
        return await present(panel) == .OK ? panel.urls.map(\.path) : []
    }

    static func chooseFolder(title: String) async -> String? {
        let panel = NSOpenPanel()
        panel.message = title
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        return await present(panel) == .OK ? panel.url?.path : nil
    }

    /// Where to write an archive, carrying the format's extension whatever
    /// the panel hands back.
    static func chooseArchiveDestination(defaultName: String, format: ArchiveFormat) async -> String? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = defaultName
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        panel.allowsOtherFileTypes = true
        if let type = UTType(filenameExtension: format.saveDialogExtension) {
            panel.allowedContentTypes = [type]
        }
        guard await present(panel) == .OK, let url = panel.url else { return nil }
        return ArchivePaths.withArchiveExtension(url.path, format: format)
    }

    /// Selects `path` in a Finder window.
    static func reveal(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    /// Where an archive goes when no destination was picked.
    static var defaultOutputDirectory: String {
        let manager = FileManager.default
        for directory in [FileManager.SearchPathDirectory.downloadsDirectory, .documentDirectory] {
            if let url = manager.urls(for: directory, in: .userDomainMask).first,
               manager.fileExists(atPath: url.path) {
                return url.path
            }
        }
        return manager.homeDirectoryForCurrentUser.path
    }

    private static func present(_ panel: NSSavePanel) async -> NSApplication.ModalResponse {
        guard let window = NSApp.keyWindow ?? NSApp.mainWindow else { return panel.runModal() }
        return await panel.beginSheetModal(for: window)
    }
}

/// The file paths carried by a drop.
enum DroppedFiles {
    static func paths(from providers: [NSItemProvider]) async -> [String] {
        var paths: [String] = []
        for provider in providers where provider.canLoadObject(ofClass: URL.self) {
            let url: URL? = await withCheckedContinuation { continuation in
                _ = provider.loadObject(ofClass: URL.self) { url, _ in continuation.resume(returning: url) }
            }
            if let url, url.isFileURL { paths.append(url.path) }
        }
        return paths
    }
}
