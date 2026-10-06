// swift-tools-version: 6.0
import PackageDescription

// The interface is nowhere near hot enough for -O's inlining to show, while
// its size is most of the app's own code.
let optimizeForSize: [SwiftSetting] = [.unsafeFlags(["-Osize"], .when(configuration: .release))]

let package = Package(
    name: "LiberaMacUI",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "LiberaMacUI", targets: ["LiberaUI"])],
    targets: [
        // Both built from crates/ by scripts/build-core.sh.
        .binaryTarget(name: "LiberaCoreFFI", path: "Frameworks/LiberaCoreFFI.xcframework"),
        .target(name: "LiberaCore", dependencies: ["LiberaCoreFFI"], swiftSettings: optimizeForSize),
        .executableTarget(
            name: "LiberaUI", dependencies: ["LiberaCore"], resources: [.copy("Resources")], swiftSettings: optimizeForSize
        ),
        .testTarget(name: "LiberaCoreTests", dependencies: ["LiberaCore"]),
        .testTarget(name: "LiberaUITests", dependencies: ["LiberaUI", "LiberaCore"]),
    ],
    swiftLanguageModes: [.v5]
)
