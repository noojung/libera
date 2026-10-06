import LiberaCore
import XCTest

final class LiberaCoreTests: XCTestCase {
    private var work: URL!

    override func setUpWithError() throws {
        work = FileManager.default.temporaryDirectory.appendingPathComponent("LiberaCoreTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: work)
    }

    private func file(_ name: String, _ contents: String) throws -> URL {
        let url = work.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(contents.utf8).write(to: url)
        return url
    }

    func testRoundTripsAFolderThroughTheCore() async throws {
        _ = try file("docs/a.txt", "hello")
        let archive = work.appendingPathComponent("docs.tgz")
        let events = Events()

        let compressed = try await Libera.compress(
            CompressionOptions(
                inputPaths: [work.appendingPathComponent("docs").path],
                outputPath: archive.path, format: .tgz, level: nil
            )
        ) { events.append($0) }

        XCTAssertEqual(compressed.originalSize, 5)
        XCTAssertEqual(events.all.last?.phase, .complete)
        XCTAssertEqual(events.all.last?.percent, 100)

        let target = work.appendingPathComponent("unpacked")
        let extracted = try await Libera.extract(
            ExtractionOptions(archivePath: archive.path, targetDir: target.path, rejectExistingTarget: true)
        )

        XCTAssertEqual(extracted.extractedCount, 1)
        XCTAssertEqual(try String(contentsOf: target.appendingPathComponent("docs/a.txt"), encoding: .utf8), "hello")
    }

    func testCancellingTheTaskCancelsTheJob() async throws {
        let input = try file("a.txt", "a")
        let archive = work.appendingPathComponent("a.tgz")

        let task = Task {
            try await Libera.compress(
                CompressionOptions(inputPaths: [input.path], outputPath: archive.path, format: .tgz, level: nil)
            )
        }
        task.cancel()

        do {
            _ = try await task.value
            XCTFail("The job finished despite the cancelled task")
        } catch LiberaError.CompressionCancelled {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: archive.path))
    }

    func testSurfacesTheCoreErrorAsItsOwnCase() async throws {
        let input = try file("a.txt", "a")
        let archive = work.appendingPathComponent("a.tgz")
        _ = try await Libera.compress(
            CompressionOptions(inputPaths: [input.path], outputPath: archive.path, format: .tgz, level: nil)
        )

        do {
            _ = try await Libera.extract(
                ExtractionOptions(archivePath: archive.path, targetDir: work.path, rejectExistingTarget: true)
            )
            XCTFail("Extracted into a folder that already existed")
        } catch LiberaError.DestinationExists {}
    }
}

private final class Events: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [ProgressData] = []

    func append(_ event: ProgressData) {
        lock.lock()
        defer { lock.unlock() }
        events.append(event)
    }

    var all: [ProgressData] {
        lock.lock()
        defer { lock.unlock() }
        return events
    }
}
