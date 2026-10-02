import SwiftUI

/// One notice for something that ships inside the app.
struct LicenseEntry: Identifiable, Decodable {
    let name: String
    let version: String
    let license: String
    let text: String

    var id: String { name }

    /// Everything that ships inside the app, by name: the crates linked into
    /// the core (Resources/licenses.json, from scripts/generate-licenses.mjs)
    /// and the fonts and icons bundled with the UI.
    static let all: [LicenseEntry] = (crates + bundled).sorted {
        $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
    }

    private static let crates: [LicenseEntry] = Bundle.module
        .url(forResource: "licenses", withExtension: "json", subdirectory: "Resources")
        .flatMap { try? Data(contentsOf: $0) }
        .flatMap { try? JSONDecoder().decode([LicenseEntry].self, from: $0) } ?? []

    private static let bundled: [LicenseEntry] = [
        ("Gaegu", "OFL-1.1", "Resources/Fonts", "Gaegu-OFL"),
        ("Gowun Dodum", "OFL-1.1", "Resources/Fonts", "GowunDodum-OFL"),
        ("JetBrains Mono", "OFL-1.1", "Resources/Fonts", "JetBrainsMono-OFL"),
        ("Lucide", "ISC", "Resources", "Lucide-LICENSE"),
    ].compactMap { name, license, directory, file in
        guard let url = Bundle.module.url(forResource: file, withExtension: "txt", subdirectory: directory),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return LicenseEntry(name: name, version: "", license: license, text: text)
    }
}

/// The package list beside the selected package's license text.
struct LicenseBrowser: View {
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t
    var entries = LicenseEntry.all
    @State private var selected: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ScrollView {
                VStack(spacing: 6) {
                    ForEach(entries) { entry in
                        let active = entry.id == (selected ?? entries.first?.id)
                        Button { selected = entry.id } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(entry.name).font(Typography.sans(13)).fontWeight(.semibold).foregroundStyle(p.text)
                                Text([entry.version, entry.license].filter { !$0.isEmpty }.joined(separator: " · "))
                                    .font(Typography.mono(10)).foregroundStyle(p.muted)
                            }
                            .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 10).padding(.vertical, 7)
                            .background(RoundedRectangle(cornerRadius: 10).fill(active ? p.pill : .clear))
                            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(active ? p.peach : .clear, lineWidth: 1.5))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(entry.name), \(entry.version), \(entry.license)")
                    }
                }
            }
            .frame(width: 200)
            ScrollView {
                if let entry = entries.first(where: { $0.id == (selected ?? entries.first?.id) }) {
                    Text(entry.text).font(Typography.mono(11)).foregroundStyle(p.text).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                } else {
                    Text(t("licenses.selectPackage")).font(Typography.sans(13)).foregroundStyle(p.muted).padding(12)
                }
            }
            .background(RoundedRectangle(cornerRadius: 12).fill(p.subtle))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.borderSubtle, lineWidth: 1.5))
        }
        .frame(height: 420)
    }
}
