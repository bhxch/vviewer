/**
 * VSCode 主题 JSON 解析与映射纯函数（spec B §2.2 地基）。
 *
 * 职责：校验导入的主题 JSON、TextMate scope→tree-sitter capture 映射
 * （移植 Markpad vscode.rs 算法，不解析 scope selector 语法）、
 * colors→UI token CSS 变量行（12 键白名单）。纯函数、无 IO，供
 * applyAppearance（Task 2）与导入管线（Task 3）复用。
 */
import type { ThemeTable } from './theme';

/** VSCode 主题 JSON 的宽松形态（导入文件不可信，字段均可缺省）。 */
export interface VscodeThemeJson {
  name?: string;
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: { scope?: string | string[]; settings?: { foreground?: string } }[];
}

/**
 * 主题亮暗槽归属：缺省回归上游语义——VSCode uiTheme 的 type 缺省即 light
 * （package.json contributes.themes 缺 vs 选项时按 light 主题处理）；dark→dark、
 * light→light；hc-* 归 dark（plan Global Constraints）。
 */
export function themeKind(raw: VscodeThemeJson): 'dark' | 'light' {
  if (raw.type === 'hc-black' || raw.type === 'hc-light') return 'dark';
  return raw.type === 'dark' ? 'dark' : 'light';
}

const THEME_TYPES = new Set(['dark', 'light', 'hc-black', 'hc-light']);

/**
 * 合法色值白名单：#RGB/#RGBA/#RRGGBB/#RRGGBBAA（3-8 位 hex，完整匹配）或
 * rgb()/rgba() 函数形态（完整闭合，参数仅数字/逗号/点/空格/百分号/斜杠）。
 * 导入 JSON 不可信且色值会原样拼进注入文本：白名单从根上杜绝 `;}`、`/*` 等
 * CSS 注入与数字形态 fg（hex 全匹配 + rgb 参数字符集均不含 `;}{/*`）。
 */
const COLOR_VALUE_RE = /^#[0-9a-fA-F]{3,8}$|^rgba?\([0-9.,%\s/]+\)$/;

/** colors 逐键过滤：值非 string 或不在色值白名单的键剔除（容错优先，不整体拒绝）。 */
function sanitizeColors(colors: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof colors !== 'object' || colors === null || Array.isArray(colors)) return out;
  for (const [key, value] of Object.entries(colors as Record<string, unknown>)) {
    if (typeof value === 'string' && COLOR_VALUE_RE.test(value)) out[key] = value;
  }
  return out;
}

/**
 * tokenColors 规则级过滤：规则非对象（null/数组/原始值）或 settings.foreground
 * 存在但不合法（非 string / 不在白名单）→ 整条跳过；foreground 缺省的规则保留
 * （映射层本就跳过无 fg 规则，保留不产出任何变量，也不影响「至少其一非空」语义）。
 */
function sanitizeTokenColors(tokenColors: unknown): VscodeThemeJson['tokenColors'] {
  if (tokenColors === undefined) return undefined;
  if (!Array.isArray(tokenColors)) return [];
  const out: NonNullable<VscodeThemeJson['tokenColors']> = [];
  for (const rule of tokenColors) {
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) continue;
    const settings = (rule as { settings?: unknown }).settings;
    const fg =
      typeof settings === 'object' && settings !== null
        ? (settings as { foreground?: unknown }).foreground
        : undefined;
    if (fg !== undefined && !(typeof fg === 'string' && COLOR_VALUE_RE.test(fg))) continue;
    out.push(rule as NonNullable<VscodeThemeJson['tokenColors']>[number]);
  }
  return out;
}

/**
 * 导入校验：name 必填非空；type 白名单（hc-* 归 dark、缺省按上游语义归 light）；
 * colors/tokenColors 至少其一「过滤后」非空——色值不在白名单的 colors 键逐键剔除、
 * foreground 不合法的 tokenColors 规则整条跳过（容错优先，坏值不炸整个主题），
 * 过滤后两手全空才拒绝。1MB 体积闸与解包在导入层（Task 3），此处只管形状。
 */
export function validateVscodeTheme(
  raw: unknown,
): { ok: true; theme: VscodeThemeJson & { name: string; kind: 'dark' | 'light' } } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: '主题 JSON 须为对象' };
  }
  const theme = raw as VscodeThemeJson;
  if (typeof theme.name !== 'string' || theme.name.trim() === '') {
    return { ok: false, reason: 'name 必填且非空' };
  }
  if (theme.type !== undefined && !THEME_TYPES.has(theme.type)) {
    return { ok: false, reason: `type 须为 dark/light/hc-black/hc-light，收到 ${String(theme.type)}` };
  }
  const colors = sanitizeColors(theme.colors);
  const tokenColors = sanitizeTokenColors(theme.tokenColors);
  if (Object.keys(colors).length === 0 && (tokenColors ?? []).length === 0) {
    return { ok: false, reason: 'colors 与 tokenColors 至少其一非空' };
  }
  return { ok: true, theme: { ...theme, name: theme.name, kind: themeKind(theme), colors, tokenColors } };
}

/**
 * TextMate scope 前缀 → tree-sitter capture 名全表。
 * 逐键移植自 Markpad vscode.rs L10-126（phf::phf_map，90 键），键值一一对应；
 * 上游语义：scope 树与 capture 树大体同构，少数异名（如 markup.inserted→diff.plus）
 * 由 Markpad 侧对齐 helix capture 体系而来，勿按 VSCode 直觉"修正"。
 */
export const TEXTMATE_TO_CAPTURE: Record<string, string> = {
  // Keywords
  'keyword': 'keyword',
  'keyword.control': 'keyword.control',
  'keyword.control.conditional': 'keyword.control.conditional',
  'keyword.control.repeat': 'keyword.control.repeat',
  'keyword.control.import': 'keyword.control.import',
  'keyword.control.return': 'keyword.control.return',
  'keyword.control.exception': 'keyword.control.exception',
  'keyword.operator': 'keyword.operator',
  'keyword.other': 'keyword',
  'keyword.directive': 'keyword.directive',

  // Strings
  'string': 'string',
  'string.quoted': 'string',
  'string.quoted.single': 'string',
  'string.quoted.double': 'string',
  'string.quoted.triple': 'string',
  'string.unquoted': 'string',
  'string.regexp': 'string.regexp',
  'string.interpolated': 'string.special',
  'string.other': 'string.special',

  // Comments
  'comment': 'comment',
  'comment.line': 'comment.line',
  'comment.line.double-slash': 'comment.line',
  'comment.line.double-dash': 'comment.line',
  'comment.line.number-sign': 'comment.line',
  'comment.block': 'comment.block',
  'comment.block.documentation': 'comment.block.documentation',

  // Functions
  'entity.name.function': 'function',
  'entity.name.function.method': 'function.method',
  'entity.name.function.constructor': 'constructor',
  'entity.name.function.macro': 'function.macro',
  'support.function': 'function.builtin',
  'meta.function-call': 'function',
  'meta.function': 'function',

  // Types
  'entity.name.type': 'type',
  'entity.name.class': 'type',
  'entity.name.struct': 'type',
  'entity.name.enum': 'type',
  'entity.name.interface': 'type',
  'support.type': 'type.builtin',
  'support.class': 'type.builtin',
  'entity.name.type.alias': 'type',
  'entity.name.type.enum.variant': 'type.enum.variant',

  // Variables
  'variable': 'variable',
  'variable.other': 'variable',
  'variable.other.readwrite': 'variable',
  'variable.other.member': 'variable.other.member',
  'variable.parameter': 'variable.parameter',
  'variable.function': 'function',
  'variable.language': 'variable.builtin',
  'support.variable': 'variable.builtin',

  // Constants
  'constant': 'constant',
  'constant.numeric': 'constant.numeric',
  'constant.numeric.integer': 'constant.numeric.integer',
  'constant.numeric.float': 'constant.numeric.float',
  'constant.language': 'constant.builtin',
  'constant.language.boolean': 'constant.builtin.boolean',
  'constant.character': 'constant.character',
  'constant.character.escape': 'constant.character.escape',
  'constant.other': 'constant',

  // Operators
  'keyword.operator.arithmetic': 'operator',
  'keyword.operator.assignment': 'operator',
  'keyword.operator.comparison': 'operator',
  'keyword.operator.logical': 'operator',
  'keyword.operator.bitwise': 'operator',
  'keyword.operator.type': 'operator',
  'keyword.operator.word': 'operator',

  // Punctuation
  'punctuation': 'punctuation',
  'punctuation.separator': 'punctuation.delimiter',
  'punctuation.terminator': 'punctuation.delimiter',
  'punctuation.section': 'punctuation.bracket',
  'punctuation.section.brackets': 'punctuation.bracket',
  'punctuation.section.parens': 'punctuation.bracket',
  'punctuation.section.braces': 'punctuation.bracket',
  'punctuation.definition': 'punctuation',

  // Properties
  'variable.other.property': 'property',
  'entity.name.label': 'label',
  'entity.name.namespace': 'namespace',
  'meta.attribute': 'attribute',

  // Markup
  'markup.heading': 'markup.heading',
  'markup.list': 'markup.list',
  'markup.bold': 'markup.bold',
  'markup.italic': 'markup.italic',
  'markup.link': 'markup.link',
  'markup.quote': 'markup.quote',
  'markup.raw': 'markup.raw',

  // Tags
  'entity.name.tag': 'tag',
  'meta.tag': 'tag',

  // Diff
  'markup.inserted': 'diff.plus',
  'markup.deleted': 'diff.minus',
  'markup.changed': 'diff.delta',
};

/**
 * scope 归一：string 或 array；逗号分隔串按 array 拆（TextMate scope 选择器惯例），空项剔除。
 * 导入 JSON 不可信：scope 形态异常（null/数字/对象等非 string 非 array）或数组含非字符串
 * 元素一律跳过（仿 Markpad filter_map(as_str)），不让单条坏规则炸掉整个映射。
 */
function normalizeScopes(scope: string | string[] | undefined): string[] {
  if (typeof scope === 'string') return scope.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (!Array.isArray(scope)) return [];
  return scope
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

const TABLE_KEYS = Object.keys(TEXTMATE_TO_CAPTURE);

/**
 * tokenColors → ThemeTable（移植 Markpad vscode.rs L129-198，不解析 selector 语法）：
 * 逐规则取 settings.foreground（空则跳过）；每 scope 先精确查表（后写覆盖先写），
 * 未命中则全表 starts_with 取最长前缀（前缀命中仅当该 capture 尚未写入——先到先得）。
 * 仅输出 captures 集合内的 capture（写入时过滤与输出时过滤等价：同一 capture 的
 * 精确/前缀写互相可见，集合归属不变）。
 */
export function tokenColorsToThemeTable(
  tokenColors: VscodeThemeJson['tokenColors'],
  captures: readonly string[],
): ThemeTable {
  const table: ThemeTable = {};
  if (!Array.isArray(tokenColors)) return table;
  const allowed = new Set(captures);
  for (const rule of tokenColors) {
    const fg = rule?.settings?.foreground;
    // 白名单双重闸：导入时 validate 已过滤，这里兜底 IndexedDB 存量主题（早于
    // 校验收口的导入不经 validate 直读注入）——非 string / 非法色值整条跳过。
    if (typeof fg !== 'string' || !COLOR_VALUE_RE.test(fg)) continue;
    for (const scope of normalizeScopes(rule?.scope)) {
      const exact = TEXTMATE_TO_CAPTURE[scope];
      if (exact !== undefined) {
        // 精确命中：后写覆盖先写（Markpad HashMap::insert 语义）
        if (allowed.has(exact)) table[exact] = { fg };
        continue;
      }
      // 未命中：全表线性 starts_with，最长字符匹配（键唯一使严格最长必存在且唯一）
      let bestKey: string | undefined;
      let bestCapture: string | undefined;
      for (const key of TABLE_KEYS) {
        if (scope.startsWith(key) && (bestKey === undefined || key.length > bestKey.length)) {
          bestKey = key;
          bestCapture = TEXTMATE_TO_CAPTURE[key];
        }
      }
      if (bestKey !== undefined && bestCapture !== undefined) {
        // 前缀命中仅当该 capture 尚未写入（更具体规则已给色的不抢）
        if (allowed.has(bestCapture) && !(bestCapture in table)) table[bestCapture] = { fg };
      }
    }
  }
  return table;
}

/**
 * colors→UI token 映射（12 键白名单，plan Global Constraints 固定）。
 * 输出 CSS 变量赋值行（`--ui-bg: #1F1F1F;`）；缺键跳过——回退 default 值由
 * app.css token 承担（缺键回退，不推断）。
 */
const COLORS_TO_UI_VARS: readonly (readonly [string, string])[] = [
  ['editor.background', '--ui-bg'],
  ['editor.foreground', '--ui-fg'],
  ['sideBar.background', '--ui-side-bg'],
  ['editorWidget.background', '--ui-tab-bg'],
  ['tab.activeBackground', '--ui-tab-active-bg'],
  ['input.background', '--ui-input-bg'],
  ['list.hoverBackground', '--ui-hover-bg'],
  ['editor.selectionBackground', '--ui-selection-bg'],
  ['statusBar.background', '--ui-statusbar-bg'],
  ['focusBorder', '--ui-accent'],
  ['editorError.foreground', '--ui-danger'],
  ['editorWarning.foreground', '--ui-warning'],
];

export function colorsToUiVars(colors: Record<string, string>): string[] {
  const lines: string[] = [];
  for (const [key, cssVar] of COLORS_TO_UI_VARS) {
    const value = colors[key];
    // 同 tokenColors 侧的白名单双重闸：存量主题直读注入时非法值不落文本
    if (typeof value === 'string' && COLOR_VALUE_RE.test(value)) lines.push(`${cssVar}: ${value};`);
  }
  return lines;
}
