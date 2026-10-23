import type { RunRecord, RunStatus } from './types.js'
/**
 * 运行记录的落盘与读取。
 *
 * 每个项目在 `<项目根>/.dsh/cicd-runs/` 下有两份文件：
 *   <runId>.json  运行记录（状态、退出码、外部 id、链接…）
 *   <runId>.log   shell 流水线的完整输出
 * 索引就是目录本身：按 runId 里的时间前缀排序即可。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const RUN_ID_RE = /^[\w.-]{1,120}$/

export function ensureRunsDir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function makeRunId(name: string): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const rand = Math.random().toString(36).slice(2, 6)
  const safe = name.replace(/[^\w-]/g, '_').slice(0, 24)
  return `${stamp}-${safe}-${rand}`
}

function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId))
    throw new Error(`非法 runId：${runId}`)
}

export function recordPath(dir: string, runId: string): string {
  assertRunId(runId)
  return join(dir, `${runId}.json`)
}

export function logPath(dir: string, runId: string): string {
  assertRunId(runId)
  return join(dir, `${runId}.log`)
}

export function saveRecord(dir: string, record: RunRecord): void {
  ensureRunsDir(dir)
  const target = recordPath(dir, record.runId)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  renameSync(tmp, target)
}

export function loadRecord(dir: string, runId: string): RunRecord | null {
  const file = recordPath(dir, runId)
  if (!existsSync(file))
    return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RunRecord
  }
  catch {
    return null
  }
}

/** 最近 N 次运行，新的在前。 */
export function listRecords(dir: string, limit = 30): RunRecord[] {
  if (!existsSync(dir))
    return []
  const entries: Array<{ runId: string, mtime: number }> = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json'))
      continue
    const runId = file.slice(0, -5)
    if (!RUN_ID_RE.test(runId))
      continue
    let mtime = 0
    try {
      mtime = statSync(join(dir, file)).mtimeMs
    }
    catch {}
    entries.push({ runId, mtime })
  }
  entries.sort((a, b) => b.mtime - a.mtime)
  return entries
    .slice(0, limit)
    .map(e => loadRecord(dir, e.runId))
    .filter((record): record is RunRecord => Boolean(record))
}

export function latestRecord(dir: string, pipelineName?: string): RunRecord | null {
  return listRecords(dir, 80).find(record => record.pipeline === pipelineName) ?? null
}

/** 保留最近 max 条运行记录，清掉更老的 json/log。 */
export function prune(dir: string, max = 200): string {
  const records = listRecords(dir, 10_000)
  for (const record of records.slice(max)) {
    for (const file of [recordPath(dir, record.runId), logPath(dir, record.runId)]) {
      try {
        unlinkSync(file)
      }
      catch {}
    }
  }
  return dir
}

export function tail(text: string | null | undefined, lines = 120, maxChars = 20_000): string {
  if (!text)
    return ''
  const arr = String(text).replace(/\r\n/g, '\n').split('\n')
  let out = arr.slice(Math.max(0, arr.length - lines)).join('\n')
  if (out.length > maxChars)
    out = `…（已截断前 ${out.length - maxChars} 字符）\n${out.slice(-maxChars)}`
  return out.trimEnd()
}

export function readLogTail(dir: string, runId: string, lines: number, maxChars: number): string {
  const file = logPath(dir, runId)
  if (!existsSync(file))
    return ''
  try {
    return tail(readFileSync(file, 'utf8'), lines, maxChars)
  }
  catch {
    return ''
  }
}

export const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'succeeded',
  'failed',
  'canceled',
  'lost',
])

/**
 * 分支选择的本地记忆：`<项目>/.dsh/cicd-branches.json`。
 *
 * 只记「最近一次确认选中的」和「明确移除的」，不替云效做决定：
 * 下次弹窗 = 云效上次分支 ∪ 本地选中 − 本地移除。
 * 这样别人在云效新加的分支仍会出现，而用户取消过的分支不会复活。
 */
export interface BranchSelection {
  selected: string[]
  removed: string[]
}

function branchSelectionPath(root: string): string {
  return join(root, '.dsh', 'cicd-branches.json')
}

function normalizeBranches(value: unknown): string[] {
  if (!Array.isArray(value))
    return []
  return [...new Set(value.map(item => String(item).trim()).filter(Boolean))]
}

export function readBranchSelection(root: string, pipeline: string): BranchSelection | null {
  try {
    const raw = JSON.parse(readFileSync(branchSelectionPath(root), 'utf8'))
    const value = raw?.[pipeline]
    // 兼容旧格式：数组 = selected，没有移除记录。
    if (Array.isArray(value))
      return { selected: normalizeBranches(value), removed: [] }
    if (value && typeof value === 'object') {
      return {
        selected: normalizeBranches((value as { selected?: unknown }).selected),
        removed: normalizeBranches((value as { removed?: unknown }).removed),
      }
    }
    return null
  }
  catch {
    return null
  }
}

export function saveBranchSelection(
  root: string,
  pipeline: string,
  selected: string[],
  removed: string[] = [],
): void {
  const file = branchSelectionPath(root)
  let all: Record<string, unknown> = {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw && typeof raw === 'object')
      all = raw as Record<string, unknown>
  }
  catch {}
  all[pipeline] = {
    selected: normalizeBranches(selected),
    removed: normalizeBranches(removed),
  }
  try {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, 'utf8')
  }
  catch {}
}
