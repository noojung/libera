import Foundation

/// The UI's bundled files. A packaged app keeps them in Contents/Resources,
/// where code signing expects them; `swift run` and the tests read them from
/// the resource bundle SwiftPM builds.
enum AppResources {
    static func url(_ name: String, _ ext: String, in subdirectory: String? = nil) -> URL? {
        let directory = subdirectory.map { root.appendingPathComponent($0) } ?? root
        let url = directory.appendingPathComponent("\(name).\(ext)")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    static func data(_ name: String, _ ext: String, in subdirectory: String? = nil) -> Data? {
        url(name, ext, in: subdirectory).flatMap { try? Data(contentsOf: $0) }
    }

    /// SwiftPM's own accessor looks beside the .app bundle, which a signed app
    /// cannot hold, so it is only the fallback.
    private static let root: URL = {
        if let packaged = Bundle.main.resourceURL, FileManager.default.fileExists(atPath: packaged.appendingPathComponent("strings.json").path) {
            return packaged
        }
        let bundle = Bundle.module.bundleURL
        let copied = bundle.appendingPathComponent("Resources")
        return FileManager.default.fileExists(atPath: copied.appendingPathComponent("strings.json").path) ? copied : bundle
    }()
}
