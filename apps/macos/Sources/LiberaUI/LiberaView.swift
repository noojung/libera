import SwiftUI

/// The window's content: the title bar over the current screen, with the
/// app's dialogs above both.
struct LiberaView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var queue: JobQueue
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = Palette(dark: colorScheme == .dark)
        GeometryReader { geometry in
            VStack(spacing: 0) {
                Header(compact: geometry.size.width <= 1024).frame(height: 52)
                screen(width: geometry.size.width)
                    .padding(20).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .background(palette.background).foregroundStyle(palette.text)
        }
        .ignoresSafeArea()
        .overlay { dialogs }
        .environment(\.palette, palette)
        .environment(\.localizer, Localizer(language: settings.language))
    }

    @ViewBuilder private func screen(width: CGFloat) -> some View {
        // The drop zone takes 1.2 shares of the row and the panel one.
        let panelWidth = (width - 60) / 2.2
        switch model.screen {
        case .compress:
            HStack(spacing: 20) {
                DropZone(mode: .compress)
                CompressionPanel(form: model.compressionForm).frame(width: panelWidth)
            }
        case .extract:
            HStack(spacing: 20) {
                DropZone(mode: .extract)
                ExtractionPanel().frame(width: panelWidth)
            }
        case .inspect:
            InspectorScreen()
        case .queue:
            QueueScreen()
        }
    }

    /// The inspector's preview under the app's dialogs, and a job's password
    /// prompt over everything, since it interrupts whatever is open.
    private var dialogs: some View {
        ZStack {
            InspectorDialogs()
            CompressionDialogs(form: model.compressionForm, items: model.compressItems)
            if let sheet = model.sheet {
                // Each dialog is its own view, so a return to one starts it afresh.
                switch sheet {
                case .about: AboutDialog()
                case .licenses: LicensesDialog()
                case .supportedFormats: SupportedFormatsDialog()
                case .unsupportedFormat: UnsupportedFormatDialog()
                }
            }
            if let prompt = queue.passwordPrompt {
                PasswordPromptDialog(prompt: prompt).id(prompt.id)
            }
        }
    }
}

#if DEBUG
#Preview("압축") {
    PreviewHost(setUp: { $0.compressItems = PreviewSamples.compressItems }) { LiberaView() }.previewWindow()
}

#Preview("압축 해제 · 전문가") {
    PreviewHost(expert: true, setUp: { model in
        model.screen = .extract
        model.extractItems = PreviewSamples.extractItems
    }) { LiberaView() }.previewWindow()
}

#Preview("작업 대기열 · 다크") {
    PreviewHost(language: .en, dark: true, setUp: { model in
        model.screen = .queue
        model.queue.showForPreview(PreviewSamples.jobs)
    }) { LiberaView() }.previewWindow()
}
#endif
