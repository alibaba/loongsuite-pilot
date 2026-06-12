import Foundation

enum StatusBarLogger {
    enum Level: String {
        case info = "INFO"
        case warning = "WARNING"
        case error = "ERROR"
    }

    private static let queue = DispatchQueue(label: "com.loongsuite-pilot.status-bar.logger")

    private static let timestampFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "Asia/Shanghai") ?? .current
        return f
    }()

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Shanghai") ?? .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func info(_ message: String) {
        write(level: .info, message: message)
    }

    static func warning(_ message: String) {
        write(level: .warning, message: message)
    }

    static func error(_ message: String) {
        write(level: .error, message: message)
    }

    private static func write(level: Level, message: String) {
        queue.async {
            let now = Date()
            let timestamp = timestampFormatter.string(from: now)
            let line = "[\(timestamp)] [PILOT:\(level.rawValue)] [status-bar-app] \(message)\n"

            let logDir: String = {
                if let dataDir = ProcessInfo.processInfo.environment["LOONGSUITE_PILOT_DATA_DIR"], !dataDir.isEmpty {
                    return (dataDir as NSString).appendingPathComponent("logs/app-status-bar")
                }
                return NSString(string: "~/.loongsuite-pilot/logs/app-status-bar").expandingTildeInPath
            }()
            let logFile = "\(logDir)/status-bar-app-\(dateFormatter.string(from: now)).log"

            do {
                try FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
                if !FileManager.default.fileExists(atPath: logFile) {
                    FileManager.default.createFile(atPath: logFile, contents: nil)
                }
                let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: logFile))
                defer { handle.closeFile() }
                handle.seekToEndOfFile()
                if let data = line.data(using: .utf8) {
                    handle.write(data)
                }
            } catch {
                fputs("[PILOT:ERROR] logger write failed: \(error.localizedDescription)\n", stderr)
            }
        }
    }
}
