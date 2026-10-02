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
                CompressionPanel().frame(width: panelWidth)
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

    @ViewBuilder private var dialogs: some View {
        if let prompt = queue.passwordPrompt {
            PasswordPromptDialog(prompt: prompt).id(prompt.id)
        } else if let sheet = model.sheet {
            // Each dialog is its own view, so a return to one starts it afresh.
            switch sheet {
            case .about: AboutDialog()
            case .licenses: LicensesDialog()
            case .supportedFormats: SupportedFormatsDialog()
            case .unsupportedFormat: UnsupportedFormatDialog()
            }
        }
    }
}
