# LoongSuite Pilot Documentation

English | [简体中文](zh-CN/README.md)

This directory contains user-facing guides for installing, configuring, operating, and extending LoongSuite Pilot.

## Start Here

| Document | Use It For |
|----------|------------|
| [Product Overview](overview.md) | Understand what Pilot collects, where data goes, and what files are created locally. |
| [Installation](installation.md) | Install Pilot, pass installer options, uninstall, or run from source. |
| [Configuration Guide](configuration.md) | Learn config loading order, global switches, and retention settings. |

## Configure Outputs

| Document | Use It For |
|----------|------------|
| [Local JSONL Output](local-jsonl-output.md) | Write normalized events to local files and verify collection. |
| [SLS Output](sls-output.md) | Report logs to Alibaba Cloud Log Service. |
| [Trace Output](trace-output.md) | Export GenAI activity as OTLP traces. |
| [HTTP Output](http-output.md) | POST normalized events to a custom endpoint. |

## Configure Collection And Privacy

| Document | Use It For |
|----------|------------|
| [Agent Configuration](agents.md) | Select agents and control message content capture. |
| [Data Masking](masking.md) | Mask API keys, access keys, private keys, and database URLs before output. |
| [Output Event Schema](output-event-schema.md) | Review normalized event names, fields, provider values, and finish reasons. |

## Extend Pilot

| Document | Use It For |
|----------|------------|
| [Agent Onboarding](agent-onboarding.md) | Add support for a new AI coding agent. |
