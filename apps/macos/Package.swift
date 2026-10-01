// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "LiberaMacUI",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "LiberaMacUI", targets: ["LiberaUI"])],
    targets: [
        // Both built from crates/ by scripts/build-core.sh.
        .binaryTarget(name: "LiberaCoreFFI", path: "Frameworks/LiberaCoreFFI.xcframework"),
        .target(name: "LiberaCore", dependencies: ["LiberaCoreFFI"]),
        .executableTarget(name: "LiberaUI", dependencies: ["LiberaCore"], resources: [.copy("Resources")]),
        .testTarget(name: "LiberaCoreTests", dependencies: ["LiberaCore"]),
    ],
    swiftLanguageModes: [.v5]
)
