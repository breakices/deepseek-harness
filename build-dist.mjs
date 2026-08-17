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
// 前端资源由**我们托管**:构建时取发布版、改品牌、随包发,再用 pnpm overrides 指过去。
// 这样用户装依赖时解析到我们的副本,不从 npm 拉原装(品牌不经第三方)。
const FE_VERSION = '0.1.0-rc.6'
const BRAND = { title: 'Knevo', short: 'Knevo', icon: 'knevo-icon.png' }

// Node 版本闸的脚本体(双引号 JS 字符串承载,内部只用单引号,避免与两种 shell 的引号打架)。
const NODE_GUARD = "const v=process.versions.node.split('.').map(Number); "
  + "if(!((v[0]===22&&v[1]>=19)||v[0]>=24)){"
  + "console.error('Knevo needs Node 22.19+ or 24+, found '+process.versions.node+'. Upgrade at https://nodejs.org');"
  + "process.exit(1)}"

// AR profile 需要的 @knevo 插件(与 .dsh-home/cordis.patch.yml 的 insert 一致)
const PLUGINS = [
  'hello', 'telemetry', 'skills-remote', 'memory', 'image',
  'web-search', 'peer-review',
  'ui-account', 'vision',
]

// 带**浏览器半边**的插件(package.json 里 dsh.client.platform=web)。
// client UI 插件不进前端 bundle:node 侧 ClientModuleRegistry 扫 Loader entry 的
// package.json，命中就把 exports['./client'] 那个文件挂到 /plugins/<包名>/client.js，
// 并把清单注进 index.html 的 window.__DSH_BOOT__；浏览器再逐个 <script> 拉。
// 所以自托管的 dsh-web-frontend 一行都不用改，只需要在这里多出一份浏览器产物。
const UI_PLUGINS = { 'ui-account': 'src/client/index.tsx' }

// 浏览器半边唯一允许 external 的 specifier —— 必须**逐字**等于 shell seed 的那批
// (packages/client/web/src/platform.ts 的 PLATFORM_MODULES)。多写一个、少写一个，
// 构建期都不报错，运行期 require 抛错 → **整个 UI 白屏**（boot 的 assertEntriesActive
// 只要有一个 entry 没 ACTIVE 就停在 loading 页）。
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
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
  const pkg = {
    name, version: VERSION, private: true, type: 'module',
    exports: { '.': './index.js', './package.json': './package.json' },
  }
  if (UI_PLUGINS[p] !== undefined) {
    // 浏览器半边:CJS + 自注册 banner/footer,格式必须与上游 tsdown.client.ts 逐字一致
    // (`window.__ModuleLoader__.load({id, factory})` 是壳与插件之间的私有约定)。
    await build({
      entryPoints: [join(ROOT, 'ar', p, UI_PLUGINS[p])],
      outfile: join(outDir, 'client.js'),
      bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
      jsx: 'automatic',
      external: PLATFORM_MODULES,
      banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {` },
      footer: { js: 'return module.exports; } });' },
      // esbuild 的 CJS 产物自带 module/exports 声明,不需要上游那条 intro。
      logLevel: 'warning',
    })
    pkg.exports['./client'] = './client.js'
    pkg.dsh = { client: { platform: 'web' } }
    console.log(`  [bundle] ${name} (含浏览器半边)`)
  }
  writeFileSync(join(outDir, 'package.json'), JSON.stringify(pkg, null, 2))
  fileDeps[name] = `file:./plugins/${p}`
  if (UI_PLUGINS[p] === undefined) console.log(`  [bundle] ${name}`)
}

// 2) 顶层 package.json:依赖 dsh + 各插件
writeFileSync(join(OUT, 'package.json'), JSON.stringify({
  name: 'knevo-ar', version: VERSION, private: true, type: 'module',
  engines: { node: '^22.19.0 || >=24' },
  description: 'Knevo（AR × dsh 形态 D）客户端 —— dsh 当 runtime,连 Knevo 云端。',
  dependencies: {
    '@deepseek-ai/dsh': DSH_VERSION,
    // web_fetch 用的原生 fetch provider —— base bundle 禁 fetch 不带它,单独装(patch 里 insert)。
    '@deepseek-ai/dsh-web-fetch-http': '0.0.1-rc.5',
    ...fileDeps,
  },
}, null, 2))

// 3.5) pnpm-workspace.yaml:**放行必要的依赖构建脚本**。
//   pnpm 10+ 默认拦下所有依赖的 install/build 脚本;放行的键是 `allowBuilds`
//   (pnpm 11;package.json 的 pnpm.onlyBuiltDependencies 与 pnpm-workspace.yaml 的
//   onlyBuiltDependencies 实测都**不生效** —— 上游 monorepo 用的就是 allowBuilds)。
//   不放行的后果是 **Linux 上直接起不来**:node-pty 只随包带 darwin/win32 预编译,
//   linux 要现场 node-gyp 编译;脚本被拦 → 无 prebuilds/linux-x64/pty.node →
//   dsh 加载 subprocess 行时硬失败(实测 dev x86_64 复现)。
//   顺带:本文件存在即让**本目录成为 workspace 根**,pnpm 不会向上走进用户的其它
//   workspace —— 所以启动器不再需要 --ignore-workspace(那反而会让本文件被忽略)。
writeFileSync(join(OUT, 'pnpm-workspace.yaml'), [
  'packages: []',
  '',
  '# 前端资源用我们随包发的副本(已改品牌),不从 npm 拉上游原装。',
  'overrides:',
  "  '@deepseek-ai/dsh-web-frontend': 'file:./vendor/dsh-web-frontend'",
  '',
  '# 只放行真正需要的构建脚本,其余一律拒绝(deny by default)。',
  'allowBuilds:',
  '  # 持久 PTY 后端:macOS/Windows 用随包预编译,Linux 需本地编译(要 python3+make+g++)。',
  '  node-pty: true',
  '  # 恢复 node-pty 预编译 spawn-helper 的可执行位(POSIX)。',
  "  '@deepseek-ai/dsh-subprocess-local': true",
  '  # JSONL 落盘在 Windows 上走 MoveFileExW。',
  '  koffi: true',
  '  # 以下脚本是我们不需要的空操作,拒绝(拒绝不影响安装成功)。',
  "  '@google/genai': false",
  '  protobufjs: false',
  '  node-addon-require-builtin: false',
  '',
].join('\n'))

// 3) profile 接线 + 启动器(从工作副本拷,过滤掉运行态/密钥)
mkdirSync(join(OUT, '.dsh-home'), { recursive: true })
// ★分发版剥掉 token 的 spike fallback:'ar-spike-2026' 会让「env 没注入」这种故障
//   静默降级成「用默认账户计费」——C 端必须 fail-loud(空 token → 明确 401/工具不可用)。
const patchSrc = readFileSync(join(ROOT, '.dsh-home', 'cordis.patch.yml'), 'utf8')
writeFileSync(join(OUT, '.dsh-home', 'cordis.patch.yml'),
  patchSrc.replaceAll(`process.env.AR_DEVICE_TOKEN || 'ar-spike-2026'`, `process.env.AR_DEVICE_TOKEN || ''`))
// ★随包发我们自己的 agent preset(.dsh-home/.agent-presets/<id>/agent.cordis.yml)。
//   人格、子 agent、web_fetch 都在 preset 层;不带它的话产品会退回上游 standard
//   预设的"编码 agent"人格。$DSH_HOME 是 agent-presets 的用户根,无需改 dsh。
cpSync(join(ROOT, '.dsh-home', '.agent-presets'), join(OUT, '.dsh-home', '.agent-presets'), { recursive: true })

for (const f of ['knevo-login.mjs', 'knevo-update.mjs', 'KNEVO-README.md']) {
  if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(OUT, f))
}

// 4) 分发版启动器。要点:
//    - 装依赖用 pnpm(npx 拉取;实测 npm 在部分代理环境静默装不出 node_modules,pnpm 稳)
//    - **不清用户代理**:npm/pnpm 拉包可能需要它(中国网络);dsh 运行时用 undici fetch,
//      本就不读 env 代理,直连 dev 公网 —— 两边各取所需,不动用户环境。
//    - token 有效性检查(--check):30 天过期/被吊销 → 触发重登录,而不是运行期哑 401。
writeFileSync(join(OUT, 'knevo.cmd'), [
  // ★本文件必须**纯 ASCII**:cmd.exe 按当前 OEM 代码页(中文 Windows 是 GBK)逐字节读
  //   批处理;UTF-8 中文的尾字节会与后一个 ASCII 字符配对,吃掉 `"` 或 `)` → 引号/块
  //   结构破裂,`||` 被当成运算符,出现「'v[0]' 不是内部或外部命令」这类怪错(实测)。
  //   chcp 65001 救不了已读入的行。所以 cmd 内文案一律英文;中文提示交给 node 脚本
  //   (chcp 让它们在控制台正确显示)。
  '@echo off',
  'chcp 65001 >nul',
  'rem Knevo client launcher (Windows). First run: install deps + device login.',
  'setlocal',
  'set DSH_HOME=%~dp0.dsh-home',
  'cd /d %~dp0',
  'rem Node version gate: dsh needs ^22.19 or >=24 (node:zlib zstd).',
  `node -e "${NODE_GUARD}" || exit /b 1`,
  'rem Gate on the real artifact, not on the node_modules dir: a half-finished',
  'rem install would otherwise be skipped forever and the launcher would die',
  'rem with "path not found". Re-running pnpm heals a partial install.',
  'if not exist "node_modules\\.bin\\dsh.CMD" (',
  '  echo Installing dependencies, a few minutes. Safe to interrupt: rerun this script to resume.',
  '  call npx -y pnpm@11.7.0 install || goto :installfail',
  ')',
  'if not exist "node_modules\\.bin\\dsh.CMD" goto :installfail',
  'if exist "%DSH_HOME%\\.device-token" (',
  '  node "%~dp0knevo-login.mjs" --check || (',
  '    echo Device login expired, please sign in again.',
  '    del "%DSH_HOME%\\.device-token"',
  '    node "%~dp0knevo-login.mjs"',
  '  )',
  ') else (',
  '  echo First run: please sign in. No account yet? Register at https://dev.ar.knevo.ai',
  '  node "%~dp0knevo-login.mjs"',
  ')',
  'if not exist "%DSH_HOME%\\.device-token" goto :nologin',
  'set /p AR_DEVICE_TOKEN=<"%DSH_HOME%\\.device-token"',
  'echo Starting Knevo, connecting dev.ar.knevo.ai. First boot takes 1-3 min, then open http://127.0.0.1:3180',
  'node_modules\\.bin\\dsh --profile web --port 3180',
  'goto :eof',
  ':installfail',
  'echo Dependency install incomplete. Check your network and rerun this script.',
  'exit /b 1',
  ':nologin',
  'echo Sign-in not completed, exiting.',
  'exit /b 1',
  'endlocal', '',
].join('\r\n'))
writeFileSync(join(OUT, 'knevo.sh'), [
  '#!/usr/bin/env bash',
  '# Knevo 客户端启动器(macOS/Linux)。首次:装依赖(几分钟)+ 登录换设备 token。',
  'set -e; cd "$(dirname "$0")"',
  'export DSH_HOME="$PWD/.dsh-home"',
  '# ★Node 版本闸:dsh 要求 ^22.19 || >=24(node:zlib 的 zstd 22.15 起才有);',
  '# 版本偏低会抛「createZstdDecompress 不存在」的语法错,用户无从判断。',
  `node -e "${NODE_GUARD}"`,
  '# 判据用真正需要的产物(./node_modules/.bin/dsh),不是 node_modules 目录是否存在:',
  '# 首装耗时数分钟,中断会留下残缺目录;按目录判定会让之后每次启动都跳过安装并卡死。',
  '[ -x ./node_modules/.bin/dsh ] || { echo "安装依赖中,约需几分钟(中断了重跑本脚本会自动续装)..."; npx -y pnpm@11.7.0 install; }',
  '[ -x ./node_modules/.bin/dsh ] || { echo "依赖未安装完整,请重新运行本脚本。"; exit 1; }',
  '# node-pty 的 spawn-helper 需要可执行位(POSIX)。正常由 dsh-subprocess-local 的',
  '# postinstall 补,已在 pnpm-workspace.yaml 的 allowBuilds 里放行;这里再兜一次底,',
  '# 以防用户的 pnpm 版本对 allowBuilds 语义不同 —— 少了它 PTY/shell 类工具会起不来。',
  'for f in ./node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*/spawn-helper \\',
  '         ./node_modules/.pnpm/node-pty@*/node_modules/node-pty/build/Release/spawn-helper \\',
  '         ./node_modules/node-pty/prebuilds/*/spawn-helper \\',
  '         ./node_modules/node-pty/build/Release/spawn-helper; do',
  '  [ -f "$f" ] && chmod 755 "$f" 2>/dev/null || true',
  'done',
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

// 4.4) 自托管并改品牌的前端资源(MIT:上游 LICENSE 随包保留,见 THIRD-PARTY-NOTICES.txt)。
//   只改可见品牌文本(标题 / PWA 名称);wordmark 图形按产品决定暂留上游原样。
const feDir = join(OUT, 'vendor', 'dsh-web-frontend')
const feCache = join(ROOT, '.fe-cache')
mkdirSync(feCache, { recursive: true })
const feTgz = `deepseek-ai-dsh-web-frontend-${FE_VERSION}.tgz`
if (!existsSync(join(feCache, feTgz))) {
  console.log('[build] 拉取前端发布包…')
  execSync(`npm pack @deepseek-ai/dsh-web-frontend@${FE_VERSION}`, { cwd: feCache, stdio: 'inherit' })
}
mkdirSync(feDir, { recursive: true })
// tar 在 Windows 上会把 `-C D:\...` 的盘符当远程主机 —— 把包拷进目标目录用相对路径解。
cpSync(join(feCache, feTgz), join(feDir, feTgz))
execSync(`tar --force-local -xzf "${feTgz}" --strip-components=1`, { cwd: feDir, stdio: 'inherit' })
rmSync(join(feDir, feTgz), { force: true })

// 改品牌:页面标题 + PWA 名称 + **图标**
const feDist = join(feDir, 'dist')
const feIndex = join(feDist, 'index.html')

// 图标:换成 Knevo 自己的。上游的 favicon.svg(鲸鱼)直接删掉 —— 留着它就还能被
// 请求到,浏览器标签页/PWA 安装图标都可能仍显示上游品牌。
cpSync(join(ROOT, 'assets', 'brand', BRAND.icon), join(feDist, BRAND.icon))
rmSync(join(feDist, 'favicon.svg'), { force: true })
writeFileSync(feIndex, readFileSync(feIndex, 'utf8')
  .replace(/<title>[^<]*<\/title>/, `<title>${BRAND.title}</title>`)
  // 上游是 <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  .replace(/<link[^>]*rel="icon"[^>]*>/,
    `<link rel="icon" type="image/png" href="/${BRAND.icon}" />`))

const feManifest = join(feDist, 'manifest.webmanifest')
if (existsSync(feManifest)) {
  const mf = JSON.parse(readFileSync(feManifest, 'utf8'))
  if (mf.name) mf.name = BRAND.title
  if (mf.short_name) mf.short_name = BRAND.short
  mf.icons = [{ src: `/${BRAND.icon}`, sizes: '512x512', type: 'image/png', purpose: 'any' }]
  writeFileSync(feManifest, JSON.stringify(mf, null, 2))
}

// 品牌闸:标题、图标引用、图标文件、以及**上游 favicon 已清除**,四项都得过,
// 任一没改成功就别发 —— 品牌漏出去比构建失败糟得多。
const idxHtml = readFileSync(feIndex, 'utf8')
if (!idxHtml.includes(`<title>${BRAND.title}</title>`)) {
  throw new Error('[build] 前端标题未改成功,中止')
}
if (!idxHtml.includes(`href="/${BRAND.icon}"`) || idxHtml.includes('favicon.svg')) {
  throw new Error('[build] 前端图标未换成 Knevo 图标(或仍引用上游 favicon),中止')
}
if (!existsSync(join(feDist, BRAND.icon)) || existsSync(join(feDist, 'favicon.svg'))) {
  throw new Error('[build] 图标文件未就位 / 上游 favicon 未清除,中止')
}
console.log('[build] 前端资源已自托管并改品牌(含图标)')

// 第三方许可声明(MIT 要求随副本分发版权与许可声明;界面无需出现)
const upstreamLicense = existsSync(join(feDir, 'LICENSE')) ? readFileSync(join(feDir, 'LICENSE'), 'utf8') : ''
writeFileSync(join(OUT, 'THIRD-PARTY-NOTICES.txt'), [
  'Knevo 客户端包含以下第三方组件。',
  '',
  '── @deepseek-ai/dsh 及其组件(含 dsh-web-frontend;本包内含其修改副本)──',
  '本产品分发的前端资源基于 @deepseek-ai/dsh-web-frontend 修改而来。',
  '原始项目按 MIT 许可发布,许可与版权声明如下:',
  '',
  upstreamLicense.trim(),
  '',
  '其余依赖的许可证随各自的 npm 包分发,见安装后的 node_modules 目录。',
  '',
].join('\n'))

// 4.5) ★泄密闸:分发包是**公开可下载**的(/releases/download 无鉴权),任何明文 token
//      常量进包 = 免注册后门(配 dev 的 env fallback 可直接冒充默认账户白嫖/错记账)。
//      此前就漏过一次:replaceAll 只清了 fallback 表达式,注释里的同一常量原样打包。
//      这里对**全部产物**做一次扫描,命中即让构建失败——比靠人记得改注释可靠。
const FORBIDDEN = [/ar-spike-2026/i, /AR_DEVICE_DEV_TOKEN\s*=\s*\S+/i, /sk-[A-Za-z0-9]{16,}/]
function scanForSecrets(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      scanForSecrets(p)
      continue
    }
    let text
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      continue // 二进制,跳过
    }
    for (const re of FORBIDDEN) {
      const m = text.match(re)
      if (m) {
        throw new Error(`[build] 拒绝打包:${p} 含疑似机密「${m[0]}」——分发包公开可下载,清理后重试。`)
      }
    }
  }
}
scanForSecrets(OUT)
console.log('[build] 泄密闸通过(产物无明文 token 常量)')

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
