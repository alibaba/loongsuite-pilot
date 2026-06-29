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

    // MARK: - #3 ModelShareItem share extremes / progress bar width safety
    // 对应 PanelContentView.swift modelsSection: `max(4, geo.size.width * item.share)`
    // 安全契约: 进度条宽度必须是有限值，回落到最小 4 或被 clamp 到 totalWidth，避免 SwiftUI 因 NaN/越界宽度崩溃。

    /// 模拟 PanelContentView 中 `max(4, geo.size.width * item.share)` 的纯计算，便于在测试里验证安全契约。
    private func progressBarWidth(share: Double, totalWidth: Double) -> Double {
        return max(4.0, totalWidth * share)
    }

    func testModelShareItem_zeroShare_progressWidthFloorsAtFour() {
        let item = ModelShareItem(model: "claude-haiku-4-5", tokens: 0, share: 0)
        let width = progressBarWidth(share: item.share, totalWidth: 240)
        XCTAssertEqual(width, 4.0, "share=0 时进度条应回落到最小宽度 4")
        XCTAssertTrue(width.isFinite)
    }

    func testModelShareItem_shareGreaterThanOne_progressWidthClampedToTotalWidth() {
        // share>1 在 totalTokens 重置或上下游聚合异常时可能出现。
        // 安全契约: 宽度不应超过容器宽度，否则进度条会溢出 GeometryReader。
        let item = ModelShareItem(model: "anomaly-model", tokens: 999, share: 1.5)
        let totalWidth = 240.0
        let width = progressBarWidth(share: item.share, totalWidth: totalWidth)
        XCTAssertTrue(width.isFinite, "share=1.5 时宽度必须有限")
        XCTAssertLessThanOrEqual(
            width, totalWidth,
            "share>1 时进度条宽度应被 clamp 到 totalWidth=\(totalWidth)，实际宽度=\(width)"
        )
    }

    func testModelShareItem_nanShare_progressWidthIsFinite() {
        // share=NaN 在除零(totalTokens=0)等边界下可能出现。
        // 安全契约: 宽度必须有限，否则 SwiftUI .frame(width: NaN) 会 crash。
        let item = ModelShareItem(model: "nan-model", tokens: 0, share: .nan)
        let width = progressBarWidth(share: item.share, totalWidth: 240)
        XCTAssertEqual(item.share, 0, "ModelShareItem 应在 init 把 NaN clamp 到 0")
        XCTAssertFalse(width.isNaN, "share=NaN 时不能让进度条宽度变成 NaN（SwiftUI 会崩），实际宽度=\(width)")
        XCTAssertTrue(width.isFinite, "share=NaN 时宽度必须有限，实际宽度=\(width)")
    }

    // MARK: - #4 metrics-summary.json 字段为 null 的逐项缺失

    @MainActor
    func testBuildSnapshot_modelShareEntry_nullModel_fallsBackToUnknown() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let json = #"""
        {"version":1,"ranges":{"today":{"totalTokens":1000,
          "modelShares":[
            {"model":null,"totalTokens":600,"share":0.6},
            {"model":"claude-opus-4-7","totalTokens":400,"share":0.4}
          ]}}}
        """#.data(using: .utf8)!
        try json.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot loaded with null model")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.snapshot.modelShares.count, 2, "null model entry 应保留并填默认值，不应被吞掉")
        XCTAssertEqual(store.snapshot.modelShares[0].model, "unknown", "model=null 应回落到 unknown")
        XCTAssertEqual(store.snapshot.modelShares[0].tokens, 600)
        XCTAssertEqual(store.snapshot.modelShares[1].model, "claude-opus-4-7")
    }

    @MainActor
    func testBuildSnapshot_modelShareEntry_nullTotalTokens_fallsBackToZero() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let json = #"""
        {"version":1,"ranges":{"today":{"totalTokens":1000,
          "modelShares":[
            {"model":"claude-opus-4-7","totalTokens":null,"share":0.5},
            {"model":"claude-sonnet-4-6","totalTokens":500,"share":0.5}
          ]}}}
        """#.data(using: .utf8)!
        try json.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot loaded with null totalTokens")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.snapshot.modelShares.count, 2)
        XCTAssertEqual(store.snapshot.modelShares[0].model, "claude-opus-4-7")
        XCTAssertEqual(store.snapshot.modelShares[0].tokens, 0, "totalTokens=null 应回落到 0")
        XCTAssertEqual(store.snapshot.modelShares[0].formattedTokens, "0")
        XCTAssertEqual(store.snapshot.modelShares[1].tokens, 500)
    }

    @MainActor
    func testBuildSnapshot_modelShareEntry_nullShare_fallsBackToZero() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let json = #"""
        {"version":1,"ranges":{"today":{"totalTokens":1000,
          "modelShares":[
            {"model":"claude-opus-4-7","totalTokens":700,"share":null},
            {"model":"claude-sonnet-4-6","totalTokens":300,"share":0.3}
          ]}}}
        """#.data(using: .utf8)!
        try json.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot loaded with null share")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.snapshot.modelShares.count, 2)
        XCTAssertEqual(store.snapshot.modelShares[0].model, "claude-opus-4-7")
        XCTAssertEqual(store.snapshot.modelShares[0].share, 0, "share=null 应回落到 0")
        XCTAssertEqual(store.snapshot.modelShares[0].formattedShare, "0%")
        XCTAssertEqual(store.snapshot.modelShares[1].share, 0.3, accuracy: 0.0001)
    }

    @MainActor
    func testBuildSnapshot_modelShareEntry_allFieldsNull_fallsBackToDefaults() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let json = #"""
        {"version":1,"ranges":{"today":{"totalTokens":1000,
          "modelShares":[
            {"model":null,"totalTokens":null,"share":null}
          ]}}}
        """#.data(using: .utf8)!
        try json.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot loaded with all-null model entry")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.snapshot.modelShares.count, 1, "全空 entry 仍应保留，由 UI 决定如何显示")
        XCTAssertEqual(store.snapshot.modelShares[0].model, "unknown")
        XCTAssertEqual(store.snapshot.modelShares[0].tokens, 0)
        XCTAssertEqual(store.snapshot.modelShares[0].share, 0)
    }

    // MARK: - #5 整个 metrics-summary.json 是 malformed JSON

    @MainActor
    func testBuildSnapshot_malformedJSON_returnsEmptySnapshotWithError() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        // 截断的 JSON: 缺少右括号，JSONDecoder 必失败
        let malformed = #"""
        {"version":1,"ranges":{"today":{"totalTokens":1000,"modelShares":[
        """#.data(using: .utf8)!
        try malformed.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot fell back after malformed JSON")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        // 安全契约: malformed → loadFile 返回 nil → buildSnapshot 走 empty + errorMessage 分支，不 crash
        XCTAssertEqual(store.snapshot.totalTokens, 0, "malformed JSON 应回落到 0 token 的空 snapshot")
        XCTAssertTrue(store.snapshot.modelShares.isEmpty, "malformed JSON 不应残留任何 modelShares")
        XCTAssertTrue(store.snapshot.agentStats.isEmpty)
        XCTAssertTrue(store.snapshot.providerShares.isEmpty)
        XCTAssertNotNil(store.snapshot.errorMessage, "malformed/缺失文件场景应设置 errorMessage 提示用户")
    }

    @MainActor
    func testBuildSnapshot_garbageJSON_returnsEmptySnapshotWithError() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        // 完全不是 JSON 的文本
        let garbage = "this is not json at all 中文乱码 \u{0000}\u{FFFE}".data(using: .utf8)!
        try garbage.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot fell back after garbage JSON")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.snapshot.totalTokens, 0)
        XCTAssertTrue(store.snapshot.modelShares.isEmpty)
        XCTAssertNotNil(store.snapshot.errorMessage)
    }
}
