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

const FOLLOW_UP_STATUS: Record<RunStatus, string> = {
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  canceled: '已取消',
  lost: '状态丢失',
}

/**
 * 后台终态唤醒模型时发的一条消息：只给「发生了什么」和边界说明，
 * 「接下来做什么」由模型按会话上下文里的用户原话决定。
 */
export function followUpText(record: RunRecord, hint = ''): string {
  const env = environmentLabel(record)
  const duration = record.durationMs ? `（${durationText(record.durationMs)}）` : ''
  const lines = [
    `【dsh-cicd 后台通知】${env ? `${env} ` : ''}${record.title || record.pipeline} 已结束：${ICON[record.status] ?? '•'} ${FOLLOW_UP_STATUS[record.status] ?? record.status}${duration}`,
    `runId:   ${record.runId}`,
    record.progress ? `progress: ${record.progress}` : '',
    record.url ? `url:     ${record.url}` : '',
    record.note ? `note:    ${record.note}` : '',
    hint ? `提示:    ${hint}` : '',
    '',
    '这是插件自动唤醒的消息，不是用户的新发言。用户此前要求继续跟进这次运行，请按会话上下文继续；',
    '如果计划已变，或下一步是不可逆操作（例如部署），先向用户确认再做。',
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * 分支集成冲突暂停时唤醒模型：告诉它运行没结束、需要人工合并，并指引用 cicd_conflict 读取详情。
 */
export function conflictWakeText(record: RunRecord): string {
  const env = environmentLabel(record)
  return [
    `【dsh-cicd 后台通知】${env ? `${env} ` : ''}${record.title || record.pipeline} 在分支集成阶段检测到合并冲突，运行暂停等待人工处理（不是终态）。`,
    `runId:   ${record.runId}`,
    record.progress ? `progress: ${record.progress}` : '',
    record.note ? `note:    ${record.note}` : '',
    '',
    `请用 cicd_conflict { "runId": "${record.runId}" } 读取冲突文件和分支，和用户确认合并方案；不要自动合并，也不要等待。`,
    '用户在云效点「Conflict Resolved」后后台跟踪会继续；完成/失败时会再唤醒你一次。',
    '（这是插件自动唤醒的消息，不是用户的新发言。）',
  ].filter(Boolean).join('\n')
}

/**
 * 检测到运行在等人工操作（人工卡点等）时唤醒模型：提示用户去云效处理，插件不会自动确认。
 */
export function waitingWakeText(record: RunRecord): string {
  const env = environmentLabel(record)
  return [
    `【dsh-cicd 后台通知】${env ? `${env} ` : ''}${record.title || record.pipeline} 正在等待人工操作（不是终态）：${record.waiting ?? '等待人工确认'}`,
    `runId:   ${record.runId}`,
    record.progress ? `progress: ${record.progress}` : '',
    '',
    '请提醒用户到云效处理（例如人工卡点需要点「通过」）；插件不会自动确认，也不会替你点。',
    '处理完成后运行会继续；可再用 cicd_status 查看，完成/失败时会再通知。',
    '（这是插件自动唤醒的消息，不是用户的新发言。）',
  ].filter(Boolean).join('\n')
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- 状态输出的字段组合较多，拆函数反而分散可读性
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
  if (record.variables?.length)
    lines.push(`运行变量: ${record.variables.length} 个（只有名称，值不读取）`)
  if (record.progress)
    lines.push(`progress:  ${record.progress}`)
  if (record.waiting)
    lines.push(`waiting: ${record.waiting}`)
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
