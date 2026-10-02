import LiberaCore
import XCTest

@testable import LiberaUI

@MainActor final class InspectorModelTests: XCTestCase {
    private var work: URL!

    override func setUp() async throws {
        work = FileManager.default.temporaryDirectory.appendingPathComponent("LiberaInspectorTests-\(UUID().uuidString)")
        let docs = work.appendingPathComponent("project/docs")
        try FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
        try Data("# Readme\n".utf8).write(to: docs.appendingPathComponent("readme.md"))
        try Data("beta".utf8).write(to: docs.appendingPathComponent("Beta.txt"))
        try Data("top".utf8).write(to: work.appendingPathComponent("project/top.txt"))
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: work)
    }

    private func waitUntil(_ condition: @autoclosure () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<500 where !condition() {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(condition(), "Timed out", file: file, line: line)
    }

    private func archive(_ name: String, format: ArchiveFormat, password: String? = nil, hideNames: Bool = false) async throws -> String {
        let path = work.appendingPathComponent(name).path
        _ = try await Libera.compress(CompressionOptions(
            inputPaths: [work.appendingPathComponent("project").path], outputPath: path, format: format,
            password: password, encryptFileNames: hideNames ? true : nil
        ))
        return path
    }

    func testBrowsesFoldersBeforeFilesAndSearchesBelowTheCurrentOne() async throws {
        let inspector = InspectorModel()
        inspector.open(try await archive("project.zip", format: .zip))
        await waitUntil(inspector.inspection != nil)

        XCTAssertEqual(inspector.allDisplayedEntries.map(\.name), ["project"])
        inspector.move(to: "project")
        XCTAssertEqual(inspector.allDisplayedEntries.map(\.name), ["docs", "top.txt"])
        XCTAssertEqual(inspector.breadcrumbs, ["project"])
        inspector.move(to: "project/docs")
        XCTAssertEqual(inspector.allDisplayedEntries.map(\.name), ["Beta.txt", "readme.md"])

        inspector.move(to: "")
        inspector.searchQuery = "BETA"
        XCTAssertEqual(inspector.allDisplayedEntries.map(\.path), ["project/docs/Beta.txt"])
        XCTAssertEqual(inspector.relativeDisplayPath("project/docs/Beta.txt"), "project > docs > Beta.txt")
        inspector.move(to: "project/docs")
        XCTAssertEqual(inspector.searchQuery, "")
    }

    func testListsSolidBlocks() async throws {
        let path = work.appendingPathComponent("solid.7z").path
        _ = try await Libera.compress(CompressionOptions(
            inputPaths: [work.appendingPathComponent("project").path], outputPath: path, format: .sevenZip, solidArchive: true
        ))
        let inspector = InspectorModel()
        inspector.open(path)
        await waitUntil(inspector.inspection != nil)
        let blocks = inspector.solidBlocks
        XCTAssertEqual(blocks.count, 1)
        XCTAssertEqual(blocks.first?.entries.count, 3)

        inspector.focusBlock(try XCTUnwrap(blocks.first?.id))
        XCTAssertTrue(inspector.blocksPanelOpen)
        XCTAssertEqual(inspector.selectedBlock, blocks.first?.id)
    }

    func testAsksForThePasswordHiddenNamesNeed() async throws {
        let path = try await archive("hidden.7z", format: .sevenZip, password: "pw", hideNames: true)
        let inspector = InspectorModel()
        inspector.open(path)
        await waitUntil(inspector.prompt != nil)
        XCTAssertEqual(inspector.prompt, .listing(path: path, incorrect: false))

        inspector.answerPrompt("wrong", rawBytes: false)
        await waitUntil(inspector.prompt?.incorrect == true)
        inspector.answerPrompt("pw", rawBytes: false)
        await waitUntil(inspector.inspection != nil)
        XCTAssertNil(inspector.prompt)

        // The listing's password opens the entries too.
        let readme = try XCTUnwrap(inspector.inspection?.entries.first { $0.path.hasSuffix("readme.md") })
        inspector.preview(readme, rawBytes: true)
        await waitUntil(inspector.preview?.loading == false)
        guard case let .text(text, _, _, _, _, rawBytes)? = inspector.preview?.result else {
            return XCTFail("Expected text, got \(String(describing: inspector.preview))")
        }
        XCTAssertEqual(text, "# Readme\n")
        XCTAssertEqual(rawBytes, Data("# Readme\n".utf8))
    }

    func testAsksForAnEntrysPasswordAndGivesUpWithThePreview() async throws {
        let path = try await archive("secret.zip", format: .zip, password: "pw")
        let inspector = InspectorModel()
        inspector.open(path)
        await waitUntil(inspector.inspection != nil)
        let top = try XCTUnwrap(inspector.inspection?.entries.first { $0.path.hasSuffix("top.txt") })

        inspector.preview(top, rawBytes: false)
        await waitUntil(inspector.prompt != nil)
        XCTAssertEqual(inspector.prompt, .entry(top, incorrect: false))
        XCTAssertEqual(inspector.preview?.loading, true)
        inspector.answerPrompt(nil, rawBytes: false)
        XCTAssertNil(inspector.preview)
    }

    func testReportsAFolderAsNotPreviewableAndAnUnsupportedFile() async throws {
        let inspector = InspectorModel()
        var unsupported = false
        inspector.onUnsupported = { unsupported = true }
        inspector.open(work.appendingPathComponent("project/top.txt").path)
        XCTAssertTrue(unsupported)
        XCTAssertFalse(inspector.loading)

        inspector.open(work.appendingPathComponent("missing.zip").path)
        await waitUntil(!inspector.loading)
        XCTAssertEqual(inspector.errorKey, "errors.archiveMissing")
    }

    func testFormatsAHexDumpAndTellsLineEndingsApart() {
        XCTAssertEqual(
            PreviewDialog.hexDump(Data("Hello, Libera!\n\u{1}AB".utf8)),
            "00000000  48 65 6C 6C 6F 2C 20 4C  69 62 65 72 61 21 0A 01  |Hello, Libera!..|\n"
                + "00000010  41 42" + String(repeating: " ", count: 45) + "|AB|"
        )
        XCTAssertEqual(LineEnding.detect("a\r\nb\r\n"), .crlf)
        XCTAssertEqual(LineEnding.detect("a\nb"), .lf)
        XCTAssertEqual(LineEnding.detect("a\rb"), .cr)
        XCTAssertEqual(LineEnding.detect("a\r\nb\n"), .mixed)
        XCTAssertEqual(LineEnding.detect("ab"), .none)
    }
}
