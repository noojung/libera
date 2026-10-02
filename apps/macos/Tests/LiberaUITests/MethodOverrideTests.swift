import LiberaCore
import XCTest

@testable import LiberaUI

final class ZipOverrideEditorTests: XCTestCase {
    private func editor(_ rules: [ZipMethodOverride] = []) -> ZipOverrideEditor {
        ZipOverrideEditor(rules: rules, defaultLevel: 6)
    }

    func testAFileFollowsTheDeepestFolderAboveIt() {
        let editor = editor([
            ZipMethodOverride(sourcePath: "/in", scope: .tree, method: .store),
            ZipMethodOverride(sourcePath: "/in/docs/", scope: .tree, method: .lzma, level: 9),
        ])
        XCTAssertEqual(editor.method("/in/docs/a.txt", isDirectory: false), .lzma)
        XCTAssertEqual(editor.levelSelection("/in/docs/a.txt", isDirectory: false), .value(9))
        XCTAssertEqual(editor.method("/in/b.txt", isDirectory: false), .store)
        XCTAssertNil(editor.levelSelection("/in/b.txt", isDirectory: false))
        XCTAssertEqual(editor.method("/elsewhere", isDirectory: false), .deflate)
    }

    func testAFolderReadsAsMixedWhenARuleBelowDiffers() {
        var editor = editor()
        editor.setMethod("/in/docs/a.txt", isDirectory: false, .store)
        XCTAssertEqual(editor.methodSelection("/in", isDirectory: true), .mixed)
        XCTAssertNil(editor.strategySelection("/in", isDirectory: true))
        XCTAssertEqual(editor.rules.nested(under: "/in").count, 1)

        // Choosing for the folder replaces what was set below it.
        editor.setMethod("/in", isDirectory: true, .deflate)
        XCTAssertEqual(editor.rules.map(\.sourcePath), ["/in"])
        XCTAssertEqual(editor.methodSelection("/in", isDirectory: true), .value(.deflate))
    }

    func testDeflateTuningStaysWithDeflate() {
        var editor = editor()
        editor.setStrategy("/in/a.txt", isDirectory: false, .rle)
        editor.setMemory("/in/a.txt", isDirectory: false, 4)
        editor.setLevel("/in/a.txt", isDirectory: false, 3)
        XCTAssertEqual(editor.rules.count, 1)
        XCTAssertEqual(editor.rules.first?.deflateStrategy, .rle)
        XCTAssertEqual(editor.rules.first?.memLevel, 4)

        editor.setMethod("/in/a.txt", isDirectory: false, .lzma)
        XCTAssertNil(editor.rules.first?.deflateStrategy)
        XCTAssertNil(editor.rules.first?.memLevel)
        XCTAssertEqual(editor.rules.first?.level, 3)

        editor.setMethod("/in/a.txt", isDirectory: false, .store)
        XCTAssertNil(editor.rules.first?.level)
        editor.setLevel("/in/a.txt", isDirectory: false, 9)
        XCTAssertNil(editor.rules.first?.level, "A stored file takes no strength")
    }

    func testAFolderStrengthClearsTheStrengthBelowIt() {
        var editor = editor()
        editor.setLevel("/in/a.txt", isDirectory: false, 1)
        XCTAssertEqual(editor.levelSelection("/in", isDirectory: true), .mixed)
        editor.setLevel("/in", isDirectory: true, 9)
        XCTAssertNil(editor.rules.first { $0.sourcePath == "/in/a.txt" }?.level)
        XCTAssertEqual(editor.levelSelection("/in/a.txt", isDirectory: false), .value(9))
    }
}

final class SevenZipOverrideEditorTests: XCTestCase {
    func testCopyDropsTheStrengthAndAFolderReplacesItsContents() {
        var editor = SevenZipOverrideEditor(rules: [], defaultLevel: 5)
        XCTAssertEqual(editor.levelSelection("/in/a.bin", isDirectory: false), .value(5))
        editor.setLevel("/in/a.bin", isDirectory: false, 9)
        editor.setMethod("/in/b.jpg", isDirectory: false, .copy)
        XCTAssertNil(editor.levelSelection("/in/b.jpg", isDirectory: false))
        XCTAssertEqual(editor.methodSelection("/in", isDirectory: true), .mixed)

        editor.setMethod("/in/a.bin", isDirectory: false, .copy)
        XCTAssertNil(editor.rules.first { $0.sourcePath == "/in/a.bin" }?.level)

        editor.setMethod("/in", isDirectory: true, .lzma2)
        XCTAssertEqual(editor.rules.map(\.sourcePath), ["/in"])
        editor.setLevel("/in", isDirectory: true, 7)
        XCTAssertEqual(editor.levelSelection("/in/a.bin", isDirectory: false), .value(7))
    }
}
