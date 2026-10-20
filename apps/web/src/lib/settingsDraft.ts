// settingsDraft.ts — 设置草稿模型纯函数（settings center spec §3/§4，Task 2）。
// 无 runes 的纯 .ts 模块（vitest 直测）：深拷贝/序列化/parse+白名单镜像校验/脏态/
// 提交/导入合并与替换。UI（SettingsCenter.svelte）持有 draft（$state 深代理）并
// 统一在「应用」时走 commit → saveSettings 集中订阅链。
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

const THEME_MODES: readonly string[] = ['light', 'dark', 'system'];
const POLICIES: readonly string[] = ['auto', 'local', 'remote'];
const DIAGRAM_MODES: readonly string[] = ['local', 'kroki', 'source'];

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
        if (k !== 'krokiHost' && k !== 'modes') issues.push({ field: `diagrams.${k}`, message: '未知字段（白名单外，不落盘）' });
      }
      if (d.krokiHost !== undefined && d.krokiHost !== '' && !(typeof d.krokiHost === 'string' && /^https?:\/\//.test(d.krokiHost))) {
        issues.push({ field: 'diagrams.krokiHost', message: '须为 http(s):// 开头地址或空串（空 = 默认服务）' });
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

/** 提交（spec §3：应用统一走 saveSettings 集中订阅链）；deep copy 入库，
 * 提交后再改 draft 不回灌已提交值 */
export function commit(draft: Draft): void {
  saveSettings(deepClone(draft));
}

/**
 * 导入合并（spec §4：白名单字段级覆盖，导入缺项保留现状）。字段 = 顶层字段：
 * 在场字段取导入值经 normalizeSettings 规范化后的结果（节内缺项归该节默认），
 * 非法字段同口径归默认（报错与拦截在 Task 3 导入对话框层——validateSettings），
 * 未知字段忽略。
 */
export function mergeImported(current: Settings, imported: unknown): Settings {
  const out = deepClone(current);
  if (!isObj(imported)) return out;
  const norm = normalizeSettings(imported);
  const target = out as unknown as Record<string, unknown>;
  const source = norm as unknown as Record<string, unknown>;
  for (const k of SETTINGS_KEYS) {
    if (k in imported) target[k] = source[k];
  }
  return out;
}

/**
 * 导入替换（spec §4：校验通过后整体覆盖为导入规范化结果）。非对象输入回落
 * 全默认；缺项/脏字段由 normalizeSettings 补默认（「整体覆盖」语义：现状不保留）。
 */
export function replaceImported(imported: unknown): Settings {
  return normalizeSettings(isObj(imported) ? imported : {});
}
