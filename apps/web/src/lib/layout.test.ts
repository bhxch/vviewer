import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  LEFT_WIDTH_RANGE,
  RIGHT_WIDTH_RANGE,
  clampWidth,
  sanitizeLayout
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
