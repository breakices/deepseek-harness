/**
 * AR 接线⑥（浏览器半）：设置里的「账号」页 —— 登录状态、积分余额、最近消耗。
 *
 * 解决两件事：
 * 1. **登录不该在终端里输密码**。这里点一下就走浏览器授权（device-code）：
 *    验证码显示在客户端界面上，密码只在 Knevo 网站上输。
 * 2. **积分对用户完全不可见**。此前客户端在架构上就查不到余额，用户唯一
 *    知道自己没钱的方式是任务被 402 拒掉。
 *
 * 一切网络都走本机 `/knevo` 通道（node 半代打云端），设备 token 绝不进页面。
 *
 * 刻意不用 CSS Modules、不注册 locale：这个包是我们自己维护的第一个浏览器半边插件，
 * 少一个构建期契约就少一个白屏来源（任一插件 apply 抛错都会让整个 UI 停在 loading 页）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

type Rpc = (endpoint: string, payload?: unknown) => Promise<any>

interface Face {
  readonly call: Rpc
}

interface Props extends Face {
  readonly close: () => void
}

interface Summary {
  loggedIn: boolean
  expired?: boolean
  userId?: string
  deviceId?: string
  billingEnabled?: boolean
  balance?: number
  owed?: number
  available?: number | null
  tokenExpiresAt?: string | null
  recent?: { delta: number; reason: string; refType?: string | null; fromClient?: boolean; createdAt?: string }[]
}

const REASON_LABEL: Record<string, string> = {
  token_spend: 'Token 扣费',
  turn_spend: '消息扣费',
  topup: '充值',
  refund: '退款',
  admin_grant: '管理员调整',
  admin_set: '管理员设定',
  sub_grant: '订阅发放',
  sub_expire: '订阅过期',
  trial_waiver: '减免',
}

const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.35rem 0' }
const muted: React.CSSProperties = { color: 'var(--dsw-color-text-muted, #888)', fontSize: '0.85em' }
const num: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' }

function daysLeft(iso?: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.floor((t - Date.now()) / 86400000)
}

export function AccountSection(props: Props): React.ReactElement {
  const { call } = props
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<{ userCode: string; url: string } | null>(null)
  const [justLoggedIn, setJustLoggedIn] = useState(false)
  const polling = useRef<number | null>(null)

  const load = useCallback(() => {
    setError(null)
    call('account/summary').then(
      (v) => setSummary(v as Summary),
      (e) => setError(String(e?.message ?? e)),
    )
  }, [call])

  useEffect(() => {
    load()
    return () => { if (polling.current !== null) window.clearInterval(polling.current) }
  }, [load])

  const startLogin = useCallback(() => {
    setError(null)
    call('auth/start').then((v: any) => {
      setPending({ userCode: v.user_code, url: v.verification_uri_complete })
      try { window.open(v.verification_uri_complete, '_blank', 'noopener') } catch { /* 用户可手动点链接 */ }
      const deadline = Date.now() + (Number(v.expires_in) || 600) * 1000
      polling.current = window.setInterval(() => {
        if (Date.now() > deadline) {
          if (polling.current !== null) window.clearInterval(polling.current)
          setPending(null)
          setError('验证码已过期，请重新开始。')
          return
        }
        call('auth/poll', { device_code: v.device_code }).then((p: any) => {
          if (p.status === 'approved') {
            if (polling.current !== null) window.clearInterval(polling.current)
            setPending(null)
            setJustLoggedIn(true)
            load()
          }
        }, () => { /* 轮询抖动忽略，等超时 */ })
      }, Math.max(1, Number(v.interval) || 2) * 1000)
    }, (e) => setError(String(e?.message ?? e)))
  }, [call, load])

  const logout = useCallback(() => {
    call('auth/logout').then(() => { setJustLoggedIn(true); load() }, (e) => setError(String(e?.message ?? e)))
  }, [call, load])

  if (error !== null) {
    return (
      <div>
        <p>读取账户失败：{error}</p>
        <button onClick={load} type="button">重试</button>
      </div>
    )
  }
  if (summary === null) return <div style={muted}>加载中…</div>

  if (pending !== null) {
    return (
      <div>
        <h3>在浏览器里确认这台设备</h3>
        <p style={{ fontSize: '2em', letterSpacing: '0.15em', fontFamily: 'monospace' }}>{pending.userCode}</p>
        <p><a href={pending.url} rel="noreferrer" target="_blank">打开确认页</a></p>
        <p style={muted}>密码只在 Knevo 网站上输入，客户端不会向你索要密码。</p>
        <p style={muted}>等待确认中…</p>
      </div>
    )
  }

  if (!summary.loggedIn) {
    return (
      <div>
        <h3>未连接账号</h3>
        <p style={muted}>
          {summary.expired === true
            ? '设备登录已失效（令牌过期或已被吊销），请重新连接。'
            : '连接账号后才能使用云端模型、联网搜索与长期记忆。'}
        </p>
        <button onClick={startLogin} type="button">连接账号</button>
      </div>
    )
  }

  const left = daysLeft(summary.tokenExpiresAt)
  return (
    <div>
      {justLoggedIn && (
        <p style={{ ...muted, border: '1px solid var(--dsw-color-border, #444)', padding: '0.5rem' }}>
          账号状态已更新。**请重启客户端**后新账号才会对模型、搜索、遥测全部生效。
        </p>
      )}
      <div style={row}><span>账号</span><span style={num}>{summary.userId}</span></div>
      <div style={row}><span>本设备</span><span style={num}>{summary.deviceId}</span></div>
      {left !== null && (
        <div style={row}>
          <span>登录有效期</span>
          <span style={num}>{left <= 0 ? '已过期' : `还有 ${left} 天`}</span>
        </div>
      )}

      <h4>积分</h4>
      {summary.billingEnabled === false
        ? <p style={muted}>当前环境未启用计费。</p>
        : (
          <>
            <div style={row}><span>余额</span><span style={num}>{summary.balance}</span></div>
            <div style={row}><span>未结算用量</span><span style={num}>{summary.owed}</span></div>
            <div style={row}>
              <span>可用额度</span>
              <span style={{ ...num, fontWeight: 600 }}>{summary.available}</span>
            </div>
            {typeof summary.available === 'number' && summary.available <= 0 && (
              <p style={muted}>额度已用尽，请到 Knevo 网站充值或联系管理员。</p>
            )}
          </>
        )}

      {(summary.recent?.length ?? 0) > 0 && (
        <>
          <h4>最近消耗</h4>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {summary.recent!.map((e, i) => (
              <li key={`${e.createdAt ?? ''}-${i}`} style={row}>
                <span>
                  {REASON_LABEL[e.reason] ?? e.reason}
                  <span style={muted}>{e.fromClient === true ? '　客户端' : '　网页'}</span>
                </span>
                <span style={num}>{e.delta > 0 ? `+${e.delta}` : e.delta}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p style={{ marginTop: '1rem' }}>
        <button onClick={load} type="button">刷新</button>
        {' '}
        <button onClick={logout} type="button">退出登录</button>
      </p>
    </div>
  )
}

export const inject = ['slots', 'connection']

export function apply(ctx: any): void {
  const conn = ctx.get('connection')
  const call: Rpc = async (endpoint, payload = {}) => {
    const r = await conn.rpc.call('/knevo', endpoint, payload)
    if (r.ok !== true) throw new Error(r.error?.message ?? 'RPC 失败')
    return r.value
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'knevo-account',
    order: -100,          // 账号是最先要看的一页
    label: () => '账号',
    inject: (): Face => ({ call }),
  }, AccountSection))
}

export default apply
