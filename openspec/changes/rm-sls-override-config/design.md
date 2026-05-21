## Context

当前 SLS 双发设计（`add-sls-dual-write`）通过 `config.sls.destinationOverride` 字段和安装器 `--default-sls-override` 参数，让用户选择是否将内部 logstore 替换为自有目的地。这个设计在集团内部署场景下不符合产品策略：集团内版本必须 100% 发内部 logstore，不允许用户通过任何开关关闭。

同时，集团外版本需要完全不包含内部 logstore 的代码——不是运行时禁用，而是编译产物中不存在相关常量和逻辑。当前纯 `tsc` 编译无法实现这一点，因为 `tsc` 不做 dead-code elimination。

构建工具链现状：`npm run build` → `tsc` → `dist/*.js`。`deploy/package.sh` 调用 `npx tsc` 生成产物后打包为 `tar.gz`。

## Goals / Non-Goals

**Goals:**
- 集团内版本：用户配了自有 SLS 目的地时无条件双发（用户 + 内部），无任何开关
- 集团外版本：编译产物中不包含 `INTERNAL_SLS_DESTINATION` 常量和 `buildInternalSlsEndpoint` 函数
- 单代码库、单分支，通过编译期常量实现版本隔离
- 删除 `--default-sls-override` 安装参数和 `destinationOverride` 配置字段
- 对用户安装、运行完全透明（产物仍是 `dist/*.js`，`node dist/index.js` 不变）

**Non-Goals:**
- 不更改 `SlsEndpoint` 接口结构、SlsFlusher 的多目的地派发逻辑、dedup 逻辑（这些在 `add-sls-dual-write` 中已实现，本次仅改变上游 resolution 策略）
- 不更改 JSONL / HTTP flusher 行为
- 不统一两个安装器脚本（`installer.sh` 和 `installer-inner.sh`）
- 不引入 bundle 模式——esbuild 仍以多文件形式输出 `dist/`，保持与现有部署结构一致

## Decisions

### D1. esbuild `--define` + dead-code elimination 作为编译期隔离方案

使用 esbuild 的 `define` 选项将 `__INTERNAL_BUILD__` 替换为字面量 `true` 或 `false`。esbuild 在编译时会将 `if (false) { ... }` 整块移除（dead-code elimination），从而让集团外产物不包含内部目的地代码。

esbuild 以非 bundle 模式运行（`bundle: false`），保持多文件输出，`dist/` 目录结构不变。

`tsc` 保留为类型检查工具（`tsc --noEmit`），不再生成产物。

**Alternatives considered:**
- *`tsc` + 构建后脚本删除文件*：脆弱，依赖文件路径硬编码，无法删除文件内的局部引用。
- *`process.env.BUILD_TARGET` 运行时判断*：外部产物仍包含全部代码，不满足"代码不存在"的要求。
- *Rollup + `@rollup/plugin-replace`*：可行，但项目对 Rollup 的直接依赖是通过 Vitest 间接引入的，不宜作为生产构建工具。
- *webpack + DefinePlugin*：配置复杂，对这个规模的项目过重。

### D2. 编译期常量 `__INTERNAL_BUILD__` 的声明与使用

在 `src/internal/build-flags.d.ts` 中声明全局常量类型：

```ts
declare const __INTERNAL_BUILD__: boolean;
```

代码中使用 `if (__INTERNAL_BUILD__)` 守护内部专属逻辑。esbuild 在编译时将其替换为字面量，dead-code elimination 移除不可达分支。

Vitest 通过 `vitest.config.ts` 的 `define` 字段控制测试时的值，默认设为 `true`（测试内部版本逻辑为主），需要测试外部版本逻辑时通过测试用例级别的 mock 或独立测试文件切换。

### D3. `buildSlsConfig` 解析逻辑简化

移除 `destinationOverride` 读取，改为基于 `__INTERNAL_BUILD__` 的分支：

```
1. Read user-provided fields (env > config.sls.* > undefined).
2. hasUserDestination = (user project && user logstore present)
3. If __INTERNAL_BUILD__:
     If !hasUserDestination → endpoints = [INTERNAL]
     Else                   → endpoints = [userEndpoint, INTERNAL]   // 无条件双发
4. If !__INTERNAL_BUILD__:
     If !hasUserDestination → endpoints = []                         // SLS 不启用
     Else                   → endpoints = [userEndpoint]             // 仅用户
5. Dedup pass (保留，防止用户字段恰好等于内部常量时重复发送)
```

dedup 逻辑和 `SlsEndpoint` 结构不变。

### D4. 两个构建目标

`package.json` 新增 scripts：

```json
{
  "build": "node build.mjs --internal",
  "build:internal": "node build.mjs --internal",
  "build:external": "node build.mjs",
  "typecheck": "tsc --noEmit"
}
```

`build` 默认产出集团内版本（`__INTERNAL_BUILD__ = true`），保持现有 CI / `deploy/package.sh` 无需改动。

`deploy/package.sh` 中的 `npx tsc` 改为 `npm run build`（或 `node build.mjs --internal`）。

### D5. esbuild 构建配置（`build.mjs`）

```js
import esbuild from 'esbuild';
const isInternal = process.argv.includes('--internal');

await esbuild.build({
  entryPoints: ['src/**/*.ts'],
  outdir: 'dist',
  platform: 'node',
  target: 'es2022',
  format: 'esm',
  bundle: false,
  define: { '__INTERNAL_BUILD__': String(isInternal) },
  sourcemap: true,
});
```

关键配置：
- `bundle: false`：保持多文件输出，与现有 `dist/` 目录结构一致
- `format: 'esm'`：匹配 `package.json` 的 `"type": "module"`
- `platform: 'node'`：Node.js 运行时
- `target: 'es2022'`：匹配 `tsconfig.json` 的 `target`

注意：esbuild 在 `bundle: false` 模式下仍会做 define 替换和常量折叠（`if (false)` 被移除），但不会做跨文件的 tree-shaking。因此 `sls-destination.ts` 文件本身仍会出现在外部版本的 `dist/` 中（内容为空导出或仅类型），但其内部常量在所有引用处已被移除。如果需要完全不输出该文件，可在构建后脚本中删除，但这不是必须的——文件存在但无引用不会产生运行时影响。

### D6. 安装器脚本清理

从两个安装器脚本中删除：
- `--default-sls-override` 参数的 `case` 分支
- `DEFAULT_SLS_OVERRIDE` 变量声明和赋值
- standalone warning 逻辑（`--default-sls-override` without `--sls-*`）
- `write_config` Node.js 内嵌脚本中 `destinationOverride` 字段的写入

保留：所有 `--sls-*` 参数的解析和写入逻辑不变。

### D7. 存量 `destinationOverride` 字段处理

`buildSlsConfig` 不再读取 `file?.sls?.destinationOverride`。残留在 `config.json` 中的字段不会引起错误（TypeScript 的 ConfigFile 类型中该字段变为可选且未读取）。

不主动删除用户 config.json 中的该字段——升级不修改 config.json 是现有契约（README 第 204 行）。

## Risks / Trade-offs

- **[Risk] 存量用户静默行为变更** — 配了 `--sls-*` 且 `destinationOverride: true`（或省略）的用户，升级后内部 logstore 开始收到数据。→ **Mitigation**: 这是产品策略要求的行为（"集团内 100% 发"），数据是加法不是减法，不会丢失用户自有 logstore 的数据。自动更新推送后 4 小时内生效。
- **[Risk] esbuild 与 tsc 编译行为差异** — esbuild 不做类型检查、不输出 `.d.ts` 声明文件、对某些 TypeScript 特性（如 `const enum`、`emitDecoratorMetadata`）支持有限。→ **Mitigation**: 本项目不使用 `const enum` 和装饰器。`.d.ts` 声明文件在守护进程场景下非必需（不作为 npm 库发布）。类型安全通过 `tsc --noEmit` 保证。
- **[Risk] `bundle: false` 模式下 `sls-destination.ts` 文件仍存在于外部产物** — 文件存在但内部常量在所有引用处已被替换。→ **Mitigation**: 外部版本中该文件的导出函数体为空或被内联替换，运行时不会被调用。如果需要绝对干净，可以在 `build.mjs` 中加构建后脚本删除该文件。
- **[Trade-off] 新增 esbuild devDependency** — 增加约 9MB 的开发依赖。→ 可接受：esbuild 是 Node.js 生态中最轻量的 bundler/compiler，且编译速度远快于 tsc。
- **[Trade-off] `tsc --watch` 增量编译不再直接产出可运行代码** — 开发者需要运行 `npm run build` 获得可运行产物。→ **Mitigation**: esbuild 编译速度极快（通常 <100ms），可以通过 `chokidar` 或类似工具实现 watch 模式。或者在开发时继续用 `tsx` / `ts-node` 直接运行 TypeScript。

## Migration Plan

1. **代码变更先行**：修改 `buildSlsConfig` 使用 `__INTERNAL_BUILD__` 分支，添加 `build.mjs`，更新 `package.json` scripts。
2. **测试覆盖**：更新单元测试，验证 `__INTERNAL_BUILD__ = true` 和 `= false` 两种模式下的 resolution 行为。
3. **安装器清理**：删除 `--default-sls-override` 相关逻辑。
4. **文档更新**：更新 README 中的安装命令示例和 SLS 目的地解析规则。
5. **`deploy/package.sh` 更新**：将 `npx tsc` 改为 `npm run build`。
6. **发布**：通过现有 CI/CD 流程发布集团内版本（默认 `build:internal`），自动更新推送给用户。
7. **Rollback**：重新安装上一版本即可回滚。新版本 config.json 无破坏性变更，旧版本可正常读取。

## Open Questions

- 是否需要在升级时 log 一条 warning 提示 `destinationOverride` 字段已废弃？（建议：是，在 `buildSlsConfig` 中检测到该字段时记录 `logger.warn`）
- 外部版本的 `deploy/package.sh` 是否需要单独的打包入口（如 `package.sh --external`）？还是通过 CI 环境变量控制？（建议：`package.sh` 增加 `--external` 选项，传递给 `build.mjs`）
