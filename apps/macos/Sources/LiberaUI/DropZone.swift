import SwiftUI

/// The drop target and the list of what has been picked, for either the
/// compression inputs or the archives to extract.
struct DropZone: View {
    enum Mode { case compress, extract }

    @EnvironmentObject private var model: AppModel
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t
    let mode: Mode
    @State private var dragOver = false
    @State private var expanded: Set<SelectedItem.ID> = []

    private var items: [SelectedItem] { mode == .compress ? model.compressItems : model.extractItems }
    private var errorKey: String? { mode == .extract ? model.extractInputErrorKey : nil }

    var body: some View {
        VStack(spacing: 16) {
            target
            if !items.isEmpty { selection }
        }
    }

    private var target: some View {
        VStack(spacing: 0) {
            VectorIcon(name: "cloud-upload").frame(width: 28, height: 28).foregroundStyle(dragOver ? p.peach : p.text)
                .frame(width: 56, height: 56)
                .background(Circle().fill(p.pill).background(Circle().fill(p.shadow).offset(x: 2, y: 2)))
                .overlay(Circle().strokeBorder(p.border, lineWidth: 2)).padding(.bottom, 10)
            CuteLabel(text: t(mode == .compress ? "dropZone.dropFilesAndFolders" : "dropZone.dropArchives"), size: 20)
                .multilineTextAlignment(.center).padding(.bottom, 4)
            Text(t(mode == .compress ? "dropZone.filesAndFoldersHint" : "dropZone.archivesHint"))
                .font(Typography.sans(13)).foregroundStyle(p.muted).multilineTextAlignment(.center).padding(.bottom, 16)
            if let errorKey {
                Text(t(errorKey)).font(Typography.sans(13)).foregroundStyle(p.danger)
                    .multilineTextAlignment(.center).padding(.top, -8).padding(.bottom, 12)
            }
            HStack(spacing: 10) {
                CozyButton(title: t("dropZone.browseFiles"), icon: "file-plus") { browse(folders: false) }
                if mode == .compress {
                    CozyButton(title: t("dropZone.browseFolders"), icon: "folder-plus") { browse(folders: true) }
                }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: items.isEmpty ? .infinity : nil)
        .frame(minHeight: items.isEmpty ? nil : 160)
        .background {
            RoundedRectangle(cornerRadius: 20).fill(p.shadow).offset(x: dragOver ? 4 : 3, y: dragOver ? 6 : 3)
            RoundedRectangle(cornerRadius: 20).fill(dragOver ? p.secondary : p.card)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 20)
                .strokeBorder(dragOver ? p.peach : p.border, style: StrokeStyle(lineWidth: dragOver ? 2.5 : 2, dash: [6, 4]))
        )
        .scaleEffect(dragOver ? 1.01 : 1)
        .animation(.spring(response: 0.25, dampingFraction: 0.6), value: dragOver)
        .contentShape(Rectangle())
        .onTapGesture { browse(folders: false) }
        .onDrop(of: [.fileURL], isTargeted: $dragOver) { providers in
            Task { add(await DroppedFiles.paths(from: providers)) }
            return true
        }
    }

    private var selection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                CuteLabel(text: t("dropZone.selectedItems", ["count": items.count]), size: 16)
                Spacer()
                Button(t("dropZone.clearAll"), action: clear).buttonStyle(.plain)
                    .font(Typography.cute(15)).foregroundStyle(p.danger)
            }
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(items) { item in row(item) }
                }
                .padding(.trailing, 4)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .card()
    }

    private func row(_ item: SelectedItem) -> some View {
        let open = expanded.contains(item.id)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                HStack(spacing: 10) {
                    VectorIcon(name: item.isDirectory ? "folder" : item.volumes == nil ? "file" : "files")
                        .frame(width: 18, height: 18).foregroundStyle(p.peach)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 8) {
                            Text(item.name).font(Typography.sans(14)).fontWeight(.semibold).foregroundStyle(p.text)
                                .lineLimit(1).truncationMode(.middle)
                            if let volumes = item.volumes { volumeBadge(item, count: volumes.count, open: open) }
                        }
                        Text(item.path).font(Typography.mono(11)).foregroundStyle(p.dim)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text(t.bytes(item.size)).font(Typography.mono(12)).foregroundStyle(p.muted).fixedSize()
                RemoveButton(label: t("dropZone.removeItem", ["name": item.name])) { remove(item) }
            }
            if let volumes = item.volumes, open {
                VStack(spacing: 5) {
                    ForEach(volumes, id: \.path) { volume in
                        HStack(spacing: 8) {
                            VectorIcon(name: "file").frame(width: 14, height: 14).foregroundStyle(p.dim)
                            VStack(alignment: .leading, spacing: 0) {
                                Text(volume.name).font(Typography.sans(12)).fontWeight(.semibold).foregroundStyle(p.text)
                                Text(volume.path).font(Typography.mono(10)).foregroundStyle(p.dim)
                            }
                            .lineLimit(1).truncationMode(.middle).frame(maxWidth: .infinity, alignment: .leading)
                            Text(t.bytes(volume.size)).font(Typography.mono(11)).foregroundStyle(p.muted)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 8).fill(p.card))
                    }
                }
                .padding(.top, 8)
                .overlay(alignment: .top) {
                    Line().stroke(p.border, style: StrokeStyle(lineWidth: 1, dash: [3, 2])).frame(height: 1)
                }
                .padding(.top, 10)
                .accessibilityElement(children: .contain)
                .accessibilityLabel(t("dropZone.volumeList", ["name": item.name]))
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 12).fill(p.subtle))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border, lineWidth: 1.5))
    }

    private func volumeBadge(_ item: SelectedItem, count: Int, open: Bool) -> some View {
        Button {
            if open { expanded.remove(item.id) } else { expanded.insert(item.id) }
        } label: {
            HStack(spacing: 4) {
                Text("\(t("dropZone.splitArchive")) · \(t("dropZone.volumeCount", ["count": count]))")
                VectorIcon(name: "chevron-down").frame(width: 11, height: 11).rotationEffect(.degrees(open ? 180 : 0))
            }
            .font(Typography.sans(10)).fontWeight(.bold).foregroundStyle(p.muted).lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Capsule().fill(p.pill)).overlay(Capsule().strokeBorder(p.border, lineWidth: 1))
        }
        .buttonStyle(.plain).fixedSize()
        .accessibilityLabel(t(open ? "dropZone.hideVolumes" : "dropZone.showVolumes", ["name": item.name]))
    }

    private func browse(folders: Bool) {
        Task {
            switch mode {
            case .compress:
                add(await FilePanels.chooseInputs(title: t("dialogs.selectCompressInputs"), folders: folders))
            case .extract:
                add(await FilePanels.chooseArchives(title: t("dialogs.selectExtractInputs")))
            }
        }
    }

    private func add(_ paths: [String]) {
        guard !paths.isEmpty else { return }
        Task {
            switch mode {
            case .compress: await model.addCompressInputs(paths)
            case .extract: await model.addExtractInputs(paths)
            }
        }
    }

    private func remove(_ item: SelectedItem) {
        expanded.remove(item.id)
        switch mode {
        case .compress: model.compressItems.removeAll { $0.id == item.id }
        case .extract: model.extractItems.removeAll { $0.id == item.id }
        }
    }

    private func clear() {
        expanded = []
        switch mode {
        case .compress: model.compressItems = []
        case .extract: model.clearExtractItems()
        }
    }
}

/// The small × that takes a row off a list.
struct RemoveButton: View {
    @Environment(\.palette) private var p
    let label: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            VectorIcon(name: "x").frame(width: 16, height: 16).foregroundStyle(hovering ? p.danger : p.dim)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).onHover { hovering = $0 }.help(label).accessibilityLabel(label)
    }
}

#if DEBUG
#Preview("비어 있음") {
    PreviewHost { DropZone(mode: .compress).padding(20) }.frame(width: 560, height: 680)
}

#Preview("선택한 항목") {
    PreviewHost(setUp: { $0.extractItems = PreviewSamples.extractItems }) {
        DropZone(mode: .extract).padding(20)
    }
    .frame(width: 560, height: 680)
}
#endif
