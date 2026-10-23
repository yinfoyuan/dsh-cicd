import type { EnvironmentTier, Pipeline, RunRecord, RunStatus } from './types.js'
/**
 * 给模型看的文本格式：流水线清单和单次运行详情。
 */
import { durationText } from './runner.js'

export const ICON: Record<RunStatus, string> = {
  running: '⏳',
  succeeded: '✅',
  failed: '❌',
  canceled: '⛔',
  lost: '❓',
}

export function fmtTime(iso?: string): string {
  if (!iso)
    return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime()))
    return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 环境标签：只展示 `[environment]`；旧配置没有 environment 时回退 tier。 */
export function environmentLabel(value: { environment?: string, tier?: EnvironmentTier }): string {
  const name = String(value.environment ?? '').trim()
  const tier = value.tier && value.tier !== 'other' ? value.tier : ''
  const label = name || tier
  return label ? `[${label}]` : ''
}

export function pipelineSummaryLine(pipeline: Pipeline, latest: RunRecord | null): string {
  const lock = pipeline.confirm ? ' 🔒' : ''
  const env = environmentLabel(pipeline)
  const last = latest
    ? `最近：${ICON[latest.status] ?? ''} ${latest.status} ${fmtTime(latest.startedAt)}${latest.durationMs ? ` (${durationText(latest.durationMs)})` : ''}`
    : '最近：还没跑过'
  const desc = pipeline.description ? ` - ${pipeline.description}` : ''
  return `- ${pipeline.name}${lock} [${pipeline.type}]${env ? ` ${env}` : ''}${desc}\n  ${last}`
}

export function recordText(record: RunRecord): string {
  const lines = [
    `${ICON[record.status] ?? '•'} ${record.pipeline} · ${record.status}`,
    `runId:   ${record.runId}`,
    `title:   ${record.title ?? ''}`,
    `type:    ${record.type}`,
  ]
  const env = environmentLabel(record)
  if (env)
    lines.push(`environment: ${env.slice(1, -1)}`)
  lines.push(`started: ${fmtTime(record.startedAt)}`)
  if (record.finishedAt)
    lines.push(`finished:${fmtTime(record.finishedAt)}`)
  if (record.durationMs)
    lines.push(`duration:${durationText(record.durationMs)}`)
  else if (record.status === 'running')
    lines.push(`elapsed: ${durationText(Date.now() - new Date(record.startedAt).getTime())}`)
  if (record.exitCode !== undefined && record.exitCode !== null)
    lines.push(`exitCode:${record.exitCode}`)
  if (record.rawStatus)
    lines.push(`rawStatus: ${record.rawStatus}`)
  if (record.branches?.length)
    lines.push(`branches: ${record.branches.join('、')}`)
  if (record.progress)
    lines.push(`progress:  ${record.progress}`)
  if (record.url)
    lines.push(`url:     ${record.url}`)
  if (record.note)
    lines.push(`note:    ${record.note}`)
  if (record.checkError) {
    lines.push(`checkError: ${record.checkError}`)
    if (record.checkErrorRetryable === false)
      lines.push('（这个错误重试不会恢复：先检查 token / 权限 / 配置，再重新查询）')
  }
  return lines.join('\n')
}
