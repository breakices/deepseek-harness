/**
 * AR 接线③: 技能远程 provider。
 *
 * 注册进 ctx.skills(registerProvider),list()/get() 从 agent_gateway 的技能服务拉取,
 * 不读本地文件。技能库(skill_gate 按用户过滤 + 内容寻址版本)是服务端真相;设备会话
 * 开始拉目录钉版本、按需取正文、会话内读穿缓存。
 *
 * catalog 端点约定(gateway):
 *   GET  {base}/skills/catalog        → { skills: [{name, description, whenToUse?,
 *                                          modelInvocable, userInvocable, version, locator}] }
 *   GET  {base}/skills/{name}?v={ver} → { name, description, content, whenToUse?,
 *                                          modelInvocable, userInvocable }
 * @module @knevo/dsh-ar-skills-remote
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
} from '@deepseek-ai/dsh-skill'

export const name = 'ar-skills-remote'
export const inject = ['skills']

const AR_SKILL_RANK = 550 // 低者胜重名;远程档,略高于 filesystem 若共存

export interface Config {
  /** 技能服务基址,如 http://localhost:8000/api/agent/v1 */
  baseUrl: string
  /** 设备 token(Bearer) */
  token: string
  /** provider 名(默认 ar-remote) */
  providerName?: string
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().required(),
  token: z.string().required(),
  providerName: z.string().default('ar-remote'),
})

class RemoteSkillProvider implements SkillProvider {
  readonly name: string
  private readonly base: string
  private readonly token: string

  constructor(config: Config, _control: SkillProviderControl) {
    this.name = config.providerName || 'ar-remote'
    this.base = config.baseUrl.replace(/\/$/, '')
    this.token = config.token
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` }
  }

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | { candidates: readonly SkillCandidate[]; complete: boolean }> {
    try {
      const resp = await fetch(`${this.base}/skills/catalog`, { headers: this.headers(), signal: options.signal })
      if (!resp.ok) return { candidates: [], complete: false } // 半失败:保留 last-good
      const data = (await resp.json()) as { skills?: any[] }
      const candidates: SkillCandidate[] = (data.skills || []).map((s) => ({
        name: s.name,
        description: s.description,
        whenToUse: typeof s.whenToUse === 'string' ? s.whenToUse : undefined,
        invocation: { modelInvocable: s.modelInvocable !== false, userInvocable: s.userInvocable !== false },
        source: 'ar-remote',
        provider: this.name,
        resourceBase: AR_RESOURCE_BASE,
        rank: AR_SKILL_RANK,
        locator: { name: s.name, version: s.version ?? null },
      }))
      return candidates
    } catch {
      return { candidates: [], complete: false }
    }
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const loc = candidate.locator as { name: string; version: string | null } | undefined
    const nm = loc?.name ?? candidate.name
    const v = loc?.version ? `?v=${encodeURIComponent(loc.version)}` : ''
    try {
      const resp = await fetch(`${this.base}/skills/${encodeURIComponent(nm)}${v}`, { headers: this.headers(), signal: options.signal })
      if (!resp.ok) return undefined
      const s = (await resp.json()) as any
      return {
        name: s.name,
        description: s.description,
        whenToUse: typeof s.whenToUse === 'string' ? s.whenToUse : undefined,
        invocation: { modelInvocable: s.modelInvocable !== false, userInvocable: s.userInvocable !== false },
        source: 'ar-remote',
        provider: this.name,
        resourceBase: AR_RESOURCE_BASE,
        content: s.content ?? '',
      }
    } catch {
      return undefined
    }
  }
}

/**
 * 技能资源基址。**刻意不给 URL**：给 url 会让 renderSkillContent 把「按此 base 解析
 * 相对链接」写进提示，模型可能真的用 web_fetch 去抓那个端点 —— 而 web_fetch 走的是
 * 设备本机 provider，不带设备 token，只会拿到 401，白烧一轮工具调用。
 * 技能正文由网关就地展开，设备侧本就不需要能解析的资源基址。
 */
const AR_RESOURCE_BASE = {
  kind: 'opaque' as const,
  description: '技能资源由 Knevo 云端提供，无需自行抓取。',
}

export function apply(ctx: Context, config: Config): void {
  ctx.skills.registerProvider((control) => new RemoteSkillProvider(config, control))
}
