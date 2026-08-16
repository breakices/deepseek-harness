/**
 * 构建 Knevo 客户端分发包(形态 D):把 @knevo 插件编译成自包含 JS,组装成一个
 * **独立 npm 项目**(依赖公网发布的 @deepseek-ai/dsh 当 runtime),打成 tarball。
 *
 * 产物 dist/knevo-ar-<ver>/:
 *   package.json          依赖 @deepseek-ai/dsh + file: 链接各 @knevo 插件
 *   plugins/<n>/          esbuild 打好的自包含插件(externalize @deepseek-ai/* 与 node:*)
 *   .dsh-home/cordis.patch.yml   AR profile 接线(dev 端点、token 走 env,无任何密钥)
 *   knevo.cmd / knevo.sh / knevo-login.mjs / KNEVO-README.md   启动器
 * 再打成 dist/knevo-ar-<ver>.tgz + 写 sha256/manifest。
 *
 * 用法:node build-dist.mjs [version]   (默认 0.1.0)
 */
import { mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'

const ROOT = dirname(fileURLToPath(import.meta.url))

// esbuild 藏在 monorepo 的 pnpm 虚拟store里(非顶层 hoisted),按路径 require(CJS)。
const require = createRequire(import.meta.url)
const _pnpm = join(ROOT, 'node_modules', '.pnpm')
const _esDir = readdirSync(_pnpm).find((d) => d.startsWith('esbuild@'))
if (!_esDir) throw new Error('找不到 esbuild(node_modules/.pnpm/esbuild@*)——先在 monorepo 跑过 pnpm install')
const { build } = require(join(_pnpm, _esDir, 'node_modules', 'esbuild'))
const VERSION = process.argv[2] || '0.1.0'
const DSH_VERSION = '0.1.0-rc.6'

// AR profile 需要的 @knevo 插件(与 .dsh-home/cordis.patch.yml 的 insert 一致)
const PLUGINS = [
  'hello', 'telemetry', 'skills-remote', 'memory', 'image',
  'web-search', 'peer-review', 'compact', 'goals-judge', 'assets-core',
]

const OUT = join(ROOT, 'dist', `knevo-ar-${VERSION}`)
console.log(`[build] 版本 ${VERSION} → ${OUT}`)
rmSync(join(ROOT, 'dist'), { recursive: true, force: true })
mkdirSync(join(OUT, 'plugins'), { recursive: true })

// 1) 逐个 esbuild 打包 @knevo 插件
const fileDeps = {}
for (const p of PLUGINS) {
  const srcPkg = JSON.parse(readFileSync(join(ROOT, 'ar', p, 'package.json'), 'utf8'))
  const name = srcPkg.name              // @knevo/dsh-ar-*
  const outDir = join(OUT, 'plugins', p)
  mkdirSync(outDir, { recursive: true })
  await build({
    entryPoints: [join(ROOT, 'ar', p, 'src', 'index.ts')],
    outfile: join(outDir, 'index.js'),
    bundle: true, format: 'esm', platform: 'node', target: 'node22',
    // @deepseek-ai/* 由装好的 dsh 提供;node: 内置 external;第三方(turndown 等)打进来
    external: ['@deepseek-ai/*', 'node:*'],
    logLevel: 'warning',
  })
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({
    name, version: VERSION, private: true, type: 'module',
    exports: { '.': './index.js', './package.json': './package.json' },
  }, null, 2))
  fileDeps[name] = `file:./plugins/${p}`
  console.log(`  [bundle] ${name}`)
}

// 2) 顶层 package.json:依赖 dsh + 各插件
writeFileSync(join(OUT, 'package.json'), JSON.stringify({
  name: 'knevo-ar', version: VERSION, private: true, type: 'module',
  description: 'Knevo（AR × dsh 形态 D）客户端 —— dsh 当 runtime,连 Knevo 云端。',
  dependencies: {
    '@deepseek-ai/dsh': DSH_VERSION,
    // web_fetch 用的原生 fetch provider —— base bundle 禁 fetch 不带它,单独装(patch 里 insert)。
    '@deepseek-ai/dsh-web-fetch-http': '0.0.1-rc.5',
    ...fileDeps,
  },
  // pnpm 默认忽略依赖的 postinstall(安全策略)——但 dsh-subprocess-local 的
  // ensure-spawn-helper 等必须跑,否则设备侧 shell/子进程工具坏。显式放行这几个。
  pnpm: {
    onlyBuiltDependencies: [
      '@deepseek-ai/dsh-subprocess-local', 'node-pty', 'koffi', 'protobufjs', '@google/genai',
    ],
  },
}, null, 2))

// 3) profile 接线 + 启动器(从工作副本拷,过滤掉运行态/密钥)
mkdirSync(join(OUT, '.dsh-home'), { recursive: true })
// ★分发版剥掉 token 的 spike fallback:'ar-spike-2026' 会让「env 没注入」这种故障
//   静默降级成「用默认账户计费」——C 端必须 fail-loud(空 token → 明确 401/工具不可用)。
const patchSrc = readFileSync(join(ROOT, '.dsh-home', 'cordis.patch.yml'), 'utf8')
writeFileSync(join(OUT, '.dsh-home', 'cordis.patch.yml'),
  patchSrc.replaceAll(`process.env.AR_DEVICE_TOKEN || 'ar-spike-2026'`, `process.env.AR_DEVICE_TOKEN || ''`))
for (const f of ['knevo-login.mjs', 'knevo-update.mjs', 'KNEVO-README.md']) {
  if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(OUT, f))
}

// 4) 分发版启动器。要点:
//    - 装依赖用 pnpm(npx 拉取;实测 npm 在部分代理环境静默装不出 node_modules,pnpm 稳)
//    - **不清用户代理**:npm/pnpm 拉包可能需要它(中国网络);dsh 运行时用 undici fetch,
//      本就不读 env 代理,直连 dev 公网 —— 两边各取所需,不动用户环境。
//    - token 有效性检查(--check):30 天过期/被吊销 → 触发重登录,而不是运行期哑 401。
writeFileSync(join(OUT, 'knevo.cmd'), [
  '@echo off',
  'rem Knevo 客户端启动器(Windows)。首次:装依赖(几分钟)+ 登录换设备 token。',
  'setlocal',
  'set DSH_HOME=%~dp0.dsh-home',
  'cd /d %~dp0',
  'if not exist node_modules (',
  '  echo 首次安装依赖,约需几分钟...',
  '  call npx -y pnpm@11.7.0 install --ignore-workspace || ( echo 依赖安装失败,请检查网络后重试。 & exit /b 1 )',
  ')',
  'if exist "%DSH_HOME%\\.device-token" (',
  '  node "%~dp0knevo-login.mjs" --check || (',
  '    echo 登录已过期,请重新登录。',
  '    del "%DSH_HOME%\\.device-token"',
  '    node "%~dp0knevo-login.mjs"',
  '  )',
  ') else (',
  '  echo 首次使用请登录(未注册先到 https://dev.ar.knevo.ai 注册)。',
  '  node "%~dp0knevo-login.mjs"',
  ')',
  'if not exist "%DSH_HOME%\\.device-token" ( echo 登录未完成,已退出。 & exit /b 1 )',
  'set /p AR_DEVICE_TOKEN=<"%DSH_HOME%\\.device-token"',
  'echo 启动 Knevo(连接 dev.ar.knevo.ai),首次启动约 1-3 分钟,好了用浏览器开 http://127.0.0.1:3180 ...',
  'node_modules\\.bin\\dsh --profile web --port 3180',
  'endlocal', '',
].join('\r\n'))
writeFileSync(join(OUT, 'knevo.sh'), [
  '#!/usr/bin/env bash',
  '# Knevo 客户端启动器(macOS/Linux)。首次:装依赖(几分钟)+ 登录换设备 token。',
  'set -e; cd "$(dirname "$0")"',
  'export DSH_HOME="$PWD/.dsh-home"',
  '[ -d node_modules ] || { echo "首次安装依赖,约需几分钟..."; npx -y pnpm@11.7.0 install --ignore-workspace; }',
  'if [ -f "$DSH_HOME/.device-token" ]; then',
  '  node ./knevo-login.mjs --check || { echo "登录已过期,请重新登录。"; rm -f "$DSH_HOME/.device-token"; node ./knevo-login.mjs; }',
  'else',
  '  echo "首次使用请登录(未注册先到 https://dev.ar.knevo.ai 注册)。"; node ./knevo-login.mjs',
  'fi',
  '[ -f "$DSH_HOME/.device-token" ] || { echo "登录未完成,已退出。"; exit 1; }',
  'export AR_DEVICE_TOKEN="$(cat "$DSH_HOME/.device-token")"',
  'echo "启动 Knevo(连接 dev.ar.knevo.ai),首次启动约 1-3 分钟,好了用浏览器开 http://127.0.0.1:3180 ..."',
  './node_modules/.bin/dsh --profile web --port 3180', '',
].join('\n'))

// 5) 打 tarball + sha256 + manifest（cwd+相对路径,避开 Windows tar 对含盘符路径的解析）
const tgz = join(ROOT, 'dist', `knevo-ar-${VERSION}.tgz`)
execSync(`tar --force-local -czf "knevo-ar-${VERSION}.tgz" "knevo-ar-${VERSION}"`,
  { cwd: join(ROOT, 'dist'), stdio: 'inherit' })
const sha = createHash('sha256').update(readFileSync(tgz)).digest('hex')
const manifest = { version: VERSION, filename: `knevo-ar-${VERSION}.tgz`, sha256: sha,
  notes: 'Knevo 形态 D 客户端(dsh runtime + AR profile)。' }
writeFileSync(join(ROOT, 'dist', 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`[build] 完成: ${tgz}`)
console.log(`[build] sha256: ${sha}`)
console.log(`[build] manifest: ${JSON.stringify(manifest)}`)
