/**
 * Knevo 设备登录 —— **浏览器授权(device-code),口令永不进本程序**。
 *
 * 流程:
 *   1. 本机 POST /auth/device/init → 拿一个 8 位验证码(给人看)+ 一个 device_code(自己轮询用)
 *   2. 打开浏览器到 Knevo 网站的确认页(带上验证码);用户在**已登录的网页里**点确认
 *   3. 本机轮询 /auth/device/poll,拿到设备 token 写进 $DSH_HOME/.device-token
 *
 * 为什么这么改:上一版是在终端里 `readline` 读邮箱+密码。那不只是"明文输入" ——
 * readline 没有掩码，**口令会直接打在屏幕上**，还留在 scrollback 与 shell history 里；
 * 客户端也因此无法自证不是钓鱼。现在密码只出现在我们自己的网站上，
 * 同一套流程对 CLI、客户端 WebUI、以后的原生 app 都成立。
 *
 * 落在设备上的只有受限设备 token(scope=agent-api，只能打 /api/agent/v1/*)；
 * 真实模型 key 从不下发。生产形态应再把它挪进 OS Keychain。
 *
 * 用法:
 *   node knevo-login.mjs             # 浏览器授权
 *   node knevo-login.mjs --check     # 校验已存 token 是否仍有效(launcher 用)
 *   KNEVO_DEVICE_TOKEN=xxx node knevo-login.mjs   # 非交互(自动化/联调):直接写入已有 token
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { hostname, platform } from 'node:os'
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

function saveToken(token) {
  mkdirSync(DSH_HOME, { recursive: true })
  writeFileSync(TOKEN_FILE, token)
}

/** 尽力打开浏览器；打不开也不算失败 —— 上面已经把链接打印出来了。 */
function openBrowser(url) {
  const p = platform()
  const [cmd, args] = p === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : p === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
  } catch { /* 无头环境：用户手动打开即可 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  // --check:校验已存 token 是否仍有效(过期/被吊销 → exit 1，launcher 据此触发重新登录)。
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
      // 网络不通 ≠ token 失效:放行启动，让运行期错误自己暴露，避免离线时死循环要登录
      process.exit(0)
    }
  }

  // 非交互逃生门:CI / 联调直接注入既有 token，同样不涉及口令。
  const injected = (process.env.KNEVO_DEVICE_TOKEN || '').trim()
  if (injected) {
    saveToken(injected)
    console.log(`✅ 已写入设备 token → ${TOKEN_FILE}`)
    return
  }

  const device_id = stableDeviceId()
  const initRes = await fetch(`${AR_BASE}/auth/device/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_id, name: hostname() }),
  })
  if (!initRes.ok) {
    console.error(`登录初始化失败: HTTP ${initRes.status} ${(await initRes.text().catch(() => '')).slice(0, 200)}`)
    process.exit(1)
  }
  const init = await initRes.json()

  console.log('')
  console.log('  在浏览器里确认这台设备：')
  console.log(`    ${init.verification_uri_complete}`)
  console.log('')
  console.log(`  验证码：${init.user_code}`)
  console.log(`  （${Math.round((init.expires_in || 600) / 60)} 分钟内有效。密码只在网页上输入，本程序不会向你索要密码。）`)
  console.log('')
  openBrowser(init.verification_uri_complete)

  const intervalMs = Math.max(1, Number(init.interval) || 2) * 1000
  const deadline = Date.now() + (Number(init.expires_in) || 600) * 1000
  process.stdout.write('  等待确认')
  while (Date.now() < deadline) {
    await sleep(intervalMs)
    let out
    try {
      const res = await fetch(`${AR_BASE}/auth/device/poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_code: init.device_code }),
      })
      if (res.status === 429) { await sleep(intervalMs * 2); continue }   // 退避，别把自己限死
      out = await res.json()
    } catch {
      continue                                   // 网络抖动:继续轮询到超时为止
    }
    if (out.status === 'approved' && out.token) {
      saveToken(out.token)
      console.log('')
      console.log(`✅ 已登录（用户 ${out.user_id ?? '?'}），设备 token 写入 ${TOKEN_FILE}`)
      console.log('现在可以启动 Knevo 了。')
      return
    }
    if (out.status === 'expired') {
      console.error('\n验证码已过期，请重新运行登录。')
      process.exit(1)
    }
    process.stdout.write('.')
  }
  console.error('\n等待确认超时，请重新运行登录。')
  process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
