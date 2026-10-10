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

/** 主题亮暗槽归属：hc-* 归 dark（plan Global Constraints），缺省/未知按 dark。 */
export function themeKind(raw: VscodeThemeJson): 'dark' | 'light' {
  return raw.type === 'light' ? 'light' : 'dark';
}

const THEME_TYPES = new Set(['dark', 'light', 'hc-black', 'hc-light']);

/**
 * 导入校验：name 必填非空；type 白名单（hc-* 归 dark）；colors/tokenColors
 * 至少其一非空。1MB 体积闸与解包在导入层（Task 3），此处只管形状。
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
  const hasColors =
    typeof theme.colors === 'object' && theme.colors !== null && !Array.isArray(theme.colors) &&
    Object.keys(theme.colors).length > 0;
  const hasTokenColors = Array.isArray(theme.tokenColors) && theme.tokenColors.length > 0;
  if (!hasColors && !hasTokenColors) {
    return { ok: false, reason: 'colors 与 tokenColors 至少其一非空' };
  }
  return { ok: true, theme: { ...theme, name: theme.name, kind: themeKind(theme) } };
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
    if (!fg) continue;
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
    if (typeof value === 'string' && value !== '') lines.push(`${cssVar}: ${value};`);
  }
  return lines;
}
