/**
 * 装完依赖后，把这套安装「变成我们的产品」：改掉上游残留的品牌文案，并把内置的
 * agent 预设适配成 Knevo 的。
 *
 * 为什么必须在装完之后就地改，而不是在构建时准备好：
 *
 * 1. **标语**在 `@deepseek-ai/dsh-client-ui-conversation` **包内的 locale 表**里（运行期
 *    下发的 client bundle，不在我们自托管的前端壳里）。两条常规路都不通：
 *      • dsh 的 locale **不支持覆盖** —— `register()` 遇同名空间直接抛错
 *        （packages/client/locale/src/client/index.ts:228）；
 *      • `pnpm overrides` 指向 vendor 副本**不可靠** —— pnpm 会按 peer 组合为同一个包
 *        建多个实例，实测装出两份、运行期解析到的是 npm 那份。
 *
 * 2. **预设**装在 dsh 包自己的 `config/agent-presets/`，由 CLI 按自身路径解析成 `system`
 *    信任的 shipped root（apps/cli/src/profile-boot.ts:35/164）。而 `discoverPresets` 是
 *    **先者胜**、用户根（`$DSH_HOME/.agent-presets`）**最后**追加（index.ts:134）——
 *    所以放在用户根里的同名预设**盖不过**内置的。profile-boot 还会在我们的 patch 之后
 *    强行把 `roots` 覆盖成 shipped root，config 也改不了。只能改文件。
 *
 * 幂等（改过就跳过）；找不到锚点只告警不失败 —— 品牌没换干净，总好过客户端起不来。
 */
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BRAND_TITLE = 'Knevo'
const SLOGAN = '知无涯'

// ── 1. 标语 ──────────────────────────────────────────────────────────────────

const TEXT_REPLACEMENTS = [
  ['"hero.headline": "探索未至之境"', `"hero.headline": "${SLOGAN}"`],
  ['"hero.headline": "Into the Unknown"', `"hero.headline": "${BRAND_TITLE}"`],
  // 「预览版 / Preview」角标同属上游 hero 文案，一并去掉（留空 = 不渲染角标）
  ['"hero.preview": "预览版"', '"hero.preview": ""'],
  ['"hero.preview": "Preview"', '"hero.preview": ""'],
]
const UI_CONV_REL = join('node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js')

// ── 2. 预设 ──────────────────────────────────────────────────────────────────

/** 上游 persona 原文（三个保留的预设里逐字相同的那句）。 */
const UPSTREAM_PERSONA = 'You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.'

/** Knevo 的研究人格（与 .dsh-home/cordis.patch.yml 的 persona 同源）。 */
const RESEARCH_PERSONA = [
  "You are Oryx-RE, Knevo's long-horizon research assistant, running on {{model}}. Your working directory is {{cwd}}.",
  '',
  '研究纪律（高于一切）：',
  '- 结论必须有来源。用 web_search 检索、web_fetch 抓正文核实；引用只能是你**真实抓取过**的链接，绝不凭记忆编造 URL、标题或数字。',
  '- 交叉验证。关键事实至少两个独立来源；来源冲突时把分歧写出来，不要偷偷选一个。',
  '- 诚实标注不确定。查不到就说查不到，不要用推测填补证据缺口。',
  '- 时间敏感的问题先确认「最新」的时点，别把旧结论当现状。',
  '',
  '工作方式：',
  '- 长任务先用 todo_write 拆解，按步推进；目标状态用 goal 工具维护，不靠对话记忆。',
  '- 可并行、可隔离的子问题用 subagent 分工（各自带回证据与来源），你负责汇总与裁决。',
  '- 重要发现用 research_memory_write 记入长期记忆（带来源 URL），后续会话会自动检索回来。',
  '- 下重要结论、交付报告前，用 peer_review 请独立模型审一遍，并按意见修正。',
  '',
  '产出：',
  '- 报告、数据、图表一律写进工作区文件，路径用工作区相对路径，不要用本机绝对路径。',
  '- **要看图片内容用 describe_image**（主模型不收图，直接读图会被拒）；生成图片用 generate_image。',
  '- 正文里给出可点击的真实引用链接；必要时附来源清单。',
  '- 回复用用户使用的语言；先给结论，再给依据，最后给不确定性与后续建议。',
]

/** 不联网的极简模式用另一段人格：许诺不了的能力就别写进提示词。 */
const MINIMAL_PERSONA = [
  "You are Oryx-RE, Knevo's research assistant, running on {{model}}. Your working directory is {{cwd}}.",
  '',
  '本模式**不联网**：只有持久 Shell 与文件编辑两件工具。',
  '- 需要外部资料时，直接告诉用户「本模式不能联网，请切换到研究模式」，不要假装查过。',
  '- 适合纯本地的整理、改写、批处理与脚本执行。',
  '- 结论只依据工作区里真实存在的文件内容，不要凭记忆补充事实。',
]

/** 每个内置预设怎么处理。缺席的（cordis）会被删掉。 */
const PRESETS = {
  standard: {
    persona: RESEARCH_PERSONA,
    enableFetch: true,
  },
  code: {
    persona: RESEARCH_PERSONA,
    enableFetch: true,
  },
  minimal: {
    persona: MINIMAL_PERSONA,
    enableFetch: false,          // 它本来就没有 web 工具行，加了也无处可加
  },
}

/** 不该给终端用户的:它能读写自己运行的 runtime 并创作 preset。 */
const DROP_PRESETS = ['cordis']

const INDENT = '      '   // persona 文本块的缩进（config.text 下两级）

function patchPreset(dir, id, spec) {
  const yml = join(dir, id, 'agent.cordis.yml')
  let src
  try { src = readFileSync(yml, 'utf8') } catch { return 'missing' }

  let changed = false
  const block = `    text: |-\n${spec.persona.map((l) => (l ? INDENT + l : '')).join('\n')}`
  // 上游的人格行有两种形态，都要认：
  //   • standard / code：折叠标量 `>-` + 那句 "You are a coding agent..."
  //     （`>-` 会把换行折成空格，我们的人格有意义的换行，所以换成 `|-`）
  //   • minimal：单行 `text: ...` + `complete: true`（它的 persona 就是完整系统提示词）
  const folded = `    text: >-\n${INDENT}${UPSTREAM_PERSONA}`
  if (src.includes(folded)) {
    src = src.replace(folded, block)
    changed = true
  } else {
    const inline = src.match(/^ {4}text: You are a [^\n]*$/m)
    if (inline) {
      src = src.replace(inline[0], block)
      changed = true
    }
  }
  // 联网：上游预设一律 fetch:false（编码 agent 不需要抓正文），调研必须开
  if (spec.enableFetch) {
    const webAt = src.indexOf('- id: tool-web')
    if (webAt >= 0) {
      const tail = src.slice(webAt)
      if (tail.includes('fetch: false')) {
        src = src.slice(0, webAt) + tail.replace('fetch: false', 'fetch: true')
        changed = true
      }
    }
  }
  if (changed) writeFileSync(yml, src)

  // **不改模式名与描述**:模式名是 dsh 的执行策略词汇(标准/PTC/极简),不是品牌,
  //   保留它反而更准确;而且实测内置预设的显示名不走 preset.yml,改了界面也不变。
  return changed ? 'patched' : 'already'
}

/** 找到装好的 dsh 包自带的 shipped preset 根。 */
function findPresetRoots(root) {
  const store = join(root, 'node_modules', '.pnpm')
  const out = []
  let entries = []
  try { entries = readdirSync(store) } catch { return out }
  for (const e of entries) {
    const d = join(store, e, 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets')
    try { if (statSync(d).isDirectory()) out.push(d) } catch { /* 不是这个包 */ }
  }
  return out
}

function findFiles(root, rel) {
  const store = join(root, 'node_modules', '.pnpm')
  const out = []
  let entries = []
  try { entries = readdirSync(store) } catch { return out }
  for (const e of entries) {
    const f = join(store, e, rel)
    try { if (statSync(f).isFile()) out.push(f) } catch { /* 不是这个包 */ }
  }
  return out
}

const root = process.cwd()

// —— 标语 ——
{
  const files = findFiles(root, UI_CONV_REL)
  let changed = 0, already = 0
  for (const f of files) {
    let src = readFileSync(f, 'utf8')
    if (TEXT_REPLACEMENTS.every(([, to]) => src.includes(to))) { already++; continue }
    let hit = false
    for (const [from, to] of TEXT_REPLACEMENTS) {
      if (src.includes(from)) { src = src.replaceAll(from, to); hit = true }
    }
    if (hit) { writeFileSync(f, src); changed++ }
  }
  if (files.length === 0) console.log('[brand] 未找到 ui-conversation 副本，跳过标语')
  else if (changed === 0 && already === 0) {
    console.warn('[brand] 警告：ui-conversation 里没找到已知的标语文案，上游可能已改版')
  } else console.log(`[brand] 标语「${SLOGAN}」（改 ${changed} 份，${already} 份已改）`)
}

// —— 预设 ——
{
  const roots = findPresetRoots(root)
  if (roots.length === 0) {
    console.warn('[brand] 警告：未找到内置 agent 预设目录，模式仍是上游的编码 Agent')
  }
  for (const dir of roots) {
    const done = []
    for (const [id, spec] of Object.entries(PRESETS)) done.push(`${id}:${patchPreset(dir, id, spec)}`)
    for (const id of DROP_PRESETS) {
      try { rmSync(join(dir, id), { recursive: true, force: true }); done.push(`${id}:removed`) } catch { /* 已不在 */ }
    }
    console.log(`[brand] 预设已适配（${done.join('，')}）`)
  }
}
