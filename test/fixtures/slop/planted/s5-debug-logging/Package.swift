// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Courier",
    platforms: [.iOS(.v17)],
    dependencies: [
        .package(url: "https://github.com/kishikawakatsumi/KeychainAccess.git", from: "4.2.2"),
    ],
    targets: [
        .target(
            name: "Courier",
            dependencies: [.product(name: "KeychainAccess", package: "KeychainAccess")]
        ),
    ]
)
