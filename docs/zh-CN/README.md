# LoongSuite Pilot 文档

[English](../README.md) | 简体中文

这里是 LoongSuite Pilot 的用户文档入口，覆盖安装、配置、运行和扩展接入。

## 开始使用

| 文档 | 用途 |
|------|------|
| [产品概览](overview.md) | 了解 Pilot 采集什么、输出到哪里，以及本地会创建哪些文件。 |
| [安装指南](installation.md) | 安装 Pilot、传入安装参数、卸载或从源码运行。 |
| [配置总览](configuration.md) | 了解配置加载顺序、全局开关和日志保留策略。 |

## 配置输出

| 文档 | 用途 |
|------|------|
| [本地 JSONL 输出](local-jsonl-output.md) | 将规范化事件写入本地文件，并验证采集是否生效。 |
| [SLS 输出](sls-output.md) | 将日志上报到阿里云日志服务。 |
| [Trace 输出](trace-output.md) | 将 GenAI 活动导出为 OTLP Trace。 |
| [HTTP 输出](http-output.md) | 将规范化事件 POST 到自定义接口。 |

## 配置采集与隐私

| 文档 | 用途 |
|------|------|
| [Agent 配置](agents.md) | 选择采集哪些 Agent，并控制消息内容采集。 |
| [数据脱敏](masking.md) | 输出前脱敏 API Key、AccessKey、私钥和数据库 URL。 |
| [输出事件 Schema](output-event-schema.md) | 查看规范化事件名称、字段、Provider 和结束原因。 |

## 扩展 Pilot

| 文档 | 用途 |
|------|------|
| [新 Agent 接入](agent-onboarding.md) | 为新的 AI Coding Agent 增加采集支持。 |
