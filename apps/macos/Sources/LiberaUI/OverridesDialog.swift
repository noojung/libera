import LiberaCore
import SwiftUI

/// The per-file dialog for the format the compression form is on.
struct CompressionDialogs: View {
    @ObservedObject var form: CompressionForm
    let items: [SelectedItem]

    var body: some View {
        if form.overridesOpen && form.expert {
            if form.format == .zip {
                ZipOverridesDialog(form: form, items: items)
            } else if form.format == .sevenZip {
                SevenZipOverridesDialog(form: form, items: items)
            }
        }
    }
}

private struct ZipOverridesDialog: View {
    @Environment(\.localizer) private var t
    @ObservedObject var form: CompressionForm
    let items: [SelectedItem]

    private var editor: ZipOverrideEditor {
        ZipOverrideEditor(rules: form.zipOverrides, defaultLevel: ArchiveFormat.zip.defaultLevel)
    }

    var body: some View {
        OverridesDialog(
            title: t("compression.zipOverridesTitle"), description: t("compression.zipOverridesDescription"),
            notice: t("compression.zipOverridesCompatibility"), closeLabel: t("compression.zipOverridesClose"), width: 1040,
            columns: [
                (t("compression.zipOverridesMethod"), 170), (t("compression.zipOverridesStrategy"), 180),
                (t("compression.zipOverridesLevel"), 128), (t("compression.zipOverridesMemory"), 80),
            ],
            items: items, ruleCount: form.zipOverrides.count, nestedCount: { editor.rules.nested(under: $0).count },
            onReset: { form.zipOverrides = [] }, onClose: { form.overridesOpen = false }
        ) { item in
            let path = item.path, folder = item.isDirectory
            OverrideSelect(
                label: t("compression.zipOverridesMethodFor", ["name": item.name]), width: 170,
                selection: editor.methodSelection(path, isDirectory: folder), mixedLabel: t("compression.zipOverridesMixed"),
                options: [(.store, t("compression.methodStore")), (.deflate, t("compression.methodDeflate")),
                          (.lzma, t("compression.methodZipLzma")), (.zstd, t("compression.methodZipZstd"))]
            ) { method in edit { $0.setMethod(path, isDirectory: folder, method) } }
            OverrideSelect(
                label: t("compression.zipOverridesStrategyFor", ["name": item.name]), width: 180,
                selection: editor.strategySelection(path, isDirectory: folder), mixedLabel: t("compression.zipOverridesStrategyMixed"),
                options: [(.default, t("compression.strategyDefault")), (.filtered, t("compression.strategyFiltered")),
                          (.huffmanOnly, t("compression.strategyHuffman")), (.rle, t("compression.strategyRle")),
                          (.fixed, t("compression.strategyFixed"))]
            ) { strategy in edit { $0.setStrategy(path, isDirectory: folder, strategy) } }
            OverrideSelect(
                label: t("compression.zipOverridesLevelFor", ["name": item.name]), width: 128,
                selection: editor.levelSelection(path, isDirectory: folder), mixedLabel: t("compression.zipOverridesLevelMixed"),
                options: (1...9).map { level in (UInt8(level), levelLabel(UInt8(level))) }
            ) { level in edit { $0.setLevel(path, isDirectory: folder, level) } }
            OverrideSelect(
                label: t("compression.zipOverridesMemoryFor", ["name": item.name]), width: 80,
                selection: editor.memorySelection(path, isDirectory: folder), mixedLabel: t("compression.zipOverridesMemoryMixed"),
                options: (1...9).map { (UInt8($0), String($0)) }
            ) { memory in edit { $0.setMemory(path, isDirectory: folder, memory) } }
        } extra: {
            EmptyView()
        }
    }

    private func levelLabel(_ level: UInt8) -> String {
        let key = [1: "levelFastest", 6: "levelNormal", 9: "levelMaximum"][Int(level)] ?? "levelPlain"
        return t("compression.\(key)", ["level": level])
    }

    private func edit(_ change: (inout ZipOverrideEditor) -> Void) {
        var editor = editor
        change(&editor)
        form.zipOverrides = editor.rules
    }
}

private struct SevenZipOverridesDialog: View {
    @Environment(\.localizer) private var t
    @ObservedObject var form: CompressionForm
    let items: [SelectedItem]

    private var editor: SevenZipOverrideEditor {
        SevenZipOverrideEditor(rules: form.sevenZipOverrides, defaultLevel: ArchiveFormat.sevenZip.defaultLevel)
    }

    var body: some View {
        OverridesDialog(
            title: t("compression.sevenZipOverridesTitle"), description: t("compression.sevenZipOverridesDescription"),
            notice: t("compression.sevenZipOverridesSolid"), closeLabel: t("compression.sevenZipOverridesClose"), width: 900,
            columns: [(t("compression.zipOverridesMethod"), 200), (t("compression.zipOverridesLevel"), 135)],
            items: items, ruleCount: form.sevenZipOverrides.count, nestedCount: { editor.rules.nested(under: $0).count },
            onReset: { form.sevenZipOverrides = [] }, onClose: { form.overridesOpen = false }
        ) { item in
            let path = item.path, folder = item.isDirectory
            OverrideSelect(
                label: t("compression.sevenZipOverridesMethodFor", ["name": item.name]), width: 200,
                selection: editor.methodSelection(path, isDirectory: folder), mixedLabel: t("compression.sevenZipOverridesMixed"),
                options: [(.lzma2, t("compression.methodLzma2")), (.copy, t("compression.methodCopy"))]
            ) { method in edit { $0.setMethod(path, isDirectory: folder, method) } }
            OverrideSelect(
                label: t("compression.zipOverridesLevelFor", ["name": item.name]), width: 135,
                selection: editor.levelSelection(path, isDirectory: folder), mixedLabel: t("compression.zipOverridesLevelMixed"),
                options: SevenZipOverrideEditor.levels.map { ($0, levelLabel($0)) }
            ) { level in edit { $0.setLevel(path, isDirectory: folder, level) } }
        } extra: {
            SolidBlocksPreview(form: form, items: items)
        }
    }

    private func levelLabel(_ level: UInt8) -> String {
        let key = [1: "levelFastest", 3: "levelFast", 5: "levelNormal", 7: "levelMaximum"][Int(level)] ?? "levelUltra"
        return t("compression.\(key)", ["level": level])
    }

    private func edit(_ change: (inout SevenZipOverrideEditor) -> Void) {
        var editor = editor
        change(&editor)
        form.sevenZipOverrides = editor.rules
    }
}

/// A row's setting: a dropdown, "—" where the setting does not apply, and a
/// "mixed" entry that can be shown but not chosen.
private struct OverrideSelect<Value: Hashable>: View {
    @Environment(\.palette) private var p
    let label: String
    let width: CGFloat
    let selection: Selection<Value>?
    let mixedLabel: String
    let options: [(Value, String)]
    let choose: (Value) -> Void

    var body: some View {
        Group {
            if let selection {
                CozySelect(
                    label: label,
                    value: Binding(get: { selection }, set: { if case let .value(value) = $0 { choose(value) } }),
                    options: (selection == .mixed ? [(Selection<Value>.mixed, mixedLabel)] : [])
                        + options.map { (Selection.value($0.0), $0.1) },
                    disabled: [.mixed]
                )
                .help(options.first { selection == .value($0.0) }?.1 ?? mixedLabel)
            } else {
                Text("—").font(Typography.sans(13)).foregroundStyle(p.dim).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 12)
            }
        }
        .frame(width: width)
    }
}

/// The dialog both formats share: a browser over the picked inputs with a
/// row of settings for each entry.
private struct OverridesDialog<Controls: View, Extra: View>: View {
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t
    let title: String
    let description: String
    let notice: String
    let closeLabel: String
    let width: CGFloat
    let columns: [(title: String, width: CGFloat)]
    let items: [SelectedItem]
    let ruleCount: Int
    let nestedCount: (String) -> Int
    let onReset: () -> Void
    let onClose: () -> Void
    @ViewBuilder let controls: (SelectedItem) -> Controls
    @ViewBuilder let extra: () -> Extra

    private enum Branch {
        case loading, loaded([SelectedItem]), failed
    }

    @State private var trail: [SelectedItem] = []
    @State private var branches: [String: Branch] = [:]

    var body: some View {
        Dialog(width: width, padding: 20, onClose: onClose) {
            VStack(alignment: .leading, spacing: 14) {
                header
                Text(notice).font(Typography.sans(12)).foregroundStyle(p.muted).fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14).padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10).fill(p.subtle))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(p.borderSubtle, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3])))
                browser
                extra()
                footer
            }
            .frame(maxHeight: 680)
        }
    }

    private var header: some View {
        HStack(spacing: 16) {
            HStack(spacing: 12) {
                DialogIcon(name: "files", size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    CuteLabel(text: title, size: 20)
                    Text(description).font(Typography.sans(13)).foregroundStyle(p.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            CloseButton(label: closeLabel, action: onClose)
        }
    }

    private var browser: some View {
        VStack(alignment: .leading, spacing: 0) {
            breadcrumbs.padding(.horizontal, 18).padding(.vertical, 10)
            HStack(spacing: 16) {
                Text(t("compression.zipOverridesItem")).frame(maxWidth: .infinity, alignment: .leading)
                Text(t("compression.zipOverridesSize")).frame(width: 68, alignment: .trailing)
                ForEach(columns.indices, id: \.self) { index in
                    Text(columns[index].title).frame(width: columns[index].width, alignment: .leading)
                }
            }
            .font(Typography.cute(13)).foregroundStyle(p.muted).lineLimit(1)
            .padding(.horizontal, 18).padding(.vertical, 8)
            .background(p.subtle)
            .overlay(alignment: .bottom) { p.borderSubtle.frame(height: 1) }
            ScrollView {
                LazyVStack(spacing: 0) { tree }
            }
            .frame(minHeight: 160, maxHeight: .infinity)
        }
        .background(RoundedRectangle(cornerRadius: 12).fill(p.card))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border, lineWidth: 1.5))
    }

    @ViewBuilder private var tree: some View {
        if let folder = trail.last {
            switch branches[folder.path] {
            case .loading, nil:
                state(t("compression.zipOverridesLoading"))
            case .failed:
                state(t("compression.zipOverridesLoadError"), error: true)
            case let .loaded(entries) where entries.isEmpty:
                state(t("compression.zipOverridesEmpty"))
            case let .loaded(entries):
                ForEach(entries) { row($0) }
            }
        } else if items.isEmpty {
            VStack(spacing: 10) {
                VectorIcon(name: "file-heart").frame(width: 34, height: 34).foregroundStyle(p.peach)
                CuteLabel(text: t("compression.zipOverridesNoItems"), size: 16, color: p.muted)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 40)
        } else {
            ForEach(items) { row($0) }
        }
    }

    private func state(_ text: String, error: Bool = false) -> some View {
        Text(text).font(Typography.sans(13)).foregroundStyle(error ? p.danger : p.muted)
            .frame(maxWidth: .infinity).padding(.vertical, 28)
    }

    private func row(_ item: SelectedItem) -> some View {
        let nested = item.isDirectory ? nestedCount(item.path) : 0
        let main = HStack(spacing: 10) {
            VectorIcon(name: item.isDirectory ? "folder" : "file").frame(width: 17, height: 17).foregroundStyle(p.peach)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.name).font(Typography.sans(13)).fontWeight(.semibold).foregroundStyle(p.text)
                if trail.isEmpty {
                    Text(item.path).font(Typography.mono(10)).foregroundStyle(p.dim)
                }
                if nested > 0 {
                    Text(t("compression.zipOverridesNested", ["count": nested])).font(Typography.sans(11)).foregroundStyle(p.peach)
                }
            }
            .lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 0)
            if item.isDirectory {
                VectorIcon(name: "chevron-right").frame(width: 15, height: 15).foregroundStyle(p.dim)
            }
        }
        return HStack(spacing: 16) {
            if item.isDirectory {
                Button { open(item) } label: { main.contentShape(Rectangle()) }
                    .buttonStyle(.plain).accessibilityLabel(t("compression.zipOverridesOpen", ["name": item.name]))
            } else {
                main
            }
            Text(item.isDirectory && !trail.isEmpty ? "—" : t.bytes(item.size))
                .font(Typography.mono(11)).foregroundStyle(p.muted).frame(width: 68, alignment: .trailing)
            controls(item)
        }
        .padding(.horizontal, 18).padding(.vertical, 10).frame(minHeight: 58)
        .overlay(alignment: .bottom) {
            Line().stroke(p.borderSubtle, style: StrokeStyle(lineWidth: 1, dash: [3, 2])).frame(height: 1)
        }
    }

    private var breadcrumbs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Button { trail = [] } label: {
                    VectorIcon(name: "house").frame(width: 15, height: 15).foregroundStyle(trail.isEmpty ? p.peach : p.text)
                }
                .buttonStyle(.plain).help(t("compression.zipOverridesRoot")).accessibilityLabel(t("compression.zipOverridesRoot"))
                ForEach(trail.indices, id: \.self) { index in
                    VectorIcon(name: "chevron-right").frame(width: 15, height: 15).foregroundStyle(p.dim)
                    Button(trail[index].name) { trail = Array(trail.prefix(index + 1)) }
                        .buttonStyle(.plain).font(Typography.sans(13))
                        .fontWeight(index == trail.count - 1 ? .bold : .medium)
                        .foregroundStyle(index == trail.count - 1 ? p.peach : p.text)
                }
            }
        }
        .accessibilityLabel(t("compression.zipOverridesBreadcrumb"))
    }

    private func open(_ folder: SelectedItem) {
        trail.append(folder)
        if case .loaded = branches[folder.path] { return }
        branches[folder.path] = .loading
        let path = folder.path
        Task {
            do {
                let children = try await Task.detached { try listInputChildren(directory: path) }.value
                branches[path] = .loaded(children.map(SelectedItem.init))
            } catch {
                branches[path] = .failed
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            CozyButton(title: t("compression.zipOverridesReset"), icon: "rotate-ccw", action: onReset)
                .disabled(ruleCount == 0).fixedSize()
            Text(t("compression.zipOverridesCount", ["count": ruleCount])).font(Typography.sans(13)).foregroundStyle(p.muted)
            Spacer()
            CozyButton(title: t("compression.zipOverridesDone"), primary: true, height: 42, action: onClose)
                .fixedSize().keyboardShortcut(.defaultAction)
        }
    }
}

/// What the 7z writer would group into solid blocks with the rules as they
/// stand, re-planned a moment after they stop changing.
private struct SolidBlocksPreview: View {
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t
    @ObservedObject var form: CompressionForm
    let items: [SelectedItem]

    private enum Plan {
        case loading, ready([SevenZipSolidBlock]), failed
    }

    @State private var plan = Plan.loading
    @State private var open = false
    @State private var expanded: Set<String> = []

    /// What the writer would be asked, which is what the plan follows.
    private var request: CompressionOptions {
        let pattern = form.filterPattern.trimmingCharacters(in: .whitespacesAndNewlines)
        return CompressionOptions(
            inputPaths: items.map(\.path), outputPath: form.resolvedOutputPath(defaultDirectory: FilePanels.defaultOutputDirectory),
            format: .sevenZip, level: ArchiveFormat.sevenZip.defaultLevel, sevenZipMethodOverrides: form.sevenZipOverrides,
            solidArchive: form.solid, excludeSymlinks: form.excludeSymlinks, excludeMacMetadata: form.excludeMacMetadata,
            excludeHiddenFiles: form.excludeHiddenFiles, filterPattern: pattern.isEmpty ? nil : pattern
        )
    }

    /// A stream holding one file is not a block, and the written archive
    /// reports none for it.
    private var split: (blocks: [SevenZipSolidBlock], standalone: [SevenZipSolidBlock]) {
        guard case let .ready(all) = plan else { return ([], []) }
        return (all.filter { $0.entries.count > 1 }, all.filter { $0.entries.count <= 1 })
    }

    var body: some View {
        VStack(spacing: 0) {
            Button { open.toggle() } label: {
                HStack(spacing: 8) {
                    VectorIcon(name: "boxes").frame(width: 16, height: 16)
                    Text(t("compression.sevenZipBlocksTitle")).font(Typography.cute(14))
                    Text(summary).font(Typography.sans(12)).foregroundStyle(p.muted).lineLimit(1)
                    Spacer()
                    if form.solid { VectorIcon(name: open ? "chevron-down" : "chevron-right").frame(width: 16, height: 16) }
                }
                .foregroundStyle(p.text).padding(.horizontal, 14).padding(.vertical, 10).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!form.solid).accessibilityLabel(t("compression.sevenZipBlocksToggle"))
            if form.solid && open {
                ScrollView { details.padding(12) }.frame(maxHeight: 200)
            }
        }
        .background(RoundedRectangle(cornerRadius: 12).fill(p.subtle))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border, lineWidth: 1.5))
        .task(id: form.solid ? request : nil) {
            guard form.solid else { return }
            // A run of clicks settles before the inputs are walked again.
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            plan = .loading
            let request = request
            do {
                let blocks = try await Task.detached { try planSevenZipSolidBlocks(options: request) }.value
                if !Task.isCancelled { plan = .ready(blocks) }
            } catch {
                if !Task.isCancelled { plan = .failed }
            }
        }
    }

    private var summary: String {
        guard form.solid else { return t("compression.sevenZipBlocksOff") }
        switch plan {
        case .loading: return t("compression.sevenZipBlocksLoading")
        case .failed: return t("compression.sevenZipBlocksError")
        case let .ready(all) where all.isEmpty: return t("compression.sevenZipBlocksEmpty")
        case .ready:
            let (blocks, standalone) = split
            var parts = [blocks.isEmpty ? t("compression.sevenZipBlocksNone") : t("compression.sevenZipBlocksCount", ["count": blocks.count])]
            if !standalone.isEmpty { parts.append(t("compression.sevenZipBlocksStandaloneCount", ["count": standalone.count])) }
            return parts.joined(separator: " · ")
        }
    }

    @ViewBuilder private var details: some View {
        let (blocks, standalone) = split
        if blocks.isEmpty && standalone.isEmpty {
            Text(summary).font(Typography.sans(13)).foregroundStyle(p.muted).frame(maxWidth: .infinity).padding(.vertical, 12)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(blocks.indices, id: \.self) { index in block(blocks[index], number: index + 1) }
                if !standalone.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(t("compression.sevenZipBlocksStandaloneTitle")).font(Typography.cute(13)).foregroundStyle(p.text)
                        Text(t("compression.sevenZipBlocksStandaloneHint")).font(Typography.sans(11)).foregroundStyle(p.muted)
                        ForEach(standalone.indices, id: \.self) { index in
                            if let entry = standalone[index].entries.first {
                                entryRow(entry, badge: standalone[index].method == .copy ? t("compression.sevenZipBlocksCopy") : "LZMA2",
                                         meta: meta(standalone[index], files: false))
                            }
                        }
                    }
                    .padding(.top, 4)
                }
            }
        }
    }

    private func block(_ block: SevenZipSolidBlock, number: Int) -> some View {
        let key = block.entries.first?.path ?? "\(number)"
        let isExpanded = expanded.contains(key)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                if isExpanded { expanded.remove(key) } else { expanded.insert(key) }
            } label: {
                HStack(spacing: 8) {
                    VectorIcon(name: isExpanded ? "chevron-down" : "chevron-right").frame(width: 15, height: 15)
                    VectorIcon(name: "files").frame(width: 15, height: 15).foregroundStyle(p.peach)
                    Text(t("compression.sevenZipBlocksLabel", ["index": number])).font(Typography.cute(13))
                    CodeBadge(text: "LZMA2")
                    Spacer(minLength: 8)
                    Text(meta(block, files: true)).font(Typography.sans(11)).foregroundStyle(p.muted).lineLimit(1)
                }
                .foregroundStyle(p.text).padding(.horizontal, 10).padding(.vertical, 8).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if isExpanded {
                VStack(spacing: 2) {
                    ForEach(block.entries, id: \.path) { entryRow($0, badge: nil, meta: t.bytes($0.size)) }
                }
                .padding(.horizontal, 10).padding(.bottom, 8)
            }
        }
        .background(RoundedRectangle(cornerRadius: 8).fill(p.card))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(p.borderSubtle, lineWidth: 1.5))
    }

    /// The folders truncate so the file's own name survives.
    private func entryRow(_ entry: PlannedFile, badge: String?, meta: String) -> some View {
        let path = entry.path as NSString
        return HStack(spacing: 8) {
            VectorIcon(name: "file").frame(width: 14, height: 14).foregroundStyle(p.dim)
            HStack(spacing: 0) {
                let folder = path.deletingLastPathComponent
                if !folder.isEmpty {
                    Text(folder + "/").foregroundStyle(p.dim).lineLimit(1).truncationMode(.middle)
                }
                Text(path.lastPathComponent).foregroundStyle(p.text).lineLimit(1).layoutPriority(1)
            }
            .font(Typography.mono(11)).frame(maxWidth: .infinity, alignment: .leading).help(entry.path)
            if let badge { CodeBadge(text: badge) }
            Text(meta).font(Typography.mono(11)).foregroundStyle(p.muted).lineLimit(1)
        }
        .padding(.vertical, 3)
    }

    private func meta(_ block: SevenZipSolidBlock, files: Bool) -> String {
        var parts: [String] = []
        if files { parts.append(t("compression.sevenZipBlocksFiles", ["count": block.entries.count])) }
        parts.append(t.bytes(block.totalBytes))
        if let dictionary = block.dictionarySize {
            parts.append(t("compression.sevenZipBlocksDictionary", ["size": t.bytes(dictionary)]))
        }
        return parts.joined(separator: " · ")
    }
}

#if DEBUG
#Preview("ZIP 파일별 설정") {
    PreviewHost(language: .en, expert: true, setUp: { model in
        model.compressItems = PreviewSamples.compressItems
        model.compressionForm.setPerFile(true)
        model.compressionForm.overridesOpen = true
    }) { OverridesPreview() }
    .previewWindow()
}

#Preview("7Z 파일별 설정") {
    PreviewHost(expert: true, setUp: { model in
        model.compressItems = PreviewSamples.compressItems
        model.compressionForm.select(.sevenZip)
        model.compressionForm.setPerFile(true)
        model.compressionForm.overridesOpen = true
    }) { OverridesPreview() }
    .previewWindow()
}

private struct OverridesPreview: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        CompressionDialogs(form: model.compressionForm, items: model.compressItems)
    }
}
#endif
