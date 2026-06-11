import SwiftUI
import AppKit

final class FloatingPanel: NSPanel {
    private let visualEffectView: NSVisualEffectView

    init(contentRect: NSRect) {
        visualEffectView = NSVisualEffectView(frame: contentRect)
        super.init(
            contentRect: contentRect,
            styleMask: [.titled, .closable, .resizable, .nonactivatingPanel, .fullSizeContentView, .utilityWindow],
            backing: .buffered,
            defer: false
        )

        titlebarAppearsTransparent = true
        titleVisibility = .hidden
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovableByWindowBackground = false
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        isFloatingPanel = true
        animationBehavior = .utilityWindow
        minSize = NSSize(width: 420, height: 520)

        standardWindowButton(.closeButton)?.isHidden = true
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true

        visualEffectView.material = .sidebar
        visualEffectView.state = .active
        visualEffectView.blendingMode = .behindWindow
        visualEffectView.wantsLayer = true
        visualEffectView.layer?.cornerRadius = 18
        visualEffectView.layer?.masksToBounds = true
        contentView = visualEffectView
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    func setRootView<Content: View>(_ rootView: Content) {
        let hostingView = NSHostingView(rootView: rootView)
        hostingView.translatesAutoresizingMaskIntoConstraints = false

        visualEffectView.subviews.forEach { $0.removeFromSuperview() }
        visualEffectView.addSubview(hostingView)

        NSLayoutConstraint.activate([
            hostingView.leadingAnchor.constraint(equalTo: visualEffectView.leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: visualEffectView.trailingAnchor),
            hostingView.topAnchor.constraint(equalTo: visualEffectView.topAnchor),
            hostingView.bottomAnchor.constraint(equalTo: visualEffectView.bottomAnchor),
        ])
    }

    func position(relativeTo statusButton: NSStatusBarButton) {
        guard
            let buttonWindow = statusButton.window,
            let screen = buttonWindow.screen ?? NSScreen.main
        else {
            return
        }

        let buttonFrameOnScreen = buttonWindow.convertToScreen(statusButton.convert(statusButton.bounds, to: nil))
        let screenFrame = screen.visibleFrame
        let margin: CGFloat = 10
        let spacing: CGFloat = 8

        var originX = buttonFrameOnScreen.midX - (frame.width / 2)
        originX = max(screenFrame.minX + margin, min(originX, screenFrame.maxX - frame.width - margin))

        var originY = buttonFrameOnScreen.minY - frame.height - spacing
        if originY < screenFrame.minY + margin {
            originY = buttonFrameOnScreen.maxY + spacing
        }
        if originY + frame.height > screenFrame.maxY - margin {
            originY = screenFrame.maxY - frame.height - margin
        }

        setFrameOrigin(NSPoint(x: originX, y: originY))
    }
}
