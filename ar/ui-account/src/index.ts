/**
 * AR 接线⑥（node 半）：账号与积分的本机 RPC 通道。
 *
 * 浏览器半边**绝不能**直连 dev.ar.knevo.ai —— 那要么撞 CORS，要么就得把设备 token
 * 交给页面（`--trusted-host` 起 LAN 监听时更糟）。所以 token 只留在 node 侧，
 * 页面通过同源的 `/knevo` 通道跟本机说话，由这里代打云端。
 *
 * 通道是 `authority: 'loopback'` —— 非本机请求直接 403（由 connection 层强制）。
 *
 * 端点：
 *   auth/status   → 本机有没有设备 token（不回 token 本身）
 *   auth/start    → 向云端要一个验证码（device-code），回验证码 + 确认链接
 *   auth/poll     → 轮询是否已在网页确认；确认后**把 token 写盘**
 *   auth/logout   → 删除本机 token
 *   account/summary → 余额 / 可用额度 / 令牌到期 / 最近消耗
 *
 * @module @knevo/dsh-ar-ui-account
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export interface Config {
  /** 网关基址，如 https://dev.ar.knevo.ai/api/agent/v1 */
  baseUrl: string
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().required(),
})

type RpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: object } }

const fail = (code: string, message: string): RpcResult => ({ ok: false, error: { code, message, details: {} } })

function dshHome(): string {
  return process.env.DSH_HOME || join(process.cwd(), '.dsh-home')
}

/**
 * 现读 token，不缓存。登录后不重启进程也能让本面板立刻反映新状态。
 *
 * 注意边界：llm / telemetry / search 等插件的 token 是 **boot 时**从 config 求值的，
 * 换账号后它们仍在用旧 token —— 所以 UI 必须提示「请重启客户端」，不能假装已经全链路生效。
 */
function readToken(): string {
  const f = join(dshHome(), '.device-token')
  if (existsSync(f)) {
    const t = readFileSync(f, 'utf8').trim()
    if (t.length > 0) return t
  }
  return (process.env.AR_DEVICE_TOKEN || '').trim()
}

function deviceId(): string {
  const f = join(dshHome(), '.device-id')
  if (existsSync(f)) return readFileSync(f, 'utf8').trim()
  const id = `${hostname()}-${Math.random().toString(36).slice(2, 10)}`
  mkdirSync(dshHome(), { recursive: true })
  writeFileSync(f, id)
  return id
}

export const inject = ['connection']

export function apply(ctx: Context, config: Config): void {
  const base = config.baseUrl.replace(/\/$/, '')

  const post = async (path: string, body: unknown, signal?: AbortSignal) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    })
    return { status: res.status, data: await res.json().catch(() => ({})) as Record<string, unknown> }
  }

  const handler = async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult> => {
    const body = (payload ?? {}) as Record<string, unknown>
    try {
      switch (endpoint) {
        case 'auth/status':
          return { ok: true, value: { loggedIn: readToken().length > 0 } }

        case 'auth/start': {
          const r = await post('/auth/device/init', { device_id: deviceId(), name: hostname() }, signal)
          if (r.status !== 200) return fail('upstream', `初始化登录失败（HTTP ${r.status}）`)
          return { ok: true, value: r.data }
        }

        case 'auth/poll': {
          const code = String(body.device_code || '')
          if (code.length === 0) return fail('invalid', 'device_code required')
          const r = await post('/auth/device/poll', { device_code: code }, signal)
          if (r.status === 429) return { ok: true, value: { status: 'pending' } }
          if (r.status !== 200) return fail('upstream', `轮询失败（HTTP ${r.status}）`)
          if (r.data.status === 'approved' && typeof r.data.token === 'string') {
            mkdirSync(dshHome(), { recursive: true })
            writeFileSync(join(dshHome(), '.device-token'), r.data.token)
            return { ok: true, value: { status: 'approved', userId: r.data.user_id ?? null } }
          }
          return { ok: true, value: { status: r.data.status ?? 'pending' } }
        }

        case 'auth/logout': {
          const f = join(dshHome(), '.device-token')
          if (existsSync(f)) rmSync(f)
          return { ok: true, value: { loggedIn: false } }
        }

        case 'account/summary': {
          const token = readToken()
          if (token.length === 0) return { ok: true, value: { loggedIn: false } }
          const res = await fetch(`${base}/account`, {
            headers: { authorization: `Bearer ${token}` },
            ...(signal === undefined ? {} : { signal }),
          })
          if (res.status === 401 || res.status === 403) {
            return { ok: true, value: { loggedIn: false, expired: true } }
          }
          if (!res.ok) return fail('upstream', `读取账户失败（HTTP ${res.status}）`)
          return { ok: true, value: { loggedIn: true, ...(await res.json()) as object } }
        }

        default:
          return fail('not_found', `unknown endpoint: ${endpoint}`)
      }
    } catch (e) {
      return fail('internal', e instanceof Error ? e.message : String(e))
    }
  }

  ctx.effect(() => {
    const dispose = (ctx as any).connection.rpc.handle('/knevo', handler, { authority: 'loopback' })
    return () => { void dispose() }
  }, 'ar-ui-account: /knevo rpc channel')
}

// ★不要加 `export default apply`。cordis 的 loader 见到 default 导出就把**那个函数**
//   当插件,而函数插件的 inject 要挂在函数属性上 —— 模块级的 `export const inject`
//   会被整个忽略,运行期报 `cannot get property "x" without inject` 并让整棵插件树
//   boot 失败(2026-08-17 实测:macOS 上客户端直接起不来)。其余 9 个 @knevo 插件
//   都是 inject + apply、无 default —— 保持一致。
