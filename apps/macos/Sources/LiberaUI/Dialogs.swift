import AppKit
import LiberaCore
import SwiftUI

/// A modal dialog over a dimmed window, the renderer's modal shell. A click
/// on the backdrop or Escape closes it.
struct Dialog<Content: View>: View {
    @Environment(\.palette) private var p
    var width: CGFloat = 440
    var padding: CGFloat = 24
    let onClose: () -> Void
    @ViewBuilder var content: Content

    var body: some View {
        ZStack {
            p.backdrop.ignoresSafeArea().onTapGesture(perform: onClose)
            content
                .padding(padding)
                .frame(maxWidth: width)
                .card()
                .padding(24)
        }
        .onExitCommand(perform: onClose)
    }
}

/// The round icon badge a dialog's heading starts with.
struct DialogIcon: View {
    @Environment(\.palette) private var p
    let name: String
    var color: Color?
    var size: CGFloat = 42

    var body: some View {
        VectorIcon(name: name).frame(width: size / 2, height: size / 2).foregroundStyle(color ?? p.peach)
            .frame(width: size, height: size)
            .background(Circle().fill(p.pill).background(Circle().fill(p.shadow).offset(x: 2, y: 2)))
            .overlay(Circle().strokeBorder(p.border, lineWidth: 2))
    }
}

/// The × in a dialog's corner.
struct CloseButton: View {
    @Environment(\.palette) private var p
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VectorIcon(name: "x").frame(width: 18, height: 18).foregroundStyle(p.text)
                .frame(width: 34, height: 34)
                .doodle(radius: 10, fill: p.card, border: p.border, lineWidth: 1.5, shadow: p.shadow, offset: 1.5)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).help(label).accessibilityLabel(label).keyboardShortcut(.cancelAction)
    }
}

/// Asks for an archive's password, `PasswordPromptModal.tsx`.
struct PasswordPromptView: View {
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t
    let archiveName: String
    let incorrect: Bool
    var confirmLabel: String?
    let onConfirm: (String) -> Void
    let onCancel: () -> Void
    @State private var password = ""
    @FocusState private var focused: Bool

    var body: some View {
        Dialog(onClose: onCancel) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    DialogIcon(name: "lock-keyhole")
                    VStack(alignment: .leading, spacing: 2) {
                        CuteLabel(text: t("passwordPrompt.title"), size: 20)
                        Text(archiveName).font(Typography.sans(13)).foregroundStyle(p.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Text(t("passwordPrompt.description")).font(Typography.sans(14)).foregroundStyle(p.muted)
                    .lineSpacing(4).fixedSize(horizontal: false, vertical: true)
                if incorrect {
                    Text(t("passwordPrompt.incorrect")).font(Typography.sans(13)).foregroundStyle(p.danger)
                        .padding(.top, -8)
                }
                CozyField(hint: t("passwordPrompt.placeholder"), value: $password, secure: true)
                    .focused($focused).onSubmit(confirm)
                HStack(spacing: 10) {
                    Spacer()
                    CozyButton(title: t("passwordPrompt.cancel"), action: onCancel).fixedSize()
                    CozyButton(title: confirmLabel ?? t("passwordPrompt.extract"), primary: true, height: 42, action: confirm)
                        .disabled(password.isEmpty).fixedSize()
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .onAppear { focused = true }
    }

    private func confirm() {
        if !password.isEmpty { onConfirm(password) }
    }
}

/// The queue's password prompt.
struct PasswordPromptDialog: View {
    @EnvironmentObject private var queue: JobQueue
    let prompt: PasswordPrompt

    var body: some View {
        PasswordPromptView(
            archiveName: prompt.archiveName, incorrect: prompt.incorrect,
            onConfirm: { queue.answerPasswordPrompt($0) }, onCancel: { queue.answerPasswordPrompt(nil) }
        )
    }
}

struct UnsupportedFormatDialog: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t

    var body: some View {
        Dialog(onClose: model.dismissSheet) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    VectorIcon(name: "file-warning").frame(width: 24, height: 24).foregroundStyle(p.warning)
                    CuteLabel(text: t("errors.unsupportedArchive"), size: 20)
                }
                Text(t("unsupportedFormat.description")).font(Typography.sans(13)).foregroundStyle(p.muted)
                    .lineSpacing(5).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    Spacer()
                    CozyButton(title: t("unsupportedFormat.viewFormats")) { model.present(.supportedFormats) }.fixedSize()
                    CozyButton(title: t("unsupportedFormat.confirm"), primary: true, height: 42, action: model.dismissSheet)
                        .fixedSize().keyboardShortcut(.defaultAction)
                }
            }
        }
    }
}

/// What each format the app reads can be asked to do.
struct SupportedFormatsDialog: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t

    private struct Row: Identifiable {
        let name: String
        let extensions: [String]
        let writable: ArchiveFormat?
        var id: String { name }
    }

    /// Every format here can be opened; the columns are what separates them,
    /// since several are read only.
    private static let rows: [Row] = [
        Row(name: "ZIP", extensions: [".zip"], writable: .zip),
        Row(name: "7Z", extensions: [".7z"], writable: .sevenZip),
        Row(name: "TAR", extensions: [".tar"], writable: .tar),
        Row(name: "TAR.GZ", extensions: [".tar.gz", ".tgz"], writable: .tgz),
        Row(name: "TAR.XZ", extensions: [".tar.xz", ".txz"], writable: nil),
        Row(name: "TAR.BZ2", extensions: [".tar.bz2", ".tbz2", ".tbz"], writable: nil),
        Row(name: "TAR.ZST", extensions: [".tar.zst", ".tzst"], writable: .tzst),
        Row(name: "GZ", extensions: [".gz"], writable: .gz),
        Row(name: "XZ", extensions: [".xz"], writable: nil),
        Row(name: "BZ2", extensions: [".bz2"], writable: nil),
        Row(name: "ZST", extensions: [".zst"], writable: .zst),
        Row(name: "JAR", extensions: [".jar"], writable: nil),
        Row(name: "WAR", extensions: [".war"], writable: nil),
    ]

    var body: some View {
        Dialog(width: 560, padding: 20, onClose: model.dismissSheet) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 16) {
                    HStack(spacing: 12) {
                        DialogIcon(name: "file-archive", color: p.success, size: 40)
                        VStack(alignment: .leading, spacing: 2) {
                            CuteLabel(text: t("supportedFormats.title"), size: 20)
                            Text(t("supportedFormats.description")).font(Typography.sans(13)).foregroundStyle(p.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 0)
                    CloseButton(label: t("supportedFormats.close"), action: model.dismissSheet)
                }
                ScrollView {
                    Grid(horizontalSpacing: 6, verticalSpacing: 0) {
                        GridRow {
                            ForEach(["format", "compress", "extract", "read", "password", "split"], id: \.self) { column in
                                Text(t("supportedFormats.\(column)").uppercased())
                                    .font(Typography.sans(11)).fontWeight(.semibold).foregroundStyle(p.muted)
                                    .frame(maxWidth: column == "format" ? .infinity : 64, alignment: column == "format" ? .leading : .center)
                                    .padding(.vertical, 8)
                            }
                        }
                        ForEach(Self.rows) { row in
                            Divider().overlay(p.borderSubtle)
                            GridRow {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(row.name).font(Typography.sans(13)).fontWeight(.semibold).foregroundStyle(p.text)
                                    Text(row.extensions.joined(separator: " · ")).font(Typography.sans(11)).foregroundStyle(p.muted)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                ability(row.writable != nil)
                                ability(true)
                                ability(true)
                                ability(row.writable.map { supportsPassword(format: $0) } ?? false)
                                ability(row.writable.map { supportsSplit(format: $0) } ?? false)
                            }
                            .padding(.vertical, 8)
                        }
                    }
                    .padding(.horizontal, 2)
                }
                .frame(maxHeight: 460)
            }
        }
    }

    /// A filled tick or a bare dash, told apart by shape as well as colour.
    private func ability(_ able: Bool) -> some View {
        ZStack {
            if able {
                Circle().fill(p.successSoft)
                VectorIcon(name: "check", lineWidth: 3).frame(width: 14, height: 14).foregroundStyle(p.success)
            } else {
                VectorIcon(name: "minus").frame(width: 12, height: 12).foregroundStyle(p.dim)
            }
        }
        .frame(width: 24, height: 24).frame(width: 64)
        .accessibilityElement().accessibilityLabel(t(able ? "supportedFormats.yes" : "supportedFormats.no"))
    }
}

/// The app's name, version and links, `AboutModal.tsx`.
struct AboutDialog: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t

    private struct AppInfo: Decodable {
        let version: String
        let homepage: String
        let repositoryUrl: String
        let copyrightYear: String
        let copyrightHolder: String
    }

    private static let info: AppInfo? = AppResources.data("appInfo", "json")
        .flatMap { try? JSONDecoder().decode(AppInfo.self, from: $0) }

    private static let logo = AppResources.url("logo", "png").flatMap(NSImage.init(contentsOf:))

    var body: some View {
        Dialog(width: 400, onClose: model.dismissSheet) {
            VStack(spacing: 14) {
                VStack(spacing: 4) {
                    if let logo = Self.logo {
                        Image(nsImage: logo).resizable().scaledToFit().frame(width: 72, height: 72)
                    }
                    CuteLabel(text: "Libera", size: 28)
                    if let info = Self.info {
                        Text(t("about.version", ["version": info.version])).font(Typography.mono(12)).foregroundStyle(p.muted)
                    }
                    Text(t("about.tagline")).font(Typography.sans(13)).foregroundStyle(p.muted)
                        .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity)
                if let info = Self.info {
                    HStack(spacing: 8) {
                        link(t("about.website"), icon: "external-link", url: info.homepage)
                        link(t("about.viewSource"), icon: "github", url: info.repositoryUrl)
                    }
                }
                section(t("supportedFormats.title"), hint: t("about.supportedFormatsHint"), icon: "file-archive") {
                    model.present(.supportedFormats)
                }
                section(t("about.openSourceLicenses"), hint: t("about.openSourceLicensesHint"), icon: "package-open") {
                    model.present(.licenses)
                }
                if let info = Self.info {
                    Text(t("about.copyright", ["year": info.copyrightYear, "holder": info.copyrightHolder]))
                        .font(Typography.sans(11)).foregroundStyle(p.dim)
                }
            }
            .overlay(alignment: .topTrailing) {
                CloseButton(label: t("about.close"), action: model.dismissSheet).offset(x: 8, y: -8)
            }
        }
    }

    private func link(_ title: String, icon: String, url: String) -> some View {
        Button {
            if let url = URL(string: url), url.scheme?.hasPrefix("http") == true { NSWorkspace.shared.open(url) }
        } label: {
            HStack(spacing: 6) {
                VectorIcon(name: icon).frame(width: 14, height: 14)
                Text(title).font(Typography.sans(13)).fontWeight(.semibold)
            }
            .foregroundStyle(p.text).padding(.horizontal, 12).frame(height: 32)
            .doodle(radius: 10, fill: p.secondary, border: p.border, lineWidth: 1.5, shadow: p.shadow, offset: 1.5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func section(_ title: String, hint: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VectorIcon(name: icon).frame(width: 18, height: 18).foregroundStyle(p.peach)
                    .frame(width: 36, height: 36).background(Circle().fill(p.pill))
                    .overlay(Circle().strokeBorder(p.border, lineWidth: 1.5))
                VStack(alignment: .leading, spacing: 1) {
                    CuteLabel(text: title, size: 15)
                    Text(hint).font(Typography.sans(12)).foregroundStyle(p.muted).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VectorIcon(name: "chevron-right").frame(width: 16, height: 16).foregroundStyle(p.muted)
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 12).fill(p.subtle))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border, lineWidth: 1.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The notices for what ships inside the app.
struct LicensesDialog: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t

    var body: some View {
        Dialog(width: 640, padding: 20, onClose: model.dismissSheet) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 16) {
                    HStack(spacing: 12) {
                        DialogIcon(name: "package-open", size: 40)
                        VStack(alignment: .leading, spacing: 2) {
                            CuteLabel(text: t("licenses.title"), size: 20)
                            Text(t("licenses.description")).font(Typography.sans(13)).foregroundStyle(p.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    Spacer(minLength: 0)
                    CloseButton(label: t("licenses.close"), action: model.dismissSheet)
                }
                LicenseBrowser()
            }
        }
    }
}
