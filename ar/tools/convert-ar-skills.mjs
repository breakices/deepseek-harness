/**
 * Convert AR skill registries (ar_backend/skills/<domain>/<kind>/<slug>/skill.md)
 * into dsh skill-filesystem bundles (<dest>/<slug>/SKILL.md).
 *
 * dsh requires kebab-case `name` while AR uses a Chinese display name, so the
 * directory slug becomes `name` and the original value is kept as `x-ar-name`
 * (dsh parses frontmatter as an open object and ignores unknown fields). All
 * other frontmatter lines and the body pass through byte-identical — no YAML
 * parsing, so odd scalars cannot be mangled. Sibling resource files copy over.
 *
 * Usage: node ar/tools/convert-ar-skills.mjs [srcDomainDir] [destSkillsDir]
 */

import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const src = resolve(process.argv[2] ?? join(repoRoot, '..', 'ar_backend', 'skills', 'general'))
const dest = resolve(process.argv[3] ?? join(repoRoot, '.dsh-home', 'skills'))

/** Recursively find every skill.md under src. */
function findSkillFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...findSkillFiles(p))
    else if (entry === 'skill.md') out.push(p)
  }
  return out
}

/** Replace the frontmatter `name:` line with the slug, keeping the original as x-ar-name. */
function convertFrontmatter(text, slug) {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') throw new Error('no frontmatter')
  const end = lines.indexOf('---', 1)
  if (end === -1) throw new Error('unterminated frontmatter')
  let renamed = false
  for (let i = 1; i < end; i++) {
    if (lines[i].startsWith('name:')) {
      lines[i] = `x-ar-name:${lines[i].slice('name:'.length)}`
      renamed = true
      break
    }
  }
  if (!renamed) throw new Error('no name: line in frontmatter')
  lines.splice(1, 0, `name: ${slug}`)
  return lines.join('\n')
}

let converted = 0
for (const file of findSkillFiles(src)) {
  const skillDir = dirname(file)
  const slug = basename(skillDir)
  const outDir = join(dest, slug)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'SKILL.md'), convertFrontmatter(readFileSync(file, 'utf8'), slug))
  for (const entry of readdirSync(skillDir)) {
    if (entry === 'skill.md') continue
    cpSync(join(skillDir, entry), join(outDir, entry), { recursive: true })
  }
  converted++
  console.log(`converted: ${slug}`)
}
console.log(`${converted} skill(s) -> ${dest}`)
