/**
 * 字体预设清单（字体系统 spec 2026-10-19 §4，Task 3）：
 * - UI 组 8 项（无衬线）/ 代码组 10 项（等宽），值为 family 原文（存入 settings
 *   fonts 槽位，注入侧 theme.ts fontFamilyValue 逐段引号包裹）；
 * - 代码组首项「默认等宽栈」以 value '' 表达（= settings 默认栈语义），
 *   fontFamilyOptions 装配时并入默认选项位，不产生重复选项值；
 * - 按可用性分化不承诺（spec §4）：本机缺失的预设由浏览器回退，不做探测。
 * Task 5 网络字体管理列表以下拉合并源身份复用本清单（fontFamilyOptions）。
 */

/** 预设项：value 存 settings，label 供下拉显示 */
export interface FontPreset {
  value: string;
  label: string;
}

/** UI 槽预设（spec §4 UI 组 8 项，无衬线） */
export const UI_FONT_PRESETS: readonly FontPreset[] = [
  { value: 'system-ui', label: 'system-ui（默认无衬线）' },
  { value: '微软雅黑', label: '微软雅黑 Microsoft YaHei' },
  { value: 'PingFang SC', label: 'PingFang SC 苹方' },
  { value: 'Noto Sans CJK SC', label: 'Noto Sans CJK SC' },
  { value: '思源黑体', label: '思源黑体 Source Han Sans' },
  { value: 'Segoe UI', label: 'Segoe UI（Windows）' },
  { value: 'Roboto', label: 'Roboto（Android）' },
  { value: 'Helvetica Neue', label: 'Helvetica Neue（macOS）' }
];

/** 代码槽预设（spec §4 代码组 10 项，等宽；首项为默认占位 value ''） */
export const CODE_FONT_PRESETS: readonly FontPreset[] = [
  { value: '', label: '默认等宽栈' },
  { value: 'JetBrains Mono', label: 'JetBrains Mono' },
  { value: 'Fira Code', label: 'Fira Code' },
  { value: 'Cascadia Code', label: 'Cascadia Code（Windows 11）' },
  { value: 'Consolas', label: 'Consolas（Windows）' },
  { value: 'Menlo', label: 'Menlo（macOS）' },
  { value: 'SF Mono', label: 'SF Mono（macOS）' },
  { value: 'Source Code Pro', label: 'Source Code Pro' },
  { value: 'Sarasa Mono SC', label: '更纱等宽 Sarasa Mono SC' },
  { value: 'Noto Sans Mono CJK SC', label: 'Noto Sans Mono CJK SC' }
];

/** 样张文本（spec §4）：中英数与易混形字符（0O、Il、1|）齐全——面板预览与
 * Task 5 管理列表样张共用 */
export const FONT_SPECIMEN = 'AaBbYyZz 0123 永江流千里 0OIl1|';

/** 「自定义…」选项哨兵：select 选中它 = 展开手输框（预设清单值不会取此形态） */
export const CUSTOM_FONT_SENTINEL = '__custom__';

export interface FontFamilyOption {
  value: string;
  label: string;
}

/**
 * 两槽族下拉的选项装配（Task 3 面板与 Task 5 网络字体下拉同源复用）：
 * 默认项（value ''，标签取清单内默认占位项，无则「默认」）+ 预设组（保持清单序）
 * +「自定义…」哨兵收尾；输出值唯一（spec 默认项并入默认位，不重复出现）。
 */
export function fontFamilyOptions(presets: readonly FontPreset[]): FontFamilyOption[] {
  const defaultLabel = presets.find((p) => p.value === '')?.label ?? '默认';
  return [
    { value: '', label: defaultLabel },
    ...presets.filter((p) => p.value !== '').map((p) => ({ value: p.value, label: p.label })),
    { value: CUSTOM_FONT_SENTINEL, label: '自定义…' }
  ];
}

/**
 * 两槽下拉与网络字体的合并装配（Task 5）：base 为 fontFamilyOptions 输出（哨兵
 * 收尾），已启用网络字体名插在预设组与哨兵之间——选项值即字体记录 name（槽位
 * 存储语义与预设一致，label 加「（网络）」标注来源）；与既有选项值撞车的名字
 * 跳过（select 重复值会选中错位），空清单时与 base 全等（未添加字体 = 纯预设形态）。
 */
export function mergedFamilyOptions(
  base: readonly FontFamilyOption[],
  networkNames: readonly string[]
): FontFamilyOption[] {
  const sentinel = base.at(-1);
  if (!sentinel) return [];
  const taken = new Set(base.slice(0, -1).map((o) => o.value));
  const net = networkNames
    .filter((n) => !taken.has(n))
    .map((n) => ({ value: n, label: `${n}（网络）` }));
  return [...base.slice(0, -1), ...net, sentinel];
}

/** 字体文件体积显示（Task 5 管理列表行）：B / KB（整数）/ MB（一位小数）三档。 */
export function formatFontSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
