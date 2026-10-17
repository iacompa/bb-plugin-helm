// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Reader",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "Reader", targets: ["Reader"]),
    ],
    targets: [
        .target(name: "Reader"),
        .testTarget(name: "ReaderTests", dependencies: ["Reader"]),
    ]
)
