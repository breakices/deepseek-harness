/**
 * AR 读图工具 `describe_image`。
 *
 * **为什么需要它**：主模型看不了图。dsh 的 DeepSeek adapter 把整个 provider 声明成
 * `inputModalities: ['text']`（packages/llm/llm-deepseek/src/adapter.ts:113），所以
 * `read_file` 读 PNG 会被硬拒：
 *   `cannot read "...png" as an image: model "deepseek-v4-pro" does not declare image input`
 * 这个判断是**对的** —— DeepSeek 本来就不收图。AR 后端一直是用一条独立旁路解决的：
 * 图 → 独立 vision provider（IMAGE_* 三元组）→ caption 文本 → 回灌主循环。
 * 形态 D 之前漏迁了这条，于是 `generate_image` 画出来的图，agent 自己看不了。
 *
 * 本插件把那条旁路补上：读工作区里的图 → 发到网关 /vision → 拿回文字描述。
 * 图片字节只上传给我们的平台（平台持 vision key），不落第三方。
 *
 * @module @knevo/dsh-ar-vision
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'

export const name = 'ar-vision'
export const inject = ['tools', 'fs']

export interface Config {
  /** 读图端点，如 https://dev.ar.knevo.ai/api/agent/v1/vision */
  endpoint: string
  /** 设备 token（Bearer） */
  token: string
}

export const Config: z<Config> = z.object({
  endpoint: z.string().required(),
  token: z.string().required(),
})

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
}

/** 把网关结构化错误翻成人话（402 配额闸 / 401 登录失效 / 429 限速 / 503 未配置）。 */
async function describeError(res: Response, what: string): Promise<string> {
  let detail: any
  try {
    const body = (await res.json()) as any
    detail = body?.error ?? body?.detail
  } catch { /* 非 JSON */ }
  const msg = typeof detail === 'string' ? detail : detail?.message
  if (res.status === 402) {
    const bal = detail?.balance
    return `${what}失败：${msg || '积分不足，请充值后继续'}${typeof bal === 'number' ? `（当前余额 ${bal}）` : ''}`
  }
  if (res.status === 429) return `${what}失败：${msg || '请求过于频繁，请稍后再试'}`
  if (res.status === 401 || res.status === 403) return `${what}失败：设备登录已失效，请重新运行启动器登录。`
  if (res.status === 503) return `${what}失败：${msg || '读图能力当前未启用。'}`
  return `${what}失败：HTTP ${res.status}${msg ? ` — ${msg}` : ''}`
}

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'describe_image',
    description:
      '看懂一张图片：读取工作区里的图片文件并返回文字描述。'
      + '主模型不能直接读图（read_file 读图会被拒），要看图内容一律用这个工具。'
      + '可用 question 指定要看什么（例如「图里的坐标轴标的是什么」）。',
    parameters: {
      file_path: { type: 'string', required: true, description: '工作区相对路径，如 figures/overview.png。' },
      question: { type: 'string', description: '可选：想从图里知道什么。不给就返回通用描述。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          caption: { type: 'string', required: true },
        },
      },
      render: (_args: any, value: any) => [{
        type: 'text',
        text: `图片 ${value.path} 的内容：\n${value.caption}`,
      }],
    },
    async execute(args: any, exec: any) {
      const rel = String(args.file_path || '')
      const ext = extname(rel).toLowerCase()
      const mime = MIME[ext]
      if (mime === undefined) {
        throw new Error(`不支持的图片格式：${ext || '(无扩展名)'}。支持 png/jpg/webp/gif/bmp。`)
      }
      const cwd = exec.agent?.session?.header?.cwd
      const target = await (ctx as any).fs.resolve(rel, { cwd, signal: exec.signal })
      const abs = (ctx as any).fs.processPath(target)
      let bytes: Buffer
      try {
        bytes = await readFile(abs)
      } catch (e) {
        throw new Error(`读不到图片 ${rel}：${e instanceof Error ? e.message : String(e)}`)
      }
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
        body: JSON.stringify({
          b64: bytes.toString('base64'),
          mime,
          ...(typeof args.question === 'string' && args.question.length > 0 ? { prompt: args.question } : {}),
        }),
        signal: exec.signal,
      })
      if (!res.ok) throw new Error(await describeError(res, '读图'))
      const data = (await res.json()) as { ok?: boolean; caption?: string }
      if (data.ok !== true || typeof data.caption !== 'string') throw new Error('读图端点返回无效')
      return { path: target.displayPath, caption: data.caption }
    },
  }))
}
