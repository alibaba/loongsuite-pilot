# Verification: Remove Internal Flag and Hardcoded SLS Destination

本文档描述如何在 test-shimu channel 上验证集团版和商业版的改造结果。

自定义 SLS 测试信息：

- project: `shimu-qoder-worder-log-test-0427`
- logstore: `shimu-qoderwork-test-0427`
- endpoint: `https://cn-hangzhou.log.aliyuncs.com`

---

## 0. 前置：打包 & 上传

### 0.1 打包

```bash
# 构建 TypeScript → dist/
npm run build

# 生成 tar.gz 包（含 dist/、scripts/、agents.d/ 等）
bash deploy/package.sh
# 产出：./loongsuite-pilot.tar.gz
```

> 商业版和集团版共用同一个 tar 包，不需要分别打包。

### 0.2 上传到 test-shimu channel

```bash
# 集团版（内部 OSS 路径，附带 installer-inner.sh）
bash deploy/upload.sh --channel test-shimu

# 商业版（外部 OSS 路径，附带 installer.sh）
bash deploy/upload.sh --channel test-shimu --external
```

上传后的 OSS 路径：

| 版本 | OSS Prefix | installer |
|------|-----------|-----------|
| 集团版 | `loongsuite-dev/test-shimu/loongsuite-pilot/` | installer-inner.sh |
| 商业版 | `loongsuite-pilot-dev/test-shimu/` | installer.sh |

---

## 1–3. 自动化验证

验证脚本：`scripts/verify-remove-internal.sh`

```bash
# 场景 1：集团版单发（默认内部 SLS）
bash scripts/verify-remove-internal.sh 1

# 场景 2：集团版双发（自定义 SLS + 内部 SLS）
bash scripts/verify-remove-internal.sh 2

# 场景 3：商业版单发（自定义 SLS）
bash scripts/verify-remove-internal.sh 3
```

每个场景自动完成：安装 → config.json 逐项断言 → 启动 pilot → 检查状态和日志 → 停止 pilot → 输出 PASS/FAIL。

场景之间手动清理：

```bash
loongsuite-pilot stop

# 集团版清理
curl -fsSL https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-dev/test-shimu/loongsuite-pilot/installer.sh \
  | bash -s -- uninstall --purge

# 商业版清理
curl -fsSL https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot-dev/test-shimu/installer.sh \
  | bash -s -- uninstall --purge
```

---

## 验证矩阵

| # | 版本 | SLS 参数 | 预期 config.json SLS | 预期 SLS 状态 | 预期 internal 字段 |
|---|------|---------|---------------------|-------------|-------------------|
| 1 | 集团版 | 不传 | flat object: 内部默认 | 单发到内部 SLS | 不存在 |
| 2 | 集团版 | 传自定义 | sls 数组: [自定义, 内部] | 双发 | 不存在 |
| 3 | 商业版 | 传自定义 | flat object: 自定义 | 单发到自定义 SLS | 不存在 |
