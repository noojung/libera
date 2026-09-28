import SwiftUI
import AppKit

@MainActor final class ApplicationDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var hosting: NSHostingView<LiberaView>!
    let model = UIModel()
    func applicationDidFinishLaunching(_ notification: Notification) {
        Typography.register()
        let arguments = CommandLine.arguments
        func option(_ name: String) -> String? { guard let index = arguments.firstIndex(of: name), index+1 < arguments.count else { return nil }; return arguments[index+1] }
        model.screen = Screen(rawValue: option("--screen") ?? "compress") ?? .compress
        model.korean = option("--lang") == "ko"
        model.dark = option("--theme") == "dark"
        model.expert = arguments.contains("--expert")
        let dimensions = (option("--size") ?? "1050x720").split(separator: "x").compactMap { Double($0) }
        let size = dimensions.count == 2 ? NSSize(width: dimensions[0], height: dimensions[1]) : NSSize(width: 1050, height: 720)
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Libera — SwiftUI UI Comparison"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 800, height: 600)
        window.isReleasedWhenClosed = false
        hosting = NSHostingView(rootView: LiberaView(model: model))
        hosting.sizingOptions = []
        window.contentView = hosting
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let menu = NSMenu(), appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Libera", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let item = NSMenuItem();item.submenu = appMenu;menu.addItem(item);NSApp.mainMenu = menu
        if let output = option("--snapshot") {
            DispatchQueue.main.asyncAfter(deadline: .now()+1) { self.snapshot(output, size: size) }
        }
    }
    func snapshot(_ output: String, size: NSSize) {
        hosting.layoutSubtreeIfNeeded()
        hosting.displayIfNeeded()
        let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width*2), pixelsHigh: Int(size.height*2), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        image.size = size
        hosting.cacheDisplay(in: hosting.bounds, to: image)
        do {
            let url = URL(fileURLWithPath: output)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try image.representation(using: .png, properties: [:])!.write(to: url)
            NSApp.terminate(nil)
        } catch { fputs("Snapshot failed: \(error)\n", stderr);exit(1) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = ApplicationDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
}
