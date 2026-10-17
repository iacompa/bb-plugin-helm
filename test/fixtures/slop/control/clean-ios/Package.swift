// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Tide",
    defaultLocalization: "en",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "Tide", targets: ["Tide"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-collections.git", from: "1.1.0"),
    ],
    targets: [
        .target(
            name: "Tide",
            dependencies: [.product(name: "OrderedCollections", package: "swift-collections")],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "TideTests", dependencies: ["Tide"]),
    ]
)
