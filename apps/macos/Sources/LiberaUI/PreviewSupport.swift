#if DEBUG
import LiberaCore
import SwiftUI

// Xcode's canvas: open apps/macos/Package.swift in Xcode, pick the LiberaUI
// scheme and any file with a #Preview. None of this reaches a release build.

private let registerFonts: Void = Typography.register()

/// Draws a view the way the app does - its fonts, palette, translations and
/// models - so a preview needs nothing but the view and some sample content.
struct PreviewHost<Content: View>: View {
    @StateObject private var model: AppModel
    private let dark: Bool?
    private let content: Content

    /// `dark` pins the theme; left nil, the canvas's color scheme decides.
    init(
        language: AppLanguage = .ko, expert: Bool = false, dark: Bool? = nil,
        setUp: @MainActor (AppModel) -> Void = { _ in }, @ViewBuilder content: () -> Content
    ) {
        _ = registerFonts
        let model = AppModel(settings: AppSettings(defaults: nil, preferredLanguages: []))
        model.settings.language = language
        model.settings.expert = expert
        setUp(model)
        _model = StateObject(wrappedValue: model)
        self.dark = dark
        self.content = content()
    }

    var body: some View {
        Themed(content: content)
            .environmentObject(model).environmentObject(model.settings)
            .environmentObject(model.queue).environmentObject(model.inspector)
            .environment(\.localizer, Localizer(language: model.settings.language))
            .modifier(SchemeOverride(dark: dark))
    }

    private struct Themed<Inner: View>: View {
        @Environment(\.colorScheme) private var scheme
        let content: Inner

        var body: some View {
            let palette = Palette(dark: scheme == .dark)
            content.environment(\.palette, palette).background(palette.background).foregroundStyle(palette.text)
        }
    }
}

private struct SchemeOverride: ViewModifier {
    let dark: Bool?

    @ViewBuilder func body(content: Content) -> some View {
        if let dark { content.environment(\.colorScheme, dark ? .dark : .light) } else { content }
    }
}

/// The window's size, for previews of whole screens and dialogs.
extension View {
    func previewWindow() -> some View { frame(width: 1050, height: 720) }
}

/// Content for previews, standing in for files, jobs and archives.
@MainActor enum PreviewSamples {
    static let compressItems = [
        SelectedItem(path: "/Users/me/Documents/Project", name: "Project", isDirectory: true, size: 12_582_912),
        SelectedItem(path: "/Users/me/Desktop/분기 보고서.pdf", name: "분기 보고서.pdf", isDirectory: false, size: 734_003),
    ]

    static let extractItems = [
        SelectedItem(
            path: "/Users/me/Downloads/photos.zip", name: "photos.zip", isDirectory: false, size: 2_202_009_600,
            volumes: (1...2).map { ArchiveVolume(path: "/Users/me/Downloads/photos.z0\($0)", name: "photos.z0\($0)", size: 1_073_741_824) }
                + [ArchiveVolume(path: "/Users/me/Downloads/photos.zip", name: "photos.zip", size: 54_525_952)]
        ),
        SelectedItem(path: "/Users/me/Downloads/backup.tar.zst", name: "backup.tar.zst", isDirectory: false, size: 48_234_496),
    ]

    static var jobs: [Job] {
        [
            Job(kind: .compress, sourceName: "Project", itemCount: 1, format: "7z", outputPath: "/Users/me/Downloads/Project.7z",
                status: .running, phase: .processing, processedBytes: 5_452_595, totalBytes: 12_582_912, percent: 43,
                currentFile: "Project/src/engine.rs"),
            Job(kind: .extract, sourceName: "photos.zip", itemCount: 1, format: "zip", outputPath: "/Users/me/Downloads/photos",
                status: .pending, phase: .extracting),
            Job(kind: .compress, sourceName: nil, itemCount: 3, format: "tgz", outputPath: "/Users/me/Downloads/archive.tar.gz",
                status: .completed, phase: .complete, percent: 100, durationMs: 1_840, originalSize: 41_943_040,
                compressedSize: 15_728_640, volumeCount: nil),
            Job(kind: .extract, sourceName: "secret.zip", itemCount: 1, format: "zip", outputPath: "/Users/me/Downloads/secret",
                status: .failed, phase: .extracting, failure: Failure(code: "wrongArchivePassword")),
        ]
    }

    static let inspection: ArchiveInspection = {
        let block = SolidBlockInfo(id: 1, fileCount: 3, uncompressedSize: 61_440, compressedSize: 18_432)
        func entry(_ index: UInt64, _ path: String, _ size: UInt64, solid: Bool = true, codec: String = "LZMA2") -> InspectedEntry {
            InspectedEntry(
                index: index, name: (path as NSString).lastPathComponent, path: path, isDirectory: false, size: size,
                compressedSize: solid ? nil : size, solidBlock: solid ? block : nil, ratio: solid ? 70 : 0,
                modified: Date(timeIntervalSince1970: 1_790_000_000), codec: codec, crc32: 0xA3B2_4D08 &+ UInt32(index),
                encrypted: false, encryptionMethod: "None", mode: 0o100644, modeString: "-rw-r--r--", offset: nil
            )
        }
        let entries = [
            entry(0, "docs/README.md", 12_729), entry(1, "docs/가이드.md", 8_311), entry(2, "src/main.rs", 40_400),
            entry(3, "assets/logo.png", 88_899, solid: false, codec: "Copy"),
        ]
        return ArchiveInspection(
            archivePath: "/Users/me/Downloads/project.7z", format: "7Z", volumes: nil, passwordProtected: false,
            totalFiles: UInt64(entries.count), totalUncompressedSize: 150_339, totalCompressedSize: 107_331, overallRatio: 28.6,
            entries: entries,
            header: ArchiveHeaderInfo(
                signature: "37 7A BC AF 27 1C (7z)", formatVersion: "0.4", codecSummary: "LZMA2, Copy", encryptionAlgorithm: nil,
                solid: true, centralDirectoryOffset: nil, centralDirectorySize: nil, nextHeaderOffset: 107_331, nextHeaderSize: 312
            )
        )
    }()

    static let textPreview: PreviewState = {
        let text = "# Libera\n\nLibera는 파일과 폴더를 압축하고, 압축 파일을 안전하게 풀고, 내용을 살펴보는 도구입니다.\n"
        return PreviewState(
            entry: inspection.entries[0], loading: false,
            result: .text(
                text: text, encoding: .utf8, truncated: false, previewedBytes: UInt64(text.utf8.count),
                totalBytes: UInt64(text.utf8.count), rawBytes: Data(text.utf8)
            )
        )
    }()
}
#endif
