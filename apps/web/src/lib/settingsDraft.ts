// settingsDraft.ts — 设置草稿模型纯函数（settings center spec §3/§4，Task 2/3）。
// 无 runes 的纯 .ts 模块（vitest 直测）：深拷贝/序列化/parse+白名单镜像校验/脏态/
// 提交/导入合并与替换/导出文件构造与导入解析/导入变更摘要/草稿变更合并
// （mergeDraftOnto——I-2 复活路径防护）。UI（SettingsCenter.svelte）
// 持有 draft（$state 深代理）并统一在「应用」时走 commit → saveSettings 集中订阅链。
//
// 校验语义 = loadSettings 白名单的镜像（spec §3：未知字段标红不静默丢弃、类型不
// 符标红、clamp 类越界提示将截断）——归一化实现复用 settings.normalizeSettings
// （同一白名单单源），此处只负责「报告」；三类问题同为阻断错误（校验失败不部分
// 应用，spec §4 导入同纪律），修复后应用时经 normalizeSettings 规范化落值。
import { resolveDiagramType } from '@vviewer/render-text/markdown/diagrams';
import { clampSize, CODE_SIZE_RANGE, normalizeSettings, saveSettings, UI_SIZE_RANGE, type Settings } from './stores/settings';
import { sanitizeLayout } from './layout';

/** 校验问题（field 为顶层字段名或 `节.字段` 点径；'' = JSON 整体语法/形态错误） */
export interface SettingsIssue {
  field: string;
  message: string;
}

/** Draft = Settings 的深拷贝语义别名（独立类型仅作文档；隔离由 openDraft 保证） */
export type Draft = Settings;

export type JsonApplyResult = { ok: true } | { ok: false; errors: SettingsIssue[] };

/** 已知顶层字段（白名单；未新增字段——layout/diagrams/fonts 均已在库） */
const SETTINGS_KEYS: readonly (keyof Settings)[] = [
  'themeMode',
  'appearanceLight',
  'appearanceDark',
  'codeThemeLight',
  'codeThemeDark',
  'excludedPatterns',
  'autoRefresh',
  'computePolicy',
  'diagrams',
  'fonts',
  'layout'
];

/** 白名单拣选（L1 顺手项）：导入路径只取已知键——normalizeSettings 对未知键原样
 * 透传（loadSettings 历史行为），不拣选会让导入文件的自造字段落进 localStorage。 */
function pickKnown(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SETTINGS_KEYS) {
    if (k in raw) out[k] = raw[k];
  }
  return out;
}

const THEME_MODES: readonly string[] = ['light', 'dark', 'system'];
const POLICIES: readonly string[] = ['auto', 'local', 'remote'];
const DIAGRAM_MODES: readonly string[] = ['local', 'kroki', 'server', 'source'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON 值深拷贝（Settings 全形为纯 JSON 值；$state 代理读入即解包） */
function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 打开草稿（spec §3：深拷贝生效 settings——此后两视图只改 draft） */
export function openDraft(settings: Settings): Draft {
  return deepClone(settings);
}

/** 序列化（表单 → JSON 视图）：格式化输出（2 空格缩进），spec §3「即格式化」 */
export function draftToJson(draft: Draft): string {
  return JSON.stringify(draft, null, 2);
}

/**
 * JSON 文本 position → 行号（1 起；V8 新版错误信息不一定携带 position，
 * 携带时 UI 拼行号提示——spec §3「错误含行号提示」的纯函数部分）
 */
export function jsonLineOf(text: string, position: number): number {
  const upto = text.slice(0, Math.max(0, Math.min(position, text.length)));
  return upto.split('\n').length;
}

// ---------- 白名单镜像校验（报告层；归一化在 settings.normalizeSettings） ----------

function appearanceFormatOk(v: unknown): boolean {
  return typeof v === 'string' && (v === 'default' || v.startsWith('vscode:') || v.startsWith('imported:'));
}

/** clamp 类数值检查：范围内（含四舍五入可入界的小数）合法；越界报目标截断值 */
function checkClampedNumber(issues: SettingsIssue[], field: string, v: unknown, range: readonly [number, number] | readonly number[]): void {
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    issues.push({ field, message: '应为数字' });
    return;
  }
  const rounded = Math.round(v);
  const clamped = Math.min(range[1]!, Math.max(range[0]!, rounded));
  if (clamped !== rounded) {
    issues.push({ field, message: `超出范围 ${range[0]}–${range[1]}，将截断为 ${clamped}` });
  }
}

/**
 * 白名单镜像校验（spec §3）：未知字段/类型不符/clamp 越界三类问题全量收集，
 * 供 JSON 视图与导入对话框标红。与 normalizeSettings 的「静默归位」互补：
 * 本函数回答「哪里不合法」，normalizeSettings 回答「合法值如何落」。
 */
export function validateSettings(raw: unknown): SettingsIssue[] {
  if (!isObj(raw)) return [{ field: '', message: '设置 JSON 必须是对象' }];
  const issues: SettingsIssue[] = [];
  for (const k of Object.keys(raw)) {
    if (!SETTINGS_KEYS.includes(k as keyof Settings)) issues.push({ field: k, message: '未知字段（白名单外，不落盘）' });
  }
  if (raw.themeMode !== undefined && !THEME_MODES.includes(raw.themeMode as string)) {
    issues.push({ field: 'themeMode', message: `须为 ${THEME_MODES.join(' / ')} 之一` });
  }
  for (const slot of ['appearanceLight', 'appearanceDark'] as const) {
    if (raw[slot] !== undefined && !appearanceFormatOk(raw[slot])) {
      issues.push({ field: slot, message: "须为 'default'、'vscode:内置名' 或 'imported:<id>' 形态" });
    }
  }
  for (const slot of ['codeThemeLight', 'codeThemeDark'] as const) {
    if (raw[slot] !== undefined && typeof raw[slot] !== 'string') {
      issues.push({ field: slot, message: '应为字符串（主题键名）' });
    }
  }
  if (raw.excludedPatterns !== undefined) {
    if (!Array.isArray(raw.excludedPatterns) || !raw.excludedPatterns.every((p) => typeof p === 'string')) {
      issues.push({ field: 'excludedPatterns', message: '应为字符串数组' });
    }
  }
  if (raw.autoRefresh !== undefined && typeof raw.autoRefresh !== 'boolean') {
    issues.push({ field: 'autoRefresh', message: '应为布尔值' });
  }
  if (raw.computePolicy !== undefined && !POLICIES.includes(raw.computePolicy as string)) {
    issues.push({ field: 'computePolicy', message: `须为 ${POLICIES.join(' / ')} 之一` });
  }
  if (raw.diagrams !== undefined) {
    if (!isObj(raw.diagrams)) {
      issues.push({ field: 'diagrams', message: '应为对象' });
    } else {
      const d = raw.diagrams;
      for (const k of Object.keys(d)) {
        if (k !== 'krokiHost' && k !== 'krokiVia' && k !== 'modes') issues.push({ field: `diagrams.${k}`, message: '未知字段（白名单外，不落盘）' });
      }
      if (d.krokiHost !== undefined && d.krokiHost !== '' && !(typeof d.krokiHost === 'string' && /^https?:\/\//.test(d.krokiHost))) {
        issues.push({ field: 'diagrams.krokiHost', message: '须为 http(s):// 开头地址或空串（空 = 默认服务）' });
      }
      if (d.krokiVia !== undefined && d.krokiVia !== 'client' && d.krokiVia !== 'server') {
        issues.push({ field: 'diagrams.krokiVia', message: "须为 'client' / 'server' 之一（client=前端直连，server=服务端代发）" });
      }
      if (d.modes !== undefined) {
        if (!isObj(d.modes)) {
          issues.push({ field: 'diagrams.modes', message: '应为对象' });
        } else {
          for (const [k, v] of Object.entries(d.modes)) {
            if (!resolveDiagramType(k)) issues.push({ field: `diagrams.modes.${k}`, message: '未知图表类型（注册表外）' });
            else if (!DIAGRAM_MODES.includes(v as string)) {
              issues.push({ field: `diagrams.modes.${k}`, message: `渲染模式须为 ${DIAGRAM_MODES.join(' / ')} 之一` });
            }
          }
        }
      }
    }
  }
  if (raw.fonts !== undefined) {
    if (!isObj(raw.fonts)) {
      issues.push({ field: 'fonts', message: '应为对象' });
    } else {
      const f = raw.fonts;
      for (const k of Object.keys(f)) {
        if (k !== 'uiFamily' && k !== 'uiSize' && k !== 'codeFamily' && k !== 'codeSize') {
          issues.push({ field: `fonts.${k}`, message: '未知字段（白名单外，不落盘）' });
        }
      }
      for (const fam of ['uiFamily', 'codeFamily'] as const) {
        if (f[fam] !== undefined && typeof f[fam] !== 'string') issues.push({ field: `fonts.${fam}`, message: '应为字符串（family 栈，空串 = 默认栈）' });
      }
      checkClampedNumber(issues, 'fonts.uiSize', f.uiSize, UI_SIZE_RANGE);
      checkClampedNumber(issues, 'fonts.codeSize', f.codeSize, CODE_SIZE_RANGE);
    }
  }
  if (raw.layout !== undefined) {
    if (!isObj(raw.layout)) {
      issues.push({ field: 'layout', message: '应为对象' });
    } else {
      const l = raw.layout;
      const sanitized = sanitizeLayout(l);
      for (const k of Object.keys(l)) {
        if (!(k in sanitized)) {
          issues.push({ field: `layout.${k}`, message: '未知字段（白名单外，不落盘）' });
        } else if (sanitized[k as keyof typeof sanitized] !== l[k]) {
          // 归位/夹紧差异 = 布尔脏值或宽度越界（clamp 类），报目标值
          issues.push({ field: `layout.${k}`, message: `非法或越界，将修正为 ${JSON.stringify(sanitized[k as keyof typeof sanitized])}` });
        }
      }
    }
  }
  return issues;
}

/**
 * 应用 JSON 文本到 draft（spec §3：parse+校验，非法返回错误不部分应用）。
 * 成功 = 白名单规范化整体写回 draft（缺项字段补默认——JSON 视图为完整文档编辑）。
 */
export function applyJson(draft: Draft, text: string): JsonApplyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const m = /position\s+(\d+)/i.exec(msg);
    const at = m ? `（第 ${jsonLineOf(text, Number(m[1]))} 行附近）` : '';
    return { ok: false, errors: [{ field: '', message: `JSON 语法错误${at}：${msg}` }] };
  }
  const issues = validateSettings(parsed);
  if (issues.length > 0) return { ok: false, errors: issues };
  Object.assign(draft, normalizeSettings(parsed as Record<string, unknown>));
  return { ok: true };
}

/** 稳定序列化（键序无关的深度比较——draft 与 applied 的来源路径键序一致，但
 * 不苛求；clamp 后 13.7/14 之类数值以字面比较） */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** 脏态（spec §3）：draft 与最近应用值深度不等即脏（键序无关） */
export function isDirty(draft: Draft, settings: Settings): boolean {
  return stableStringify(draft) !== stableStringify(settings);
}

/** 提交（spec §3：应用统一走 saveSettings 集中订阅链）；deep copy 入库。
 * 入参为完整设置值——「应用」侧以 mergeDraftOnto 先行合并（复活路径防护，I-2），
 * 本函数只负责落盘与订阅广播。 */
export function commit(s: Settings): void {
  saveSettings(deepClone(s));
}

/**
 * 把 draft 相对其出发快照（baseline）的变更字段合并到 base（提交时刻的最新生效值）
 * 上，返回合并结果（不改动三个入参；I-2 复活路径防护的纯函数核）：
 * - 变更判定 = 与 baseline 的深度比较（stableStringify）；变更字段取 draft 值
 *   （数组整组、标量直接），对象节内递归一层至 diagrams.modes（depth < 2）；
 * - 未变字段保留 base——外部在设置页打开期间经 saveSettings 落盘的变更
 *   （如存储管理 purge 的引用回落）不被草稿中的陈旧字段复活；
 * - base 与 baseline 相等（无外部变更）时结果恒等于 draft（原 commit(draft)
 *   语义不变）；用户改动与外部变更撞同一字段时 draft 值胜（后写优先）。
 */
export function mergeDraftOnto(base: Settings, baseline: Settings, draft: Settings): Settings {
  const out = deepClone(base);
  mergeChanged(
    out as unknown as Record<string, unknown>,
    baseline as unknown as Record<string, unknown>,
    draft as unknown as Record<string, unknown>,
    0
  );
  return out;
}

/** mergeDraftOnto 的递归体：draft 相对 baseline 有差异的叶子字段写入 target。
 * 顶层只走白名单键（draft 未知键不入结果）；节内信任 Settings 同构契约
 * （fonts/layout 全形，diagrams.modes 任意图类型键均合法——新增键按「baseline
 * 缺键 = 变更」落位），删键不传播（target 保留 base 的键，与 mergeImported 的
 * modes 合并缺项保留口径对称）。 */
function mergeChanged(
  target: Record<string, unknown>,
  baseline: Record<string, unknown>,
  draft: Record<string, unknown>,
  depth: number
): void {
  for (const k of depth === 0 ? SETTINGS_KEYS : Object.keys(draft)) {
    const dv = draft[k];
    const tv = target[k];
    if (depth < 2 && isObj(dv) && isObj(baseline[k]) && isObj(tv)) {
      mergeChanged(tv as Record<string, unknown>, baseline[k] as Record<string, unknown>, dv, depth + 1);
    } else if (stableStringify(dv) !== stableStringify(baseline[k])) {
      target[k] = dv;
    }
  }
}

/**
 * 字段级覆盖（I1 终审勘误口径，spec §4「字段级覆盖，缺项保留现状」的落地形态）：
 * raw 在场且规范化结果在案的键取规范化值覆盖 target；raw 在场但规范化剔除的键
 * （顶层未知字段/modes 非法值——normalizeSettings 重建节时剔除）忽略，current
 * 保留。双方均为对象且未到深度上限时递归（节 → diagrams.modes 一层），数组与
 * 标量整值覆盖（excludedPatterns 整组替换）。
 */
function mergeFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  raw: Record<string, unknown>,
  depth: number
): void {
  for (const k of Object.keys(raw)) {
    if (!(k in source)) continue;
    const rv = raw[k];
    if (depth < 2 && isObj(rv) && isObj(source[k]) && isObj(target[k])) {
      mergeFields(target[k] as Record<string, unknown>, source[k] as Record<string, unknown>, rv, depth + 1);
    } else {
      target[k] = source[k];
    }
  }
}

/**
 * 导入合并（spec §4「白名单字段级覆盖，导入缺项保留现状」；2026-10-19 终审 I1
 * 勘误：字段 = 节内字段级而非节整体——对象节内递归一层至 diagrams.modes，数组
 * 整组覆盖，标量直接覆盖；导入缺项保留 current）。在场字段取导入值经
 * normalizeSettings 规范化后的结果，非法字段同口径取规范化值（顶层归默认/节内
 * clamp；modes 非法值被剔除即不覆盖——严格阻断在导入对话框层 validateSettings），
 * 未知字段忽略。
 */
export function mergeImported(current: Settings, imported: unknown): Settings {
  const out = deepClone(current);
  if (!isObj(imported)) return out;
  const raw = imported as Record<string, unknown>;
  const norm = normalizeSettings(pickKnown(raw));
  mergeFields(out as unknown as Record<string, unknown>, norm as unknown as Record<string, unknown>, raw, 0);
  return out;
}

/**
 * 导入替换（spec §4：校验通过后整体覆盖为导入规范化结果）。非对象输入回落
 * 全默认；缺项/脏字段由 normalizeSettings 补默认（「整体覆盖」语义：现状不保留）；
 * 白名单外未知字段拣选剔除（L1 顺手项——不落盘）。
 */
export function replaceImported(imported: unknown): Settings {
  return normalizeSettings(isObj(imported) ? pickKnown(imported) : {});
}

// ---------- 导入/导出文件（spec §4，Task 3） ----------

/** 导出文件形状（spec §4：{ schemaVersion: 1, exportedAt, settings }） */
export interface SettingsExportFile {
  schemaVersion: number;
  exportedAt: string;
  settings: Settings;
}

/** 当前 schema 版本（首版；更高版本文件走「尽力合并」降级路径并警告） */
export const SETTINGS_SCHEMA_VERSION = 1;

/** 导出文件构造（纯函数；Blob 下载与 a[download] 接线在 SettingsCenter UI 层） */
export function buildExportFile(settings: Settings, exportedAt: string): SettingsExportFile {
  return { schemaVersion: SETTINGS_SCHEMA_VERSION, exportedAt, settings: deepClone(settings) };
}

/** 导出文件名（spec §4：vviewer-settings-YYYYMMDD.json，本地日期补零） */
export function exportFileName(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `vviewer-settings-${y}${m}${d}.json`;
}

export type ImportParseResult =
  | { ok: true; settings: Record<string, unknown>; warnings: string[] }
  | { ok: false; errors: SettingsIssue[] };

/**
 * 导入文件解析（spec §4 管线前半：parse → schemaVersion 兼容检查 → 白名单校验）。
 * 校验口径与 JSON 视图同源（validateSettings），差异仅在未知字段：JSON 视图阻断，
 * 导入降为警告（pickKnown 在 merge/replace 侧确保不落盘——「警告不静默丢弃」）。
 * 类型/枚举/clamp 类问题仍阻断（校验失败不部分应用）。通过时 settings 原样透传
 * （规范化在 merge/replace 内做），版本警告随结果携带供对话框注记。
 */
export function parseImportFile(text: string): ImportParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [{ field: '', message: `JSON 语法错误：${msg}` }] };
  }
  if (!isObj(parsed)) return { ok: false, errors: [{ field: '', message: '导入文件必须是 JSON 对象' }] };
  const warnings: string[] = [];
  const v = parsed.schemaVersion;
  if (v === undefined) {
    warnings.push('缺少 schemaVersion，按当前版本处理');
  } else if (typeof v !== 'number' || !Number.isFinite(v)) {
    warnings.push(`schemaVersion 非法（${JSON.stringify(v) ?? 'null'}），按当前版本处理`);
  } else if (v > SETTINGS_SCHEMA_VERSION) {
    warnings.push(
      `导入文件版本更新（schemaVersion ${v} > ${SETTINGS_SCHEMA_VERSION}），将尽力合并，可能存在兼容风险`
    );
  }
  const rawSettings = parsed.settings;
  if (!isObj(rawSettings)) {
    return { ok: false, errors: [{ field: 'settings', message: '导入文件缺少 settings 对象' }] };
  }
  const unknownPaths = new Set(collectUnknownPaths(rawSettings));
  const issues = validateSettings(rawSettings);
  const errors = issues.filter((i) => !unknownPaths.has(i.field));
  for (const p of unknownPaths) warnings.push(`${p}：未知字段（白名单外，不落盘）`);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, settings: rawSettings, warnings };
}

/** 白名单外字段路径收集（顶层 + 已知节的一级键 + diagrams.modes 键级），与
 * validateSettings 的 field 记法一致——导入侧据此把未知字段降级为警告 */
function collectUnknownPaths(raw: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const k of Object.keys(raw)) {
    if (!SETTINGS_KEYS.includes(k as keyof Settings)) paths.push(k);
  }
  const allowed: Record<string, readonly string[]> = {
    diagrams: ['krokiHost', 'krokiVia', 'modes'],
    fonts: ['uiFamily', 'uiSize', 'codeFamily', 'codeSize'],
    layout: Object.keys(sanitizeLayout({}))
  };
  for (const [sec, keys] of Object.entries(allowed)) {
    const v = raw[sec];
    if (isObj(v)) {
      for (const k of Object.keys(v)) {
        if (!keys.includes(k)) paths.push(`${sec}.${k}`);
      }
    }
  }
  const modes = isObj(raw.diagrams) ? (raw.diagrams as Record<string, unknown>).modes : undefined;
  if (isObj(modes)) {
    for (const k of Object.keys(modes)) {
      if (!resolveDiagramType(k)) paths.push(`diagrams.modes.${k}`);
    }
  }
  return paths;
}

// ---------- 导入变更摘要（spec §4：对话框逐组 diff 列表） ----------

/** 单组变更摘要：added/removed/changed 为人类可读 diff 行（UI 原样渲染） */
export interface ImportGroupDiff {
  key: string;
  added: string[];
  removed: string[];
  changed: string[];
}

function previewValue(v: unknown): string {
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 39)}…` : v;
  const s = JSON.stringify(v) ?? 'null';
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

/** 值级 diff（深度 ≤3：settings 组至多 diagrams.modes.<type> 两级嵌套） */
function diffInto(key: string, a: unknown, b: unknown, d: ImportGroupDiff, depth: number): void {
  if (stableStringify(a) === stableStringify(b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    const setA = new Set(a);
    for (const x of b) if (!setA.has(x)) d.added.push(`+ ${previewValue(x)}`);
    const setB = new Set(b);
    for (const x of a) if (!setB.has(x)) d.removed.push(`- ${previewValue(x)}`);
    return;
  }
  if (isObj(a) && isObj(b) && depth < 3) {
    for (const sk of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const av = (a as Record<string, unknown>)[sk];
      const bv = (b as Record<string, unknown>)[sk];
      if (stableStringify(av) === stableStringify(bv)) continue;
      if (av === undefined) d.added.push(`+ ${key}.${sk} = ${previewValue(bv)}`);
      else if (bv === undefined) d.removed.push(`- ${key}.${sk}`);
      else if (isObj(av) && isObj(bv)) diffInto(`${key}.${sk}`, av, bv, d, depth + 1);
      else d.changed.push(`${key}.${sk}: ${previewValue(av)} → ${previewValue(bv)}`);
    }
    return;
  }
  d.changed.push(`${key}: ${previewValue(a)} → ${previewValue(b)}`);
}

/**
 * 导入变更摘要（spec §4「逐组新增/修改计数，关键字段 diff 列表」的纯函数部分）：
 * 仅列导入在场且与现状有差异的组；对照值取 mergeImported 的真实合并结果（I1
 * 字段级口径同源——摘要即所选「合并」路径的真实效果预览）。
 */
export function importGroupDiffs(current: Settings, importedSettings: unknown): ImportGroupDiff[] {
  if (!isObj(importedSettings)) return [];
  const next = mergeImported(current, importedSettings);
  const cur = current as unknown as Record<string, unknown>;
  const nx = next as unknown as Record<string, unknown>;
  const diffs: ImportGroupDiff[] = [];
  for (const k of SETTINGS_KEYS) {
    if (!(k in importedSettings)) continue;
    const d: ImportGroupDiff = { key: k, added: [], removed: [], changed: [] };
    diffInto(k, cur[k], nx[k], d, 0);
    if (d.added.length > 0 || d.removed.length > 0 || d.changed.length > 0) diffs.push(d);
  }
  return diffs;
}
