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

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
} from '@deepseek-ai/dsh-skill'

export const name = 'ar-skills-remote'
export const inject = ['skills', 'tools', 'fs']

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

  const base = config.baseUrl.replace(/\/$/, '')
  const headers = { authorization: `Bearer ${config.token}` }

  // 技能带的子资源。**两类待遇不同,判据是「谁消费它」**:
  //   • 脚本(.py/.sh/...)—— 消费者是本机解释器,网关回原文,这里写进工作区让模型 bash 跑;
  //   • 知识(.md 规范/清单)—— 消费者是模型,网关只回占位符,由网关转发前注入,不落设备。
  // 所以同一个工具,拿到 script 就落盘、拿到 knowledge 就把占位符当文本回给模型。
  ctx.tools.register(defineTool({
    name: 'fetch_skill_file',
    description:
      '取技能自带的资源文件。技能正文里让你「运行 xxx.py」或「按 xxx.md 的规范」时用。'
      + '脚本会被写进工作区并返回路径(直接用 bash 运行它,不要自己重写);'
      + '规范类文件会直接返回内容。先用 list=true 看这个技能带了哪些文件。',
    parameters: {
      skill: { type: 'string', required: true, description: '技能名(与 skill 工具里的一致)。' },
      path: { type: 'string', description: '资源相对路径,如 reference/run_self_audit.py。list=true 时不用给。' },
      list: { type: 'boolean', description: '只列清单,不取内容。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skill: { type: 'string', required: true },
          listing: { type: 'string' },
          path: { type: 'string' },
          kind: { type: 'string' },
          saved_to: { type: 'string' },
          content: { type: 'string' },
        },
      },
      render: (_a: any, v: any) => [{
        type: 'text',
        text: v.listing !== undefined
          ? `技能 ${v.skill} 的资源文件:
${v.listing}`
          : v.saved_to !== undefined
            ? `已保存到 ${v.saved_to}(脚本,直接用 bash 运行,不要重写它)。`
            : `${v.path}:
${v.content}`,
      }],
    },
    async execute(args: any, exec: any) {
      const skill = String(args.skill || '')
      if (args.list === true || !args.path) {
        const res = await fetch(`${base}/skills/${encodeURIComponent(skill)}/files`, { headers, signal: exec.signal })
        if (!res.ok) throw new Error(`列技能资源失败:HTTP ${res.status}`)
        const data = (await res.json()) as { files?: { path: string; kind: string; bytes: number }[] }
        const listing = (data.files || []).map((f) => `  ${f.kind === 'script' ? '[脚本]' : '[规范]'} ${f.path}`).join('\n')
        return { skill, listing: listing || '(无)' }
      }
      const rel = String(args.path)
      const res = await fetch(
        `${base}/skills/${encodeURIComponent(skill)}/file?path=${encodeURIComponent(rel)}`,
        { headers, signal: exec.signal })
      if (!res.ok) throw new Error(`取技能资源失败:HTTP ${res.status}`)
      const data = (await res.json()) as { path: string; kind: string; content: string }
      if (data.kind !== 'script') {
        // 知识类:回来的是占位符,网关转发时注入真内容 —— 不落设备磁盘
        return { skill, path: data.path, kind: data.kind, content: data.content }
      }
      const target = await (ctx as any).fs.resolve(`.knevo/skills/${skill}/${rel}`, {
        cwd: exec.agent?.session?.header?.cwd, signal: exec.signal,
      })
      const abs = (ctx as any).fs.processPath(target)
      await mkdir(dirname(abs), { recursive: true }).catch(() => {})
      await writeFile(abs, data.content, { signal: exec.signal })
      return { skill, path: data.path, kind: 'script', saved_to: target.displayPath }
    },
  }))
}
