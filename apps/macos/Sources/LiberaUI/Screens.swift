import SwiftUI
import AppKit

struct LiberaView: View {
    @ObservedObject var model: UIModel
    private var p: Palette { model.palette }
    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                Header(model: model, compact: geometry.size.width <= 1024).frame(height: 52)
                Group {
                    switch model.screen {
                    case .compress, .extract:
                        HStack(spacing: 20) {
                            DropArea(model: model, folders: model.screen == .compress)
                                .frame(width: (geometry.size.width-60)*1.2/2.2)
                            Options(model: model, width: (geometry.size.width-60)/2.2)
                        }
                    case .inspect: Inspector(model: model, short: geometry.size.height <= 700)
                    case .queue: QueueScreen(model: model)
                    }
                }.padding(20).frame(maxWidth: .infinity, maxHeight: .infinity)
            }.background(p.background).foregroundStyle(p.text)
        }.ignoresSafeArea().environment(\.colorScheme, model.dark ? .dark : .light)
            .sheet(isPresented: $model.about) { AboutView(model: model) }
    }
}
private struct Header: View {
    @ObservedObject var model: UIModel
    let compact: Bool
    private var p: Palette { model.palette }
    private let logo = NSImage(contentsOf: Bundle.module.url(forResource: "logo", withExtension: "png", subdirectory: "Resources")!)!
    var body: some View {
        ZStack {
            HStack(spacing: 8) {
                Image(nsImage: logo).resizable().scaledToFit().padding(3.5).frame(width: 30, height: 30)
                    .background(Circle().fill(p.card)).overlay(Circle().strokeBorder(p.border, lineWidth: 1.5))
                if !compact { CuteLabel(text: "Libera", size: 20, color: p.text).kerning(0.5) }
                Spacer(minLength: 0)
                HStack(spacing: 8) {
                    action("sliders-horizontal", label: model.text("titleBar.expertModeToggle"), active: model.expert) { model.expert.toggle() }
                    action(model.dark ? "moon" : "sun", label: model.text("titleBar.themeToggle")) { model.dark.toggle() }
                    action("info", label: model.text("titleBar.about")) { model.about = true }
                    HStack(spacing: 0) {
                        language("EN", korean: false)
                        language("KO", korean: true)
                    }.padding(3.5).background(RoundedRectangle(cornerRadius: 9).fill(p.card)
                        .background(RoundedRectangle(cornerRadius: 9).fill(p.shadow).offset(x: 1.5, y: 1.5)))
                        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(p.border, lineWidth: 1.5))
                }
            }.padding(.leading, 84).padding(.trailing, compact ? 24 : 28).padding(.bottom, 2)
            HStack(spacing: compact ? 2 : 4) {
                ForEach(Screen.allCases, id: \.self) { screen in
                    Button { model.screen = screen } label: {
                        HStack(spacing: 6) {
                            VectorIcon(name: screen.icon).frame(width: 14, height: 14)
                            if !compact { Text(model.text(screen.titleKey)).font(Typography.cute(14)).fontWeight(.bold) }
                        }.foregroundStyle(model.screen == screen ? Color.white : p.muted)
                            .padding(.horizontal, compact ? 9 : 15.5).frame(height: 30)
                            .background {
                                if model.screen == screen {
                                    RoundedRectangle(cornerRadius: 10).fill(p.shadow).offset(x: 1.5, y: 1.5)
                                    RoundedRectangle(cornerRadius: 10).fill(screen.accent(p))
                                }
                            }.overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(model.screen == screen ? p.border : .clear, lineWidth: 1.5))
                    }.buttonStyle(.plain).accessibilityLabel(model.text(screen.titleKey))
                }
            }.padding(.horizontal, 6).padding(.vertical, 5).background(RoundedRectangle(cornerRadius: 14).fill(p.pill))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(p.border, lineWidth: 2)).padding(.bottom, 2)
        }.overlay(alignment: .bottom) { p.border.frame(height: 2) }
    }
    private func action(_ icon: String, label: String, active: Bool = false, run: @escaping () -> Void) -> some View {
        Button(action: run) {
            VectorIcon(name: icon).frame(width: 14, height: 14).foregroundStyle(active ? p.peach : p.muted)
                .frame(width: 28, height: 28).background(RoundedRectangle(cornerRadius: 9).fill(active ? p.secondary : p.card)
                    .background(RoundedRectangle(cornerRadius: 9).fill(p.shadow).offset(x: 1.5, y: 1.5)))
                .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(active ? p.peach : p.border, lineWidth: 1.5))
        }.buttonStyle(.plain).help(label).accessibilityLabel(label)
    }
    private func language(_ title: String, korean: Bool) -> some View {
        Button { model.korean = korean } label: {
            Text(title).font(Typography.cute(11)).fontWeight(.bold).foregroundStyle(model.korean == korean ? Color.white : p.muted)
                .frame(width: 30, height: 24).background(RoundedRectangle(cornerRadius: 6).fill(model.korean == korean ? p.peach : .clear))
        }.buttonStyle(.plain).accessibilityLabel(korean ? "한국어" : "English")
    }
}
private struct DropArea: View {
    @ObservedObject var model: UIModel
    let folders: Bool
    var dashed = true
    private var p: Palette { model.palette }
    var body: some View {
        VStack(spacing: 0) {
            VectorIcon(name: "cloud-upload").frame(width: 28, height: 28).foregroundStyle(p.text)
                .frame(width: 56, height: 56).background(Circle().fill(p.pill)
                    .background(Circle().fill(p.shadow).offset(x: 2, y: 2)))
                .overlay(Circle().strokeBorder(p.border, lineWidth: 2)).padding(.bottom, 10)
            CuteLabel(text: model.text(folders ? "dropZone.dropFilesAndFolders" : "dropZone.dropArchives"), size: 20, color: p.text)
                .frame(height: 27.5).padding(.bottom, 4)
            Text(model.text(folders ? "dropZone.filesAndFoldersHint" : "dropZone.archivesHint")).font(Typography.sans(13)).foregroundStyle(p.muted)
                .frame(height: 18.5).padding(.bottom, 16)
            HStack(spacing: 10) {
                CozyButton(title: model.text("dropZone.browseFiles"), icon: "file-plus", p: p)
                if folders { CozyButton(title: model.text("dropZone.browseFolders"), icon: "folder-plus", p: p) }
            }
        }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
            .modifier(Card(p: p, radius: dashed ? 20 : 16, dashed: dashed))
    }
}
private struct Options: View {
    @ObservedObject var model: UIModel
    let width: CGFloat
    private var p: Palette { model.palette }
    private var compress: Bool { model.screen == .compress }
    private var prefix: String { compress ? "compression." : "extraction." }
    var body: some View {
        ReferenceScroll(p: p) {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 8) {
                    VectorIcon(name: compress ? "sliders" : "folder").frame(width: 18, height: 18).foregroundStyle(p.peach)
                    CuteLabel(text: model.text(prefix + "title"), size: 18, color: p.text)
                    Spacer(minLength: 4)
                    Text(model.text(compress ? "compression.totalSize" : (model.korean ? "extraction.selected" : "extraction.selected_other"), count: 0))
                        .font(Typography.mono(12)).foregroundStyle(p.muted).fixedSize()
                }.frame(height: 25)
                if compress { compressionFields }
                else { extractionFields }
            }.padding(22).frame(width: width, alignment: .leading)
        }.frame(width: width).modifier(Card(p: p)).clipShape(RoundedRectangle(cornerRadius: 16))
    }
    private func heading(_ key: String) -> some View { CuteLabel(text: model.text(key), color: p.text).frame(height: 19, alignment: .leading) }
    private var compressionFields: some View {
        Group {
            VStack(alignment: .leading, spacing: 8) {
                heading("compression.format")
                let columns = max(1, Int((width-34)/100))
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 0), spacing: 10), count: columns), spacing: 10) {
                    ForEach([".ZIP", ".TAR", ".GZ", ".TAR.GZ", ".ZST", ".TAR.ZST", ".7Z"], id: \.self) { format in
                        Button { model.format = format; model.password = ""; model.confirmation = ""; model.output = ""; model.split = false } label: {
                            Text(format).font(Typography.cute(16)).fontWeight(.bold).foregroundStyle(model.format == format ? p.peach : p.text)
                                .frame(maxWidth: .infinity).frame(height: 43.5)
                                .background(RoundedRectangle(cornerRadius: 12).fill(model.format == format ? p.pill : p.card)
                                    .background(RoundedRectangle(cornerRadius: 12).fill(model.format == format ? p.shadow : .clear).offset(x: 2, y: 2)))
                                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(model.format == format ? p.peach : p.border, lineWidth: model.format == format ? 2 : 1.5))
                        }.buttonStyle(.plain)
                    }
                }
            }
            if model.format != ".TAR" {
                VStack(spacing: 6) {
                    HStack { heading("compression.level"); Spacer(); Text(levelLabel).font(Typography.sans(12)).fontWeight(.semibold).foregroundStyle(p.peach) }.frame(height: 19)
                    LevelSlider(value: $model.level, p: p).frame(height: 22.5)
                }
            }
            if model.expert { expertFields }
            if [".ZIP", ".7Z"].contains(model.format) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 7) { heading("compression.password"); Text(model.text("compression.optional")).font(Typography.sans(12)).foregroundStyle(p.muted) }.frame(height: 20)
                    HStack(spacing: 8) {
                        CozyField(hint: model.text("compression.passwordPlaceholder"), value: $model.password, p: p, secure: true)
                        CozyField(hint: model.text("compression.confirmPasswordPlaceholder"), value: $model.confirmation, p: p, secure: true)
                    }
                }
                OptionCard(title: model.text("compression.splitEnable"), description: model.text(model.format == ".7Z" ? "compression.splitExample7z" : "compression.splitExampleZip"), checked: $model.split, p: p).frame(minHeight: 73)
                if model.split {
                    VStack(alignment: .leading, spacing: 10) {
                        heading("compression.splitSize")
                        HStack { ForEach(["100 MB", "700 MB", "1 GB"], id: \.self) { size in CozyButton(title: size, p: p, height: 32) } }
                    }.padding(14).background(RoundedRectangle(cornerRadius: 16).fill(p.subtle))
                }
            }
            destination
            CozyButton(title: model.text("compression.start"), icon: "archive", p: p, primary: true, disabled: true, height: 51.5)
        }
    }
    private var levelLabel: String {
        let level = Int(model.level)
        let key = level == 0 ? "levelStore" : level <= 3 ? "levelFastest" : level <= 5 ? "levelFast" : level == 6 ? "levelNormal" : level <= 8 ? "levelMaximum" : "levelUltra"
        return model.text("compression." + key).replacingOccurrences(of: "{{level}}", with: String(level))
    }
    private var extractionFields: some View {
        Group {
            destination
            OptionCard(title: model.text("extraction.createSubfolder"), description: model.text("extraction.example"), checked: $model.subfolder, p: p)
            CozyButton(title: model.text("extraction.start"), icon: "download", p: p, primary: true, disabled: true, height: 51.5)
            if model.expert { expertFields }
        }
    }
    private var destination: some View {
        VStack(alignment: .leading, spacing: 6) {
            heading(prefix + "destination")
            HStack(spacing: 8) {
                CozyField(hint: model.text(prefix + "destinationPlaceholder"), value: $model.output, p: p)
                CozyButton(title: model.text(prefix + "browse"), p: p, height: 44)
            }
        }
    }
    private var expertFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            CuteLabel(text: model.text(prefix + "expertTitle"), size: 16, color: p.peach)
            Divider().overlay(p.peach.opacity(0.3))
            if compress {
                heading("compression.codecMethod")
                Picker("", selection: $model.method) { ForEach(["Store (0)", "Deflate (8)", "LZMA (14)", "Zstandard (93)"], id: \.self) { Text($0) } }.labelsHidden()
            }
            Toggle(model.korean ? "숨김 파일 제외" : "Exclude hidden files", isOn: $model.excludedHidden)
            Toggle(model.korean ? "macOS 메타데이터 제외" : "Exclude macOS metadata", isOn: $model.excludedMac)
            CozyField(hint: "*.txt, !*.tmp", value: $model.pattern, p: p)
        }.font(Typography.sans(13)).padding(16).background(RoundedRectangle(cornerRadius: 16).fill(p.card))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(p.peach, style: StrokeStyle(lineWidth: 2, dash: [4, 2])))
    }
}
private struct LevelSlider: View {
    @Binding var value: Double
    let p: Palette
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(p.dark ? p.thumb : Color(hex: 0x3B3B3B)).frame(height: 7)
                Capsule().fill(p.peach).frame(width: max(0, g.size.width * value/9), height: 7)
                Circle().fill(p.peach).frame(width: 16, height: 16).offset(x: max(0, (g.size.width-16)*value/9))
            }.frame(height: g.size.height).contentShape(Rectangle()).gesture(DragGesture(minimumDistance: 0).onChanged { event in value = min(9, max(0, (Double(event.location.x/g.size.width)*9).rounded())) })
        }.accessibilityLabel("Compression level").accessibilityValue(String(Int(value)))
            .accessibilityAdjustableAction { direction in value = min(9, max(0, value + (direction == .increment ? 1 : -1))) }
    }
}
private struct ScrollContentPreference: PreferenceKey {
    static var defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}
private struct ScrollOffsetPreference: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
private struct ReferenceScroll<Content: View>: View {
    let p: Palette
    @ViewBuilder var content: Content
    @State private var contentSize: CGSize = .zero
    @State private var offset: CGFloat = 0
    var body: some View {
        GeometryReader { g in
            ScrollView(.vertical) {
                content.background(GeometryReader { item in Color.clear.preference(key: ScrollContentPreference.self, value: item.size)
                    .preference(key: ScrollOffsetPreference.self, value: item.frame(in: .named("options-scroll")).minY) })
            }.scrollIndicators(.hidden).coordinateSpace(name: "options-scroll")
                .onPreferenceChange(ScrollContentPreference.self) { contentSize = $0 }
                .onPreferenceChange(ScrollOffsetPreference.self) { offset = $0 }
                .overlay(alignment: .topTrailing) {
                    if contentSize.height > g.size.height {
                        let track = g.size.height-12
                        let height = max(24, track*g.size.height/contentSize.height)
                        Capsule().fill(p.thumb).frame(width: 6, height: height)
                            .offset(y: 6 + min(1, max(0, -offset/(contentSize.height-g.size.height)))*(track-height)).padding(.trailing, 8).allowsHitTesting(false)
                    }
                }
        }
    }
}
private struct Inspector: View {
    @ObservedObject var model: UIModel
    let short: Bool
    private var p: Palette { model.palette }
    var body: some View {
        VStack(spacing: short ? 10 : 16) {
            HStack(spacing: 12) {
                VectorIcon(name: "search").frame(width: 24, height: 24).foregroundStyle(p.peach)
                    .frame(width: 44, height: 44).background(Circle().fill(p.pill).background(Circle().fill(p.shadow).offset(x: 2, y: 2)))
                    .overlay(Circle().strokeBorder(p.border, lineWidth: 2))
                VStack(alignment: .leading, spacing: 0) {
                    CuteLabel(text: model.text("inspector.title"), size: 20, color: p.text).frame(height: 27.5)
                    Text(model.text("inspector.subtitle")).font(Typography.sans(13)).foregroundStyle(p.muted).frame(height: 18.5)
                }
                Spacer()
            }.padding(.vertical, short ? 14 : 18).padding(.horizontal, short ? 16 : 18).modifier(Card(p: p))
            DropArea(model: model, folders: false, dashed: false)
        }.padding(.trailing, 14)
    }
}
private struct QueueScreen: View {
    @ObservedObject var model: UIModel
    private var p: Palette { model.palette }
    var body: some View {
        VStack(spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 0) {
                    CuteLabel(text: model.text(model.korean ? "queue.title" : "queue.title_other", count: 0), size: 20, color: p.text).frame(height: 27.5)
                    Text(model.text("queue.subtitle")).font(Typography.sans(13)).foregroundStyle(p.muted).frame(height: 18.5)
                }
                Spacer()
                CozyButton(title: model.text("queue.clearCompleted"), p: p, disabled: true)
            }.padding(18).modifier(Card(p: p))
            CuteLabel(text: model.text("queue.empty"), size: 18, color: p.dim).frame(maxWidth: .infinity, maxHeight: .infinity)
        }.padding(.trailing, 14)
    }
}
private struct AboutView: View {
    @ObservedObject var model: UIModel
    var body: some View {
        VStack(spacing: 16) {
            CuteLabel(text: "Libera", size: 32, color: model.palette.text)
            Text(model.korean ? "SwiftUI 화면 비교용 빌드" : "SwiftUI UI comparison build").font(Typography.sans(14))
            Text("Gaegu · Gowun Dodum · JetBrains Mono\nSIL Open Font License 1.1\nLucide — ISC").font(Typography.sans(12)).multilineTextAlignment(.center)
            CozyButton(title: model.korean ? "닫기" : "Close", p: model.palette) { model.about = false }
        }.padding(32).frame(width: 420).background(model.palette.card).foregroundStyle(model.palette.text)
    }
}
