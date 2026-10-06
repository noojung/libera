// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "LiberaMacUI",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "LiberaMacUI", targets: ["LiberaUI"])],
    targets: [.executableTarget(name: "LiberaUI", resources: [.copy("Resources")])],
    swiftLanguageModes: [.v5]
)
