import LiberaCore
import SwiftUI

/// Browses an archive's entries without extracting it.
struct InspectorScreen: View {
    @EnvironmentObject private var inspector: InspectorModel
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t

    var body: some View {
        VStack(spacing: 16) {
            header
            if inspector.loading {
                CuteLabel(text: t("inspector.loading"), size: 18, color: p.peach)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).card()
            } else if let errorKey = inspector.errorKey {
                VStack(spacing: 10) {
                    VectorIcon(name: "shield-alert").frame(width: 40, height: 40)
                    Text(t(errorKey)).font(Typography.sans(15)).fontWeight(.semibold).multilineTextAlignment(.center)
                    CozyButton(title: t("dropZone.browseFiles"), icon: "file-plus", action: browse)
                }
                .foregroundStyle(p.danger).padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity).card()
            } else if let inspection = inspector.inspection {
                InspectorContent(inspection: inspection)
            } else {
                emptyState
            }
        }
        .onAppear { inspector.language = settings.language }
        .onChange(of: settings.language) { inspector.language = $0 }
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            Task {
                if let path = await DroppedFiles.paths(from: providers).first { inspector.open(path) }
            }
            return true
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            DialogIcon(name: "search", size: 44)
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    CuteLabel(text: t("inspector.title"), size: 20)
                    if let volumes = inspector.splitVolumes {
                        Button { inspector.volumesExpanded.toggle() } label: {
                            HStack(spacing: 5) {
                                VectorIcon(name: "files").frame(width: 13, height: 13)
                                Text("\(t("inspector.splitArchive")) · \(t("inspector.volumeCount", ["count": volumes.count]))")
                                VectorIcon(name: "chevron-down").frame(width: 13, height: 13)
                                    .rotationEffect(.degrees(inspector.volumesExpanded ? 180 : 0))
                            }
                            .font(Typography.sans(11)).fontWeight(.bold).foregroundStyle(p.peach)
                            .padding(.horizontal, 9).padding(.vertical, 3)
                            .background(Capsule().fill(p.pill)).overlay(Capsule().strokeBorder(p.peach, lineWidth: 1.5))
                        }
                        .buttonStyle(.plain).fixedSize()
                        .accessibilityLabel(t(inspector.volumesExpanded ? "inspector.hideVolumes" : "inspector.showVolumes"))
                    }
                }
                Text(inspector.archivePath.isEmpty ? t("inspector.subtitle") : inspector.archivePath)
                    .font(Typography.sans(13)).foregroundStyle(p.muted).lineLimit(1).truncationMode(.middle)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 0)
        }
        .padding(16).card()
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Button(action: browse) {
                VectorIcon(name: "cloud-upload").frame(width: 28, height: 28).foregroundStyle(p.text)
                    .frame(width: 56, height: 56)
                    .background(Circle().fill(p.pill).background(Circle().fill(p.shadow).offset(x: 2, y: 2)))
                    .overlay(Circle().strokeBorder(p.border, lineWidth: 2))
            }
            .buttonStyle(.plain).accessibilityLabel(t("inspector.selectArchive"))
            CuteLabel(text: t("dropZone.dropArchives"), size: 20)
            Text(t("dropZone.archivesHint")).font(Typography.sans(13)).foregroundStyle(p.muted)
            CozyButton(title: t("dropZone.browseFiles"), icon: "file-plus", action: browse)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity).card()
    }

    private func browse() {
        Task {
            if let path = await FilePanels.chooseArchives(title: t("dialogs.selectExtractInputs")).first {
                inspector.open(path)
            }
        }
    }
}

private struct InspectorContent: View {
    @EnvironmentObject private var inspector: InspectorModel
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t
    let inspection: ArchiveInspection

    var body: some View {
        ScrollViewReader { scroller in
            ScrollView {
                VStack(spacing: 16) {
                    if let volumes = inspector.splitVolumes, inspector.volumesExpanded { volumesPanel(volumes) }
                    if settings.expert { diagnostics }
                    stats
                    browser(scroller)
                }
                .padding(.trailing, 3).padding(.bottom, 3)
            }
        }
    }

    private func volumesPanel(_ volumes: [ArchiveVolume]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    CuteLabel(text: t("inspector.volumes"), size: 16)
                    Text(t("inspector.splitDescription", ["count": volumes.count])).font(Typography.sans(12)).foregroundStyle(p.muted)
                }
                Spacer()
                Text(t.bytes(volumes.reduce(0) { $0 + $1.size })).font(Typography.mono(12)).foregroundStyle(p.muted)
            }
            VStack(spacing: 5) {
                ForEach(volumes, id: \.path) { volume in
                    HStack(spacing: 8) {
                        VectorIcon(name: "file").frame(width: 15, height: 15).foregroundStyle(p.dim)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(volume.name).font(Typography.sans(12)).fontWeight(.semibold).foregroundStyle(p.text)
                            Text(volume.path).font(Typography.mono(10)).foregroundStyle(p.dim)
                        }
                        .lineLimit(1).truncationMode(.middle).frame(maxWidth: .infinity, alignment: .leading)
                        Text(t.bytes(volume.size)).font(Typography.mono(11)).foregroundStyle(p.muted)
                    }
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(RoundedRectangle(cornerRadius: 8).fill(p.subtle))
                }
            }
        }
        .padding(16).card()
        .accessibilityElement(children: .contain).accessibilityLabel(t("inspector.volumes"))
    }

    private var diagnostics: some View {
        let header = inspection.header
        var items: [(label: String, value: String, code: Bool)] = [
            (t("inspector.signature"), header.signature ?? "N/A", true),
            (t("inspector.codec"), header.codecSummary ?? "N/A", false),
            (t("inspector.encryptionMethod"), header.encryptionAlgorithm ?? "None", false),
            (t("inspector.solid"), t(header.solid ? "inspector.solidYes" : "inspector.solidNo"), false),
        ]
        if let version = header.formatVersion { items.append((t("inspector.headerVersion"), version, true)) }
        if let offset = header.centralDirectoryOffset { items.append((t("inspector.centralDirOffset"), Self.hex(offset), true)) }
        if let size = header.centralDirectorySize { items.append((t("inspector.centralDirSize"), t.bytes(size), false)) }
        if let offset = header.nextHeaderOffset { items.append((t("inspector.nextHeaderOffset"), Self.hex(offset), true)) }
        if let size = header.nextHeaderSize { items.append((t("inspector.nextHeaderSize"), t.bytes(size), false)) }
        return ExpertCard(title: t("inspector.expertHeader"), icon: "microscope") {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 12, alignment: .topLeading)], alignment: .leading, spacing: 12) {
                ForEach(items.indices, id: \.self) { index in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(items[index].label).font(Typography.cute(13)).foregroundStyle(p.muted)
                        if items[index].code {
                            CodeBadge(text: items[index].value)
                        } else {
                            Text(items[index].value).font(Typography.sans(13)).fontWeight(.semibold).foregroundStyle(p.text)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    private var stats: some View {
        var cells: [(label: String, value: String, color: Color?, mono: Bool)] = [
            (t("inspector.format"), inspection.format, p.peach, false),
            (t("inspector.totalFiles"), t("inspector.fileCount", ["count": inspection.totalFiles]), nil, false),
            (t("inspector.extractedSize"), inspection.totalUncompressedSize.map { t.bytes($0) } ?? t("inspector.unknown"), nil, true),
            (t("inspector.compressedSize"), t.bytes(inspection.totalCompressedSize), nil, true),
            (t("inspector.efficiency"), inspection.overallRatio.map { t("inspector.savings", ["ratio": percent($0)]) } ?? t("inspector.unknown"), p.success, false),
        ]
        if let volumes = inspector.splitVolumes {
            cells.append((t("inspector.volumes"), t("inspector.volumeCount", ["count": volumes.count]), p.peach, false))
        }
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
            ForEach(cells.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: 2) {
                    Text(cells[index].label).font(Typography.cute(14)).foregroundStyle(p.muted)
                    Text(cells[index].value)
                        .font(cells[index].mono ? Typography.mono(16) : Typography.cute(18))
                        .foregroundStyle(cells[index].color ?? p.text).lineLimit(1).minimumScaleFactor(0.7)
                        .frame(height: 24, alignment: .leading)
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading).card()
            }
        }
    }

    private func browser(_ scroller: ScrollViewProxy) -> some View {
        let all = inspector.allDisplayedEntries
        let shown = inspector.displayedEntries
        let expert = settings.expert
        return VStack(alignment: .leading, spacing: 0) {
            breadcrumbs.padding(.bottom, 12)
            HStack(spacing: 12) {
                HStack(spacing: 8) {
                    VectorIcon(name: "filter").frame(width: 16, height: 16).foregroundStyle(p.muted)
                    TextField("", text: $inspector.searchQuery, prompt: Text(t("inspector.searchPlaceholder")).foregroundColor(p.dim))
                        .textFieldStyle(.plain).font(Typography.sans(13)).foregroundStyle(p.text)
                }
                .padding(.horizontal, 12).frame(height: 38)
                .doodle(radius: 10, fill: p.input, border: p.border, shadow: p.shadow)
                Text(t(inspector.isSearching ? "inspector.searchResults" : "inspector.currentFolder", ["count": all.count]))
                    .font(Typography.cute(14)).foregroundStyle(p.muted).fixedSize()
            }
            .padding(.bottom, 12)
            EntryTable(expert: expert, searching: inspector.isSearching, entries: Array(shown)) { id in
                inspector.focusBlock(id)
                // The panel has to be laid out before it can be scrolled to.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    withAnimation { scroller.scrollTo("block-\(id)", anchor: .center) }
                }
            }
            if shown.count < all.count {
                CozyButton(title: t("inspector.loadMore", ["count": min(InspectorModel.pageSize, all.count - shown.count)])) {
                    inspector.visibleCount += InspectorModel.pageSize
                }
                .frame(maxWidth: .infinity).padding(.top, 12)
            }
            if shown.isEmpty {
                Text(t(inspector.isSearching ? "inspector.noSearchResults" : "inspector.emptyFolder"))
                    .font(Typography.cute(15)).foregroundStyle(p.dim).frame(maxWidth: .infinity).padding(.vertical, 28)
            }
            let blocks = inspector.solidBlocks
            if !blocks.isEmpty { SolidBlocksPanel(blocks: blocks).padding(.top, 14) }
        }
        .padding(16).frame(minHeight: 280, alignment: .top).card()
    }

    private var breadcrumbs: some View {
        let segments = inspector.breadcrumbs
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Button { inspector.move(to: "") } label: {
                    VectorIcon(name: "house").frame(width: 15, height: 15).foregroundStyle(p.text)
                }
                .buttonStyle(.plain).help(t("inspector.home")).accessibilityLabel(t("inspector.home"))
                ForEach(segments.indices, id: \.self) { index in
                    VectorIcon(name: "chevron-right").frame(width: 15, height: 15).foregroundStyle(p.dim)
                    Button(segments[index]) { inspector.move(to: segments[...index].joined(separator: "/")) }
                        .buttonStyle(.plain).font(Typography.sans(13))
                        .fontWeight(index == segments.count - 1 ? .bold : .medium)
                        .foregroundStyle(index == segments.count - 1 ? p.peach : p.text)
                }
            }
            .frame(minHeight: 32)
        }
    }

    private func percent(_ value: Double) -> String {
        t.number(value, fractionDigits: 2)
    }

    static func hex<Value: BinaryInteger>(_ value: Value) -> String {
        "0x" + String(value, radix: 16, uppercase: true)
    }
}

/// The file table: name, sizes and savings, and in expert mode the codec,
/// encryption, CRC, mode and offset of each entry.
private struct EntryTable: View {
    @EnvironmentObject private var inspector: InspectorModel
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t
    let expert: Bool
    let searching: Bool
    let entries: [BrowserEntry]
    let focusBlock: (UInt32) -> Void
    @State private var width: CGFloat = 0

    private var fractions: [CGFloat] { expert ? [2.1, 0.8, 0.8, 0.65, 0.85, 0.85, 1, 0.9, 0.75] : [2, 1, 1, 1] }

    private var widths: [CGFloat] {
        let total = fractions.reduce(0, +)
        return fractions.map { width * $0 / total }
    }

    var body: some View {
        VStack(spacing: 0) {
            headerRow
            LazyVStack(spacing: 0) {
                ForEach(entries) { row($0) }
            }
        }
        .background(GeometryReader { geometry in
            Color.clear.onAppear { width = geometry.size.width }.onChange(of: geometry.size.width) { width = $0 }
        })
    }

    private var headerRow: some View {
        let titles = [t(searching ? "inspector.path" : "inspector.fileName"), t("inspector.originalSize"), t("inspector.compressedSize"), t("inspector.ratio")]
            + (expert ? [t("inspector.codec"), t("inspector.encryptionMethod"), t("inspector.crc32"), t("inspector.permissions"), t("inspector.offset")] : [])
        return HStack(spacing: 0) {
            ForEach(titles.indices, id: \.self) { index in
                Text(titles[index]).font(Typography.cute(15)).foregroundStyle(p.text).lineLimit(1).minimumScaleFactor(0.7)
                    .frame(width: widths[safe: index] ?? 0, alignment: index == 0 ? .leading : index < 4 ? .trailing : .center)
            }
        }
        .padding(.bottom, 8)
        .overlay(alignment: .bottom) { p.border.frame(height: 2) }
    }

    private func row(_ row: BrowserEntry) -> some View {
        EntryRow(row: row, expert: expert, searching: searching, widths: widths, focusBlock: focusBlock)
    }
}

private struct EntryRow: View {
    @EnvironmentObject private var inspector: InspectorModel
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t
    let row: BrowserEntry
    let expert: Bool
    let searching: Bool
    let widths: [CGFloat]
    let focusBlock: (UInt32) -> Void
    @State private var hovering = false

    var body: some View {
        Button {
            if row.isDirectory {
                inspector.move(to: InspectorModel.normalized(row.path))
            } else if let entry = row.entry {
                inspector.preview(entry, rawBytes: expert)
            }
        } label: {
            HStack(spacing: 0) {
                HStack(spacing: 8) {
                    VectorIcon(name: row.isDirectory ? "folder" : "file").frame(width: 16, height: 16).foregroundStyle(p.peach)
                    Text(searching ? inspector.relativeDisplayPath(row.path) : row.name)
                        .font(Typography.sans(13)).fontWeight(.medium).lineLimit(1).truncationMode(.middle)
                    if row.isDirectory {
                        VectorIcon(name: "chevron-right").frame(width: 15, height: 15).foregroundStyle(p.dim)
                    }
                }
                .frame(width: widths[safe: 0] ?? 0, alignment: .leading)
                cell(1, sizeText)
                compressedCell.frame(width: widths[safe: 2] ?? 0, alignment: .trailing)
                cell(3, ratioText, color: (row.entry?.ratio ?? 0) > 0 ? p.success : nil)
                if expert, let entry = row.entry {
                    CodeBadge(text: entry.codec ?? "-").frame(width: widths[safe: 4] ?? 0)
                    CodeBadge(text: entry.encryptionMethod.isEmpty ? "-" : entry.encryptionMethod).frame(width: widths[safe: 5] ?? 0)
                    cell(6, entry.crc32.map { "0x" + String(format: "%08X", $0) } ?? "-", mono: true, alignment: .center)
                    cell(7, modeText(entry), mono: true, alignment: .center, color: p.muted)
                    cell(8, entry.offset.map { InspectorContent.hex($0) } ?? "-", mono: true, alignment: .center, color: p.muted)
                } else if expert {
                    ForEach(4..<9, id: \.self) { cell($0, "", alignment: .center) }
                }
            }
            .foregroundStyle(p.text)
            .padding(.vertical, 10)
            .background(hovering ? p.cardHover : .clear)
            .overlay(alignment: .bottom) {
                Line().stroke(p.borderSubtle, style: StrokeStyle(lineWidth: 1, dash: [3, 2])).frame(height: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).onHover { hovering = $0 }
    }

    private var sizeText: String {
        if row.isDirectory { return "-" }
        return row.entry?.size.map { t.bytes($0) } ?? t("inspector.unknown")
    }

    private var ratioText: String {
        guard let ratio = row.entry?.ratio else { return "-" }
        return "\(t.number(ratio, fractionDigits: 2))%"
    }

    @ViewBuilder private var compressedCell: some View {
        if let block = row.entry?.solidBlock {
            Button { focusBlock(block.id) } label: {
                Text("#\(block.id)").font(Typography.cute(11)).fontWeight(.bold).foregroundStyle(p.peach)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(Capsule().fill(p.shadow).offset(x: 1, y: 1))
                    .background(Capsule().fill(p.subtle))
                    .overlay(Capsule().strokeBorder(p.peach, lineWidth: 1.5))
            }
            .buttonStyle(.plain)
            .help(t("inspector.solidBlockBadgeHint", ["number": block.id]))
            .accessibilityLabel(t("inspector.solidBlockBadgeHint", ["number": block.id]))
        } else {
            Text(row.entry?.compressedSize.map { t.bytes($0) } ?? "-").font(Typography.sans(13))
        }
    }

    private func modeText(_ entry: InspectedEntry) -> String {
        guard let string = entry.modeString else { return "-" }
        guard let mode = entry.mode else { return string }
        let octal = String(mode & 0o777, radix: 8)
        return "0\(String(repeating: "0", count: max(0, 3 - octal.count)))\(octal) / \(string)"
    }

    private func cell(_ index: Int, _ text: String, mono: Bool = false, alignment: Alignment = .trailing, color: Color? = nil) -> some View {
        Text(text).font(mono ? Typography.mono(11) : Typography.sans(13)).foregroundStyle(color ?? p.text)
            .lineLimit(1).minimumScaleFactor(0.8)
            .frame(width: widths[safe: index] ?? 0, alignment: alignment)
    }
}

/// The collapsible list of a 7z's solid blocks and the files in each.
private struct SolidBlocksPanel: View {
    @EnvironmentObject private var inspector: InspectorModel
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t
    let blocks: [SolidBlockSummary]

    var body: some View {
        VStack(spacing: 0) {
            Button { inspector.blocksPanelOpen.toggle() } label: {
                HStack(spacing: 8) {
                    VectorIcon(name: "boxes").frame(width: 16, height: 16)
                    Text(t("inspector.solidBlocksTitle")).font(Typography.cute(15))
                    Text(t("inspector.solidBlocksSummary", ["count": blocks.count])).font(Typography.sans(12)).foregroundStyle(p.muted)
                    Spacer()
                    VectorIcon(name: inspector.blocksPanelOpen ? "chevron-down" : "chevron-right").frame(width: 16, height: 16)
                }
                .foregroundStyle(p.text).padding(.horizontal, 14).padding(.vertical, 10)
                .background(p.subtle).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if inspector.blocksPanelOpen {
                VStack(spacing: 8) {
                    ForEach(blocks) { block in card(block).id("block-\(block.id)") }
                }
                .padding(12)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .doodle(radius: 12, fill: p.card, border: p.border, shadow: p.shadow)
    }

    private func card(_ block: SolidBlockSummary) -> some View {
        let expanded = inspector.expandedBlocks.contains(block.id)
        let selected = inspector.selectedBlock == block.id
        let saved = Int64(block.uncompressedSize) - Int64(block.compressedSize)
        return VStack(spacing: 0) {
            Button { inspector.toggleBlock(block.id) } label: {
                HStack(spacing: 8) {
                    VectorIcon(name: expanded ? "chevron-down" : "chevron-right").frame(width: 15, height: 15)
                    VectorIcon(name: "files").frame(width: 15, height: 15).foregroundStyle(p.peach)
                    Text(t("inspector.solidBlock", ["number": block.id])).font(Typography.cute(13))
                    CodeBadge(text: block.codec ?? "LZMA2")
                    Text(t("inspector.fileCount", ["count": block.fileCount])).font(Typography.sans(12)).foregroundStyle(p.muted)
                    Spacer(minLength: 8)
                    Text("\(t.bytes(block.uncompressedSize)) → \(t.bytes(block.compressedSize))")
                        .font(Typography.mono(11)).foregroundStyle(p.muted)
                    Text(t(saved >= 0 ? "inspector.solidBlockSaved" : "inspector.solidBlockExpanded", [
                        "size": t.bytes(UInt64(abs(saved))), "ratio": block.ratio.map { t.number($0, fractionDigits: 2) } ?? "-",
                    ]))
                    .font(Typography.sans(12)).fontWeight(.bold).foregroundStyle(saved >= 0 ? p.success : p.danger)
                }
                .foregroundStyle(p.text).padding(.horizontal, 12).padding(.vertical, 9).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                VStack(spacing: 2) {
                    ForEach(block.entries, id: \.index) { entry in
                        Button { inspector.preview(entry, rawBytes: settings.expert) } label: {
                            HStack(spacing: 8) {
                                VectorIcon(name: "file").frame(width: 14, height: 14).foregroundStyle(p.peach)
                                Text(entry.path).font(Typography.mono(11)).lineLimit(1).truncationMode(.middle)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Text(entry.size.map { t.bytes($0) } ?? "-").font(Typography.mono(11)).foregroundStyle(p.muted)
                            }
                            .foregroundStyle(p.text).padding(.horizontal, 12).padding(.vertical, 5).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).help(entry.path)
                    }
                }
                .padding(.bottom, 8)
            }
        }
        .background(RoundedRectangle(cornerRadius: 8).fill(selected ? p.subtle : p.card))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(selected ? p.peach : p.borderSubtle, lineWidth: 1.5))
        .overlay {
            RoundedRectangle(cornerRadius: 8).fill(p.peach).mask(alignment: .leading) { Rectangle().frame(width: 4) }
        }
        .overlay {
            if selected { RoundedRectangle(cornerRadius: 10).strokeBorder(p.peach.opacity(0.35), lineWidth: 2).padding(-2) }
        }
    }
}

/// `.code-badge`: a small monospaced value in a pill.
struct CodeBadge: View {
    @Environment(\.palette) private var p
    let text: String

    var body: some View {
        Text(text).font(Typography.mono(11)).foregroundStyle(p.text).lineLimit(1)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: 4).fill(p.pill))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(p.borderSubtle, lineWidth: 1))
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
