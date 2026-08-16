/**
 * AR 接线④: 目标完成裁判。
 *
 * 监听 tools/pre-execute(waterfall):拦 update_goal(action='complete'),在 ctx.goals.complete
 * 真正执行前跑一道**跨模型独立裁判**(判断目标是否真达成)。裁判 FAIL → deny(完成不执行、
 * 无 goal/change 事件、目标保持未完成);PASS → next()放行;裁判不可用/超时 → fail-open 放行
 * (AR 语义:加固不是单点故障)。纯插件,零改 goal 包。
 *
 * spike:设备端用 ctx.llm 跑裁判(用与主 agent 不同的 model);真实形态裁判逻辑走服务端
 * gateway 裁判通道(不下发)。
 * @module @knevo/dsh-ar-goals-judge
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'

export const name = 'ar-goals-judge'
export const inject = ['goals', 'llm']

export interface Config {
  /** 裁判用的 provider/model(留空则用主 agent 的;真实形态该跨模型) */
  judgeProvider?: string
  judgeModel?: string
}

export const Config: z<Config> = z.object({
  judgeProvider: z.string().default(''),
  judgeModel: z.string().default(''),
})

async function runJudge(ctx: Context, config: Config, objective: string, exec: any): Promise<'PASS' | 'FAIL'> {
  const provider = config.judgeProvider || exec.agent.options?.provider
  const model = config.judgeModel || exec.agent.options?.model
  if (!provider || !model) return 'PASS' // 无裁判模型 → fail-open
  const assembler = new BlockAssembler()
  const messages = [
    createUserMessage({
      content: [{
        type: 'text',
        text: `目标：${objective}\n\n请判断这个目标是否真的已经达成。只回一个词：PASS(确实达成) 或 FAIL(未达成)。默认从严——不确定就 FAIL。`,
      }],
      source: { kind: 'plugin', plugin: name },
    }),
  ]
  const options: any = {
    provider, model, messages,
    maxTokens: 8,
    sessionId: exec.agent.session.id,
    purpose: 'other',
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  }
  for await (const chunk of (ctx as any).llm.stream(options)) assembler.push(chunk)
  const text = assembler.blocks().filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join('').toUpperCase()
  return text.includes('PASS') ? 'PASS' : 'FAIL'
}

export function apply(ctx: Context, config: Config): void {
  ctx.on('tools/pre-execute' as any, async (exec: any, next: any) => {
    if (exec.name !== 'update_goal') return next()
    const args = exec.arguments || {}
    if (args.action !== 'complete') return next()
    try {
      const goal = await (ctx as any).goals.get(exec.agent)
      const objective = goal?.objective ?? ''
      if (!objective) return next() // 无目标 → 放行
      const verdict = await runJudge(ctx, config, objective, exec)
      if (verdict === 'PASS') return next()
      return { kind: 'deny', reason: `完成裁判未通过：目标「${objective}」尚未确认达成，请补齐证据或继续推进。` }
    } catch {
      return next() // 裁判不可用 → fail-open
    }
  })
}
