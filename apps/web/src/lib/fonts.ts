/**
 * 字体预设清单（字体系统 spec 2026-10-19 §4，Task 3）：
 * - UI 组 8 项（无衬线）/ 代码组 10 项（等宽），值为 family 原文（存入 settings
 *   fonts 槽位，注入侧 theme.ts fontFamilyValue 逐段引号包裹）；
 * - 代码组首项「默认等宽栈」以 value '' 表达（= settings 默认栈语义），
 *   fontFamilyOptions 装配时并入默认选项位，不产生重复选项值；
 * - 按可用性分化不承诺（spec §4）：本机缺失的预设由浏览器回退，不做探测。
 * Task 5 网络字体管理列表以下拉合并源身份复用本清单（fontFamilyOptions）。
 * Task 10 域 G：label 迁目录键（settings.fonts.preset.*，消费点 t() 现取）；
 * value 与样张的 CJK 是数据值（family 名/字形样本），\u 转义保留恒定字节。
 */

import { translate } from './i18n/core';

// t 的松散签名(gitClient tLoose / index.svelte coreTranslateLoose 先例):label 是
// \`settings.fonts.preset.${string}\` 模板键类型,规范 TFunction 的占位符模板推导对
// 模板键类型推不出空参元组(编译误报必传参)——键与占位符的对齐由目录 satisfies
// 与消费点字面键保证,此处以 loose 面承接键分支形态。
type LooseT = (key: string, params?: Record<string, string | number>) => string;
const t = translate as unknown as LooseT;

/**
 * 预设项：value 存 settings（family 名数据值，不翻译——含 CJK 的 family 名以
 * \u 转义保留恒定字节，运行时值逐字节不变）；label 是下拉显示文案的目录键
 * （settings.fonts.preset.*）——消费点（fontFamilyOptions/mergedFamilyOptions）
 * t(label) 当下取值。
 */
export interface FontPreset {
  value: string;
  label: `settings.fonts.preset.${string}`;
}

/** UI 槽预设（spec §4 UI 组 8 项，无衬线） */
export const UI_FONT_PRESETS: readonly FontPreset[] = [
  { value: 'system-ui', label: 'settings.fonts.preset.systemUi' },
  { value: '\u5fae\u8f6f\u96c5\u9ed1', label: 'settings.fonts.preset.microsoftYaHei' },
  { value: 'PingFang SC', label: 'settings.fonts.preset.pingFangSc' },
  { value: 'Noto Sans CJK SC', label: 'settings.fonts.preset.notoSansCjkSc' },
  { value: '\u601d\u6e90\u9ed1\u4f53', label: 'settings.fonts.preset.sourceHanSans' },
  { value: 'Segoe UI', label: 'settings.fonts.preset.segoeUi' },
  { value: 'Roboto', label: 'settings.fonts.preset.roboto' },
  { value: 'Helvetica Neue', label: 'settings.fonts.preset.helveticaNeue' }
];

/** 代码槽预设（spec §4 代码组 10 项，等宽；首项为默认占位 value ''） */
export const CODE_FONT_PRESETS: readonly FontPreset[] = [
  { value: '', label: 'settings.fonts.preset.defaultMono' },
  { value: 'JetBrains Mono', label: 'settings.fonts.preset.jetbrainsMono' },
  { value: 'Fira Code', label: 'settings.fonts.preset.firaCode' },
  { value: 'Cascadia Code', label: 'settings.fonts.preset.cascadiaCode' },
  { value: 'Consolas', label: 'settings.fonts.preset.consolas' },
  { value: 'Menlo', label: 'settings.fonts.preset.menlo' },
  { value: 'SF Mono', label: 'settings.fonts.preset.sfMono' },
  { value: 'Source Code Pro', label: 'settings.fonts.preset.sourceCodePro' },
  { value: 'Sarasa Mono SC', label: 'settings.fonts.preset.sarasaMonoSc' },
  { value: 'Noto Sans Mono CJK SC', label: 'settings.fonts.preset.notoSansMonoCjkSc' }
];

/**
 * 样张文本（spec §4）：中英数与易混形字符（0O、Il、1|）齐全——面板预览与
 * Task 5 管理列表样张共用。中文字形段是字体渲染预览的固定样本数据（en 态同样
 * 要展示 CJK 字形效果），非翻译文案——D8 审计数据值裁决，\u 转义保留恒定值。
 */
export const FONT_SPECIMEN = 'AaBbYyZz 0123 \u6c38\u6c5f\u6d41\u5343\u91cc 0OIl1|';

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
  const defaultKey = presets.find((p) => p.value === '')?.label ?? 'settings.fonts.preset.default';
  return [
    { value: '', label: t(defaultKey) },
    ...presets.filter((p) => p.value !== '').map((p) => ({ value: p.value, label: t(p.label) })),
    { value: CUSTOM_FONT_SENTINEL, label: t('settings.fonts.preset.custom') }
  ];
}

/**
 * 两槽下拉与网络字体的合并装配（Task 5）：base 为 fontFamilyOptions 输出（哨兵
 * 收尾），已启用网络字体名插在预设组与哨兵之间——选项值即字体记录 name（槽位
 * 存储语义与预设一致，label 加「（网络）」标注来源）；与既有选项值撞车的名字
 * 跳过（select 重复值会选中错位），空清单时与 base 全等（未添加字体 = 纯预设形态）。
 * 台账 Low：哨兵 value（__custom__）也在占用集内——网络字体恰名为 __custom__ 时
 * 若放行会与哨兵选项重复，select 选中它即误开手输框。
 */
export function mergedFamilyOptions(
  base: readonly FontFamilyOption[],
  networkNames: readonly string[]
): FontFamilyOption[] {
  const sentinel = base.at(-1);
  if (!sentinel) return [];
  const taken = new Set(base.map((o) => o.value));
  const net = networkNames
    .filter((n) => !taken.has(n))
    .map((n) => ({ value: n, label: t('settings.fonts.preset.network', { name: n }) }));
  return [...base.slice(0, -1), ...net, sentinel];
}

/** 字体文件体积显示（Task 5 管理列表行）：B / KB（整数）/ MB（一位小数）三档。 */
export function formatFontSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
