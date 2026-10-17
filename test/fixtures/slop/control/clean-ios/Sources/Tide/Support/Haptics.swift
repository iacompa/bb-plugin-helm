import UIKit

enum Haptics {
    static func logged() {
        // A light tap rather than .success: logging water is routine, and the
        // stronger pattern felt like a celebration in user testing.
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}
