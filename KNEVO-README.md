# Knevo（AR × dsh 形态 D）— 初见者运行包

**产品形态**：dsh 在你自己机器上当执行内核（agent 循环、工具、本地文件/沙盒都在本地跑），
研究能力（联网搜索、抓取、子 agent 编排、评审、记忆）通过端点回连 Knevo 云端（dev.ar.knevo.ai）。
真实的模型/搜索/评审密钥只在云端，绝不下发；你的设备只持一枚受限设备 token（scope=agent-api）。

## 初见者三步

1. **注册**：浏览器打开 https://dev.ar.knevo.ai ，用邀请码注册一个账号（邮箱 + 密码 ≥8 位）。
2. **启动**：双击 `knevo.cmd`（Windows）。首次会提示登录 —— 输入刚注册的邮箱和密码。
   它会用你的账号换一枚**绑到你本人**的设备 token（存 `.dsh-home/.device-token`），之后不再问。
3. **用**：浏览器自动可访问的 dsh Web（http://127.0.0.1:3180）里发调研任务，例如：
   > 帮我调研「2024 年 X 领域的关键进展」，联网检索、抓关键来源正文、必要时分派子调查、
   > 把重要发现记入长期记忆、请独立模型审阅结论，最后给带真实引用的报告。

## 会发生什么（都经你的设备 dsh，工具背后的能力在云端）

| 你看到 | 背后 |
|---|---|
| 联网搜索出真实来源 | `web_search` → 云 `/search`（平台持 Tavily/火山 key + 计量） |
| 抓取网页正文 | `web_fetch` → **dsh 原生 web-fetch-http，在你本机/你的 IP 抓**（内网/登录态也能） |
| 子任务分工 | `sub_agent` → dsh 原生本地子会话（各自再调云端 LLM/搜索） |
| 记住研究发现 | `research_memory_write` → 云端记忆库（下次自动检索注入） |
| 独立评审 | `peer_review` → 云 `/llm/review`（跨模型，grok） |
| 生成配图 | `generate_image` → 云 `/images` |
| 用量与配额 | 每次调用按 user 计量（token/次/张），余额不足自动 402 拦下 |

## 计费

付费状态是云端真相：订阅/充值决定余额（云端 CreditLot 钱包），设备每次请求按余额放行或拒绝，
不下发付费态、不缓存。降级后下个会话自然按新配额走。

## 包内容 / 结构

- `knevo.cmd`：启动器（登录 → 注入 `AR_DEVICE_TOKEN` → `dsh --profile web`）
- `knevo-login.mjs`：账号口令换设备 token（复用云端 `/auth/token` 凭据端点）
- `.dsh-home/cordis.patch.yml`：AR profile 层（@knevo 插件接线 + dev 端点；**不含 token**，token 登录时才取）
- `ar/*`：@knevo 设备侧插件（web-search / peer-review / memory / image / telemetry / skills-remote / compact / goals-judge）
- dsh 本体：`@deepseek-ai/dsh`（上游，`npx pnpm dsh` 当 runtime；零 fork）

## 尚属生产工程（本包未含，设计⑥）

- 真正的**签名跨平台安装器**（携带 Node+pnpm、双击即用、目录级升级、Ed25519 验签）——
  当前包依赖机器已有 Node（`npx pnpm@11.7.0` 拉 dsh runtime）。
- 设备 token 存 **OS Keychain**（当前落 `.dsh-home/.device-token` 文件）+ OAuth device-code。
- @knevo 插件的**独立发行**（脱离本 monorepo 的 tsconfig 解析 → 真实版本 peerDeps + 打包）。
