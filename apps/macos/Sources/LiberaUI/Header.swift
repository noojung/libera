import AppKit
import SwiftUI

/// The title bar: logo, the four screens as tabs, and the expert, theme,
/// about and language controls.
struct Header: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var queue: JobQueue
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t
    let compact: Bool

    private static let logo = AppResources.url("logo", "png").flatMap(NSImage.init(contentsOf:))

    var body: some View {
        ZStack {
            HStack(spacing: 8) {
                if let logo = Self.logo {
                    Image(nsImage: logo).resizable().scaledToFit().padding(3.5).frame(width: 30, height: 30)
                        .background(Circle().fill(p.card)).overlay(Circle().strokeBorder(p.border, lineWidth: 1.5))
                }
                if !compact { CuteLabel(text: "Libera", size: 20).kerning(0.5) }
                Spacer(minLength: 0)
                HStack(spacing: 8) {
                    action(
                        "sliders-horizontal", label: t("titleBar.expertModeToggle"),
                        help: t(settings.expert ? "titleBar.expertModeOn" : "titleBar.expertModeOff"),
                        active: settings.expert
                    ) { settings.expert.toggle() }
                    .overlay(alignment: .topTrailing) {
                        if settings.expert {
                            Circle().fill(p.warm).frame(width: 6, height: 6)
                                .overlay(Circle().strokeBorder(p.card, lineWidth: 1)).padding(3)
                        }
                    }
                    action(themeIcon, label: t("titleBar.themeToggle"), help: t(themeHelpKey)) {
                        settings.theme = settings.theme.next
                    }
                    action("info", label: t("titleBar.about"), help: t("titleBar.about")) { model.present(.about) }
                    languageSwitch
                }
            }
            .padding(.leading, 84).padding(.trailing, compact ? 24 : 28).padding(.bottom, 2)
            tabs
        }
        .overlay(alignment: .bottom) { p.border.frame(height: 2) }
    }

    private var themeIcon: String {
        switch settings.theme {
        case .system: "contrast"
        case .light: "sun"
        case .dark: "moon"
        }
    }

    private var themeHelpKey: String {
        switch settings.theme {
        case .system: "titleBar.themeSystem"
        case .light: "titleBar.themeLight"
        case .dark: "titleBar.themeDark"
        }
    }

    private var tabs: some View {
        HStack(spacing: compact ? 2 : 4) {
            ForEach(Screen.allCases, id: \.self) { screen in
                tab(screen)
            }
        }
        .padding(.horizontal, 6).padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 14).fill(p.pill))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(p.border, lineWidth: 2))
        .padding(.bottom, 2)
    }

    private func tab(_ screen: Screen) -> some View {
        let active = model.screen == screen
        let count = screen == .queue ? queue.activeCount : 0
        return Button { model.screen = screen } label: {
            HStack(spacing: 6) {
                VectorIcon(name: screen.icon).frame(width: 14, height: 14)
                if !compact { Text(t(screen.titleKey)).font(Typography.cute(14)).fontWeight(.bold) }
                if count > 0 && !compact { badge(count, size: 18, font: 11) }
            }
            .foregroundStyle(active ? Color.white : p.muted)
            .padding(.horizontal, compact ? 9 : 15.5).frame(height: 30)
            .background {
                if active {
                    RoundedRectangle(cornerRadius: 10).fill(p.shadow).offset(x: 1.5, y: 1.5)
                    RoundedRectangle(cornerRadius: 10).fill(accent(screen))
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(active ? p.border : .clear, lineWidth: 1.5))
            .overlay(alignment: .topTrailing) {
                if count > 0 && compact { badge(count, size: 15, font: 9).offset(x: 3, y: -3) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel(t(screen.titleKey))
        .accessibilityValue(count > 0 ? t("titleBar.activeJobs", ["count": count]) : "")
    }

    private func accent(_ screen: Screen) -> Color {
        switch screen {
        case .compress: p.peach
        case .extract: p.blue
        case .inspect: p.warning
        case .queue: p.mint
        }
    }

    private func badge(_ count: Int, size: CGFloat, font: CGFloat) -> some View {
        Text(String(count)).font(Typography.cute(font)).fontWeight(.heavy).foregroundStyle(Color.white)
            .frame(width: size, height: size)
            .background(Circle().fill(p.danger)).overlay(Circle().strokeBorder(p.border, lineWidth: 1))
    }

    private func action(
        _ icon: String, label: String, help: String, active: Bool = false, run: @escaping () -> Void
    ) -> some View {
        Button(action: run) {
            VectorIcon(name: icon).frame(width: 14, height: 14).foregroundStyle(active ? p.peach : p.muted)
                .frame(width: 28, height: 28)
                .doodle(radius: 9, fill: active ? p.secondary : p.card, border: active ? p.peach : p.border,
                        lineWidth: 1.5, shadow: p.shadow, offset: 1.5)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).help(help).accessibilityLabel(label)
    }

    private var languageSwitch: some View {
        HStack(spacing: 0) {
            ForEach(AppLanguage.allCases, id: \.self) { language in
                let active = settings.language == language
                Button { settings.language = language } label: {
                    Text(language.rawValue.uppercased()).font(Typography.cute(11)).fontWeight(.bold)
                        .foregroundStyle(active ? Color.white : p.muted)
                        .frame(width: 30, height: 24)
                        .background(RoundedRectangle(cornerRadius: 6).fill(active ? p.peach : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).help(t(language == .ko ? "language.korean" : "language.english"))
            }
        }
        .padding(3.5)
        .doodle(radius: 9, fill: p.card, border: p.border, lineWidth: 1.5, shadow: p.shadow, offset: 1.5)
        .accessibilityElement(children: .contain).accessibilityLabel(t("language.selector"))
    }
}
