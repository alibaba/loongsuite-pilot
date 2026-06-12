import XCTest
@testable import LoongSuitePilotMenuBarApp

final class MetricsSnapshotTests: XCTestCase {

    // MARK: - Snapshot computed properties

    func testFormattedTotalTokens() {
        var snapshot = PilotMetricsSnapshot.makeEmpty(range: .today)
        snapshot.totalTokens = 48_534_323
        XCTAssertEqual(snapshot.formattedTotalTokens, "48.5M")
    }

    func testFormattedCacheReadShare_withData() {
        var snapshot = PilotMetricsSnapshot.makeEmpty(range: .today)
        snapshot.inputTokens = 100_000
        snapshot.cacheReadTokens = 85_000
        XCTAssertEqual(snapshot.formattedCacheReadShare, "85%")
    }

    func testFormattedCacheReadShare_zeroInput() {
        let snapshot = PilotMetricsSnapshot.makeEmpty(range: .today)
        XCTAssertEqual(snapshot.formattedCacheReadShare, "0%")
    }

    func testMenuBarTitle() {
        var snapshot = PilotMetricsSnapshot.makeEmpty(range: .today)
        snapshot.totalTokens = 8_523_400
        XCTAssertEqual(snapshot.menuBarTitle, "8.5M")
    }

    func testMenuBarTitle_zero() {
        let snapshot = PilotMetricsSnapshot.makeEmpty(range: .today)
        XCTAssertEqual(snapshot.menuBarTitle, "0")
    }

    // MARK: - AgentStatusItem

    func testAgentStatusItem_formattedTokens() {
        let item = AgentStatusItem(agentType: "claude-code", events: 415, tokens: 6_200_000, sessions: 3, share: 0.4)
        XCTAssertEqual(item.formattedTokens, "6.2M")
    }

    // MARK: - ProviderShareItem

    func testProviderShareItem_formattedShare() {
        let item = ProviderShareItem(provider: "anthropic", tokens: 6_200_000, share: 0.73)
        XCTAssertEqual(item.formattedShare, "73%")
        XCTAssertEqual(item.formattedTokens, "6.2M")
    }

    // MARK: - MetricsAggregationRange

    func testRangePickerTitles() {
        XCTAssertEqual(MetricsAggregationRange.today.pickerTitle, "今日")
        XCTAssertEqual(MetricsAggregationRange.sevenDays.pickerTitle, "7天")
        XCTAssertEqual(MetricsAggregationRange.thirtyDays.pickerTitle, "30天")
    }

    func testRangeTrendRange() {
        XCTAssertEqual(MetricsAggregationRange.today.trendRange, .sevenDays)
        XCTAssertEqual(MetricsAggregationRange.sevenDays.trendRange, .sevenDays)
        XCTAssertEqual(MetricsAggregationRange.thirtyDays.trendRange, .thirtyDays)
    }
}
