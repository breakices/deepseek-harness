/**
 * Knevo 设备登录:初见者用账号口令换一枚**设备 token**(绑到本人),写进
 * $DSH_HOME/.device-token。之后 launcher 把它注入 AR_DEVICE_TOKEN 跑 dsh。
 *
 * 复用现有 device_agents /auth/token 凭据端点(email+password → 绑真实用户的 token)。
 * 真实 key 从不落设备;这里落的只是受限设备 token(scope=agent-api)。
 * 生产形态应换 OS Keychain + OAuth device-code;此为可跑的最小真实流。
 *
 * 用法:
 *   node knevo-login.mjs                     # 交互式提示 email/password
 *   KNEVO_EMAIL=.. KNEVO_PASSWORD=.. node knevo-login.mjs   # 非交互(自动化/测试)
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

const AR_BASE = process.env.KNEVO_AR_BASE || 'https://dev.ar.knevo.ai/api/agent/v1'
const DSH_HOME = process.env.DSH_HOME || join(process.cwd(), '.dsh-home')
const TOKEN_FILE = join(DSH_HOME, '.device-token')
const DEVICE_FILE = join(DSH_HOME, '.device-id')

function stableDeviceId() {
  if (existsSync(DEVICE_FILE)) return readFileSync(DEVICE_FILE, 'utf8').trim()
  const id = `${hostname()}-${Math.random().toString(36).slice(2, 10)}`
  mkdirSync(DSH_HOME, { recursive: true })
  writeFileSync(DEVICE_FILE, id)
  return id
}

async function prompt(q, { silent = false } = {}) {
  const env = silent ? process.env.KNEVO_PASSWORD : process.env.KNEVO_EMAIL
  if (env) return env
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ans = await rl.question(q)
  rl.close()
  return ans.trim()
}

async function main() {
  // --check:校验已存 token 是否仍有效(过期/被吊销 → exit 1,launcher 据此触发重登录)。
  // 用 /skills/catalog 当探针:带鉴权、无 LLM/搜索成本。
  if (process.argv.includes('--check')) {
    if (!existsSync(TOKEN_FILE)) process.exit(1)
    const token = readFileSync(TOKEN_FILE, 'utf8').trim()
    try {
      const res = await fetch(`${AR_BASE}/skills/catalog`, {
        headers: { authorization: `Bearer ${token}` },
      })
      process.exit(res.status === 401 || res.status === 403 ? 1 : 0)
    } catch {
      // 网络不通 ≠ token 失效:放行启动,让运行期错误自己暴露,避免离线时死循环要登录
      process.exit(0)
    }
  }

  console.log(`Knevo 设备登录（连接 ${AR_BASE}）`)
  const email = await prompt('邮箱: ')
  const password = await prompt('密码: ', { silent: true })
  const device_id = stableDeviceId()

  const res = await fetch(`${AR_BASE}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_id, email, password }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.error(`登录失败: HTTP ${res.status} ${body.slice(0, 200)}`)
    process.exit(1)
  }
  const data = await res.json()
  if (!data.token) { console.error('返回无 token'); process.exit(1) }
  mkdirSync(DSH_HOME, { recursive: true })
  writeFileSync(TOKEN_FILE, data.token)
  console.log(`✅ 已登录为用户 ${data.user_id}，设备 token 写入 ${TOKEN_FILE}`)
  console.log('现在可以启动 Knevo 了。')
}

main().catch((e) => { console.error(e); process.exit(1) })
