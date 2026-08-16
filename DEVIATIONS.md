# DEVIATIONS — AR spike 对上游文件的改动台账

本副本（`ar_deepseek_harness`，分支 `feat/ar-research-full`，基于 fork 的 `feat/workspace-file-tree`）是 AR 功能迁移的源码 spike。每处**上游文件**改动记一行：文件、为什么、终态怎么收敛（对照工作区根 `../AR-DSH-STATUS.md` 与 `../AR-DSH-ARCHITECTURE-MAP.md`）。`ar/` 目录与 `.dsh-home/` 是新增区，不算 deviation。

| # | 文件 | 改了什么 | 为什么 | 终态收敛 |
|---|---|---|---|---|
| 1 | `pnpm-workspace.yaml` | packages 加 `ar/*` | @knevo 插件区进 workspace | 插件迁独立 `ar-agent/` 仓 + profile 机制，条目删除 |
| 2 | `tsconfig.base.json` | paths 加 `@knevo/dsh-ar-hello` | 源码模式 tsx 按 paths 解析裸包名 | 同上；发行态走 profile node_modules 解析，无需 paths |

运行副本约定：`DSH_HOME=D:\ar_dsh\ar_deepseek_harness\.dsh-home`；pnpm 用 `npx -y pnpm@11.7.0`；本地探测 `curl --noproxy '*'`；web 端口 3180（3080 被日常正本实例占用）。

## Spike 发现（回填设计用）

- skill-filesystem 默认根包含 `~/.agents/skills`（user-agents，rank 500）——本机个人技能（lark-* 等 30+ 个）混进了目录。**产品形态必须用 `includeDefaultRoots: false` 的隔离 provider**，只看 AR 下发的技能根。已回填至设计文档待办。
- AR 技能正文引用 AR 工具名（shell / run_sandbox / read_file / list_dir），dsh 侧是 bash / 文件工具——技能文迁移时需统一改写或做工具名对照层（M3 处理）。
