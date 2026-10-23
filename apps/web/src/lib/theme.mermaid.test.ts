// theme.mermaid.test.ts — mermaid 主题映射与外观派发（Task 5，spec §2.3）。
// 映射纯函数主测在此（apps/web/src/lib/theme.ts 单一来源）；render-text 侧不持副本，
// 注入通道透传断言见 packages/render-text/src/markdown/pipeline.mermaidTheme.test.ts。
import { expect, it } from 'vitest';
import { applyAppearanceFromSettings, resolveMermaidTheme } from './theme';
import type { Settings } from './stores/settings';
import { DEFAULT_LAYOUT } from './layout';

it('resolveMermaidTheme 映射：dark→dark，light→default', () => {
  expect(resolveMermaidTheme('dark')).toBe('dark');
  expect(resolveMermaidTheme('light')).toBe('default');
});

/** 最小 Settings 构造（未覆盖字段取与 stores/settings DEFAULTS 一致的合法值）。 */
function settings(over: Partial<Settings> = {}): Settings {
  return {
    themeMode: 'light',
    appearanceLight: 'default',
    appearanceDark: 'default',
    codeThemeLight: 'onelight',
    codeThemeDark: 'serika-dark',
    excludedPatterns: [],
    autoRefresh: true,
    computePolicy: 'auto',
    diagrams: { krokiHost: '', krokiVia: 'client', modes: {} },
    fonts: { uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13 },
    layout: { ...DEFAULT_LAYOUT },
    ...over
  };
}

it('applyAppearanceFromSettings 派发 vv:appearance-applied：detail.mermaidTheme 随生效亮暗（Task 6 注入器/markdownRenderer 同源消费）', () => {
  const seen: Array<'default' | 'dark' | undefined> = [];
  const on = (ev: Event): void => {
    seen.push((ev as CustomEvent<{ mermaidTheme?: 'default' | 'dark' }>).detail?.mermaidTheme);
  };
  document.addEventListener('vv:appearance-applied', on);
  try {
    applyAppearanceFromSettings(settings({ themeMode: 'dark' }));
    expect(seen).toEqual(['dark']);
    applyAppearanceFromSettings(settings({ themeMode: 'light' }));
    expect(seen).toEqual(['dark', 'default']);
  } finally {
    document.removeEventListener('vv:appearance-applied', on);
  }
});
