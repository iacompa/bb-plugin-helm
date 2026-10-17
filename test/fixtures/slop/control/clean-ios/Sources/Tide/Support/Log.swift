import Foundation
import OSLog

/// The single choke point for diagnostics. Release builds go to the unified
/// log with private interpolation; debug builds also echo to the console so
/// the simulator shows them next to SwiftUI warnings.
enum Log {
    private static let logger = Logger(subsystem: "com.example.tide", category: "app")

    static func info(_ message: String) {
        logger.info("\(message, privacy: .private)")
        #if DEBUG
        print("[info] \(message)")
        #endif
    }

    static func error(_ message: String) {
        logger.error("\(message, privacy: .private)")
        #if DEBUG
        print("[error] \(message)")
        #endif
    }
}
