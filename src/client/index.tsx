/**
 * dsh-cicd 的浏览器半边：多分支运行的分支选择弹窗。
 *
 * 设计目标：
 * - 默认**全部勾选**（勾选 = 保留，取消 = 本次移除），比通用 userQuestions 直观；
 * - 颜色/圆角/字体全部用 DSH 的 `--dsw-*` CSS 变量，自动跟随明暗主题；
 * - 通过 `/dsh-cicd/*` HTTP 路由和宿主通信（不依赖 dsh-pet）。
 */
/* eslint-disable react-refresh/only-export-components -- 插件被打包成单个 client.js（__ModuleLoader__ 协议），不是 Vite HMR 应用 */
import type { ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'

export const name = 'cicd-client'
export const inject = ['slots']

const PREFIX = '/dsh-cicd'
const SEEN_KEY = 'dsh-cicd.notices.seen'

function readSeenSeq(): number {
  try {
    const value = Number(localStorage.getItem(SEEN_KEY))
    return Number.isFinite(value) && value > 0 ? value : 0
  }
  catch {
    return 0
  }
}

const CSS = `
.dshp-backdrop{position:fixed;top:var(--dsh-frame-chrome-top,0px);right:0;bottom:0;left:0;z-index:10010;display:flex;align-items:center;justify-content:center;padding:var(--dsh-frame-overlay-top,24px) 24px 24px;background:var(--dsw-alias-bg-mask-1,rgba(15,17,21,.45));}
.dshp-card{width:min(560px,100%);max-height:min(80vh,720px);display:flex;flex-direction:column;gap:12px;padding:20px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--dsw-radius-lg,14px);box-shadow:0 20px 60px rgba(0,0,0,.28);font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);font-size:14px;line-height:1.5;}
.dshp-body{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:4px;}
.dshp-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a);}
.dshp-subtitle{font-size:12px;color:var(--dsw-alias-label-secondary,#666);margin-top:3px;}
.dshp-list{overflow:visible;display:flex;flex-direction:column;gap:2px;padding:4px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1,#fafafa);}
.dshp-option{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:var(--dsw-radius-sm,6px);cursor:pointer;color:var(--dsw-alias-label-primary,#1a1a1a);}
.dshp-option:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));}
.dshp-option input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer;}
.dshp-branch{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;word-break:break-all;}
.dshp-empty{padding:10px;color:var(--dsw-alias-label-tertiary,#888);font-size:13px;}
.dshp-label{font-size:12px;color:var(--dsw-alias-label-secondary,#666);margin-bottom:6px;}
.dshp-input{width:100%;box-sizing:border-box;padding:9px 10px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);font:inherit;outline:none;}
.dshp-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe);}
.dshp-summary{font-size:12px;color:var(--dsw-alias-label-tertiary,#888);word-break:break-all;}
.dshp-vars{display:flex;flex-direction:column;gap:10px;}
.dshp-hint{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#888);}
.dshp-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#d33);}
.dshp-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:2px;}
.dshp-btn{box-sizing:border-box;height:32px;padding:0 12px;border-radius:var(--dsw-radius-md,8px);border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#1a1a1a);font:inherit;font-size:13px;cursor:pointer;}
.dshp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}
.dshp-btn:disabled{opacity:.5;cursor:not-allowed;}
.dshp-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4d6bfe));color:var(--dsw-alias-label-primary-inverted,#fff);}
.dshp-primary:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#4d6bfe));}
.dshp-badge{display:inline-flex;align-items:center;padding:1px 7px;margin-left:8px;border-radius:999px;font-size:11px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-fill-tertiary,rgba(0,0,0,.06));border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));vertical-align:middle;}
.dshp-badge-prod{color:var(--dsw-alias-state-warn-primary,#b26a00);background:var(--dsw-alias-state-warn-secondary,rgba(255,171,64,.12));border-color:transparent;}
.dshp-toasts{position:fixed;top:var(--dsh-frame-overlay-top,68px);left:50%;transform:translateX(-50%);z-index:10000;display:flex;flex-direction:column;align-items:center;gap:8px;max-width:min(560px,calc(100vw - 32px));pointer-events:none;}
.dshp-toast{pointer-events:auto;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-left:3px solid var(--dsw-alias-brand-primary,#4d6bfe);border-radius:var(--dsw-radius-md,10px);padding:10px 12px;box-shadow:0 6px 20px rgba(0,0,0,.18);font:13px/1.45 var(--dsw-font-family,system-ui);white-space:pre-wrap;cursor:pointer;word-break:break-word;}
.dshp-history{display:flex;flex-direction:column;gap:10px;width:100%;height:100%;min-height:0;box-sizing:border-box;font:13px/1.5 var(--dsw-font-family,system-ui);color:var(--dsw-alias-label-primary,#1a1a1a);}
.dshp-history-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;}
.dshp-history-head .dshp-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;padding:3px 10px;font-size:12px;line-height:20px;text-align:center;}
.dshp-history-title{font-size:14px;font-weight:600;}
.dshp-history-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#666);margin-top:2px;}
.dshp-history-list{display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-height:0;overflow:auto;}
.dshp-history-row{display:grid;grid-template-columns:64px 96px minmax(0,1fr) auto;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2,#fff);}
.dshp-history-time{grid-column:1;color:var(--dsw-alias-label-tertiary,#888);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;white-space:nowrap;padding-top:1px;}
.dshp-history-project{grid-column:2;justify-self:stretch;display:flex;align-items:center;width:96px;box-sizing:border-box;padding:0 6px;border-radius:999px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-fill-tertiary,rgba(0,0,0,.05));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dshp-history-text{grid-column:3;min-width:0;text-align:left;white-space:pre-wrap;word-break:break-word;}
.dshp-history-count{grid-column:4;align-self:flex-start;color:var(--dsw-alias-label-tertiary,#888);font-size:11px;white-space:nowrap;}
.dshp-history-empty{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;padding:12px;border:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:var(--dsw-radius-sm,8px);}
.dshp-shortcut{position:relative;display:flex;align-items:center;}
.dshp-iconbtn{position:relative;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;-webkit-app-region:no-drag;}
.dshp-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#1a1a1a);}
.dshp-iconbtn svg{width:15px;height:15px;}
.dshp-iconbtn-dot{position:absolute;top:5px;right:5px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4d6bfe);}
.dshp-popover{position:absolute;top:calc(100% + 8px);right:0;z-index:20000;width:380px;max-width:calc(100vw - 24px);max-height:min(60vh,520px);display:flex;flex-direction:column;gap:8px;padding:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,10px);box-shadow:0 12px 36px rgba(0,0,0,.28);font:13px/1.5 var(--dsw-font-family,system-ui);}
.dshp-popover-head .dshp-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;padding:2px 8px;font-size:11px;line-height:18px;text-align:center;}
.dshp-popover-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;}
.dshp-popover-title{font:600 13px/20px var(--dsw-font-family,system-ui);}
.dshp-config{display:flex;flex-direction:column;gap:14px;height:100%;min-height:0;overflow:auto;font:14px/22px var(--dsw-font-family,system-ui);color:var(--dsw-alias-label-primary,#1a1a1a);}
.dshp-config-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex:none;}
.dshp-config-title{font-size:16px;font-weight:600;line-height:24px;}
.dshp-config-sub{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#666);margin-top:4px;}
.dshp-section{display:flex;flex-direction:column;gap:6px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-2,#fff);}
.dshp-sec-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 0 4px;}
.dshp-sec-title{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:600;line-height:22px;}
.dshp-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);}
.dshp-dot.ok{background:var(--dsw-alias-state-success-primary);}
.dshp-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 0;min-height:28px;}
.dshp-label{font-size:14px;line-height:20px;}
.dshp-muted{color:var(--dsw-alias-label-secondary,#666);font-size:12px;line-height:18px;}
.dshp-ok{color:var(--dsw-alias-state-success-primary,#1a7f37);}
.dshp-warn{color:var(--dsw-alias-state-warn-primary,#b26a00);}
.dshp-error{color:var(--dsw-alias-state-error-primary,#d1242f);background:var(--dsw-alias-state-error-secondary,rgba(209,36,47,.08));border-radius:var(--dsw-radius-sm,8px);padding:10px 12px;font-size:13px;line-height:20px;white-space:pre-wrap;}
.dshp-inp{box-sizing:border-box;width:100%;min-height:32px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary,#1a1a1a);font:inherit;font-size:13px;outline:none;}
.dshp-inp:focus{border-color:var(--dsw-alias-state-business-primary);}
.dshp-select{position:relative;min-width:0;}
.dshp-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;text-align:left;cursor:pointer;}
.dshp-select-trigger[aria-expanded=true]{border-color:var(--dsw-alias-state-business-primary);}
.dshp-select-trigger:disabled{cursor:default;opacity:.6;}
.dshp-select-chevron{flex:none;color:var(--dsw-alias-label-tertiary);}
.dshp-select-placeholder{color:var(--dsw-alias-label-tertiary);}
.dshp-select-menu{position:fixed;z-index:20200;box-sizing:border-box;max-height:240px;overflow:auto;padding:4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 12px 32px rgba(0,0,0,.18);}
.dshp-select-option{display:block;width:100%;padding:7px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1a1a1a);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;}
.dshp-select-option.active,.dshp-select-option:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));}
.dshp-select-option[aria-selected=true]{color:var(--dsw-alias-state-business-primary);font-weight:500;}
.dshp-btn-sm{display:inline-flex;align-items:center;justify-content:center;flex:none;height:28px;padding:0 8px;font-size:12px;line-height:20px;text-align:center;}
.dshp-pipeline{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2,#fff);}
.dshp-pipeline + .dshp-pipeline{margin-top:6px;}
.dshp-pipeline-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
.dshp-pipeline-name{font-weight:600;font-size:14px;line-height:20px;}
.dshp-pipeline-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#666);white-space:pre-wrap;word-break:break-word;}
.dshp-org{display:flex;flex-direction:column;gap:6px;padding:10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fafafa);}
.dshp-org + .dshp-org{margin-top:6px;}
.dshp-org-head{display:flex;align-items:center;gap:12px;padding:0 0 4px;flex-wrap:wrap;}
.dshp-org-name{font-weight:600;font-size:14px;line-height:20px;}
.dshp-org-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#888);}
.dshp-org-actions{margin-left:auto;display:flex;gap:4px;flex-wrap:wrap;}
.dshp-switch{box-sizing:border-box;position:relative;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer;}
.dshp-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary);}
.dshp-switch:disabled{cursor:default;opacity:.5;}
.dshp-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:transform .12s ease;}
.dshp-switch[aria-checked=true] .dshp-switch-thumb{background:var(--dsw-alias-label-primary-foreground);transform:translate(16px);}
.dshp-switch-row{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#666);}
.dshp-modal-backdrop{position:fixed;top:var(--dsh-frame-chrome-top,0px);right:0;bottom:0;left:0;z-index:20100;display:flex;align-items:center;justify-content:center;padding:var(--dsh-frame-overlay-top,24px) 24px 24px;background:var(--dsw-alias-bg-mask-1,rgba(15,17,21,.45));}
.dshp-modal{width:min(560px,100%);max-height:min(82vh,720px);overflow:auto;display:flex;flex-direction:column;gap:14px;padding:20px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--dsw-radius-lg,14px);box-shadow:0 20px 60px rgba(0,0,0,.28);}
.dshp-modal-title{font-size:16px;line-height:24px;font-weight:600;}
.dshp-form{display:flex;flex-direction:column;gap:12px;}
.dshp-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;}
.dshp-field{display:flex;flex-direction:column;gap:4px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary,#666);}
.dshp-field-wide{grid-column:1/-1;}
.dshp-field-label{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#1a1a1a);}
.dshp-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#1a1a1a);}
.dshp-check input{margin:3px 0 0;}
@media (max-width: 520px){.dshp-form-grid{grid-template-columns:1fr;}}
.dshp-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding-top:4px;}
`

interface DialogVariable {
  key: string
  description?: string
  encrypted?: boolean
  masked?: boolean
}

interface BranchRequest {
  id: string
  kind?: 'branch' | 'runConfig'
  title: string
  previous: string[]
  showBranches?: boolean
  showComment?: boolean
  variables?: DialogVariable[]
  environment?: string
  tier?: string
}

function splitBranches(text: string): string[] {
  return text.split(/[,，、\s]+/).map(branch => branch.trim()).filter(Boolean)
}

/** 只取路径最后一段作为项目名（完整路径放 title）。 */
function projectLabel(path?: string): string {
  const clean = String(path ?? '').replace(/[\\/]+$/, '')
  return clean.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- 弹窗要同时渲染分支/变量/备注三块，拆组件会打断共享状态
function BranchDialog(): ReactElement | null {
  const [request, setRequest] = useState<BranchRequest | null>(null)
  const [keep, setKeep] = useState<Set<string>>(() => new Set())
  const [custom, setCustom] = useState('')
  const [envs, setEnvs] = useState<Record<string, string>>({})
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const currentIdRef = useRef('')

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setInterval> | null = null

    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`${PREFIX}/branch/request`, { cache: 'no-store' })
        if (!res.ok || !alive)
          return
        const data = await res.json()
        if (!alive)
          return
        if (data?.request) {
          if (data.request.id !== currentIdRef.current) {
            currentIdRef.current = data.request.id
            setRequest(data.request)
            setKeep(new Set<string>(data.request.previous))
            setCustom('')
            setEnvs({})
            setComment('')
            setError('')
            setBusy(false)
          }
        }
        else if (!busy) {
          currentIdRef.current = ''
          setRequest(null)
        }
      }
      catch {}
    }

    void poll()
    timer = setInterval(() => {
      void poll()
    }, 1000)
    return () => {
      alive = false
      if (timer)
        clearInterval(timer)
    }
  }, [busy])

  if (!request)
    return null

  const runConfigMode = request.kind === 'runConfig'
  const showBranches = runConfigMode ? request.showBranches === true : true
  const variables = request.variables ?? []
  const filledEnvs = Object.fromEntries(
    variables
      .map(variable => [variable.key, (envs[variable.key] ?? '').trim()] as const)
      .filter(([, value]) => Boolean(value)),
  )

  const added = splitBranches(custom).filter(branch => !request.previous.includes(branch))
  const kept = request.previous.filter(branch => keep.has(branch))
  const branches = [...new Set([...kept, ...added])]

  const toggle = (branch: string): void => {
    setKeep((previous) => {
      const next = new Set(previous)
      if (next.has(branch))
        next.delete(branch)
      else next.add(branch)
      return next
    })
  }

  const submit = async (): Promise<void> => {
    if (busy)
      return
    if (showBranches && branches.length === 0) {
      setError('多分支流水线至少要有一个运行分支：请至少保留或新增一个')
      return
    }
    setBusy(true)
    setError('')
    try {
      const payload = runConfigMode
        ? {
            id: request.id,
            envs: filledEnvs,
            comment,
            ...(showBranches ? { selected: kept, custom } : {}),
          }
        : { id: request.id, selected: kept, custom }
      const res = await fetch(`${PREFIX}/branch/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok)
        throw new Error(`HTTP ${res.status}`)
      currentIdRef.current = ''
      setRequest(null)
    }
    catch (failure) {
      setError(`提交失败：${(failure as Error).message}`)
      setBusy(false)
    }
  }

  const cancel = async (): Promise<void> => {
    if (busy)
      return
    setBusy(true)
    try {
      await fetch(`${PREFIX}/branch/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: request.id, cancelled: true }),
      })
    }
    catch {}
    currentIdRef.current = ''
    setRequest(null)
  }

  return (
    <>
      <style>{CSS}</style>
      <div className="dshp-backdrop">
        <div className="dshp-card" role="dialog" aria-modal="true" aria-label={runConfigMode ? '运行配置' : '选择运行分支'}>
          <div>
            <div className="dshp-title">
              {request.title}
              {request.environment || request.tier
                ? (
                    <span className={`dshp-badge${request.tier === 'production' ? ' dshp-badge-prod' : ''}`}>
                      {environmentText(request.environment) || request.tier}
                    </span>
                  )
                : null}
            </div>
            <div className="dshp-subtitle">
              {runConfigMode
                ? (variables.length > 0 ? '运行配置 · 变量留空 = 使用云效当前值' : '分支确认 · 本次不修改运行变量')
                : '多分支运行 · 勾选 = 保留，取消勾选 = 本次移除'}
            </div>
          </div>

          <div className="dshp-body">
            {showBranches
              ? (
                  <>
                    <div className="dshp-list">
                      {request.previous.length === 0
                        ? <div className="dshp-empty">上次没有可继承的分支，请在下方输入新增分支</div>
                        : request.previous.map(branch => (
                            <label key={branch} className="dshp-option">
                              <input type="checkbox" checked={keep.has(branch)} onChange={() => toggle(branch)} />
                              <span className="dshp-branch">{branch}</span>
                            </label>
                          ))}
                    </div>

                    <div>
                      <div className="dshp-label">新增分支（逗号分隔，可留空）</div>
                      <input
                        className="dshp-input"
                        value={custom}
                        placeholder="例如：feat/login, feat/pay"
                        onChange={event => setCustom(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing)
                            return
                          event.preventDefault()
                          void submit()
                        }}
                      />
                    </div>
                  </>
                )
              : null}

            {variables.length > 0
              ? (
                  <div className="dshp-vars">
                    <div className="dshp-label">运行变量（留空 = 不覆盖，用云效当前值）</div>
                    {variables.map(variable => (
                      <label key={variable.key} className="dshp-field">
                        <span className="dshp-field-label">
                          {variable.key}
                          {variable.encrypted || variable.masked ? '（已配置，值不可读）' : ''}
                        </span>
                        <input
                          className="dshp-input"
                          type={variable.encrypted || variable.masked ? 'password' : 'text'}
                          autoComplete="off"
                          value={envs[variable.key] ?? ''}
                          placeholder={variable.description || '留空 = 不覆盖'}
                          onChange={event => setEnvs(previous => ({ ...previous, [variable.key]: event.target.value }))}
                        />
                      </label>
                    ))}
                    <div className="dshp-hint">值只用于本次触发：不会写入运行记录，也不经过模型。</div>
                  </div>
                )
              : null}

            {runConfigMode && request.showComment === true
              ? (
                  <div>
                    <div className="dshp-label">运行备注（可选）</div>
                    <input
                      className="dshp-input"
                      value={comment}
                      placeholder="例如：发版 1.2.3"
                      onChange={event => setComment(event.target.value)}
                    />
                  </div>
                )
              : null}
          </div>

          <div className="dshp-summary">
            {[
              showBranches ? `本次将运行 ${branches.length} 个分支` : '',
              variables.length > 0 ? `变量覆盖 ${Object.keys(filledEnvs).length} 个` : '',
            ].filter(Boolean).join(' · ') || '运行配置'}
            {showBranches && branches.length > 0 ? `：${branches.join('、')}` : ''}
          </div>
          {error ? <div className="dshp-error">{error}</div> : null}

          <div className="dshp-footer">
            <button type="button" className="dshp-btn" disabled={busy} onClick={() => { void cancel() }}>取消</button>
            <button type="button" className="dshp-btn dshp-primary" disabled={busy || (showBranches && branches.length === 0)} onClick={() => { void submit() }}>
              {busy ? '提交中…' : '开始运行'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

function NoticeToasts(): ReactElement | null {
  const [items, setItems] = useState<Array<{ id: string, text: string, level: string }>>([])
  const [toastEnabled, setToastEnabled] = useState(true)
  const toastRef = useRef(true)
  const lastSeqRef = useRef(0)
  const initializedRef = useRef(false)

  useEffect(() => {
    let alive = true
    const loadPrefs = async (): Promise<void> => {
      try {
        const res = await fetch(`${PREFIX}/config/prefs`, { cache: 'no-store' })
        if (!res.ok || !alive)
          return
        const prefs = await res.json()
        const enabled = prefs?.toast !== false
        setToastEnabled(enabled)
        toastRef.current = enabled
      }
      catch {}
    }
    void loadPrefs()
    const timer = setInterval(() => {
      void loadPrefs()
    }, 5_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    toastRef.current = toastEnabled
  }, [toastEnabled])

  useEffect(() => {
    let alive = true
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`${PREFIX}/notices?since=${lastSeqRef.current}`, { cache: 'no-store' })
        if (!res.ok || !alive)
          return
        const data = await res.json()
        if (!alive)
          return
        if (!initializedRef.current) {
          initializedRef.current = true
          lastSeqRef.current = typeof data?.seq === 'number' ? data.seq : 0
          return
        }
        if (typeof data?.seq === 'number')
          lastSeqRef.current = data.seq
        const notices: NoticeItem[] = Array.isArray(data?.notices) ? data.notices as NoticeItem[] : []
        if (notices.length === 0)
          return
        if (!toastRef.current)
          return

        const fresh = notices.map(notice => ({
          id: String(notice.seq),
          text: String(notice.text ?? ''),
          level: String(notice.level ?? 'info'),
        }))
        setItems((previous) => {
          const next = [...previous]
          for (const toast of fresh) {
            // 同一段文本已在屏上：移到最后，只保留最新一条。
            const index = next.findIndex(item => item.text === toast.text)
            if (index >= 0)
              next.splice(index, 1)
            next.push(toast)
          }
          return next.slice(-5)
        })
        for (const toast of fresh) {
          // eslint-disable-next-line react/web-api-no-leaked-timeout -- 定时器登记在 timers Map，unmount 时统一 clearTimeout
          const timer = setTimeout(() => {
            if (!alive)
              return
            setItems(previous => previous.filter(item => item.id !== toast.id))
            timers.delete(toast.id)
          }, 6000)
          timers.set(toast.id, timer)
        }
      }
      catch {}
    }

    void poll()
    const interval = setInterval(() => {
      void poll()
    }, 1000)
    return () => {
      alive = false
      clearInterval(interval)
      for (const timer of timers.values()) clearTimeout(timer)
    }
  }, [])

  if (items.length === 0)
    return null

  return (
    <>
      <style>{CSS}</style>
      <div className="dshp-toasts">
        {items.map(item => (
          <div
            key={item.id}
            className="dshp-toast"
            role="status"
            onClick={() => setItems(previous => previous.filter(entry => entry.id !== item.id))}
          >
            {item.text}
          </div>
        ))}
      </div>
    </>
  )
}

interface NoticeItem {
  seq: number
  text: string
  at: number
  level: string
  count?: number
  project?: string
  runId?: string
}

type NoticeRow = NoticeItem & { count: number }

function groupNotices(items: NoticeItem[]): NoticeRow[] {
  const grouped: NoticeRow[] = []
  const seen = new Map<string, NoticeRow>()
  for (const item of items) {
    // 按「同一次运行 + 同文本」去重；不同运行的相同文本分开保留。
    const key = `${item.project ?? ''}|${item.runId ?? ''}|${item.text}`
    const existing = seen.get(key)
    if (existing) {
      existing.count += item.count ?? 1
      continue
    }
    const entry = { ...item, count: item.count ?? 1 }
    seen.set(key, entry)
    grouped.push(entry)
  }
  return grouped
}

function useNoticeHistory(active = true): { items: NoticeItem[], loading: boolean, clear: () => Promise<void> } {
  const [items, setItems] = useState<NoticeItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!active)
      return
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`${PREFIX}/notices/history?limit=50`, { cache: 'no-store' })
        if (!res.ok || !alive)
          return
        const data = await res.json()
        if (!alive)
          return
        setItems(Array.isArray(data?.notices) ? data.notices : [])
        setLoading(false)
      }
      catch {}
    }
    void load()
    const timer = setInterval(() => {
      void load()
    }, 2_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [active])

  const clear = async (): Promise<void> => {
    try {
      await fetch(`${PREFIX}/notices/clear`, { method: 'POST' })
      setItems([])
    }
    catch {}
  }

  return { items, loading, clear }
}

function NoticeRows({ rows, loading }: { rows: NoticeRow[], loading: boolean }): ReactElement {
  if (loading)
    return <div className="dshp-history-empty">加载中…</div>
  if (rows.length === 0)
    return <div className="dshp-history-empty">还没有收到通知。触发流水线后，进度和结果会出现在这里。</div>
  return (
    <div className="dshp-history-list">
      {rows.map(item => (
        <div key={item.seq} className="dshp-history-row">
          <span className="dshp-history-time">
            {new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false })}
          </span>
          {item.project
            ? <span className="dshp-history-project" title={item.project}>{projectLabel(item.project)}</span>
            : null}
          <span className="dshp-history-text">{item.text}</span>
          {item.count > 1
            ? (
                <span className="dshp-history-count">
                  ×
                  {item.count}
                </span>
              )
            : null}
        </div>
      ))}
    </div>
  )
}

interface ConfigPipeline {
  name: string
  type: string
  title?: string
  organizationId?: string
  pipelineId?: string
  environment?: string
  tier?: string
  confirm?: boolean
  branchMode?: string
  runConfig?: boolean
  command?: string
  latest?: { runId: string, status: string, startedAt: string, durationMs?: number }
}

interface DialogPipeline {
  title?: string
  environment?: string
  confirm?: boolean
  runConfig?: boolean
  [key: string]: unknown
}

type Dialog
  = | { kind: 'pipeline', mode: 'edit', projectRoot: string, name: string, pipeline: DialogPipeline }
    | { kind: 'organization', mode: 'add' | 'rename', id: string, name?: string, baseUrl?: string }
    | { kind: 'token' }
    | { kind: 'confirm', message: string, action: () => Promise<void> }

interface ConfigProject {
  root: string
  configPath: string
  error?: string
  pipelines: ConfigPipeline[]
}

interface ConfigData {
  prefs: { tokenRef: string, pet: boolean, petId: string, toast: boolean, historyLimit: number }
  token: { ref: string, configured: boolean }
  organizations: Array<{ id: string, name?: string, baseUrl?: string }>
  pets: Array<{ id: string, name?: string }>
  projects: ConfigProject[]
}

function statusIcon(status?: string): string {
  if (status === 'succeeded')
    return '✅'
  if (status === 'failed')
    return '❌'
  if (status === 'canceled')
    return '⛔'
  if (status === 'running')
    return '⏳'
  return '•'
}

const STATUS_LABELS: Record<string, string> = {
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  canceled: '已取消',
  lost: '状态丢失',
}

const ENVIRONMENT_OPTIONS = [
  { value: 'development', label: '开发' },
  { value: 'test', label: '测试' },
  { value: 'staging', label: '预发' },
  { value: 'production', label: '生产' },
]

function statusText(status?: string): string {
  return STATUS_LABELS[status ?? ''] ?? status ?? '未知'
}

function environmentText(value?: string): string {
  if (!value)
    return ''
  return ENVIRONMENT_OPTIONS.find(option => option.value === value)?.label ?? value
}

function environmentOptions(value?: string): Array<{ value: string, label: string }> {
  const current = String(value ?? '').trim()
  if (!current || ENVIRONMENT_OPTIONS.some(option => option.value === current))
    return ENVIRONMENT_OPTIONS
  return [...ENVIRONMENT_OPTIONS, { value: current, label: current }]
}

function ToggleSwitch({ checked, label, disabled, onChange }: {
  checked: boolean
  label: string
  disabled?: boolean
  onChange: (checked: boolean) => void
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="dshp-switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="dshp-switch-thumb" />
    </button>
  )
}

interface SelectOption {
  value: string
  label: string
}

function SelectMenu({ value, options, onChange, disabled, title, placeholder = '请选择' }: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  title?: string
  placeholder?: string
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState<{ left: number, top: number, width: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const current = options.find(option => option.value === value)

  const openMenu = (): void => {
    if (disabled || !triggerRef.current)
      return
    const rect = triggerRef.current.getBoundingClientRect()
    const estimated = Math.min(options.length, 7) * 32 + 8
    const below = window.innerHeight - rect.bottom - 12
    setPosition({
      left: rect.left,
      width: rect.width,
      top: below >= estimated ? rect.bottom + 4 : Math.max(8, rect.top - estimated - 4),
    })
    setActive(Math.max(0, options.findIndex(option => option.value === value)))
    setOpen(true)
  }

  const choose = (option: SelectOption): void => {
    onChange(option.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  useEffect(() => {
    if (!open)
      return
    const onPointerDown = (event: MouseEvent): void => {
      if (triggerRef.current?.contains(event.target as Node))
        return
      if (menuRef.current?.contains(event.target as Node))
        return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
      else if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive(index => Math.min(options.length - 1, index + 1))
      }
      else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive(index => Math.max(0, index - 1))
      }
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const option = options[active]
        if (option)
          choose(option)
      }
    }
    const close = (): void => setOpen(false)
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  })

  return (
    <div className="dshp-select">
      <button
        ref={triggerRef}
        type="button"
        className="dshp-inp dshp-select-trigger"
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open)
            setOpen(false)
          else
            openMenu()
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (open) {
              const option = options[Math.max(0, Math.min(options.length - 1, active))]
              if (option)
                choose(option)
            }
            else {
              openMenu()
            }
          }
        }}
      >
        <span className={current ? '' : 'dshp-select-placeholder'}>{current?.label ?? placeholder}</span>
        <svg className="dshp-select-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && position
        ? (
            <div
              ref={menuRef}
              className="dshp-select-menu"
              role="listbox"
              style={{ left: position.left, top: position.top, width: position.width }}
            >
              {options.map((option, index) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className={`dshp-select-option${index === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(option)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )
        : null}
    </div>
  )
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- 平台协议/解析流程分支多，拆函数反而降低可读性
function PipelineConfigSection(): ReactElement {
  const [data, setData] = useState<ConfigData | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [tokenValue, setTokenValue] = useState('')

  const load = async (): Promise<void> => {
    try {
      const res = await fetch(`${PREFIX}/config`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || json?.ok === false)
        throw new Error(json?.error ?? `HTTP ${res.status}`)
      setData(json)
      setError('')
    }
    catch (reason) {
      setError((reason as Error)?.message ?? String(reason))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const call = async (method: string, path: string, body?: unknown): Promise<{ ok?: boolean, error?: string }> => {
    const res = await fetch(`${PREFIX}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json?.ok === false)
      throw new Error(json?.error ?? `HTTP ${res.status}`)
    return json
  }

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await action()
      await load()
    }
    catch (reason) {
      setError((reason as Error)?.message ?? String(reason))
    }
    finally {
      setBusy(false)
    }
  }

  const setPref = (patch: Record<string, unknown>): void => {
    void run(() => call('PUT', '/config/prefs', patch))
  }

  const allPipelines = (data?.projects ?? [])
    .flatMap(project => project.pipelines.map(pipeline => ({ ...pipeline, projectRoot: project.root })))
    .filter(pipeline => pipeline.type !== 'shell')
  const organizations = data?.organizations ?? []
  const pets = data?.pets ?? []
  const petOptions = [
    { value: '', label: pets.length > 0 ? '自动（main / 第一个）' : '自动（未检测到 dsh-pet）' },
    ...pets.map(pet => ({ value: pet.id, label: pet.name ? `${pet.name}（${pet.id}）` : pet.id })),
    ...(data?.prefs.petId && !pets.some(pet => pet.id === data.prefs.petId)
      ? [{ value: data.prefs.petId, label: `${data.prefs.petId}（当前配置）` }]
      : []),
  ]
  const groups = organizations.map(org => ({
    org,
    pipelines: allPipelines.filter(pipeline => pipeline.organizationId === org.id),
  }))
  const ungrouped = allPipelines.filter(pipeline => !pipeline.organizationId)

  const saveDialog = (): void => {
    if (!dialog)
      return
    if (dialog.kind === 'pipeline') {
      void run(async () => {
        await call('PUT', '/config/pipeline', {
          projectRoot: dialog.projectRoot,
          name: dialog.name,
          pipeline: dialog.pipeline,
        })
        setDialog(null)
      })
    }
    else if (dialog.kind === 'organization') {
      void run(async () => {
        await call('PUT', '/config/organization', {
          id: dialog.id,
          name: dialog.name,
          baseUrl: dialog.baseUrl,
        })
        setDialog(null)
      })
    }
    else if (dialog.kind === 'token') {
      void run(async () => {
        await call('POST', '/config/token', { value: tokenValue })
        setTokenValue('')
        setDialog(null)
      })
    }
  }

  const field = (key: string, value: unknown): void => {
    setDialog((current) => {
      if (!current)
        return current
      if (current.kind === 'pipeline')
        return { ...current, pipeline: { ...current.pipeline, [key]: value } }
      return { ...current, [key]: value } as Dialog
    })
  }

  return (
    <div className="dshp-config">
      <style>{CSS}</style>
      <div className="dshp-config-head">
        <div>
          <div className="dshp-config-title">流水线配置</div>
          <div className="dshp-config-sub">本地配置（`.dsh/cicd.json` 与全局组织/token），不会修改云效上的流水线</div>
        </div>
      </div>

      {error ? <div className="dshp-error">{error}</div> : null}

      {!data
        ? <div className="dshp-muted">加载中…</div>
        : (
            <>
              <div className="dshp-section">
                <div className="dshp-sec-head">
                  <span className="dshp-sec-title">
                    <span
                      className={`dshp-dot${data.token.configured ? ' ok' : ''}`}
                      title={data.token.configured ? 'Token 已配置' : 'Token 未配置'}
                    />
                    全局配置
                  </span>
                  <button
                    type="button"
                    className="dshp-btn dshp-btn-sm"
                    onClick={() => {
                      setTokenValue('')
                      setDialog({ kind: 'token' })
                    }}
                  >
                    设置 Token
                  </button>
                </div>
                <div className="dshp-row">
                  <div className="dshp-label">通知</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                    <span className="dshp-switch-row">
                      桌宠通知
                      <ToggleSwitch
                        checked={data.prefs.pet}
                        label="桌宠通知"
                        disabled={busy}
                        onChange={checked => setPref({ pet: checked })}
                      />
                    </span>
                    <span className="dshp-switch-row">
                      Toast 通知
                      <ToggleSwitch
                        checked={data.prefs.toast}
                        label="Toast 通知"
                        disabled={busy}
                        onChange={checked => setPref({ toast: checked })}
                      />
                    </span>
                  </div>
                </div>
                <div className="dshp-row">
                  <div>
                    <div className="dshp-label">通知宠物</div>
                    <div className="dshp-muted">多宠物时指定一只，选择后只发这只</div>
                  </div>
                  <div style={{ width: 220 }}>
                    <SelectMenu
                      value={data.prefs.petId ?? ''}
                      options={petOptions}
                      placeholder="自动"
                      onChange={value => setPref({ petId: value })}
                    />
                  </div>
                </div>
              </div>

              <div className="dshp-section">
                <div className="dshp-sec-head">
                  <span className="dshp-sec-title">组织</span>
                  <button type="button" className="dshp-btn dshp-btn-sm" onClick={() => setDialog({ kind: 'organization', mode: 'add', id: '', name: '', baseUrl: '' })}>+ 添加组织</button>
                </div>

                {groups.map(({ org, pipelines }) => (
                  <div className="dshp-org" key={org.id}>
                    <div className="dshp-org-head">
                      <span className="dshp-org-name">{org.name || org.id}</span>
                      <span className="dshp-org-actions">
                        <button type="button" className="dshp-btn dshp-btn-sm" onClick={() => setDialog({ kind: 'organization', mode: 'rename', id: org.id, name: org.name || '' })}>重命名</button>
                        <button
                          type="button"
                          className="dshp-btn dshp-btn-sm"
                          onClick={() =>
                            setDialog({
                              kind: 'confirm',
                              message: `删除组织 ${org.name || org.id}？（只删本地元数据，不影响云效）`,
                              action: () => run(() => call('DELETE', `/config/organization?id=${encodeURIComponent(org.id)}`)),
                            })}
                        >
                          删除
                        </button>
                      </span>
                    </div>

                    {pipelines.length === 0
                      ? <div className="dshp-muted">还没有流水线</div>
                      : pipelines.map(pipeline => (
                          <div className="dshp-pipeline" key={`${pipeline.projectRoot}:${pipeline.name}`}>
                            <div className="dshp-pipeline-main">
                              <span className="dshp-pipeline-name">{pipeline.title || pipeline.name}</span>
                              <span className="dshp-pipeline-meta">
                                {pipeline.type === 'shell' ? 'shell' : 'yunxiao'}
                                {pipeline.environment ? ` · ${environmentText(pipeline.environment)}` : ''}
                                {pipeline.confirm ? ' · 🔒' : ''}
                                {pipeline.branchMode ? ` · ${pipeline.branchMode}` : ''}
                                {pipeline.pipelineId ? ` · #${pipeline.pipelineId}` : ''}
                                {` · ${pipeline.projectRoot}`}
                              </span>
                              {pipeline.latest
                                ? (
                                    <span className="dshp-pipeline-meta">
                                      {statusIcon(pipeline.latest.status)}
                                      {' '}
                                      最近：
                                      {statusText(pipeline.latest.status)}
                                      {' '}
                                      ·
                                      {new Date(pipeline.latest.startedAt).toLocaleString('zh-CN', { hour12: false })}
                                    </span>
                                  )
                                : null}
                            </div>
                            <span className="dshp-org-actions">
                              <button
                                type="button"
                                className="dshp-btn dshp-btn-sm"
                                onClick={() => setDialog({
                                  kind: 'pipeline',
                                  mode: 'edit',
                                  projectRoot: pipeline.projectRoot,
                                  name: pipeline.name,
                                  pipeline: { ...pipeline },
                                })}
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                className="dshp-btn dshp-btn-sm"
                                onClick={() =>
                                  setDialog({
                                    kind: 'confirm',
                                    message: `删除流水线 ${pipeline.name}？（只删本地配置）`,
                                    action: () => run(() => call('DELETE', `/config/pipeline?projectRoot=${encodeURIComponent(pipeline.projectRoot)}&name=${encodeURIComponent(pipeline.name)}`)),
                                  })}
                              >
                                删除
                              </button>
                            </span>
                          </div>
                        ))}
                  </div>
                ))}

                {ungrouped.length > 0
                  ? (
                      <div className="dshp-org">
                        <div className="dshp-org-head"><span className="dshp-org-name">未分组</span></div>
                        {ungrouped.map(pipeline => (
                          <div className="dshp-pipeline" key={`${pipeline.projectRoot}:${pipeline.name}`}>
                            <div className="dshp-pipeline-main">
                              <span className="dshp-pipeline-name">{pipeline.title || pipeline.name}</span>
                              <span className="dshp-pipeline-meta">
                                {pipeline.type}
                                {pipeline.environment ? ` · ${environmentText(pipeline.environment)}` : ''}
                                {` · ${pipeline.projectRoot}`}
                              </span>
                            </div>
                            <button
                              type="button"
                              className="dshp-btn dshp-btn-sm"
                              onClick={() => setDialog({ kind: 'pipeline', mode: 'edit', projectRoot: pipeline.projectRoot, name: pipeline.name, pipeline: { ...pipeline } })}
                            >
                              编辑
                            </button>
                          </div>
                        ))}
                      </div>
                    )
                  : null}
              </div>
            </>
          )}

      {dialog?.kind === 'pipeline'
        ? (
            <div
              className="dshp-modal-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget)
                  setDialog(null)
              }}
            >
              <div className="dshp-modal" role="dialog" aria-label="编辑流水线">
                <div className="dshp-modal-title">
                  编辑流水线 ·
                  {dialog.name}
                </div>
                <div className="dshp-form">
                  <div className="dshp-form-grid">
                    <label className="dshp-field dshp-field-wide">
                      <span className="dshp-field-label">显示名称</span>
                      <input className="dshp-inp" value={dialog.pipeline.title ?? ''} placeholder="列表/通知展示名称" onChange={event => field('title', event.target.value)} />
                    </label>

                    <label className="dshp-field dshp-field-wide">
                      <span className="dshp-field-label">环境</span>
                      <SelectMenu
                        value={dialog.pipeline.environment ?? ''}
                        options={environmentOptions(dialog.pipeline.environment)}
                        placeholder="选择环境"
                        title="保存英文值，界面显示中文"
                        onChange={value => field('environment', value)}
                      />
                    </label>

                    <label className="dshp-check dshp-field-wide" title="生产等敏感流水线建议开启；调用时必须传 confirm:true">
                      <input type="checkbox" checked={dialog.pipeline.confirm === true} onChange={event => field('confirm', event.target.checked)} />
                      <span className="dshp-field-label">需要显式确认才执行（🔒）</span>
                    </label>

                    <label className="dshp-check dshp-field-wide" title="开启后每次触发前弹「运行配置」：分支 + 运行变量 + 备注；变量留空 = 用云效当前值">
                      <input type="checkbox" checked={dialog.pipeline.runConfig === true} onChange={event => field('runConfig', event.target.checked)} />
                      <span className="dshp-field-label">触发前弹运行配置（可修改变量）</span>
                    </label>
                  </div>
                </div>
                <div className="dshp-modal-foot">
                  <button type="button" className="dshp-btn" onClick={() => setDialog(null)}>取消</button>
                  <button type="button" className="dshp-btn" disabled={busy} onClick={saveDialog}>保存</button>
                </div>
              </div>
            </div>
          )
        : null}

      {dialog?.kind === 'organization'
        ? (
            <div
              className="dshp-modal-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget)
                  setDialog(null)
              }}
            >
              <div className="dshp-modal" role="dialog" aria-label={dialog.mode === 'rename' ? '重命名组织' : '添加组织'}>
                <div className="dshp-modal-title">{dialog.mode === 'rename' ? '重命名组织' : '添加组织'}</div>
                <div className="dshp-form">
                  {dialog.mode === 'rename'
                    ? (
                        <>
                          <div className="dshp-muted">
                            组织 ID：
                            {dialog.id}
                            （不可修改）
                          </div>
                          <label className="dshp-field">
                            <span className="dshp-field-label">组织名称</span>
                            <input className="dshp-inp" value={dialog.name ?? ''} placeholder="例如 团队测试组织" onChange={event => field('name', event.target.value)} />
                          </label>
                        </>
                      )
                    : (
                        <div className="dshp-form-grid">
                          <label className="dshp-field">
                            <span className="dshp-field-label">组织 ID</span>
                            <input className="dshp-inp" value={dialog.id} placeholder="云效组织 ID，如 636b…" onChange={event => field('id', event.target.value)} />
                          </label>
                          <label className="dshp-field">
                            <span className="dshp-field-label">组织名称</span>
                            <input className="dshp-inp" value={dialog.name ?? ''} placeholder="例如 团队测试组织" onChange={event => field('name', event.target.value)} />
                          </label>
                          <label className="dshp-field dshp-field-wide">
                            <span className="dshp-field-label">服务地址</span>
                            <input className="dshp-inp" value={dialog.baseUrl ?? ''} placeholder="默认 https://openapi-rdc.aliyuncs.com，Region 版才填" onChange={event => field('baseUrl', event.target.value)} />
                          </label>
                        </div>
                      )}
                </div>
                <div className="dshp-modal-foot">
                  <button type="button" className="dshp-btn" onClick={() => setDialog(null)}>取消</button>
                  <button type="button" className="dshp-btn" disabled={busy} onClick={saveDialog}>保存</button>
                </div>
              </div>
            </div>
          )
        : null}

      {dialog?.kind === 'confirm'
        ? (
            <div
              className="dshp-modal-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget)
                  setDialog(null)
              }}
            >
              <div className="dshp-modal" role="dialog" aria-label="确认操作">
                <div className="dshp-modal-title">确认操作</div>
                <div className="dshp-muted">{dialog.message}</div>
                <div className="dshp-modal-foot">
                  <button type="button" className="dshp-btn" onClick={() => setDialog(null)}>取消</button>
                  <button
                    type="button"
                    className="dshp-btn dshp-primary"
                    disabled={busy}
                    onClick={() => {
                      void dialog.action()
                      setDialog(null)
                    }}
                  >
                    确认
                  </button>
                </div>
              </div>
            </div>
          )
        : null}

      {dialog?.kind === 'token'
        ? (
            <div
              className="dshp-modal-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget)
                  setDialog(null)
              }}
            >
              <div className="dshp-modal" role="dialog" aria-label="设置 Token">
                <div className="dshp-modal-title">设置云效 Token</div>
                <div className="dshp-muted">Token 只写入 DSH 凭据存储，保存后不会回显；所有云效组织共用这一个 Token。</div>
                <label className="dshp-field">
                  Token
                  <input className="dshp-inp" type="password" autoFocus value={tokenValue} placeholder="粘贴 Token（保存后不会回显）" onChange={event => setTokenValue(event.target.value)} />
                </label>
                <div className="dshp-modal-foot">
                  <button
                    type="button"
                    className="dshp-btn"
                    disabled={busy}
                    onClick={() => {
                      void run(async () => {
                        await call('DELETE', '/config/token')
                        setDialog(null)
                      })
                    }}
                  >
                    清除
                  </button>
                  <button type="button" className="dshp-btn" onClick={() => setDialog(null)}>取消</button>
                  <button type="button" className="dshp-btn" disabled={busy || !tokenValue} onClick={saveDialog}>保存</button>
                </div>
              </div>
            </div>
          )
        : null}
    </div>
  )
}

function NoticeShortcut(): ReactElement {
  const [open, setOpen] = useState(false)
  const [seenSeq, setSeenSeq] = useState(readSeenSeq)
  const rootRef = useRef<HTMLDivElement>(null)
  const { items, loading, clear } = useNoticeHistory()
  const grouped = groupNotices(items)
  const latestSeq = items.reduce((max, item) => Math.max(max, item.seq), 0)
  const unread = latestSeq > seenSeq

  // 打开/关闭弹窗时把当前最新通知标记为已读；之后只有新通知才会再亮小圆点。
  const markSeen = (): void => {
    if (latestSeq <= seenSeq)
      return
    setSeenSeq(latestSeq)
    try {
      localStorage.setItem(SEEN_KEY, String(latestSeq))
    }
    catch {}
  }

  useEffect(() => {
    if (!open)
      return
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node))
        setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape')
        setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const clearAll = async (): Promise<void> => {
    await clear()
    setSeenSeq(0)
    try {
      localStorage.removeItem(SEEN_KEY)
    }
    catch {}
  }

  return (
    <div className="dshp-shortcut" ref={rootRef}>
      <style>{CSS}</style>
      <button
        type="button"
        className="dshp-iconbtn"
        title="流水线通知"
        aria-label="流水线通知"
        aria-expanded={open}
        onClick={() => {
          setOpen(value => !value)
          markSeen()
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
          <path d="M10 21h4" />
        </svg>
        {unread ? <span className="dshp-iconbtn-dot" /> : null}
      </button>
      {open
        ? (
            <div className="dshp-popover" role="dialog" aria-label="流水线通知">
              <div className="dshp-popover-head">
                <span className="dshp-popover-title">流水线通知</span>
                <button type="button" className="dshp-btn" disabled={grouped.length === 0} onClick={() => { void clearAll() }}>清空</button>
              </div>
              <NoticeRows rows={grouped} loading={loading} />
            </div>
          )
        : null}
    </div>
  )
}

interface SlotHost {
  slots: {
    inject: (name: string, fn: () => Generator<unknown, void, unknown>) => void
    register: (spec: { name: string, id: string, order?: number, label?: () => string }, render: () => ReactElement) => unknown
  }
}

export function apply(ctx: SlotHost): void {
  ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register(
      { name: 'shell.overlay', id: 'pipeline-branch', order: 1001 },
      () => <BranchDialog />,
    )
    yield ctx.slots.register(
      { name: 'shell.overlay', id: 'cicd-notices', order: 1002 },
      () => <NoticeToasts />,
    )
  })

  ctx.slots.inject('settings.section', function* () {
    yield ctx.slots.register(
      { name: 'settings.section', id: 'cicd-config', order: 40, label: () => '流水线配置' },
      () => <PipelineConfigSection />,
    )
  })

  // 会话头部右上角的快捷入口：和「打开文件 / 侧栏」按钮同一排。
  ctx.slots.inject('conversation.session.header.utilities', function* () {
    yield ctx.slots.register(
      { name: 'conversation.session.header.utilities', id: 'cicd-notices', order: -1, label: () => '流水线通知' },
      () => <NoticeShortcut />,
    )
  })
}
