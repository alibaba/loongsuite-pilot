import SwiftUI
import Charts

// MARK: - Design Tokens

private enum DT {
    static let bg       = Color(red: 0.059, green: 0.067, blue: 0.090)
    static let card     = Color(red: 0.102, green: 0.114, blue: 0.153)
    static let border   = Color.white.opacity(0.06)

    static let text     = Color(red: 0.91, green: 0.93, blue: 0.96)
    static let muted    = Color(red: 0.42, green: 0.45, blue: 0.50)
    static let dim      = Color(red: 0.28, green: 0.31, blue: 0.36)

    static let accent   = Color(red: 0.39, green: 0.40, blue: 0.95)   // indigo
    static let green    = Color(red: 0.13, green: 0.77, blue: 0.37)
    static let amber    = Color(red: 0.96, green: 0.62, blue: 0.04)
    static let red      = Color(red: 0.94, green: 0.27, blue: 0.27)
    static let cyan     = Color(red: 0.13, green: 0.83, blue: 0.93)
}

// MARK: - PanelContentView

struct PanelContentView: View {
    @ObservedObject var runtimeStore: PilotRuntimeStore
    @ObservedObject var metricsStore: PilotMetricsStore
    let closePanel: () -> Void

    var body: some View {
        ZStack {
            DT.bg.ignoresSafeArea()

            VStack(spacing: 0) {
                header
                Divider().background(DT.border)

                ScrollView(showsIndicators: false) {
                    VStack(spacing: 12) {
                        statsGrid
                        rangeSelector
                        agentsSection
                        providersSection
                        reposSection
                        tokenTrendSection
                        sessionTrendSection
                        tokenBreakdownSection
                        if let msg = metricsStore.snapshot.errorMessage {
                            errorBanner(msg)
                        }
                    }
                    .padding(16)
                }
            }
        }
        .frame(minWidth: 480, minHeight: 640)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)

            Text("LoongSuite Pilot")
                .font(.system(size: 14, weight: .semibold, design: .rounded))
                .foregroundStyle(DT.text)

            Text(runtimeStore.snapshot.appVersionText)
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(DT.muted)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 4).fill(DT.card))

            Spacer()

            if let updatedAt = runtimeStore.snapshot.updatedAt {
                Text(shortTime(updatedAt))
                    .font(.system(size: 10))
                    .foregroundStyle(DT.dim)
            }

            Button(action: closePanel) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(DT.muted)
                    .frame(width: 22, height: 22)
                    .background(Circle().fill(DT.card))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var statusColor: Color {
        runtimeStore.isReachable ? DT.green : DT.amber
    }

    // MARK: - Stats Grid

    private var statsGrid: some View {
        HStack(spacing: 8) {
            statCell(value: metricsStore.snapshot.formattedTotalTokens, label: "TOKENS", accent: DT.accent)
            statCell(value: "\(metricsStore.snapshot.totalSessions)", label: "SESSIONS", accent: DT.cyan)
            statCell(value: "\(metricsStore.snapshot.totalRequests)", label: "REQUESTS", accent: DT.muted)
            statCell(value: "\(metricsStore.snapshot.totalToolCalls)", label: "TOOLS", accent: DT.muted)
        }
    }

    private func statCell(value: String, label: String, accent: Color) -> some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.system(size: 20, weight: .bold, design: .rounded))
                .foregroundStyle(DT.text)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(label)
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(accent)
                .kerning(1)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(DT.card))
    }

    // MARK: - Range Selector

    private var rangeSelector: some View {
        HStack(spacing: 4) {
            ForEach(MetricsAggregationRange.allCases) { range in
                let selected = metricsStore.selectedRange == range
                Button { metricsStore.selectRange(range) } label: {
                    Text(range.pickerTitle)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(selected ? DT.bg : DT.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(
                            RoundedRectangle(cornerRadius: 6)
                                .fill(selected ? DT.accent : Color.clear)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .background(RoundedRectangle(cornerRadius: 8).fill(DT.card))
    }

    // MARK: - Agents

    private var agentsSection: some View {
        section(title: "AGENTS") {
            if metricsStore.snapshot.agentStats.isEmpty {
                emptyText("No agent data")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(metricsStore.snapshot.agentStats.enumerated()), id: \.element.id) { index, agent in
                        HStack(spacing: 10) {
                            Circle()
                                .fill(agent.events > 0 ? DT.green : DT.dim)
                                .frame(width: 6, height: 6)

                            Text(agent.agentType)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(DT.text)
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)

                            Text("\(agent.events)")
                                .font(.system(size: 11, weight: .medium, design: .rounded))
                                .foregroundStyle(DT.muted)
                                .frame(width: 50, alignment: .trailing)

                            Text(agent.formattedTokens)
                                .font(.system(size: 11, weight: .semibold, design: .rounded))
                                .foregroundStyle(DT.text)
                                .frame(width: 55, alignment: .trailing)
                        }
                        .padding(.vertical, 7)

                        if index < metricsStore.snapshot.agentStats.count - 1 {
                            Divider().background(DT.border)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Providers

    private var providersSection: some View {
        section(title: "PROVIDERS") {
            if metricsStore.snapshot.providerShares.isEmpty {
                emptyText("No provider data")
            } else {
                VStack(spacing: 10) {
                    ForEach(metricsStore.snapshot.providerShares) { item in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(item.provider)
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(DT.text)
                                Spacer()
                                Text(item.formattedShare)
                                    .font(.system(size: 11, weight: .semibold, design: .rounded))
                                    .foregroundStyle(DT.accent)
                                Text(item.formattedTokens)
                                    .font(.system(size: 11, weight: .medium, design: .rounded))
                                    .foregroundStyle(DT.muted)
                                    .frame(width: 50, alignment: .trailing)
                            }

                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(DT.border)
                                    RoundedRectangle(cornerRadius: 2)
                                        .fill(DT.accent.opacity(0.7))
                                        .frame(width: max(4, geo.size.width * item.share))
                                }
                            }
                            .frame(height: 4)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Repositories

    private var reposSection: some View {
        section(title: "REPOSITORIES") {
            if metricsStore.snapshot.repoShares.isEmpty {
                emptyText("No repository data")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(metricsStore.snapshot.repoShares.prefix(6).enumerated()), id: \.element.id) { index, repo in
                        HStack(spacing: 8) {
                            Image(systemName: "folder")
                                .font(.system(size: 10))
                                .foregroundStyle(DT.dim)

                            Text(repo.repo)
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(DT.text)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .frame(maxWidth: .infinity, alignment: .leading)

                            Text("\(repo.sessions) sess")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(DT.muted)

                            Text("\(repo.events) evt")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(DT.muted)
                        }
                        .padding(.vertical, 6)

                        if index < min(5, metricsStore.snapshot.repoShares.count - 1) {
                            Divider().background(DT.border)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Token Trend

    private var tokenTrendSection: some View {
        section(title: metricsStore.snapshot.aggregationRange.tokenTrendTitle) {
            if metricsStore.snapshot.dailyTokenUsage.isEmpty {
                emptyText("No trend data")
            } else {
                Chart(metricsStore.snapshot.dailyTokenUsage) { item in
                    AreaMark(x: .value("Day", item.day, unit: .day), y: .value("Tokens", item.value))
                        .interpolationMethod(.catmullRom)
                        .foregroundStyle(LinearGradient(colors: [DT.accent.opacity(0.25), DT.accent.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                    LineMark(x: .value("Day", item.day, unit: .day), y: .value("Tokens", item.value))
                        .interpolationMethod(.catmullRom)
                        .foregroundStyle(DT.accent)
                        .lineStyle(.init(lineWidth: 1.8, lineCap: .round))
                }
                .chartYAxis {
                    AxisMarks(position: .leading) {
                        AxisValueLabel().font(.system(size: 9)).foregroundStyle(DT.dim)
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.3, dash: [4, 4])).foregroundStyle(DT.border)
                    }
                }
                .chartXAxis {
                    AxisMarks { AxisValueLabel().font(.system(size: 9)).foregroundStyle(DT.dim) }
                }
                .frame(height: 120)
            }
        }
    }

    // MARK: - Session Trend

    private var sessionTrendSection: some View {
        section(title: metricsStore.snapshot.aggregationRange.sessionTrendTitle) {
            if metricsStore.snapshot.dailySessionCounts.isEmpty {
                emptyText("No session data")
            } else {
                Chart(metricsStore.snapshot.dailySessionCounts) { item in
                    BarMark(x: .value("Day", item.day, unit: .day), y: .value("Sessions", item.value))
                        .foregroundStyle(DT.accent.opacity(0.6))
                        .cornerRadius(3)
                }
                .chartYAxis {
                    AxisMarks(position: .leading) {
                        AxisValueLabel().font(.system(size: 9)).foregroundStyle(DT.dim)
                        AxisGridLine(stroke: StrokeStyle(lineWidth: 0.3, dash: [4, 4])).foregroundStyle(DT.border)
                    }
                }
                .chartXAxis {
                    AxisMarks { AxisValueLabel().font(.system(size: 9)).foregroundStyle(DT.dim) }
                }
                .frame(height: 100)
            }
        }
    }

    // MARK: - Token Breakdown

    private var tokenBreakdownSection: some View {
        section(title: "TOKEN BREAKDOWN") {
            HStack(spacing: 0) {
                breakdownCell(label: "INPUT", value: metricsStore.snapshot.formattedInputTokens, accent: DT.accent)
                Divider().frame(height: 36).background(DT.border)
                breakdownCell(label: "OUTPUT", value: metricsStore.snapshot.formattedOutputTokens, accent: DT.cyan)
                Divider().frame(height: 36).background(DT.border)
                breakdownCell(label: "CACHE HIT", value: metricsStore.snapshot.formattedCacheReadShare, accent: DT.green)
            }
        }
    }

    private func breakdownCell(label: String, value: String, accent: Color) -> some View {
        VStack(spacing: 4) {
            Text(value)
                .font(.system(size: 18, weight: .bold, design: .rounded))
                .foregroundStyle(DT.text)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label)
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(accent)
                .kerning(0.8)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    // MARK: - Error

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 11))
                .foregroundStyle(DT.amber)
            Text(message)
                .font(.system(size: 11))
                .foregroundStyle(DT.amber.opacity(0.85))
                .lineLimit(2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(DT.amber.opacity(0.06)).overlay(RoundedRectangle(cornerRadius: 8).stroke(DT.amber.opacity(0.15), lineWidth: 0.5)))
    }

    // MARK: - Shared

    private func section<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(DT.muted)
                .kerning(1.2)
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(DT.card)
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(DT.border, lineWidth: 0.5))
        )
    }

    private func emptyText(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundStyle(DT.dim)
            .padding(.vertical, 4)
    }

    private func shortTime(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) else {
            return String(iso.prefix(19)).replacingOccurrences(of: "T", with: " ")
        }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        formatter.timeZone = .current
        return formatter.string(from: date)
    }
}
