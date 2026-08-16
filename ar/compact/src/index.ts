/**
 * AR 接线④: compaction provider。
 *
 * extends BasicCompactionEngine，只覆盖唯一定制钩子 summarize() —— 把 dsh 默认压缩指令
 * 换成 AR 九节交接摘要提示词(@knevo/dsh-ar-assets)。阈值判断、选区间、落 replacement、
 * 自动触发(agent/pre-step pressure + context-overflow)全部继承基类。
 *
 * 一个 context 只能挂一个 ctx.compaction(单例)——profile patch 里 disable 默认
 * compaction-basic 行、insert 本 provider。
 * @module @knevo/dsh-ar-compact
 */

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import { AR_COMPACT_INSTRUCTION } from '@knevo/dsh-ar-assets'

export class ArCompactionEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']
  static Config = BasicCompactionEngine.Config

  /** 唯一定制钩子:照 summarizeWithLlm 的机制,但把追加的压缩指令换成 AR 九节提示词。 */
  protected override async summarize(input: any, agent: any, signal?: AbortSignal): Promise<any> {
    const cfg: any = this.config
    const latest = agent.session.requestHeader()?.config
    const configured = cfg.summarizationProvider && cfg.summarizationProvider.length > 0
      ? { provider: cfg.summarizationProvider, model: cfg.summarizationModel }
      : undefined
    const agentTarget = agent.options?.provider?.length > 0 && agent.options?.model?.length > 0
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined
    const target = configured ?? latest ?? agentTarget
    if (target === undefined) {
      throw new Error('ar-compact: no provider/model available for summarization')
    }

    const assembler = new BlockAssembler()
    const messages = [
      ...input.messages,
      createUserMessage({
        content: [{ type: 'text', text: AR_COMPACT_INSTRUCTION }],
        source: { kind: 'plugin', plugin: 'ar-compact' },
      }),
    ]
    const options: any = {
      provider: target.provider,
      model: target.model,
      messages,
      ...(input.system === undefined ? {} : { system: input.system }),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens: cfg.maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal }),
    }
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)

    const rawOutput = assembler.blocks()
    const summary = rawOutput.filter((b: any) => b.type === 'text')
    if (!summary.some((b: any) => (b.text ?? '').trim().length > 0)) {
      throw new Error('ar-compact: summarization produced no text summary')
    }
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: target.provider,
      model: target.model,
      maxTokens: cfg.maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    }
  }
}

export default ArCompactionEngine
