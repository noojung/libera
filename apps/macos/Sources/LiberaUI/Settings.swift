import AppKit

/// The title bar's theme button, cycling system → light → dark like the
/// Electron app's.
enum ThemePreference: String, CaseIterable {
    case system, light, dark

    var next: ThemePreference {
        switch self {
        case .system: .light
        case .light: .dark
        case .dark: .system
        }
    }

    /// What the app draws with. `nil` follows the system.
    var appearance: NSAppearance? {
        switch self {
        case .system: nil
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        }
    }
}

enum AppLanguage: String, CaseIterable {
    case en, ko

    /// A stored choice wins; otherwise Korean for a Korean system, English for
    /// anything else - the rule the renderer's `resolveInitialLanguage` follows.
    static func initial(stored: String?, preferred: [String]) -> AppLanguage {
        if let stored, let language = AppLanguage(rawValue: stored) { return language }
        return preferred.contains { $0.lowercased().hasPrefix("ko") } ? .ko : .en
    }
}

/// The three choices the title bar remembers between launches.
@MainActor final class AppSettings: ObservableObject {
    private enum Key {
        static let theme = "libera.theme"
        static let language = "libera.language"
        static let expert = "libera.expertMode"
    }

    /// `nil` keeps every change in memory, for snapshots that set their own.
    private let defaults: UserDefaults?

    @Published var theme: ThemePreference {
        didSet { defaults?.set(theme.rawValue, forKey: Key.theme) }
    }
    @Published var language: AppLanguage {
        didSet { defaults?.set(language.rawValue, forKey: Key.language) }
    }
    @Published var expert: Bool {
        didSet { defaults?.set(expert, forKey: Key.expert) }
    }

    init(defaults: UserDefaults?, preferredLanguages: [String] = Locale.preferredLanguages) {
        self.defaults = defaults
        theme = defaults?.string(forKey: Key.theme).flatMap(ThemePreference.init) ?? .system
        language = AppLanguage.initial(stored: defaults?.string(forKey: Key.language), preferred: preferredLanguages)
        expert = defaults?.bool(forKey: Key.expert) ?? false
    }
}
