// swift-tools-version: 5.7

import PackageDescription

let package = Package(
    name: "LoongSuitePilotMenuBarApp",
    platforms: [
        .macOS(.v13),
    ],
    products: [
        .executable(
            name: "LoongSuitePilotMenuBarApp",
            targets: ["LoongSuitePilotMenuBarApp"]
        ),
    ],
    targets: [
        .executableTarget(
            name: "LoongSuitePilotMenuBarApp"
        ),
        .testTarget(
            name: "LoongSuitePilotMenuBarAppTests",
            dependencies: ["LoongSuitePilotMenuBarApp"]
        ),
    ]
)
