import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  LEFT_WIDTH_RANGE,
  RIGHT_WIDTH_RANGE,
  chromeVisible,
  clampWidth,
  enterZen,
  exitZen,
  sanitizeLayout,
  zenEscAction,
  zenPopAction
} from './layout';

describe('layout 纯函数（spec 2026-10-19 布局自由化 §2）', () => {
  it('DEFAULT_LAYOUT：双栏默认宽 260/230，全件可见不折叠非 zen', () => {
    expect(DEFAULT_LAYOUT).toEqual({
      leftCollapsed: false,
      rightCollapsed: false,
      leftWidth: 260,
      rightWidth: 230,
      topBarVisible: true,
      tabBarVisible: true,
      zen: false
    });
  });

  it('clampWidth：左栏 clamp 180–480 / 右栏 clamp 160–420（越界夹紧）', () => {
    expect(LEFT_WIDTH_RANGE).toEqual([180, 480]);
    expect(RIGHT_WIDTH_RANGE).toEqual([160, 420]);
    expect(clampWidth('left', 100)).toBe(180);
    expect(clampWidth('left', 999)).toBe(480);
    expect(clampWidth('right', 100)).toBe(160);
    expect(clampWidth('right', 999)).toBe(420);
    expect(clampWidth('left', 300)).toBe(300);
    expect(clampWidth('right', 300)).toBe(300);
  });

  it('clampWidth 边界值原样通过', () => {
    expect(clampWidth('left', 180)).toBe(180);
    expect(clampWidth('left', 480)).toBe(480);
    expect(clampWidth('right', 160)).toBe(160);
    expect(clampWidth('right', 420)).toBe(420);
  });

  it('clampWidth 脏值（非有限数字，含 Infinity）归位该侧默认宽', () => {
    expect(clampWidth('left', NaN)).toBe(DEFAULT_LAYOUT.leftWidth);
    expect(clampWidth('left', Infinity)).toBe(DEFAULT_LAYOUT.leftWidth);
    expect(clampWidth('right', -Infinity)).toBe(DEFAULT_LAYOUT.rightWidth);
    expect(clampWidth('right', NaN)).toBe(DEFAULT_LAYOUT.rightWidth);
  });

  it('sanitizeLayout：合法值原样通过', () => {
    const l = {
      leftCollapsed: true,
      rightCollapsed: false,
      leftWidth: 400,
      rightWidth: 200,
      topBarVisible: false,
      tabBarVisible: true,
      zen: true
    };
    expect(sanitizeLayout(l)).toEqual(l);
  });

  it('sanitizeLayout：宽度越界 clamp、小数取整', () => {
    const l = sanitizeLayout({ leftWidth: 9999, rightWidth: 1, leftCollapsed: false, rightCollapsed: false, topBarVisible: true, tabBarVisible: true, zen: false });
    expect(l.leftWidth).toBe(480);
    expect(l.rightWidth).toBe(160);
    expect(sanitizeLayout({ ...DEFAULT_LAYOUT, leftWidth: 260.6 }).leftWidth).toBe(261);
  });

  it('sanitizeLayout：布尔脏值（非 boolean 类型）字段级归位默认，宽度脏值归位默认宽', () => {
    const l = sanitizeLayout({
      leftCollapsed: 1,
      rightCollapsed: 'yes',
      leftWidth: 'wide',
      rightWidth: null,
      topBarVisible: undefined,
      tabBarVisible: 0,
      zen: 'true'
    });
    expect(l).toEqual(DEFAULT_LAYOUT);
  });

  it('sanitizeLayout：入参整体非对象（脏 JSON）回落全默认', () => {
    expect(sanitizeLayout(42)).toEqual(DEFAULT_LAYOUT);
    expect(sanitizeLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(sanitizeLayout(undefined)).toEqual(DEFAULT_LAYOUT);
    expect(sanitizeLayout('layout')).toEqual(DEFAULT_LAYOUT);
  });

  it('sanitizeLayout：部分字段缺失按默认补齐（旧版本 localStorage 无 layout 节的字段级前向兼容）', () => {
    const l = sanitizeLayout({ leftWidth: 360 });
    expect(l.leftWidth).toBe(360);
    expect(l.rightWidth).toBe(DEFAULT_LAYOUT.rightWidth);
    expect(l.zen).toBe(false);
  });
});

describe('zen 覆盖语义（spec 2026-10-19 布局自由化 §3）', () => {
  const customized: typeof DEFAULT_LAYOUT = {
    ...DEFAULT_LAYOUT,
    leftCollapsed: true,
    rightWidth: 400,
    topBarVisible: false,
    tabBarVisible: false
  };

  it('enterZen 只翻转 zen，不改其余字段（正交性：无独立快照存储的依据）', () => {
    const zen = enterZen(customized);
    expect(zen.zen).toBe(true);
    expect(zen).toEqual({ ...customized, zen: true });
  });

  it('exitZen 还原进入前各件可见性：字段从未被改写，翻回即还原', () => {
    const restored = exitZen(enterZen(customized));
    expect(restored).toEqual(customized);
  });

  it('chromeVisible：zen 覆盖全部 chrome（即使底层字段要求显示）', () => {
    expect(chromeVisible({ ...DEFAULT_LAYOUT, zen: true })).toEqual({
      topBar: false,
      tabBar: false,
      left: false,
      right: false
    });
  });

  it('chromeVisible：非 zen 按显式字段（折叠/可见性）生效', () => {
    expect(chromeVisible(customized)).toEqual({
      topBar: false,
      tabBar: false,
      left: false, // leftCollapsed
      right: true
    });
  });

  it('zenEscAction 状态机三态：overlay 开 → closeOverlay（优先级最高）', () => {
    expect(zenEscAction({ overlaysOpen: true, zen: true })).toBe('closeOverlay');
    expect(zenEscAction({ overlaysOpen: true, zen: false })).toBe('closeOverlay');
  });

  it('zenEscAction：无 overlay 且 zen → exitZen；否则 none', () => {
    expect(zenEscAction({ overlaysOpen: false, zen: true })).toBe('exitZen');
    expect(zenEscAction({ overlaysOpen: false, zen: false })).toBe('none');
  });
});

describe('zenPopAction 返回键分派（spec 2026-10-19 §3.1：同一状态机双触发源）', () => {
  it('双触发源等价性：产生实际动作的各态与桌面 Esc（zenEscAction）一致', () => {
    // 面板开 → closeOverlay；无面板且 zen → exitZen（两态两触发源同分派）
    expect(zenPopAction({ guardArmed: true, overlaysOpen: true, zen: true })).toBe(
      zenEscAction({ overlaysOpen: true, zen: true })
    );
    expect(zenPopAction({ guardArmed: true, overlaysOpen: true, zen: false })).toBe(
      zenEscAction({ overlaysOpen: true, zen: false })
    );
    expect(zenPopAction({ guardArmed: true, overlaysOpen: false, zen: true })).toBe(
      zenEscAction({ overlaysOpen: false, zen: true })
    );
    // 刻意差异：空闲态（守卫在场、无面板、非 zen）Esc 侧 none，返回键侧 ignore
    // ——popstate 的 no-op 还承担「不劫持正常导航」（放行原生回退）
    expect(zenPopAction({ guardArmed: true, overlaysOpen: false, zen: false })).toBe('ignore');
  });

  it('popstate 分派：面板开 → closeOverlay（返回键承接「Esc 先关面板」）', () => {
    expect(zenPopAction({ guardArmed: true, overlaysOpen: true, zen: true })).toBe('closeOverlay');
    expect(zenPopAction({ guardArmed: true, overlaysOpen: true, zen: false })).toBe('closeOverlay');
  });

  it('popstate 分派：无面板且 zen → exitZen', () => {
    expect(zenPopAction({ guardArmed: true, overlaysOpen: false, zen: true })).toBe('exitZen');
  });

  it('守卫不在场恒 ignore：正常导航不劫持（含面板开着但不经 zen 的回退不误退）', () => {
    expect(zenPopAction({ guardArmed: false, overlaysOpen: true, zen: true })).toBe('ignore');
    expect(zenPopAction({ guardArmed: false, overlaysOpen: true, zen: false })).toBe('ignore');
    expect(zenPopAction({ guardArmed: false, overlaysOpen: false, zen: false })).toBe('ignore');
  });

  it('zen 已退但守卫残留（跨标签同步退出等边缘）：ignore 不误动作', () => {
    expect(zenPopAction({ guardArmed: true, overlaysOpen: false, zen: false })).toBe('ignore');
  });
});
