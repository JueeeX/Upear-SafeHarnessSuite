/**
 * The SafeHarness panel: one read-only tab in the host's Plugins settings
 * section (T5.3).
 *
 * Presentation only. It receives `load` from the registration face and renders
 * whatever the Host reports; it subscribes to nothing and holds no state beyond
 * the last successful read. Styling stays inline on purpose: this package is
 * built outside the DSH monorepo, where CSS Modules are compiled by a bundler
 * preset it does not ship.
 * @module
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { PanelDenial, PanelPayload } from '../panel/protocol.js'

/** The props this component reads (the renderer supplies more; they are ignored). */
export interface SafeHarnessPanelProps {
  /** Read one fresh payload from the Host. */
  readonly load: () => Promise<PanelPayload>
}

/** What the tab currently shows. */
type View =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly payload: PanelPayload }

const S = {
  root: { display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '13px' },
  header: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
  title: { margin: 0, fontSize: '15px', fontWeight: 600 },
  chip: {
    display: 'inline-block', padding: '1px 8px', borderRadius: '999px',
    border: '1px solid currentColor', fontSize: '11px', opacity: 0.85,
  },
  muted: { opacity: 0.7 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' },
  tile: { border: '1px solid rgba(127, 127, 127, 0.35)', borderRadius: '8px', padding: '8px 10px' },
  tileLabel: { margin: 0, fontSize: '11px', opacity: 0.7 },
  tileValue: { margin: '2px 0 0', fontSize: '18px', fontWeight: 600 },
  section: { border: '1px solid rgba(127, 127, 127, 0.25)', borderRadius: '8px', padding: '10px 12px' },
  sectionTitle: { margin: '0 0 6px', fontSize: '12px', fontWeight: 600, opacity: 0.8 },
  rows: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', margin: 0 },
  term: { margin: 0, opacity: 0.7 },
  desc: { margin: 0 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
  th: { textAlign: 'left', padding: '3px 6px', opacity: 0.7, fontWeight: 500, borderBottom: '1px solid rgba(127, 127, 127, 0.3)' },
  td: { padding: '3px 6px', borderBottom: '1px solid rgba(127, 127, 127, 0.15)' },
  footer: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  button: {
    padding: '3px 12px', borderRadius: '6px', border: '1px solid currentColor',
    background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px',
  },
} satisfies Record<string, CSSProperties>

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

/** One labelled tile. */
function Tile({ label, value }: { readonly label: string; readonly value: string | number }): ReactNode {
  return (
    <div style={S.tile}>
      <p style={S.tileLabel}>{label}</p>
      <p style={S.tileValue}>{value}</p>
    </div>
  )
}

/** One definition row in a section. */
function Row({ term, desc }: { readonly term: string; readonly desc: string }): ReactNode {
  return (
    <>
      <dt style={S.term}>{term}</dt>
      <dd style={S.desc}>{desc}</dd>
    </>
  )
}

/** The newest denials, oldest first. */
function Denials({ rows }: { readonly rows: readonly PanelDenial[] }): ReactNode {
  if (rows.length === 0) return <p style={S.muted}>本进程还没有拦截记录。</p>
  return (
    <table style={S.table}>
      <thead>
        <tr>
          <th style={S.th}>时间</th>
          <th style={S.th}>类型</th>
          <th style={S.th}>原因</th>
          <th style={S.th}>工具</th>
          <th style={S.th}>规则数</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.ts}-${index}`}>
            <td style={S.td}>{formatTime(row.ts)}</td>
            <td style={S.td}>{row.kind}</td>
            <td style={S.td}>{row.reasonCode.length > 0 ? row.reasonCode : '—'}</td>
            <td style={S.td}>{row.tool ?? '—'}</td>
            <td style={S.td}>{row.rules}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** The tab body. */
export function SafeHarnessPanel({ load }: SafeHarnessPanelProps): ReactNode {
  const [view, setView] = useState<View>({ status: 'loading' })
  const [request, setRequest] = useState(0)

  useEffect(() => {
    let current = true
    void load().then(
      (payload) => { if (current) setView({ status: 'ready', payload }) },
      () => { if (current) setView({ status: 'error' }) },
    )
    return () => { current = false }
  }, [load, request])

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
            onClick={() => { setView({ status: 'loading' }); setRequest(value => value + 1) }}
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  const { payload } = view
  return (
    <div style={S.root}>
      <header style={S.header}>
        <h3 style={S.title}>SafeHarness</h3>
        <span style={S.chip}>v{payload.version}</span>
        <span style={S.chip}>{payload.preset}</span>
        <span style={S.muted}>已运行 {formatUptime(payload.uptimeMs)} · {payload.sessions} 个会话</span>
      </header>

      <div style={S.grid}>
        <Tile label="拦截" value={payload.counters.deny} />
        <Tile label="放行" value={payload.counters.allow} />
        <Tile label="告警" value={payload.counters.warn} />
        <Tile label="审批 / 内部错误" value={`${payload.counters.ask} / ${payload.counters.internalErrors}`} />
      </div>

      <section style={S.section}>
        <h4 style={S.sectionTitle}>判定模式</h4>
        <dl style={S.rows}>
          <Row term="输入" desc={payload.modes.input} />
          <Row term="工具" desc={payload.modes.tools} />
          <Row term="结果" desc={payload.modes.results} />
          <Row term="输出" desc={payload.modes.output} />
          <Row term="审批" desc={payload.modes.approval} />
        </dl>
      </section>

      <section style={S.section}>
        <h4 style={S.sectionTitle}>规则与账本</h4>
        <dl style={S.rows}>
          <Row term="规则集" desc={`${payload.rules.count} 条 · ${payload.rules.chains} 条链 · ${payload.rules.hash}…`} />
          <Row
            term="账本"
            desc={payload.ledger.enabled
              ? `${payload.ledger.records} 条记录${payload.ledger.writable ? '' : '（不可写）'}${payload.ledger.failures > 0 ? ` · ${payload.ledger.failures} 次写失败` : ''}`
              : '未启用'}
          />
          <Row term="引擎" desc={`${payload.engine.kind} · ${payload.engine.status}${payload.engine.rulesStale ? ' · 规则待更新' : ''}`} />
        </dl>
      </section>

      <section style={S.section}>
        <h4 style={S.sectionTitle}>最近拦截</h4>
        <Denials rows={payload.recentDenials} />
      </section>

      <footer style={S.footer}>
        <button
          type="button"
          style={S.button}
          onClick={() => { setView({ status: 'loading' }); setRequest(value => value + 1) }}
        >
          刷新
        </button>
        <span style={S.muted}>读取于 {formatTime(payload.generatedAt)} · 只读面板，不做任何修改</span>
      </footer>
    </div>
  )
}
