# Knevo（AR × dsh 形态 D）— 客户端运行包

**产品形态**：dsh 在你自己机器上当执行内核（agent 循环、工具、本地文件/沙盒都在本地跑），
研究能力（联网搜索、独立评审、长期记忆、技能）通过端点回连 Knevo 云端（dev.ar.knevo.ai）。
真实的模型/搜索/评审密钥只在云端，绝不下发；你的设备只持一枚受限设备 token（scope=agent-api）。

## 前置

- **Node.js `22.19+` 或 `24+`**(`node -v` 确认)。低于此版本 dsh 起不来(缺 `node:zlib`
  的 zstd 支持);启动器会先检查并给出明确提示,不会让你撞见看不懂的报错。
- 平台支持:

  | 平台 | 状态 | 说明 |
  |---|---|---|
  | Windows x64 | ✅ 实测通过 | 原生组件走随包预编译,无需编译器 |
  | Linux x64 | ✅ 实测通过 | node-pty 无 linux 预编译,**需 `python3` + `make` + `g++`**(Debian/Ubuntu:`apt install -y build-essential python3`),首装现场编译一次 |
  | macOS (arm64/x64) | ⚠️ 未实测 | 随包带 darwin 预编译,无需编译器;理论可用,未在真机验证 |

- 一个 Knevo 账号（在 https://dev.ar.knevo.ai 用邀请码注册），且**账号里有积分**
  （内测期由管理员发放；没有积分时云端能力会返回 402）。

## 三步开始

1. **注册**：浏览器打开 https://dev.ar.knevo.ai ，用邀请码注册（邮箱 + 密码 ≥8 位）。
2. **启动**：Windows 双击 `knevo.cmd`；macOS/Linux 跑 `bash knevo.sh`。
   - 首次会自动装依赖（pnpm，几分钟）→ 提示登录（输入上面注册的邮箱/密码，
     换一枚**绑定你本人**的设备 token，存 `.dsh-home/.device-token`，30 天有效，
     过期启动时会自动要求重新登录）。
3. **用**：等它起来（首次约 1–3 分钟），浏览器打开 **http://127.0.0.1:3180** 发调研任务，例如：
   > 深入调研「2025 年 X 领域的关键进展」：联网检索，抓取关键来源正文，
   > 把重要发现记入长期记忆，请独立模型审阅结论，最后给出带真实引用链接的报告。

## 会发生什么（工具在你的设备上执行，背后的能力在云端）

| 你看到 | 背后 |
|---|---|
| 联网搜索出真实来源 | `web_search` → 云 `/search`（平台持搜索 key + 计量） |
| 抓取网页正文 | `web_fetch` → **在你本机/你的 IP 抓**（内网、登录态页面也能） |
| 子任务分工 | `sub_agent` → dsh 原生本地子会话（各自再调云端 LLM/搜索） |
| 记住研究发现 | `research_memory_write` → 云端记忆库（后续会话自动检索注入） |
| 独立评审 | `peer_review` → 云 `/llm/review`（跨模型 grok，独立找茬） |
| 生成配图 | `generate_image` → 云 `/images` |
| 主模型 | deepseek-v4-pro（与 Knevo 网页版一致） |

## 计费

按量计：搜索按次、生图按张、LLM（含评审）按 token。付费状态是云端真相 ——
每次请求按你账号的余额放行或拒绝（余额不足 → 402「积分不足」）。余额与充值请到网页端查看。

## 更新

```
node knevo-update.mjs        # 查云端最新版本 → 下载 → sha256 校验 → 解包
```

## 目录说明

- `knevo.cmd` / `knevo.sh`：启动器（装依赖 → 登录/校验 token → 起 dsh Web:3180）
- `knevo-login.mjs`：账号口令换设备 token（`--check` 校验现有 token 是否有效）
- `plugins/`：Knevo 设备侧插件（已编译，esbuild 自包含）
- `.dsh-home/`：dsh 配置层（AR profile 接线；运行后会多出会话/缓存等本地数据）
- dsh 本体：`@deepseek-ai/dsh`（上游 npm 包，装依赖时自动拉取，零 fork）

## 已知边界（内测）

- 设备 token 落在 `.dsh-home/.device-token` 文件（生产形态会换 OS Keychain）；
  换机/怀疑泄露时可在服务端吊销（凭账号密码调 `/api/agent/v1/auth/revoke`）。
- 工件校验目前是 manifest sha256（生产形态会加 Ed25519 签名验签）。
- 首次启动慢（装依赖 + 首次 boot）；之后启动明显变快。
