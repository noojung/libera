import AppKit
import LiberaCore
import SwiftUI

/// The inspector's dialogs, drawn over the whole window like the others.
struct InspectorDialogs: View {
    @EnvironmentObject private var inspector: InspectorModel
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.localizer) private var t

    var body: some View {
        ZStack {
            if let preview = inspector.preview {
                PreviewDialog(state: preview, expert: settings.expert) { inspector.closePreview() }
            }
            if let prompt = inspector.prompt {
                PasswordPromptView(
                    archiveName: promptName(prompt), incorrect: prompt.incorrect, confirmLabel: t("passwordPrompt.open"),
                    onConfirm: { inspector.answerPrompt($0, rawBytes: settings.expert) },
                    onCancel: { inspector.answerPrompt(nil, rawBytes: settings.expert) }
                )
            }
        }
    }

    private func promptName(_ prompt: InspectorPrompt) -> String {
        switch prompt {
        case let .listing(path, _): (path as NSString).lastPathComponent
        case let .entry(entry, _): entry.path
        }
    }
}

/// One entry's contents as text, a hex dump, or a picture.
struct PreviewDialog: View {
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t
    let state: PreviewState
    let expert: Bool
    let onClose: () -> Void
    @State private var hex = false
    @State private var copied = false

    private var isImage: Bool {
        if case .image = state.result { return true }
        return false
    }

    var body: some View {
        Dialog(width: 820, padding: 20, onClose: onClose) {
            VStack(alignment: .leading, spacing: 14) {
                header
                if expert { metadata }
                body(content: content)
                footer
            }
            .frame(minHeight: 320, maxHeight: 620)
        }
        .onChange(of: state.result) { _ in hex = false }
    }

    private var header: some View {
        HStack(spacing: 16) {
            HStack(spacing: 12) {
                DialogIcon(name: isImage ? "image" : "file-text", color: isImage ? p.blue : p.peach, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    CuteLabel(text: t("inspector.preview.title"), size: 20)
                    Text(state.entry.path).font(Typography.mono(12)).foregroundStyle(p.muted)
                        .lineLimit(2).truncationMode(.middle).textSelection(.enabled)
                }
            }
            Spacer(minLength: 0)
            if expert, case let .text(_, _, _, _, _, rawBytes) = state.result, rawBytes != nil {
                HStack(spacing: 2) {
                    modeButton(t("inspector.preview.textView"), icon: "file-text", active: !hex) { hex = false }
                    modeButton(t("inspector.preview.hexView"), icon: "binary", active: hex) { hex = true }
                }
                .padding(3).doodle(radius: 9, fill: p.card, border: p.border, lineWidth: 1.5, shadow: nil)
            }
            CloseButton(label: t("inspector.preview.close"), action: onClose)
        }
    }

    private var metadata: some View {
        let entry = state.entry
        return HStack(spacing: 14) {
            Text("\(t("inspector.codec")): \(entry.codec ?? "-")")
            Text("\(t("inspector.encryptionMethod")): \(entry.encryptionMethod.isEmpty ? "-" : entry.encryptionMethod)")
            Text("\(t("inspector.crc32")): \(entry.crc32.map { "0x" + String(format: "%08X", $0) } ?? "-")")
            Text("\(t("inspector.originalSize")): \(entry.size.map { t.bytes($0) } ?? "-")")
            Text("\(t("inspector.compressedSize")): \(entry.compressedSize.map { t.bytes($0) } ?? "-")")
        }
        .font(Typography.mono(11)).foregroundStyle(p.muted).lineLimit(1).minimumScaleFactor(0.7)
        .padding(.horizontal, 18).padding(.vertical, 8)
        .overlay(alignment: .bottom) {
            Line().stroke(p.borderSubtle, style: StrokeStyle(lineWidth: 1, dash: [3, 2])).frame(height: 1)
        }
    }

    /// What is shown, and the text the copy button copies.
    private enum Content {
        case message(String, error: Bool)
        case text(String)
        case image(NSImage)
    }

    private var content: Content {
        if state.loading { return .message(t("inspector.preview.loading"), error: false) }
        if let code = state.errorCode {
            let key = "inspector.preview.errors.\(code)"
            return .message(t(t.has(key) ? key : "inspector.preview.errors.genericPreview"), error: true)
        }
        switch state.result {
        case let .text(text, _, _, _, _, rawBytes):
            let shown = hex ? Self.hexDump(rawBytes ?? Data(text.utf8)) : text
            return shown.isEmpty ? .message(t("inspector.preview.empty"), error: false) : .text(shown)
        case let .image(data, _, _, _, _, _):
            guard let image = NSImage(data: data), image.isValid else {
                return .message(t("inspector.preview.errors.invalidImage"), error: true)
            }
            return .image(image)
        case nil:
            return .message(t("inspector.preview.loading"), error: false)
        }
    }

    private func body(content: Content) -> some View {
        ZStack(alignment: .topTrailing) {
            switch content {
            case let .message(text, error):
                Text(text).font(Typography.sans(14)).foregroundStyle(error ? p.danger : p.muted)
                    .multilineTextAlignment(.center).padding(24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .text(text):
                PlainTextView(text: text, color: NSColor(p.text), size: hex ? 12 : 12.5).padding(.vertical, 4)
                copyButton(text)
            case let .image(image):
                Image(nsImage: image).resizable().scaledToFit().padding(18)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Checkerboard(color: p.borderSubtle))
                    .accessibilityLabel(t("inspector.preview.imageAlt", ["path": state.entry.path]))
            }
        }
        .frame(maxHeight: .infinity)
        .background(RoundedRectangle(cornerRadius: 12).fill(p.subtle))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(p.borderSubtle, lineWidth: 1))
    }

    @ViewBuilder private var footer: some View {
        switch state.result {
        case let .text(text, encoding, truncated, previewedBytes, totalBytes, _) where !state.loading:
            HStack {
                Text(hex ? t("inspector.preview.hexView") : t("inspector.preview.encoding", ["encoding": Self.label(encoding)]))
                Spacer()
                if !hex { Text(lineEndingLabel(LineEnding.detect(text))) }
                if truncated {
                    Text(totalBytes.map { t("inspector.preview.truncated", ["shown": t.bytes(previewedBytes), "total": t.bytes($0)]) }
                        ?? t("inspector.preview.truncatedUnknown", ["shown": t.bytes(previewedBytes)]))
                        .foregroundStyle(p.warning)
                } else {
                    Text(t.bytes(previewedBytes))
                }
            }
            .font(Typography.sans(12)).foregroundStyle(p.muted)
        case let .image(_, type, width, height, previewedBytes, _) where !state.loading:
            HStack {
                Text(t("inspector.preview.imageFormat", ["format": Self.label(type)]))
                Spacer()
                Text(t("inspector.preview.imageDetails", ["width": width, "height": height, "size": t.bytes(previewedBytes)]))
            }
            .font(Typography.sans(12)).foregroundStyle(p.muted)
        default:
            EmptyView()
        }
    }

    private func modeButton(_ title: String, icon: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                VectorIcon(name: icon).frame(width: 13, height: 13)
                Text(title).font(Typography.sans(12)).fontWeight(.semibold)
            }
            .foregroundStyle(active ? Color.white : p.muted).padding(.horizontal, 8).frame(height: 26)
            .background(RoundedRectangle(cornerRadius: 7).fill(active ? p.peach : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func copyButton(_ text: String) -> some View {
        let label = t(copied ? "inspector.preview.copied" : "inspector.preview.copyContent")
        return Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { copied = false }
        } label: {
            VectorIcon(name: copied ? "check" : "copy").frame(width: 15, height: 15).foregroundStyle(copied ? p.success : p.muted)
                .frame(width: 30, height: 30)
                .doodle(radius: 8, fill: p.card, border: p.borderSubtle, lineWidth: 1, shadow: nil)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).help(label).accessibilityLabel(label)
        .padding(.top, 10).padding(.trailing, 20)
    }

    private func lineEndingLabel(_ ending: LineEnding) -> String {
        switch ending {
        case .mixed: t("inspector.preview.lineEndingMixed")
        case .none: t("inspector.preview.lineEndingNone")
        default: ending.rawValue.uppercased()
        }
    }

    private static func label(_ encoding: TextEncoding) -> String {
        switch encoding {
        case .utf8: "UTF-8"
        case .utf16Le: "UTF-16LE"
        case .utf16Be: "UTF-16BE"
        }
    }

    private static func label(_ type: ImageType) -> String {
        switch type {
        case .png: "PNG"
        case .jpeg: "JPEG"
        case .webp: "WEBP"
        case .gif: "GIF"
        }
    }

    /// Offset, sixteen bytes in two groups of eight, and their ASCII, for at
    /// most the first MiB.
    static func hexDump(_ data: Data) -> String {
        let bytes = [UInt8](data.prefix(1024 * 1024))
        let digits = Array("0123456789ABCDEF".utf8)
        var output: [UInt8] = []
        output.reserveCapacity(bytes.count / 16 * 79 + 79)
        var offset = 0
        while offset < bytes.count {
            if offset > 0 { output.append(0x0A) }
            output += Array(String(format: "%08X", offset).utf8)
            output += [0x20, 0x20]
            for index in 0..<16 {
                if index == 8 { output += [0x20, 0x20] }
                if offset + index < bytes.count {
                    let byte = bytes[offset + index]
                    output += [digits[Int(byte >> 4)], digits[Int(byte & 0x0F)]]
                } else {
                    output += [0x20, 0x20]
                }
                if index != 7 && index != 15 { output.append(0x20) }
            }
            output += [0x20, 0x20, 0x7C]
            for byte in bytes[offset..<min(offset + 16, bytes.count)] {
                output.append((32...126).contains(byte) ? byte : 0x2E)
            }
            output.append(0x7C)
            offset += 16
        }
        return String(decoding: output, as: UTF8.self)
    }
}

/// Which line ending a text uses. A lone CR is one that is not part of a
/// CRLF, so an old Mac file is told apart from a Windows one.
enum LineEnding: String {
    case crlf, lf, cr, mixed, none

    static func detect(_ text: String) -> LineEnding {
        var crlf = 0, lf = 0, cr = 0
        var previousCR = false
        for byte in text.utf8 {
            if byte == 0x0A {
                if previousCR { crlf += 1; cr -= 1 } else { lf += 1 }
            }
            if byte == 0x0D { cr += 1 }
            previousCR = byte == 0x0D
        }
        switch [crlf, lf, cr].filter({ $0 > 0 }).count {
        case 0: return .none
        case 1: return crlf > 0 ? .crlf : lf > 0 ? .lf : .cr
        default: return .mixed
        }
    }
}

/// Selectable read-only text that stays quick at a megabyte.
private struct PlainTextView: NSViewRepresentable {
    let text: String
    let color: NSColor
    let size: CGFloat

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        scrollView.drawsBackground = false
        scrollView.autohidesScrollers = true
        guard let textView = scrollView.documentView as? NSTextView else { return scrollView }
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.textContainerInset = NSSize(width: 14, height: 10)
        textView.isAutomaticLinkDetectionEnabled = false
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        let font = NSFont(name: "JetBrainsMono-Regular", size: size) ?? .monospacedSystemFont(ofSize: size, weight: .regular)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineHeightMultiple = 1.15
        if textView.string != text || textView.textColor != color {
            textView.textStorage?.setAttributedString(NSAttributedString(
                string: text, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraph]
            ))
            textView.scroll(.zero)
        }
    }
}

/// The transparency grid behind a picture.
private struct Checkerboard: View {
    let color: Color

    var body: some View {
        Canvas { context, size in
            let cell: CGFloat = 8
            for row in 0..<Int(ceil(size.height / cell)) {
                for column in 0..<Int(ceil(size.width / cell)) where (row + column).isMultiple(of: 2) {
                    context.fill(Path(CGRect(x: CGFloat(column) * cell, y: CGFloat(row) * cell, width: cell, height: cell)), with: .color(color))
                }
            }
        }
    }
}

#if DEBUG
#Preview("텍스트 미리보기") {
    PreviewHost(expert: true) {
        PreviewDialog(state: PreviewSamples.textPreview, expert: true) {}
    }
    .previewWindow()
}
#endif
