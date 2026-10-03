import Foundation
import LiberaCore

/// A file or folder picked for a job, as the drop zones list it.
struct SelectedItem: Identifiable, Equatable {
    let path: String
    let name: String
    let isDirectory: Bool
    let size: UInt64
    /// Every volume of a split archive, which the extraction list collapses
    /// into this one row.
    var volumes: [ArchiveVolume]? = nil

    var id: String { path }

    init(path: String, name: String, isDirectory: Bool, size: UInt64, volumes: [ArchiveVolume]? = nil) {
        self.path = path
        self.name = name
        self.isDirectory = isDirectory
        self.size = size
        self.volumes = volumes
    }

    init(_ item: FileItem) {
        self.init(path: item.path, name: item.name, isDirectory: item.isDirectory, size: item.size)
    }

    init(_ archive: ResolvedArchive) {
        self.init(path: archive.path, name: archive.name, isDirectory: false, size: archive.size, volumes: archive.volumes)
    }
}

struct Job: Identifiable {
    enum Kind { case compress, extract }
    enum Status { case pending, running, completed, failed, cancelled }
    /// The keys under `queue.phase`.
    enum Phase: String { case initializing, compressing, extracting, processing, complete }

    let id = UUID()
    let kind: Kind
    /// The one item a job works on, or nil for a compression of several.
    let sourceName: String?
    let itemCount: Int
    /// The renderer's format name (`tgz`, `7z`), so a label reads the same.
    let format: String
    var outputPath: String?
    var status: Status
    var phase: Phase
    var processedBytes: UInt64 = 0
    var totalBytes: UInt64? = nil
    var percent: UInt8? = 0
    var currentFile: String? = nil
    var failure: Failure? = nil
    var durationMs: UInt64? = nil
    var symbolicLinksExcluded: UInt64? = nil
    var originalSize: UInt64? = nil
    var compressedSize: UInt64? = nil
    var volumeCount: Int? = nil

    var isActive: Bool { status == .pending || status == .running }
}

/// What the extraction panel decided, applied to each archive in a batch.
struct ExtractionRequest {
    var targetDir: String
    /// Extract each archive into a folder named after it.
    var createSubfolder: Bool
    /// The expert options, with the archive, target and password left for
    /// each job to fill in.
    var options = ExtractionOptions(archivePath: "", targetDir: "", rejectExistingTarget: false)

    func target(for item: SelectedItem) -> String {
        guard createSubfolder else { return targetDir }
        return (targetDir as NSString).appendingPathComponent(ArchivePaths.baseName(item.name))
    }

    func options(for item: SelectedItem, password: String?) -> ExtractionOptions {
        var options = options
        options.archivePath = item.path
        options.targetDir = target(for: item)
        // A fresh folder must not already exist, unless an overwrite policy
        // says what to do with what is in it.
        options.rejectExistingTarget = createSubfolder && options.overwritePolicy == nil
        options.password = password
        return options
    }
}

/// An archive waiting for its password.
struct PasswordPrompt: Identifiable, Equatable {
    let id = UUID()
    let jobID: Job.ID
    let archiveName: String
    /// The password just tried was wrong.
    let incorrect: Bool
}

/// The jobs on the queue screen, newest first, and the work behind them.
@MainActor final class JobQueue: ObservableObject {
    @Published private(set) var jobs: [Job] = []
    @Published private(set) var passwordPrompt: PasswordPrompt?

    private var tasks: [Job.ID: Task<Void, Never>] = [:]
    private var cancelled: Set<Job.ID> = []
    /// Prompts asked for while another is open wait their turn.
    private var prompts: [(prompt: PasswordPrompt, answer: CheckedContinuation<String?, Never>)] = []

    var activeCount: Int { jobs.filter(\.isActive).count }

    var hasFinishedJobs: Bool { jobs.contains { !$0.isActive } }

    @discardableResult
    func compress(_ items: [SelectedItem], options: CompressionOptions) -> Job.ID {
        let job = Job(
            kind: .compress, sourceName: items.count == 1 ? items[0].name : nil, itemCount: items.count,
            format: options.format.id, outputPath: options.outputPath, status: .running, phase: .initializing
        )
        jobs.insert(job, at: 0)
        tasks[job.id] = Task {
            do {
                let result = try await Libera.compress(options, onProgress: reporter(for: job.id))
                finish(job.id) {
                    $0.durationMs = result.durationMs
                    $0.originalSize = result.originalSize
                    $0.compressedSize = result.compressedSize
                    $0.outputPath = result.outputPath
                    $0.volumeCount = result.volumePaths?.count
                }
            } catch {
                fail(job.id, Failure(error, during: .compression))
            }
            tasks[job.id] = nil
        }
        return job.id
    }

    /// Queues one job per archive and runs them one after another.
    @discardableResult
    func extract(_ items: [SelectedItem], request: ExtractionRequest) -> [Job.ID] {
        let batch = items.map { item in
            Job(
                kind: .extract, sourceName: item.name, itemCount: 1,
                format: ArchivePaths.format(ofArchiveNamed: item.name), outputPath: request.target(for: item),
                status: .pending, phase: .extracting
            )
        }
        jobs.insert(contentsOf: batch, at: 0)
        Task {
            for (item, job) in zip(items, batch) where !cancelled.contains(job.id) {
                update(job.id) { $0.status = .running }
                let task = Task { await runExtraction(item, job: job.id, request: request) }
                tasks[job.id] = task
                await task.value
                tasks[job.id] = nil
            }
        }
        return batch.map(\.id)
    }

    func cancel(_ id: Job.ID) {
        guard let job = jobs.first(where: { $0.id == id }), job.isActive else { return }
        cancelled.insert(id)
        for waiting in prompts where waiting.prompt.jobID == id {
            waiting.answer.resume(returning: nil)
        }
        prompts.removeAll { $0.prompt.jobID == id }
        passwordPrompt = prompts.first?.prompt
        update(id) {
            $0.status = .cancelled
            $0.failure = Failure(code: job.kind == .compress ? "compressionCancelled" : "extractionCancelled")
        }
        tasks[id]?.cancel()
    }

    func clearFinished() {
        jobs.removeAll { !$0.isActive }
    }

    /// The open prompt's answer; nil, or an empty password, gives up.
    func answerPasswordPrompt(_ password: String?) {
        guard !prompts.isEmpty else { return }
        let waiting = prompts.removeFirst()
        passwordPrompt = prompts.first?.prompt
        waiting.answer.resume(returning: password.flatMap { $0.isEmpty ? nil : $0 })
    }

    private func runExtraction(_ item: SelectedItem, job id: Job.ID, request: ExtractionRequest) async {
        var password: String?
        if await Self.needsPassword(item.path) {
            guard !cancelled.contains(id) else { return }
            password = await requestPassword(for: id, archiveName: item.name, incorrect: false)
            if password == nil { return fail(id, Failure(code: "passwordCancelled")) }
        }
        while !cancelled.contains(id) {
            do {
                let result = try await Libera.extract(
                    request.options(for: item, password: password), onProgress: reporter(for: id)
                )
                return finish(id) {
                    $0.durationMs = result.durationMs
                    $0.symbolicLinksExcluded = result.symbolicLinksExcluded
                }
            } catch let error as LiberaError where error == .PasswordRequired || error == .WrongPassword {
                // A password the inspection could not tell was needed is asked
                // for the same way; a wrong one is asked for again.
                password = await requestPassword(for: id, archiveName: item.name, incorrect: password != nil)
                if password == nil { return fail(id, Failure(code: "passwordCancelled")) }
            } catch {
                return fail(id, Failure(error, during: .extraction))
            }
        }
    }

    /// Whether an archive asks for a password before any of it can be read. A
    /// 7z with encrypted names cannot even be listed, so that refusal is the
    /// answer rather than a failure.
    private static func needsPassword(_ path: String) async -> Bool {
        guard ArchivePaths.isEncryptable(path) else { return false }
        do {
            return try await Libera.inspect(path).passwordProtected
        } catch LiberaError.PasswordRequired {
            return true
        } catch {
            return false
        }
    }

    private func requestPassword(for id: Job.ID, archiveName: String, incorrect: Bool) async -> String? {
        await withCheckedContinuation { answer in
            prompts.append((PasswordPrompt(jobID: id, archiveName: archiveName, incorrect: incorrect), answer))
            passwordPrompt = prompts.first?.prompt
        }
    }

    /// Progress arrives on the core's thread; the main queue keeps it in order.
    private func reporter(for id: Job.ID) -> @Sendable (ProgressData) -> Void {
        { progress in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self.update(id) { job in
                        guard job.status == .running else { return }
                        job.processedBytes = progress.processedBytes
                        job.totalBytes = progress.totalBytes
                        job.percent = progress.percent
                        job.currentFile = progress.currentFile
                        job.phase = progress.phase == .complete ? .complete : .processing
                    }
                }
            }
        }
    }

    private func finish(_ id: Job.ID, _ result: (inout Job) -> Void) {
        guard !cancelled.contains(id) else { return }
        update(id) {
            $0.status = .completed
            $0.percent = 100
            $0.phase = .complete
            result(&$0)
        }
    }

    private func fail(_ id: Job.ID, _ failure: Failure) {
        guard !cancelled.contains(id) else { return }
        update(id) {
            $0.status = .failed
            $0.failure = failure
        }
    }

    private func update(_ id: Job.ID, _ change: (inout Job) -> Void) {
        guard let index = jobs.firstIndex(where: { $0.id == id }) else { return }
        change(&jobs[index])
    }
}

#if DEBUG
extension JobQueue {
    /// Shows `jobs` without running any of them, for previews.
    func showForPreview(_ jobs: [Job]) {
        self.jobs = jobs
    }
}
#endif
