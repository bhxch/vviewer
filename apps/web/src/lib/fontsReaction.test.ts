// fontsReaction.test.ts — fonts 设置变更反应（字体系统 Task 2，spec §2.3）：
// 签名 diff 命中 → style#vv-font 注入 + 触发激活 tab 重渲染回调（rev++ 通道）；
// 无关字段变化零触发。rev++ 动作（tabStore.touchActiveTab）以回调注入——
// openFlow.svelte 为 runes 模块 vitest 无插件不可编译（highlightRouter 测试同款
// 约束），本模块保持纯逻辑可单测。
import { describe, expect, it, vi } from 'vitest';
import { reactToFontsChange } from './fontsReaction';
import type { Settings } from './stores/settings';
import { DEFAULT_LAYOUT } from './layout';

function baseSettings(fonts?: Partial<Settings['fonts']>): Settings {
  return {
    themeMode: 'system',
    appearanceLight: 'default',
    appearanceDark: 'default',
    codeThemeLight: 'onelight',
    codeThemeDark: 'serika-dark',
    excludedPatterns: [],
    autoRefresh: true,
    computePolicy: 'auto',
    diagrams: { krokiHost: '', krokiVia: 'client', mermaidTheme: 'auto', modes: {}, renderers: {} },
    fonts: { uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13, ...fonts },
    layout: { ...DEFAULT_LAYOUT }
  };
}

describe('reactToFontsChange（fonts 变更 → 重渲染触发）', () => {
  it('fonts 签名变化：注入 style#vv-font 且触发回调恰一次（TopBar 传 tabStore.touchActiveTab）', () => {
    const onFontsChanged = vi.fn();
    expect(reactToFontsChange(baseSettings({ codeSize: 16 }), onFontsChanged)).toBe(true);
    expect(onFontsChanged).toHaveBeenCalledTimes(1);
    const el = document.getElementById('vv-font');
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain('--vv-code-font-size: 16px;');
    expect(el?.textContent).toContain('--vv-code-line-height: 24px;');
  });

  it('无关字段变化：不注入不触发（rev++ 仅 fonts 四元组变化时发生）', () => {
    reactToFontsChange(baseSettings({ codeSize: 16 }), vi.fn());
    const on = vi.fn();
    const unrelated: Settings = { ...baseSettings({ codeSize: 16 }), autoRefresh: false, excludedPatterns: ['.git'] };
    expect(reactToFontsChange(unrelated, on)).toBe(false);
    expect(on).not.toHaveBeenCalled();
  });
});
