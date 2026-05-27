## 1. 新建中心化规范化模块

- [x] 1.1 新建 `src/normalization/normalize-messages.ts`，实现 `normalizeOutputMessages()`、`normalizeInputMessagesDelta()`、`normalizeInputMessages()` 三个幂等规范化函数
- [x] 1.2 新建 `tests/unit/normalization/normalize-messages.test.ts`，覆盖 spec 中定义的所有场景（bare parts、flat content、snake_case finishReason、已规范数据、undefined/null、多 parts）

## 2. 集成到 entry-builder

- [x] 2.1 在 `src/normalization/entry-builder.ts` 的 `buildAgentActivityEntry` 中，于 `removeLegacyAliases(entry)` 之前调用三个规范化函数
- [ ] 2.2 更新 `tests/unit/normalization/build-entry.test.ts`，验证非规范格式经过 entry-builder 后输出为规范格式

## 3. hook 层 cursor 源头修复

- [ ] 3.1 修改 `assets/hooks/agent-event-normalizer.mjs` 的 `buildCursorOutputMessages()` 函数，输出 `[{role:"assistant", parts:[{type, content}]}]` 格式
- [ ] 3.2 修改 `assets/hooks/agent-event-normalizer.mjs` 的 `buildCursorInputMessagesDelta()` 函数，输出 `[{role, parts:[{type:"text", content}]}]` 格式
- [ ] 3.3 更新 `tests/unit/hooks/agent-event-normalizer.test.mjs` 中的相关测试用例

## 4. hook 层 qoder 源头修复

- [ ] 4.1 修改 `assets/hooks/agent-event-normalizer.mjs` 的 `buildQoderOutputMessages()` 函数，输出规范格式
- [ ] 4.2 修改 `assets/hooks/agent-event-normalizer.mjs` 的 `buildQoderInputMessagesDelta()` 函数，输出规范格式
- [ ] 4.3 更新 `tests/unit/hooks/agent-event-normalizer.test.mjs` 中的相关测试用例（与 3.3 合并）

## 5. 回退 input 层改动

- [ ] 5.1 回退 `src/inputs/cursor-hook/cursor-hook-input.ts` 的 `buildOutputMessages` 和 `buildInputMessagesDelta` 到 master 版本
- [ ] 5.2 回退 `src/inputs/qoder-cli/qoder-cli-input.ts` 的 `buildOutputMessages` 和 `buildInputMessagesDelta` 到 master 版本
- [ ] 5.3 回退 `tests/unit/inputs/cursor-hook-input.test.ts` 测试改动
- [ ] 5.4 回退 `tests/unit/inputs/qoder-cli-input.test.ts` 测试改动
- [ ] 5.5 回退 `tests/unit/inputs/qoder-work-input.test.ts` 测试改动

## 6. 验证

- [ ] 6.1 运行 `npx vitest run tests/unit/hooks/` 确保 hook 层测试通过
- [ ] 6.2 运行 `npx vitest run tests/unit/normalization/` 确保规范化函数测试通过
- [ ] 6.3 运行 `npx vitest run tests/unit/inputs/` 确保各 input 测试通过
- [ ] 6.4 运行 `npm run typecheck` 确保类型检查通过
- [ ] 6.5 本地部署后检查 `~/.loongsuite-pilot/logs/output/` 中的 JSONL 输出，确认各 agent 的 messages 字段已为标准格式
