/**
 * AR 接线③: 记忆注入。
 *
 * 监听 agent/pre-step(waterfall):await next() 拿默认 decision 后,用「当前 user 最新一条」
 * 作 query 拉 /memories/rank,把排序好的记忆作为一条 **user role** 消息追加到本回合上下文
 * (createUserMessage,role 恒 user —— AR 纪律:会话中段禁 system)。排序逻辑在服务端执行,
 * 设备只拉结果。云不可用/无记忆 → 原样放行(降级通则)。
 * @module @knevo/dsh-ar-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'ar-memory'
export const inject: string[] = ['tools']

export interface Config {
  /** 记忆排序端点,如 http://localhost:8000/api/agent/v1/memories/rank */
  endpoint: string
  /** 设备 token(Bearer) */
  token: string
}

export const Config: z<Config> = z.object({
  endpoint: z.string().required(),
  token: z.string().required(),
})

/** 从消息里取「当前 user 最新一条」的纯文本。 */
function lastUserText(messages: readonly UserMessage[]): string {
  const users = messages.filter((m) => m.source.kind === 'user')
  const last = users[users.length - 1]
  if (!last) return ''
  return last.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
}

/** 拉排序好的记忆,拼成注入文本。失败/空 → 空串(降级)。 */
async function rank(endpoint: string, token: string, query: string, signal: AbortSignal): Promise<string> {
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ query }),
      signal,
    })
    if (!resp.ok) return ''
    const data = (await resp.json()) as { memories?: { title?: string; content?: string }[] }
    const mems = data.memories || []
    if (mems.length === 0) return ''
    const lines = mems.map((m) => `- ${m.title ?? ''}: ${m.content ?? ''}`.trim())
    return `以下是与当前问题相关的长期记忆(供参考):\n${lines.join('\n')}`
  } catch {
    return ''
  }
}

export function apply(ctx: Context, config: Config): void {
  // research_memory_write:把研究发现记进云端记忆库(服务端真相),后续经 pre-step 注入回来。
  const writeEndpoint = config.endpoint.replace(/\/memories\/rank$/, '/memories/write')
  ctx.tools.register(defineTool({
    name: 'research_memory_write',
    description: '把一条重要的研究发现/结论记入长期记忆(云端),供后续会话检索注入。调研中得到值得记住的事实、关系、结论时用。带上支撑来源。',
    parameters: {
      title: { type: 'string', required: true, description: '发现的一句话标题。' },
      content: { type: 'string', description: '发现的详细内容。' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选标签(主题/实体)。' },
      sources: { type: 'array', items: { type: 'string' }, description: '可选:支撑该发现的来源 URL。' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string', required: true } },
      },
      render: (_args: any, value: any) => [{ type: 'text', text: `已记入长期记忆(${value.id})。` }],
    },
    async execute(args: any, exec: any) {
      const res = await fetch(writeEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
        body: JSON.stringify({
          title: args.title, content: args.content,
          tags: args.tags || [], sources: args.sources || [],
        }),
        signal: exec.signal,
      })
      if (!res.ok) throw new Error(`记忆写入失败: HTTP ${res.status}`)
      const data = (await res.json()) as { id?: string }
      if (!data.id) throw new Error('记忆写入返回无效')
      return { id: data.id }
    },
  }))

  // ★按「用户最新输入」去重:agent/pre-step 每个 step(每次 LLM 迭代)都会触发,
  //   一次长调研几十个 step —— 不去重就是每步一次 /memories/rank(服务端一次 lite LLM),
  //   纯浪费(同一轮里用户输入没变,排序结果也不会变)。同 query 只查一次。
  let lastAttemptedQuery = ''
  ctx.on('agent/pre-step', async ({ messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next() // waterfall:先委托拿默认 decision(已含装配的 context)
    if (decision.kind === 'reject' || signal.aborted) return decision
    const query = lastUserText(messages as readonly UserMessage[])
    if (query.length === 0 || query === lastAttemptedQuery) return decision
    lastAttemptedQuery = query   // 失败也标记:云端故障时不能每步重试放大
    const memory = await rank(config.endpoint, config.token, query, signal)
    signal.throwIfAborted()
    if (memory.length === 0) return decision
    const ctxMsg = createUserMessage({
      content: [{ type: 'text', text: memory }],
      source: { kind: 'plugin', plugin: name, form: 'recall' },
    })
    return { ...decision, messages: [...decision.messages, ctxMsg] }
  })
}
