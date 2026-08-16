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
export const inject = ['tools', 'fs']

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
        },
      },
      render: (_args: any, value: any) => [{
        type: 'text',
        text: `已生成图片:${value.path}(${value.bytes} 字节)。可在右侧文件区打开预览。`,
      }],
    },
    async execute(args: any, exec: any) {
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ prompt: args.prompt }),
        signal: exec.signal,
      })
      if (!res.ok) throw new Error(`生图端点失败: HTTP ${res.status}`)
      const data = (await res.json()) as { ok?: boolean; b64?: string }
      if (!data.ok || !data.b64) throw new Error('生图端点返回无效')
      const bytes = Buffer.from(data.b64, 'base64')

      const relPath = args.file_path || `generated/image-${Date.now()}.png`
      const cwd = exec.agent?.session?.header?.cwd
      const target = await (ctx as any).fs.resolve(relPath, { cwd, signal: exec.signal })
      const abs = (ctx as any).fs.processPath(target)
      await mkdir(dirname(abs), { recursive: true }).catch(() => {})
      await writeFile(abs, bytes, { signal: exec.signal })
      return { path: target.displayPath, bytes: bytes.byteLength }
    },
  }))
}
