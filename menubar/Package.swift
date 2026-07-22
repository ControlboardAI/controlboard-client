// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CBMenubar",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "CBMenubar",
            path: "Sources/CBMenubar"
        )
    ]
)
