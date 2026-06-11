import AppKit
import SwiftUI
import Combine

@MainActor
final class StatusBarController {
    private let runtimeStore = PilotRuntimeStore()
    private let metricsStore = PilotMetricsStore()
    private let statusItem: NSStatusItem
    private let panel: FloatingPanel
    private var eventMonitor: Any?
    private var cancellables = Set<AnyCancellable>()

    init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        panel = FloatingPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 760))

        StatusBarLogger.info("initializing status bar controller")
        configureStatusItem()
        configurePanel()
        bindState()
        runtimeStore.start()
        metricsStore.start()
    }

    func teardown() {
        StatusBarLogger.info("tearing down status bar controller")
        runtimeStore.stop()
        metricsStore.stop()
        if let eventMonitor {
            NSEvent.removeMonitor(eventMonitor)
        }
    }

    private func configureStatusItem() {
        guard let button = statusItem.button else {
            StatusBarLogger.error("failed to access status item button")
            return
        }

        let image = NSImage(systemSymbolName: "chart.bar.xaxis", accessibilityDescription: "LoongSuite Pilot")
        image?.isTemplate = true
        button.image = image
        button.imagePosition = .imageLeading
        button.title = metricsStore.snapshot.menuBarTitle
        button.target = self
        button.action = #selector(handleStatusItemClick(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        StatusBarLogger.info("status item configured")
    }

    private func configurePanel() {
        panel.setRootView(
            PanelContentView(
                runtimeStore: runtimeStore,
                metricsStore: metricsStore,
                closePanel: { [weak self] in
                    self?.closePanel()
                }
            )
        )
    }

    private func bindState() {
        metricsStore.$snapshot
            .sink { [weak self] snapshot in
                self?.statusItem.button?.title = snapshot.menuBarTitle
            }
            .store(in: &cancellables)

        runtimeStore.$snapshot
            .sink { [weak self] snapshot in
                guard let self else { return }
                self.statusItem.isVisible = snapshot.isStatusBarAppEnabled
                if !snapshot.isStatusBarAppEnabled {
                    self.closePanel()
                }
            }
            .store(in: &cancellables)
    }

    @objc
    private func handleStatusItemClick(_ sender: Any?) {
        guard let event = NSApp.currentEvent else {
            togglePanel()
            return
        }

        switch event.type {
        case .rightMouseUp:
            showContextMenu()
        default:
            togglePanel()
        }
    }

    private func togglePanel() {
        if panel.isVisible {
            closePanel()
        } else {
            openPanel()
        }
    }

    private func openPanel() {
        guard runtimeStore.snapshot.isStatusBarAppEnabled, let button = statusItem.button else {
            return
        }

        runtimeStore.refresh(forceReload: false)
        metricsStore.refresh()
        panel.position(relativeTo: button)
        panel.orderFrontRegardless()
        panel.makeKey()
        startEventMonitor()
        NSApp.activate(ignoringOtherApps: true)
        StatusBarLogger.info("panel opened")
    }

    func closePanel() {
        panel.orderOut(nil)
        stopEventMonitor()
    }

    private func showContextMenu() {
        let menu = NSMenu()
        let openItem = NSMenuItem(title: "打开面板", action: #selector(openPanelFromMenu), keyEquivalent: "")
        openItem.target = self
        menu.addItem(openItem)
        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    @objc
    private func openPanelFromMenu() {
        openPanel()
    }

    @objc
    private func quit() {
        StatusBarLogger.info("quit requested from menu")
        NSApp.terminate(nil)
    }

    private func startEventMonitor() {
        guard eventMonitor == nil else { return }
        eventMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor in
                self?.closePanel()
            }
        }
    }

    private func stopEventMonitor() {
        if let eventMonitor {
            NSEvent.removeMonitor(eventMonitor)
            self.eventMonitor = nil
        }
    }
}
