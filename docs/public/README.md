# Public 接入文档生成说明

这个目录维护 LoongSuite Pilot 对外接入文档。

## 怎么生成

在仓库根目录执行：

```bash
npm run docs:public
```

命令会读取：

```text
docs/public/pilot-integration.source.md
```

并生成：

```text
docs/public/agentloop-integration.md
docs/public/cms-integration.md
```

生成文件开头带有 `Generated from ...` 注释，不要直接手改生成文件。

## 怎么改文档

优先修改源文档：

```text
docs/public/pilot-integration.source.md
```

当前只维护一个变量：

```md
目标平台（{{platformName}}）已完成接入。
```

`{{platformName}}` 的取值在脚本中维护：

```text
docs/public/render-public-docs.mjs
```

其它平台差异不要继续加变量。确实不同的句子或步骤，用尽量小的条件块：

```md
<!-- platform:agentloop -->
AgentLoop 专属段落。
<!-- /platform -->

<!-- platform:cms -->
云监控 2.0 专属段落。
<!-- /platform -->
```

原则：只有平台名称用 `{{platformName}}`；其它差异用小条件块，不要把一整段重复两份。

## 修改后检查

每次修改源文档或脚本后，执行：

```bash
npm run docs:public
```

然后检查生成文档里没有残留：

```text
{{...}}
platform:
```
