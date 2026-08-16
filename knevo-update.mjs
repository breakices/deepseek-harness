/**
 * Knevo 客户端分发逻辑:查 dev 的 releases 端点 → 比对本地版本 → 下载最新工件 →
 * 校验 sha256 → 解包。这是「设备从平台拉取版本」的更新链路(设计里 launcher 的一环)。
 *
 * 端点(公开,无需 token):
 *   GET {AR_BASE}/releases/latest            → {version, filename, sha256, url}
 *   GET .../releases/download/{filename}      → tarball
 *
 * 用法:node knevo-update.mjs [目标目录]   (默认 ./.knevo-releases)
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'

const AR_BASE = process.env.KNEVO_AR_BASE || 'https://dev.ar.knevo.ai/api/agent/v1'
const DEST = process.argv[2] || join(process.cwd(), '.knevo-releases')
const VER_FILE = join(DEST, '.installed-version')

async function main() {
  mkdirSync(DEST, { recursive: true })
  const res = await fetch(`${AR_BASE}/releases/latest`)
  if (!res.ok) { console.error(`查询最新版本失败: HTTP ${res.status}`); process.exit(1) }
  const m = await res.json()
  console.log(`最新版本: ${m.version}  (${m.filename})`)

  const installed = existsSync(VER_FILE) ? readFileSync(VER_FILE, 'utf8').trim() : ''
  if (installed === m.version) { console.log('已是最新,无需更新。'); return }

  console.log(`下载 ${m.url} ...`)
  const dl = await fetch(m.url)
  if (!dl.ok) { console.error(`下载失败: HTTP ${dl.status}`); process.exit(1) }
  const buf = Buffer.from(await dl.arrayBuffer())

  const sha = createHash('sha256').update(buf).digest('hex')
  if (m.sha256 && sha !== m.sha256) {
    console.error(`❌ sha256 校验失败!期望 ${m.sha256} 实得 ${sha} —— 拒绝安装(可能被篡改/传输损坏)。`)
    process.exit(1)
  }
  console.log(`✅ sha256 校验通过: ${sha}`)

  const tgz = join(DEST, m.filename)
  writeFileSync(tgz, buf)
  // 在 DEST 里就地解包(相对文件名),避开 Windows tar 对含盘符路径的 -C 解析问题。
  execSync(`tar -xzf "${m.filename}"`, { cwd: DEST, stdio: 'inherit' })
  writeFileSync(VER_FILE, m.version)
  console.log(`✅ 已下载并解包到 ${DEST}/knevo-ar-${m.version}/`)
  console.log('进入该目录跑 knevo.cmd / knevo.sh 即可(首次会 npm install 拉 dsh runtime + 登录)。')
}
main().catch((e) => { console.error(e); process.exit(1) })
