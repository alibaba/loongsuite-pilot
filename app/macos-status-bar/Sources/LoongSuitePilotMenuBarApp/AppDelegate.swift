import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusBarController: StatusBarController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        StatusBarLogger.info("application did finish launching")
        NSApp.setActivationPolicy(.accessory)
        statusBarController = StatusBarController()
        StatusBarLogger.info("status bar controller initialized")
    }

    func applicationWillTerminate(_ notification: Notification) {
        StatusBarLogger.info("application will terminate")
        statusBarController?.teardown()
    }
}
