#!/usr/bin/env node
/**
 * 文档一致性检查：让 Spec / ADR / 工具文档跟着代码一起演进。
 *
 * 检查项：
 *   1. 必需文档存在（README / AGENTS / docs/{README,tools} / spec / ADR 索引）；
 *   2. 每篇 ADR 有标题、状态、背景/决策/后果，且被索引列出；
 *   3. docs/tools.md 的 `## cicd_*` 章节与代码注册的工具完全一致；
 *   4. 文档里的相对链接都能解析到真实文件。
 *
 * 由 `pnpm check` 调用；不通过就退出码 1。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

function check(ok, message) {
  if (!ok)
    problems.push(message)
}

function read(rel) {
  return readFileSync(join(root, rel), 'utf8')
}

/* 1. 必需文档 */
const REQUIRED = [
  'README.md',
  'AGENTS.md',
  'docs/README.md',
  'docs/tools.md',
  'docs/spec/spec.md',
  'docs/adr/README.md',
]
for (const file of REQUIRED) check(existsSync(join(root, file)), `缺少必需文档：${file}`)

/* 2. ADR */
const adrDir = join(root, 'docs/adr')
const adrFiles = existsSync(adrDir)
  ? readdirSync(adrDir).filter(file => /^\d{4}-.+\.md$/.test(file)).sort()
  : []
check(adrFiles.length > 0, 'docs/adr 下一篇 ADR 都没有')

const adrIndexPath = join(adrDir, 'README.md')
const adrIndex = existsSync(adrIndexPath) ? readFileSync(adrIndexPath, 'utf8') : ''
for (const file of adrFiles) {
  const text = readFileSync(join(adrDir, file), 'utf8')
  const num = file.slice(0, 4)
  check(adrIndex.includes(file), `ADR 索引 docs/adr/README.md 没有列出 ${file}`)
  check(new RegExp(`^# ADR-${num}[:：]`, 'm').test(text), `${file}：标题应为 "# ADR-${num}: ..."`)
  check(/^- 状态：\S+/m.test(text), `${file}：缺少 "- 状态：..."`)
  for (const section of ['## 背景', '## 决策', '## 后果']) {
    check(text.includes(section), `${file}：缺少章节 ${section}`)
  }
}

/* 3. 工具文档 vs 代码注册 */
let toolNames = []
try {
  const moduleUrl = pathToFileURL(join(root, 'lib/tool-defs.js')).href
  const { buildToolDefinitions } = await import(moduleUrl)
  const tools = buildToolDefinitions({ defineTool: spec => spec, runner: {}, options: {} })
  toolNames = tools.map(tool => tool.name)
}
catch (error) {
  problems.push(`无法加载 lib/tool-defs.js（先执行 pnpm build）：${error.message}`)
}

const toolsDoc = existsSync(join(root, 'docs/tools.md')) ? read('docs/tools.md') : ''
const documented = [...toolsDoc.matchAll(/^## (cicd_[a-z_]+)\s*$/gm)].map(match => match[1])
for (const name of toolNames) {
  check(documented.includes(name), `docs/tools.md 缺少工具章节：## ${name}`)
}
for (const name of documented) {
  check(toolNames.includes(name), `docs/tools.md 多出代码里不存在的工具章节：## ${name}`)
}

/* 4. 相对链接 */
const mdFiles = [
  'README.md',
  'AGENTS.md',
  'docs/README.md',
  'docs/tools.md',
  'docs/upstream.md',
  'docs/spec/spec.md',
  ...adrFiles.map(file => join('docs/adr', file)),
]
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g
for (const rel of mdFiles) {
  if (!existsSync(join(root, rel)))
    continue
  const text = read(rel)
  for (const match of text.matchAll(LINK_RE)) {
    let target = match[1].trim()
    if (/^(?:https?:|mailto:|#)/.test(target))
      continue
    target = target.replace(/^<|>$/g, '').split('#')[0]
    if (!target)
      continue
    const abs = resolve(dirname(join(root, rel)), target)
    check(existsSync(abs), `${rel}：链接目标不存在 -> ${target}`)
  }
}

/* 5. AGENTS.md 必须指向规格与 ADR（让智能体知道去哪看） */
if (existsSync(join(root, 'AGENTS.md'))) {
  const agents = read('AGENTS.md')
  check(agents.includes('docs/spec/spec.md'), 'AGENTS.md 没有指向 docs/spec/spec.md')
  check(agents.includes('docs/adr'), 'AGENTS.md 没有指向 docs/adr')
}

if (problems.length > 0) {
  console.error(`文档检查失败（${problems.length} 项）：`)
  for (const problem of problems) console.error(` - ${problem}`)
  process.exit(1)
}

console.log(`文档检查通过：${REQUIRED.length} 个必需文件、${adrFiles.length} 篇 ADR、${toolNames.length} 个工具、${mdFiles.length} 份文档。`)
