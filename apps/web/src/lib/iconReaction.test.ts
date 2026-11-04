// iconReaction.test.ts — 图标主题设置变更反应（图标主题 spec §3.5，Task 3）：
// iconSig 公式（theme + scopes 四键，无关字段零参与）与 reactToIconsChange 联动
// 契约（changed → 回调恰一次，fontsReaction 先例同款；rev++ 动作由调用方注入）。
// iconTheme.svelte 为 runes 模块（$state），根 vitest 无 svelte 插件不可编译
// （metaStore.test.ts 先例）——vi.mock 注入 fake applyIconsFromSettings/
// iconThemeState：fake 与真实现同契约（签名落位 = 该次设置已解析），且 fake 的
// 签名落位直接引用本目录真实 iconSig（单源），故 diff 判定全链走真实公式。
import { describe, expect, it, vi } from 'vitest';
import type { Settings } from './stores/settings';
import { DEFAULT_LAYOUT } from './layout';

vi.mock('./iconTheme.svelte', async () => {
  const { iconSig } = await import('./iconReaction');
  const state: { sig: string; runtime: unknown; ready: boolean } = { sig: '', runtime: null, ready: false };
  return {
    iconThemeState: state,
    applyIconsFromSettings: async (s: Settings): Promise<void> => {
      const sig = iconSig(s);
      if (sig === state.sig) return; // 与真实现同契约：无变化零操作（签名不落位）
      state.sig = sig; // 字体装卸/runtime 换装副作用此处省略（runes 面由 e2e 覆盖）
    }
  };
});

import { iconSig, reactToIconsChange } from './iconReaction';

function baseSettings(iconThemes?: Partial<Settings['iconThemes']>): Settings {
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
    fonts: { uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13 },
    iconThemes: { theme: 'none', scopes: { tree: true, tabs: false, quickOpen: false, search: false }, ...iconThemes },
    layout: { ...DEFAULT_LAYOUT },
    storage: { remoteDownloadConfirmMb: 512 }
  };
}

describe('iconSig（签名公式：theme + scopes 四键，无关字段零参与）', () => {
  it('同设置稳定；theme 或 scopes 任一键变化即改签名', () => {
    const a = baseSettings();
    expect(iconSig(a)).toBe(iconSig(baseSettings()));
    expect(iconSig(baseSettings({ theme: 'seti' }))).not.toBe(iconSig(a));
    expect(iconSig(baseSettings({ scopes: { tree: true, tabs: true, quickOpen: false, search: false } }))).not.toBe(
      iconSig(a)
    );
    expect(iconSig(baseSettings({ scopes: { tree: false, tabs: false, quickOpen: false, search: false } }))).not.toBe(
      iconSig(a)
    );
  });

  it('无关字段（fonts/autoRefresh/excludedPatterns/themeMode…）不改签名', () => {
    const a = baseSettings();
    const b: Settings = { ...baseSettings(), autoRefresh: false, excludedPatterns: ['.git'], themeMode: 'dark' };
    expect(iconSig(b)).toBe(iconSig(a));
  });
});

describe('reactToIconsChange（icons 变更 → 重渲染触发）', () => {
  it('theme 变更：应用并触发回调恰一次，返回 true（AppShell 传 tabStore.touchActiveTab）', async () => {
    const onIconsChanged = vi.fn();
    await reactToIconsChange(baseSettings(), vi.fn()); // 先落基线（首调必命中：初值 sig 空）
    expect(await reactToIconsChange(baseSettings({ theme: 'seti' }), onIconsChanged)).toBe(true);
    expect(onIconsChanged).toHaveBeenCalledTimes(1);
  });

  it('scopes-only 变更：同样触发（作用域开关即时生效，spec §3.5）', async () => {
    const onIconsChanged = vi.fn();
    await reactToIconsChange(baseSettings(), vi.fn());
    expect(
      await reactToIconsChange(baseSettings({ scopes: { tree: true, tabs: true, quickOpen: false, search: false } }), onIconsChanged)
    ).toBe(true);
    expect(onIconsChanged).toHaveBeenCalledTimes(1);
  });

  it('无关字段变化：零应用零触发，返回 false', async () => {
    const onIconsChanged = vi.fn();
    await reactToIconsChange(baseSettings(), vi.fn());
    const unrelated: Settings = { ...baseSettings(), autoRefresh: false, excludedPatterns: ['.git'] };
    expect(await reactToIconsChange(unrelated, onIconsChanged)).toBe(false);
    expect(onIconsChanged).not.toHaveBeenCalled();
  });
});
