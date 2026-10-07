import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { captureToCssClass, themeToCssVars } from '@vviewer/highlight';
import { renderLineHtml } from '@vviewer/render-text';
import {
  applyCodeTheme,
  CODE_CAPTURES,
  CURATED_CODE_THEMES,
  DEFAULT_CODE_THEME,
  effectiveMode,
  getTheme,
  listThemes
} from './theme';
import { loadSettings } from './stores/settings';

const STYLE_ID = 'vv-code-theme';

function styleEl(): HTMLStyleElement | null {
  return document.getElementById(STYLE_ID) as HTMLStyleElement | null;
}

afterEach(() => {
  document.head.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('applyCodeTheme（注入 style#vv-code-theme）', () => {
  it('注入含 --vv-ts-* 变量的单节点 style', async () => {
    await applyCodeTheme('serika-dark', 'dark');
    const el = styleEl();
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain('--vv-ts-keyword: #e29da7;');
    expect(el?.dataset.mode).toBe('dark');
  });

  it('单节点幂等：两次 apply 不叠加 style 节点，内容整体替换', async () => {
    await applyCodeTheme('serika-dark', 'dark');
    await applyCodeTheme('onelight', 'light');
    const els = document.querySelectorAll(`#${STYLE_ID}`);
    expect(els.length).toBe(1);
    expect(styleEl()?.textContent).toContain('--vv-ts-keyword: #b500a9;');
    expect(styleEl()?.textContent).not.toContain('#e29da7');
  });

  it('两主题切换 style 内容变化（与 themeToCssVars 输出一致）', async () => {
    await applyCodeTheme('serika-dark', 'dark');
    const before = styleEl()?.textContent;
    await applyCodeTheme('gruvbox', 'dark');
    const after = styleEl()?.textContent;
    expect(before).not.toBe(after);
    const gruvbox = await getTheme('gruvbox');
    expect(gruvbox).not.toBeNull();
    expect(after).toBe(
      `/* vviewer 代码主题：gruvbox（dark）——只换 CSS 变量，不重解析 */\n:root {\n${themeToCssVars(gruvbox!, CODE_CAPTURES)}\n}`
    );
  });

  it('未知主题：console.warn 且保持现有 style 不变', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await applyCodeTheme('serika-dark', 'dark');
    const before = styleEl()?.textContent;
    await applyCodeTheme('no-such-theme', 'dark');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(`#${STYLE_ID}`).length).toBe(1);
    expect(styleEl()?.textContent).toBe(before);
  });
});

describe('captureToCssClass 与 code.ts 类名对齐', () => {
  it('renderLineHtml 的 span class 与 captureToCssClass 推导一致', () => {
    for (const c of ['keyword', 'string.special', 'variable.builtin', 'constant.character.escape']) {
      const html = renderLineHtml('x', [{ start: 0, end: 1, capture: c }]);
      expect(html).toContain(`class="ts-${captureToCssClass(c)}"`);
    }
  });
});

describe('app.css 与 CODE_CAPTURES 对齐（.ts-* 规则双向覆盖）', () => {
  // vitest 会把 ?raw 的 css 导入桩成空串，故从文件系统读（根目录或 apps/web 两种 cwd 均可）
  const css = readFileSync(
    ['apps/web/src/app.css', 'src/app.css'].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );

  it('每个 CODE_CAPTURES capture 都有 .ts-<class> 颜色规则（回落 inherit）', () => {
    for (const c of CODE_CAPTURES) {
      const cls = captureToCssClass(c);
      expect(css, `缺少 .ts-${cls} 规则`).toContain(`.ts-${cls} { color: var(--vv-ts-${cls}, inherit); }`);
    }
  });

  it('app.css 中每个 .ts- 规则都来自 CODE_CAPTURES（无漂移）', () => {
    const rules = [...css.matchAll(/\.ts-([a-z0-9-]+) \{/g)].map((m) => m[1]);
    const expected = new Set(CODE_CAPTURES.map((c) => captureToCssClass(c)));
    for (const r of rules) expect(expected.has(r), `.ts-${r} 不在 CODE_CAPTURES`).toBe(true);
    expect(rules.length).toBe(expected.size);
  });
});

describe('主题清单与默认值', () => {
  it('listThemes 按字母排序且含精选与默认主题', async () => {
    const themes = await listThemes();
    expect(themes.length).toBeGreaterThan(200);
    expect([...themes].sort()).toEqual(themes);
    for (const t of [...CURATED_CODE_THEMES, DEFAULT_CODE_THEME.light, DEFAULT_CODE_THEME.dark]) {
      expect(themes).toContain(t);
    }
  });

  it('settings 默认代码主题真实存在于 themes.json', async () => {
    const s = loadSettings();
    const themes = await listThemes();
    expect(themes).toContain(s.codeThemeLight);
    expect(themes).toContain(s.codeThemeDark);
    expect(s.codeThemeLight).toBe(DEFAULT_CODE_THEME.light);
    expect(s.codeThemeDark).toBe(DEFAULT_CODE_THEME.dark);
  });

  it('精选主题无重复且都存在于全量清单', async () => {
    expect(new Set(CURATED_CODE_THEMES).size).toBe(CURATED_CODE_THEMES.length);
    const themes = new Set(await listThemes());
    expect(CURATED_CODE_THEMES.every((t) => themes.has(t))).toBe(true);
  });
});

describe('effectiveMode（system 解析为具体亮暗）', () => {
  it('light/dark 原样返回', () => {
    expect(effectiveMode('light')).toBe('light');
    expect(effectiveMode('dark')).toBe('dark');
  });

  it('system 按 prefers-color-scheme 解析（jsdom 无 matchMedia 时回落 light）', () => {
    expect(effectiveMode('system')).toBe('light');
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('dark') }));
    expect(effectiveMode('system')).toBe('dark');
  });
});
