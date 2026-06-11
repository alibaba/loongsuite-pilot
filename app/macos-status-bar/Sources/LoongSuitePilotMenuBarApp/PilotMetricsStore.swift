import Foundation
import SwiftUI

// MARK: - Aggregation Range

enum MetricsAggregationRange: String, CaseIterable, Identifiable {
    case today
    case sevenDays
    case thirtyDays

    var id: String { rawValue }

    var pickerTitle: String {
        switch self {
        case .today: return "今日"
        case .sevenDays: return "7天"
        case .thirtyDays: return "30天"
        }
    }

    var displayTitle: String {
        switch self {
        case .today: return "今日"
        case .sevenDays: return "近 7 日"
        case .thirtyDays: return "近 30 日"
        }
    }

    var heroLabel: String {
        switch self {
        case .today: return "TODAY"
        case .sevenDays: return "7 DAYS"
        case .thirtyDays: return "30 DAYS"
        }
    }

    var tokenTrendTitle: String {
        switch self {
        case .today, .sevenDays: return "TOKEN TREND · 7D"
        case .thirtyDays: return "TOKEN TREND · 30D"
        }
    }

    var sessionTrendTitle: String {
        switch self {
        case .today, .sevenDays: return "SESSION TREND · 7D"
        case .thirtyDays: return "SESSION TREND · 30D"
        }
    }

    var trendRange: MetricsAggregationRange {
        self == .thirtyDays ? .thirtyDays : .sevenDays
    }
}

// MARK: - Data Types

struct DailyMetricPoint: Identifiable {
    let day: Date
    let value: Int
    var id: TimeInterval { day.timeIntervalSince1970 }
}

struct AgentStatusItem: Identifiable {
    let agentType: String
    let events: Int
    let tokens: Int
    let sessions: Int
    let share: Double
    var id: String { agentType }
    var formattedTokens: String { Formatters.compactNumber(tokens) }
}

struct ProviderShareItem: Identifiable {
    let provider: String
    let tokens: Int
    let share: Double
    var id: String { provider }
    var formattedTokens: String { Formatters.compactNumber(tokens) }
    var formattedShare: String { Formatters.percent(share) }
}

struct RepoShareItem: Identifiable {
    let repo: String
    let sessions: Int
    let events: Int
    var id: String { repo }
}

// MARK: - Snapshot

struct PilotMetricsSnapshot {
    var aggregationRange: MetricsAggregationRange
    var totalTokens: Int
    var inputTokens: Int
    var outputTokens: Int
    var cacheReadTokens: Int
    var totalEvents: Int
    var totalSessions: Int
    var totalRequests: Int
    var totalToolCalls: Int
    var dailyTokenUsage: [DailyMetricPoint]
    var dailySessionCounts: [DailyMetricPoint]
    var agentStats: [AgentStatusItem]
    var providerShares: [ProviderShareItem]
    var repoShares: [RepoShareItem]
    var errorMessage: String?

    static func makeEmpty(range: MetricsAggregationRange = .today) -> PilotMetricsSnapshot {
        PilotMetricsSnapshot(
            aggregationRange: range,
            totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
            totalEvents: 0, totalSessions: 0, totalRequests: 0, totalToolCalls: 0,
            dailyTokenUsage: [], dailySessionCounts: [],
            agentStats: [], providerShares: [], repoShares: [],
            errorMessage: nil
        )
    }

    static let empty = PilotMetricsSnapshot.makeEmpty()

    var formattedTotalTokens: String { Formatters.compactNumber(totalTokens) }
    var formattedInputTokens: String { Formatters.compactNumber(inputTokens) }
    var formattedOutputTokens: String { Formatters.compactNumber(outputTokens) }

    var formattedCacheReadShare: String {
        guard inputTokens > 0 else { return "0%" }
        return Formatters.percent(Double(cacheReadTokens) / Double(inputTokens))
    }

    var menuBarTitle: String { formattedTotalTokens }
}

// MARK: - JSON Codable

private struct SummaryFile: Decodable {
    let version: Int?
    let ranges: RangesFile?
    let dailyTokens: [DailyPointFile]?
    let dailySessions: [DailyPointFile]?
}

private struct RangesFile: Decodable {
    let today: RangeDataFile?
    let sevenDays: RangeDataFile?
    let thirtyDays: RangeDataFile?
}

private struct RangeDataFile: Decodable {
    let totalTokens: Int?
    let inputTokens: Int?
    let outputTokens: Int?
    let cacheReadTokens: Int?
    let cacheCreationTokens: Int?
    let totalSessions: Int?
    let totalRequests: Int?
    let totalToolCalls: Int?
    let totalEvents: Int?
    let agentShares: [AgentShareFile]?
    let providerShares: [ProviderShareFile]?
    let repoShares: [RepoShareFile]?
}

private struct AgentShareFile: Decodable {
    let agentType: String?
    let sessions: Int?
    let events: Int?
    let tokens: Int?
    let share: Double?
}

private struct ProviderShareFile: Decodable {
    let provider: String?
    let totalTokens: Int?
    let share: Double?
}

private struct RepoShareFile: Decodable {
    let repo: String?
    let sessions: Int?
    let events: Int?
}

private struct DailyPointFile: Decodable {
    let day: String?
    let value: Int?
}

// MARK: - Store

@MainActor
final class PilotMetricsStore: ObservableObject {
    @Published private(set) var snapshot = PilotMetricsSnapshot.empty
    @Published private(set) var selectedRange: MetricsAggregationRange = .today

    private var timer: Timer?
    private var cachedSummary: SummaryFile?
    private let summaryPath: String = {
        if let dataDir = ProcessInfo.processInfo.environment["LOONGSUITE_PILOT_DATA_DIR"], !dataDir.isEmpty {
            return (dataDir as NSString).appendingPathComponent("logs/metrics-summary.json")
        }
        return NSString(string: "~/.loongsuite-pilot/logs/metrics-summary.json").expandingTildeInPath
    }()

    private let refreshQueue = DispatchQueue(label: "com.loongsuite-pilot.status-bar.metrics-refresh", qos: .utility)

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    func start() {
        StatusBarLogger.info("metrics store started")
        refresh()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refresh()
            }
        }
    }

    func stop() {
        StatusBarLogger.info("metrics store stopped")
        timer?.invalidate()
        timer = nil
    }

    func refresh() {
        let path = self.summaryPath
        refreshQueue.async { [weak self] in
            let file = Self.loadFile(path: path)
            DispatchQueue.main.async {
                guard let self else { return }
                self.cachedSummary = file
                self.snapshot = Self.buildSnapshot(from: file, range: self.selectedRange)
            }
        }
    }

    func selectRange(_ range: MetricsAggregationRange) {
        guard selectedRange != range else { return }
        selectedRange = range
        if let file = cachedSummary {
            snapshot = Self.buildSnapshot(from: file, range: range)
        } else {
            snapshot = PilotMetricsSnapshot.makeEmpty(range: range)
        }
    }

    private nonisolated static func loadFile(path: String) -> SummaryFile? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        return try? JSONDecoder().decode(SummaryFile.self, from: data)
    }

    private static func buildSnapshot(from file: SummaryFile?, range: MetricsAggregationRange) -> PilotMetricsSnapshot {
        guard let file else {
            var empty = PilotMetricsSnapshot.makeEmpty(range: range)
            empty.errorMessage = "未发现 metrics-summary.json，请先启动 loongsuite-pilot 守护进程。"
            return empty
        }

        let rangeData: RangeDataFile?
        switch range {
        case .today: rangeData = file.ranges?.today
        case .sevenDays: rangeData = file.ranges?.sevenDays
        case .thirtyDays: rangeData = file.ranges?.thirtyDays
        }

        let rd = rangeData

        let trendDayCount = range.trendRange == .thirtyDays ? 30 : 7
        let dailyTokens = parseDailyPoints(file.dailyTokens, lastN: trendDayCount)
        let dailySessions = parseDailyPoints(file.dailySessions, lastN: trendDayCount)

        let agentStats = (rd?.agentShares ?? []).map { item in
            AgentStatusItem(
                agentType: item.agentType ?? "unknown",
                events: item.events ?? 0,
                tokens: item.tokens ?? 0,
                sessions: item.sessions ?? 0,
                share: item.share ?? 0
            )
        }

        let providerShares = (rd?.providerShares ?? []).map { item in
            ProviderShareItem(
                provider: item.provider ?? "unknown",
                tokens: item.totalTokens ?? 0,
                share: item.share ?? 0
            )
        }

        let repoShares = (rd?.repoShares ?? []).map { item in
            RepoShareItem(
                repo: item.repo ?? "unknown",
                sessions: item.sessions ?? 0,
                events: item.events ?? 0
            )
        }

        return PilotMetricsSnapshot(
            aggregationRange: range,
            totalTokens: rd?.totalTokens ?? 0,
            inputTokens: rd?.inputTokens ?? 0,
            outputTokens: rd?.outputTokens ?? 0,
            cacheReadTokens: rd?.cacheReadTokens ?? 0,
            totalEvents: rd?.totalEvents ?? 0,
            totalSessions: rd?.totalSessions ?? 0,
            totalRequests: rd?.totalRequests ?? 0,
            totalToolCalls: rd?.totalToolCalls ?? 0,
            dailyTokenUsage: dailyTokens,
            dailySessionCounts: dailySessions,
            agentStats: agentStats,
            providerShares: providerShares,
            repoShares: repoShares,
            errorMessage: nil
        )
    }

    private static func parseDailyPoints(_ points: [DailyPointFile]?, lastN: Int?) -> [DailyMetricPoint] {
        guard let points else { return [] }
        let parsed = points.compactMap { item -> DailyMetricPoint? in
            guard let dayStr = item.day,
                  let date = dayFormatter.date(from: dayStr) else { return nil }
            return DailyMetricPoint(day: date, value: item.value ?? 0)
        }
        if let lastN, parsed.count > lastN {
            return Array(parsed.suffix(lastN))
        }
        return parsed
    }
}
