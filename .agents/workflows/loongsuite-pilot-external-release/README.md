# LoongSuite Pilot external 发布工作流

这是 `1.0.0-validation` 版本的单一事实来源，用于验证 Multica 小队、Agent、Autopilot 和 Skill 的协作契约。

当前版本只支持 external（商业版），且只允许验证。它不会创建或更新 Multica 资源，不会发送通知，也不会运行 release、rollout、promote、OSS、Tag、CR 或 GitHub 发布。

## 本地验证

```bash
node .agents/workflows/loongsuite-pilot-external-release/scripts/validate-workflow.mjs
node --test .agents/workflows/loongsuite-pilot-external-release/tests/*.test.mjs
```

离线比较版本库内容与 fixture：

```bash
node .agents/workflows/loongsuite-pilot-external-release/scripts/sync-multica.mjs \
  plan \
  --snapshot .agents/workflows/loongsuite-pilot-external-release/tests/fixtures/live-snapshot.json
```

只读比较版本库内容与当前 Multica：

```bash
node .agents/workflows/loongsuite-pilot-external-release/scripts/sync-multica.mjs \
  plan \
  --live
```

输出只包含资源标识、状态和内容哈希，不包含完整在线 Instructions 或可能携带密钥的字段。

## 安全边界

`sync-multica.mjs` 只实现 `plan`。传入 `apply` 或其他命令会以 `PRODUCTION_APPLY_DISABLED` 失败。

若以后需要启用真实同步或在线发布，必须创建新的工作流版本，另行评审写操作、权限、回滚、通知和人工批准语义；不得直接放宽本版本的验证护栏。
