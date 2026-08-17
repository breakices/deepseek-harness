/**
 * AR 接线: web_search 远程 provider。
 *
 * 注册进 ctx.web(registerSearchProvider),search() 打 agent_gateway 的 /search;
 * **平台持 Tavily/火山 key + 统一计量**,key 绝不下发设备。工具本体(web_search 的
 * schema/校验/展示)是 dsh 原生 `tool-web`,本包只提供搜索**后端**。
 *
 * web_fetch **不在本包**:抓取由 dsh 原生 `web-fetch-http` provider 在**设备本地/用户 IP**
 * 上做(公网页也默认设备抓 —— 爆炸半径自包含、反爬友好、内网/登录态本来只能本地)。
 * 详见 AR-DSH-ARCHITECTURE-MAP §7。
 *
 * /search 端点约定(gateway):
 *   POST {base}/search  body {query, maxResults?}  →
 *     成功 { ok:true, query, answer?, provider, sources:[{url,title?,snippet?,publishedAt?}], truncated }
 *     失败 { ok:false, error, code }
 * @module @knevo/dsh-ar-web-search
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import { WebError } from '@deepseek-ai/dsh-web'

export const name = 'ar-web-search'
export const inject = ['web']

export interface Config {
  /** 搜索服务基址,如 http://localhost:8000/api/agent/v1 */
  baseUrl: string
  /** 设备 token(Bearer) */
  token: string
  /** provider id(默认 ar-remote) */
  providerId?: string
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().required(),
  token: z.string().required(),
  providerId: z.string().default('ar-remote'),
})

/** gateway /search 的成功返回体(source 侧字段与 dsh WebSearchSource 同名,浅映射即可)。 */
interface SearchApiResponse {
  ok: boolean
  error?: string
  code?: string
  query?: string
  answer?: string | null
  provider?: string
  sources?: Array<{
    url: string
    title?: string | null
    snippet?: string | null
    publishedAt?: string | null
  }>
  truncated?: boolean
}

/**
 * 把网关的结构化错误体翻成人话。C 端最关键的一处:402 配额闸的 detail 里带
 * {code, balance, owed, message},若只抛「HTTP 402」,用户在**付费时刻**看到的是
 * 一串裸状态码,不知道要充值。401/403(设备登录失效)、429(限速)同理。
 */
async function describeError(res: Response, what: string): Promise<string> {
  let detail: any
  try {
    const body = (await res.json()) as any
    // 网关现在按 OpenAI 线格式回 `error`(dsh 主通道 adapter 只认这个键),
    // 同时保留 `detail` 兼容存量客户端。两个都读,谁在用谁。
    detail = body?.error ?? body?.detail
  } catch {
    /* 非 JSON 响应,退回状态码 */
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

class RemoteSearchProvider implements WebSearchProvider {
  readonly id: string
  private readonly base: string
  private readonly token: string

  constructor(config: Config) {
    this.id = config.providerId || 'ar-remote'
    this.base = config.baseUrl.replace(/\/$/, '')
    this.token = config.token
  }

  /** 便宜的本地可用性检查(不发网络):base + token 齐即可用。 */
  available(): boolean {
    return this.base.length > 0 && this.token.length > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    let resp: Response
    try {
      resp = await fetch(`${this.base}/search`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query: request.query,
          ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }),
        }),
        signal,
      })
    } catch (cause) {
      throw new WebError('web search request failed', 'WEB_PROVIDER_FAILED', { cause })
    }

    if (!resp.ok) {
      throw new WebError(
        await describeError(resp, '联网搜索'),
        resp.status === 402 ? 'WEB_QUOTA_EXCEEDED' : 'WEB_PROVIDER_FAILED',
      )
    }

    const data = (await resp.json()) as SearchApiResponse
    if (!data.ok) {
      throw new WebError(data.error || 'web search failed', data.code || 'WEB_PROVIDER_FAILED')
    }

    const sources: WebSearchSource[] = (data.sources || []).map((s) => ({
      url: s.url,
      ...(s.title ? { title: s.title } : {}),
      ...(s.snippet ? { snippet: s.snippet } : {}),
      ...(s.publishedAt ? { publishedAt: s.publishedAt } : {}),
    }))

    return {
      ...(data.answer ? { content: data.answer } : {}),
      sources,
      truncated: data.truncated === true,
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new RemoteSearchProvider(config))
}
