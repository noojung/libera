import AppKit
import Combine
import LiberaCore
import SwiftUI

/// Command line flags, for screenshots taken without touching the UI:
///
///     --screen compress|extract|inspect|queue   --lang en|ko   --theme system|light|dark
///     --expert   --size 1050x720   --sheet about|licenses|supportedFormats|unsupportedFormat
///     --input PATH (repeatable)   --compress-now   --archive PATH (repeatable)   --extract-now
///     --inspect PATH   --preview ENTRY-INDEX   --format zip|tar|gz|tgz|zst|tzst|7z   --solid   --per-file
///     --snapshot OUT.png
///
/// Any of the first three makes the run leave the saved settings alone.
private struct LaunchOptions {
    let arguments = CommandLine.arguments

    func value(_ name: String) -> String? {
        guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
        return arguments[index + 1]
    }

    func values(_ name: String) -> [String] {
        arguments.indices.filter { arguments[$0] == name && $0 + 1 < arguments.count }.map { arguments[$0 + 1] }
    }

    func flag(_ name: String) -> Bool { arguments.contains(name) }

    var scripted: Bool { value("--snapshot") != nil || value("--lang") != nil || value("--theme") != nil || flag("--expert") }

    var size: NSSize {
        let parts = (value("--size") ?? "").split(separator: "x").compactMap { Double($0) }
        return parts.count == 2 ? NSSize(width: parts[0], height: parts[1]) : NSSize(width: 1050, height: 720)
    }
}

@MainActor final class ApplicationDelegate: NSObject, NSApplicationDelegate {
    private let options = LaunchOptions()
    private var window: NSWindow!
    private var settings: AppSettings!
    private var model: AppModel!
    private var observers: Set<AnyCancellable> = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        Typography.register()
        settings = AppSettings(defaults: options.scripted ? nil : .standard)
        if let language = options.value("--lang").flatMap(AppLanguage.init) { settings.language = language }
        if let theme = options.value("--theme").flatMap(ThemePreference.init) { settings.theme = theme }
        if options.flag("--expert") { settings.expert = true }
        model = AppModel(settings: settings)
        if let screen = options.value("--screen").flatMap(Screen.init) { model.screen = screen }
        if let sheet = options.value("--sheet").flatMap(Sheet.init) { model.present(sheet) }
        let form = model.compressionForm
        if let format = ArchiveFormat.allCases.first(where: { $0.id == options.value("--format") }) { form.select(format) }
        if options.flag("--solid") { form.solid = true }
        if options.flag("--per-file") {
            form.setPerFile(true)
            form.overridesOpen = true
        }

        settings.$theme.sink { NSApp.appearance = $0.appearance }.store(in: &observers)

        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: options.size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.title = "Libera"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 800, height: 600)
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName(options.scripted ? "" : "LiberaMainWindow")
        let root = LiberaView().environmentObject(model).environmentObject(settings).environmentObject(model.queue)
            .environmentObject(model.inspector)
        let hosting = NSHostingView(rootView: root)
        hosting.sizingOptions = []
        window.contentView = hosting
        if options.scripted || !window.setFrameUsingName("LiberaMainWindow") { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.mainMenu = mainMenu()
        NSApp.activate(ignoringOtherApps: true)

        let inputs = options.values("--input")
        if !inputs.isEmpty {
            Task {
                await model.addCompressInputs(inputs)
                if options.flag("--compress-now") { compressNow() }
            }
        }
        if let archive = options.value("--inspect") {
            model.screen = .inspect
            model.inspector.open(archive)
            if let index = options.value("--preview").flatMap(UInt64.init) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    if let entry = self.model.inspector.inspection?.entries.first(where: { $0.index == index }) {
                        self.model.inspector.preview(entry, rawBytes: self.settings.expert)
                    }
                }
            }
        }
        let archives = options.values("--archive")
        if !archives.isEmpty {
            Task {
                await model.addExtractInputs(archives)
                if options.flag("--extract-now") {
                    model.startExtract(ExtractionRequest(targetDir: temporaryDirectory().path, createSubfolder: true))
                }
            }
        }
        if let output = options.value("--snapshot") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.snapshot(to: output) }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// Starts the inputs as a ZIP in a temporary folder, to show the queue.
    private func compressNow() {
        let form = CompressionForm()
        if let options = form.options(inputs: model.compressItems.map(\.path), defaultDirectory: temporaryDirectory().path) {
            model.startCompress(options)
        }
    }

    private func temporaryDirectory() -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("libera-snapshot-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func snapshot(to output: String) {
        guard let view = window.contentView else { return }
        view.layoutSubtreeIfNeeded()
        guard let image = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: image)
        do {
            let url = URL(fileURLWithPath: output)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try image.representation(using: .png, properties: [:])?.write(to: url)
            NSApp.terminate(nil)
        } catch {
            fputs("Snapshot failed: \(error)\n", stderr)
            exit(1)
        }
    }

    @objc private func showAbout() {
        model.present(.about)
    }

    private func mainMenu() -> NSMenu {
        let menu = NSMenu()

        let app = NSMenu()
        app.addItem(withTitle: "About Libera", action: #selector(showAbout), keyEquivalent: "").target = self
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Libera", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit Libera", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(submenu(app, title: "Libera"))

        // Text fields take copy and paste from these items' shortcuts.
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        menu.addItem(submenu(edit, title: "Edit"))

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        menu.addItem(submenu(windowMenu, title: "Window"))
        NSApp.windowsMenu = windowMenu
        return menu
    }

    private func submenu(_ menu: NSMenu, title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = ApplicationDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
}
