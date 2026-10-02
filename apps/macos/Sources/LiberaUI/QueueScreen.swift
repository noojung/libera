import SwiftUI

/// Every job this session has started, newest first.
struct QueueScreen: View {
    @EnvironmentObject private var queue: JobQueue
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t

    var body: some View {
        VStack(spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 0) {
                    CuteLabel(text: t("queue.title", ["count": queue.jobs.count]), size: 20)
                    Text(t("queue.subtitle")).font(Typography.sans(13)).foregroundStyle(p.muted)
                }
                Spacer()
                if queue.hasFinishedJobs {
                    CozyButton(title: t("queue.clearCompleted")) { queue.clearFinished() }
                }
            }
            .padding(16).frame(maxWidth: .infinity).card()

            if queue.jobs.isEmpty {
                CuteLabel(text: t("queue.empty"), size: 18, color: p.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).card()
            } else {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(queue.jobs) { job in JobRow(job: job) }
                    }
                    .padding(.trailing, 3).padding(.bottom, 3)
                }
            }
        }
    }
}

private struct JobRow: View {
    @EnvironmentObject private var queue: JobQueue
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t
    let job: Job

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                HStack(spacing: 10) {
                    VectorIcon(name: job.kind == .compress ? "archive" : "download").frame(width: 20, height: 20)
                        .foregroundStyle(job.kind == .compress ? p.peach : p.blue)
                    VStack(alignment: .leading, spacing: 0) {
                        CuteLabel(text: name, size: 17).lineLimit(1)
                        Text("\(t(job.kind == .compress ? "queue.typeCompress" : "queue.typeExtract")) • \(ArchivePaths.label(job.format))")
                            .font(Typography.cute(14)).foregroundStyle(p.muted)
                    }
                }
                Spacer(minLength: 12)
                HStack(spacing: 12) {
                    status
                    if job.isActive {
                        CozyButton(title: "", icon: "circle-x", height: 34) { queue.cancel(job.id) }
                            .help(t("queue.cancel")).accessibilityLabel(t("queue.cancel"))
                    }
                    if let output = job.outputPath, job.status == .completed {
                        CozyButton(title: "", icon: "folder-open", height: 34) { FilePanels.reveal(output) }
                            .help(t("queue.openFolder")).accessibilityLabel(t("queue.openFolder"))
                    }
                }
            }
            if job.status == .running { progress }
            if job.status == .failed {
                Text(t(job.failure?.messageKey ?? (job.kind == .compress ? "errors.genericCompression" : "errors.genericExtraction")))
                    .font(Typography.sans(12)).foregroundStyle(p.danger).help(job.failure?.detail ?? "")
            }
            if job.status == .completed { completedDetails }
        }
        .padding(16).padding(.leading, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .overlay {
            // The status stripe down the left edge, `border-left: 6px`.
            RoundedRectangle(cornerRadius: 16).fill(statusColor)
                .mask(alignment: .leading) { Rectangle().frame(width: 6) }
        }
    }

    private var name: String {
        if job.kind == .extract { return t("queue.extractName", ["name": job.sourceName ?? ""]) }
        if job.itemCount > 1 { return t("queue.compressItems", ["count": job.itemCount]) }
        return t("queue.compressName", ["name": job.sourceName ?? ""])
    }

    @ViewBuilder private var status: some View {
        HStack(spacing: 6) {
            switch job.status {
            case .running:
                Spinner().frame(width: 18, height: 18)
                Text(job.percent.map { "\($0)%" } ?? t("queue.processing"))
            case .pending:
                VectorIcon(name: "clock-3").frame(width: 18, height: 18)
                Text(t("queue.pending"))
            case .completed:
                VectorIcon(name: "circle-check-big").frame(width: 18, height: 18)
                Text(t("queue.completed", ["duration": t.duration(milliseconds: job.durationMs)]))
            case .failed:
                VectorIcon(name: "circle-alert").frame(width: 18, height: 18)
                Text(t("queue.failed"))
            case .cancelled:
                VectorIcon(name: "circle-x").frame(width: 18, height: 18)
                Text(t("queue.cancelled"))
            }
        }
        .font(Typography.cute(15)).fontWeight(.bold).foregroundStyle(statusColor)
    }

    private var statusColor: Color {
        switch job.status {
        case .running: p.peach
        case .pending: p.blue
        case .completed: p.success
        case .failed: p.danger
        case .cancelled: p.dim
        }
    }

    private var progress: some View {
        VStack(spacing: 4) {
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(p.pill)
                    if let percent = job.percent {
                        Rectangle().fill(p.gradient).frame(width: geometry.size.width * CGFloat(percent) / 100)
                            .animation(.easeOut(duration: 0.2), value: percent)
                    } else {
                        IndeterminateBar(width: geometry.size.width)
                    }
                }
                .clipShape(Capsule())
                .overlay(Capsule().strokeBorder(p.border, lineWidth: 1.5))
            }
            .frame(height: 10)
            HStack {
                Text(job.currentFile ?? t("queue.phase.\(job.phase.rawValue)")).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 12)
                if let total = job.totalBytes {
                    Text("\(t.bytes(job.processedBytes)) / \(t.bytes(total))")
                } else if job.processedBytes > 0 {
                    Text(t("queue.processed", ["size": t.bytes(job.processedBytes)]))
                }
            }
            .font(Typography.mono(11)).foregroundStyle(p.muted)
        }
    }

    @ViewBuilder private var completedDetails: some View {
        if let original = job.originalSize, let compressed = job.compressedSize, original > 0, compressed > 0 {
            HStack(spacing: 16) {
                Text(t("queue.original", ["size": t.bytes(original)]))
                Text(t("queue.compressed", ["size": t.bytes(compressed)]))
                Text(t("queue.saved", ["ratio": Int(((1 - Double(compressed) / Double(original)) * 100).rounded())]))
                    .font(Typography.cute(14)).fontWeight(.bold).foregroundStyle(p.success)
                if let volumes = job.volumeCount { Text(t("queue.volumes", ["count": volumes])) }
            }
            .font(Typography.mono(12)).foregroundStyle(p.muted)
        }
        if let links = job.symbolicLinksExcluded, links > 0 {
            Text(t("queue.symbolicLinksExcluded", ["count": links])).font(Typography.sans(13)).foregroundStyle(p.warning)
        }
    }
}

/// The turning `loader-circle`.
struct Spinner: View {
    @State private var turning = false

    var body: some View {
        VectorIcon(name: "loader-circle")
            .rotationEffect(.degrees(turning ? 360 : 0))
            .animation(.linear(duration: 1).repeatForever(autoreverses: false), value: turning)
            .onAppear { turning = true }
    }
}

/// A bar sliding across a track whose total is not known.
private struct IndeterminateBar: View {
    @Environment(\.palette) private var p
    let width: CGFloat
    @State private var sliding = false

    var body: some View {
        Rectangle().fill(p.gradient).frame(width: width * 0.35)
            .offset(x: sliding ? width : -width * 0.385)
            .animation(.easeInOut(duration: 1.2).repeatForever(autoreverses: false), value: sliding)
            .onAppear { sliding = true }
    }
}
