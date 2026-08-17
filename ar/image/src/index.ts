/**
 * AR 生图工具(目标场景:新用户完整跑一次生图)。
 *
 * 注册模型可调用工具 generate_image:模型给 prompt → 调 agent_gateway 的 /images
 * (真实 IMAGE_GEN key 只在服务端)→ 拿 base64 PNG → 写进当前会话工作区 → 返回路径。
 * 图靠工作区文件区预览显示(我们给 dsh 贡献的 ui-file-tree 支持图片预览)。
 *
 * ctx.fs 无二进制写 → PNG 用 fs.resolve 拿绝对路径后 node writeFile(本地后端可行)。
 * @module @knevo/dsh-ar-image
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'

export const name = 'ar-image'
// ★inject 只能是**数组**或「服务名 → 配置」映射(vendor/cordis/src/registry.ts:296)。
//   这版 cordis **没有可选注入**:写成 {required:[...], optional:[...]} 会被当成两个
//   分别叫 required / optional 的服务去等,插件永远 pending、整棵树 boot 失败
//   (2026-08-17 实测)。attachments 由 base bundle 提供(与本插件同在 host 层),
//   声明成必需是安全的 —— 有它才能把生成的图内联渲染进对话。
export const inject = ['tools', 'fs', 'attachments']

export interface Config {
  /** 生图端点,如 http://localhost:8000/api/agent/v1/images */
  endpoint: string
  /** 设备 token(Bearer) */
  token: string
}

export const Config: z<Config> = z.object({
  endpoint: z.string().required(),
  token: z.string().required(),
})

/** 把网关结构化错误翻成人话(402 配额闸/401 登录失效/429 限速)。 */
async function describeError(res: Response, what: string): Promise<string> {
  let detail: any
  try {
    const body = (await res.json()) as any
    // 网关现在按 OpenAI 线格式回 `error`(dsh 主通道 adapter 只认这个键),
    // 同时保留 `detail` 兼容存量客户端。两个都读,谁在用谁。
    detail = body?.error ?? body?.detail
  } catch {
    /* 非 JSON */
  }
  const msg = typeof detail === 'string' ? detail : detail?.message
  if (res.status === 402) {
    const bal = detail?.balance
    return `${what}失败:${msg || '积分不足,请充值后继续'}${typeof bal === 'number' ? `(当前余额 ${bal})` : ''}`
  }
  if (res.status === 429) return `${what}失败:${msg || '请求过于频繁,请稍后再试'}`
  if (res.status === 401 || res.status === 403) return `${what}失败:设备登录已失效,请重新运行启动器登录。`
  return `${what}失败:HTTP ${res.status}${msg ? ` — ${msg}` : ''}`
}

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: '根据文字描述生成一张 PNG 图片,保存到当前工作区并返回路径。用户要画图/生成图片时用。',
    parameters: {
      prompt: { type: 'string', required: true, description: '要画的内容(英文效果更好)。' },
      file_path: { type: 'string', description: '可选:工作区相对输出路径(默认 generated/image-<时间>.png)。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          // 存进 attachments 后的引用;有它才能在对话里**内联渲染**出这张图。
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      // ★★ 绝对不要在这里回 `{type:'image'}` 块 ★★
      //
      // 我试过（0.4.x）：回 image 块确实能让图内联显示在对话里，但**它会进会话历史**，
      // 而历史在下一轮要序列化给 DeepSeek —— `llm-deepseek/src/serialize.ts:66` 的
      // `assertTextOnly` 见到 image 块直接抛 `UNSUPPORTED_CONTENT`。
      // 后果不是"这次失败"，而是**整个会话从此报废**：此后每一轮都在序列化同一段历史时炸，
      // 用户只能新开会话（2026-08-17 实测，用户会话被我这个改动搞死）。
      //
      // dsh 自己的 read_image 能回 image 块，是因为它有一道能力闸：模型不声明
      // inputModalities 含 image 就直接拒绝调用。我们的主模型是纯文本的，没有这个前提。
      //
      // 看图的正路有两条：右侧**工作区文件树**点开预览（0.6.0 起随包发），
      // 模型要"看懂"内容则用 `describe_image`（走云端 vision provider 转文字）。
      render: (_args: any, value: any) => [{
        type: 'text',
        text: `已生成图片:${value.path}(${value.bytes} 字节)。可在右侧文件区打开预览;`
          + `需要确认画面内容请用 describe_image(直接 read_file 读图会被拒)。`,
      }],
    },
    async execute(args: any, exec: any) {
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ prompt: args.prompt }),
        signal: exec.signal,
      })
      if (!res.ok) throw new Error(await describeError(res, '生成图片'))
      const data = (await res.json()) as { ok?: boolean; b64?: string }
      if (!data.ok || !data.b64) throw new Error('生图端点返回无效')
      const bytes = Buffer.from(data.b64, 'base64')

      const relPath = args.file_path || `generated/image-${Date.now()}.png`
      const cwd = exec.agent?.session?.header?.cwd
      const target = await (ctx as any).fs.resolve(relPath, { cwd, signal: exec.signal })
      const abs = (ctx as any).fs.processPath(target)
      await mkdir(dirname(abs), { recursive: true }).catch(() => {})
      await writeFile(abs, bytes, { signal: exec.signal })

      // 同时存一份进 attachments,拿到引用后就能在对话里内联渲染。
      // 失败不算生图失败 —— 文件已经写好了,退回"只给路径"就是原来的行为。
      let image: unknown
      try {
        const store = (ctx as any).attachments
        if (store !== undefined) {
          image = await store.saveImage({
            data: bytes, mediaType: 'image/png', name: relPath.split('/').pop(),
          })
        }
      } catch { /* 超出附件尺寸限制等 —— 降级成纯文本结果 */ }
      return { path: target.displayPath, bytes: bytes.byteLength,
               ...(image === undefined ? {} : { image }) }
    },
  }))
}
