import SwiftUI

/// Browses an archive's entries without extracting it.
struct InspectorScreen: View {
    @Environment(\.palette) private var p
    @Environment(\.localizer) private var t

    var body: some View {
        VStack(spacing: 16) {
            HStack(spacing: 12) {
                DialogIcon(name: "search", size: 44)
                VStack(alignment: .leading, spacing: 0) {
                    CuteLabel(text: t("inspector.title"), size: 20)
                    Text(t("inspector.subtitle")).font(Typography.sans(13)).foregroundStyle(p.muted)
                }
                Spacer()
            }
            .padding(18).card()
            Spacer()
        }
    }
}
