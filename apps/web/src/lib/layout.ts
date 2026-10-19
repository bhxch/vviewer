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

// ---------- zen（spec §3）：覆盖语义与 Esc 优先级状态机 ----------

/**
 * 进入 zen：只翻转 zen 字段。spec「zen 与显式布局配置正交」的实现即在此——
 * 不改写其余字段，进入前的各件可见性天然留在原地，退出（exitZen）翻回即还原，
 * 无需独立快照存储（快照还原语义由「字段从未被改写」承担，zen.test 覆盖）。
 */
export function enterZen(l: LayoutSettings): LayoutSettings {
  return { ...l, zen: true };
}

/** 退出 zen：同上只翻 zen 字段（还原 = 进入前字段值）。 */
export function exitZen(l: LayoutSettings): LayoutSettings {
  return { ...l, zen: false };
}

export interface ChromeVisibility {
  topBar: boolean;
  tabBar: boolean;
  left: boolean;
  right: boolean;
}

/**
 * chrome 有效可见性（AppShell 渲染消费）：zen 做全件视觉覆盖（隐 TopBar/TabBar/
 * 双栏，仅留内容区），非 zen 按显式字段（可见性 × 折叠）生效。移动端抽屉断点
 * 的开关不受此影响（AppShell 渲染层断点分流）。
 */
export function chromeVisible(l: LayoutSettings): ChromeVisibility {
  if (l.zen) return { topBar: false, tabBar: false, left: false, right: false };
  return {
    topBar: l.topBarVisible,
    tabBar: l.tabBarVisible,
    left: !l.leftCollapsed,
    right: !l.rightCollapsed
  };
}

export type ZenEscAction = 'closeOverlay' | 'exitZen' | 'none';

/**
 * Esc 优先级状态机（spec §3）：设置/搜索/快速打开等 overlay 打开时 Esc 只关
 * overlay（面板自带 Esc 处理器，AppShell 侧不动作）；无 overlay 时 Esc 退 zen；
 * 平时 Esc 无事。同一状态机双触发源（桌面 Esc / 移动端返回键，spec §3.1）——
 * 触发源只负责算出 overlaysOpen，分派语义集中在此纯函数。
 * overlaysOpen 的判定信号：AppShell 实时查 overlay 面板 DOM（各面板为 {#if}
 * 条件挂载，在 DOM 即开——比镜像多份 $state 布尔更准，见 AppShell anyOverlayOpen）。
 */
export function zenEscAction(state: { overlaysOpen: boolean; zen: boolean }): ZenEscAction {
  if (state.overlaysOpen) return 'closeOverlay';
  if (state.zen) return 'exitZen';
  return 'none';
}

export type ZenPopAction = 'closeOverlay' | 'exitZen' | 'ignore';

/**
 * 返回键 popstate 分派（spec §3.1）：zenEscAction 的第二触发源（Android 返回键 /
 * PWA standalone 手势），语义逐态一致（guardArmed=true 时等价，layout.test 锁定）。
 * 差异只在守卫门：guardArmed=当前历史项是 AppShell 压入的 zen 守卫（{vvZen:1}）——
 * 守卫不在场一律 ignore 放行原生回退（不劫持正常导航，含「面板开着但不经 zen」的
 * 回退不误退）；守卫在场则面板开=closeOverlay（承接桌面「Esc 先关面板」）、无面板
 * 且 zen=exitZen，余皆 ignore（如跨标签同步退 zen 后的残留守卫）。
 */
export function zenPopAction(state: { guardArmed: boolean; overlaysOpen: boolean; zen: boolean }): ZenPopAction {
  if (!state.guardArmed) return 'ignore';
  if (state.overlaysOpen) return 'closeOverlay';
  if (state.zen) return 'exitZen';
  return 'ignore';
}
