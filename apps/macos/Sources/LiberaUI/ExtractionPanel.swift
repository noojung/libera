import LiberaCore
import SwiftUI

/// Where the archives beside it go, and how they come out.
struct ExtractionPanel: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t

    @State private var targetDir = FilePanels.defaultOutputDirectory
    @State private var createSubfolder = true
    @State private var encoding = FilenameEncoding.auto
    @State private var overwritePolicy = OverwritePolicy.overwrite
    @State private var restoreTimestamps = true
    @State private var restorePermissions = true
    @State private var restoreSymlinks = true
    @State private var excludeMacMetadata = false
    @State private var strictCrc = true
    @State private var filterPattern = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                VStack(alignment: .leading, spacing: 6) {
                    CuteLabel(text: t("extraction.destination"))
                    HStack(spacing: 8) {
                        CozyField(hint: t("extraction.destinationPlaceholder"), value: $targetDir)
                        CozyButton(title: t("extraction.browse"), height: 44) {
                            Task {
                                if let folder = await FilePanels.chooseFolder(title: t("dialogs.selectExtractionDestination")) {
                                    targetDir = folder
                                }
                            }
                        }
                        .fixedSize()
                    }
                }
                OptionCard(
                    title: t("extraction.createSubfolder"),
                    description: t("extraction.example", ["directory": targetDir.isEmpty ? t("extraction.defaultDirectory") : targetDir]),
                    checked: $createSubfolder
                )
                if settings.expert { expertCard }
                CozyButton(title: t("extraction.start"), icon: "download", primary: true, height: 48) {
                    model.startExtract(request)
                }
                .disabled(model.extractItems.isEmpty || targetDir.isEmpty)
                .padding(.trailing, 3).padding(.bottom, 3)
            }
            .padding(20)
        }
        .card()
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private var header: some View {
        HStack(spacing: 8) {
            VectorIcon(name: "folder-output").frame(width: 18, height: 18).foregroundStyle(p.peach)
            CuteLabel(text: t("extraction.title"), size: 18).layoutPriority(1)
            Spacer(minLength: 4)
            Text(t("extraction.selected", [
                "count": model.extractItems.count,
                "size": t.bytes(model.extractItems.reduce(0) { $0 + $1.size }),
            ]))
            .font(Typography.mono(12)).foregroundStyle(p.muted).lineLimit(2).multilineTextAlignment(.trailing)
        }
    }

    private var expertCard: some View {
        ExpertCard(title: t("extraction.expertTitle"), icon: "package-open") {
            VStack(alignment: .leading, spacing: 12) {
                row("extraction.encoding") {
                    CozySelect(label: t("extraction.encoding"), value: $encoding, options: [
                        (.auto, t("extraction.encodingAuto")), (.utf8, t("extraction.encodingUtf8")),
                        (.cp949, t("extraction.encodingCp949")), (.shiftJis, t("extraction.encodingShiftJis")),
                        (.gbk, t("extraction.encodingGbk")), (.big5, t("extraction.encodingBig5")),
                        (.windows1252, t("extraction.encodingWin1252")), (.cp437, t("extraction.encodingCp437")),
                    ])
                }
                row("extraction.overwritePolicy") {
                    CozySelect(label: t("extraction.overwritePolicy"), value: $overwritePolicy, options: [
                        (.overwrite, t("extraction.overwriteAlways")), (.skip, t("extraction.overwriteSkip")),
                        (.rename, t("extraction.overwriteRename")),
                    ])
                }
                VStack(alignment: .leading, spacing: 8) {
                    CheckboxRow(title: t("extraction.restoreTimestamps"), checked: $restoreTimestamps)
                    CheckboxRow(title: t("extraction.restorePermissions"), checked: $restorePermissions)
                    CheckboxRow(title: t("extraction.restoreSymlinks"), checked: $restoreSymlinks)
                    CheckboxRow(title: t("extraction.stripMacMetadata"), checked: $excludeMacMetadata)
                    CheckboxRow(title: t("extraction.crcCheck"), checked: $strictCrc)
                }
                row("extraction.filterPattern") {
                    CozyField(hint: t("extraction.filterPatternPlaceholder"), value: $filterPattern, height: 38, fontSize: 13)
                }
            }
        }
    }

    /// The expert options apply only while expert mode shows them.
    private var request: ExtractionRequest {
        var request = ExtractionRequest(targetDir: targetDir, createSubfolder: createSubfolder)
        guard settings.expert else { return request }
        let pattern = filterPattern.trimmingCharacters(in: .whitespacesAndNewlines)
        request.options = ExtractionOptions(
            archivePath: "", targetDir: "", rejectExistingTarget: false, encoding: encoding,
            strictCrc: strictCrc, overwritePolicy: overwritePolicy, restoreTimestamps: restoreTimestamps,
            restorePermissions: restorePermissions, restoreSymlinks: restoreSymlinks,
            excludeMacMetadata: excludeMacMetadata, filterPattern: pattern.isEmpty ? nil : pattern
        )
        return request
    }

    private func row<Control: View>(_ key: String, @ViewBuilder control: () -> Control) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            CuteLabel(text: t(key), size: 14)
            control()
        }
    }
}
