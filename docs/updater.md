# 自动更新模块 (src/updater/)

> 独立 updater 进程定期检查远端版本，自动下载、部署、重启，支持自动回滚。

## 模块组成

| 文件 | 职责 |
|------|------|
| `updater.ts` | 更新主逻辑（检查→下载→部署→重启） |
| `version-utils.ts` | 版本比对和 VERSION 文件解析 |
| `index.ts` | updater 进程入口 |

## 多版本目录结构

```
~/.loongsuite-pilot/
├── current              ← JSON 指针文件，指向当前版本目录
├── previous             ← 上一版本指针（回滚用）
└── versions/
    ├── 1.0.34_abc1234/  ← 旧版本
    └── 1.0.35_def5678/  ← 当前版本
```

## 更新流程

<!-- TODO: 描述 updater 的完整工作循环（定时检查 → 下载 → 部署 → 切换指针 → 重启） -->
<!-- TODO: 描述 latest.json 版本清单的格式 -->
<!-- TODO: 描述版本比对逻辑（version + git_commit） -->

## 回滚机制

<!-- TODO: 描述自动回滚的触发条件（启动失败 / 进程不存活） -->
<!-- TODO: 描述手动回滚命令的实现（loongsuite-pilot rollback） -->
<!-- TODO: 描述引导脚本和命令入口的同步更新 -->

## 进程模型

<!-- TODO: 描述 updater 与采集器主进程的隔离关系 -->
<!-- TODO: 描述 launchd/systemd 对两个进程的独立管理 -->
<!-- TODO: 描述 "固定引导脚本 + 动态版本目录" 的设计 -->

## 版本清理

<!-- TODO: 描述旧版本自动清理策略（仅保留 current + previous） -->
