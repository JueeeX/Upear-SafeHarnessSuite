/**
 * The SafeHarness panel: one tab in the host's Plugins settings section (T5.3).
 *
 * Five tabs, all mounted at once (inactive panes are `display:none`) so a draft
 * result, a filter selection, a patrol report and unsaved settings survive a tab
 * switch: 概览 (what is on), 事件 (what happened, filtered + paged), 规则 (what is
 * loaded, AI drafting, reload), 巡检 (run now, or on a timer) and 设置 (judge and
 * drafting routes, plus a judge connectivity probe).
 *
 * Presentation only; it owns no security decision. The Host enforces every
 * action's gate (POST-only, single-flight, cooldown, body limits).
 *
 * Zero-content discipline: nothing here renders prompt text, tool arguments,
 * model output, a webhook or a credential — only codes, names, hashes, counts,
 * titles and operator paths. The one literal payload is a drafted rule, which
 * the operator typed and the loader's own gate validated.
 *
 * Styling: a single `<style>` element rendered inside the component's own tree,
 * with an `shp-` prefix and a dark-mode media query. Rendering the sheet in-tree
 * (instead of appending to `document.head`) keeps it working whatever subtree
 * the host mounts the tab in. No external CSS/JS dependency.
 * @module
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import type {
  PanelCustomProvider,
  PanelDraft,
  PanelDraftSettings,
  PanelDraftValue,
  PanelEvent,
  PanelExportValue,
  PanelJudgeFact,
  PanelJudgeProbe,
  PanelJudgeSettings,
  PanelPatrolReport,
  PanelPayload,
  PanelProviderInput,
  PanelProviderOption,
  PanelProviderProtocol,
  PanelRule,
  PanelRuleWriteValue,
  PanelRuleHistoryValue,
  PanelSchedule,
  PanelSession,
  PanelSettingsPatch,
  PanelSettingsValue,
  PanelOutputMode,
  PanelApprovalMode,
  PanelMode,
  PanelSurfaceSettings,
  PanelInputJudge,
  PanelResultPii,
  PanelToolDetection,
} from '../panel/protocol.js'
import type { PanelFace } from './index.js'

/** What the renderer injects; the component reads only this face. */
export type SafeHarnessPanelProps = PanelFace

/** Tabs the panel renders. */
type Tab = 'overview' | 'events' | 'rules' | 'patrol' | 'settings'

/** Colour family for a badge / dot / bar. */
type Tone = 'danger' | 'warn' | 'ask' | 'ok' | 'muted' | 'accent'

/** Decision filter buckets. */
type DecisionFilter = 'all' | 'deny' | 'ask' | 'warn' | 'fail'

/** Event kind groups. */
type KindGroup =
  | 'all'
  | 'input'
  | 'tool'
  | 'result'
  | 'approval'
  | 'budget'
  | 'output'
  | 'patrol'
  | 'posture'
  | 'error'
  | 'other'

/** The events tab's selection (owned by the panel so a payload refresh cannot reset it). */
interface EventFilter {
  /** Absolute workspace path, `all`, or '' for "no workspace was recorded". */
  readonly workspace: string
  /** Short session id, or `all`. */
  readonly session: string
  readonly kind: KindGroup
  readonly decision: DecisionFilter
}

/** One conversation offered by the 对话 picker (title/workspace are filled in later). */
interface ConversationEntry {
  readonly id: string
  title?: string
  workspace?: string
  readonly historical: boolean
}

/** One row of a custom picker's menu. */
interface PickerOption {
  readonly id: string
  readonly label: string
  readonly meta?: string
  readonly tag?: string
}

/** What the status half currently shows. */
type View =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly code: string }
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
  | { readonly status: 'error'; readonly code: string; readonly detail?: string }

/**
 * Rule-file write state: draft → confirm → write, with `exists` as the extra gate
 * that only a second click may pass (overwriting is never the default).
 */
type RuleWriteState =
  | { readonly status: 'idle' }
  | { readonly status: 'confirming' }
  | { readonly status: 'saving' }
  | { readonly status: 'exists' }
  | { readonly status: 'done'; readonly value: PanelRuleWriteValue }
  | { readonly status: 'error'; readonly code: string; readonly detail?: string; readonly problems?: readonly string[] }

/** Settings form (the judge half); numbers stay strings while being edited. */
interface JudgeForm {
  readonly enabled: boolean
  readonly scope: 'flagged' | 'always'
  readonly provider: string
  readonly model: string
  readonly maxChars: string
  readonly timeoutMs: string
}

/** Settings form (the drafting-route half). */
interface DraftForm {
  readonly provider: string
  readonly model: string
}

/** Tool-surface detection form (numbers are edited as strings). */
interface ToolDetectionForm {
  readonly descriptorScan: 'off' | 'warn' | 'enforce'
  readonly repeatedAttemptThreshold: string
  readonly entropyThreshold: string
  readonly entropyMinLength: string
  /** One table name per line (empty = no restriction). */
  readonly allowedTables: string
  /**
   * `tools.argSchemas` as JSON text (1.17.0). Empty means "no declarations".
   *
   * JSON rather than YAML because the browser has no YAML emitter and the plugin's
   * parser rejects flow sequences such as `[https]`; `JSON.parse` also lets the form
   * refuse text it cannot parse before anything reaches the host.
   */
  readonly argSchemas: string
}

/**
 * List/pattern form (1.13.0). Every list is edited as text — one entry per line —
 * and only the entries that differ from the loaded value go on the wire.
 */
interface ListForm {
  /** One tool-name glob per line. */
  readonly denyTools: string
  readonly askTools: string
  readonly allowOnce: string
  /** One semantic tag per line. */
  readonly denyTags: string
  /** `pattern: tag1, tag2` per line. */
  readonly tagOverrides: string
  /** Result categories that block, as chips. */
  readonly blockOn: readonly string[]
}

/** Rule-source and patrol form (numbers stay strings while being edited). */
interface SourceForm {
  readonly rulesDir: string
  readonly rulesWatch: boolean
  readonly patrolWindowMinutes: string
  readonly patrolFactor: string
  readonly patrolMinCount: string
}

/** The editable half of a loaded settings value. */
interface SettingsForm {
  readonly judge: JudgeForm
  readonly draft: DraftForm
  readonly surfaces: PanelSurfaceSettings
  readonly inputJudge: PanelInputJudge
  readonly toolDetection: ToolDetectionForm
  readonly pii: PanelResultPii
  readonly lists: ListForm
  readonly source: SourceForm
}

/** One loaded settings value plus the editable copy of it. */
interface SettingsData extends SettingsForm {
  readonly value: PanelSettingsValue
}

/** Settings tab load state. */
type SettingsView =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly code: string }
  | { readonly status: 'ready'; readonly data: SettingsData }

/** Save bar state. */
type SaveState =
  | { readonly status: 'idle' }
  | { readonly status: 'saving' }
  | { readonly status: 'saved' }
  | { readonly status: 'error'; readonly code: string }

/** Judge probe state. */
type ProbeState =
  | { readonly status: 'idle' }
  | { readonly status: 'running' }
  | { readonly status: 'done'; readonly probe: PanelJudgeProbe }
  | { readonly status: 'error'; readonly code: string }

/** A patch plus the validation message that stopped it, when any. */
interface PatchResult {
  readonly patch: PanelSettingsPatch | undefined
  readonly invalid: string | null
}

/** Mutable builders for the wire patch (its fields are readonly). */
interface MutableJudgePatch {
  enabled?: boolean
  scope?: 'flagged' | 'always'
  provider?: string
  model?: string
  maxChars?: number
  timeoutMs?: number
}

/** Mutable builder for the drafting-route patch. */
interface MutableDraftPatch {
  provider?: string
  model?: string
}

/** Mutable builder for the input judge patch. */
interface MutableInputJudgePatch {
  mode?: 'off' | 'flagged' | 'always'
  failClosed?: boolean
  normalize?: boolean
}

/** Mutable builder for the tool-detection patch. */
interface MutableToolDetectionPatch {
  descriptorScan?: 'off' | 'warn' | 'enforce'
  repeatedAttemptThreshold?: number
  entropyThreshold?: number
  entropyMinLength?: number
  allowedTables?: readonly string[]
  argSchemas?: readonly unknown[]
}

/** Mutable builder for the PII patch. */
interface MutablePiiPatch {
  enabled?: boolean
  classes?: readonly string[]
}

/** Mutable builder for the list/pattern patch. */
interface MutableListPatch {
  denyTools?: readonly string[]
  askTools?: readonly string[]
  denyTags?: readonly string[]
  tagOverrides?: readonly { readonly pattern: string; readonly tags: readonly string[] }[]
  blockOn?: readonly string[]
  allowOnce?: readonly string[]
}

/** Mutable builder for the rule-source / patrol patch. */
interface MutableSourcePatch {
  rulesDir?: string
  rulesWatch?: boolean
  patrolWindowMinutes?: number
  patrolFactor?: number
  patrolMinCount?: number
}

/** Mutable builder for the per-surface switchboard patch. */
interface MutableSurfacePatch {
  input?: PanelMode
  tools?: PanelMode
  results?: PanelMode
  output?: PanelOutputMode
  approval?: PanelApprovalMode
}

/**
 * The hand-declared provider form. The API key is write-only: it is never
 * seeded from anything the Host sends back and is cleared after a successful
 * add, so it can only ever travel one way.
 */
interface ProviderForm {
  readonly id: string
  readonly displayName: string
  readonly api: PanelProviderProtocol
  readonly baseURL: string
  readonly apiKey: string
  readonly model: string
  readonly modelName: string
  /** Also point the judge at the new route (default on). */
  readonly useForJudge: boolean
}

/** Add/delete state of the 自定义模型 card. */
type ProviderOp =
  | { readonly status: 'idle' }
  | { readonly status: 'adding' }
  | { readonly status: 'deleting'; readonly id: string }
  | { readonly status: 'added'; readonly provider: PanelCustomProvider; readonly judgeRouteApplied: boolean }
  | { readonly status: 'deleted'; readonly provider: PanelCustomProvider }
  | { readonly status: 'error'; readonly code: string; readonly detail?: string }

/** The overview's ledger-export state. */
type ExportState =
  | { readonly status: 'idle' }
  | { readonly status: 'running' }
  | { readonly status: 'done'; readonly count: number; readonly filename: string }
  | { readonly status: 'error'; readonly code: string }

/** Protocols pi-ai can speak, with the operator-facing label. */
const PROVIDER_PROTOCOL_OPTIONS: readonly { readonly value: PanelProviderProtocol; readonly label: string }[] = [
  { value: 'openai-completions', label: 'openai-completions（OpenAI 兼容 Chat）' },
  { value: 'openai-responses', label: 'openai-responses（OpenAI Responses）' },
  { value: 'anthropic-messages', label: 'anthropic-messages（Anthropic 兼容）' },
]

/** The empty provider form (also what a successful add resets to). */
const EMPTY_PROVIDER_FORM: ProviderForm = {
  id: '',
  displayName: '',
  api: 'openai-completions',
  baseURL: '',
  apiKey: '',
  model: '',
  modelName: '',
  useForJudge: true,
}

/** Events per page in the timeline. */
const PAGE_SIZE = 20

/** Interval choices offered for the patrol timer (minutes). */
const INTERVAL_CHOICES = [5, 15, 30, 60, 180, 360, 720, 1_440]

/** The unfiltered selection (a fresh object each time it is used, so `limit` resets). */
const EMPTY_FILTER: EventFilter = { workspace: 'all', session: 'all', kind: 'all', decision: 'all' }

/**
 * Worked example shown in the empty `tools.argSchemas` textarea.
 *
 * Chosen to be the two shapes an operator most often wants (keep writes inside the
 * workspace; keep egress on TLS) and to be valid JSON, since that is the format this
 * control speaks.
 */
const ARG_SCHEMAS_PLACEHOLDER = JSON.stringify(
  [
    {
      name: 'write_inside_workspace',
      tool: 'write',
      args: { file_path: { pathPrefix: '/workspace' } },
    },
    {
      name: 'web_https_only',
      tool: 'web_fetch',
      args: { url: { urlScheme: ['https'] } },
    },
  ],
  null,
  2,
)

/** Session-scoped keys: a Host remount (settings hot-reload) must not reset the UI. */
const TAB_KEY = 'safeharness.panel.tab'
const SETTINGS_DRAFT_KEY = 'safeharness.panel.settings-draft'
const SETTINGS_SAVED_KEY = 'safeharness.panel.settings-saved'

/** Read the remembered tab; a corrupt/absent value falls back to the overview. */
function readStoredTab(): Tab {
  const stored = readStoredValue(TAB_KEY)
  if (stored === 'overview' || stored === 'events' || stored === 'rules' || stored === 'patrol' || stored === 'settings') return stored
  return 'overview'
}

/** Best-effort sessionStorage read: storage is a convenience, never a requirement. */
function readStoredValue(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

/** Best-effort sessionStorage write/remove; a blocked store must not break the panel. */
function storeValue(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, value)
  } catch {
    // Ignore.
  }
}

/**
 * Identity of the loaded route values. A stored draft is replayed only while the
 * server still stands where it did when the draft was typed.
 *
 * Only the *editable* fields belong here. Status flags (`judge.available`,
 * `judge.configurable`, `preset`) are part of the same payload but flip on their
 * own — a probe or a preset expansion is not the operator changing the config —
 * and including them threw away a draft that was still perfectly valid.
 */
export function baselineOf(value: PanelSettingsValue): string {
  return JSON.stringify({
    // Only the editable judge fields: `available` / `configurable` are live probe
    // results, and a probe flipping false→true used to invalidate a valid draft.
    judge: {
      enabled: value.judge.enabled,
      scope: value.judge.scope,
      provider: value.judge.provider,
      model: value.judge.model,
      maxChars: value.judge.maxChars,
      timeoutMs: value.judge.timeoutMs,
    },
    draft: value.draft,
    surfaces: value.surfaces,
    inputJudge: value.inputJudge,
    toolDetection: value.toolDetection,
    pii: value.pii,
    lists: value.lists,
    source: value.source,
  })
}

/** A settings form draft kept across a Host remount. */
interface StoredSettingsDraft {
  readonly baseline: string
  readonly judge: JudgeForm
  readonly draft: DraftForm
  /** Absent drafts from 1.9.5 and earlier fall back to the loaded value. */
  readonly surfaces?: PanelSurfaceSettings
  /** Absent drafts from 1.10.0 and earlier fall back to the loaded value. */
  readonly inputJudge?: PanelInputJudge
  /** Absent drafts from 1.11.0 and earlier fall back to the loaded value. */
  readonly toolDetection?: ToolDetectionForm
  readonly pii?: PanelResultPii
  /** Absent drafts from 1.12.0 and earlier fall back to the loaded value. */
  readonly lists?: ListForm
  readonly source?: SourceForm
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
  info: '提示',
}

/** Record kind → what surface produced it. */
const KIND_LABELS: Record<string, string> = {
  input_denied: '输入',
  input_checked: '输入',
  tool_denied: '工具调用',
  tool_asked: '工具审批',
  tool_descriptor_flagged: '工具描述',
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
  input_judge_blocked: '输入评审判定注入',
  input_judge_unavailable: '输入评审不可用',
  tool_denied_by_name: '工具名黑名单',
  tool_denied_by_tag: '工具能力标签被禁',
  tool_denied_by_args: '参数命中危险模式',
  tool_denied_by_chain: '命中调用链规则',
  tool_ask_required: '需要人工审批',
  tool_args_too_large: '参数过大',
  unauthorized_sql_table: 'SQL 表不在白名单',
  tool_descriptor_injection: '工具描述含注入',
  tool_repeated_attempts: '同一工具反复失败',
  tool_high_entropy_payload: '参数疑似编码载荷',
  guard_internal_error: '守卫内部错误',
  credential_leak: '结果中含凭据',
  injection_marker: '结果中含注入标记',
  pii: '结果中含 PII',
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

/**
 * PII class → operator label (1.12.0).
 *
 * The `name` values are the kernel's own rule names (`memory/sanitizer.py`), and the
 * order is the kernel's declaration order; the label is only what the panel shows.
 */
const PII_CLASS_LABELS: readonly { readonly name: string; readonly label: string }[] = [
  { name: 'id_card', label: '身份证' },
  { name: 'phone_cn', label: '手机号' },
  { name: 'email', label: '邮箱' },
  { name: 'bank_card', label: '银行卡' },
  { name: 'api_key', label: 'API Key' },
  { name: 'jwt', label: 'JWT' },
  { name: 'doc_no', label: '红头文号' },
  { name: 'gov_serial', label: '公文流水号' },
  { name: 'customer_id', label: '客户号' },
  { name: 'internal_url', label: '内网地址' },
]

/** Result categories a save may name in `results.blockOn` (1.13.0). */
const RESULT_CATEGORY_LABELS: readonly { readonly name: string; readonly label: string }[] = [
  { name: 'credential_leak', label: '凭据泄漏' },
  { name: 'injection_marker', label: '注入标记' },
  { name: 'pii', label: 'PII' },
]

/** Severity → label; unknown severities render raw. */const SEVERITY_LABELS: Record<string, string> = {
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

/** What each 防护面 seam means, in one line. */
const MODE_MEANINGS: Record<string, string> = {
  input: '检查用户输入里的危险指令与注入标记',
  tools: '工具调用前按名称、能力标签、参数与调用链判定',
  results: '扫描工具结果里的凭据与注入标记',
  output: '审查模型输出（可选语义评审）',
  approval: '审批桥：委派宿主或按插件策略裁决',
}

/** Switchboard options for the three detection surfaces. */
const MODE_OPTIONS = [
  { value: 'enforce', label: '强制拦截' },
  { value: 'warn', label: '仅告警' },
  { value: 'off', label: '关闭' },
]

/** The output surface adds a buffered enforcement level. */
const OUTPUT_MODE_OPTIONS = [
  { value: 'enforce-buffer', label: '强制拦截（缓冲流式）' },
  { value: 'warn', label: '仅告警' },
  { value: 'off', label: '关闭' },
]

/** The approval bridge has no "off": delegating is its pass-through. */
const APPROVAL_MODE_OPTIONS = [
  { value: 'policy', label: '插件策略' },
  { value: 'delegate', label: '委派宿主' },
]

/** Narrow a select value back to the panel's mode unions. */
function toMode(value: string): PanelMode {
  return value === 'warn' ? 'warn' : value === 'off' ? 'off' : 'enforce'
}

/** Narrow the output select to its buffered union. */
function toOutputMode(value: string): PanelOutputMode {
  return value === 'warn' ? 'warn' : value === 'off' ? 'off' : 'enforce-buffer'
}

/** Narrow the approval select to its two-way union. */
function toApprovalMode(value: string): PanelApprovalMode {
  return value === 'policy' ? 'policy' : 'delegate'
}

/** Kind group → label for the 类别 picker. */
const KIND_GROUP_LABELS: Record<KindGroup, string> = {
  all: '全部类别',
  input: '输入',
  tool: '工具调用',
  result: '工具结果',
  approval: '审批',
  budget: '预算',
  output: '输出',
  patrol: '巡检',
  posture: '姿态',
  error: '内部错误',
  other: '其他',
}

/** Decision bucket → label for the chips. */
const DECISION_FILTER_LABELS: Record<DecisionFilter, string> = {
  all: '全部',
  deny: '拦截',
  ask: '审批',
  warn: '告警',
  fail: '失败',
}

/** Tone → concrete colour (used only where a class cannot carry it). */
const TONE_COLOR: Record<Tone, string> = {
  danger: 'var(--shp-danger)',
  warn: 'var(--shp-warn)',
  ask: 'var(--shp-ask)',
  ok: 'var(--shp-ok)',
  muted: 'var(--shp-muted)',
  accent: 'var(--shp-accent)',
}

/**
 * The sheet, rendered in-tree. Tokens follow the brief: page `#f6f7fb`, card
 * white, 13px base, 11–12px meta, tabular numerals, 8px spacing grid. Dark mode
 * only swaps the variables, so every rule below keeps working.
 */
const PANEL_CSS = `
.shp-root{--shp-page:#f6f7fb;--shp-card:#ffffff;--shp-card-alt:#f8fafc;--shp-border:#e6e9f0;--shp-border-strong:#d3d9e6;--shp-text:#111827;--shp-muted:#6b7280;--shp-faint:#9aa3b2;--shp-accent:#2563eb;--shp-accent-soft:#e6efff;--shp-danger:#dc2626;--shp-danger-soft:#fee2e2;--shp-warn:#d97706;--shp-warn-soft:#fef3c7;--shp-ask:#7c3aed;--shp-ask-soft:#ede9fe;--shp-ok:#15803d;--shp-ok-soft:#dcfce7;--shp-shadow:0 1px 2px rgba(17,24,39,.04),0 1px 3px rgba(17,24,39,.06);
background:var(--shp-page);color:var(--shp-text);border-radius:14px;padding:16px;font-size:13px;line-height:1.5;font-family:inherit;min-width:0;container-type:inline-size;container-name:shp}
.shp-root *,.shp-root *::before,.shp-root *::after{box-sizing:border-box}
.shp-root button,.shp-root input,.shp-root select,.shp-root textarea{font-family:inherit}
.shp-root h3,.shp-root h4,.shp-root p,.shp-root dl,.shp-root dd,.shp-root dt,.shp-root ul,.shp-root li{margin:0;padding:0}
.shp-root.shp-dark{--shp-page:#0f1319;--shp-card:#171c24;--shp-card-alt:#1c232d;--shp-border:#29313d;--shp-border-strong:#3a4553;--shp-text:#e5e9f0;--shp-muted:#9aa5b4;--shp-faint:#77828f;--shp-accent:#60a5fa;--shp-accent-soft:#1b2f4a;--shp-danger:#f87171;--shp-danger-soft:#3d1d1f;--shp-warn:#fbbf24;--shp-warn-soft:#3a2b12;--shp-ask:#a78bfa;--shp-ask-soft:#2b2247;--shp-ok:#4ade80;--shp-ok-soft:#123222;--shp-shadow:none}
.shp-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.shp-mark{width:32px;height:32px;flex:0 0 auto;border-radius:9px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;display:grid;place-items:center;font-size:12px;font-weight:700;letter-spacing:.04em}
.shp-headings{display:flex;flex-direction:column;gap:1px;min-width:0}
.shp-title{font-size:15px;font-weight:650;line-height:1.35}
.shp-subtitle{font-size:11.5px;color:var(--shp-muted);line-height:1.4}
.shp-pills{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.shp-pill{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;border:1px solid var(--shp-border-strong);color:var(--shp-muted);font-size:11px;line-height:18px;white-space:nowrap;background:var(--shp-card)}
.shp-pill-strong{border-color:var(--shp-accent);background:var(--shp-accent-soft);color:var(--shp-accent);font-weight:600}
.shp-live{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--shp-muted);white-space:nowrap}
.shp-live-dot{width:7px;height:7px;border-radius:50%;background:var(--shp-ok);box-shadow:0 0 0 3px var(--shp-ok-soft);animation:shp-pulse 2.4s ease-in-out infinite}
@keyframes shp-pulse{0%,100%{box-shadow:0 0 0 2px var(--shp-ok-soft)}50%{box-shadow:0 0 0 5px transparent}}
@media (prefers-reduced-motion:reduce){.shp-live-dot{animation:none}}
.shp-spacer{flex:1 1 auto;min-width:0}
.shp-tabs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;border-bottom:1px solid var(--shp-border);margin-bottom:14px}
.shp-tab{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--shp-muted);font-size:12.5px;cursor:pointer;border-radius:8px 8px 0 0;margin-bottom:-1px}
.shp-tab:hover{color:var(--shp-text);background:var(--shp-card-alt)}
.shp-tab-active{color:var(--shp-accent);border-bottom-color:var(--shp-accent);font-weight:600;background:transparent}
.shp-tab-active:hover{color:var(--shp-accent);background:var(--shp-card-alt)}
.shp-tab-count{font-size:10.5px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--shp-card-alt);border:1px solid var(--shp-border);color:var(--shp-muted);font-variant-numeric:tabular-nums}
.shp-tab-active .shp-tab-count{background:var(--shp-accent-soft);border-color:transparent;color:var(--shp-accent)}
.shp-pane{display:flex;flex-direction:column;gap:12px;min-width:0}
.shp-stack{display:flex;flex-direction:column;gap:12px;min-width:0}
.shp-kpi-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@container shp (min-width:700px){.shp-kpi-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
.shp-kpi{background:var(--shp-card);border:1px solid var(--shp-border);border-radius:12px;padding:11px 13px;box-shadow:var(--shp-shadow);display:flex;flex-direction:column;gap:1px;min-width:0}
.shp-kpi-label{font-size:11.5px;color:var(--shp-muted)}
.shp-kpi-value{font-size:26px;line-height:1.15;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.shp-kpi-sub{font-size:11px;color:var(--shp-faint)}
.shp-kpi-note{font-size:11px;color:var(--shp-warn);font-variant-numeric:tabular-nums}
.shp-overview-grid{columns:2;column-gap:12px}
@container shp (max-width:699px){.shp-overview-grid{columns:1}}
.shp-overview-grid>.shp-card{break-inside:avoid;margin:0 0 12px}
.shp-card{background:var(--shp-card);border:1px solid var(--shp-border);border-radius:12px;padding:12px 14px;box-shadow:var(--shp-shadow);display:flex;flex-direction:column;gap:10px;min-width:0}
.shp-card-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.shp-card-title{font-size:13px;font-weight:650;line-height:1.4}
.shp-card-hint{font-size:11.5px;color:var(--shp-muted);line-height:1.45}
.shp-card-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.shp-defs{display:grid;grid-template-columns:auto minmax(0,1fr);gap:7px 12px;align-items:baseline}
.shp-term{font-size:11.5px;color:var(--shp-muted);white-space:nowrap}
.shp-desc{font-size:12px;min-width:0;overflow-wrap:anywhere}
.shp-inline{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.shp-mono{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:11px;color:var(--shp-muted);overflow-wrap:anywhere}
.shp-muted{color:var(--shp-muted);font-size:12px}
.shp-hint{font-size:11.5px;color:var(--shp-muted)}
.shp-num{font-variant-numeric:tabular-nums}
.shp-badge{display:inline-flex;align-items:center;gap:4px;padding:0 8px;border-radius:999px;font-size:11px;line-height:18px;font-weight:500;white-space:nowrap;border:1px solid transparent}
.shp-badge-danger{background:var(--shp-danger-soft);color:var(--shp-danger)}
.shp-badge-warn{background:var(--shp-warn-soft);color:var(--shp-warn)}
.shp-badge-ask{background:var(--shp-ask-soft);color:var(--shp-ask)}
.shp-badge-ok{background:var(--shp-ok-soft);color:var(--shp-ok)}
.shp-badge-muted{background:var(--shp-card-alt);color:var(--shp-muted);border-color:var(--shp-border)}
.shp-badge-accent{background:var(--shp-accent-soft);color:var(--shp-accent)}
.shp-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
.shp-tag{font-size:10px;line-height:15px;padding:0 5px;border-radius:4px;background:var(--shp-warn-soft);color:var(--shp-warn);white-space:nowrap}
.shp-mode-row{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:4px 8px;align-items:center;padding:6px 0;border-bottom:1px dashed var(--shp-border)}
.shp-mode-row:last-child{border-bottom:0}
.shp-mode-name{font-size:12px;font-weight:500;white-space:nowrap}
.shp-mode-meaning{font-size:11.5px;color:var(--shp-muted);min-width:0}
.shp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:5px 12px;border-radius:8px;border:1px solid var(--shp-border-strong);background:var(--shp-card);color:var(--shp-text);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;line-height:1.5}
.shp-btn:hover:not(:disabled){border-color:var(--shp-accent);color:var(--shp-accent)}
.shp-btn:disabled{opacity:.45;cursor:not-allowed}
.shp-btn:focus-visible{outline:2px solid var(--shp-accent);outline-offset:1px}
.shp-btn-primary{background:var(--shp-accent);border-color:var(--shp-accent);color:#fff}
.shp-btn-primary:hover:not(:disabled){background:var(--shp-accent);color:#fff;filter:brightness(1.08)}
.shp-btn-sm{padding:2px 9px;font-size:11.5px;border-radius:7px}
.shp-btn-ghost{border-color:transparent;background:transparent;color:var(--shp-muted);padding:2px 6px}
.shp-btn-ghost:hover:not(:disabled){background:var(--shp-card-alt);color:var(--shp-accent)}
.shp-input,.shp-select,.shp-textarea{font-size:12.5px;color:var(--shp-text);background:var(--shp-card);border:1px solid var(--shp-border-strong);border-radius:8px;padding:5px 9px;min-width:0;line-height:1.5}
.shp-input:focus-visible,.shp-select:focus-visible,.shp-textarea:focus-visible{outline:2px solid var(--shp-accent-soft);outline-offset:1px;border-color:var(--shp-accent)}
.shp-textarea{min-height:64px;resize:vertical;width:100%}
.shp-input{width:100%}
.shp-field .shp-select{width:100%}
.shp-field{display:flex;flex-direction:column;gap:4px;position:relative;min-width:0}
.shp-facts{display:flex;flex-direction:column;gap:6px}
.shp-fact{display:grid;grid-template-columns:88px 1fr;gap:8px;align-items:baseline;min-width:0}
.shp-fact-label{font-size:11.5px;color:var(--shp-muted)}
.shp-fact code{font-size:12px;color:var(--shp-text);overflow-wrap:anywhere}
.shp-field-label{font-size:11px;color:var(--shp-muted);font-weight:500;white-space:nowrap}
.shp-field-hint{font-size:10.5px;color:var(--shp-faint);line-height:1.4}
.shp-field-wide{grid-column:1/-1}
.shp-picker{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-width:0;text-align:left;padding:5px 9px;border-radius:8px;border:1px solid var(--shp-border-strong);background:var(--shp-card);color:var(--shp-text);font-size:12.5px;cursor:pointer;line-height:1.5}
.shp-picker:hover:not(:disabled){border-color:var(--shp-accent)}
.shp-picker:disabled{opacity:.5;cursor:not-allowed}
.shp-picker:focus-visible{outline:2px solid var(--shp-accent-soft);outline-offset:1px;border-color:var(--shp-accent)}
.shp-picker-open{border-color:var(--shp-accent);box-shadow:0 0 0 3px var(--shp-accent-soft)}
.shp-picker-value{display:flex;flex-direction:column;min-width:0;flex:1 1 auto}
.shp-picker-title{font-size:12.5px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.shp-picker-meta{font-size:10.5px;line-height:1.35;color:var(--shp-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.shp-caret{font-size:9px;color:var(--shp-faint);flex:0 0 auto}
.shp-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:40;list-style:none;min-width:100%;max-width:380px;max-height:280px;overflow:auto;padding:4px;background:var(--shp-card);border:1px solid var(--shp-border-strong);border-radius:10px;box-shadow:0 10px 30px rgba(17,24,39,.18)}
.shp-menu-item{display:flex;flex-direction:column;gap:1px;width:100%;text-align:left;padding:5px 9px;border:0;border-radius:7px;background:transparent;color:var(--shp-text);cursor:pointer;min-width:0}
.shp-menu-item:hover{background:var(--shp-card-alt)}
.shp-menu-item-active{background:var(--shp-accent-soft)}
.shp-menu-line{display:flex;align-items:center;gap:6px;min-width:0}
.shp-toolbar{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}
.shp-toolbar .shp-field{flex:1 1 170px;min-width:140px;max-width:300px}
.shp-filter-card{background:var(--shp-card);border:1px solid var(--shp-border);border-radius:12px;padding:11px 13px;box-shadow:var(--shp-shadow);display:flex;flex-direction:column;gap:10px}
.shp-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.shp-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 10px;border-radius:999px;border:1px solid var(--shp-border-strong);background:var(--shp-card);color:var(--shp-muted);font-size:11.5px;cursor:pointer;line-height:18px;font-variant-numeric:tabular-nums}
.shp-chip:hover{border-color:var(--shp-accent);color:var(--shp-accent)}
.shp-chip-active{background:var(--shp-accent);border-color:var(--shp-accent);color:#fff;font-weight:600}
.shp-chip-active:hover{color:#fff;background:var(--shp-accent)}
.shp-chip-count{font-size:10.5px;opacity:.82;font-variant-numeric:tabular-nums}
.shp-filterbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 10px;border-radius:9px;border:1px dashed var(--shp-border-strong);background:var(--shp-card-alt);min-width:0}
.shp-filterbar-on{border-style:solid;border-color:var(--shp-accent);background:var(--shp-accent-soft)}
.shp-filterbar-label{font-size:11.5px;color:var(--shp-muted);font-weight:500;white-space:nowrap}
.shp-filterbar-on .shp-filterbar-label{color:var(--shp-accent)}
.shp-filterbar-hint{font-size:11.5px;color:var(--shp-muted)}
.shp-filter-chip{font-size:11px;line-height:18px;padding:0 8px;border-radius:999px;background:var(--shp-card);border:1px solid var(--shp-border-strong);color:var(--shp-text);white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}
.shp-timeline{list-style:none;display:flex;flex-direction:column;gap:6px}
.shp-tl-item{border:1px solid var(--shp-border);border-left:3px solid var(--shp-muted);border-radius:9px;background:var(--shp-card);overflow:hidden}
.shp-tl-btn{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;padding:8px 10px;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;min-width:0}
.shp-tl-btn:hover{background:var(--shp-card-alt)}
.shp-tl-btn:focus-visible{outline:2px solid var(--shp-accent);outline-offset:-2px}
.shp-tl-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.shp-tl-title{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.shp-tl-time{font-variant-numeric:tabular-nums;white-space:nowrap}
.shp-tl-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:11px;color:var(--shp-faint);min-width:0}
.shp-tl-detail{border-top:1px dashed var(--shp-border);background:var(--shp-card-alt);padding:9px 11px;display:flex;flex-direction:column;gap:8px}
.shp-tl-defs{grid-template-columns:auto minmax(0,1fr)}
.shp-attention{list-style:none;display:flex;flex-direction:column;gap:5px}
.shp-attention-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap;width:100%;text-align:left;padding:6px 8px;border:1px solid var(--shp-border);border-radius:8px;background:var(--shp-card);color:inherit;cursor:pointer;font:inherit;min-width:0}
.shp-attention-row:hover{background:var(--shp-card-alt);border-color:var(--shp-border-strong)}
.shp-attention-time{font-size:10.5px;color:var(--shp-faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.shp-attention-title{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px}
.shp-attention-reason{font-size:11.5px;color:var(--shp-muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 120px}
.shp-list{list-style:none;display:flex;flex-direction:column;gap:5px}
.shp-provider-row{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;padding:8px 9px;border:1px solid var(--shp-border);border-radius:9px;background:var(--shp-card)}
.shp-provider-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 240px}
.shp-provider-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--shp-muted);min-width:0;overflow-wrap:anywhere}
.shp-session{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;padding:7px 9px;border:1px solid var(--shp-border);border-radius:9px;background:var(--shp-card);color:inherit;cursor:pointer;font:inherit;min-width:0}
.shp-session:hover{background:var(--shp-card-alt);border-color:var(--shp-border-strong)}
.shp-session-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.shp-session-title{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.shp-session-meta{font-size:11px;color:var(--shp-faint);min-width:0;overflow-wrap:anywhere}
.shp-session-counts{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.shp-session-note{font-size:11px;color:var(--shp-muted)}
.shp-rule{display:flex;align-items:stretch;flex-wrap:wrap;border:1px solid var(--shp-border);border-radius:9px;background:var(--shp-card);overflow:hidden;margin-bottom:5px}
.shp-rule-bar{width:3px;flex:0 0 3px;background:var(--shp-muted)}
.shp-rule-main{display:flex;align-items:center;gap:8px;flex:1 1 auto;text-align:left;padding:7px 9px;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;min-width:0;flex-wrap:wrap}
.shp-rule-main:hover{background:var(--shp-card-alt)}
.shp-rule-main:focus-visible{outline:2px solid var(--shp-accent);outline-offset:-2px}
.shp-rule-name{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.shp-rule-meta{font-size:11px;color:var(--shp-muted);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.shp-rule-hits{font-size:11px;color:var(--shp-faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.shp-rule-detail{border-top:1px dashed var(--shp-border);background:var(--shp-card-alt);padding:8px 10px;display:flex;flex-direction:column;gap:6px;flex:0 0 100%;width:100%}
.shp-rule-detail code{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:11px;color:var(--shp-text);overflow-wrap:anywhere;word-break:break-word;background:transparent}
.shp-search{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.shp-search .shp-input{flex:1 1 220px;min-width:160px}
.shp-pre{margin:0;padding:9px 10px;border-radius:8px;border:1px solid var(--shp-border);background:var(--shp-card-alt);font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:11px;line-height:1.55;color:var(--shp-text);white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto}
.shp-warn-list{list-style:none;display:flex;flex-direction:column;gap:3px}
.shp-warn-list li{font-size:11.5px;color:var(--shp-warn);display:flex;gap:5px;align-items:flex-start}
.shp-warn-list li::before{content:"! ";font-weight:700}
.shp-findings{list-style:none;display:flex;flex-direction:column;gap:4px}
.shp-finding{display:flex;align-items:center;gap:7px;flex-wrap:wrap;padding:4px 0;border-bottom:1px dashed var(--shp-border)}
.shp-finding:last-child{border-bottom:0}
.shp-finding-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:var(--shp-text);white-space:nowrap}
.shp-finding-detail{font-size:11.5px;color:var(--shp-muted);min-width:0;flex:1 1 160px;overflow-wrap:anywhere}
.shp-form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px 12px}
.shp-switch-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.shp-switch-label{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;cursor:pointer}
.shp-switch-label input{accent-color:var(--shp-accent);width:14px;height:14px;cursor:pointer}
.shp-route{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px}
.shp-probe-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:2px}
.shp-probe{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--shp-muted)}
.shp-savebar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--shp-border);border-radius:11px;background:var(--shp-card);box-shadow:var(--shp-shadow)}
.shp-dirty{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--shp-warn)}
.shp-dirty::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--shp-warn)}
.shp-line-ok{font-size:11.5px;color:var(--shp-ok)}
.shp-line-error{font-size:11.5px;color:var(--shp-danger);overflow-wrap:anywhere}
.shp-notice{display:flex;flex-direction:column;gap:7px;padding:11px 13px;border-radius:10px;border:1px solid var(--shp-border-strong);background:var(--shp-card-alt)}
.shp-notice-warn{border-color:var(--shp-warn);background:var(--shp-warn-soft)}
.shp-notice-title{font-size:12.5px;font-weight:650}
.shp-notice-body{font-size:12px;color:var(--shp-muted);line-height:1.55}
.shp-empty{display:flex;flex-direction:column;gap:4px;padding:14px;border:1px dashed var(--shp-border-strong);border-radius:10px;background:var(--shp-card-alt)}
.shp-empty-title{font-size:12.5px;font-weight:600}
.shp-empty-body{font-size:11.5px;color:var(--shp-muted);line-height:1.55}
.shp-loading{display:flex;align-items:center;justify-content:center;gap:8px;padding:26px 12px;color:var(--shp-muted);font-size:12px;background:var(--shp-card);border:1px solid var(--shp-border);border-radius:12px}
.shp-spin{width:13px;height:13px;border-radius:50%;border:2px solid var(--shp-border-strong);border-top-color:var(--shp-accent);animation:shp-rotate .8s linear infinite;flex:0 0 auto}
@keyframes shp-rotate{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.shp-spin{animation-duration:2s}}
.shp-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:10px;border-top:1px solid var(--shp-border);font-size:11px;color:var(--shp-faint);line-height:1.5}
`

/**
 * True when the host shell itself renders dark. The OS colour-scheme is only a
 * last resort: the shell can force light while the OS is dark (and this panel is
 * a card inside the shell's own dialog), so following `prefers-color-scheme`
 * alone paints a black card inside a white dialog.
 */
function detectHostDark(): boolean {
  if (typeof document === 'undefined') return false
  const root = document.documentElement
  const source = (root.dataset.dsThemeSource ?? root.dataset.theme ?? '').toLowerCase()
  if (source === 'dark') return true
  if (source === 'light') return false
  try {
    const scheme = (root.style.colorScheme || getComputedStyle(root).colorScheme || '').toLowerCase()
    if (scheme.includes('dark') && !scheme.includes('light')) return true
    if (scheme.includes('light')) return false
    const background = getComputedStyle(document.body).backgroundColor
    const match = /rgba?\(([^)]+)\)/u.exec(background)
    const channels = match?.[1]?.split(',').map(part => Number(part.trim()))
    if (channels !== undefined && channels.length >= 3) {
      const alpha = channels[3]
      if (alpha === undefined || Number.isNaN(alpha) || alpha > 0.5) {
        const luminance = (channels[0] ?? 255) * 0.2126 + (channels[1] ?? 255) * 0.7152 + (channels[2] ?? 255) * 0.0722
        return luminance < 128
      }
    }
  } catch {
    // A shell without getComputedStyle answers nothing; stay on the light tokens.
  }
  return false
}

/** Track the host's theme as it changes (the shell may flip light/dark live). */
function useHostDark(): boolean {
  const [dark, setDark] = useState<boolean>(() => detectHostDark())
  useEffect(() => {
    const update = (): void => { setDark(detectHostDark()) }
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ds-theme-source', 'data-theme', 'style', 'class'],
    })
    if (document.body !== null) {
      observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] })
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => { update() }
    media.addEventListener('change', onChange)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', onChange)
    }
  }, [])
  return dark
}

/** Render the panel's sheet plus the tokenised root. */
function Root({ children }: { readonly children: ReactNode }): ReactNode {
  const dark = useHostDark()
  return (
    <div className={dark ? 'shp-root shp-dark' : 'shp-root'}>
      <style>{PANEL_CSS}</style>
      {children}
    </div>
  )
}

/** Tone for one disposition. */
function toneOf(decision: string): Tone {
  if (decision === 'deny' || decision === 'block' || decision === 'fail' || decision === 'error') return 'danger'
  if (decision === 'warn') return 'warn'
  if (decision === 'ask' || decision === 'asked') return 'ask'
  if (decision === 'allow' || decision === 'ok') return 'ok'
  return 'muted'
}

/** Tone for one rule severity. */
function severityTone(severity: string): Tone {
  if (severity === 'critical' || severity === 'high') return 'danger'
  if (severity === 'medium') return 'warn'
  if (severity === 'low') return 'ask'
  return 'muted'
}

/** Tone for one patrol finding. */
function findingTone(severity: string): Tone {
  if (severity === 'FAIL') return 'danger'
  if (severity === 'WARN') return 'warn'
  if (severity === 'OK') return 'ok'
  return 'muted'
}

/** Tone for one probe status (the server owns the status string). */
function probeTone(status: string): Tone {
  const value = status.toLowerCase()
  if (value.includes('ok') || value.includes('allow') || value.includes('pass')) return 'ok'
  if (value.includes('block') || value.includes('deny') || value.includes('fail') || value.includes('error')) return 'danger'
  if (value.includes('unavailable') || value.includes('warn')) return 'warn'
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

/** True when one event passes the whole filter. */
function matchEvent(row: PanelEvent, filter: EventFilter): boolean {
  if (filter.workspace !== 'all' && (row.workspace ?? '') !== filter.workspace) return false
  if (filter.session !== 'all' && row.session !== filter.session) return false
  if (filter.kind !== 'all' && kindGroupOf(row.kind) !== filter.kind) return false
  return matchesDecision(row.decision, filter.decision)
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

/** One-line title of an event row (tool name, else what produced it). */
function eventTitle(row: PanelEvent): string {
  if (row.tool !== undefined && row.tool.length > 0) return row.tool
  return KIND_LABELS[row.kind] ?? (row.kind.length > 0 ? row.kind : '事件')
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

/** Compact event time: clock for today, `MM-DD HH:mm` otherwise. */
function formatEventTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const now = new Date()
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}`
  return sameDay ? clock : `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${clock.slice(0, 5)}`
}

/** Last path segment of a project directory (the full path stays in the meta line). */
function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/** Readable workspace label; the raw path is the picker meta. */
function workspaceLabel(workspace: string | undefined): string {
  if (workspace === undefined || workspace.length === 0) return '未记录工作区'
  return baseName(workspace)
}

/** Readable conversation label for a row: title, else project + short id, else the id. */
function conversationText(id: string | undefined, title: string | undefined, workspace: string | undefined): string {
  if (id === undefined || id.length === 0) return '无会话'
  if (title !== undefined && title.length > 0) return title
  if (workspace !== undefined && workspace.length > 0) return `${baseName(workspace)} · ${id}`
  return id
}

/** Build the conversation entries from sessions plus event-only session ids. */
function buildConversations(payload: PanelPayload): ConversationEntry[] {
  const entries: ConversationEntry[] = []
  const known = new Set<string>()
  for (const detail of payload.sessionDetails) {
    known.add(detail.id)
    entries.push({
      id: detail.id,
      ...(detail.title === undefined ? {} : { title: detail.title }),
      ...(detail.workspace === undefined ? {} : { workspace: detail.workspace }),
      historical: detail.historical === true,
    })
  }
  // Events can mention sessions the bounded session page no longer lists (or the
  // process forgot after a restart): keep them selectable, newest first.
  const eventOnly = new Map<string, { lastIndex: number; title?: string; workspace?: string }>()
  payload.recentEvents.forEach((row, index) => {
    const id = row.session
    if (id === undefined || id.length === 0 || known.has(id)) return
    const current = eventOnly.get(id) ?? { lastIndex: index }
    current.lastIndex = index
    if (current.title === undefined && row.title !== undefined) current.title = row.title
    if (current.workspace === undefined && row.workspace !== undefined) current.workspace = row.workspace
    eventOnly.set(id, current)
  })
  const extras = [...eventOnly.entries()].sort((left, right) => right[1].lastIndex - left[1].lastIndex)
  for (const [id, value] of extras) {
    entries.push({
      id,
      ...(value.title === undefined ? {} : { title: value.title }),
      ...(value.workspace === undefined ? {} : { workspace: value.workspace }),
      historical: false,
    })
  }
  // Fill titles/workspaces that only the ledger rows know (the session page is bounded).
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  for (const row of payload.recentEvents) {
    const entry = row.session === undefined ? undefined : byId.get(row.session)
    if (entry === undefined) continue
    if (entry.title === undefined && row.title !== undefined) entry.title = row.title
    if (entry.workspace === undefined && row.workspace !== undefined) entry.workspace = row.workspace
  }
  return entries
}

/** One picker row for a conversation (title first, short id muted below it). */
function conversationOption(entry: ConversationEntry): PickerOption {
  const tag = entry.historical ? '历史' : undefined
  if (entry.title !== undefined && entry.title.length > 0) {
    const meta = `${workspaceLabel(entry.workspace)} · ${entry.id}`
    return { id: entry.id, label: entry.title, meta, ...(tag === undefined ? {} : { tag }) }
  }
  if (entry.workspace !== undefined && entry.workspace.length > 0) {
    return { id: entry.id, label: `${baseName(entry.workspace)} · ${entry.id}`, ...(tag === undefined ? {} : { tag }) }
  }
  return { id: entry.id, label: entry.id, ...(tag === undefined ? {} : { tag }) }
}

/** Distinct workspaces plus whether anything was recorded without one. */
function buildWorkspaces(payload: PanelPayload): { readonly workspaces: readonly string[]; readonly hasUnknown: boolean } {
  const names = new Set<string>()
  let hasUnknown = false
  for (const detail of payload.sessionDetails) {
    if (detail.workspace !== undefined && detail.workspace.length > 0) names.add(detail.workspace)
    else hasUnknown = true
  }
  for (const row of payload.recentEvents) {
    if (row.workspace !== undefined && row.workspace.length > 0) names.add(row.workspace)
    else hasUnknown = true
  }
  const workspaces = [...names].sort((left, right) => workspaceLabel(left).localeCompare(workspaceLabel(right), 'zh'))
  return { workspaces, hasUnknown }
}

/** Judge facts exist only on a 1.7.0 payload; older Host builds omit the field. */
function judgeFactOf(payload: PanelPayload): PanelJudgeFact | undefined {
  return (payload as { readonly judge?: PanelJudgeFact }).judge
}

/** Error code of a rejected face call. */
function codeOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown_error'
}

/** Coarse server-side reason attached to a rejected face call, when present. */
function detailOf(error: unknown): string | undefined {
  const detail = (error as { readonly detail?: unknown } | null)?.detail
  return typeof detail === 'string' && detail.length > 0 ? detail : undefined
}

/** Loader problems attached to a rejected rule write, when present. */
function problemsOf(error: unknown): readonly string[] {
  const problems = (error as { readonly problems?: unknown } | null)?.problems
  return Array.isArray(problems) ? problems.filter((item): item is string => typeof item === 'string') : []
}

/** Best-effort clipboard copy; the text stays visible on failure. */
function copyText(text: string): void {
  try {
    void navigator.clipboard?.writeText(text).catch(() => undefined)
  } catch {
    // Clipboard permission is not guaranteed in every shell; the text is visible.
  }
}

/** Error copy for one failed panel action. */
function actionError(code: string, detail?: string): string {
  const text = (() => {
    switch (code) {
      case 'invalid_body': return '请求内容不合法。'
      case 'draft_disabled': return 'AI 起草已关闭（config `draft.enabled: false`）。'
      case 'draft_unavailable': return '起草路由不可用（profile 没有 llm 服务，或 draft 路由为空）。'
      case 'draft_timeout': return '起草超时：模型没有在限定时间内返回。'
      case 'draft_empty': return '起草失败：模型没有返回文本（可能是输出 token 上限太小）。'
      case 'draft_bad_json': return '起草失败：模型返回的不是 JSON。'
      case 'draft_invalid': return '起草失败：生成的规则未通过校验。'
      case 'draft_failed': return '起草失败：模型调用出错。'
      case 'draft_in_progress': return '已有一个起草请求在运行。'
      case 'schedule_unavailable': return '本 profile 没有接定时巡检。'
      case 'reload_unavailable': return '本 profile 不支持在线重新加载。'
      case 'reload_failed': return '重新加载失败，已保留旧规则集（看日志）。'
      case 'write_unavailable': return '本 profile 没有接规则写入。'
      case 'rules_dir_unconfigured': return '未配置 rules.dir：在 profile 里给它一个绝对路径并重启一次。'
      case 'rules_dir_not_absolute': return 'rules.dir 必须是绝对路径。'
      case 'rules_dir_packaged': return '拒绝写入安装包自带的 rules/：把 rules.dir 指到别的目录。'
      case 'rules_dir_unwritable': return '规则目录不可写（检查路径与权限）。'
      case 'filename_invalid': return '文件名不合法：小写字母/数字/._-，以 .yaml 结尾，不能带路径。'
      case 'rule_content_invalid': return '规则未通过 loader 校验，没有写入。'
      case 'rule_exists': return '同名规则文件已存在：确认覆盖才会替换。'
      case 'rule_write_failed': return '写入规则文件失败（看日志）。'
      case 'patrol_cooldown': return '刚运行过巡检，请几秒后再试。'
      case 'patrol_in_progress': return '已经有一次巡检在运行。'
      case 'patrol_unavailable': return '本 profile 没有接巡检。'
      case 'method_not_allowed': return '该操作只接受 POST。'
      case 'unknown_endpoint': return '当前服务端没有这个接口。'
      default: return '操作失败。'
    }
  })()
  return detail === undefined ? text : `${text}（${detail}）`
}

/** Error copy for one settings/probe failure code. */
function settingsErrorMessage(code: string): string {
  switch (code) {
    case 'settings_unavailable': return '本 profile 没有可读的配置服务（settings_unavailable）。'
    case 'settings_readonly': return '配置是只读的，宿主机不允许写入（settings_readonly）。'
    case 'settings_invalid': return '要保存的取值不合法（settings_invalid），请检查字符数与超时。'
    case 'settings_write_failed': return '写入 profile 配置失败（settings_write_failed），看宿主日志。'
    case 'settings_conflict': return '配置在读取之后被别处改过（settings_conflict）：刷新面板再保存。'
    case 'probe_unavailable': return '本 profile 不能探测评审路由（probe_unavailable）。'
    case 'judge_unavailable': return '本 profile 没有可用的 llm 服务（judge_unavailable）。'
    case 'unknown_endpoint': return '当前服务端还没有 /settings 接口（unknown_endpoint）。'
    case 'panel_http_404': return '当前服务端没有 /settings 路由（HTTP 404）。'
    case 'invalid_body': return '请求内容不合法（invalid_body）。'
    default: return `操作失败（${code}）。`
  }
}

/** A positive integer from a text field, or undefined when it is not one. */
function positiveInt(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!/^\d+$/u.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** A non-negative integer from a text field (0 disables the check). */
function nonNegativeInt(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!/^\d+$/u.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * A non-negative number from a text field, optionally capped, or undefined when it
 * is not one.
 *
 * The cap used to be hard-wired to `8` because the only caller was the entropy
 * threshold. Patrol then started sharing the helper and every default
 * (`patrolWindowMinutes: 10`) fell outside it: `buildPatch` answered "必须是 ≥ 1
 * 的分钟数" for a value that *is* a valid minute count, no patch was ever
 * produced, and the bar sat on "没有修改" no matter what the operator changed —
 * settings could not be saved at all from 1.13.0 to 1.15.1.
 */
function nonNegativeNumber(raw: string, max = Number.POSITIVE_INFINITY): number | undefined {
  const trimmed = raw.trim()
  if (!/^\d+(?:\.\d+)?$/u.test(trimmed)) return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) && value >= 0 && value <= max ? value : undefined
}

/** Error copy for one provider add/delete failure code. */
function providerErrorMessage(code: string): string {
  switch (code) {
    case 'provider_exists': return '同名路由已存在：换一个路由 id。'
    case 'provider_in_use': return '该路由正被评审或起草使用：先在评审卡片里换掉，再删除。'
    case 'provider_not_found': return '找不到这个路由（可能已被删除）。'
    case 'provider_unavailable': return '本 profile 没有可写的 pi-ai 供应商条目或凭据服务。'
    case 'settings_invalid': return '输入不合法：检查路由 id、base URL、API key 与模型 id。'
    case 'settings_write_failed': return '宿主拒绝写入配置（settings_write_failed），看宿主日志。'
    case 'settings_conflict': return '配置在读取之后被别处改过（settings_conflict）：刷新面板再试。'
    case 'provider_index_failed': return '路由与面板索引未能同时写入（provider_index_failed）：重试一次，或看日志。'
    case 'unknown_endpoint': return '当前服务端还没有这个接口（unknown_endpoint）。'
    case 'panel_http_404': return '当前服务端没有这个接口（HTTP 404）。'
    default: return `操作失败（${code}）。`
  }
}

/** Error copy for one ledger-export failure code. */
function exportErrorMessage(code: string): string {
  switch (code) {
    case 'export_failed': return '账本读取失败（export_failed），看宿主日志。'
    case 'invalid_body': return '导出参数不合法（invalid_body）。'
    case 'unknown_endpoint': return '当前服务端还没有导出接口（unknown_endpoint）。'
    case 'panel_http_404': return '当前服务端没有导出接口（HTTP 404）。'
    default: return `导出失败（${code}）。`
  }
}

/** Local pre-check of the provider form; null when the Host should decide. */
function providerFormInvalid(form: ProviderForm): string | null {
  if (!/^[a-z][a-z0-9-]{1,39}$/u.test(form.id.trim())) return '路由 id 需匹配 [a-z][a-z0-9-]{1,39}（2–40 字符，小写字母开头）。'
  if (form.baseURL.trim().length === 0) return 'Base URL 必填。'
  if (form.apiKey.trim().length === 0) return 'API key 必填（只写不读）。'
  if (form.model.trim().length === 0) return '模型 id 必填。'
  return null
}

/** Hand one generated text file to the browser's normal download flow. */
function downloadText(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoking immediately can cancel the download in some shells; give it a beat.
  window.setTimeout(() => { URL.revokeObjectURL(url) }, 4_000)
}

/** Turn a loaded value into the editable form state. */
export function toSettingsData(value: PanelSettingsValue): SettingsData {
  return {
    value,
    judge: {
      enabled: value.judge.enabled,
      scope: value.judge.scope,
      provider: value.judge.provider,
      model: value.judge.model,
      maxChars: String(value.judge.maxChars),
      timeoutMs: String(value.judge.timeoutMs),
    },
    draft: { provider: value.draft.provider, model: value.draft.model },
    surfaces: { ...value.surfaces },
    inputJudge: { ...value.inputJudge },
    toolDetection: {
      descriptorScan: value.toolDetection.descriptorScan,
      repeatedAttemptThreshold: String(value.toolDetection.repeatedAttemptThreshold),
      entropyThreshold: String(value.toolDetection.entropyThreshold),
      entropyMinLength: String(value.toolDetection.entropyMinLength),
      allowedTables: value.toolDetection.allowedTables.join('\n'),
      // `?? ''`: a host that predates 1.17.0 sends no such field. The form always
      // carries text, so "absent" and "empty" mean the same thing here.
      argSchemas: value.toolDetection.argSchemas ?? '',
    },
    pii: { enabled: value.pii.enabled, classes: [...value.pii.classes] },
    lists: {
      denyTools: value.lists.denyTools.join('\n'),
      askTools: value.lists.askTools.join('\n'),
      allowOnce: value.lists.allowOnce.join('\n'),
      denyTags: value.lists.denyTags.join('\n'),
      tagOverrides: value.lists.tagOverrides.map((item) => `${item.pattern}: ${item.tags.join(', ')}`).join('\n'),
      blockOn: [...value.lists.blockOn],
    },
    source: {
      rulesDir: value.source.rulesDir,
      rulesWatch: value.source.rulesWatch,
      patrolWindowMinutes: String(value.source.patrolWindowMinutes),
      patrolFactor: String(value.source.patrolFactor),
      patrolMinCount: String(value.source.patrolMinCount),
    },
  }
}

/**
 * Parse the `tools.argSchemas` textarea.
 *
 * Accepts only a JSON array of objects (the same text the panel puts in, and the
 * shape `tools.argSchemas` has on the wire). Empty or comment-less blank text means
 * "no declarations", which is what an absent key means to the loader.
 *
 * The plugin does NOT re-check the schema keywords here: that is the host's job on
 * save, using the loader's own compiler, so the form and the deployment cannot hold
 * two different opinions about what a valid schema is. This function only decides
 * whether the text is an array the wire can carry.
 *
 * @param text - raw textarea content.
 * @returns the declarations plus an optional operator-facing error message.
 */
function parseArgSchemasText(text: string): { value?: readonly unknown[]; error?: string } {
  // Defensive: a value from an older host (or a partially-shaped fixture) carries no
  // `argSchemas` text at all. That must read as "no declarations", never crash the
  // whole settings tab — a settings form that throws is worse than one field missing.
  const trimmed = (text ?? '').trim()
  if (trimmed.length === 0) return { value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { error: '「参数形状规则」不是合法 JSON（应为对象数组，参照上面的示例）。' }
  }
  if (!Array.isArray(parsed)) {
    return { error: '「参数形状规则」必须是 JSON 数组（留空 = 不限制）。' }
  }
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: '「参数形状规则」的每一项都必须是对象。' }
    }
  }
  return { value: parsed as readonly unknown[] }
}

/** Whether two settings values serialise identically (order-insensitive compare). */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Parse the SQL table allowlist textarea: one entry per line, `,` also accepted as
 * a separator, blanks ignored, duplicates removed (case-insensitively — the engine
 * compares case-insensitively, so `Users` and `users` are one entry).
 */
function parseTableList(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split(/[\r\n,]+/u)) {
    const entry = raw.trim()
    if (entry.length === 0) continue
    const key = entry.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

/**
 * Parse a plain list textarea: one entry per line, blanks ignored.
 *
 * `,` is NOT a separator here (unlike the table list) because a tool-name glob or a
 * tag may legitimately contain a comma-free punctuation like `mcp__*`; a line is the
 * unit an operator thinks in.
 */
function parseLineList(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/u)) {
    const entry = raw.trim()
    if (entry.length > 0 && !out.includes(entry)) out.push(entry)
  }
  return out
}

/** Parse the `pattern: tag1, tag2` tag-override textarea. */
function parseTagOverrides(text: string): { pattern: string; tags: string[] }[] {
  const out: { pattern: string; tags: string[] }[] = []
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const colon = line.indexOf(':')
    const pattern = (colon >= 0 ? line.slice(0, colon) : line).trim()
    const rest = colon >= 0 ? line.slice(colon + 1) : ''
    const tags = rest.split(/[,;]+/u).map((tag) => tag.trim()).filter((tag) => tag.length > 0)
    if (pattern.length === 0) continue
    out.push({ pattern, tags })
  }
  return out
}

/** Diff the editable form against the loaded value. */
export function buildPatch(value: PanelSettingsValue, form: SettingsForm): PatchResult {
  const { judge, draft, surfaces, inputJudge, toolDetection, pii, lists, source } = form
  const maxChars = positiveInt(judge.maxChars)
  const timeoutMs = positiveInt(judge.timeoutMs)
  if (maxChars === undefined) return { patch: undefined, invalid: '「送入评审的最大字符数」必须是正整数。' }
  if (timeoutMs === undefined) return { patch: undefined, invalid: '「评审超时」必须是正整数毫秒。' }
  // Tool-detection numbers: 0 is a legal value (it disables the check), so the
  // parser here only refuses negatives and non-integers beyond what the host accepts.
  const retry = nonNegativeInt(toolDetection.repeatedAttemptThreshold)
  const entropy = nonNegativeNumber(toolDetection.entropyThreshold, 8)
  const entropyMin = positiveInt(toolDetection.entropyMinLength)
  if (retry === undefined) return { patch: undefined, invalid: '「重复失败阈值」必须是 0 或正整数。' }
  if (entropy === undefined) return { patch: undefined, invalid: '「熵阈值」必须是 0–8 之间的数字。' }
  if (entropyMin === undefined) return { patch: undefined, invalid: '「熵检测最短长度」必须是正整数。' }
  const allowedTables = parseTableList(toolDetection.allowedTables)
  // Argument schemas: parsed here so unparsable text can never reach the host, and
  // compared as JSON so a reformat (whitespace only) is not a change.
  const argSchemas = parseArgSchemasText(toolDetection.argSchemas)
  if (argSchemas.error !== undefined) return { patch: undefined, invalid: argSchemas.error }
  // Source/patrol numbers: same rule (0 is legal for minCount, not for the window).
  const windowMinutes = nonNegativeNumber(source.patrolWindowMinutes.replace(',', '.'))
  const factor = nonNegativeNumber(source.patrolFactor.replace(',', '.'))
  const minCount = nonNegativeInt(source.patrolMinCount)
  if (windowMinutes === undefined || windowMinutes < 1) {
    return { patch: undefined, invalid: '「巡检窗口」必须是 ≥ 1 的分钟数。' }
  }
  if (factor === undefined || factor < 1) {
    return { patch: undefined, invalid: '「速率倍数」必须是 ≥ 1 的数字。' }
  }
  if (minCount === undefined) return { patch: undefined, invalid: '「最少拒绝数」必须是 0 或正整数。' }
  const judgePatch: MutableJudgePatch = {}
  if (judge.enabled !== value.judge.enabled) judgePatch.enabled = judge.enabled
  if (judge.scope !== value.judge.scope) judgePatch.scope = judge.scope
  if (judge.provider !== value.judge.provider) judgePatch.provider = judge.provider
  if (judge.model !== value.judge.model) judgePatch.model = judge.model
  if (maxChars !== value.judge.maxChars) judgePatch.maxChars = maxChars
  if (timeoutMs !== value.judge.timeoutMs) judgePatch.timeoutMs = timeoutMs
  const draftPatch: MutableDraftPatch = {}
  if (draft.provider !== value.draft.provider) draftPatch.provider = draft.provider
  if (draft.model !== value.draft.model) draftPatch.model = draft.model
  const surfacePatch: MutableSurfacePatch = {}
  if (surfaces.input !== value.surfaces.input) surfacePatch.input = surfaces.input
  if (surfaces.tools !== value.surfaces.tools) surfacePatch.tools = surfaces.tools
  if (surfaces.results !== value.surfaces.results) surfacePatch.results = surfaces.results
  if (surfaces.output !== value.surfaces.output) surfacePatch.output = surfaces.output
  if (surfaces.approval !== value.surfaces.approval) surfacePatch.approval = surfaces.approval
  const inputJudgePatch: MutableInputJudgePatch = {}
  if (inputJudge.mode !== value.inputJudge.mode) inputJudgePatch.mode = inputJudge.mode
  if (inputJudge.failClosed !== value.inputJudge.failClosed) inputJudgePatch.failClosed = inputJudge.failClosed
  if (inputJudge.normalize !== value.inputJudge.normalize) inputJudgePatch.normalize = inputJudge.normalize
  const toolDetectionPatch: MutableToolDetectionPatch = {}
  if (toolDetection.descriptorScan !== value.toolDetection.descriptorScan) {
    toolDetectionPatch.descriptorScan = toolDetection.descriptorScan
  }
  if (retry !== value.toolDetection.repeatedAttemptThreshold) toolDetectionPatch.repeatedAttemptThreshold = retry
  if (entropy !== value.toolDetection.entropyThreshold) toolDetectionPatch.entropyThreshold = entropy
  if (entropyMin !== value.toolDetection.entropyMinLength) toolDetectionPatch.entropyMinLength = entropyMin
  const savedTables = value.toolDetection.allowedTables.join('\u0000').toLowerCase()
  if (allowedTables.join('\u0000').toLowerCase() !== savedTables) toolDetectionPatch.allowedTables = allowedTables
  // Compare as canonical JSON: reformatting the textarea alone is not an edit.
  // An absent field (older host, or a fixture that predates 1.17.0) reads as "no
  // declarations", which is what an empty list means — otherwise every untouched
  // form would report itself dirty. The SAVED side is parsed rather than compared as
  // text, because `[]` and `` are the same thing to the loader but not to `===`.
  const savedArgSchemas = parseArgSchemasText(value.toolDetection.argSchemas ?? '').value ?? []
  if (argSchemas.value !== undefined && !sameJson(argSchemas.value, savedArgSchemas)) {
    toolDetectionPatch.argSchemas = argSchemas.value
  }
  const piiPatch: MutablePiiPatch = {}
  if (pii.enabled !== value.pii.enabled) piiPatch.enabled = pii.enabled
  const savedClasses = [...value.pii.classes].sort().join(',')
  if ([...pii.classes].sort().join(',') !== savedClasses) piiPatch.classes = pii.classes
  // Lists: whole-list comparison (the wire field replaces the stored list), with line
  // order ignored so re-ordering alone never triggers a save/remount.
  const listPatch: MutableListPatch = {}
  const denyTools = parseLineList(lists.denyTools)
  const askTools = parseLineList(lists.askTools)
  const allowOnce = parseLineList(lists.allowOnce)
  const denyTags = parseLineList(lists.denyTags)
  if (!sameList(denyTools, value.lists.denyTools)) listPatch.denyTools = denyTools
  if (!sameList(askTools, value.lists.askTools)) listPatch.askTools = askTools
  if (!sameList(allowOnce, value.lists.allowOnce)) listPatch.allowOnce = allowOnce
  if (!sameList(denyTags, value.lists.denyTags)) listPatch.denyTags = denyTags
  const tagOverrides = parseTagOverrides(lists.tagOverrides)
  const savedOverrides = value.lists.tagOverrides.map((item) => `${item.pattern}|${item.tags.join(',')}`).sort().join('\n')
  const nextOverrides = tagOverrides.map((item) => `${item.pattern}|${item.tags.join(',')}`).sort().join('\n')
  if (nextOverrides !== savedOverrides) listPatch.tagOverrides = tagOverrides
  if (!sameList(lists.blockOn, value.lists.blockOn)) listPatch.blockOn = [...lists.blockOn]
  const sourcePatch: MutableSourcePatch = {}
  const rulesDir = source.rulesDir.trim()
  if (rulesDir !== value.source.rulesDir) sourcePatch.rulesDir = rulesDir
  if (source.rulesWatch !== value.source.rulesWatch) sourcePatch.rulesWatch = source.rulesWatch
  if (windowMinutes !== value.source.patrolWindowMinutes) sourcePatch.patrolWindowMinutes = windowMinutes
  if (factor !== value.source.patrolFactor) sourcePatch.patrolFactor = factor
  if (minCount !== value.source.patrolMinCount) sourcePatch.patrolMinCount = minCount
  const hasJudge = Object.keys(judgePatch).length > 0
  const hasDraft = Object.keys(draftPatch).length > 0
  const hasSurfaces = Object.keys(surfacePatch).length > 0
  const hasInputJudge = Object.keys(inputJudgePatch).length > 0
  const hasToolDetection = Object.keys(toolDetectionPatch).length > 0
  const hasPii = Object.keys(piiPatch).length > 0
  const hasLists = Object.keys(listPatch).length > 0
  const hasSource = Object.keys(sourcePatch).length > 0
  if (
    !hasJudge && !hasDraft && !hasSurfaces && !hasInputJudge && !hasToolDetection
    && !hasPii && !hasLists && !hasSource
  ) {
    return { patch: undefined, invalid: null }
  }
  return {
    patch: {
      // Echo the revision this form was rendered at: the next save is refused as stale
      // instead of overwriting a change another window (or the native settings page)
      // made in the meantime. Null means the host exposes no revision.
      ...(value.revision === null ? {} : { expectedRevision: value.revision }),
      ...(hasSurfaces ? { surfaces: surfacePatch } : {}),
      ...(hasInputJudge ? { inputJudge: inputJudgePatch } : {}),
      ...(hasToolDetection ? { toolDetection: toolDetectionPatch } : {}),
      ...(hasPii ? { pii: piiPatch } : {}),
      ...(hasLists ? { lists: listPatch } : {}),
      ...(hasSource ? { source: sourcePatch } : {}),
      ...(hasJudge ? { judge: judgePatch } : {}),
      ...(hasDraft ? { draft: draftPatch } : {}),
    },
    invalid: null,
  }
}

/** Order-insensitive list equality: a reorder alone must never cause a save. */
function sameList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const a = [...left].sort()
  const b = [...right].sort()
  return a.every((entry, index) => entry === b[index])
}

/** Provider choices for a route picker, keeping an out-of-catalog saved value. */
function providerOptionsFor(
  providers: readonly PanelProviderOption[],
  current: string,
  emptyLabel: string,
  emptyMeta: string,
): PickerOption[] {
  const options: PickerOption[] = [{ id: '', label: emptyLabel, meta: emptyMeta }]
  for (const provider of providers) {
    options.push({ id: provider.id, label: provider.name, meta: `${provider.id} · ${provider.models.length} 个模型` })
  }
  if (current.length > 0 && !providers.some(provider => provider.id === current)) {
    options.push({ id: current, label: current, meta: '不在当前目录中', tag: '自定义' })
  }
  return options
}

/** Model choices for the selected provider, keeping an out-of-catalog saved value. */
function modelOptionsFor(
  providers: readonly PanelProviderOption[],
  providerId: string,
  current: string,
  emptyLabel: string,
  emptyMeta: string,
): PickerOption[] {
  const provider = providers.find(entry => entry.id === providerId)
  const models = provider?.models ?? []
  const options: PickerOption[] = [{ id: '', label: emptyLabel, meta: emptyMeta }]
  for (const model of models) options.push({ id: model.id, label: model.name, meta: model.id })
  if (current.length > 0 && !models.some(model => model.id === current)) {
    options.push({ id: current, label: current, meta: '不在当前目录中', tag: '自定义' })
  }
  return options
}

/** One soft-tint badge. */
function Badge({ tone, children, title }: {
  readonly tone: Tone
  readonly children: ReactNode
  readonly title?: string
}): ReactNode {
  return <span className={`shp-badge shp-badge-${tone}`} title={title}>{children}</span>
}

/** One coloured dot. */
function Dot({ tone }: { readonly tone: Tone }): ReactNode {
  return <span className="shp-dot" style={{ background: TONE_COLOR[tone] }} aria-hidden="true" />
}

/** One card with a title row. */
function Card({ title, hint, actions, children }: {
  readonly title: string
  readonly hint?: ReactNode
  readonly actions?: ReactNode
  readonly children: ReactNode
}): ReactNode {
  return (
    <section className="shp-card">
      <div className="shp-card-head">
        <h4 className="shp-card-title">{title}</h4>
        {hint === undefined ? null : <span className="shp-card-hint">{hint}</span>}
        <span className="shp-spacer" />
        {actions === undefined ? null : <div className="shp-card-actions">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** One KPI tile. */
function Kpi({ label, value, tone, sub, note }: {
  readonly label: string
  readonly value: number | string
  readonly tone: Tone
  readonly sub: string
  readonly note?: string
}): ReactNode {
  return (
    <div className="shp-kpi">
      <span className="shp-kpi-label">{label}</span>
      <span className="shp-kpi-value" style={{ color: TONE_COLOR[tone] }}>{value}</span>
      <span className="shp-kpi-sub">{sub}</span>
      {note === undefined ? null : <span className="shp-kpi-note">{note}</span>}
    </div>
  )
}

/** One definition row. */
function DefRow({ term, desc }: { readonly term: string; readonly desc: ReactNode }): ReactNode {
  return (
    <>
      <dt className="shp-term">{term}</dt>
      <dd className="shp-desc">{desc}</dd>
    </>
  )
}

/** An empty state that says what "normal" looks like. */
function EmptyState({ title, body }: { readonly title: string; readonly body: string }): ReactNode {
  return (
    <div className="shp-empty">
      <span className="shp-empty-title">{title}</span>
      <span className="shp-empty-body">{body}</span>
    </div>
  )
}

/** A labelled text/number input (password mode for write-only secrets). */
function Field({ label, hint, value, onChange, inputMode, disabled, type, autoComplete, placeholder, spellCheck, multiline }: {
  readonly label: string
  readonly hint?: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly inputMode?: 'numeric' | 'decimal' | 'text'
  readonly disabled?: boolean
  readonly type?: 'text' | 'password'
  readonly autoComplete?: string
  readonly placeholder?: string
  readonly spellCheck?: boolean
  /** Render a `<textarea>` (one entry per line, e.g. the SQL table allowlist). */
  readonly multiline?: boolean
}): ReactNode {
  return (
    <div className="shp-field">
      <span className="shp-field-label">{label}</span>
      {multiline === true ? (
        <textarea
          className="shp-textarea"
          value={value}
          autoComplete={autoComplete ?? 'off'}
          placeholder={placeholder}
          spellCheck={spellCheck === true}
          disabled={disabled === true}
          rows={4}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => { onChange(event.target.value) }}
        />
      ) : (
        <input
          className="shp-input"
          value={value}
          type={type ?? 'text'}
          inputMode={inputMode ?? 'text'}
          autoComplete={autoComplete ?? 'off'}
          placeholder={placeholder}
          spellCheck={spellCheck === true}
          disabled={disabled === true}
          onChange={(event: ChangeEvent<HTMLInputElement>) => { onChange(event.target.value) }}
        />
      )}
      {hint === undefined ? null : <span className="shp-field-hint">{hint}</span>}
    </div>
  )
}

/** A labelled native select (short, fixed option lists). */
function SelectField({ label, value, onChange, options, disabled, hint }: {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly options: readonly { readonly value: string; readonly label: string }[]
  readonly disabled?: boolean
  readonly hint?: string
}): ReactNode {
  return (
    <div className="shp-field">
      <span className="shp-field-label">{label}</span>
      <select
        className="shp-select"
        value={value}
        disabled={disabled === true}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => { onChange(event.target.value) }}
      >
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {hint === undefined ? null : <span className="shp-field-hint">{hint}</span>}
    </div>
  )
}

/**
 * A custom select: native `<option>` elements cannot carry the muted "workspace ·
 * short id" line the brief asks for, and two conversations may share a title.
 */
function Picker({ label, value, options, onChange, disabled, emptyText }: {
  readonly label: string
  readonly value: string
  readonly options: readonly PickerOption[]
  readonly onChange: (id: string) => void
  readonly disabled?: boolean
  readonly emptyText?: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const selected = options.find(option => option.id === value)
  return (
    <div className="shp-field" ref={rootRef}>
      <span className="shp-field-label">{label}</span>
      <button
        type="button"
        className={open ? 'shp-picker shp-picker-open' : 'shp-picker'}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled === true}
        onClick={() => { setOpen(current => !current) }}
      >
        <span className="shp-picker-value">
          <span className="shp-picker-title">{selected?.label ?? emptyText ?? '—'}</span>
          {selected?.meta === undefined ? null : <span className="shp-picker-meta">{selected.meta}</span>}
        </span>
        <span className="shp-caret" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <ul className="shp-menu" role="listbox" aria-label={label}>
          {options.map(option => (
            <li key={option.id} role="option" aria-selected={option.id === value}>
              <button
                type="button"
                className={option.id === value ? 'shp-menu-item shp-menu-item-active' : 'shp-menu-item'}
                onClick={() => { onChange(option.id); setOpen(false) }}
              >
                <span className="shp-menu-line">
                  <span className="shp-picker-title">{option.label}</span>
                  {option.tag === undefined ? null : <span className="shp-tag">{option.tag}</span>}
                </span>
                {option.meta === undefined ? null : <span className="shp-picker-meta">{option.meta}</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** A copy button that confirms locally. */
function CopyButton({ text, label }: { readonly text: string; readonly label?: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
  }, [])
  return (
    <button
      type="button"
      className="shp-btn shp-btn-ghost shp-btn-sm"
      onClick={() => {
        copyText(text)
        setCopied(true)
        if (timer.current !== undefined) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => { setCopied(false) }, 1_600)
      }}
    >
      {copied ? '已复制' : label ?? '复制'}
    </button>
  )
}

/** A centered loading line (no skeletons, per the brief). */
function Loading({ text }: { readonly text: string }): ReactNode {
  return (
    <div className="shp-loading" role="status">
      <span className="shp-spin" aria-hidden="true" />
      {text}
    </div>
  )
}

/** One 防护面 row: name, mode pill, one-line meaning. */
function ModeRow({ name, mode, meaning }: {
  readonly name: string
  readonly mode: string
  readonly meaning: string
}): ReactNode {
  const entry = MODE_LABELS[mode]
  return (
    <div className="shp-mode-row">
      <span className="shp-mode-name">{name}</span>
      {entry === undefined ? <Badge tone="muted">{mode}</Badge> : <Badge tone={entry.tone}>{entry.text}</Badge>}
      <span className="shp-mode-meaning">{meaning}</span>
    </div>
  )
}

/** The overview tab: health at a glance, sessions, rules/ledger, attention. */
function OverviewTab({ payload, onJump, exportLedger }: {
  readonly payload: PanelPayload
  readonly onJump: (session: string | undefined) => void
  readonly exportLedger: (limit?: number) => Promise<PanelExportValue>
}): ReactNode {
  const judge = judgeFactOf(payload)
  const sessions = payload.sessionDetails.slice(0, 6)
  const moreSessions = payload.sessionDetails.length - sessions.length
  const [exportState, setExportState] = useState<ExportState>({ status: 'idle' })

  const eventCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of payload.recentEvents) {
      if (row.session === undefined) continue
      counts.set(row.session, (counts.get(row.session) ?? 0) + 1)
    }
    return counts
  }, [payload.recentEvents])

  const attention = useMemo(() => {
    const rows = payload.recentEvents.filter(row =>
      matchesDecision(row.decision, 'deny') || matchesDecision(row.decision, 'warn') || matchesDecision(row.decision, 'fail'))
    return rows.slice(-3).reverse()
  }, [payload.recentEvents])

  // The export is a plain download: the Host returns an already-redacted NDJSON
  // slice and never writes a file itself.
  const runExport = useCallback((): void => {
    setExportState({ status: 'running' })
    void exportLedger(200).then(
      (value) => {
        downloadText(value.filename, value.content, 'application/x-ndjson')
        setExportState({ status: 'done', count: value.count, filename: value.filename })
      },
      (error: unknown) => { setExportState({ status: 'error', code: codeOf(error) }) },
    )
  }, [exportLedger])

  return (
    <div className="shp-stack">
      <div className="shp-kpi-grid">
        <Kpi label="拦截" value={payload.counters.deny} tone="danger" sub="本进程 · 输入 / 工具 / 输出"
          {...(payload.counters.auditBlocked > 0 ? { note: `账本拒绝 ${payload.counters.auditBlocked}` } : {})} />
        <Kpi label="告警" value={payload.counters.warn} tone="warn" sub="本进程 · 仅告警模式" />
        <Kpi label="审批" value={payload.counters.ask} tone="ask" sub="本进程 · 等待或已裁决" />
        <Kpi label="放行" value={payload.counters.allow} tone="ok" sub="本进程 · 无内部错误"
          {...(payload.counters.internalErrors > 0 ? { note: `内部错误 ${payload.counters.internalErrors}` } : {})} />
      </div>

      <div className="shp-overview-grid">
        <Card title="防护面" hint="强制 = 会拦截；仅告警 = 只记账">
          <div>
            <ModeRow name="输入" mode={payload.modes.input} meaning={MODE_MEANINGS.input ?? ''} />
            <ModeRow name="工具调用" mode={payload.modes.tools} meaning={MODE_MEANINGS.tools ?? ''} />
            <ModeRow name="工具结果" mode={payload.modes.results} meaning={MODE_MEANINGS.results ?? ''} />
            <ModeRow name="模型输出" mode={payload.modes.output} meaning={MODE_MEANINGS.output ?? ''} />
            <ModeRow name="审批桥" mode={payload.modes.approval} meaning={MODE_MEANINGS.approval ?? ''} />
            <div className="shp-mode-row">
              <span className="shp-mode-name">语义评审</span>
              {judge === undefined
                ? <Badge tone="muted">未上报</Badge>
                : <Badge tone={judge.enabled ? 'ok' : 'muted'}>{judge.enabled ? '已启用' : '已关闭'}</Badge>}
              {judge === undefined
                ? <span className="shp-mode-meaning">当前服务端版本还没有上报评审事实（需要 1.7.0）</span>
                : (
                  <span className="shp-mode-meaning">
                    {`${judge.provider.length > 0 ? judge.provider : '宿主默认'} / ${judge.model.length > 0 ? judge.model : '宿主默认'}`}
                    {judge.scope === 'always' ? ' · 评审全部输出' : ' · 只评审已标记输出'}
                    {judge.available ? '' : ' · 本 profile 无 llm 服务'}
                  </span>
                )}
            </div>
          </div>
        </Card>

        <Card title="会话" hint={`${payload.sessionDetails.length} 个对话（含历史）· ${payload.sessions} 个本进程`}>
          {sessions.length === 0 ? (
            <EmptyState
              title="还没有观察到会话"
              body="新开一个对话或发一条消息后，这里会出现它的标题、工作区和各结论计数。"
            />
          ) : (
            <ul className="shp-list">
              {sessions.map(detail => {
                const events = eventCounts.get(detail.id) ?? 0
                return (
                  <li key={detail.id}>
                    <button type="button" className="shp-session" onClick={() => { onJump(detail.id) }}>
                      <span className="shp-session-top">
                        <span className="shp-session-title">{conversationText(detail.id, detail.title, detail.workspace)}</span>
                        <span className="shp-mono">{detail.id}</span>
                        {detail.historical === true ? <Badge tone="warn">历史</Badge> : null}
                        <span className="shp-spacer" />
                        <span className="shp-session-note">{events > 0 ? `本窗口 ${events} 条事件` : '本窗口无事件'}</span>
                      </span>
                      <span className="shp-session-meta">
                        {detail.workspace === undefined ? '未记录工作区' : detail.workspace}
                        {` · 最近 ${formatEpoch(detail.lastSeenAt)}`}
                      </span>
                      {detail.historical === true ? (
                        <span className="shp-session-note">历史会话：计数是本进程的 0，点开可按账本事件筛选。</span>
                      ) : (
                        <span className="shp-session-counts">
                          <Badge tone="danger">拦截 {detail.deny}</Badge>
                          <Badge tone="ask">审批 {detail.ask}</Badge>
                          <Badge tone="warn">告警 {detail.warn}</Badge>
                          <Badge tone="ok">放行 {detail.allow}</Badge>
                          <span className="shp-session-note shp-num">{detail.calls} 次工具调用</span>
                        </span>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {moreSessions > 0 ? <p className="shp-card-hint">还有 {moreSessions} 个会话未显示；事件页可按对话筛选全部。</p> : null}
        </Card>

        <Card
          title="规则与账本"
          hint="只存代码、哈希与计数"
          actions={(
            <button
              type="button"
              className="shp-btn shp-btn-sm"
              onClick={runExport}
              disabled={!payload.ledger.enabled || exportState.status === 'running'}
              title={payload.ledger.enabled ? '下载最近 200 条已脱敏记录（NDJSON）' : '账本未启用'}
            >
              {exportState.status === 'running' ? '导出中…' : '导出账本片段'}
            </button>
          )}
        >
          <dl className="shp-defs">
            <DefRow term="规则集" desc={`${payload.rules.count} 条规则 · ${payload.rules.chains} 条链`} />
            <DefRow term="规则哈希" desc={
              <span className="shp-inline">
                <code className="shp-mono">{payload.rules.hash}…</code>
                <CopyButton text={payload.rules.hash} label="复制" />
              </span>
            } />
            <DefRow term="账本" desc={
              <span className="shp-inline">
                <Dot tone={payload.ledger.enabled ? (payload.ledger.writable ? 'ok' : 'danger') : 'muted'} />
                <span className={payload.ledger.writable ? '' : 'shp-line-error'}>
                  {payload.ledger.enabled
                    ? `${payload.ledger.records} 条记录${payload.ledger.writable ? '' : '（不可写）'}`
                    : '未启用'}
                  {payload.ledger.failures > 0 ? ` · ${payload.ledger.failures} 次写失败` : ''}
                </span>
              </span>
            } />
            <DefRow term="引擎" desc={`${payload.engine.kind} · ${payload.engine.status}${payload.engine.rulesStale ? ' · 规则待更新' : ''}`} />
            <DefRow term="账本文件" desc={
              payload.ledger.path === null ? '—' : (
                <span className="shp-inline">
                  <code className="shp-mono">{payload.ledger.path}</code>
                  <CopyButton text={payload.ledger.path} label="复制" />
                </span>
              )
            } />
            <DefRow term="规则目录" desc={payload.rulesDir.length > 0 ? <code className="shp-mono">{payload.rulesDir}</code> : '仅内置 rules/'} />
          </dl>
          {exportState.status === 'done' ? (
            <p className="shp-line-ok" role="status">
              已导出 {exportState.count} 条记录（<code className="shp-mono">{exportState.filename}</code>）。
            </p>
          ) : null}
          {exportState.status === 'error' ? (
            <p className="shp-line-error" role="alert">{exportErrorMessage(exportState.code)}</p>
          ) : null}
          <p className="shp-card-hint">
            完整日志：用 <code className="shp-mono">safeharness_audit_query</code>，或在任意会话输入 <code className="shp-mono">/safeharness audit 50</code>。
            「导出账本片段」下载最近 200 条已脱敏记录（NDJSON，只含哈希与长度）。
          </p>
        </Card>

        <Card title="最近需要关注" hint="最近 3 条拦截 / 告警 / 失败">
          {attention.length === 0 ? (
            <EmptyState
              title="没有需要关注的事件"
              body="账本窗口里没有拦截、告警或失败记录。这属于正常：安全面仍在记账，放行计数见上方「放行」。"
            />
          ) : (
            <ul className="shp-attention">
              {attention.map((row, index) => (
                <li key={`${row.ts}-${row.kind}-${String(index)}`}>
                  <button
                    type="button"
                    className="shp-attention-row"
                    title={`${reasonText(row)} · ${formatTime(row.ts)}`}
                    onClick={() => { onJump(row.session) }}
                  >
                    <span className="shp-attention-time">{formatEventTime(row.ts)}</span>
                    <Badge tone={toneOf(row.decision)}>{DECISION_LABELS[row.decision] ?? row.decision}</Badge>
                    <span className="shp-attention-title">{eventTitle(row)}</span>
                    <span className="shp-attention-reason">{reasonText(row)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

/** The events tab: filters + readable active-filter bar + timeline + pagination. */
function EventsTab({ payload, filter, onFilter }: {
  readonly payload: PanelPayload
  readonly filter: EventFilter
  readonly onFilter: (next: EventFilter) => void
}): ReactNode {
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => { setLimit(PAGE_SIZE) }, [filter])

  const workspaceInfo = useMemo(() => buildWorkspaces(payload), [payload.sessionDetails, payload.recentEvents])
  const conversations = useMemo(() => buildConversations(payload), [payload.sessionDetails, payload.recentEvents])

  const scopedConversations = useMemo(() => {
    if (filter.workspace === 'all') return conversations
    return conversations.filter(entry => (entry.workspace ?? '') === filter.workspace)
  }, [conversations, filter.workspace])

  const workspaceOptions = useMemo(() => {
    const options: PickerOption[] = [{ id: 'all', label: '全部工作区', meta: `${workspaceInfo.workspaces.length} 个已记录` }]
    for (const path of workspaceInfo.workspaces) options.push({ id: path, label: workspaceLabel(path), meta: path })
    if (workspaceInfo.hasUnknown) options.push({ id: '', label: '未记录工作区', meta: '会话 / 事件没有上报项目目录' })
    if (filter.workspace !== 'all' && filter.workspace !== '' && !workspaceInfo.workspaces.includes(filter.workspace)) {
      options.push({ id: filter.workspace, label: workspaceLabel(filter.workspace), meta: filter.workspace, tag: '当前' })
    }
    return options
  }, [workspaceInfo, filter.workspace])

  const conversationOptions = useMemo(() => {
    const options: PickerOption[] = [{ id: 'all', label: '全部对话', meta: `共 ${scopedConversations.length} 个` }]
    for (const entry of scopedConversations) options.push(conversationOption(entry))
    if (filter.session !== 'all' && !scopedConversations.some(entry => entry.id === filter.session)) {
      options.push({ id: filter.session, label: filter.session, meta: '不在当前工作区内', tag: '当前' })
    }
    return options
  }, [scopedConversations, filter.session])

  const filtered = useMemo(() => {
    const rows: { readonly row: PanelEvent; readonly index: number }[] = []
    payload.recentEvents.forEach((row, index) => {
      if (matchEvent(row, filter)) rows.push({ row, index })
    })
    rows.reverse()
    return rows
  }, [payload.recentEvents, filter])

  const counts = useMemo(() => {
    let deny = 0
    let ask = 0
    let warn = 0
    let fail = 0
    for (const row of payload.recentEvents) {
      if (matchesDecision(row.decision, 'deny')) deny += 1
      else if (matchesDecision(row.decision, 'ask')) ask += 1
      else if (matchesDecision(row.decision, 'warn')) warn += 1
      else if (matchesDecision(row.decision, 'fail')) fail += 1
    }
    return { deny, ask, warn, fail }
  }, [payload.recentEvents])

  const activeParts: string[] = []
  if (filter.workspace !== 'all') activeParts.push(`工作区「${workspaceLabel(filter.workspace)}」`)
  if (filter.session !== 'all') {
    const entry = conversations.find(item => item.id === filter.session)
    const label = entry === undefined
      ? filter.session
      : entry.title !== undefined && entry.title.length > 0
        ? `${entry.title} · ${entry.id}`
        : conversationText(entry.id, entry.title, entry.workspace)
    activeParts.push(`对话「${label}」`)
  }
  if (filter.kind !== 'all') activeParts.push(`类别「${KIND_GROUP_LABELS[filter.kind]}」`)
  if (filter.decision !== 'all') activeParts.push(`结论「${DECISION_FILTER_LABELS[filter.decision]}」`)
  const active = activeParts.length > 0

  const visible = filtered.slice(0, limit)

  const clear = (): void => { onFilter({ ...EMPTY_FILTER }) }

  return (
    <div className="shp-stack">
      <section className="shp-filter-card">
        <div className="shp-toolbar">
          <Picker
            label="工作区"
            value={filter.workspace}
            options={workspaceOptions}
            onChange={(value) => { onFilter({ ...filter, workspace: value, session: 'all' }) }}
          />
          <Picker
            label="对话"
            value={filter.session}
            options={conversationOptions}
            onChange={(value) => { onFilter({ ...filter, session: value }) }}
          />
          <SelectField
            label="类别"
            value={filter.kind}
            onChange={(value) => { onFilter({ ...filter, kind: value as KindGroup }) }}
            options={(Object.keys(KIND_GROUP_LABELS) as KindGroup[]).map(key => ({ value: key, label: KIND_GROUP_LABELS[key] }))}
          />
        </div>

        <div className="shp-chips">
          {(['all', 'deny', 'ask', 'warn', 'fail'] as const).map(bucket => {
            const count = bucket === 'all'
              ? payload.recentEvents.length
              : bucket === 'deny' ? counts.deny : bucket === 'ask' ? counts.ask : bucket === 'warn' ? counts.warn : counts.fail
            return (
              <button
                key={bucket}
                type="button"
                className={filter.decision === bucket ? 'shp-chip shp-chip-active' : 'shp-chip'}
                onClick={() => { onFilter({ ...filter, decision: bucket }) }}
              >
                {DECISION_FILTER_LABELS[bucket]}
                <span className="shp-chip-count">{count}</span>
              </button>
            )
          })}
          <span className="shp-spacer" />
          <span className="shp-hint shp-num">
            账本最近扫描 {payload.eventWindow.scanned} 条 · 需要关注 {payload.eventWindow.kept} 条
            {payload.eventWindow.since === null ? '' : ` · 从 ${formatTime(payload.eventWindow.since)} 起`}
          </span>
        </div>

        <div className={active ? 'shp-filterbar shp-filterbar-on' : 'shp-filterbar'}>
          <span className="shp-filterbar-label">{active ? '正在筛选' : '未筛选'}</span>
          {active
            ? activeParts.map(part => <span key={part} className="shp-filter-chip" title={part}>{part}</span>)
            : <span className="shp-filterbar-hint">显示最近需要关注的全部事件（新→旧）</span>}
          <span className="shp-spacer" />
          <span className="shp-hint shp-num">共 {filtered.length} 条</span>
          <button type="button" className="shp-btn shp-btn-sm" onClick={clear} disabled={!active}>清除筛选</button>
        </div>
      </section>

      <section className="shp-card">
        <div className="shp-card-head">
          <h4 className="shp-card-title">事件时间线</h4>
          <span className="shp-card-hint">点一行展开细节（规则 id、原因代码、严重度）；不显示参数或输出内容。</span>
        </div>
        {filtered.length === 0 ? (
          <EmptyState
            title={active ? '当前筛选下没有事件' : '账本窗口里没有需要关注的事件'}
            body={active
              ? '试试放宽一个条件，或点上面的「清除筛选」。'
              : '账本只把拦截、告警、审批与失败投影到列表；正常放行仍在计数（见概览的「放行」），所以这里为空是正常状态。'}
          />
        ) : (
          <>
            <ul className="shp-timeline">
              {visible.map(({ row, index }) => {
                const key = `${row.ts}-${row.kind}-${String(index)}`
                const tone = toneOf(row.decision)
                const open = expanded === key
                return (
                  <li key={key} className="shp-tl-item" style={{ borderLeftColor: TONE_COLOR[tone] }}>
                    <button
                      type="button"
                      className="shp-tl-btn"
                      aria-expanded={open}
                      onClick={() => { setExpanded(open ? null : key) }}
                    >
                      <span className="shp-tl-top">
                        <Badge tone={tone}>{DECISION_LABELS[row.decision] ?? (row.decision.length > 0 ? row.decision : '—')}</Badge>
                        <Badge tone="muted">{KIND_LABELS[row.kind] ?? row.kind}</Badge>
                        <span className="shp-tl-title">{eventTitle(row)}</span>
                        <span className="shp-spacer" />
                        <span className="shp-mono shp-tl-time">{formatEventTime(row.ts)}</span>
                      </span>
                      <span className="shp-tl-meta">
                        <span>{reasonText(row)}</span>
                        <span>·</span>
                        <span>{conversationText(row.session, row.title, row.workspace)}</span>
                        <span>·</span>
                        <span>{workspaceLabel(row.workspace)}</span>
                        <span>·</span>
                        <span>规则 {row.rules}</span>
                        {row.argsHash === undefined ? null : (
                          <>
                            <span>·</span>
                            <code className="shp-mono">参数 {row.argsHash}</code>
                          </>
                        )}
                      </span>
                    </button>
                    {open ? (
                      <div className="shp-tl-detail">
                        <dl className="shp-defs shp-tl-defs">
                          <DefRow term="原因代码" desc={<code className="shp-mono">{row.reasonCode.length > 0 ? row.reasonCode : '—'}</code>} />
                          <DefRow term="严重度" desc={row.severity === undefined ? '—' : `${SEVERITY_LABELS[row.severity] ?? row.severity}（${row.severity}）`} />
                          <DefRow term="类别" desc={row.category ?? '—'} />
                          <DefRow term="记录类型" desc={<code className="shp-mono">{row.kind}</code>} />
                          <DefRow term="命中规则" desc={row.ruleIds.length === 0
                            ? `无（规则数 ${row.rules}）`
                            : <code className="shp-mono">{row.ruleIds.join(' · ')}</code>} />
                          <DefRow term="会话" desc={row.session === undefined ? '无会话' : <code className="shp-mono">{row.session}</code>} />
                          <DefRow term="工作区" desc={row.workspace ?? '未记录'} />
                          <DefRow term="时间" desc={formatTime(row.ts)} />
                        </dl>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            {filtered.length > visible.length ? (
              <div className="shp-card-actions">
                <button type="button" className="shp-btn" onClick={() => { setLimit(current => current + PAGE_SIZE) }}>
                  显示更多（{visible.length} / {filtered.length}）
                </button>
                <span className="shp-hint">新的在前，每次 {PAGE_SIZE} 条。</span>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  )
}

/** A landing file name for one draft: lowercase token with a YAML suffix. */
function ruleFilenameFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
    .slice(0, 48)
  return `${slug.length > 0 ? slug : 'operator-rule'}.yaml`
}

/** The rules tab: inventory, search, reload, AI drafting, land-as-file. */
/**
 * Rule-directory snapshots (1.14.0).
 *
 * Every rule write first copies the directory, so this card is the "undo" shelf:
 * newest first, with the live state marked. Rolling back is two clicks (the row
 * turns into a confirm) because it rewrites the rule directory — the plugin's
 * trust root — even though the Host runs the loader gate and snapshots the state
 * being replaced.
 */
function SnapshotCard({ face, writable, refreshKey, onReloaded }: {
  readonly face: PanelFace
  readonly writable: boolean
  /** Changes after a successful write so the list refreshes on its own. */
  readonly refreshKey: string | null
  readonly onReloaded: () => void
}): ReactNode {
  const [state, setState] = useState<
    | { readonly status: 'idle' | 'loading' }
    | { readonly status: 'done'; readonly value: PanelRuleHistoryValue }
    | { readonly status: 'error'; readonly code: string }
  >({ status: 'idle' })
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const load = useCallback((): void => {
    setState(current => current.status === 'done' ? current : { status: 'loading' })
    void face.ruleHistory().then(
      value => { setState({ status: 'done', value }) },
      (error: unknown) => { setState({ status: 'error', code: codeOf(error) }) },
    )
  }, [face])

  useEffect(() => { load() }, [load, refreshKey])

  const rollbackTo = (id: string): void => {
    setBusy(true)
    setMessage(null)
    setFailure(null)
    void face.rollbackRule(id).then(
      (value) => {
        setBusy(false)
        setConfirming(null)
        const removed = value.removed.length === 0 ? '' : `，移除 ${value.removed.length} 个不在快照中的文件`
        setMessage(`已回滚到 ${value.snapshot}：恢复 ${value.files} 个文件${removed}${value.reloaded ? '，已重新加载' : '，但热重载未生效（看日志）'}`)
        onReloaded()
        load()
      },
      (error: unknown) => {
        setBusy(false)
        setConfirming(null)
        setFailure(`${actionError(codeOf(error))}${detailOf(error) === undefined ? '' : `（${detailOf(error)}）`}`)
      },
    )
  }

  return (
    <Card
      title="快照与回滚"
      hint={writable ? '每次写入前自动快照；最多保留 10 份' : '未配置 rules.dir：写入与快照都不可用'}
      actions={(
        <button type="button" className="shp-btn shp-btn-sm" onClick={load} disabled={state.status === 'loading' || busy}>
          {state.status === 'loading' ? '读取中…' : '刷新快照'}
        </button>
      )}
    >
      {state.status === 'error' ? (
        <p className="shp-line-error" role="alert">{actionError(state.code)}</p>
      ) : null}
      {state.status === 'done' && state.value.snapshots.length === 0 ? (
        <p className="shp-card-hint">
          还没有快照。第一次「写入并重载」时会自动生成一份；也可以先手动写入一条规则来建立基线。
        </p>
      ) : null}
      {state.status === 'done' && state.value.snapshots.length > 0 ? (
        <div className="shp-rule-list">
          {state.value.snapshots.map((snapshot) => {
            const when = new Date(snapshot.createdAt).toLocaleString('zh-CN', { hour12: false })
            const trigger = snapshot.trigger === 'pre-rollback' ? '回滚前自动' : snapshot.trigger === 'manual' ? '手动' : '写入前自动'
            return (
              <div key={snapshot.id} className="shp-rule-row">
                <div className="shp-rule-head">
                  <span className="shp-rule-name">{when}</span>
                  {snapshot.active ? <Badge tone="ok">当前状态</Badge> : null}
                  <span className="shp-rule-meta">
                    {snapshot.files} 个文件 · {(snapshot.bytes / 1024).toFixed(1)} KiB · {trigger} · {snapshot.id}
                  </span>
                  <span className="shp-spacer" />
                  {confirming === snapshot.id ? (
                    <>
                      <button type="button" className="shp-btn shp-btn-sm shp-btn-primary" disabled={busy} onClick={() => { rollbackTo(snapshot.id) }}>
                        {busy ? '回滚中…' : '确认回滚'}
                      </button>
                      <button type="button" className="shp-btn shp-btn-sm" disabled={busy} onClick={() => { setConfirming(null) }}>
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="shp-btn shp-btn-sm"
                      disabled={busy || snapshot.active}
                      onClick={() => { setConfirming(snapshot.id) }}
                    >
                      {snapshot.active ? '无需回滚' : '回滚'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
      {message === null ? null : <p className="shp-line-ok" role="status">{message}</p>}
      {failure === null ? null : <p className="shp-line-error" role="alert">{failure}</p>}
      <p className="shp-card-hint">
        回滚会把 <code className="shp-mono">rules.dir</code> 恢复成该快照的样子：快照里没有的规则文件会被移除（只动
        <code className="shp-mono"> .yaml/.yml</code>），并且先给当前状态拍一份快照，所以回滚本身也能反悔。
        恢复前宿主会先在临时目录里跑一遍 loader，编不过就一个字节都不写。
      </p>
    </Card>
  )
}

function RulesTab({ payload, face, onRefresh }: {
  readonly payload: PanelPayload
  readonly face: PanelFace
  readonly onRefresh: () => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<'inform' | 'chain'>('inform')
  const [draft, setDraft] = useState<DraftState>({ status: 'idle' })
  const [filename, setFilename] = useState('')
  const [write, setWrite] = useState<RuleWriteState>({ status: 'idle' })
  const [reloading, setReloading] = useState(false)
  const [reloadMessage, setReloadMessage] = useState<string | null>(null)

  // Landing a draft needs a configured `rules.dir`; without one the only option is
  // copy-paste, and the button explains that instead of failing on click.
  const writable = payload.rulesDir.length > 0

  const rules = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return payload.rulesDetail
    return payload.rulesDetail.filter(rule =>
      `${rule.name} ${rule.category} ${rule.origin} ${rule.detail} ${rule.kind} ${rule.severity}`.toLowerCase().includes(needle))
  }, [payload.rulesDetail, query])

  const startDraft = (): void => {
    if (description.trim().length === 0) return
    setDraft({ status: 'running' })
    setWrite({ status: 'idle' })
    setFilename('')
    void face.draft({ description: description.trim(), kind }).then(
      value => {
        setDraft({ status: 'done', value })
        setFilename(ruleFilenameFor(value.name))
      },
      (error: unknown) => {
        const detail = detailOf(error)
        setDraft({ status: 'error', code: codeOf(error), ...(detail === undefined ? {} : { detail }) })
      },
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
        setReloadMessage(actionError(codeOf(error)))
      },
    )
  }

  /**
   * Land the current draft. `overwrite: false` first: the Host answers `rule_exists`
   * when the name is taken, and only the explicit "覆盖并重载" click passes `true`.
   */
  const writeRule = (overwrite: boolean): void => {
    if (draft.status !== 'done') return
    setWrite({ status: 'saving' })
    void face.writeRule({ filename: filename.trim(), yaml: draft.value.yaml, overwrite }).then(
      (value) => {
        setWrite({ status: 'done', value })
        onRefresh()
      },
      (error: unknown) => {
        const code = codeOf(error)
        if (code === 'rule_exists') {
          setWrite({ status: 'exists' })
          return
        }
        const detail = detailOf(error)
        const problems = problemsOf(error)
        setWrite({
          status: 'error',
          code,
          ...(detail === undefined ? {} : { detail }),
          ...(problems.length === 0 ? {} : { problems }),
        })
      },
    )
  }

  const maxChars = payload.draft.maxChars > 0 ? payload.draft.maxChars : 2_000

  return (
    <div className="shp-stack">
      <Card
        title="规则集"
        hint={`${payload.rules.count} 条规则 · ${payload.rules.chains} 条链 · ${payload.rules.hash}…`}
        actions={(
          <button type="button" className="shp-btn shp-btn-sm" onClick={reload} disabled={reloading}>
            {reloading ? '重新加载中…' : '重新加载规则'}
          </button>
        )}
      >
        <p className="shp-card-hint">
          规则目录：<code className="shp-mono">{payload.rulesDir.length > 0 ? payload.rulesDir : '（仅内置 rules/）'}</code>。
          改完规则文件后点「重新加载规则」，不需要重启；加载失败会保留旧规则集并写日志。
        </p>
        {reloadMessage === null ? null : <p className="shp-line-ok" role="status">{reloadMessage}</p>}
        <div className="shp-search">
          <input
            className="shp-input"
            placeholder="搜索规则名 / 类别 / 来源 / 模式…"
            value={query}
            onChange={(event: ChangeEvent<HTMLInputElement>) => { setQuery(event.target.value) }}
          />
          <span className="shp-hint shp-num">{rules.length} / {payload.rulesDetail.length}</span>
        </div>
        {rules.length === 0 ? (
          <EmptyState title="没有匹配的规则" body="清空搜索框，或换一个关键词（规则名、类别、来源文件名都参与匹配）。" />
        ) : (
          <div>
            {rules.map(rule => {
              const key = `${rule.kind}-${rule.name}`
              const open = expanded === key
              return (
                <div key={key} className="shp-rule">
                  <span className="shp-rule-bar" style={{ background: TONE_COLOR[severityTone(rule.severity)] }} aria-hidden="true" />
                  <button
                    type="button"
                    className="shp-rule-main"
                    aria-expanded={open}
                    onClick={() => { setExpanded(open ? null : key) }}
                  >
                    <span className="shp-rule-name">{rule.name}</span>
                    <Badge tone={rule.kind === 'chain' ? 'ask' : 'muted'}>{rule.kind === 'chain' ? '链' : '规则'}</Badge>
                    <span className="shp-rule-meta">
                      {rule.category} · {SEVERITY_LABELS[rule.severity] ?? rule.severity} · {rule.origin.length > 0 ? rule.origin : 'chain'}
                    </span>
                    <span className="shp-spacer" />
                    <span className="shp-rule-hits">本窗口命中 {rule.hits}</span>
                  </button>
                  {open ? (
                    <div className="shp-rule-detail">
                      <code>{rule.detail}</code>
                      <div className="shp-card-actions">
                        <CopyButton text={rule.detail} label="复制模式" />
                        <span className="shp-hint">命中数是当前事件窗口的粗粒度活跃度，不是判定结论。</span>
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </Card>

      <SnapshotCard face={face} writable={writable} refreshKey={write.status === 'done' ? write.value.filename : null} onReloaded={onRefresh} />

      <Card
        title="AI 起草规则"
        hint={payload.draft.enabled ? `已启用 · 描述上限 ${payload.draft.maxChars} 字` : '未启用（config `draft.enabled`）'}
      >
        <p className="shp-card-hint">
          用一句话描述「要抓什么」，让辅助模型起草一条规则。草稿不会自动生效：只返回经 loader 门校验的 YAML，
          复制到 rules 目录（或 <code className="shp-mono">rules.inline</code>）后再点「重新加载规则」。
        </p>
        <textarea
          className="shp-textarea"
          placeholder="例：下载脚本后直接交给 shell 执行"
          value={description}
          maxLength={maxChars}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => { setDescription(event.target.value) }}
        />
        <div className="shp-toolbar">
          <SelectField
            label="类型"
            value={kind}
            onChange={(value) => { setKind(value === 'chain' ? 'chain' : 'inform') }}
            options={[
              { value: 'inform', label: '单条规则（inform）' },
              { value: 'chain', label: '调用链（chain）' },
            ]}
          />
          <button
            type="button"
            className="shp-btn shp-btn-primary"
            disabled={!payload.draft.enabled || draft.status === 'running' || description.trim().length === 0}
            onClick={startDraft}
          >
            {draft.status === 'running' ? '起草中…' : '起草'}
          </button>
          <span className="shp-hint shp-num">{description.length} / {maxChars}</span>
          {draft.status === 'error' ? <span className="shp-line-error" role="alert">{actionError(draft.code, draft.detail)}</span> : null}
        </div>
        {draft.status === 'done' ? (
          <div className="shp-stack">
            <div className="shp-card-actions">
              <Badge tone="ok">草稿</Badge>
              <strong>{draft.value.name}</strong>
              <span className="shp-card-hint">{draft.value.category} · {SEVERITY_LABELS[draft.value.severity] ?? draft.value.severity}</span>
              <span className="shp-spacer" />
              <CopyButton text={draft.value.yaml} label="复制 YAML" />
            </div>
            <p className="shp-card-hint">{draft.value.summary}</p>
            <pre className="shp-pre">{draft.value.yaml}</pre>
            {draft.value.warnings.length === 0 ? null : (
              <ul className="shp-warn-list">
                {draft.value.warnings.map((warning, index) => <li key={`${warning}-${String(index)}`}>{warning}</li>)}
              </ul>
            )}
            <div className="shp-stack">
              <p className="shp-card-hint">
                草稿不会自动生效。确认后会写成
                {writable
                  ? <> <code className="shp-mono">{payload.rulesDir}</code> 下的一个文件并立即热重载</>
                  : ' rules.dir 下的一个文件（当前未配置，只能复制粘贴）'}
                ；写入前先用 loader 校验，失败不落盘。
              </p>
              <Field
                label="文件名"
                hint="小写字母/数字/._-，以 .yaml 结尾；同名文件需要再确认一次"
                value={filename}
                onChange={(value) => { setFilename(value); setWrite({ status: 'idle' }) }}
                disabled={write.status === 'saving'}
                placeholder="operator-my-rule.yaml"
                spellCheck={false}
              />
              <div className="shp-card-actions">
                {write.status === 'idle' ? (
                  <>
                    <button
                      type="button"
                      className="shp-btn shp-btn-primary"
                      onClick={() => { setWrite({ status: 'confirming' }) }}
                      disabled={!writable}
                    >
                      写入并重载
                    </button>
                    {writable ? null : <span className="shp-hint">未配置 rules.dir：只能复制粘贴。</span>}
                  </>
                ) : null}
                {write.status === 'confirming' ? (
                  <>
                    <span className="shp-hint">确认把这段 YAML 写成 {filename.trim()} 并立即生效？</span>
                    <button type="button" className="shp-btn shp-btn-primary" onClick={() => { writeRule(false) }}>确认写入</button>
                    <button type="button" className="shp-btn" onClick={() => { setWrite({ status: 'idle' }) }}>取消</button>
                  </>
                ) : null}
                {write.status === 'saving' ? <span className="shp-hint">写入中…</span> : null}
                {write.status === 'exists' ? (
                  <>
                    <span className="shp-line-error" role="alert">同名文件已存在。</span>
                    <button type="button" className="shp-btn" onClick={() => { writeRule(true) }}>覆盖并重载</button>
                    <button type="button" className="shp-btn" onClick={() => { setWrite({ status: 'idle' }) }}>取消</button>
                  </>
                ) : null}
              </div>
              {write.status === 'done' ? (
                <p className="shp-line-ok" role="status">
                  已{write.value.reloaded ? '写入并重载' : '写入（热重载失败，保留旧规则集）'}：{write.value.filename}
                  {' · '}{write.value.bytes} B{' · '}{write.value.rules} 条规则 / {write.value.chains} 条链{' · '}{write.value.hash}…
                </p>
              ) : null}
              {write.status === 'error' ? (
                <div className="shp-stack">
                  <span className="shp-line-error" role="alert">{actionError(write.code, write.detail)}</span>
                  {write.problems === undefined || write.problems.length === 0 ? null : (
                    <ul className="shp-warn-list">
                      {write.problems.map((problem, index) => <li key={`${problem}-${String(index)}`}>{problem}</li>)}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  )
}

/** The patrol tab: one manual run plus the optional timer. */
function PatrolTab({ payload, face, onRefresh }: {
  readonly payload: PanelPayload
  readonly face: PanelFace
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
      (error: unknown) => { setState({ status: 'error', code: codeOf(error) }) },
    )
  }, [face, onRefresh])

  const saveSchedule = (): void => {
    setSaving(true)
    setScheduleError(null)
    const intervalMinutes = schedule.enabled ? schedule.intervalMinutes : null
    void face.schedule({ enabled: schedule.enabled, intervalMinutes }).then(
      () => { setSaving(false); onRefresh() },
      (error: unknown) => { setSaving(false); setScheduleError(actionError(codeOf(error))) },
    )
  }

  // `persisted: false` only means "nothing has been written yet". It is not a
  // failure until the timer is armed (or has run once), so the idle state stays
  // neutral instead of warning about a file that was never needed.
  const scheduleActive = payload.schedule.enabled || payload.schedule.lastRunAt !== null

  return (
    <div className="shp-stack">
      <Card
        title="手动巡检"
        hint="拒绝速率 · 健康探针 · 姿态漂移 · 账本对账 · 通知通道"
        actions={state.status === 'done'
          ? <Badge tone={state.report.exitCode === 0 ? 'ok' : 'danger'}>{state.report.exitCode === 0 ? '干净' : '有问题'}</Badge>
          : undefined}
      >
        <p className="shp-card-hint">
          运行一次外部巡检。它会写一条 <code className="shp-mono">patrol_report</code> 记录，并在配置了通知通道时发送一条摘要。
        </p>
        <div className="shp-card-actions">
          {state.status !== 'confirming' && state.status !== 'running' ? (
            <button type="button" className="shp-btn shp-btn-primary" onClick={() => { setState({ status: 'confirming' }) }}>
              {state.status === 'done' ? '再运行一次' : '运行巡检'}
            </button>
          ) : null}
          {state.status === 'confirming' ? (
            <>
              <span className="shp-hint">确认运行一次巡检？会写账本，可能发出通知。</span>
              <button type="button" className="shp-btn shp-btn-primary" onClick={run}>确认运行</button>
              <button type="button" className="shp-btn" onClick={() => { setState({ status: 'idle' }) }}>取消</button>
            </>
          ) : null}
          {state.status === 'running' ? <span className="shp-hint">巡检运行中…</span> : null}
          {state.status === 'error' ? <span className="shp-line-error" role="alert">{actionError(state.code)}</span> : null}
        </div>
        {state.status === 'done' ? (
          <div className="shp-stack">
            <div className="shp-kpi-grid">
              <Kpi label="FAIL" value={state.report.summary.fail} tone={state.report.summary.fail > 0 ? 'danger' : 'ok'} sub="检查失败" />
              <Kpi label="WARN" value={state.report.summary.warn} tone={state.report.summary.warn > 0 ? 'warn' : 'ok'} sub="需要看一眼" />
              <Kpi label="OK / SKIP" value={`${state.report.summary.ok} / ${state.report.summary.skip}`} tone="ok" sub="通过 / 跳过" />
              <Kpi label="退出码" value={state.report.exitCode} tone={state.report.exitCode === 0 ? 'ok' : 'danger'} sub={state.report.notified ? '通知已送达' : '未发送通知'} />
            </div>
            <ul className="shp-findings">
              {state.report.findings.map((finding, index) => (
                <li key={`${finding.code}-${String(index)}`} className="shp-finding">
                  <Badge tone={findingTone(finding.severity)}>{finding.severity}</Badge>
                  <code className="shp-finding-code">{finding.code}</code>
                  <span className="shp-finding-detail">{finding.detail}</span>
                </li>
              ))}
            </ul>
            <p className="shp-hint">
              运行于 {formatTime(state.report.ranAt)}
              {state.report.internalError === undefined ? '' : ` · 内部错误：${state.report.internalError}`}
              {state.report.summary.clean ? ' · 没有 FAIL' : ''}
            </p>
          </div>
        ) : null}
      </Card>

      <Card
        title="定时巡检"
        hint={payload.schedule.enabled ? `已启用 · 每 ${payload.schedule.intervalMinutes} 分钟` : '未启用'}
        actions={scheduleActive
          ? <Badge tone={payload.schedule.persisted ? 'ok' : 'warn'}>{payload.schedule.persisted ? '已持久化' : '仅内存'}</Badge>
          : <Badge tone="muted">未启用</Badge>}
      >
        <p className="shp-card-hint">
          按固定间隔自动跑一次上面的巡检（写账本、按配置发通知）。调度器在宿主进程里，随插件卸载而停止；
          设置保存在 <code className="shp-mono">$DSH_HOME/safeharness/panel-state.json</code>，重启后恢复。
        </p>
        <div className="shp-toolbar">
          <label className="shp-switch-label">
            <input
              type="checkbox"
              checked={schedule.enabled}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                setSchedule(current => ({ ...current, enabled: event.target.checked }))
              }}
            />
            启用定时巡检
          </label>
          <SelectField
            label="间隔"
            value={String(schedule.intervalMinutes)}
            onChange={(value) => { setSchedule(current => ({ ...current, intervalMinutes: Number(value) })) }}
            options={INTERVAL_CHOICES.map(minutes => ({
              value: String(minutes),
              label: minutes < 60 ? `${minutes} 分钟` : minutes === 60 ? '1 小时' : minutes === 1_440 ? '24 小时' : `${minutes / 60} 小时`,
            }))}
          />
          <button type="button" className="shp-btn" onClick={saveSchedule} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
          {scheduleError === null ? null : <span className="shp-line-error" role="alert">{scheduleError}</span>}
        </div>
        <dl className="shp-defs">
          <DefRow term="下次运行" desc={formatEpoch(payload.schedule.nextAt)} />
          <DefRow term="上次定时运行" desc={formatEpoch(payload.schedule.lastRunAt)} />
          <DefRow term="状态文件" desc={scheduleActive
            ? payload.schedule.persisted ? '已持久化（重启后恢复）' : '未持久化：宿主无法写入状态文件，重启后丢失'
            : '未启用（启用并保存后写入 panel-state.json）'} />
        </dl>
      </Card>
    </div>
  )
}

/**
 * The settings tab: judge + drafting routes, save bar, judge probe.
 *
 * Exported (1.15.2) so the save path can be exercised in a DOM test: every
 * control must reach `buildPatch`, and the bar must stop saying "没有修改" the
 * moment one of them moves.
 */
export function SettingsTab({ face, active, draftFact, onRefresh }: {
  readonly face: PanelFace
  readonly active: boolean
  readonly draftFact: PanelDraft
  readonly onRefresh: () => void
}): ReactNode {
  const [view, setView] = useState<SettingsView>({ status: 'idle' })
  const [request, setRequest] = useState(0)
  const [save, setSave] = useState<SaveState>({ status: 'idle' })
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' })
  // The provider form is deliberately not persisted: it can hold a key.
  const [providerForm, setProviderForm] = useState<ProviderForm>(EMPTY_PROVIDER_FORM)
  const [providerOp, setProviderOp] = useState<ProviderOp>({ status: 'idle' })
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const loaded = useRef(false)

  useEffect(() => {
    if (!active) return undefined
    if (loaded.current && request === 0) return undefined
    loaded.current = true
    let current = true
    setView({ status: 'loading' })
    void face.loadSettings().then(
      (value) => {
        if (!current) return
        // A Host remount (a settings write hot-reloads the plugin) wipes React
        // state; restore an unsaved draft only while the server still stands on
        // the baseline it was typed against.
        const base = toSettingsData(value)
        let data = base
        const stored = readStoredValue(SETTINGS_DRAFT_KEY)
        if (stored !== null) {
          try {
            const parsed = JSON.parse(stored) as Partial<StoredSettingsDraft>
            if (parsed.baseline === baselineOf(value) && parsed.judge !== undefined && parsed.draft !== undefined) {
              data = {
                value,
                judge: parsed.judge,
                draft: parsed.draft,
                surfaces: parsed.surfaces ?? base.surfaces,
                inputJudge: parsed.inputJudge ?? base.inputJudge,
                toolDetection: parsed.toolDetection ?? base.toolDetection,
                pii: parsed.pii ?? base.pii,
                lists: parsed.lists ?? base.lists,
                source: parsed.source ?? base.source,
              }
            } else {
              storeValue(SETTINGS_DRAFT_KEY, null)
            }
          } catch {
            storeValue(SETTINGS_DRAFT_KEY, null)
          }
        }
        setView({ status: 'ready', data })
        const savedAt = Number(readStoredValue(SETTINGS_SAVED_KEY))
        if (Number.isFinite(savedAt) && Date.now() - savedAt < 15_000) {
          // The save that triggered this remount succeeded: keep saying so.
          setSave({ status: 'saved' })
          storeValue(SETTINGS_SAVED_KEY, null)
        } else {
          setSave({ status: 'idle' })
        }
        setRequest(0)
      },
      (error: unknown) => {
        if (!current) return
        setView({ status: 'error', code: codeOf(error) })
      },
    )
    return () => { current = false }
  }, [active, request, face])

  const data = view.status === 'ready' ? view.data : undefined
  const patchResult = useMemo<PatchResult>(() => {
    if (data === undefined) return { patch: undefined, invalid: null }
    return buildPatch(data.value, data)
  }, [data])

  // Keep an unsaved form across a remount; a clean form clears the draft.
  useEffect(() => {
    if (view.status !== 'ready') return
    const { value, ...form } = view.data
    const result = buildPatch(value, form)
    const dirty = result.patch !== undefined || result.invalid !== null
    storeValue(
      SETTINGS_DRAFT_KEY,
      dirty ? JSON.stringify({ baseline: baselineOf(value), ...form }) : null,
    )
  }, [view])

  const updateJudge = useCallback((patch: Partial<JudgeForm>): void => {
    setView(current => current.status === 'ready'
      ? { status: 'ready', data: { ...current.data, judge: { ...current.data.judge, ...patch } } }
      : current)
    // A new edit makes the previous "已保存" line stale.
    setSave(current => current.status === 'saved' ? { status: 'idle' } : current)
  }, [])

  const updateDraft = useCallback((patch: Partial<DraftForm>): void => {
    setView(current => current.status === 'ready'
      ? { status: 'ready', data: { ...current.data, draft: { ...current.data.draft, ...patch } } }
      : current)
    setSave(current => current.status === 'saved' ? { status: 'idle' } : current)
  }, [])

  const updateSurface = useCallback((patch: Partial<PanelSurfaceSettings>): void => {
    setView(current => current.status === 'ready'
      ? { status: 'ready', data: { ...current.data, surfaces: { ...current.data.surfaces, ...patch } } }
      : current)
    setSave(current => current.status === 'saved' ? { status: 'idle' } : current)
  }, [])

  const updateInputJudge = useCallback((patch: Partial<PanelInputJudge>): void => {
    setView(current => current.status === 'ready'
      ? { status: 'ready', data: { ...current.data, inputJudge: { ...current.data.inputJudge, ...patch } } }
      : current)
    setSave(current => current.status === 'saved' ? { status: 'idle' } : current)
  }, [])

  const updateToolDetection = useCallback((patch: Partial<ToolDetectionForm>): void => {
    setView(current => current.status === 'ready'
      ? { status: 'ready', data: { ...current.data, toolDetection: { ...current.data.toolDetection, ...patch } } }
      : current)
    setSave(current => current.status === 'saved' ? { status: 'idle' } : current)
  }, [])

  const updatePii = useCallback((patch: Partial<PanelResultPii>): void => {
    setView(current => current.status === 'ready'
      ? { status: 'ready', data: { ...current.data, pii: { ...current.data.pii, ...patch } } }
      : current)
    setSave(current => current.status === 'saved' ? { status: 'idle' } : current)
  }, [])

  const updateList = useCallback((patch: Partial<ListForm>): void => {
    setView(current => current.status === 'ready'
      ? { status: 'ready', data: { ...current.data, lists: { ...current.data.lists, ...patch } } }
      : current)
    setSave(current => current.status === 'saved' ? { status: 'idle' } : current)
  }, [])

  const updateSource = useCallback((patch: Partial<SourceForm>): void => {
    setView(current => current.status === 'ready'
      ? { status: 'ready', data: { ...current.data, source: { ...current.data.source, ...patch } } }
      : current)
    setSave(current => current.status === 'saved' ? { status: 'idle' } : current)
  }, [])

  const retry = useCallback((): void => { setRequest(current => current + 1) }, [])

  const runProbe = useCallback((): void => {
    setProbe({ status: 'running' })
    void face.probeJudge().then(
      (value) => { setProbe({ status: 'done', probe: value }) },
      (error: unknown) => { setProbe({ status: 'error', code: codeOf(error) }) },
    )
  }, [face])

  const saveNow = useCallback((): void => {
    const patch = patchResult.patch
    if (patch === undefined) return
    setSave({ status: 'saving' })
    void face.saveSettings(patch).then(
      (value) => {
        setView({ status: 'ready', data: toSettingsData(value) })
        setSave({ status: 'saved' })
        // The write hot-reloads the plugin, which can remount this tab: remember
        // the success briefly so the remounted form still says it saved.
        storeValue(SETTINGS_SAVED_KEY, String(Date.now()))
        onRefresh()
      },
      (error: unknown) => { setSave({ status: 'error', code: codeOf(error) }) },
    )
  }, [face, onRefresh, patchResult])

  const resetForm = useCallback((): void => {
    setView(current => current.status === 'ready'
      ? { status: 'ready', data: toSettingsData(current.data.value) }
      : current)
    setSave({ status: 'idle' })
  }, [])

  const updateProvider = useCallback((patch: Partial<ProviderForm>): void => {
    setProviderForm(current => ({ ...current, ...patch }))
    setProviderOp(current => current.status === 'error' ? { status: 'idle' } : current)
  }, [])

  const resetProviderForm = useCallback((): void => {
    setProviderForm(EMPTY_PROVIDER_FORM)
    setProviderOp({ status: 'idle' })
    setConfirmDelete(null)
  }, [])

  /**
   * Add one hand-declared route. The key travels one way only: on success the
   * whole form is reset (so the browser keeps no copy), and the settings view is
   * rebuilt from `value.settings` so a judge route pointed at the new provider
   * shows up immediately.
   */
  const addProviderNow = useCallback((): void => {
    const invalid = providerFormInvalid(providerForm)
    if (invalid !== null) {
      setProviderOp({ status: 'error', code: 'settings_invalid', detail: invalid })
      return
    }
    const input: PanelProviderInput = {
      id: providerForm.id.trim(),
      ...(providerForm.displayName.trim().length === 0 ? {} : { displayName: providerForm.displayName.trim() }),
      api: providerForm.api,
      baseURL: providerForm.baseURL.trim(),
      apiKey: providerForm.apiKey,
      model: providerForm.model.trim(),
      ...(providerForm.modelName.trim().length === 0 ? {} : { modelName: providerForm.modelName.trim() }),
      useForJudge: providerForm.useForJudge,
    }
    setProviderOp({ status: 'adding' })
    void face.addProvider(input).then(
      (added) => {
        setView({ status: 'ready', data: toSettingsData(added.settings) })
        setProviderForm(EMPTY_PROVIDER_FORM)
        setProviderOp({ status: 'added', provider: added.provider, judgeRouteApplied: added.judgeRouteApplied })
        setSave({ status: 'idle' })
        onRefresh()
      },
      (error: unknown) => { setProviderOp({ status: 'error', code: codeOf(error) }) },
    )
  }, [face, onRefresh, providerForm])

  const deleteProviderNow = useCallback((id: string): void => {
    setConfirmDelete(null)
    setProviderOp({ status: 'deleting', id })
    void face.deleteProvider(id).then(
      (removed) => {
        setView({ status: 'ready', data: toSettingsData(removed.settings) })
        setProviderOp({ status: 'deleted', provider: removed.provider })
        setSave({ status: 'idle' })
        onRefresh()
      },
      (error: unknown) => { setProviderOp({ status: 'error', code: codeOf(error) }) },
    )
  }, [face, onRefresh])

  if (view.status === 'idle' || view.status === 'loading') {
    return <div className="shp-stack"><Card title="设置"><Loading text="正在读取评审与起草路由…" /></Card></div>
  }

  if (view.status === 'error') {
    const code = view.code
    const missing = code === 'unknown_endpoint' || code === 'panel_http_404' || code === 'not_found'
    return (
      <div className="shp-stack">
        <Card title="设置">
          <div className="shp-notice shp-notice-warn">
            <p className="shp-notice-title">{missing ? '当前服务端还没有 /settings 接口' : '读取设置失败'}</p>
            <p className="shp-notice-body">
              {missing
                ? '这是 1.7.0 新增的接口。当前运行的宿主仍在用旧的服务端构建：重建服务端并重启宿主后即可读写评审与起草路由。面板其他标签不受影响。'
                : settingsErrorMessage(code)}
            </p>
            <div className="shp-card-actions">
              <button type="button" className="shp-btn" onClick={retry}>重试</button>
              <code className="shp-mono">{code}</code>
            </div>
          </div>
        </Card>
      </div>
    )
  }

  if (data === undefined) {
    return <div className="shp-stack"><Card title="设置"><Loading text="正在读取评审与起草路由…" /></Card></div>
  }

  const { value, judge, draft, surfaces, inputJudge, toolDetection, pii, lists, source } = data
  const readOnly = !value.judge.configurable
  const saving = save.status === 'saving'
  // An invalid value is still an unsaved change: the bar must not claim "没有修改"
  // while a field is being refused, or the refusal reads as "there was nothing to do".
  const dirty = patchResult.patch !== undefined || patchResult.invalid !== null
  const providerOptions = providerOptionsFor(value.providers, judge.provider, '（未设置）', '使用宿主默认路由')
  const modelOptions = modelOptionsFor(value.providers, judge.provider, judge.model, '（未设置）', '使用宿主默认模型')
  const draftProviderOptions = providerOptionsFor(value.providers, draft.provider, '（跟随评审路由）', '留空即复用评审路由')
  const draftCatalogProvider = draft.provider.length > 0 ? draft.provider : judge.provider
  const draftModelOptions = modelOptionsFor(value.providers, draftCatalogProvider, draft.model, '（跟随评审路由）', '留空即复用评审路由')
  const judgeRoute = `${judge.provider.length > 0 ? judge.provider : '宿主默认'} / ${judge.model.length > 0 ? judge.model : '宿主默认'}`
  const providerConfigurable = value.providerConfigurable
  const customProviders = value.customProviders
  const providerAdding = providerOp.status === 'adding'
  const providerDeleting = providerOp.status === 'deleting'
  const providerBusy = providerAdding || providerDeleting
  const providerLocked = !providerConfigurable || providerBusy

  return (
    <div className="shp-stack">
      {readOnly ? (
        <div className="shp-notice shp-notice-warn">
          <p className="shp-notice-title">配置在本 profile 里是只读的</p>
          <p className="shp-notice-body">
            宿主没有暴露可写的 settings 服务，或本插件没有可编辑条目（judge.configurable = false）。下面显示当前路由，
            保存按钮已禁用。
            {value.configPath === null ? '' : ' 需要修改时，直接编辑 profile patch 后重启宿主。'}
          </p>
          {value.configPath === null ? null : (
            <div className="shp-card-actions">
              <code className="shp-mono">{value.configPath}</code>
              <CopyButton text={value.configPath} label="复制路径" />
            </div>
          )}
        </div>
      ) : null}

      <Card
        title="防护面"
        hint={`preset ${value.preset} · 关掉一面就只在该面不检测、不记账`}
        actions={<Badge tone="accent">逐面覆盖</Badge>}
      >
        <div className="shp-form-grid">
          <SelectField
            label="输入"
            value={surfaces.input}
            disabled={readOnly}
            onChange={(next) => { updateSurface({ input: toMode(next) }) }}
            options={MODE_OPTIONS}
            hint={MODE_MEANINGS.input ?? ''}
          />
          <SelectField
            label="工具调用"
            value={surfaces.tools}
            disabled={readOnly}
            onChange={(next) => { updateSurface({ tools: toMode(next) }) }}
            options={MODE_OPTIONS}
            hint={MODE_MEANINGS.tools ?? ''}
          />
          <SelectField
            label="工具结果"
            value={surfaces.results}
            disabled={readOnly}
            onChange={(next) => { updateSurface({ results: toMode(next) }) }}
            options={MODE_OPTIONS}
            hint={MODE_MEANINGS.results ?? ''}
          />
          <SelectField
            label="模型输出"
            value={surfaces.output}
            disabled={readOnly}
            onChange={(next) => { updateSurface({ output: toOutputMode(next) }) }}
            options={OUTPUT_MODE_OPTIONS}
            hint="强制拦截只在输出结束时裁决；流式预览会被缓冲"
          />
          <SelectField
            label="审批桥"
            value={surfaces.approval}
            disabled={readOnly}
            onChange={(next) => { updateSurface({ approval: toApprovalMode(next) }) }}
            options={APPROVAL_MODE_OPTIONS}
            hint="委派宿主 = 透传；插件策略 = 按本包的粗粒度规则裁决"
          />
        </div>
        <div className="shp-form-grid">
          <SelectField
            label="输入语义评审"
            value={inputJudge.mode}
            disabled={readOnly}
            onChange={(next) => {
              updateInputJudge({ mode: next === 'always' ? 'always' : next === 'off' ? 'off' : 'flagged' })
            }}
            options={[
              { value: 'flagged', label: '仅结构命中时评审（默认）' },
              { value: 'always', label: '每轮都评审（更贵）' },
              { value: 'off', label: '关闭' },
            ]}
            hint="复用上面的评审路由；每次评审多一次模型调用"
          />
        </div>
        <div className="shp-switch-row">
          <label className="shp-switch-label">
            <input
              type="checkbox"
              checked={inputJudge.failClosed}
              disabled={readOnly}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                updateInputJudge({ failClosed: event.target.checked })
              }}
            />
            评审无结论时拒绝（fail-closed）
          </label>
          <span className="shp-card-hint">关闭时保持结构规则的判定；开启后 judge 超时、空回复也会拒。</span>
        </div>
        <div className="shp-switch-row">
          <label className="shp-switch-label">
            <input
              type="checkbox"
              checked={inputJudge.normalize}
              disabled={readOnly}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                updateInputJudge({ normalize: event.target.checked })
              }}
            />
            匹配前清洗（NFKC / 零宽 / HTML 注释）
          </label>
          <span className="shp-card-hint">被清洗的输入在放行时会以清洗后的文本进入模型。</span>
        </div>
        <p className="shp-card-hint">
          这里的改动是逐字段覆盖：只写你动过的那几个字段，`preset` 保持原值；想整体切换用 profile 的 `preset`。
          关闭一面后该面不检测、不记账，其他面不受影响。
        </p>
      </Card>

      <Card
        title="工具与结果检测"
        hint="1.12.0：工具描述符、轨迹阈值、SQL 表白名单与 PII 类别"
        actions={(
          <>
            <Badge tone={toolDetection.descriptorScan === 'enforce' ? 'danger' : toolDetection.descriptorScan === 'warn' ? 'warn' : 'muted'}>
              描述符 {toolDetection.descriptorScan}
            </Badge>
            <Badge tone={pii.enabled ? 'accent' : 'muted'}>{pii.enabled ? `PII ${pii.classes.length} 类` : 'PII 关闭'}</Badge>
          </>
        )}
      >
        <div className="shp-form-grid">
          <SelectField
            label="工具描述符扫描"
            value={toolDetection.descriptorScan}
            disabled={readOnly}
            onChange={(next) => {
              updateToolDetection({ descriptorScan: next === 'enforce' ? 'enforce' : next === 'off' ? 'off' : 'warn' })
            }}
            options={[
              { value: 'warn', label: '仅告警（默认）' },
              { value: 'enforce', label: '命中即拒绝该调用' },
              { value: 'off', label: '关闭' },
            ]}
            hint="用注入规则扫工具名与描述；命中后每个会话记一次，enforce 时该工具的每次调用都被拒"
          />
          <Field
            label="重复失败阈值（0 = 关）"
            value={toolDetection.repeatedAttemptThreshold}
            inputMode="numeric"
            disabled={readOnly}
            onChange={(next) => { updateToolDetection({ repeatedAttemptThreshold: next }) }}
          />
          <Field
            label="熵阈值 bits/char（0 = 关）"
            value={toolDetection.entropyThreshold}
            inputMode="decimal"
            disabled={readOnly}
            onChange={(next) => { updateToolDetection({ entropyThreshold: next }) }}
          />
          <Field
            label="熵检测最短长度"
            value={toolDetection.entropyMinLength}
            inputMode="numeric"
            disabled={readOnly}
            onChange={(next) => { updateToolDetection({ entropyMinLength: next }) }}
          />
        </div>
        <Field
          label="SQL 表白名单（每行一个，留空 = 不限制）"
          value={toolDetection.allowedTables}
          multiline
          disabled={readOnly}
          onChange={(next) => { updateToolDetection({ allowedTables: next }) }}
        />
        <p className="shp-card-hint">
          白名单只作用于会被扫描的 SQL 参数（默认只扫能执行 SQL 的工具）；非白名单表的
          <code className="shp-mono"> SELECT </code> 会被拒，破坏性语句仍按危险 SQL 拒绝。
          这一格不是热更新字段：保存会重载插件。
        </p>
        <Field
          label="参数形状规则 tools.argSchemas（JSON 数组，留空 = 不限制）"
          value={toolDetection.argSchemas}
          multiline
          disabled={readOnly}
          placeholder={ARG_SCHEMAS_PLACEHOLDER}
          onChange={(next) => { updateToolDetection({ argSchemas: next }) }}
        />
        <p className="shp-card-hint">
          每一项是 <code className="shp-mono">{'{ name, tool, args }'}</code>：<code className="shp-mono">tool</code>
          是工具名 glob（<code className="shp-mono">*</code> 是唯一通配符），
          <code className="shp-mono">args</code> 里每个参数可写
          <code className="shp-mono">pattern</code> / <code className="shp-mono">enum</code> /
          <code className="shp-mono">minBytes</code> / <code className="shp-mono">maxBytes</code> /
          <code className="shp-mono">pathPrefix</code> / <code className="shp-mono">urlScheme</code> /
          <code className="shp-mono">commandAllowlist</code>。命中即拒（
          <code className="shp-mono">unauthorized_tool_argument</code>），账本只记参数哈希与长度。
          编不过的声明会在保存时被拒，**一个字节都不写**。这一格不是热更新字段：保存会重载插件。
        </p>
        <div className="shp-switch-row">
          <label className="shp-switch-label">
            <input
              type="checkbox"
              checked={pii.enabled}
              disabled={readOnly}
              onChange={(event: ChangeEvent<HTMLInputElement>) => { updatePii({ enabled: event.target.checked }) }}
            />
            工具结果里扫描 PII（内核 10 类）
          </label>
          <span className="shp-card-hint">只产生 `pii` 类别的事件；要拦截需在 profile 里把 `pii` 加进 `results.blockOn`。</span>
        </div>
        <div className="shp-chips">
          {PII_CLASS_LABELS.map(({ name, label }) => (
            <label key={name} className="shp-chip" title={name}>
              <input
                type="checkbox"
                checked={pii.classes.includes(name)}
                disabled={readOnly || !pii.enabled}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  const next = event.target.checked
                    ? [...pii.classes, name]
                    : pii.classes.filter((entry) => entry !== name)
                  updatePii({ classes: next })
                }}
              />
              {label}
            </label>
          ))}
        </div>
        <p className="shp-card-hint">
          类别与内核 <code className="shp-mono">memory/sanitizer.py</code> 逐条对应；检测结果只记类别名，不记命中内容。
        </p>
      </Card>

      <Card
        title="列表与匹配"
        hint="1.13.0：黑白名单、标签覆盖、拦截类别与规则/巡检参数"
        actions={<Badge tone="accent">保存会重载插件</Badge>}
      >
        <div className="shp-form-grid">
          <Field
            label="必拒工具（每行一个 glob，`*` 通配）"
            value={lists.denyTools}
            multiline
            disabled={readOnly}
            onChange={(next) => { updateList({ denyTools: next }) }}
          />
          <Field
            label="需审批工具（每行一个 glob）"
            value={lists.askTools}
            multiline
            disabled={readOnly}
            onChange={(next) => { updateList({ askTools: next }) }}
          />
          <Field
            label="允许一次（每行一个 glob）"
            value={lists.allowOnce}
            multiline
            disabled={readOnly}
            onChange={(next) => { updateList({ allowOnce: next }) }}
          />
          <Field
            label="必拒标签（每行一个，如 shell / egress）"
            value={lists.denyTags}
            multiline
            disabled={readOnly}
            onChange={(next) => { updateList({ denyTags: next }) }}
          />
        </div>
        <Field
          label="工具名 → 标签覆盖（每行 `pattern: tag1, tag2`，# 开头为注释）"
          value={lists.tagOverrides}
          multiline
          disabled={readOnly}
          onChange={(next) => { updateList({ tagOverrides: next }) }}
        />
        <div className="shp-field">
          <span className="shp-field-label">工具结果在强制拦截时拦哪些类别（results.blockOn）</span>
          <div className="shp-chips">
            {RESULT_CATEGORY_LABELS.map(({ name, label }) => (
              <label key={name} className="shp-chip" title={name}>
                <input
                  type="checkbox"
                  checked={lists.blockOn.includes(name)}
                  disabled={readOnly}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => {
                    const next = event.target.checked
                      ? [...lists.blockOn, name]
                      : lists.blockOn.filter((entry) => entry !== name)
                    updateList({ blockOn: next })
                  }}
                />
                {label}
              </label>
            ))}
          </div>
          <span className="shp-field-hint">
            只影响 `工具结果 = 强制拦截` 时的裁决；空 = 不拦任何类别（只记事件）。
          </span>
        </div>
        <div className="shp-form-grid">
          <Field
            label="额外规则目录（空 = 只用包内规则）"
            value={source.rulesDir}
            disabled={readOnly}
            onChange={(next) => { updateSource({ rulesDir: next }) }}
          />
          <Field
            label="巡检窗口（分钟）"
            value={source.patrolWindowMinutes}
            inputMode="numeric"
            disabled={readOnly}
            onChange={(next) => { updateSource({ patrolWindowMinutes: next }) }}
          />
          <Field
            label="速率倍数"
            value={source.patrolFactor}
            inputMode="decimal"
            disabled={readOnly}
            onChange={(next) => { updateSource({ patrolFactor: next }) }}
          />
          <Field
            label="最少拒绝数"
            value={source.patrolMinCount}
            inputMode="numeric"
            disabled={readOnly}
            onChange={(next) => { updateSource({ patrolMinCount: next }) }}
          />
        </div>
        <div className="shp-switch-row">
          <label className="shp-switch-label">
            <input
              type="checkbox"
              checked={source.rulesWatch}
              disabled={readOnly}
              onChange={(event: ChangeEvent<HTMLInputElement>) => { updateSource({ rulesWatch: event.target.checked }) }}
            />
            规则文件变化时自动重编译
          </label>
          <span className="shp-card-hint">关闭后新增/修改规则要重启插件才生效。</span>
        </div>
        <p className="shp-card-hint">
          这些字段都不是宿主的热更新字段：保存会改写 profile patch，宿主重载本插件（正在跑的会话不受影响，下一条调用即用新配置）。
          写前按现有语法校验（glob 单行、标签标识符、类别白名单、数值范围），失败一个字节都不写。
        </p>
      </Card>

      <Card
        title="只读配置"
        hint="阶段三：这些只能在 profile patch 里改，这里只显示"
        actions={<Badge tone="muted">只读</Badge>}
      >
        <div className="shp-facts">
          <div className="shp-fact">
            <span className="shp-fact-label">输入引擎</span>
            <code className="shp-mono">{value.facts.engine.kind}{value.facts.engine.command.length === 0 ? '' : ` · ${value.facts.engine.command}`}</code>
          </div>
          <div className="shp-fact">
            <span className="shp-fact-label">规则来源</span>
            <code className="shp-mono">内联 {value.facts.rules.inlineRules} 条 · 文件 {value.facts.rules.sources} 份</code>
          </div>
          <div className="shp-fact">
            <span className="shp-fact-label">账本</span>
            <code className="shp-mono">
              {value.facts.audit.format} · {value.facts.audit.dir.length === 0 ? '默认目录' : value.facts.audit.dir} · 轮转{' '}
              {value.facts.audit.rotateMb} MB · {value.facts.audit.required ? '写入失败即拒' : '写入失败仍放行'}
            </code>
          </div>
          <div className="shp-fact">
            <span className="shp-fact-label">加载闸门</span>
            <code className="shp-mono">
              {value.facts.posture.failOn.length === 0
                ? '姿态 FAIL 不阻止加载'
                : `FAIL 即拒绝加载：${value.facts.posture.failOn.join(', ')}`}
            </code>
          </div>
          <div className="shp-fact">
            <span className="shp-fact-label">巡检通知</span>
            <code className="shp-mono">
              {value.facts.patrolNotify.channels.length === 0
                ? '未配置通道'
                : `${value.facts.patrolNotify.channels.join(' / ')} · ${value.facts.patrolNotify.channels.length} 个通道`}
              {value.facts.patrolNotify.healthUrls > 0 ? ` · 探针 ${value.facts.patrolNotify.healthUrls} 个` : ''}
            </code>
          </div>
        </div>
        <p className="shp-card-hint">
          通知只显示通道类型与数量，webhook / token 永不回显。要改这些值：编辑 profile patch 的
          <code className="shp-mono"> id: safeharness → config </code>
          段后重启。
        </p>
        {value.configPath === null ? null : (
          <div className="shp-card-actions">
            <code className="shp-mono">{value.configPath}</code>
            <CopyButton text={value.configPath} label="复制路径" />
          </div>
        )}
      </Card>

      <Card
        title="语义评审"
        hint={`preset ${value.preset} · 关闭后只做结构规则判定`}
        actions={(
          <>
            <Badge tone={judge.enabled ? 'ok' : 'muted'}>{judge.enabled ? '已启用' : '已关闭'}</Badge>
            <Badge tone={value.judge.available ? 'accent' : 'warn'}>{value.judge.available ? 'llm 可用' : '本 profile 无 llm'}</Badge>
          </>
        )}
      >
        <div className="shp-switch-row">
          <label className="shp-switch-label">
            <input
              type="checkbox"
              checked={judge.enabled}
              disabled={readOnly}
              onChange={(event: ChangeEvent<HTMLInputElement>) => { updateJudge({ enabled: event.target.checked }) }}
            />
            启用语义评审
          </label>
          <span className="shp-card-hint">评审是额外的一次模型调用；关闭后不会产生这笔开销。</span>
        </div>
        <div className="shp-form-grid">
          <SelectField
            label="评审范围"
            value={judge.scope}
            disabled={readOnly}
            onChange={(next) => { updateJudge({ scope: next === 'always' ? 'always' : 'flagged' }) }}
            options={[
              { value: 'flagged', label: '只评审已标记输出（默认）' },
              { value: 'always', label: '评审全部输出（更贵）' },
            ]}
          />
          <Picker
            label="供应方"
            value={judge.provider}
            options={providerOptions}
            disabled={readOnly}
            onChange={(id) => {
              const next = value.providers.find(provider => provider.id === id)
              const keep = next?.models.some(model => model.id === judge.model) === true
              updateJudge({ provider: id, model: keep ? judge.model : '' })
            }}
          />
          <Picker
            label="模型"
            value={judge.model}
            options={modelOptions}
            disabled={readOnly}
            onChange={(id) => { updateJudge({ model: id }) }}
          />
          <Field
            label="送入评审的最大字符数"
            value={judge.maxChars}
            inputMode="numeric"
            disabled={readOnly}
            onChange={(next) => { updateJudge({ maxChars: next }) }}
          />
          <Field
            label="评审超时（毫秒）"
            value={judge.timeoutMs}
            inputMode="numeric"
            disabled={readOnly}
            onChange={(next) => { updateJudge({ timeoutMs: next }) }}
          />
          <div className="shp-field">
            <span className="shp-field-label">当前路由</span>
            <span className="shp-route">
              <code className="shp-mono">{judgeRoute}</code>
              {value.judge.available ? null : <Badge tone="warn">探测会报 judge_unavailable</Badge>}
            </span>
          </div>
        </div>
        <div className="shp-probe-row">
          <button type="button" className="shp-btn" onClick={runProbe} disabled={probe.status === 'running' || readOnly}>
            {probe.status === 'running' ? '测试中…' : '测试连接'}
          </button>
          {probe.status === 'done' ? (
            <span className="shp-probe shp-num">
              <Badge tone={probeTone(probe.probe.status)}>{probe.probe.status}</Badge>
              <span>{probe.probe.route}</span>
              <span>{probe.probe.elapsedMs} ms</span>
              <code className="shp-mono">verdict {probe.probe.verdict}{probe.probe.blocked ? ' · 判定拦截' : ''}</code>
            </span>
          ) : null}
          {probe.status === 'error' ? <span className="shp-line-error" role="alert">{settingsErrorMessage(probe.code)}</span> : null}
          {probe.status === 'idle' ? <span className="shp-hint">发送一次最小的结构化请求；只回报状态与耗时，不显示模型回复。</span> : null}
        </div>
        <p className="shp-card-hint">
          路由留空表示使用宿主默认。保存后宿主的热更新会立即使用新路由，不需要重启。
        </p>
      </Card>

      <Card
        title="规则起草路由"
        hint={draftFact.enabled ? `草稿功能已启用 · 描述上限 ${draftFact.maxChars} 字` : '草稿功能未启用（config `draft.enabled`）'}
      >
        <div className="shp-form-grid">
          <Picker
            label="供应方"
            value={draft.provider}
            options={draftProviderOptions}
            disabled={readOnly}
            onChange={(id) => {
              const next = value.providers.find(provider => provider.id === id)
              const keep = next?.models.some(model => model.id === draft.model) === true
              updateDraft({ provider: id, model: keep ? draft.model : '' })
            }}
          />
          <Picker
            label="模型"
            value={draft.model}
            options={draftModelOptions}
            disabled={readOnly}
            onChange={(id) => { updateDraft({ model: id }) }}
          />
        </div>
        <p className="shp-card-hint">
          留空跟随评审路由（当前 {judgeRoute}）。启用开关在 profile 配置 <code className="shp-mono">draft.enabled</code>，面板不写入该项。
        </p>
      </Card>

      <Card
        title="自定义模型"
        hint="把手写的 OpenAI 兼容 / Anthropic 路由加进 pi-ai；key 只写不读"
        actions={<Badge tone={providerConfigurable ? 'accent' : 'muted'}>{providerConfigurable ? '可增删' : '只读'}</Badge>}
      >
        {providerConfigurable ? null : (
          <div className="shp-notice shp-notice-warn">
            <p className="shp-notice-title">不能在这里增删路由</p>
            <p className="shp-notice-body">
              providerConfigurable = false：宿主没有暴露可写的 <code className="shp-mono">@deepseek-ai/dsh-llm-pi-ai</code> 条目，
              或本 profile 没有可写的凭据服务。下面只读展示已添加的路由。
            </p>
          </div>
        )}

        <div className="shp-form-grid">
          <Field
            label="路由 id"
            value={providerForm.id}
            placeholder="my-gateway"
            disabled={providerLocked}
            hint="[a-z][a-z0-9-]{1,39}"
            onChange={(next) => { updateProvider({ id: next }) }}
          />
          <Field
            label="显示名称"
            value={providerForm.displayName}
            placeholder="留空 = 路由 id"
            disabled={providerLocked}
            onChange={(next) => { updateProvider({ displayName: next }) }}
          />
          <SelectField
            label="协议"
            value={providerForm.api}
            options={PROVIDER_PROTOCOL_OPTIONS}
            disabled={providerLocked}
            onChange={(next) => { updateProvider({ api: next as PanelProviderProtocol }) }}
          />
          <Field
            label="Base URL"
            value={providerForm.baseURL}
            placeholder="https://api.example.com/v1"
            disabled={providerLocked}
            hint="http(s) 绝对地址，不能带用户名 / 密码"
            onChange={(next) => { updateProvider({ baseURL: next }) }}
          />
          <Field
            label="API key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={providerForm.apiKey}
            placeholder="只写：保存后不再显示"
            disabled={providerLocked}
            hint="写入宿主凭据服务；面板不回读、不回显"
            onChange={(next) => { updateProvider({ apiKey: next }) }}
          />
          <Field
            label="模型 id"
            value={providerForm.model}
            placeholder="fake-model"
            disabled={providerLocked}
            onChange={(next) => { updateProvider({ model: next }) }}
          />
          <Field
            label="模型名称"
            value={providerForm.modelName}
            placeholder="留空 = 模型 id"
            disabled={providerLocked}
            onChange={(next) => { updateProvider({ modelName: next }) }}
          />
        </div>

        <div className="shp-switch-row">
          <label className="shp-switch-label">
            <input
              type="checkbox"
              checked={providerForm.useForJudge}
              disabled={providerLocked}
              onChange={(event: ChangeEvent<HTMLInputElement>) => { updateProvider({ useForJudge: event.target.checked }) }}
            />
            添加后设为评审模型
          </label>
          <span className="shp-card-hint">勾选会同时启用语义评审并指向新路由；之后可以在上面的评审卡片里改回。</span>
        </div>

        <div className="shp-card-actions">
          <button type="button" className="shp-btn shp-btn-primary" onClick={addProviderNow} disabled={providerLocked}>
            {providerAdding ? '添加中…' : '添加路由'}
          </button>
          <button type="button" className="shp-btn" onClick={resetProviderForm} disabled={providerBusy}>清空</button>
          {providerOp.status === 'added' ? (
            <span className="shp-line-ok" role="status">
              已添加 <code className="shp-mono">{providerOp.provider.id}</code>
              {providerOp.judgeRouteApplied ? '，评审已指向它。' : '；评审未指向它（可在评审卡片里手动选）。'}
            </span>
          ) : null}
          {providerOp.status === 'deleted' ? (
            <span className="shp-line-ok" role="status">
              已删除 <code className="shp-mono">{providerOp.provider.id}</code> 及其凭据。
            </span>
          ) : null}
          {providerOp.status === 'error' ? (
            <span className="shp-line-error" role="alert">{providerOp.detail ?? providerErrorMessage(providerOp.code)}</span>
          ) : null}
        </div>

        <div>
          <div className="shp-card-head">
            <h4 className="shp-card-title">已添加的路由</h4>
            <span className="shp-card-hint">
              {customProviders.length === 0 ? '还没有通过面板添加的路由' : `${customProviders.length} 个`}
            </span>
          </div>
          {customProviders.length === 0 ? (
            <EmptyState
              title="自定义路由列表是空的"
              body="用上面的表单加一个 OpenAI 兼容或 Anthropic 兼容路由：它写进 pi-ai 配置，key 写进宿主凭据服务，删除时一并移除。"
            />
          ) : (
            <ul className="shp-list">
              {customProviders.map(provider => (
                <li key={provider.id} className="shp-provider-row">
                  <div className="shp-provider-main">
                    <span className="shp-inline">
                      <strong>{provider.displayName}</strong>
                      <code className="shp-mono">{provider.id}</code>
                    </span>
                    <span className="shp-provider-meta">
                      <Badge tone="muted">{provider.api}</Badge>
                      <code className="shp-mono">{provider.baseURL}</code>
                    </span>
                    <span className="shp-provider-meta">
                      模型 {provider.models.length > 0 ? provider.models.join(' · ') : '—'} · 添加于 {formatEpoch(provider.addedAt)}
                    </span>
                  </div>
                  <div className="shp-card-actions">
                    {confirmDelete === provider.id ? (
                      <>
                        <span className="shp-hint">确认删除该路由及其凭据？</span>
                        <button
                          type="button"
                          className="shp-btn shp-btn-sm"
                          onClick={() => { deleteProviderNow(provider.id) }}
                          disabled={providerBusy}
                        >
                          {providerDeleting ? '删除中…' : '确认删除'}
                        </button>
                        <button type="button" className="shp-btn shp-btn-sm" onClick={() => { setConfirmDelete(null) }}>取消</button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="shp-btn shp-btn-sm"
                        onClick={() => { setConfirmDelete(provider.id) }}
                        disabled={providerLocked}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="shp-card-hint">
          删除正在被评审或起草使用的路由会被拒绝（provider_in_use）；先在评审卡片里换掉再删。
          添加 / 删除会立即写 profile 配置，不需要重启。
        </p>
      </Card>

      <div className="shp-savebar">
        <span className={dirty ? 'shp-dirty' : 'shp-hint'}>{dirty ? '有未保存的修改' : '没有修改'}</span>
        <span className="shp-spacer" />
        {save.status === 'saved' ? <span className="shp-line-ok" role="status">已保存</span> : null}
        {save.status === 'error' ? <span className="shp-line-error" role="alert">{settingsErrorMessage(save.code)}</span> : null}
        {/* The reason a save is refused belongs next to the button, not below the bar:
            an invalid value used to render its alert under the fold and read as
            "没有修改" with a save button that never lit up. */}
        {patchResult.invalid === null ? null : <span className="shp-line-error" role="alert">{patchResult.invalid}</span>}
        <button type="button" className="shp-btn" onClick={resetForm} disabled={!dirty || saving}>还原</button>
        <button
          type="button"
          className="shp-btn shp-btn-primary"
          onClick={saveNow}
          disabled={!dirty || patchResult.invalid !== null || readOnly || saving}
          title={readOnly
            ? '本 profile 里配置是只读的'
            : patchResult.invalid !== null ? '有字段不合法：先按提示修正' : undefined}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
      {readOnly ? null : (
        <p className="shp-card-hint">
          保存写入 profile 配置{value.configPath === null ? '' : <>：<code className="shp-mono">{value.configPath}</code></>}
          。只提交改动过的字段，宿主校验失败时不会写入。
        </p>
      )}
    </div>
  )
}

/** The tab body. */
export function SafeHarnessPanel(props: SafeHarnessPanelProps): ReactNode {
  const {
    load, patrol, draft, schedule, reloadRules, writeRule, ruleHistory, rollbackRule, loadSettings, saveSettings,
    addProvider, deleteProvider, probeJudge, exportLedger,
  } = props
  const face = useMemo<PanelFace>(() => ({
    load, patrol, draft, schedule, reloadRules, writeRule, ruleHistory, rollbackRule, loadSettings, saveSettings,
    addProvider, deleteProvider, probeJudge, exportLedger,
  }), [
    load, patrol, draft, schedule, reloadRules, writeRule, ruleHistory, rollbackRule, loadSettings, saveSettings,
    addProvider, deleteProvider, probeJudge, exportLedger,
  ])

  const [view, setView] = useState<View>({ status: 'loading' })
  const [request, setRequest] = useState(0)
  const [busy, setBusy] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  // Remembered across a Host remount (a settings write hot-reloads the plugin):
  // losing the active tab would drop the operator on the overview mid-task.
  const [tab, setTabState] = useState<Tab>(readStoredTab)
  const setTab = useCallback((next: Tab): void => {
    setTabState(next)
    storeValue(TAB_KEY, next)
  }, [])
  // Owned here (not inside EventsTab) for two reasons: a session row on the
  // overview can set it, and a payload refresh must never reset it.
  const [filter, setFilter] = useState<EventFilter>({ ...EMPTY_FILTER })

  useEffect(() => {
    let current = true
    setBusy(true)
    void load().then(
      (payload) => {
        if (!current) return
        setView({ status: 'ready', payload })
        setRefreshError(null)
        setBusy(false)
      },
      (error: unknown) => {
        if (!current) return
        setBusy(false)
        const code = codeOf(error)
        setRefreshError(code)
        setView(previous => previous.status === 'ready' ? previous : { status: 'error', code })
      },
    )
    return () => { current = false }
  }, [load, request])

  const refresh = useCallback((): void => { setRequest(current => current + 1) }, [])

  const jumpToSession = useCallback((session: string | undefined): void => {
    setFilter(session === undefined ? { ...EMPTY_FILTER } : { ...EMPTY_FILTER, session })
    setTab('events')
  }, [])

  if (view.status === 'loading') {
    return <Root><Loading text="正在读取 SafeHarness 状态…" /></Root>
  }

  if (view.status === 'error') {
    return (
      <Root>
        <div className="shp-card">
          <div className="shp-notice shp-notice-warn">
            <p className="shp-notice-title">读取状态失败</p>
            <p className="shp-notice-body">
              插件可能未加载，或本 profile 没有 Web 传输通道。面板本身不显示任何内容，只读取账本摘要。
            </p>
            <div className="shp-card-actions">
              <button type="button" className="shp-btn" onClick={() => { setView({ status: 'loading' }); refresh() }}>重试</button>
              <code className="shp-mono">{view.code}</code>
            </div>
          </div>
        </div>
      </Root>
    )
  }

  const { payload } = view
  const tabs: readonly { readonly id: Tab; readonly label: string; readonly count?: number }[] = [
    { id: 'overview', label: '概览' },
    { id: 'events', label: '事件', count: payload.recentEvents.length },
    { id: 'rules', label: '规则', count: payload.rules.count + payload.rules.chains },
    { id: 'patrol', label: '巡检' },
    { id: 'settings', label: '设置' },
  ]

  return (
    <Root>
      <header className="shp-header">
        <span className="shp-mark" aria-hidden="true">SH</span>
        <div className="shp-headings">
          <h3 className="shp-title">SafeHarness 安全面</h3>
          <span className="shp-subtitle">只显示代码、名称、哈希与计数；不显示提示文本、工具参数或模型输出。</span>
        </div>
        <div className="shp-pills">
          <span className="shp-pill">v{payload.version}</span>
          <span className="shp-pill shp-pill-strong">{payload.preset}</span>
          <span className="shp-live"><span className="shp-live-dot" aria-hidden="true" />已运行 {formatUptime(payload.uptimeMs)}</span>
        </div>
        <span className="shp-spacer" />
        <button type="button" className="shp-btn" onClick={refresh} disabled={busy}>
          {busy ? '刷新中…' : '刷新'}
        </button>
      </header>

      {refreshError === null ? null : (
        <div className="shp-filterbar" style={{ marginBottom: '12px' }}>
          <span className="shp-line-error" role="alert">刷新失败（{refreshError}），下面仍是上一次成功读取的数据。</span>
          <span className="shp-spacer" />
          <button type="button" className="shp-btn shp-btn-sm" onClick={refresh}>重试</button>
        </div>
      )}

      <div className="shp-tabs" role="tablist">
        {tabs.map(entry => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={tab === entry.id ? 'shp-tab shp-tab-active' : 'shp-tab'}
            onClick={() => { setTab(entry.id) }}
          >
            {entry.label}
            {entry.count === undefined ? null : <span className="shp-tab-count">{entry.count}</span>}
          </button>
        ))}
      </div>

      {/* All five panes stay mounted: drafts, filters, patrol results and the
          settings form must survive a tab switch (inactive = display:none). */}
      <div className="shp-pane" role="tabpanel" style={{ display: tab === 'overview' ? 'flex' : 'none' }}>
        <OverviewTab payload={payload} onJump={jumpToSession} exportLedger={exportLedger} />
      </div>
      <div className="shp-pane" role="tabpanel" style={{ display: tab === 'events' ? 'flex' : 'none' }}>
        <EventsTab payload={payload} filter={filter} onFilter={setFilter} />
      </div>
      <div className="shp-pane" role="tabpanel" style={{ display: tab === 'rules' ? 'flex' : 'none' }}>
        <RulesTab payload={payload} face={face} onRefresh={refresh} />
      </div>
      <div className="shp-pane" role="tabpanel" style={{ display: tab === 'patrol' ? 'flex' : 'none' }}>
        <PatrolTab payload={payload} face={face} onRefresh={refresh} />
      </div>
      <div className="shp-pane" role="tabpanel" style={{ display: tab === 'settings' ? 'flex' : 'none' }}>
        <SettingsTab face={face} active={tab === 'settings'} draftFact={payload.draft} onRefresh={refresh} />
      </div>

      <footer className="shp-footer">
        <span>读取于 {formatTime(payload.generatedAt)}</span>
        <span>·</span>
        <span>动作只有：运行巡检、定时设置、起草规则（不自动生效）、重新加载规则、保存评审 / 起草路由</span>
      </footer>
    </Root>
  )
}
