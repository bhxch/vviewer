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
