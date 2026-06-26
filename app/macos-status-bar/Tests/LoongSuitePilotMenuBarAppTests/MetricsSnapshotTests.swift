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

    func testMakeEmpty_hasEmptyModelShares() {
        let snapshot = PilotMetricsSnapshot.makeEmpty(range: .today)
        XCTAssertTrue(snapshot.modelShares.isEmpty)
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

    // MARK: - ModelShareItem

    func testModelShareItem_formattedShare() {
        let item = ModelShareItem(model: "claude-opus-4-7", tokens: 7_300_000, share: 0.73)
        XCTAssertEqual(item.formattedShare, "73%")
        XCTAssertEqual(item.formattedTokens, "7.3M")
        XCTAssertEqual(item.id, "claude-opus-4-7")
    }

    func testModelShareItem_smallTokens() {
        let item = ModelShareItem(model: "claude-haiku-4-5", tokens: 850, share: 0.0085)
        XCTAssertEqual(item.formattedShare, "1%")
        XCTAssertEqual(item.formattedTokens, "850")
    }

    // MARK: - buildSnapshot decodes modelShares

    @MainActor
    func testBuildSnapshot_decodesModelSharesInOrder() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        // fixture 来源: 仿照 tests/unit/status-bar/metrics-summary-writer.test.ts
        // 已有的 claude-opus-4-6 / claude-sonnet-4-6 modelShares 结构
        let json = #"""
        {"version":1,"ranges":{"today":{"totalTokens":10000000,
          "modelShares":[
            {"model":"claude-opus-4-7","totalTokens":7300000,"inputTokens":5000000,"cacheReadTokens":2000000,"share":0.73},
            {"model":"claude-sonnet-4-6","totalTokens":2700000,"inputTokens":1800000,"cacheReadTokens":400000,"share":0.27}
          ]}}}
        """#.data(using: .utf8)!
        try json.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot loaded from temp file")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.snapshot.totalTokens, 10_000_000)
        XCTAssertEqual(store.snapshot.modelShares.count, 2)
        XCTAssertEqual(store.snapshot.modelShares[0].model, "claude-opus-4-7")
        XCTAssertEqual(store.snapshot.modelShares[0].tokens, 7_300_000)
        XCTAssertEqual(store.snapshot.modelShares[0].share, 0.73, accuracy: 0.0001)
        XCTAssertEqual(store.snapshot.modelShares[0].formattedShare, "73%")
        XCTAssertEqual(store.snapshot.modelShares[0].formattedTokens, "7.3M")
        XCTAssertEqual(store.snapshot.modelShares[1].model, "claude-sonnet-4-6")
        XCTAssertEqual(store.snapshot.modelShares[1].tokens, 2_700_000)
        XCTAssertEqual(store.snapshot.modelShares[1].share, 0.27, accuracy: 0.0001)
        XCTAssertEqual(store.snapshot.modelShares[1].formattedShare, "27%")
        XCTAssertEqual(store.snapshot.modelShares[1].formattedTokens, "2.7M")
    }

    @MainActor
    func testBuildSnapshot_modelSharesMissing_yieldsEmptyArray() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        // 旧 metrics-summary.json 无 modelShares 字段 —— 向后兼容
        let json = #"""
        {"version":1,"ranges":{"today":{"totalTokens":1000}}}
        """#.data(using: .utf8)!
        try json.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot loaded without modelShares")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.snapshot.totalTokens, 1000)
        XCTAssertTrue(store.snapshot.modelShares.isEmpty)
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
