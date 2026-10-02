import LiberaCore
import SwiftUI

/// The compression settings beside the drop zone.
struct CompressionPanel: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t
    @ObservedObject var form: CompressionForm

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                formatGrid
                if form.supportsLevel { levelField }
                if form.expertCardShown { expertCard }
                if form.supportsPassword { passwordField }
                if form.supportsSplit { splitField }
                destinationField
                CozyButton(title: t("compression.start"), icon: "archive", primary: true, height: 48, action: start)
                    .disabled(model.compressItems.isEmpty || form.passwordMismatch || form.splitInvalid)
                    .padding(.trailing, 3).padding(.bottom, 3)
            }
            .padding(20)
        }
        .card()
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private var header: some View {
        HStack(spacing: 8) {
            VectorIcon(name: "sliders-vertical").frame(width: 18, height: 18).foregroundStyle(p.peach)
            CuteLabel(text: t("compression.title"), size: 18).layoutPriority(1)
            Spacer(minLength: 4)
            Text(t("compression.totalSize", ["size": t.bytes(model.compressItems.reduce(0) { $0 + $1.size })]))
                .font(Typography.mono(12)).foregroundStyle(p.muted).lineLimit(2).multilineTextAlignment(.trailing)
        }
    }

    private var formatGrid: some View {
        VStack(alignment: .leading, spacing: 8) {
            label("compression.format")
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 90), spacing: 10)], spacing: 10) {
                ForEach(ArchiveFormat.allCases) { format in
                    let active = form.format == format
                    Button { form.select(format) } label: {
                        Text(".\(format.label)").font(Typography.cute(16)).fontWeight(.bold)
                            .foregroundStyle(active ? p.peach : p.text)
                            .frame(maxWidth: .infinity).frame(height: 42)
                            .doodle(radius: 12, fill: active ? p.pill : p.card, border: active ? p.peach : p.border,
                                    lineWidth: active ? 2 : 1.5, shadow: active ? p.shadow : nil)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var levelField: some View {
        VStack(spacing: 6) {
            HStack {
                label("compression.level")
                Spacer()
                Text(form.perFileActive ? CompressionForm.clearedValue : t(form.levelLabelKey, ["level": form.effectiveLevel]))
                    .font(Typography.sans(12)).fontWeight(.semibold).foregroundStyle(p.peach)
            }
            CozySlider(label: t("compression.level"), value: levelIndex, range: 0...max(0, form.levels.count - 1),
                       cleared: form.perFileActive)
                .disabled(form.storeSelected || form.perFileActive)
        }
    }

    /// The slider moves over the levels a format has, not over 0...9.
    private var levelIndex: Binding<Int> {
        Binding(
            get: { form.levels.firstIndex(of: form.effectiveLevel) ?? 0 },
            set: { index in if form.levels.indices.contains(index) { form.level = form.levels[index] } }
        )
    }

    // MARK: Expert settings

    private var expertCard: some View {
        ExpertCard(title: t("compression.expertTitle"), icon: "package") {
            VStack(alignment: .leading, spacing: 12) {
                if form.format == .zip {
                    row("compression.zipMethod") {
                        CozySelect(label: t("compression.zipMethod"), value: $form.zipMethod, options: [
                            (.deflate, t("compression.methodDeflate")), (.store, t("compression.methodStore")),
                            (.lzma, t("compression.methodZipLzma")), (.zstd, t("compression.methodZipZstd")),
                        ], cleared: form.zipSettingsCleared)
                        .disabled(form.zipSettingsCleared)
                    }
                }
                if form.format == .sevenZip { sevenZipRows }
                if form.deflateTuningShown { deflateRows }
                if form.zstdTuningShown { zstdRows }
                if form.solidShown || form.zstdTuningShown || form.sourceFiltersShown { checkboxes }
                if form.sourceFiltersShown {
                    row("compression.filterPattern") {
                        CozyField(hint: t("compression.filterPatternPlaceholder"), value: $form.filterPattern, height: 38, fontSize: 13)
                    }
                }
                if form.format == .zip || form.format == .sevenZip { perFileRow }
            }
        }
    }

    /// Switching per-file mode on hands every setting above to its dialog, so
    /// they clear rather than disappear.
    private var perFileRow: some View {
        let zip = form.format == .zip
        let enabled = zip ? form.zipPerFile : form.sevenZipPerFile
        let count = zip ? form.zipOverrides.count : form.sevenZipOverrides.count
        return HStack(spacing: 0) {
            Button { form.overridesOpen = true } label: {
                HStack(spacing: 10) {
                    VectorIcon(name: "files").frame(width: 16, height: 16).foregroundStyle(p.peach)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(t(zip ? "compression.zipOverridesButton" : "compression.sevenZipOverridesButton"))
                            .font(Typography.cute(14)).foregroundStyle(p.text)
                        Text(t(zip ? "compression.zipOverridesButtonHint" : "compression.sevenZipOverridesButtonHint"))
                            .font(Typography.sans(10)).foregroundStyle(p.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 4)
                    if count > 0 {
                        Text(t("compression.zipOverridesCount", ["count": count])).font(Typography.sans(10)).fontWeight(.bold)
                            .foregroundStyle(p.peach).padding(.horizontal, 7).padding(.vertical, 3)
                            .background(Capsule().fill(p.pill))
                    }
                }
                .padding(.leading, 12).padding(.trailing, 8).padding(.vertical, 10).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!enabled).opacity(enabled ? 1 : 0.72)
            .accessibilityLabel(t(zip ? "compression.zipOverridesButton" : "compression.sevenZipOverridesButton"))
            CozySwitch(label: t("compression.zipOverridesEnable"), on: Binding(get: { enabled }, set: { form.setPerFile($0) }))
                .padding(.leading, 6).padding(.trailing, 12)
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(form.perFileActive ? p.pill : p.card))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(form.perFileActive ? p.peach : p.border, lineWidth: 1.5))
        .padding(.top, 4)
    }

    @ViewBuilder private var sevenZipRows: some View {
        let cleared = form.sevenZipSettingsCleared
        row("compression.codecMethod") {
            CozySelect(label: t("compression.codecMethod"), value: $form.sevenZipMethod, options: [
                (.lzma2, t("compression.methodLzma2")), (.copy, t("compression.methodCopy")),
            ], cleared: cleared)
            .disabled(cleared)
        }
        if form.sevenZipTuningShown {
            row("compression.dictionarySize") {
                CozySelect(label: t("compression.dictionarySize"), value: $form.dictionarySize,
                           options: CompressionForm.dictionarySizes.map { ($0.value, $0.label) }, cleared: cleared)
                .disabled(cleared)
            }
            row("compression.matchFinderWordSize") {
                CozySelect(label: t("compression.matchFinderWordSize"), value: $form.wordSize,
                           options: CompressionForm.wordSizes.map { ($0, String($0)) }, cleared: cleared)
                .disabled(cleared)
            }
            row("compression.searchCycles", value: cleared ? CompressionForm.clearedValue : String(form.searchCycles)) {
                CozySlider(label: t("compression.searchCycles"), value: integer($form.searchCycles), range: 1...1024, cleared: cleared)
                    .disabled(cleared)
            }
        }
    }

    @ViewBuilder private var deflateRows: some View {
        let cleared = form.zipSettingsCleared
        row("compression.deflateStrategy") {
            CozySelect(label: t("compression.deflateStrategy"), value: $form.deflateStrategy, options: [
                (.default, t("compression.strategyDefault")), (.filtered, t("compression.strategyFiltered")),
                (.huffmanOnly, t("compression.strategyHuffman")), (.rle, t("compression.strategyRle")),
                (.fixed, t("compression.strategyFixed")),
            ], cleared: cleared)
            .disabled(cleared)
        }
        row("compression.memLevel", value: cleared ? CompressionForm.clearedValue : String(form.memLevel)) {
            CozySlider(label: t("compression.memLevel"), value: integer($form.memLevel), range: 1...9, cleared: cleared)
                .disabled(cleared)
        }
    }

    @ViewBuilder private var zstdRows: some View {
        row("compression.zstdStrategy") {
            CozySelect(label: t("compression.zstdStrategy"), value: $form.zstdStrategy, options: [
                (.fast, t("compression.zstdStrategyFast")), (.dfast, t("compression.zstdStrategyDfast")),
                (.greedy, t("compression.zstdStrategyGreedy")), (.lazy, t("compression.zstdStrategyLazy")),
                (.lazy2, t("compression.zstdStrategyLazy2")), (.btlazy2, t("compression.zstdStrategyBtlazy2")),
                (.btopt, t("compression.zstdStrategyBtopt")), (.btultra, t("compression.zstdStrategyBtultra")),
                (.btultra2, t("compression.zstdStrategyBtultra2")),
            ])
        }
        row("compression.zstdWindowSize") {
            CozySelect(label: t("compression.zstdWindowSize"), value: $form.zstdWindowSize,
                       options: CompressionForm.zstdWindowSizes.map { ($0.value, $0.label) })
        }
        row("compression.zstdWorkers") {
            CozySelect(label: t("compression.zstdWorkers"), value: $form.zstdWorkers, options: CompressionForm.zstdWorkerChoices.map {
                ($0, $0 == 0 ? t("compression.zstdWorkersOff") : String($0))
            })
        }
    }

    private var checkboxes: some View {
        VStack(alignment: .leading, spacing: 8) {
            if form.zstdTuningShown {
                CheckboxRow(title: t("compression.zstdLongDistance"), hint: t("compression.zstdLongDistanceHint"),
                            checked: $form.zstdLongDistance)
            }
            if form.sourceFiltersShown {
                CheckboxRow(title: t("compression.excludeSymlinks"), hint: t("compression.excludeSymlinksHint"),
                            checked: $form.excludeSymlinks)
                CheckboxRow(title: t("compression.excludeMacMetadata"), hint: t("compression.excludeMacMetadataHint"),
                            checked: $form.excludeMacMetadata)
                CheckboxRow(title: t("compression.excludeHiddenFiles"), hint: t("compression.excludeHiddenFilesHint"),
                            checked: $form.excludeHiddenFiles)
            }
            if form.solidShown {
                CheckboxRow(title: t("compression.solidArchive"), hint: t("compression.solidArchiveHint"), checked: $form.solid)
            }
        }
    }

    // MARK: Password, split and destination

    @ViewBuilder private var passwordField: some View {
        if settings.expert {
            ExpertCard(title: t("compression.expertEncryptionTitle"), icon: "lock", compact: true) { passwordControls }
        } else {
            passwordControls
        }
    }

    private var passwordControls: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                label("compression.password")
                Text(t("compression.optional")).font(Typography.sans(12)).foregroundStyle(p.muted)
            }
            .padding(.bottom, 6)
            HStack(spacing: 8) {
                CozyField(hint: t("compression.passwordPlaceholder"), value: $form.password, secure: true)
                CozyField(hint: t("compression.confirmPasswordPlaceholder"), value: $form.passwordConfirmation, secure: true)
            }
            if !form.password.isEmpty && form.passwordMismatch {
                message(t("compression.passwordMismatch"), error: true)
            }
            if settings.expert && form.format == .zip {
                row("compression.encryptionMethod") {
                    CozySelect(label: t("compression.encryptionMethod"), value: $form.zipEncryption, options: [
                        (.zipCrypto, t("compression.zipCrypto")), (.aes256, t("compression.aes256")),
                        (.aes128, t("compression.aes128")),
                    ])
                }
                .padding(.top, 12)
            }
            if !form.password.isEmpty && !form.passwordMismatch {
                message(t(form.passwordNoticeKey), error: false)
            }
            if settings.expert && form.supportsHeaderEncryption {
                // Shown from the start; it takes effect once a password backs it.
                CheckboxRow(title: t("compression.encryptFileNames"), hint: t("compression.encryptFileNamesHint"),
                            checked: $form.encryptFileNames)
                    .padding(.top, 10)
            }
        }
    }

    private var splitField: some View {
        VStack(alignment: .leading, spacing: 12) {
            OptionCard(
                title: t("compression.splitEnable"),
                description: t(form.format == .sevenZip ? "compression.splitExample7z" : "compression.splitExampleZip"),
                checked: $form.splitEnabled
            )
            if form.splitEnabled {
                VStack(alignment: .leading, spacing: 10) {
                    label("compression.splitSize")
                    FlowLayout(spacing: 8) {
                        ForEach(CompressionForm.SplitPreset.allCases) { preset in
                            choice(t(preset.labelKey), active: form.splitPreset == preset) { form.splitPreset = preset }
                        }
                    }
                    if form.splitPreset == .custom {
                        HStack(spacing: 8) {
                            CozyField(hint: t("compression.splitCustomPlaceholder"), value: $form.splitCustomValue, height: 34)
                                .frame(maxWidth: 110)
                            ForEach(CompressionForm.SplitUnit.allCases) { unit in
                                choice(unit.rawValue, active: form.splitCustomUnit == unit) { form.splitCustomUnit = unit }
                                    .frame(minWidth: 54)
                            }
                        }
                    }
                    if form.splitInvalid { message(t("compression.splitMinimum"), error: true) }
                }
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 22).fill(p.subtle))
                .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(p.borderSubtle, style: StrokeStyle(lineWidth: 2, dash: [5, 3])))
            }
        }
    }

    private var destinationField: some View {
        VStack(alignment: .leading, spacing: 6) {
            label("compression.destination")
            HStack(spacing: 8) {
                CozyField(hint: t("compression.destinationPlaceholder"), value: $form.outputPath)
                CozyButton(title: t("compression.browse"), height: 44) {
                    Task {
                        let name = "archive\(form.format.fileExtension)"
                        if let path = await FilePanels.chooseArchiveDestination(defaultName: name, format: form.format) {
                            form.outputPath = path
                        }
                    }
                }
                .fixedSize()
            }
        }
    }

    private func start() {
        let inputs = model.compressItems.map(\.path)
        guard let options = form.options(inputs: inputs, defaultDirectory: FilePanels.defaultOutputDirectory) else { return }
        model.startCompress(options)
    }

    // MARK: Pieces

    private func label(_ key: String) -> some View {
        CuteLabel(text: t(key))
    }

    private func row<Control: View>(_ key: String, value: String? = nil, @ViewBuilder control: () -> Control) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            CuteLabel(text: value.map { "\(t(key)) (\($0))" } ?? t(key), size: 14)
            control()
        }
    }

    private func message(_ text: String, error: Bool) -> some View {
        Text(text).font(Typography.sans(12)).foregroundStyle(error ? p.danger : p.muted)
            .fixedSize(horizontal: false, vertical: true).padding(.top, 6)
    }

    private func choice(_ title: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(Typography.cute(14)).fontWeight(.bold).foregroundStyle(active ? p.peach : p.text)
                .padding(.horizontal, 12).frame(height: 32)
                .doodle(radius: 12, fill: active ? p.pill : p.card, border: active ? p.peach : p.border,
                        lineWidth: active ? 2 : 1.5, shadow: active ? p.shadow : nil)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func integer<Value: BinaryInteger>(_ binding: Binding<Value>) -> Binding<Int> {
        Binding(get: { Int(binding.wrappedValue) }, set: { binding.wrappedValue = Value($0) })
    }
}

/// Lays its children out in rows, wrapping when a row is full.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [(indices: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(indices: [Int], width: CGFloat, height: CGFloat)] = []
        var current: (indices: [Int], width: CGFloat, height: CGFloat) = ([], 0, 0)
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if needed > width && !current.indices.isEmpty {
                rows.append(current)
                current = ([index], size.width, size.height)
            } else {
                current = (current.indices + [index], needed, max(current.height, size.height))
            }
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}
