/**
 * The SafeHarness panel: one tab in the host's Plugins settings section (T5.3).
 *
 * Four tabs: 概览 (what is on), 事件 (what happened, filtered + paged), 规则
 * (what is loaded, AI drafting, reload) and 巡检 (run now, or on a timer).
 * Presentation only; it owns no security decision. The Host enforces every
 * action's gate (POST-only, single-flight, cooldown, body limits).
 *
 * Styling stays inline on purpose: this package is built outside the DSH
 * monorepo, where CSS Modules are compiled by a bundler preset it does not ship.
 * Solid badges (white on saturated fill) stay legible in both shells.
 * @module
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type {
  PanelDraftValue,
  PanelEvent,
  PanelPatrolReport,
  PanelPayload,
  PanelRule,
  PanelSchedule,
  PanelSession,
} from '../panel/protocol.js'

/** The props this component reads (the renderer supplies more; they are ignored). */
export interface SafeHarnessPanelProps {
  /** Read one fresh payload from the Host. */
  readonly load: () => Promise<PanelPayload>
  /** Run one patrol on the Host. */
  readonly patrol: () => Promise<PanelPatrolReport>
  /** Ask the drafting route for one candidate rule. */
  readonly draft: (input: { readonly description: string; readonly kind: 'inform' | 'chain' }) => Promise<PanelDraftValue>
  /** Arm/disarm the patrol timer. */
  readonly schedule: (input: { readonly enabled: boolean; readonly intervalMinutes: number | null }) => Promise<PanelSchedule>
  /** Re-read the rule directory. */
  readonly reloadRules: () => Promise<{ readonly rules: number; readonly chains: number; readonly hash: string }>
}

/** Tabs the panel renders. */
type Tab = 'overview' | 'events' | 'rules' | 'patrol'

/** What the status half currently shows. */
type View =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly payload: PanelPayload }

/** Patrol control state. */
type PatrolState =
  | { readonly status: 'idle' }
  | { readonly status: 'confirming' }
  | { readonly status: 'running' }
  | { readonly status: 'done'; readonly report: PanelPatrolReport }
  | { readonly status: 'error'; readonly code: string }

/** Draft control state. */
type DraftState =
  | { readonly status: 'idle' }
  | { readonly status: 'running' }
  | { readonly status: 'done'; readonly value: PanelDraftValue }
  | { readonly status: 'error'; readonly code: string }

/** Colour family for a badge. */
type Tone = 'danger' | 'warn' | 'ask' | 'ok' | 'muted'

/** Decision filter buckets. */
type DecisionFilter = 'all' | 'deny' | 'ask' | 'warn' | 'fail'

/** Event kind groups. */
type KindGroup = 'all' | 'input' | 'tool' | 'result' | 'approval' | 'budget' | 'output' | 'patrol' | 'posture' | 'error' | 'other'

const PAGE_SIZE = 20

const C = {
  border: 'rgba(127, 127, 127, 0.26)',
  borderSoft: 'rgba(127, 127, 127, 0.16)',
  soft: 'rgba(127, 127, 127, 0.07)',
  muted: 'rgba(127, 127, 127, 0.78)',
}

const S = {
  root: { display: 'flex', flexDirection: 'column', gap: '12px', fontSize: '13px', lineHeight: 1.5 },
  header: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
  title: { margin: 0, fontSize: '15px', fontWeight: 600 },
  spacer: { flex: '1 1 auto' },
  chip: {
    display: 'inline-block', padding: '0 7px', borderRadius: '999px',
    border: '1px solid currentColor', fontSize: '11px', opacity: 0.8,
  },
  tabs: { display: 'flex', gap: '2px', borderBottom: `1px solid ${C.border}`, paddingBottom: '2px', flexWrap: 'wrap' },
  tab: {
    padding: '4px 10px', borderRadius: '6px 6px 0 0', border: '1px solid transparent',
    background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px', opacity: 0.75,
  },
  tabActive: {
    padding: '4px 10px', borderRadius: '6px 6px 0 0', border: `1px solid ${C.border}`,
    borderBottom: '1px solid transparent', background: C.soft, color: 'inherit', cursor: 'pointer',
    fontSize: '12px', fontWeight: 600, marginBottom: '-3px',
  },
  section: { border: `1px solid ${C.border}`, borderRadius: '10px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' },
  sectionHead: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
  sectionTitle: { margin: 0, fontSize: '12px', fontWeight: 600, opacity: 0.85 },
  muted: { margin: 0, opacity: 0.72, fontSize: '12px' },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '11px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: '8px' },
  tile: { border: `1px solid ${C.border}`, borderRadius: '8px', padding: '7px 10px' },
  tileLabel: { margin: 0, fontSize: '11px', opacity: 0.7 },
  tileValue: { margin: '1px 0 0', fontSize: '18px', fontWeight: 600 },
  rows: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '5px 12px', margin: 0, alignItems: 'baseline' },
  term: { margin: 0, opacity: 0.7, whiteSpace: 'nowrap' as const },
  desc: { margin: 0, wordBreak: 'break-all' as const },
  tableWrap: { overflowX: 'auto' as const },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '12px' },
  th: {
    textAlign: 'left' as const, padding: '4px 6px', opacity: 0.7, fontWeight: 500,
    borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' as const,
  },
  td: { padding: '4px 6px', borderBottom: `1px solid ${C.borderSoft}`, verticalAlign: 'top' as const },
  footer: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  button: {
    padding: '3px 11px', borderRadius: '6px', border: `1px solid ${C.border}`,
    background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px',
  },
  primary: {
    padding: '3px 11px', borderRadius: '6px', border: '1px solid currentColor',
    background: C.soft, color: 'inherit', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
  },
  smallButton: {
    padding: '1px 8px', borderRadius: '999px', border: `1px solid ${C.border}`,
    background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '11px',
  },
  toolbar: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' as const },
  filter: {
    padding: '2px 10px', borderRadius: '999px', border: `1px solid ${C.border}`,
    background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '11px',
  },
  filterActive: {
    padding: '2px 10px', borderRadius: '999px', border: '1px solid currentColor',
    background: C.soft, color: 'inherit', cursor: 'pointer', fontSize: '11px', fontWeight: 600,
  },
  select: {
    padding: '3px 6px', borderRadius: '6px', border: `1px solid ${C.border}`,
    background: 'transparent', color: 'inherit', fontSize: '12px', maxWidth: '200px',
  },
  input: {
    padding: '4px 8px', borderRadius: '6px', border: `1px solid ${C.border}`,
    background: 'transparent', color: 'inherit', fontSize: '12px', width: '100%', boxSizing: 'border-box' as const,
  },
  textarea: {
    padding: '6px 8px', borderRadius: '6px', border: `1px solid ${C.border}`,
    background: 'transparent', color: 'inherit', fontSize: '12px', width: '100%',
    minHeight: '58px', resize: 'vertical' as const, boxSizing: 'border-box' as const,
  },
  eventList: { display: 'flex', flexDirection: 'column' as const, gap: '6px', margin: 0, padding: 0, listStyle: 'none' },
  eventCard: {
    border: `1px solid ${C.borderSoft}`, borderRadius: '8px', padding: '6px 9px',
    display: 'flex', flexDirection: 'column' as const, gap: '2px',
  },
  eventTop: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' as const },
  eventNote: { margin: 0, opacity: 0.85, wordBreak: 'break-word' as const },
  sessionRow: {
    display: 'flex', flexDirection: 'column' as const, gap: '2px', width: '100%', textAlign: 'left' as const,
    padding: '6px 8px', borderRadius: '8px', border: `1px solid ${C.borderSoft}`,
    background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px',
  },
  sessionRowActive: {
    display: 'flex', flexDirection: 'column' as const, gap: '2px', width: '100%', textAlign: 'left' as const,
    padding: '6px 8px', borderRadius: '8px', border: '1px solid currentColor',
    background: C.soft, color: 'inherit', cursor: 'pointer', fontSize: '12px',
  },
  sessionList: { display: 'flex', flexDirection: 'column' as const, gap: '5px', margin: 0, padding: 0, listStyle: 'none' },
  ruleRow: { display: 'flex', flexDirection: 'column' as const, gap: '2px', padding: '6px 0', borderBottom: `1px solid ${C.borderSoft}` },
  pre: {
    margin: 0, padding: '8px', borderRadius: '6px', background: C.soft,
    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '11px',
    whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const, maxHeight: '240px', overflow: 'auto' as const,
  },
} satisfies Record<string, CSSProperties>

/** Solid pills: readable on both shells, no theme lookup needed. */
const PILL: Record<Tone, CSSProperties> = {
  danger: { background: '#dc2626', color: '#fff' },
  warn: { background: '#b45309', color: '#fff' },
  ask: { background: '#6d28d9', color: '#fff' },
  ok: { background: '#15803d', color: '#fff' },
  muted: { background: 'rgba(127, 127, 127, 0.22)', color: 'inherit' },
}

/** Text colours for tile values (work on light and dark backgrounds). */
const VALUE_COLOR: Record<Tone, string | undefined> = {
  danger: '#ef4444',
  warn: '#f59e0b',
  ask: '#a78bfa',
  ok: '#22c55e',
  muted: undefined,
}

/** Decision → human label. */
const DECISION_LABELS: Record<string, string> = {
  deny: '拦截',
  block: '拦截',
  fail: '失败',
  error: '出错',
  warn: '告警',
  ask: '待审批',
  asked: '审批请求',
  allow: '放行',
  ok: '正常',
}

/** Record kind → what surface produced it. */
const KIND_LABELS: Record<string, string> = {
  input_denied: '输入',
  input_checked: '输入',
  tool_denied: '工具调用',
  tool_asked: '工具审批',
  tool_result: '工具结果',
  tool_result_flagged: '工具结果',
  tool_executed: '工具执行',
  approval_asked: '审批请求',
  approval_decided: '审批结果',
  budget_exceeded: '预算',
  output_reviewed: '输出审查',
  posture_report: '姿态自检',
  patrol_report: '巡检',
  invariant_probe: '自检',
  error: '内部错误',
}

/** Reason code → short operator explanation (codes only; never matched text). */
const REASON_LABELS: Record<string, string> = {
  input_rule_hit: '命中输入规则',
  input_sql_dangerous: '危险 SQL',
  input_truncated: '输入超长',
  input_engine_unavailable: '输入引擎不可用',
  tool_denied_by_name: '工具名黑名单',
  tool_denied_by_tag: '工具能力标签被禁',
  tool_denied_by_args: '参数命中危险模式',
  tool_denied_by_chain: '命中调用链规则',
  tool_ask_required: '需要人工审批',
  tool_args_too_large: '参数过大',
  guard_internal_error: '守卫内部错误',
  credential_leak: '结果中含凭据',
  injection_marker: '结果中含注入标记',
  output_rule_hit: '输出命中规则',
  output_judge_blocked: '语义评审拦截',
  output_judge_unavailable: '语义评审不可用',
  budget_exceeded: '超出每轮 token 预算',
  approval_delegated: '审批已委派给宿主',
  approval_policy: '按本插件审批策略处理',
  approval_allowed_once: '一次性放行',
  approval_rejected: '审批被拒',
  approval_not_granted: '未获批准',
  none: '—',
}

/** Severity → label; unknown severities render raw. */
const SEVERITY_LABELS: Record<string, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  info: '提示',
}

/** Enforcement mode → label + tone. */
const MODE_LABELS: Record<string, { readonly text: string; readonly tone: Tone }> = {
  enforce: { text: '强制拦截', tone: 'danger' },
  warn: { text: '仅告警', tone: 'warn' },
  'enforce-buffer': { text: '缓冲后拦截', tone: 'danger' },
  off: { text: '关闭', tone: 'muted' },
  delegate: { text: '透传宿主', tone: 'muted' },
  policy: { text: '插件策略', tone: 'ask' },
}

/** Interval choices offered for the patrol timer (minutes). */
const INTERVAL_CHOICES = [5, 15, 30, 60, 180, 360, 720, 1_440]

/** A tab pane: kept mounted so drafts and patrol results survive a tab switch. */
function tabPane(active: boolean): CSSProperties {
  return { display: active ? 'flex' : 'none', flexDirection: 'column', gap: '12px' }
}

/** Tone for one disposition. */
function toneOf(decision: string): Tone {
  if (decision === 'deny' || decision === 'block' || decision === 'fail' || decision === 'error') return 'danger'
  if (decision === 'warn') return 'warn'
  if (decision === 'ask' || decision === 'asked') return 'ask'
  if (decision === 'allow' || decision === 'ok') return 'ok'
  return 'muted'
}

/** Group of one record kind (the event tab's 类别 filter). */
function kindGroupOf(kind: string): KindGroup {
  switch (kind) {
    case 'input_denied':
    case 'input_checked': return 'input'
    case 'tool_denied':
    case 'tool_asked':
    case 'tool_executed': return 'tool'
    case 'tool_result':
    case 'tool_result_flagged': return 'result'
    case 'approval_asked':
    case 'approval_decided': return 'approval'
    case 'budget_exceeded': return 'budget'
    case 'output_reviewed': return 'output'
    case 'patrol_report': return 'patrol'
    case 'posture_report':
    case 'invariant_probe': return 'posture'
    case 'error': return 'error'
    default: return 'other'
  }
}

/** True when one event belongs in the selected decision bucket. */
function matchesDecision(decision: string, filter: DecisionFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'deny') return decision === 'deny' || decision === 'block'
  if (filter === 'ask') return decision === 'ask' || decision === 'asked'
  if (filter === 'warn') return decision === 'warn'
  return decision === 'fail' || decision === 'error'
}

/** Reason text for one event: the mapped code, or a kind-level fallback. */
function reasonText(row: PanelEvent): string {
  if (row.reasonCode.length > 0) return REASON_LABELS[row.reasonCode] ?? row.reasonCode
  switch (row.kind) {
    case 'tool_result_flagged': return '结果扫描命中（凭据或注入标记）'
    case 'tool_denied': return '工具被策略拒绝'
    case 'tool_asked': return '工具调用需要审批'
    case 'approval_asked': return '等待审批裁决'
    case 'budget_exceeded': return '超出每轮 token 预算'
    case 'posture_report': return '姿态自检异常'
    case 'patrol_report': return '巡检发现异常'
    case 'error': return '插件内部错误'
    default: return '—'
  }
}

/** Human-readable uptime. */
function formatUptime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days} 天 ${hours} 小时`
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  return `${minutes} 分`
}

/** Local wall-clock rendering of one ISO instant; the raw value on a bad parse. */
function formatTime(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString()
}

/** Epoch ms → local wall clock, or a dash. */
function formatEpoch(ms: number | null): string {
  if (ms === null) return '—'
  return formatTime(new Date(ms).toISOString())
}

/** Local `HH:mm:ss` for event rows; the raw value on a bad parse. */
function formatClock(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime())
    ? iso
    : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}`
}

/** Last path segment of a project directory (the full path stays in the title). */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/** Short display name of a conversation: title, else project + id prefix. */
function sessionLabel(session: PanelSession): string {
  if (session.title !== undefined) return session.title
  const project = session.workspace === undefined ? '未知项目' : baseName(session.workspace)
  return `${project} · ${session.id}`
}

/** One solid badge. */
function Pill({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }): ReactNode {
  return (
    <span style={{
      display: 'inline-block', padding: '0 7px', borderRadius: '999px',
      fontSize: '11px', lineHeight: '18px', whiteSpace: 'nowrap', ...PILL[tone],
    }}>
      {children}
    </span>
  )
}

/** One labelled tile. */
function Tile({ label, value, tone, hint }: {
  readonly label: string
  readonly value: string | number
  readonly tone?: Tone
  readonly hint?: string
}): ReactNode {
  return (
    <div style={S.tile}>
      <p style={S.tileLabel}>{label}</p>
      <p style={{ ...S.tileValue, ...(tone === undefined ? {} : { color: VALUE_COLOR[tone] }) }}>{value}</p>
      {hint === undefined ? null : <p style={{ ...S.tileLabel, margin: '1px 0 0' }}>{hint}</p>}
    </div>
  )
}

/** One definition row. */
function Row({ term, desc }: { readonly term: string; readonly desc: ReactNode }): ReactNode {
  return (
    <>
      <dt style={S.term}>{term}</dt>
      <dd style={S.desc}>{desc}</dd>
    </>
  )
}

/** A mode value with its colour. */
function ModeValue({ mode }: { readonly mode: string }): ReactNode {
  const entry = MODE_LABELS[mode]
  if (entry === undefined) return <span>{mode}</span>
  return <Pill tone={entry.tone}>{entry.text}</Pill>
}

/** A labelled select. */
function Select({ label, value, onChange, children }: {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly children: ReactNode
}): ReactNode {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', opacity: 0.9 }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <select style={S.select} value={value} onChange={(event) => { onChange(event.target.value) }}>
        {children}
      </select>
    </label>
  )
}

/** Best-effort clipboard copy; the button still shows the text on failure. */
function copyText(text: string): void {
  try {
    void navigator.clipboard?.writeText(text)
  } catch {
    // Clipboard permission is not guaranteed in every shell; the text is visible.
  }
}

/** Error copy for one failed action code. */
function actionError(code: string): string {
  switch (code) {
    case 'invalid_body': return '请求内容不合法。'
    case 'draft_disabled': return 'AI 起草已关闭（config `draft.enabled: false`）。'
    case 'draft_unavailable': return '起草路由不可用。'
    case 'draft_in_progress': return '已有一个起草请求在运行。'
    case 'schedule_unavailable': return '本 profile 没有接定时巡检。'
    case 'reload_unavailable': return '本 profile 不支持在线重新加载。'
    case 'reload_failed': return '重新加载失败，已保留旧规则集（看日志）。'
    case 'patrol_cooldown': return '刚运行过巡检，请几秒后再试。'
    case 'patrol_in_progress': return '已经有一次巡检在运行。'
    case 'patrol_unavailable': return '本 profile 没有接巡检。'
    case 'method_not_allowed': return '该操作只接受 POST。'
    default: return '操作失败。'
  }
}

/** The events tab: filters + paged cards. */
function EventsTab({ payload, initialSession }: {
  readonly payload: PanelPayload
  readonly initialSession: string | null
}): ReactNode {
  const [workspace, setWorkspace] = useState('all')
  const [session, setSession] = useState(initialSession ?? 'all')
  const [kind, setKind] = useState<KindGroup>('all')
  const [decision, setDecision] = useState<DecisionFilter>('all')
  const [limit, setLimit] = useState(PAGE_SIZE)

  useEffect(() => { setLimit(PAGE_SIZE) }, [workspace, session, kind, decision])

  const workspaces = useMemo(() => {
    const names = new Set<string>()
    for (const detail of payload.sessionDetails) if (detail.workspace !== undefined) names.add(detail.workspace)
    for (const event of payload.recentEvents) if (event.workspace !== undefined) names.add(event.workspace)
    return [...names]
  }, [payload.sessionDetails, payload.recentEvents])

  const sessions = useMemo(() => {
    if (workspace === 'all') return payload.sessionDetails
    if (workspace === '') return payload.sessionDetails.filter(detail => detail.workspace === undefined)
    return payload.sessionDetails.filter(detail => detail.workspace === workspace)
  }, [payload.sessionDetails, workspace])

  const filtered = useMemo(() => {
    const rows = [...payload.recentEvents].reverse().filter(event => {
      if (workspace === 'all') { /* no workspace filter */ } else if ((event.workspace ?? '') !== workspace) return false
      if (session !== 'all' && event.session !== session) return false
      if (kind !== 'all' && kindGroupOf(event.kind) !== kind) return false
      if (!matchesDecision(event.decision, decision)) return false
      return true
    })
    return rows
  }, [payload.recentEvents, workspace, session, kind, decision])

  const visible = filtered.slice(0, limit)
  const counts = {
    deny: payload.recentEvents.filter(event => matchesDecision(event.decision, 'deny')).length,
    ask: payload.recentEvents.filter(event => matchesDecision(event.decision, 'ask')).length,
    warn: payload.recentEvents.filter(event => matchesDecision(event.decision, 'warn')).length,
  }

  return (
    <section style={S.section}>
      <div style={S.sectionHead}>
        <h4 style={S.sectionTitle}>事件</h4>
        <span style={{ ...S.tileLabel, opacity: 0.62 }}>
          账本最近 {payload.eventWindow.scanned} 条中 {payload.eventWindow.kept} 条需要关注
          {payload.eventWindow.since === null ? '' : ` · 从 ${formatTime(payload.eventWindow.since)} 起`}
        </span>
        <span style={S.spacer} />
        <button type="button" style={S.smallButton} onClick={() => { setWorkspace('all'); setSession('all'); setKind('all'); setDecision('all') }}>
          清除筛选
        </button>
      </div>

      <div style={S.toolbar}>
        <Select label="工作区" value={workspace} onChange={(value) => { setWorkspace(value); setSession('all') }}>
          <option value="all">全部</option>
          {workspaces.map(name => <option key={name} value={name}>{baseName(name)}</option>)}
          <option value="">未知项目</option>
        </Select>
        <Select label="对话" value={session} onChange={setSession}>
          <option value="all">全部</option>
          {sessions.map(detail => <option key={detail.id} value={detail.id}>{sessionLabel(detail)}</option>)}
        </Select>
        <Select label="类别" value={kind} onChange={(value) => { setKind(value as KindGroup) }}>
          <option value="all">全部</option>
          <option value="input">输入</option>
          <option value="tool">工具</option>
          <option value="result">工具结果</option>
          <option value="approval">审批</option>
          <option value="budget">预算</option>
          <option value="output">输出</option>
          <option value="patrol">巡检</option>
          <option value="posture">姿态</option>
          <option value="error">内部错误</option>
          <option value="other">其他</option>
        </Select>
      </div>

      <div style={S.toolbar}>
        <button type="button" style={decision === 'all' ? S.filterActive : S.filter} onClick={() => { setDecision('all') }}>
          全部 {payload.recentEvents.length}
        </button>
        <button type="button" style={decision === 'deny' ? S.filterActive : S.filter} onClick={() => { setDecision('deny') }}>
          拦截 {counts.deny}
        </button>
        <button type="button" style={decision === 'ask' ? S.filterActive : S.filter} onClick={() => { setDecision('ask') }}>
          审批 {counts.ask}
        </button>
        <button type="button" style={decision === 'warn' ? S.filterActive : S.filter} onClick={() => { setDecision('warn') }}>
          告警 {counts.warn}
        </button>
        <span style={{ ...S.tileLabel, opacity: 0.6 }}>共 {filtered.length} 条</span>
      </div>

      {filtered.length === 0 ? (
        <p style={S.muted}>
          当前筛选下没有事件。账本窗口里没有拦截/审批/告警时，这属于正常——安全面仍在记账（见"概览"的本进程放行数）。
        </p>
      ) : (
        <>
          <ul style={S.eventList}>
            {visible.map((row, index) => {
              const tone = toneOf(row.decision)
              const accent = VALUE_COLOR[tone] ?? 'rgba(127, 127, 127, 0.55)'
              return (
                <li key={`${row.ts}-${row.kind}-${index}`} style={{ ...S.eventCard, borderLeft: `3px solid ${accent}` }}>
                  <div style={S.eventTop}>
                    <Pill tone={tone}>{DECISION_LABELS[row.decision] ?? (row.decision.length > 0 ? row.decision : '—')}</Pill>
                    <strong>{row.tool ?? KIND_LABELS[row.kind] ?? row.kind}</strong>
                    {row.tool === undefined ? null : (
                      <span style={{ ...S.tileLabel, opacity: 0.6 }}>{KIND_LABELS[row.kind] ?? row.kind}</span>
                    )}
                    <span style={S.spacer} />
                    <span style={{ ...S.mono, opacity: 0.7 }}>{formatClock(row.ts)}</span>
                  </div>
                  <p style={S.eventNote}>
                    {reasonText(row)}
                    {row.severity === undefined ? '' : ` · ${SEVERITY_LABELS[row.severity] ?? row.severity}`}
                    {row.category === undefined ? '' : ` · ${row.category}`}
                  </p>
                  <div style={{ ...S.tileLabel, display: 'flex', gap: '8px', flexWrap: 'wrap', opacity: 0.75 }}>
                    {row.session === undefined ? <span>无会话</span> : (
                      <button
                        type="button"
                        style={{ ...S.smallButton, padding: '0 6px' }}
                        title={row.workspace === undefined ? '未记录项目目录' : `${row.workspace} · ${row.session}`}
                        onClick={() => { setSession(row.session as string) }}
                      >
                        {row.title ?? (row.workspace === undefined ? '未知项目' : baseName(row.workspace))} · {row.session}
                      </button>
                    )}
                    {row.ruleIds.length === 0 ? null : <span style={S.mono}>规则 {row.ruleIds.join(' · ')}</span>}
                    {row.argsHash === undefined ? null : <span style={S.mono}>参数 {row.argsHash}</span>}
                  </div>
                </li>
              )
            })}
          </ul>
          {filtered.length > visible.length ? (
            <div style={S.footer}>
              <button type="button" style={S.button} onClick={() => { setLimit(current => current + PAGE_SIZE) }}>
                显示更多（还剩 {filtered.length - visible.length} 条）
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

/** One rule row. */
function RuleRow({ rule }: { readonly rule: PanelRule }): ReactNode {
  return (
    <div style={S.ruleRow}>
      <div style={S.eventTop}>
        <Pill tone={rule.kind === 'chain' ? 'ask' : 'muted'}>{rule.kind === 'chain' ? '链' : '规则'}</Pill>
        <strong style={{ fontSize: '12px' }}>{rule.name}</strong>
        <span style={{ ...S.tileLabel, opacity: 0.65 }}>{rule.category} · {SEVERITY_LABELS[rule.severity] ?? rule.severity}</span>
        <span style={S.spacer} />
        <span style={{ ...S.tileLabel, opacity: 0.55 }}>{rule.origin.length > 0 ? rule.origin : 'chain'} · 本窗口命中 {rule.hits}</span>
      </div>
      <code style={{ ...S.mono, opacity: 0.8, wordBreak: 'break-all' }}>{rule.detail}</code>
    </div>
  )
}

/** The rules tab: inventory, AI drafting, reload. */
function RulesTab({ payload, face, onRefresh }: {
  readonly payload: PanelPayload
  readonly face: SafeHarnessPanelProps
  readonly onRefresh: () => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<'inform' | 'chain'>('inform')
  const [draft, setDraft] = useState<DraftState>({ status: 'idle' })
  const [reloading, setReloading] = useState(false)
  const [reloadMessage, setReloadMessage] = useState<string | null>(null)

  const rules = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return payload.rulesDetail
    return payload.rulesDetail.filter(rule =>
      `${rule.name} ${rule.category} ${rule.origin} ${rule.detail} ${rule.kind}`.toLowerCase().includes(needle))
  }, [payload.rulesDetail, query])

  const startDraft = (): void => {
    if (description.trim().length === 0) return
    setDraft({ status: 'running' })
    void face.draft({ description: description.trim(), kind }).then(
      value => { setDraft({ status: 'done', value }) },
      (error: unknown) => { setDraft({ status: 'error', code: error instanceof Error ? error.message : 'draft_failed' }) },
    )
  }

  const reload = (): void => {
    setReloading(true)
    setReloadMessage(null)
    void face.reloadRules().then(
      (value) => {
        setReloading(false)
        setReloadMessage(`已重新加载：${value.rules} 条规则 · ${value.chains} 条链 · ${value.hash}…`)
        onRefresh()
      },
      (error: unknown) => {
        setReloading(false)
        setReloadMessage(actionError(error instanceof Error ? error.message : 'reload_failed'))
      },
    )
  }

  return (
    <>
      <section style={S.section}>
        <div style={S.sectionHead}>
          <h4 style={S.sectionTitle}>规则集</h4>
          <span style={{ ...S.tileLabel, opacity: 0.62 }}>
            {payload.rules.count} 条规则 · {payload.rules.chains} 条链 · {payload.rules.hash}…
          </span>
          <span style={S.spacer} />
          <button type="button" style={S.button} onClick={reload} disabled={reloading}>
            {reloading ? '重新加载中…' : '重新加载规则'}
          </button>
        </div>
        <p style={S.muted}>
          规则目录：<span style={S.mono}>{payload.rulesDir.length > 0 ? payload.rulesDir : '（仅内置 rules/）'}</span>
          。改完规则文件后点"重新加载规则"，不需要重启；加载失败会保留旧规则集并写日志。
        </p>
        {reloadMessage === null ? null : <p style={S.muted} role="status">{reloadMessage}</p>}
        <input
          style={S.input}
          placeholder="搜索规则名 / 类别 / 模式…"
          value={query}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <div>
          {rules.length === 0
            ? <p style={S.muted}>没有匹配的规则。</p>
            : rules.map(rule => <RuleRow key={`${rule.kind}-${rule.name}`} rule={rule} />)}
        </div>
      </section>

      <section style={S.section}>
        <div style={S.sectionHead}>
          <h4 style={S.sectionTitle}>AI 起草规则</h4>
          <span style={{ ...S.tileLabel, opacity: 0.62 }}>
            {payload.draft.enabled ? `已启用 · 描述上限 ${payload.draft.maxChars} 字` : '未启用（config `draft.enabled`）'}
          </span>
        </div>
        <p style={S.muted}>
          用一句话描述"要抓什么"，让辅助模型起草一条规则。**草稿不会自动生效**：它只返回经 loader 门校验的 YAML，
          你复制到 rules 目录（或 `rules.inline`）后再点"重新加载规则"。起草会调用一次模型，描述文字会进入该次调用。
        </p>
        <textarea
          style={S.textarea}
          placeholder="例：curl 下载脚本后直接交给 sh 执行"
          value={description}
          maxLength={payload.draft.maxChars > 0 ? payload.draft.maxChars : 2_000}
          onChange={(event) => { setDescription(event.target.value) }}
        />
        <div style={S.toolbar}>
          <Select label="类型" value={kind} onChange={(value) => { setKind(value === 'chain' ? 'chain' : 'inform') }}>
            <option value="inform">单条规则（inform）</option>
            <option value="chain">调用链（chain）</option>
          </Select>
          <button
            type="button"
            style={S.primary}
            disabled={!payload.draft.enabled || draft.status === 'running' || description.trim().length === 0}
            onClick={startDraft}
          >
            {draft.status === 'running' ? '起草中…' : '起草'}
          </button>
          {draft.status === 'error' ? <span role="alert">{actionError(draft.code)}</span> : null}
        </div>
        {draft.status === 'done' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={S.eventTop}>
              <Pill tone="ok">草稿</Pill>
              <strong>{draft.value.name}</strong>
              <span style={{ ...S.tileLabel, opacity: 0.65 }}>
                {draft.value.category} · {SEVERITY_LABELS[draft.value.severity] ?? draft.value.severity}
              </span>
              <span style={S.spacer} />
              <button type="button" style={S.smallButton} onClick={() => { copyText(draft.value.yaml) }}>复制 YAML</button>
            </div>
            <pre style={S.pre}>{draft.value.yaml}</pre>
            {draft.value.warnings.length === 0 ? null : (
              <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '11px', opacity: 0.8 }}>
                {draft.value.warnings.map(warning => <li key={warning}>{warning}</li>)}
              </ul>
            )}
            <p style={S.muted}>{draft.value.summary}</p>
          </div>
        ) : null}
      </section>
    </>
  )
}

/** The patrol tab: manual run plus the optional timer. */
function PatrolTab({ payload, face, onRefresh }: {
  readonly payload: PanelPayload
  readonly face: SafeHarnessPanelProps
  readonly onRefresh: () => void
}): ReactNode {
  const [state, setState] = useState<PatrolState>({ status: 'idle' })
  const [schedule, setSchedule] = useState<{ enabled: boolean; intervalMinutes: number }>({
    enabled: payload.schedule.enabled,
    intervalMinutes: payload.schedule.intervalMinutes ?? 30,
  })
  const [saving, setSaving] = useState(false)
  const [scheduleError, setScheduleError] = useState<string | null>(null)

  useEffect(() => {
    setSchedule({
      enabled: payload.schedule.enabled,
      intervalMinutes: payload.schedule.intervalMinutes ?? 30,
    })
  }, [payload.schedule.enabled, payload.schedule.intervalMinutes])

  const run = useCallback((): void => {
    setState({ status: 'running' })
    void face.patrol().then(
      (report) => {
        setState({ status: 'done', report })
        onRefresh()
      },
      (error: unknown) => {
        setState({ status: 'error', code: error instanceof Error ? error.message : 'patrol_failed' })
      },
    )
  }, [face, onRefresh])

  const saveSchedule = (): void => {
    setSaving(true)
    setScheduleError(null)
    const intervalMinutes = schedule.enabled ? schedule.intervalMinutes : null
    void face.schedule({ enabled: schedule.enabled, intervalMinutes }).then(
      () => { setSaving(false); onRefresh() },
      (error: unknown) => { setSaving(false); setScheduleError(actionError(error instanceof Error ? error.message : 'invalid_body')) },
    )
  }

  return (
    <>
      <section style={S.section}>
        <div style={S.sectionHead}>
          <h4 style={S.sectionTitle}>手动巡检</h4>
          <span style={{ ...S.tileLabel, opacity: 0.62 }}>拒绝速率 · 健康探针 · 姿态漂移 · 账本对账 · 通知通道</span>
        </div>
        <p style={S.muted}>
          运行一次外部巡检。它会写一条 <code>patrol_report</code> 记录，并在配置了通知通道时发送一条摘要。
        </p>
        <div style={S.footer}>
          {state.status !== 'confirming' && state.status !== 'running' ? (
            <button type="button" style={S.primary} onClick={() => { setState({ status: 'confirming' }) }}>运行巡检</button>
          ) : null}
          {state.status === 'confirming' ? (
            <>
              <span>确认运行一次巡检？</span>
              <button type="button" style={S.primary} onClick={run}>确认运行</button>
              <button type="button" style={S.button} onClick={() => { setState({ status: 'idle' }) }}>取消</button>
            </>
          ) : null}
          {state.status === 'running' ? <span style={S.muted}>巡检运行中…</span> : null}
          {state.status === 'error' ? <span role="alert">{actionError(state.code)}</span> : null}
        </div>
        {state.status === 'done' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={S.grid}>
              <Tile label="FAIL" value={state.report.summary.fail} tone={state.report.summary.fail > 0 ? 'danger' : 'ok'} />
              <Tile label="WARN / OK / SKIP" value={`${state.report.summary.warn} / ${state.report.summary.ok} / ${state.report.summary.skip}`} tone={state.report.summary.warn > 0 ? 'warn' : 'ok'} />
              <Tile label="退出码" value={state.report.exitCode} tone={state.report.exitCode === 0 ? 'ok' : 'danger'} />
              <Tile label="通知" value={state.report.notified ? '已送达' : '未发送'} tone="muted" />
            </div>
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>检查</th>
                    <th style={S.th}>结论</th>
                    <th style={S.th}>细节</th>
                  </tr>
                </thead>
                <tbody>
                  {state.report.findings.map(finding => (
                    <tr key={finding.code}>
                      <td style={S.td}>{finding.code}</td>
                      <td style={S.td}>
                        <Pill tone={finding.severity === 'FAIL' ? 'danger' : finding.severity === 'WARN' ? 'warn' : finding.severity === 'OK' ? 'ok' : 'muted'}>
                          {finding.severity}
                        </Pill>
                      </td>
                      <td style={S.td}>{finding.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={S.muted}>
              运行于 {formatTime(state.report.ranAt)}
              {state.report.internalError === undefined ? '' : ` · 内部错误：${state.report.internalError}`}
              {state.report.summary.clean ? ' · 干净' : ''}
            </p>
          </div>
        ) : null}
      </section>

      <section style={S.section}>
        <div style={S.sectionHead}>
          <h4 style={S.sectionTitle}>定时巡检</h4>
          <span style={{ ...S.tileLabel, opacity: 0.62 }}>
            {payload.schedule.enabled ? `已启用 · 每 ${payload.schedule.intervalMinutes} 分钟` : '未启用'}
          </span>
        </div>
        <p style={S.muted}>
          按固定间隔自动跑一次上面的巡检（写账本、按配置发通知）。调度器在宿主进程里，随插件卸载而停止；
          设置保存在 <span style={S.mono}>$DSH_HOME/safeharness/panel-state.json</span>，重启后恢复。
        </p>
        <div style={S.toolbar}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
            <input
              type="checkbox"
              checked={schedule.enabled}
              onChange={(event) => { setSchedule(current => ({ ...current, enabled: event.target.checked })) }}
            />
            启用定时巡检
          </label>
          <Select
            label="间隔"
            value={String(schedule.intervalMinutes)}
            onChange={(value) => { setSchedule(current => ({ ...current, intervalMinutes: Number(value) })) }}
          >
            {INTERVAL_CHOICES.map(minutes => (
              <option key={minutes} value={minutes}>
                {minutes < 60 ? `${minutes} 分钟` : minutes === 60 ? '1 小时' : minutes === 1_440 ? '24 小时' : `${minutes / 60} 小时`}
              </option>
            ))}
          </Select>
          <button type="button" style={S.button} onClick={saveSchedule} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
          {scheduleError === null ? null : <span role="alert">{scheduleError}</span>}
        </div>
        <dl style={S.rows}>
          <Row term="下次运行" desc={formatEpoch(payload.schedule.nextAt)} />
          <Row term="上次定时运行" desc={formatEpoch(payload.schedule.lastRunAt)} />
          <Row term="状态文件" desc={payload.schedule.persisted ? '已持久化' : '未持久化（重启后丢失）'} />
        </dl>
      </section>
    </>
  )
}

/** The tab body. */
export function SafeHarnessPanel({ load, patrol, draft, schedule, reloadRules }: SafeHarnessPanelProps): ReactNode {
  const face: SafeHarnessPanelProps = { load, patrol, draft, schedule, reloadRules }
  const [view, setView] = useState<View>({ status: 'loading' })
  const [request, setRequest] = useState(0)
  const [tab, setTab] = useState<Tab>('overview')
  const [sessionFilter, setSessionFilter] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void load().then(
      (payload) => { if (current) setView({ status: 'ready', payload }) },
      () => { if (current) setView({ status: 'error' }) },
    )
    return () => { current = false }
  }, [load, request])

  const refresh = useCallback(() => { setRequest(value => value + 1) }, [])

  if (view.status === 'loading') {
    return <div style={S.root}><p style={S.muted}>正在读取 SafeHarness 状态…</p></div>
  }
  if (view.status === 'error') {
    return (
      <div style={S.root}>
        <p role="alert">读取状态失败。插件可能未加载，或本 profile 没有 Web 传输通道。</p>
        <div style={S.footer}>
          <button type="button" style={S.button} onClick={() => { setView({ status: 'loading' }); refresh() }}>重试</button>
        </div>
      </div>
    )
  }

  const { payload } = view
  const tabs: readonly { readonly id: Tab; readonly label: string }[] = [
    { id: 'overview', label: '概览' },
    { id: 'events', label: `事件 · ${payload.recentEvents.length}` },
    { id: 'rules', label: `规则 · ${payload.rules.count + payload.rules.chains}` },
    { id: 'patrol', label: '巡检' },
  ]

  return (
    <div style={S.root}>
      <header style={S.header}>
        <h3 style={S.title}>SafeHarness</h3>
        <span style={S.chip}>v{payload.version}</span>
        <span style={S.chip}>{payload.preset}</span>
        <span style={S.muted}>已运行 {formatUptime(payload.uptimeMs)} · {payload.sessions} 个会话</span>
        <span style={S.spacer} />
        <button type="button" style={S.button} onClick={() => { setView({ status: 'loading' }); refresh() }}>刷新</button>
      </header>

      <div style={S.tabs}>
        {tabs.map(entry => (
          <button
            key={entry.id}
            type="button"
            style={tab === entry.id ? S.tabActive : S.tab}
            onClick={() => { setTab(entry.id) }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div style={tabPane(tab === 'overview')}>
          <div style={S.grid}>
            <Tile label="拦截" value={payload.counters.deny} tone={payload.counters.deny > 0 ? 'danger' : 'ok'} hint="本进程 · 输入/工具/输出" />
            <Tile label="告警" value={payload.counters.warn} tone={payload.counters.warn > 0 ? 'warn' : 'ok'} hint="本进程 · 仅告警模式" />
            <Tile label="审批" value={payload.counters.ask} tone={payload.counters.ask > 0 ? 'ask' : 'muted'} hint="本进程 · 等待或已裁决" />
            <Tile label="放行" value={payload.counters.allow} tone="ok" hint={payload.counters.internalErrors > 0 ? `本进程 · 内部错误 ${payload.counters.internalErrors}` : '本进程 · 无内部错误'} />
          </div>

          <section style={S.section}>
            <div style={S.sectionHead}>
              <h4 style={S.sectionTitle}>防护面</h4>
              <span style={{ ...S.tileLabel, opacity: 0.62 }}>强制 = 会拦截；仅告警 = 只记账</span>
            </div>
            <dl style={S.rows}>
              <Row term="输入" desc={<ModeValue mode={payload.modes.input} />} />
              <Row term="工具调用" desc={<ModeValue mode={payload.modes.tools} />} />
              <Row term="工具结果" desc={<ModeValue mode={payload.modes.results} />} />
              <Row term="模型输出" desc={<ModeValue mode={payload.modes.output} />} />
              <Row term="审批桥" desc={<ModeValue mode={payload.modes.approval} />} />
            </dl>
          </section>

          <section style={S.section}>
            <div style={S.sectionHead}>
              <h4 style={S.sectionTitle}>会话</h4>
              <span style={{ ...S.tileLabel, opacity: 0.62 }}>按项目 + 名称 + 短 id 识别；点一行到"事件"只看该会话</span>
            </div>
            {payload.sessionDetails.length === 0 ? (
              <p style={S.muted}>还没有观察到会话。开一个新对话或发一条消息后，这里会出现。</p>
            ) : (
              <ul style={S.sessionList}>
                {payload.sessionDetails.slice(0, 8).map(detail => (
                  <li key={detail.id}>
                    <button
                      type="button"
                      style={sessionFilter === detail.id ? S.sessionRowActive : S.sessionRow}
                      title={detail.workspace}
                      onClick={() => { setSessionFilter(detail.id); setTab('events') }}
                    >
                      <span style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <strong>{sessionLabel(detail)}</strong>
                        <span style={{ ...S.mono, opacity: 0.65 }}>{detail.id}</span>
                        <span style={{ ...S.tileLabel, opacity: 0.6 }}>
                          {detail.createdAt === undefined ? '' : `创建 ${formatEpoch(detail.createdAt)} · `}
                          最近 {formatEpoch(detail.lastSeenAt)}
                        </span>
                      </span>
                      <span style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                        <Pill tone="danger">拦截 {detail.deny}</Pill>
                        <Pill tone="ask">审批 {detail.ask}</Pill>
                        <Pill tone="warn">告警 {detail.warn}</Pill>
                        <Pill tone="muted">放行 {detail.allow}</Pill>
                        <span style={{ ...S.tileLabel, opacity: 0.6 }}>{detail.calls} 次工具调用</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={S.section}>
            <div style={S.sectionHead}>
              <h4 style={S.sectionTitle}>规则与账本</h4>
              <span style={{ ...S.tileLabel, opacity: 0.62 }}>sha256 链式账本，只存哈希与长度</span>
            </div>
            <dl style={S.rows}>
              <Row term="规则集" desc={`${payload.rules.count} 条规则 · ${payload.rules.chains} 条链 · ${payload.rules.hash}…`} />
              <Row
                term="账本"
                desc={payload.ledger.enabled
                  ? `${payload.ledger.records} 条记录${payload.ledger.writable ? '' : '（不可写）'}${payload.ledger.failures > 0 ? ` · ${payload.ledger.failures} 次写失败` : ''}`
                  : '未启用'}
              />
              <Row term="账本文件" desc={<span style={S.mono}>{payload.ledger.path ?? '—'}</span>} />
              <Row term="引擎" desc={`${payload.engine.kind} · ${payload.engine.status}${payload.engine.rulesStale ? ' · 规则待更新' : ''}`} />
            </dl>
            <p style={{ ...S.tileLabel, opacity: 0.62 }}>
              完整日志：用 <code>safeharness_audit_query</code>，或在任意会话输入 <code>/safeharness audit 50</code>。
            </p>
          </section>
      </div>

      <div style={tabPane(tab === 'events')}>
        <EventsTab key={sessionFilter ?? 'all'} payload={payload} initialSession={sessionFilter} />
      </div>
      <div style={tabPane(tab === 'rules')}>
        <RulesTab payload={payload} face={face} onRefresh={refresh} />
      </div>
      <div style={tabPane(tab === 'patrol')}>
        <PatrolTab payload={payload} face={face} onRefresh={refresh} />
      </div>

      <footer style={S.footer}>
        <span style={S.muted}>
          读取于 {formatTime(payload.generatedAt)} · 只读视图；动作只有：运行巡检、定时设置、起草规则（不自动生效）、重新加载规则
        </span>
      </footer>
    </div>
  )
}
