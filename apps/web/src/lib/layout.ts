/**
 * layout 状态纯函数（spec 2026-10-19 布局自由化与 zen mode §2）：
 * Settings.layout 节的类型/默认值/clamp/持久化白名单校验——不依赖 DOM 与
 * settings store（settings.ts 单向依赖本模块），可被 vitest 直测。
 * 渲染语义（折叠竖条/拖拽把手/zen 覆盖）在 AppShell.svelte 消费。
 */

/** 布局设置节（spec §2）。宽度为 px；折叠态栏宽归零残留 28px 竖条；
 * zen 与其余字段正交（只做视觉覆盖，不改底层字段，见 chromeVisible）。 */
export interface LayoutSettings {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftWidth: number;
  rightWidth: number;
  topBarVisible: boolean;
  tabBarVisible: boolean;
  zen: boolean;
}

export const DEFAULT_LAYOUT: LayoutSettings = {
  leftCollapsed: false,
  rightCollapsed: false,
  leftWidth: 260,
  rightWidth: 230,
  topBarVisible: true,
  tabBarVisible: true,
  zen: false
};

/** 栏宽 clamp 范围（spec §2：left 180–480 / right 160–420） */
export const LEFT_WIDTH_RANGE = [180, 480] as const;
export const RIGHT_WIDTH_RANGE = [160, 420] as const;

export type LayoutSide = 'left' | 'right';

/** 拖拽实时预览与持久化共用的宽度夹紧：非有限数字归位该侧默认宽，
 * 有限数字四舍五入后夹进范围（与 settings.clampSize 同口径）。 */
export function clampWidth(side: LayoutSide, w: number): number {
  const range = side === 'left' ? LEFT_WIDTH_RANGE : RIGHT_WIDTH_RANGE;
  if (!Number.isFinite(w)) return side === 'left' ? DEFAULT_LAYOUT.leftWidth : DEFAULT_LAYOUT.rightWidth;
  return Math.min(range[1], Math.max(range[0], Math.round(w)));
}

/** 单布尔字段校验：非 boolean 类型（JSON 数字/字符串/undefined）归位默认 */
function boolOr(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt;
}

/** layout 节白名单校验（settings.loadSettings 消费）：字段级归位——脏字段单独
 * 回默认，不整体回落（同 fonts/diagrams 节惯例）；宽度经 clampWidth（脏值/越界
 * 双重防线）。入参整体非对象（脏 JSON、旧版本无该节）回落全默认。 */
export function sanitizeLayout(v: unknown): LayoutSettings {
  if (typeof v !== 'object' || v === null) return { ...DEFAULT_LAYOUT };
  const o = v as Record<string, unknown>;
  return {
    leftCollapsed: boolOr(o.leftCollapsed, DEFAULT_LAYOUT.leftCollapsed),
    rightCollapsed: boolOr(o.rightCollapsed, DEFAULT_LAYOUT.rightCollapsed),
    leftWidth: clampWidth('left', typeof o.leftWidth === 'number' ? o.leftWidth : NaN),
    rightWidth: clampWidth('right', typeof o.rightWidth === 'number' ? o.rightWidth : NaN),
    topBarVisible: boolOr(o.topBarVisible, DEFAULT_LAYOUT.topBarVisible),
    tabBarVisible: boolOr(o.tabBarVisible, DEFAULT_LAYOUT.tabBarVisible),
    zen: boolOr(o.zen, DEFAULT_LAYOUT.zen)
  };
}
