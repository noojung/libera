import Foundation
import SwiftUI

/// Looks text up in the renderer's translations (Resources/strings.json, kept
/// in sync by scripts/sync-resources.mjs) the way i18next does: `{{name}}`
/// placeholders, `_one`/`_other` plurals chosen by `count`, and English for a
/// key Korean lacks.
struct Localizer {
    let language: AppLanguage

    func callAsFunction(_ key: String, _ values: [String: Any] = [:]) -> String {
        guard let template = template(key, count: values["count"].flatMap(Self.integer)) else { return key }
        return values.reduce(template) { text, value in
            text.replacingOccurrences(of: "{{\(value.key)}}", with: String(describing: value.value))
        }
    }

    func has(_ key: String) -> Bool {
        template(key, count: nil) != nil
    }

    /// Bytes in binary units, as the renderer's `formatBytes` writes them.
    func bytes<Count: BinaryInteger>(_ count: Count) -> String {
        guard count > 0 else { return "0 B" }
        let units = ["B", "KiB", "MiB", "GiB", "TiB"]
        let value = Double(count)
        let unit = min(Int(log(value) / log(1024)), units.count - 1)
        return "\(number(value / pow(1024, Double(unit)), fractionDigits: 2)) \(units[unit])"
    }

    func duration(milliseconds: UInt64?) -> String {
        let value = milliseconds ?? 0
        if value < 1000 { return "\(number(Double(value), fractionDigits: 0)) ms" }
        return "\(number(Double(value) / 1000, fractionDigits: 1)) s"
    }

    func number(_ value: Double, fractionDigits: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: language.rawValue)
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = fractionDigits
        // Intl.NumberFormat rounds half away from zero, not to even.
        formatter.roundingMode = .halfUp
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }

    private func template(_ key: String, count: Int?) -> String? {
        for language in [language, .en] {
            let table = Self.tables[language] ?? [:]
            if let count, let plural = table["\(key)_\(language.pluralCategory(count))"] { return plural }
            if let text = table[key] { return text }
        }
        return nil
    }

    private static func integer(_ value: Any) -> Int? {
        (value as? any BinaryInteger).map { Int($0) }
    }

    /// Each language's translations flattened to dotted keys.
    private static let tables: [AppLanguage: [String: String]] = {
        guard let data = AppResources.data("strings", "json"),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        func flatten(_ object: [String: Any], prefix: String, into table: inout [String: String]) {
            for (key, value) in object {
                if let nested = value as? [String: Any] {
                    flatten(nested, prefix: "\(prefix)\(key).", into: &table)
                } else if let text = value as? String {
                    table[prefix + key] = text
                }
            }
        }
        var tables: [AppLanguage: [String: String]] = [:]
        for language in AppLanguage.allCases {
            guard let translation = (root[language.rawValue] as? [String: Any])?["translation"] as? [String: Any] else { continue }
            var table: [String: String] = [:]
            flatten(translation, prefix: "", into: &table)
            tables[language] = table
        }
        return tables
    }()
}

private extension AppLanguage {
    /// The CLDR plural category i18next picks: Korean has only `other`.
    func pluralCategory(_ count: Int) -> String {
        self == .en && count == 1 ? "one" : "other"
    }
}

private struct LocalizerKey: EnvironmentKey {
    static let defaultValue = Localizer(language: .en)
}

extension EnvironmentValues {
    var localizer: Localizer {
        get { self[LocalizerKey.self] }
        set { self[LocalizerKey.self] = newValue }
    }
}
