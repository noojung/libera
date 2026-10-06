import SwiftUI

enum Screen: String, CaseIterable {
    case compress, extract, inspect, queue
    var titleKey: String { "titleBar." + (self == .inspect ? "inspector" : rawValue) }
    var icon: String { switch self { case .compress: "archive";case .extract: "layers";case .inspect: "search";case .queue: "list-todo" } }
    func accent(_ p: Palette) -> Color { switch self { case .compress: p.peach;case .extract: p.blue;case .inspect: p.warning;case .queue: p.mint } }
}
@MainActor final class UIModel: ObservableObject {
    @Published var screen: Screen = .compress
    @Published var korean = false
    @Published var dark = false
    @Published var expert = false
    @Published var format = ".ZIP"
    @Published var level = 6.0
    @Published var password = ""
    @Published var confirmation = ""
    @Published var split = false
    @Published var subfolder = true
    @Published var output = ""
    @Published var about = false
    @Published var excludedHidden = false
    @Published var excludedMac = false
    @Published var pattern = ""
    @Published var method = "Deflate (8)"
    var palette: Palette { Palette(dark: dark) }
    private static let strings = try! JSONSerialization.jsonObject(with: Data(contentsOf: Bundle.module.url(forResource:"strings",withExtension:"json",subdirectory:"Resources")!)) as! [String: Any]
    func text(_ key: String, count: Int? = nil) -> String {
        var value: Any = Self.strings[korean ? "ko" : "en"]!
        for part in (["translation"] + key.split(separator:".").map(String.init)) { value=(value as? [String:Any])?[part] ?? key }
        return (value as? String ?? key).replacingOccurrences(of:"{{count}}",with:String(count ?? 0)).replacingOccurrences(of:"{{size}}",with:"0 B").replacingOccurrences(of:"{{directory}}",with:korean ? "저장폴더" : "destination")
    }
}
