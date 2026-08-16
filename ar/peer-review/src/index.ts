/**
 * AR 接线: peer_review 工具。
 *
 * 形态:**统一 /llm 接口 + 拼上下文**(用户裁决 A)。不做独立 /review 端点——
 * 把「审阅指令(system)+ 待审材料(user)」拼成 messages,POST 到网关的
 * `/llm/review/chat/completions`。网关的 review channel 复用 openrouter/gemini 上游
 * (平台持 grok/gemini key),于是这是一次**跨模型独立评审**(审的模型≠主循环的 deepseek)。
 *
 * 计量:走 /llm,网关按 op=turn 计(review 的 token 成本,cost.py 有 grok 费率)。
 * @module @knevo/dsh-ar-peer-review
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'ar-peer-review'
export const inject = ['tools']

export interface Config {
  /** review channel 的 chat/completions 端点,如 https://dev.ar.knevo.ai/api/agent/v1/llm/review/chat/completions */
  endpoint: string
  /** 设备 token(Bearer) */
  token: string
  /** 评审模型 id(非密,平台持 key)。默认 x-ai/grok-4.5。 */
  model?: string
  /** 评审输出上限 tokens。 */
  maxTokens?: number
}

export const Config: z<Config> = z.object({
  endpoint: z.string().required(),
  token: z.string().required(),
  model: z.string().default('x-ai/grok-4.5'),
  maxTokens: z.number().default(4096),
})

/** 独立审稿人契约(venue-agnostic)。刻意让审的模型带着怀疑、只认证据、点破薄弱处。 */
const REVIEWER_SYSTEM = [
  '你是一位独立、严格、只认证据的同行评审专家。你在审阅另一个 AI 智能体产出的研究材料。',
  '你的职责不是附和,而是**找问题**:',
  '- 事实与引用:有无未经来源支撑的断言?引用是否真实、是否支撑该论点?有无过时/被撤稿的来源?',
  '- 逻辑与推理:论证链条是否有跳步、以偏概全、因果混淆、幸存者偏差?',
  '- 完整性:是否遗漏了对立证据、关键反例、重要的相关工作或数据?',
  '- 结论强度:结论是否超出了证据能支撑的范围?不确定性是否被诚实标注?',
  '给出**可执行**的批判:逐条指出问题、定位到具体位置、说明为何是问题、给出改进方向。',
  '若材料在某方面确实扎实,简短肯定即可,不要凑数。默认从怀疑出发。',
].join('\n')

/** 把网关结构化错误翻成人话(402 配额闸/401 登录失效/429 限速)。见 web-search 同名注释。 */
async function describeError(res: Response, what: string): Promise<string> {
  let detail: any
  try {
    detail = ((await res.json()) as any)?.detail
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
    name: 'peer_review',
    description: '请一个独立的评审模型(跨模型)严格审阅一段研究材料/结论/报告,挑出事实、引用、逻辑、完整性、结论强度上的问题。做完一稿研究、下重要结论前用它自检。',
    parameters: {
      material: { type: 'string', required: true, description: '要被审阅的完整材料(报告/结论/论证,含其引用)。' },
      focus: { type: 'string', description: '可选:希望评审重点关注的方面。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          review: { type: 'string', required: true },
          model: { type: 'string' },
        },
      },
      render: (_args: any, value: any) => [{
        type: 'text',
        text: `独立评审(${value.model || 'reviewer'})意见:\n\n${value.review}`,
      }],
    },
    async execute(args: any, exec: any) {
      const userContent = args.focus
        ? `【评审重点】${args.focus}\n\n【待审材料】\n${args.material}`
        : args.material
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens,
          stream: false,
          messages: [
            { role: 'system', content: REVIEWER_SYSTEM },
            { role: 'user', content: userContent },
          ],
        }),
        signal: exec.signal,
      })
      if (!res.ok) throw new Error(await describeError(res, '独立评审'))
      // 网关透传上游字节;上游可能夹 keep-alive 空行/注释。从首个 '{' 起截出 JSON 再解析,
      // 不依赖 res.json()(前导杂行会让它失败)。
      const raw = await res.text()
      const start = raw.indexOf('{')
      if (start < 0) throw new Error('评审返回非 JSON')
      const data = JSON.parse(raw.slice(start)) as { choices?: Array<{ message?: { content?: string } }>; model?: string }
      const review = data.choices?.[0]?.message?.content?.trim()
      if (!review) throw new Error('评审返回为空')
      return { review, model: data.model || config.model }
    },
  }))
}
