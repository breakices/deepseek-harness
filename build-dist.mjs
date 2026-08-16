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
import { build } from 'esbuild'
import { mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'

const ROOT = dirname(fileURLToPath(import.meta.url))
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
  dependencies: { '@deepseek-ai/dsh': DSH_VERSION, ...fileDeps },
}, null, 2))

// 3) profile 接线 + 启动器(从工作副本拷,过滤掉运行态/密钥)
mkdirSync(join(OUT, '.dsh-home'), { recursive: true })
cpSync(join(ROOT, '.dsh-home', 'cordis.patch.yml'), join(OUT, '.dsh-home', 'cordis.patch.yml'))
for (const f of ['knevo-login.mjs', 'KNEVO-README.md']) {
  if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(OUT, f))
}

// 4) 分发版启动器(与 spike 的 knevo.cmd 不同:用装好的本地 dsh,不用 monorepo)
writeFileSync(join(OUT, 'knevo.cmd'), [
  '@echo off',
  'rem Knevo 客户端启动器（分发版）。首次会 npm install 拉 dsh runtime + 登录换设备 token。',
  'setlocal',
  'set DSH_HOME=%~dp0.dsh-home',
  'cd /d %~dp0',
  'set HTTP_PROXY=', 'set HTTPS_PROXY=', 'set http_proxy=', 'set https_proxy=',
  'if not exist node_modules ( echo 首次安装依赖... & npm install --no-audit --no-fund )',
  'if not exist "%DSH_HOME%\\.device-token" (',
  '  echo 首次使用请登录（未注册先到 https://dev.ar.knevo.ai 注册）。',
  '  node "%~dp0knevo-login.mjs"',
  ')',
  'if not exist "%DSH_HOME%\\.device-token" ( echo 登录未完成 & exit /b 1 )',
  'set /p AR_DEVICE_TOKEN=<"%DSH_HOME%\\.device-token"',
  'echo 启动 Knevo（连接 dev.ar.knevo.ai）...',
  'node_modules\\.bin\\dsh --profile web --port 3180',
  'endlocal', '',
].join('\r\n'))
writeFileSync(join(OUT, 'knevo.sh'), [
  '#!/usr/bin/env bash',
  '# Knevo 客户端启动器（分发版,macOS/Linux）。',
  'set -e; cd "$(dirname "$0")"',
  'export DSH_HOME="$PWD/.dsh-home"',
  'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy',
  '[ -d node_modules ] || { echo "首次安装依赖..."; npm install --no-audit --no-fund; }',
  'if [ ! -f "$DSH_HOME/.device-token" ]; then',
  '  echo "首次使用请登录（未注册先到 https://dev.ar.knevo.ai 注册）。"; node ./knevo-login.mjs',
  'fi',
  '[ -f "$DSH_HOME/.device-token" ] || { echo "登录未完成"; exit 1; }',
  'export AR_DEVICE_TOKEN="$(cat "$DSH_HOME/.device-token")"',
  'echo "启动 Knevo（连接 dev.ar.knevo.ai）..."',
  './node_modules/.bin/dsh --profile web --port 3180', '',
].join('\n'))

// 5) 打 tarball + sha256 + manifest
const tgz = join(ROOT, 'dist', `knevo-ar-${VERSION}.tgz`)
execSync(`tar -czf "${tgz}" -C "${join(ROOT, 'dist')}" "knevo-ar-${VERSION}"`, { stdio: 'inherit' })
const sha = createHash('sha256').update(readFileSync(tgz)).digest('hex')
const manifest = { version: VERSION, filename: `knevo-ar-${VERSION}.tgz`, sha256: sha,
  notes: 'Knevo 形态 D 客户端(dsh runtime + AR profile)。' }
writeFileSync(join(ROOT, 'dist', 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`[build] 完成: ${tgz}`)
console.log(`[build] sha256: ${sha}`)
console.log(`[build] manifest: ${JSON.stringify(manifest)}`)
