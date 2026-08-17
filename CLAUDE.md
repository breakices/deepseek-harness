# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**上游 dsh 自身的规则在 [`AGENTS.md`](AGENTS.md)（仓库布局、命令、conventions、vendoring policy），仍然全部适用。**
本文件只讲 `AGENTS.md` 覆盖不到的那一层：**这个 checkout 不是普通的 dsh。**

## 这是什么

Knevo 客户端（形态 D）的**设备侧代码**。分支 `feat/ar-research-full`（基于 fork 的
`feat/workspace-file-tree`，推 `fork` 远端，**不推 `origin`**——那是上游 deepseek-ai）。

dsh 在用户机器上当执行内核；需要平台密钥或共享数据的能力（LLM、联网搜索、读图、跨模型评审、
长期记忆、技能库）经 `ar_backend` 的设备面网关 `https://dev.ar.knevo.ai/api/agent/v1/*` 回连云端。

- 新增区（不算对上游的改动）：`ar/`（@knevo 插件）、`.dsh-home/`（AR profile）、`build-dist.mjs`、`knevo-*.mjs`
- 对**上游文件**的改动记在 [`DEVIATIONS.md`](DEVIATIONS.md)
- 现状 / 决策 / 部署 / 已知坑的**唯一现役答案**在工作区根 `../AR-DSH-STATUS.md`；架构见 `../AR-DSH-ARCHITECTURE-MAP.md`

## 命令

```bash
npx -y pnpm@11.7.0 install          # corepack 的 pnpm 在 Node 24 下崩，一律用 npx 指定版本
pnpm run test                       # 上游测试；ar/ 下的插件没有单测，靠构建闸 + 真机启动兜底

node build-dist.mjs <version>       # 出分发包 dist/knevo-ar-<ver>.tgz + manifest（含 sha256）
node knevo-brand.mjs                # 装完依赖后就地改品牌/预设（启动器会自动调）
```

本地探测用 `curl --noproxy '*'`（系统代理会劫持对 localhost 的请求）。
跑本副本时 `DSH_HOME=<repo>/.dsh-home`，web 端口用 3180（3080 留给日常正本实例）。

### 发版前必须真装真起

**不要只看产物形状**——2026-08-17 一天之内连栽两次，都是「产物看着对、一执行就炸」，
且都由用户先撞到。正确流程：

```bash
# 1) 装到 monorepo **外面**（在里面装，pnpm 会把它当 workspace 成员而 no-op）
mkdir /tmp/t && cp dist/knevo-ar-<ver>.tgz /tmp/t/ && cd /tmp/t && tar -xzf *.tgz
cd knevo-ar-<ver> && npx -y pnpm@11.7.0 install && node knevo-brand.mjs
# 2) 真启动
AR_DEVICE_TOKEN=<token> DSH_HOME=$PWD/.dsh-home ./node_modules/.bin/dsh web --port 3181
# 3) 真浏览器验（curl 到 200 不算数：上一版 client.js 也是 200，是执行时才炸的）
```
UI 相关改动用 playwright 打开页面看 console error + 截图。注意 dsh 的 UI 有常驻 WebSocket，
**不能等 `networkidle`**，用 `domcontentloaded` + 显式等待。

## 架构：四层叠加，以及「什么放哪一层」

组成按顺序叠加，**后写覆盖同 id 的行**（`apps/cli/src/profile-boot.ts`）：

1. profile root（`.dsh-home/profiles/web/cordis.yml`，空）
2. **bundle 层**：`@deepseek-ai/dsh-base` + `dsh-web-app`。
   ★ web-app bundle **把整个 agent 面 disable 掉**（tool-bash/fs/skill/goal/todo/web、compaction、
   subagent 全部 `disabled: true`），改由 preset 层提供 —— 所以「用户能用哪些工具」几乎全看 preset。
3. **host 用户层** = `.dsh-home/cordis.patch.yml` ← 我们的接线都在这
4. profile patch（空）

判断一个东西该放哪一层：

| 放哪 | 什么东西 | 后果 |
|---|---|---|
| **host 层** | 全部 9 个 @knevo 插件、模型路由、沙盒/审批、持久化、遥测 | 进程级、跨会话、**与 preset 无关** → 所有模式都能用 |
| **preset 层** | **人格**、`tool-web.fetch`、agent 的工具组成 | preset **遮蔽** host 层同名设置 |

**踩过的坑**：在 host 层写 `system-prompt.persona` 只对不走 roster 的入口（headless）生效，
走 preset 的会话拿的是 preset 那份。同理 `compaction` —— preset 自己在 isolate 组里挂了一份
`compaction-basic`，host 层换引擎是无效的。

### 预设：为什么要在装完之后改文件

内置预设装在 **dsh 包自己的 `config/agent-presets/`**，CLI 按自身路径解析成 `system` 信任的
shipped root；而 `discoverPresets` 是**先者胜**、用户根（`$DSH_HOME/.agent-presets`）**最后**追加 ——
所以放用户根里的同名预设**盖不过**内置的，`profile-boot` 还会在 patch 之后强行覆盖 `roots`。

结论：要改内置模式只能改文件 → `knevo-brand.mjs` 在装完后就地把 `standard`/`code`/`minimal`
换成 Knevo 人格 + 打开 `web_fetch`，并删掉 `cordis`（它能让 agent 读写自己运行的 runtime）。
**组成只动这两处，其余一行不改**；模式名保持上游的（那是执行策略词汇，不是品牌）。

### 客户端 UI 插件是运行期下发的

node 侧 `ClientModuleRegistry` 扫 Loader entry 的 `package.json`，命中 `dsh.client.platform==='web'`
就把 `exports['./client']` 挂到 `/plugins/<包名>/client.js`，清单注进 `index.html` 的
`window.__DSH_BOOT__`，浏览器再逐个 `<script>` 拉。

**所以自托管的前端壳不参与组装**——加一个 UI 插件不需要重打包前端。
但 boot 的 `assertEntriesActive` 只要有一个 entry 没 ACTIVE 就**整个 UI 停在 loading 页**，
不是「这个面板没了」。

## 分发管线（build-dist.mjs）

- 每个 `ar/*` 插件 esbuild 成自包含 ESM（external `@deepseek-ai/*` 与 `node:*`）
- 带浏览器半边的插件（`UI_PLUGINS`）多打一份 CJS，banner/footer 必须逐字复刻上游
  `packages/client/tsdown.client.ts` 的 `__ModuleLoader__.load({id, factory})` 契约
- 前端壳 vendor 下来改品牌（标题 / PWA / 图标 / wordmark / hero 图形），品牌闸四项全过才放行
- 三道闸：**泄密闸**（产物含明文 token 即失败）、**品牌闸**、**浏览器半边冒烟闸**（用最小宿主
  真的执行一遍 factory，拿不到 `apply`/`inject` 就失败）

## 这些坑很贵，别重踩

1. **插件模块不能有 `export default`** —— cordis 见到 default 就把那个函数当插件，
   模块级 `export const inject` 被整个忽略 → 运行期 `cannot get property "x" without inject`，整棵树 boot 失败。
2. **浏览器半边的 banner 必须带 `var module = { exports: {} }; var exports = module.exports;`** ——
   esbuild 的 CJS 产物只是**使用** module/exports，不声明；少了它浏览器报 `module is not defined`。
3. **`inject` 只能是数组或「服务名 → 配置」映射**，这版 cordis **没有可选注入**；
   写 `{required:[...], optional:[...]}` 会被当成两个叫 required/optional 的服务去等，永远 pending。
4. **改 `node_modules/.pnpm/` 下的文件必须先 unlink 再写** —— pnpm 默认从全局 store 硬链接
   （实测某文件链接数 11），直接写会穿透改到 store，污染用户机器上**别的项目**。
5. **`knevo.cmd` 必须纯 ASCII** —— cmd.exe 按 OEM 代码页逐字节读，UTF-8 中文尾字节会吃掉后面的
   引号/括号；块内 echo 里的半角 `)` 也会提前闭合 `if`。中文提示交给 node 脚本。
6. **放行依赖构建脚本的键是 pnpm-workspace.yaml 的 `allowBuilds`**（`onlyBuiltDependencies` 实测无效）；
   不放行 node-pty 会让 **Linux 直接起不来**。
7. **Node 要求 `^22.19 || >=24`**（`node:zlib` 的 zstd），启动器有版本闸。
8. **Windows 上 `tar -C <含盘符路径>` 会把 `D:` 当远程主机** —— 拷进目标目录用相对路径解。
9. **新增 @knevo 插件要加 `tsconfig.base.json` 的 paths**（源码模式经 paths 解析）；
   `--dump-config` 不 import 模块，漏了要真 boot 才炸。
10. **行内 config 覆写不是 merge** —— `agent-default-model` 只给 `model` 会 ValidationError。
11. **locale 不能覆盖** —— `register()` 遇同名空间直接抛错，改 UI 文案只能改包内文件。
12. **monorepo 内跑 headless 会被仓库自带 `AGENTS.md` 污染**（agent-instructions 注入）；测人格要用干净包。

## 提交与推送

`git push fork <branch> --no-verify`（lefthook 的 pre-push 跑全仓 typecheck）。
远端 Actions 用 commit message 里的 `[skip ci]` 跳过——`--no-verify` 只管本地钩子。
公开产出不留 AI 署名。
