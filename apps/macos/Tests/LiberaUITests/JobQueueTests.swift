import LiberaCore
import XCTest

@testable import LiberaUI

@MainActor final class JobQueueTests: XCTestCase {
    private var work: URL!

    override func setUp() async throws {
        work = FileManager.default.temporaryDirectory.appendingPathComponent("LiberaUITests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: work)
    }

    private func file(_ name: String, _ contents: String) throws -> SelectedItem {
        let url = work.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(contents.utf8).write(to: url)
        return SelectedItem(path: url.path, name: name, isDirectory: false, size: UInt64(contents.utf8.count))
    }

    /// Polls the main actor until `condition` holds.
    private func waitUntil(_ condition: @autoclosure () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<500 where !condition() {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(condition(), "Timed out", file: file, line: line)
    }

    private func job(_ queue: JobQueue, _ id: Job.ID) -> Job? {
        queue.jobs.first { $0.id == id }
    }

    func testRunsACompressionToTheEnd() async throws {
        let queue = JobQueue()
        let input = try file("a.txt", String(repeating: "libera ", count: 1000))
        let output = work.appendingPathComponent("a.zip").path
        let id = queue.compress([input], options: CompressionOptions(inputPaths: [input.path], outputPath: output, format: .zip))

        XCTAssertEqual(queue.activeCount, 1)
        await waitUntil(self.job(queue, id)?.status == .completed)
        let done = try XCTUnwrap(job(queue, id))
        XCTAssertEqual(done.percent, 100)
        XCTAssertEqual(done.originalSize, 7000)
        XCTAssertEqual(done.outputPath, output)
        XCTAssertEqual(done.sourceName, "a.txt")
        XCTAssertTrue(queue.hasFinishedJobs)
        queue.clearFinished()
        XCTAssertTrue(queue.jobs.isEmpty)
    }

    func testReportsAFailureByItsCode() async throws {
        let queue = JobQueue()
        let id = queue.compress(
            [SelectedItem(path: work.path, name: "work", isDirectory: true, size: 0)],
            options: CompressionOptions(inputPaths: [work.path], outputPath: work.appendingPathComponent("w.gz").path, format: .gz)
        )
        await waitUntil(self.job(queue, id)?.status == .failed)
        XCTAssertEqual(job(queue, id)?.failure?.code, "invalidSingleFileInput")
    }

    func testAsksAgainAfterAWrongPassword() async throws {
        let queue = JobQueue()
        let input = try file("secret.txt", "classified")
        let archive = work.appendingPathComponent("secret.zip").path
        _ = try await Libera.compress(CompressionOptions(inputPaths: [input.path], outputPath: archive, format: .zip, password: "hunter2"))
        let item = SelectedItem(path: archive, name: "secret.zip", isDirectory: false, size: 1)
        let target = work.appendingPathComponent("out").path

        let id = try XCTUnwrap(queue.extract([item], request: ExtractionRequest(targetDir: target, createSubfolder: true)).first)
        await waitUntil(queue.passwordPrompt != nil)
        XCTAssertEqual(queue.passwordPrompt?.archiveName, "secret.zip")
        XCTAssertEqual(queue.passwordPrompt?.incorrect, false)
        queue.answerPasswordPrompt("wrong")

        await waitUntil(queue.passwordPrompt?.incorrect == true)
        queue.answerPasswordPrompt("hunter2")

        await waitUntil(self.job(queue, id)?.status == .completed)
        XCTAssertNil(queue.passwordPrompt)
        let extracted = (target as NSString).appendingPathComponent("secret/secret.txt")
        XCTAssertEqual(try String(contentsOfFile: extracted, encoding: .utf8), "classified")
    }

    func testGivingUpOnThePasswordFailsTheJob() async throws {
        let queue = JobQueue()
        let input = try file("secret.txt", "classified")
        let archive = work.appendingPathComponent("secret.7z").path
        _ = try await Libera.compress(CompressionOptions(
            inputPaths: [input.path], outputPath: archive, format: .sevenZip, password: "pw", encryptFileNames: true
        ))
        let item = SelectedItem(path: archive, name: "secret.7z", isDirectory: false, size: 1)

        let id = try XCTUnwrap(queue.extract([item], request: ExtractionRequest(targetDir: work.path, createSubfolder: true)).first)
        await waitUntil(queue.passwordPrompt != nil)
        queue.answerPasswordPrompt(nil)
        await waitUntil(self.job(queue, id)?.status == .failed)
        XCTAssertEqual(job(queue, id)?.failure?.code, "passwordCancelled")
    }

    func testCancellingAWaitingJobClosesItsPromptAndSkipsTheRest() async throws {
        let queue = JobQueue()
        let input = try file("secret.txt", "classified")
        let archive = work.appendingPathComponent("secret.zip").path
        _ = try await Libera.compress(CompressionOptions(inputPaths: [input.path], outputPath: archive, format: .zip, password: "pw"))
        let plain = work.appendingPathComponent("plain.tgz").path
        _ = try await Libera.compress(CompressionOptions(inputPaths: [input.path], outputPath: plain, format: .tgz))
        let items = [
            SelectedItem(path: archive, name: "secret.zip", isDirectory: false, size: 1),
            SelectedItem(path: plain, name: "plain.tgz", isDirectory: false, size: 1),
        ]

        let ids = queue.extract(items, request: ExtractionRequest(targetDir: work.appendingPathComponent("out").path, createSubfolder: true))
        await waitUntil(queue.passwordPrompt != nil)
        queue.cancel(ids[1])
        queue.cancel(ids[0])

        XCTAssertNil(queue.passwordPrompt)
        XCTAssertEqual(job(queue, ids[0])?.status, .cancelled)
        XCTAssertEqual(job(queue, ids[0])?.failure?.code, "extractionCancelled")
        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(job(queue, ids[1])?.status, .cancelled)
        XCTAssertFalse(FileManager.default.fileExists(atPath: work.appendingPathComponent("out/plain").path))
    }
}

@MainActor final class AppModelTests: XCTestCase {
    private var work: URL!

    override func setUp() async throws {
        work = FileManager.default.temporaryDirectory.appendingPathComponent("LiberaUITests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: work)
    }

    func testCollapsesASplitSetAndTurnsAwayWhatIsNotAnArchive() async throws {
        let input = work.appendingPathComponent("big.bin")
        try Data((0..<3_000_000).map { UInt8(truncatingIfNeeded: $0 &* 2654435761 >> 13) }).write(to: input)
        let archive = work.appendingPathComponent("set.zip").path
        let result = try await Libera.compress(CompressionOptions(
            inputPaths: [input.path], outputPath: archive, format: .zip, level: 0, splitSize: 1 << 20
        ))
        let volumes = try XCTUnwrap(result.volumePaths)
        XCTAssertGreaterThan(volumes.count, 1)

        let model = AppModel(settings: AppSettings(defaults: nil))
        await model.addExtractInputs(volumes)
        XCTAssertEqual(model.extractItems.count, 1)
        XCTAssertEqual(model.extractItems.first?.volumes?.count, volumes.count)
        XCTAssertNil(model.sheet)

        await model.addExtractInputs([input.path, volumes[0]])
        XCTAssertEqual(model.extractItems.count, 1)
        XCTAssertEqual(model.sheet, .unsupportedFormat)
        model.dismissSheet()
        XCTAssertNil(model.sheet)
    }

    func testHandsTheSelectionToTheQueue() async throws {
        let input = work.appendingPathComponent("a.txt")
        try Data("a".utf8).write(to: input)
        let model = AppModel(settings: AppSettings(defaults: nil))
        await model.addCompressInputs([input.path, input.path])
        XCTAssertEqual(model.compressItems.count, 1)

        let form = CompressionForm()
        model.startCompress(try XCTUnwrap(form.options(inputs: model.compressItems.map(\.path), defaultDirectory: work.path)))
        XCTAssertTrue(model.compressItems.isEmpty)
        XCTAssertEqual(model.screen, .queue)
        XCTAssertEqual(model.queue.jobs.count, 1)
    }
}
