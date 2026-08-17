# DEVIATIONS — 本副本对**上游文件**的改动台账

本副本（`ar_deepseek_harness`，分支 `feat/ar-research-full`，基于 fork 的 `feat/workspace-file-tree`）
是 Knevo 客户端（形态 D）的设备侧代码。**每处对上游文件的改动记一行**；
`ar/`、`.dsh-home/`、`build-dist.mjs`、`knevo-*.mjs`、`assets/brand/` 是新增区，不算 deviation。

现状与决策以工作区根 `../AR-DSH-STATUS.md` 为准，架构见 `../AR-DSH-ARCHITECTURE-MAP.md`。

| # | 文件 | 改了什么 | 为什么 | 终态收敛 |
|---|---|---|---|---|
| 1 | `pnpm-workspace.yaml` | packages 加 `ar/*` | @knevo 插件区进 workspace | 插件迁独立仓 + profile 机制后删除 |
| 2 | `tsconfig.base.json` | paths 加 9 个 `@knevo/dsh-ar-*` | 源码模式 tsx 按 paths 解析裸包名 | 同上；发行态走 node_modules 解析，无需 paths |
| 3 | `.gitignore` | 忽略 `.dsh-home/` 运行态与凭据、`dist/`、`.fe-cache/` | `.credentials.yaml` 存 `AR_DEVICE_TOKEN`/`DEEPSEEK_API_KEY`，原 pattern `credentials*` **匹配不到前导点**，一次 `git add -A` 就会入库 | 保留 |

**上游 `packages/` 的源码一行未改。** 品牌与预设的适配都发生在**分发包安装之后**
（`knevo-brand.mjs` 就地改用户机器上装好的副本），不改本仓上游源码 —— 这样跟上游升级时
冲突面最小。代价是那些改动依赖锚点字符串，上游改版会让锚点失配（脚本会告警，构建期的品牌闸会失败）。

## 与上游的运行期差异（不是文件改动，但会影响行为）

- **压缩用上游自己的**：曾接过 AR 版（`ar-compact` + `assets-core`），2026-08-17 撤除 ——
  差量只有一段提示词且两边同源，而 dsh 那版更完整（重复压缩会合并旧 checkpoint、带 checkpoint 封装），
  我们覆盖 `summarize()` 反而把这些锚点弄丢了。
- **`ar-goals-judge` 已撤**：AR 侧的 `goals/judge.py` 本身已被删除（理由见其 `goals/tool.py`），
  我们迁的是个上游已废弃的机制；dsh 自带完整 goal 三件套 + `goal-round-driver`。
- **随包发 `@deepseek-ai/dsh-client-ui-file-tree`**：它是本 fork 独有、npm 上不存在（实测 404），
  所以装上游 dsh 的分发包里没有它。现由 `build-dist.mjs` 自己打包（含 esbuild 版 CSS Modules 处理）。

## Spike 期发现（已处理或已作废）

- skill-filesystem 默认根包含 `~/.agents/skills`，本机个人技能会混进目录 ——
  产品形态需要 `includeDefaultRoots: false` 的隔离 provider。**未做**，仍在待办。
- AR 技能正文引用的是 AR 的工具名（`shell` / `run_sandbox` / `read_file`），而设备端是 dsh 词汇
  （`bash` / `read` / `write`）。**产品决定：改我们自己的技能描述去对齐 dsh**，不做工具名对照层。
  下发范围也要从 `skills/general`（6 条）扩到含 `research`（23 条）。**未做**，在待办。
