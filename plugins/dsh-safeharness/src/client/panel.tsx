/**
 * The SafeHarness panel: one tab in the host's Plugins settings section (T5.3).
 *
 * Presentation only. It receives `load` and `patrol` from the registration face
 * and renders whatever the Host reports; it subscribes to nothing and holds no
 * state beyond the last successful reads and the local view filters. Patrol is
 * the one action: a two-step confirm (the Host also enforces single-flight and a
 * cooldown), because it appends a ledger record and may notify the configured
 * channels.
 *
 * Styling stays inline on purpose: this package is built outside the DSH
 * monorepo, where CSS Modules are compiled by a bundler preset it does not ship.
 * Solid pill colors (white on saturated fill) keep the decision badges legible
 * in both the light and dark shells without a theme lookup.
 * @module
 */
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { PanelEvent, PanelPatrolReport, PanelPayload, PanelSession } from '../panel/protocol.js'

/** The props this component reads (the renderer supplies more; they are ignored). */
export interface SafeHarnessPanelProps {
  /** Read one fresh payload from the Host. */
  readonly load: () => Promise<PanelPayload>
  /** Run one patrol on the Host. */
  readonly patrol: () => Promise<PanelPatrolReport>
}

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

/** Colour family for a badge. */
type Tone = 'danger' | 'warn' | 'ask' | 'ok' | 'muted'

/** Which events the table shows. */
type DecisionFilter = 'all' | 'deny' | 'ask' | 'warn'

const S = {
  root: { display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '13px' },
  header: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
  title: { margin: 0, fontSize: '15px', fontWeight: 600 },
  chip: {
    display: 'inline-block', padding: '1px 8px', borderRadius: '999px',
    border: '1px solid currentColor', fontSize: '11px', opacity: 0.85,
  },
  muted: { opacity: 0.7, margin: 0 },
  section: { border: '1px solid rgba(127, 127, 127, 0.25)', borderRadius: '8px', padding: '10px 12px' },
  sectionHead: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', margin: '0 0 8px' },
  sectionTitle: { margin: 0, fontSize: '12px', fontWeight: 600, opacity: 0.85 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px' },
  tile: { border: '1px solid rgba(127, 127, 127, 0.35)', borderRadius: '8px', padding: '8px 10px' },
  tileLabel: { margin: 0, fontSize: '11px', opacity: 0.7 },
  tileValue: { margin: '2px 0 0', fontSize: '18px', fontWeight: 600 },
  eventList: { display: 'flex', flexDirection: 'column' as const, gap: '6px', margin: 0, padding: 0, listStyle: 'none' },
  eventCard: {
    border: '1px solid rgba(127, 127, 127, 0.22)', borderRadius: '6px',
    padding: '6px 8px', display: 'flex', flexDirection: 'column' as const, gap: '3px',
  },
  eventTop: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' as const },
  eventSpacer: { flex: '1 1 auto' },
  eventMeta: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' as const, fontSize: '11px' },
  eventNote: { margin: 0, opacity: 0.72, wordBreak: 'break-word' as const },
  severityChip: {
    padding: '0 6px', borderRadius: '999px', border: '1px solid currentColor',
    fontSize: '10px', lineHeight: '16px', opacity: 0.85,
  },
  rows: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', margin: 0 },
  term: { margin: 0, opacity: 0.7 },
  desc: { margin: 0, wordBreak: 'break-all' as const },
  code: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '11px' },
  tableWrap: { overflowX: 'auto' as const },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '12px' },
  th: {
    textAlign: 'left' as const, padding: '4px 6px', opacity: 0.7, fontWeight: 500,
    borderBottom: '1px solid rgba(127, 127, 127, 0.3)', whiteSpace: 'nowrap' as const,
  },
  td: { padding: '4px 6px', borderBottom: '1px solid rgba(127, 127, 127, 0.15)', verticalAlign: 'top' as const },
  footer: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  button: {
    padding: '3px 12px', borderRadius: '6px', border: '1px solid currentColor',
    background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px',
  },
  dangerButton: {
    padding: '3px 12px', borderRadius: '6px', border: '1px solid currentColor',
    background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
  },
  toolbar: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' as const, marginBottom: '8px' },
  filter: {
    padding: '2px 10px', borderRadius: '999px', border: '1px solid rgba(127, 127, 127, 0.45)',
    background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '11px',
  },
  filterActive: {
    padding: '2px 10px', borderRadius: '999px', border: '1px solid currentColor',
    background: 'rgba(127, 127, 127, 0.16)', color: 'inherit', cursor: 'pointer', fontSize: '11px', fontWeight: 600,
  },
  sessionRow: {
    display: 'flex', flexDirection: 'column' as const, gap: '2px', width: '100%', textAlign: 'left' as const,
    padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(127, 127, 127, 0.25)',
    background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px',
  },
  sessionRowActive: {
    display: 'flex', flexDirection: 'column' as const, gap: '2px', width: '100%', textAlign: 'left' as const,
    padding: '6px 8px', borderRadius: '6px', border: '1px solid currentColor',
    background: 'rgba(127, 127, 127, 0.14)', color: 'inherit', cursor: 'pointer', fontSize: '12px',
  },
  sessionList: { display: 'flex', flexDirection: 'column' as const, gap: '6px', margin: 0, padding: 0, listStyle: 'none' },
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
  error: '内部错误',
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
  tool_denied: '工具',
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

/** Tone for one disposition. */
function toneOf(decision: string): Tone {
  if (decision === 'deny' || decision === 'block' || decision === 'fail' || decision === 'error') return 'danger'
  if (decision === 'warn') return 'warn'
  if (decision === 'ask' || decision === 'asked') return 'ask'
  if (decision === 'allow' || decision === 'ok') return 'ok'
  return 'muted'
}

/** True when one event belongs in the selected decision bucket. */
function matchesFilter(decision: string, filter: DecisionFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'deny') return decision === 'deny' || decision === 'block'
  if (filter === 'ask') return decision === 'ask' || decision === 'asked'
  return decision === 'warn' || decision === 'fail'
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

/** Local `HH:mm:ss` for table rows; the raw value on a bad parse. */
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
      {hint === undefined ? null : <p style={{ ...S.tileLabel, margin: '2px 0 0' }}>{hint}</p>}
    </div>
  )
}

/** One definition row in a section. */
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

/** One event card: decision + tool + reason + project/session + rules. */
function Events({ rows, onSession }: {
  readonly rows: readonly PanelEvent[]
  readonly onSession: (session: string) => void
}): ReactNode {
  if (rows.length === 0) {
    return <p style={S.muted}>当前筛选下没有事件。</p>
  }
  return (
    <ul style={S.eventList}>
      {rows.map((row, index) => {
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
              <span style={S.eventSpacer} />
              <span style={{ ...S.code, opacity: 0.7 }}>{formatClock(row.ts)}</span>
            </div>
            <p style={S.eventNote}>
              {reasonText(row)}
              {row.severity === undefined ? '' : ` · ${SEVERITY_LABELS[row.severity] ?? row.severity}`}
              {row.category === undefined ? '' : ` · ${row.category}`}
            </p>
            <div style={S.eventMeta}>
              {row.session === undefined ? <span style={{ opacity: 0.6 }}>无会话</span> : (
                <button
                  type="button"
                  style={{ ...S.filter, padding: '0 7px' }}
                  title={row.workspace === undefined ? '未记录项目目录' : `${row.workspace} · ${row.session}`}
                  onClick={() => { onSession(row.session as string) }}
                >
                  {row.workspace === undefined ? '未知项目' : baseName(row.workspace)} · {row.session}
                </button>
              )}
              {row.ruleIds.length === 0 ? null : (
                <span style={S.code}>规则 {row.ruleIds.join(' · ')}</span>
              )}
              {row.argsHash === undefined ? null : (
                <span style={{ ...S.code, opacity: 0.6 }}>参数 {row.argsHash}</span>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** The tracked-session list (click to filter the events table). */
function Sessions({ rows, active, onToggle }: {
  readonly rows: readonly PanelSession[]
  readonly active: string | null
  readonly onToggle: (session: string) => void
}): ReactNode {
  if (rows.length === 0) return <p style={S.muted}>还没有观察到会话。</p>
  return (
    <ul style={S.sessionList}>
      {rows.map(row => {
        const selected = active === row.id
        return (
          <li key={row.id}>
            <button
              type="button"
              style={selected ? S.sessionRowActive : S.sessionRow}
              aria-pressed={selected}
              title={row.workspace}
              onClick={() => { onToggle(row.id) }}
            >
              <span style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <strong>{row.workspace === undefined ? '未知项目' : baseName(row.workspace)}</strong>
                <span style={{ ...S.code, opacity: 0.7 }}>{row.id}</span>
                <span style={{ ...S.tileLabel, opacity: 0.6 }}>
                  {row.createdAt === undefined ? '' : `创建 ${formatTime(new Date(row.createdAt).toISOString())} · `}
                  最近 {formatClock(new Date(row.lastSeenAt).toISOString())}
                </span>
              </span>
              <span style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                <Pill tone="danger">拦截 {row.deny}</Pill>
                <Pill tone="ask">审批 {row.ask}</Pill>
                <Pill tone="warn">告警 {row.warn}</Pill>
                <Pill tone="muted">放行 {row.allow}</Pill>
                <span style={{ ...S.tileLabel, opacity: 0.6 }}>{row.calls} 次工具调用</span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** What a failed patrol call means, in user terms (the Host's codes are stable). */
function patrolErrorMessage(code: string): string {
  switch (code) {
    case 'patrol_cooldown': return '刚运行过巡检，请几秒后再试。'
    case 'patrol_in_progress': return '已经有一次巡检在运行。'
    case 'patrol_unavailable': return '本 profile 没有接巡检。'
    default: return '巡检失败。'
  }
}

/** Patrol controls plus the last report. */
function PatrolSection({ patrol, onRefresh }: {
  readonly patrol: () => Promise<PanelPatrolReport>
  readonly onRefresh: () => void
}): ReactNode {
  const [state, setState] = useState<PatrolState>({ status: 'idle' })

  const run = useCallback((): void => {
    setState({ status: 'running' })
    void patrol().then(
      (report) => {
        setState({ status: 'done', report })
        // A patrol appends a record and may move counters; refresh the status
        // half so the two halves never disagree on screen.
        onRefresh()
      },
      (error: unknown) => {
        setState({ status: 'error', code: error instanceof Error ? error.message : 'patrol_failed' })
      },
    )
  }, [patrol, onRefresh])

  return (
    <section style={S.section}>
      <div style={S.sectionHead}>
        <h4 style={S.sectionTitle}>巡检</h4>
        <span style={{ ...S.tileLabel, opacity: 0.6 }}>拒绝速率 · 健康探针 · 姿态漂移 · 账本对账 · 通知通道</span>
      </div>
      <p style={S.muted}>
        运行一次外部巡检。它会写一条 <code>patrol_report</code> 记录，并在配置了通知通道时发送一条摘要。
      </p>
      <div style={S.footer}>
        {state.status === 'idle' || state.status === 'error' || state.status === 'done' ? (
          <button type="button" style={S.button} onClick={() => { setState({ status: 'confirming' }) }}>
            运行巡检
          </button>
        ) : null}
        {state.status === 'confirming' ? (
          <>
            <span>确认运行一次巡检？</span>
            <button type="button" style={S.dangerButton} onClick={run}>确认运行</button>
            <button type="button" style={S.button} onClick={() => { setState({ status: 'idle' }) }}>取消</button>
          </>
        ) : null}
        {state.status === 'running' ? <span style={S.muted}>巡检运行中…</span> : null}
        {state.status === 'error' ? <span role="alert">{patrolErrorMessage(state.code)}</span> : null}
      </div>

      {state.status === 'done' ? (
        <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
  )
}

/** The tab body. */
export function SafeHarnessPanel({ load, patrol }: SafeHarnessPanelProps): ReactNode {
  const [view, setView] = useState<View>({ status: 'loading' })
  const [request, setRequest] = useState(0)
  const [decision, setDecision] = useState<DecisionFilter>('all')
  const [session, setSession] = useState<string | null>(null)

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
          <button
            type="button"
            style={S.button}
            onClick={() => { setView({ status: 'loading' }); refresh() }}
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  const { payload } = view
  const events = payload.recentEvents
  const newestFirst = [...events].reverse()
  const counts = {
    deny: events.filter(event => matchesFilter(event.decision, 'deny')).length,
    ask: events.filter(event => matchesFilter(event.decision, 'ask')).length,
    warn: events.filter(event => matchesFilter(event.decision, 'warn')).length,
  }
  const visible = newestFirst.filter(event =>
    matchesFilter(event.decision, decision) && (session === null || event.session === session))

  return (
    <div style={S.root}>
      <header style={S.header}>
        <h3 style={S.title}>SafeHarness</h3>
        <span style={S.chip}>v{payload.version}</span>
        <span style={S.chip}>{payload.preset}</span>
        <span style={S.muted}>已运行 {formatUptime(payload.uptimeMs)} · {payload.sessions} 个会话</span>
      </header>

      <div style={S.grid}>
        <Tile label="拦截" value={payload.counters.deny} tone={payload.counters.deny > 0 ? 'danger' : 'ok'} hint="本进程 · 输入/工具/输出" />
        <Tile label="告警" value={payload.counters.warn} tone={payload.counters.warn > 0 ? 'warn' : 'ok'} hint="本进程 · 仅告警模式" />
        <Tile label="审批" value={payload.counters.ask} tone={payload.counters.ask > 0 ? 'ask' : 'muted'} hint="本进程 · 等待或已裁决" />
        <Tile label="放行" value={payload.counters.allow} tone="ok" hint={payload.counters.internalErrors > 0 ? `本进程 · 内部错误 ${payload.counters.internalErrors}` : '本进程 · 无内部错误'} />
      </div>

      <section style={S.section}>
        <div style={S.sectionHead}>
          <h4 style={S.sectionTitle}>最近拦截与审批</h4>
          <span style={{ ...S.tileLabel, opacity: 0.6 }}>
            账本最近 {payload.eventWindow.scanned} 条中 {payload.eventWindow.kept} 条需要关注
            {payload.eventWindow.since === null ? '' : ` · 从 ${formatTime(payload.eventWindow.since)} 起`}
          </span>
        </div>
        <div style={S.toolbar}>
          <button type="button" style={decision === 'all' ? S.filterActive : S.filter} onClick={() => { setDecision('all') }}>
            全部 {events.length}
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
          {session === null ? null : (
            <button type="button" style={S.filterActive} onClick={() => { setSession(null) }}>
              会话 {session} ×
            </button>
          )}
        </div>
        <Events rows={visible} onSession={(id) => { setSession(current => (current === id ? null : id)) }} />
      </section>

      <section style={S.section}>
        <div style={S.sectionHead}>
          <h4 style={S.sectionTitle}>会话</h4>
          <span style={{ ...S.tileLabel, opacity: 0.6 }}>点击一行只看该会话的事件</span>
        </div>
        <Sessions rows={payload.sessionDetails} active={session} onToggle={(id) => { setSession(current => (current === id ? null : id)) }} />
      </section>

      <section style={S.section}>
        <div style={S.sectionHead}>
          <h4 style={S.sectionTitle}>判定模式</h4>
          <span style={{ ...S.tileLabel, opacity: 0.6 }}>强制 = 会拦截；仅告警 = 只记账</span>
        </div>
        <dl style={S.rows}>
          <Row term="输入" desc={<ModeValue mode={payload.modes.input} />} />
          <Row term="工具" desc={<ModeValue mode={payload.modes.tools} />} />
          <Row term="工具结果" desc={<ModeValue mode={payload.modes.results} />} />
          <Row term="输出" desc={<ModeValue mode={payload.modes.output} />} />
          <Row term="审批" desc={<ModeValue mode={payload.modes.approval} />} />
        </dl>
      </section>

      <section style={S.section}>
        <div style={S.sectionHead}>
          <h4 style={S.sectionTitle}>规则与账本</h4>
          <span style={{ ...S.tileLabel, opacity: 0.6 }}>sha256 链式账本，只存哈希与长度</span>
        </div>
        <dl style={S.rows}>
          <Row term="规则集" desc={`${payload.rules.count} 条 · ${payload.rules.chains} 条链 · ${payload.rules.hash}…`} />
          <Row
            term="账本"
            desc={payload.ledger.enabled
              ? `${payload.ledger.records} 条记录${payload.ledger.writable ? '' : '（不可写）'}${payload.ledger.failures > 0 ? ` · ${payload.ledger.failures} 次写失败` : ''}`
              : '未启用'}
          />
          <Row term="账本文件" desc={<span style={S.code}>{payload.ledger.path ?? '—'}</span>} />
          <Row term="引擎" desc={`${payload.engine.kind} · ${payload.engine.status}${payload.engine.rulesStale ? ' · 规则待更新' : ''}`} />
        </dl>
        <p style={{ ...S.tileLabel, opacity: 0.6, marginTop: '6px' }}>
          完整日志：在上方会话里用 <code>safeharness_audit_query</code>，或在任意会话输入 <code>/safeharness audit 50</code>。
        </p>
      </section>

      <PatrolSection patrol={patrol} onRefresh={refresh} />

      <footer style={S.footer}>
        <button
          type="button"
          style={S.button}
          onClick={() => { setView({ status: 'loading' }); refresh() }}
        >
          刷新
        </button>
        <span style={S.muted}>读取于 {formatTime(payload.generatedAt)} · 只读，唯一动作是"运行巡检"</span>
      </footer>
    </div>
  )
}
