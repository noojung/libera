import AppKit
import CoreText
import SwiftUI

// Values from src/renderer/src/styles/theme.css. Fonts and icons match React.
struct Palette {
    let dark: Bool

    var background: Color { Color(hex: dark ? 0x241F1B : 0xFAF7F2) }
    var card: Color { Color(hex: dark ? 0x342C27 : 0xFFFFFF) }
    var cardHover: Color { Color(hex: dark ? 0x3E342E : 0xFFF9F3) }
    var subtle: Color { Color(hex: dark ? 0x2C2521 : 0xFAF7F2) }
    var pill: Color { Color(hex: dark ? 0x40362F : 0xFFF3E4) }
    var input: Color { dark ? subtle : card }
    var secondary: Color { Color(hex: dark ? 0x40362F : 0xFFF4E8) }
    var secondaryHover: Color { Color(hex: dark ? 0x4D423B : 0xFFEBD6) }
    var borderSubtle: Color { Color(hex: dark ? 0x4D423B : 0xE8DFD5) }
    var border: Color { Color(hex: dark ? 0xEADFD5 : 0x4A403A) }
    var shadow: Color { Color(hex: dark ? 0x120F0D : 0x4A403A) }
    var peach: Color { Color(hex: dark ? 0xFF9F89 : 0xFF8E72) }
    var warm: Color { Color(hex: dark ? 0xFF7D7D : 0xFF6B6B) }
    var blue: Color { Color(hex: dark ? 0x6EABF2 : 0x5A9EED) }
    var mint: Color { Color(hex: dark ? 0x7CC878 : 0x6BBE66) }
    var success: Color { Color(hex: dark ? 0x62C496 : 0x52B788) }
    var successSoft: Color { Color(hex: dark ? 0x27423A : 0xE3F4EB) }
    var warning: Color { Color(hex: dark ? 0xF6B17A : 0xF4A261) }
    var danger: Color { Color(hex: dark ? 0xED8167 : 0xE76F51) }
    var text: Color { Color(hex: dark ? 0xFFF7EF : 0x362D27) }
    var muted: Color { Color(hex: dark ? 0xCDBFB4 : 0x6E6158) }
    var dim: Color { Color(hex: dark ? 0x9E8F84 : 0xA3968C) }
    var thumb: Color { Color(hex: dark ? 0x4D423B : 0xD9CEC1) }
    var backdrop: Color { dark ? Color.black.opacity(0.65) : Color(hex: 0x362D27).opacity(0.45) }
    var gradient: LinearGradient {
        LinearGradient(
            colors: [Color(hex: dark ? 0xFF9F89 : 0xFF9E85), Color(hex: dark ? 0xFF7D7D : 0xFF7070)],
            startPoint: .topLeading, endPoint: .bottomTrailing
        )
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB, red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255,
            blue: Double(hex & 255) / 255, opacity: 1
        )
    }
}

private struct PaletteKey: EnvironmentKey {
    static let defaultValue = Palette(dark: false)
}

extension EnvironmentValues {
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}

enum Typography {
    static func cute(_ size: CGFloat) -> Font { .custom("Gaegu-Bold", fixedSize: size) }
    static func sans(_ size: CGFloat) -> Font { .custom("GowunDodum-Regular", fixedSize: size) }
    static func mono(_ size: CGFloat) -> Font { .custom("JetBrainsMono-Regular", fixedSize: size) }

    static func register() {
        for name in ["Gaegu-Bold", "GowunDodum-Regular", "JetBrainsMono"] {
            guard let url = Bundle.module.url(forResource: name, withExtension: "ttf", subdirectory: "Resources/Fonts") else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }
}

/// The doodle card: a 2px outline with a hard shadow, `.glass-panel`.
struct Card: ViewModifier {
    @Environment(\.palette) private var p
    var radius: CGFloat = 16
    var dashed = false
    var fill: Color?
    var shadow = true

    func body(content: Content) -> some View {
        content
            .background {
                if shadow { RoundedRectangle(cornerRadius: radius).fill(p.shadow).offset(x: 3, y: 3) }
                RoundedRectangle(cornerRadius: radius).fill(fill ?? p.card)
            }
            .overlay(
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(p.border, style: StrokeStyle(lineWidth: 2, dash: dashed ? [4, 2] : []))
            )
    }
}

extension View {
    func card(radius: CGFloat = 16, dashed: Bool = false, fill: Color? = nil, shadow: Bool = true) -> some View {
        modifier(Card(radius: radius, dashed: dashed, fill: fill, shadow: shadow))
    }

    /// A filled shape with an outline and an offset hard shadow.
    func doodle(
        radius: CGFloat, fill: Color, border: Color, lineWidth: CGFloat = 2, shadow: Color?, offset: CGFloat = 2
    ) -> some View {
        background {
            if let shadow { RoundedRectangle(cornerRadius: radius).fill(shadow).offset(x: offset, y: offset) }
            RoundedRectangle(cornerRadius: radius).fill(fill)
        }
        .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(border, lineWidth: lineWidth))
    }
}

struct CuteLabel: View {
    @Environment(\.palette) private var p
    let text: String
    var size: CGFloat = 15
    var color: Color?

    var body: some View {
        Text(text).font(Typography.cute(size)).foregroundStyle(color ?? p.text)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// `.btn-primary` and `.btn-secondary`.
struct CozyButton: View {
    @Environment(\.palette) private var p
    @Environment(\.isEnabled) private var enabled
    let title: String
    var icon: String?
    var primary = false
    var height: CGFloat = 40
    var action: () -> Void = {}
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: primary ? 8 : 6) {
                if let icon { VectorIcon(name: icon).frame(width: primary ? 20 : 16, height: primary ? 20 : 16) }
                if !title.isEmpty {
                    Text(title).font(primary ? Typography.cute(17) : Typography.sans(14))
                        .fontWeight(primary ? .bold : .semibold).lineLimit(1)
                }
            }
            .foregroundStyle(primary ? Color.white : p.text)
            .padding(.horizontal, primary ? 22 : (title.isEmpty ? 10 : 18))
            .frame(maxWidth: primary ? .infinity : nil).frame(height: height)
            .background {
                RoundedRectangle(cornerRadius: primary ? 16 : 10).fill(p.shadow).offset(x: primary ? 3 : 2, y: primary ? 3 : 2)
                if primary {
                    RoundedRectangle(cornerRadius: 16).fill(p.gradient)
                } else {
                    RoundedRectangle(cornerRadius: 10).fill(hovering && enabled ? p.secondaryHover : p.secondary)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: primary ? 16 : 10).strokeBorder(p.border, lineWidth: 2))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).opacity(enabled ? 1 : 0.5).onHover { hovering = $0 }
    }
}

/// `.input-text`, plain or secure.
struct CozyField: View {
    @Environment(\.palette) private var p
    let hint: String
    @Binding var value: String
    var secure = false
    var height: CGFloat = 44
    var fontSize: CGFloat = 14
    @FocusState private var focused: Bool

    var body: some View {
        Group {
            if secure {
                SecureField("", text: $value, prompt: Text(hint).foregroundColor(p.dim))
            } else {
                TextField("", text: $value, prompt: Text(hint).foregroundColor(p.dim))
            }
        }
        .focused($focused)
        .textFieldStyle(.plain).font(Typography.sans(fontSize)).foregroundStyle(p.text)
        .padding(.horizontal, 14).frame(height: height)
        .doodle(radius: 10, fill: p.input, border: focused ? p.peach : p.border, shadow: p.shadow, offset: focused ? 3 : 2)
    }
}

/// The peach checkbox the panels use in place of the system one.
struct CozyCheckbox: View {
    @Environment(\.palette) private var p
    let checked: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 3).fill(checked ? p.peach : p.input)
            RoundedRectangle(cornerRadius: 3).strokeBorder(checked ? p.peach : p.dim, lineWidth: 1)
            if checked { VectorIcon(name: "check", lineWidth: 3).padding(3).foregroundStyle(Color.white) }
        }
        .frame(width: 18, height: 18)
    }
}

/// A checkbox with its label, `.compression-panel__checkbox-row`.
struct CheckboxRow: View {
    @Environment(\.palette) private var p
    let title: String
    var hint: String?
    @Binding var checked: Bool

    var body: some View {
        Button { checked.toggle() } label: {
            HStack(spacing: 8) {
                CozyCheckbox(checked: checked)
                Text(title).font(Typography.sans(13)).foregroundStyle(p.text)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).help(hint ?? "").accessibilityValue(checked ? "On" : "Off")
    }
}

/// A checkbox card with a title and a description under it.
struct OptionCard: View {
    @Environment(\.palette) private var p
    let title: String
    let description: String
    @Binding var checked: Bool

    var body: some View {
        Button { checked.toggle() } label: {
            HStack(spacing: 10) {
                CozyCheckbox(checked: checked)
                VStack(alignment: .leading, spacing: 0) {
                    CuteLabel(text: title)
                    Text(description).font(Typography.sans(12)).foregroundStyle(p.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 12).fill(p.subtle))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.border, lineWidth: 1.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityValue(checked ? "On" : "Off")
    }
}

/// The custom dropdown, `Select.tsx`: an outlined trigger opening a native
/// menu under it.
struct CozySelect<Value: Hashable>: View {
    @Environment(\.palette) private var p
    @Environment(\.isEnabled) private var enabled
    let label: String
    @Binding var value: Value
    let options: [(value: Value, label: String)]
    /// The per-file dialog owns the setting, so the trigger shows no value.
    var cleared = false
    /// Options shown but not offered, such as a folder's "mixed".
    var disabled: Set<Value> = []
    @State private var frame = CGRect.zero

    var body: some View {
        Button {
            PopUpMenu.show(
                options.map(\.label), selected: cleared ? nil : options.firstIndex { $0.value == value }, below: frame,
                disabled: Set(options.indices.filter { disabled.contains(options[$0].value) })
            ) { index in value = options[index].value }
        } label: {
            HStack(spacing: 8) {
                Text(cleared ? CompressionForm.clearedValue : options.first { $0.value == value }?.label ?? "")
                    .font(Typography.sans(13)).foregroundStyle(cleared ? p.muted : p.text).lineLimit(1)
                Spacer(minLength: 0)
                VectorIcon(name: "chevron-down").frame(width: 14, height: 14).foregroundStyle(p.muted)
            }
            .padding(.leading, 12).padding(.trailing, 10).frame(height: 36)
            .doodle(radius: 10, fill: p.input, border: p.border, shadow: p.shadow)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).opacity(enabled ? 1 : 0.5)
        .readFrame(into: $frame)
        .accessibilityLabel(label)
        .accessibilityValue(cleared ? CompressionForm.clearedValue : options.first { $0.value == value }?.label ?? "")
    }
}

/// A native menu shown under a SwiftUI control.
@MainActor enum PopUpMenu {
    /// `frame` is in SwiftUI's global space, whose origin is the window
    /// content's top left.
    static func show(
        _ titles: [String], selected: Int?, below frame: CGRect, disabled: Set<Int> = [], choose: @escaping (Int) -> Void
    ) {
        guard let content = NSApp.keyWindow?.contentView else { return }
        let target = Target(choose)
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.font = NSFont(name: "GowunDodum-Regular", size: 13)
        menu.minimumWidth = frame.width
        for (index, title) in titles.enumerated() {
            let item = NSMenuItem(title: title, action: #selector(Target.choose(_:)), keyEquivalent: "")
            item.target = target
            item.tag = index
            item.state = index == selected ? .on : .off
            item.isEnabled = !disabled.contains(index)
            menu.addItem(item)
        }
        let y = content.isFlipped ? frame.maxY + 4 : content.bounds.height - frame.maxY - 4
        // Runs until the menu closes, so the target outlives every choice.
        menu.popUp(positioning: nil, at: NSPoint(x: frame.minX, y: y), in: content)
        withExtendedLifetime(target) {}
    }

    private final class Target: NSObject {
        let action: (Int) -> Void

        init(_ action: @escaping (Int) -> Void) {
            self.action = action
        }

        @objc func choose(_ item: NSMenuItem) {
            action(item.tag)
        }
    }
}

private struct FramePreference: PreferenceKey {
    static let defaultValue = CGRect.zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}

extension View {
    /// Keeps `frame` at this view's frame in the global space.
    func readFrame(into frame: Binding<CGRect>) -> some View {
        background(GeometryReader { geometry in
            Color.clear.preference(key: FramePreference.self, value: geometry.frame(in: .global))
        })
        .onPreferenceChange(FramePreference.self) { frame.wrappedValue = $0 }
    }
}

/// The peach range input. `cleared` drops the thumb and the fill, for a
/// setting the per-file dialog has taken over.
struct CozySlider: View {
    @Environment(\.palette) private var p
    @Environment(\.isEnabled) private var enabled
    let label: String
    @Binding var value: Int
    let range: ClosedRange<Int>
    var cleared = false

    private var fraction: CGFloat {
        guard range.count > 1 else { return 0 }
        return CGFloat(value - range.lowerBound) / CGFloat(range.upperBound - range.lowerBound)
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(cleared ? p.borderSubtle : p.thumb).frame(height: cleared ? 4 : 6)
                if !cleared {
                    Capsule().fill(p.peach).frame(width: max(8, geometry.size.width * fraction), height: 6)
                    Circle().fill(p.peach).frame(width: 16, height: 16)
                        .overlay(Circle().strokeBorder(Color.white.opacity(0.9), lineWidth: 2))
                        .offset(x: (geometry.size.width - 16) * fraction)
                }
            }
            .frame(height: geometry.size.height).contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { event in
                guard enabled, !cleared, geometry.size.width > 0 else { return }
                let position = min(1, max(0, event.location.x / geometry.size.width))
                value = range.lowerBound + Int((position * CGFloat(range.upperBound - range.lowerBound)).rounded())
            })
        }
        .frame(height: 20).opacity(enabled || cleared ? 1 : 0.5)
        .accessibilityElement().accessibilityLabel(label)
        .accessibilityValue(cleared ? CompressionForm.clearedValue : String(value))
        .accessibilityAdjustableAction { direction in
            guard enabled, !cleared else { return }
            value = min(range.upperBound, max(range.lowerBound, value + (direction == .increment ? 1 : -1)))
        }
    }
}

/// The on/off switch beside a per-file dialog's button.
struct CozySwitch: View {
    @Environment(\.palette) private var p
    let label: String
    @Binding var on: Bool

    var body: some View {
        Button { on.toggle() } label: {
            ZStack(alignment: on ? .trailing : .leading) {
                Capsule().fill(on ? p.peach : p.subtle)
                    .overlay(Capsule().strokeBorder(on ? p.peach : p.border, lineWidth: 1.5))
                Circle().fill(on ? p.card : p.muted).frame(width: 13, height: 13).padding(.horizontal, 3.5)
            }
            .frame(width: 34, height: 20).animation(.easeOut(duration: 0.14), value: on)
        }
        .buttonStyle(.plain).accessibilityLabel(label).accessibilityValue(on ? "On" : "Off")
    }
}

/// `.expert-card`: the dashed peach frame around expert-only controls.
struct ExpertCard<Content: View>: View {
    @Environment(\.palette) private var p
    let title: String
    let icon: String
    var compact = false
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                VectorIcon(name: icon).frame(width: 16, height: 16)
                Text(title).font(Typography.cute(compact ? 14 : 16))
            }
            .foregroundStyle(p.warm).padding(.bottom, compact ? 6 : 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) {
                Line().stroke(p.borderSubtle, style: StrokeStyle(lineWidth: 1, dash: [3, 2])).frame(height: 1)
            }
            .padding(.bottom, compact ? 10 : 12)
            content
        }
        .padding(compact ? 12 : 16)
        .background(RoundedRectangle(cornerRadius: 16).fill(p.card))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(p.peach, style: StrokeStyle(lineWidth: 2, dash: [5, 3])))
    }
}

struct Line: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        }
    }
}
