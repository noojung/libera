import SwiftUI
import AppKit
import CoreText

// Values from src/renderer/src/styles/theme.css. Fonts and icons match React.
struct Palette {
    let dark: Bool
    var background: Color { Color(hex: dark ? 0x241F1B : 0xFAF7F2) }
    var card: Color { Color(hex: dark ? 0x342C27 : 0xFFFFFF) }
    var subtle: Color { Color(hex: dark ? 0x2C2521 : 0xFAF7F2) }
    var pill: Color { Color(hex: dark ? 0x40362F : 0xFFF3E4) }
    var input: Color { dark ? subtle : card }
    var secondary: Color { Color(hex: dark ? 0x40362F : 0xFFF4E8) }
    var border: Color { Color(hex: dark ? 0xEADFD5 : 0x4A403A) }
    var shadow: Color { Color(hex: dark ? 0x120F0D : 0x4A403A) }
    var peach: Color { Color(hex: dark ? 0xFF9F89 : 0xFF8E72) }
    var blue: Color { Color(hex: dark ? 0x6EABF2 : 0x5A9EED) }
    var mint: Color { Color(hex: dark ? 0x7CC878 : 0x6BBE66) }
    var warning: Color { Color(hex: dark ? 0xF6B17A : 0xF4A261) }
    var text: Color { Color(hex: dark ? 0xFFF7EF : 0x362D27) }
    var muted: Color { Color(hex: dark ? 0xCDBFB4 : 0x6E6158) }
    var dim: Color { Color(hex: dark ? 0x9E8F84 : 0xA3968C) }
    var thumb: Color { Color(hex: dark ? 0x4D423B : 0xD9CEC1) }
    var gradient: LinearGradient { LinearGradient(colors: [Color(hex: dark ? 0xFF9F89 : 0xFF9E85), Color(hex: dark ? 0xFF7D7D : 0xFF7070)], startPoint: .topLeading, endPoint: .bottomTrailing) }
}
extension Color {
    init(hex: UInt32) { self.init(.sRGB, red: Double((hex >> 16) & 255)/255, green: Double((hex >> 8) & 255)/255, blue: Double(hex & 255)/255, opacity: 1) }
}
enum Typography {
    static func cute(_ size: CGFloat) -> Font { .custom("Gaegu-Bold", fixedSize: size) }
    static func sans(_ size: CGFloat) -> Font { .custom("GowunDodum-Regular", fixedSize: size) }
    static func mono(_ size: CGFloat) -> Font { .custom("JetBrainsMono-Regular", fixedSize: size) }
    static func register() {
        let directory = Bundle.module.resourceURL!.appendingPathComponent("Resources/Fonts")
        for name in ["Gaegu-Bold.ttf", "GowunDodum-Regular.ttf", "JetBrainsMono.ttf"] {
            CTFontManagerRegisterFontsForURL(directory.appendingPathComponent(name) as CFURL, .process, nil)
        }
    }
}
struct Card: ViewModifier {
    let p: Palette
    var radius: CGFloat = 16
    var dashed = false
    func body(content: Content) -> some View {
        content.background(RoundedRectangle(cornerRadius: radius).fill(p.card)
            .background(RoundedRectangle(cornerRadius: radius).fill(p.shadow).offset(x: 3, y: 3)))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(p.border, style: StrokeStyle(lineWidth: 2, dash: dashed ? [4, 2] : [])))
    }
}
struct CuteLabel: View {
    let text: String
    var size: CGFloat = 15
    var color: Color = .primary
    var body: some View { Text(text).font(Typography.cute(size)).foregroundStyle(color).fixedSize(horizontal: false, vertical: true) }
}
struct CozyButton: View {
    let title: String
    var icon: String? = nil
    let p: Palette
    var primary = false
    var disabled = false
    var height: CGFloat = 40
    var action: () -> Void = {}
    var body: some View {
        Button(action: action) {
            HStack(spacing: primary ? 8 : 6) {
                if let icon { VectorIcon(name: icon).frame(width: primary ? 20 : 16, height: primary ? 20 : 16) }
                Text(title).font(primary ? Typography.cute(17) : Typography.sans(14)).fontWeight(primary ? .bold : .semibold)
            }.foregroundStyle(primary ? Color.white : p.text)
                .padding(.horizontal, primary ? 12 : 20).frame(maxWidth: primary ? .infinity : nil).frame(height: height)
                .background {
                    RoundedRectangle(cornerRadius: primary ? 16 : 10).fill(p.shadow).offset(x: primary ? 3 : 2, y: primary ? 3 : 2)
                    if primary { RoundedRectangle(cornerRadius: 16).fill(p.gradient) }
                    else { RoundedRectangle(cornerRadius: 10).fill(p.secondary) }
                }.overlay(RoundedRectangle(cornerRadius: primary ? 16 : 10).strokeBorder(p.border, lineWidth: 2))
        }.buttonStyle(.plain).disabled(disabled).opacity(disabled ? 0.5 : 1)
    }
}
struct CozyField: View {
    let hint: String
    @Binding var value: String
    let p: Palette
    var secure = false
    var body: some View {
        Group {
            if secure { SecureField("", text: $value, prompt: Text(hint).foregroundColor(p.dim)) }
            else { TextField("", text: $value, prompt: Text(hint).foregroundColor(p.dim)) }
        }.textFieldStyle(.plain).font(Typography.sans(14)).foregroundStyle(p.text)
            .padding(.horizontal, 16).frame(height: 44)
            .background(RoundedRectangle(cornerRadius: 10).fill(p.input)
                .background(RoundedRectangle(cornerRadius: 10).fill(p.shadow).offset(x: 2, y: 2)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(p.border, lineWidth: 2))
    }
}
struct OptionCard: View {
    let title: String
    let description: String
    @Binding var checked: Bool
    let p: Palette
    var body: some View {
        Button { checked.toggle() } label: {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 2).fill(checked ? p.peach : p.input)
                    RoundedRectangle(cornerRadius: 2).strokeBorder(p.dim, lineWidth: 1)
                    if checked { VectorIcon(name: "check").padding(2).foregroundStyle(p.border) }
                }.frame(width: 18, height: 18)
                VStack(alignment: .leading, spacing: 0) {
                    CuteLabel(text: title, color: p.text)
                    Text(description).font(Typography.sans(12)).foregroundStyle(p.muted).fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(15.5).frame(minHeight: 68)
                .background(RoundedRectangle(cornerRadius: 12).fill(p.subtle))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border, lineWidth: 1.5))
        }.buttonStyle(.plain).accessibilityValue(checked ? "On" : "Off")
    }
}
