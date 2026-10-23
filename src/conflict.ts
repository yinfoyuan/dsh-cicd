/**
 * 云效分支管理器「合并冲突」信息解析。
 *
 * 运行日志里包含冲突文件、release/feature 分支、仓库地址等信息；
 * 这里只做只读解析，供 `cicd_conflict` 工具把结构化信息交给模型和用户。
 */
import { tail } from './state.js'

export interface ConflictInfo {
  hasConflict: boolean
  paused: boolean
  conflictFiles: string[]
  releaseBranch?: string
  baseBranch?: string
  featureBranches: string[]
  repoUrl?: string
  conflictBranch?: string
  logTail: string
}

function firstMatch(log: string, pattern: RegExp): string | undefined {
  const match = log.match(pattern)
  return match?.[1]?.trim() || undefined
}

/** 从一份日志里提取冲突信息；没有冲突标记时 hasConflict=false。 */
export function parseConflictInfo(log: string): ConflictInfo {
  const text = String(log ?? '')
  const conflictFiles = [...new Set([
    ...Array.from(text.matchAll(/冲突（内容）：合并冲突于\s*(.+)/g), match => match[1]),
    ...Array.from(text.matchAll(/CONFLICT \(content\): Merge conflict in\s*(.+)/gi), match => match[1]),
    ...Array.from(text.matchAll(/Merge conflict in\s+(.+)/gi), match => match[1]),
  ].map(item => item.trim()).filter(Boolean))]

  const featureBranches = (firstMatch(text, /FEATURE_BRANCHS=([^\n]+)/) ?? '')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(Boolean)

  const paused = /Merge conflicted,\s*job paused/i.test(text)
  const hasConflict = paused
    || conflictFiles.length > 0
    || /合并冲突|Merge conflicted/i.test(text)

  return {
    hasConflict,
    paused,
    conflictFiles,
    releaseBranch: firstMatch(text, /RELEASE_BRANCH_NAME=([^\n]+)/),
    baseBranch: firstMatch(text, /BASE_BRANCH_NAME=([^\n]+)/),
    featureBranches: [...new Set(featureBranches)],
    repoUrl: firstMatch(text, /REPO_URL=([^\n]+)/),
    conflictBranch: firstMatch(text, /合并\s*([^\s时]+)时出现冲突/),
    logTail: tail(text, 120, 8_000),
  }
}
