import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { captureToCssClass, resolveCapture, themeToCssVars } from '@vviewer/highlight';
import { renderLineHtml } from '@vviewer/render-text';
import {
  applyAppearance,
  applyCodeTheme,
  CODE_CAPTURES,
  CURATED_CODE_THEMES,
  DEFAULT_CODE_THEME,
  effectiveMode,
  getTheme,
  HLJS_CAPTURE_TO_VAR,
  listThemes,
  onSystemModeChange,
  THEME_ROOT_SELECTOR
} from './theme';
import { deleteTheme, putTheme, type ImportedTheme } from './stores/session';
import { loadSettings } from './stores/settings';

const STYLE_ID = 'vv-code-theme';

function styleEl(): HTMLStyleElement | null {
  return document.getElementById(STYLE_ID) as HTMLStyleElement | null;
}

/** 测试侧复算 hljs 近似映射期望输出（与 theme.ts 同一规则：命中取 fg，未命中跳过） */
function hljsVarsOf(theme: NonNullable<Awaited<ReturnType<typeof getTheme>>>): string {
  return HLJS_CAPTURE_TO_VAR
    .map(([capture, cssVar]) => {
      const fg = resolveCapture(theme, capture).fg;
      return fg ? `${cssVar}: ${fg};` : null;
    })
    .filter((s): s is string => s !== null)
    .join('\n');
}

/**
 * 旧 applyCodeTheme 时代注入文本的期望构造器（default 路径须逐字节等价）。
 * 新旧断言共用：theme.ts 内部重构（applyAppearance 接管注入）后仍锁同一文本。
 */
async function legacyExpectedText(name: string, mode: 'light' | 'dark'): Promise<string> {
  const theme = (await getTheme(name))!;
  return `/* vviewer 代码主题：${name}（${mode}）——只换 CSS 变量，不重解析 */\n${THEME_ROOT_SELECTOR} {\n${themeToCssVars(theme, [...CODE_CAPTURES])}\n${hljsVarsOf(theme)}\n}`;
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

  it('两主题切换 style 内容变化（与 themeToCssVars + hljs 映射输出一致）', async () => {
    await applyCodeTheme('serika-dark', 'dark');
    const before = styleEl()?.textContent;
    await applyCodeTheme('gruvbox', 'dark');
    const after = styleEl()?.textContent;
    expect(before).not.toBe(after);
    const gruvbox = await getTheme('gruvbox');
    expect(gruvbox).not.toBeNull();
    expect(after).toBe(await legacyExpectedText('gruvbox', 'dark'));
  });

  it('未知主题（残留下架名）：console.warn 并回退该亮暗槽位的默认主题', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await applyCodeTheme('no-such-theme', 'dark');
    expect(warn).toHaveBeenCalledTimes(1);
    const fallback = await getTheme(DEFAULT_CODE_THEME.dark);
    expect(fallback).not.toBeNull();
    // 回退后生效的是默认主题（serika-dark），而非保持无 style / 旧主题
    expect(styleEl()?.textContent).toBe(await legacyExpectedText(DEFAULT_CODE_THEME.dark, 'dark'));
  });

  it('onSystemModeChange：matchMedia 变化触发回调，解绑后不再触发', async () => {
    const listeners: Array<(e: MediaQueryListEvent) => void> = [];
    const fakeMq = {
      addEventListener: vi.fn((_t: string, cb: (e: MediaQueryListEvent) => void) => listeners.push(cb)),
      removeEventListener: vi.fn()
    } as unknown as MediaQueryList;
    const mm = vi.fn().mockReturnValue(fakeMq);
    vi.stubGlobal('matchMedia', mm);
    const seen: string[] = [];
    const off = onSystemModeChange((m) => seen.push(m));
    expect(mm).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    // 模拟亮/暗两次变化
    const ev = (matches: boolean) => ({ matches }) as unknown as MediaQueryListEvent;
    listeners[0]!(ev(true));
    listeners[0]!(ev(false));
    expect(seen).toEqual(['dark', 'light']);
    off();
    expect(fakeMq.removeEventListener).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('applyAppearance（B 项）', () => {
  it('default keeps legacy text identical', async () => {
    await applyAppearance('default', 'light', 'onelight');
    // 与 applyCodeTheme 时代文本逐字节等价（沿用既有精确断言文本）
    expect(styleEl()?.textContent).toBe(await legacyExpectedText('onelight', 'light'));
  });

  it('vscode ref injects UI vars + capture vars', async () => {
    await applyAppearance('vscode:Dark Modern', 'dark', 'serika-dark');
    const text = styleEl()?.textContent;
    expect(text).toContain('--ui-bg: #1F1F1F'); // dark_modern editor.background（上游为大写）
    expect(text).toContain('--vv-ts-comment: #6A9955');
    expect(styleEl()?.dataset.mode).toBe('dark');
  });

  it('unknown ref falls back to default with warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await applyAppearance('imported:ghost', 'light', 'onelight');
    expect(warn).toHaveBeenCalled();
    // 回退 default：注入文本与 default 路径一致
    expect(styleEl()?.textContent).toBe(await legacyExpectedText('onelight', 'light'));
    warn.mockRestore();
  });

  it('imported ref 命中 IndexedDB：按其 colors/tokenColors 注入，不 warn', async () => {
    const t: ImportedTheme = {
      id: 'imported:aaaa1111',
      name: 'Imported Owl',
      kind: 'dark',
      colors: { 'editor.background': '#011627' },
      tokenColors: [{ scope: 'keyword', settings: { foreground: '#c792ea' } }],
      source: 'json',
      addedAt: Date.now()
    };
    await putTheme(t);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await applyAppearance('imported:aaaa1111', 'dark', 'serika-dark');
    expect(warn).not.toHaveBeenCalled();
    const text = styleEl()?.textContent ?? '';
    expect(text).toContain('--ui-bg: #011627');
    expect(text).toContain('--vv-ts-keyword: #c792ea');
    expect(styleEl()?.dataset.mode).toBe('dark');
    await deleteTheme(t.id);
  });

  it('外观 colors 全缺时 UI vars 段为空：空段跳过不产出空行', async () => {
    const t: ImportedTheme = {
      id: 'imported:nocolor1',
      name: 'Token Only',
      kind: 'dark',
      colors: {},
      tokenColors: [{ scope: 'keyword', settings: { foreground: '#c792ea' } }],
      source: 'json',
      addedAt: Date.now()
    };
    await putTheme(t);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await applyAppearance('imported:nocolor1', 'dark', 'serika-dark');
    expect(warn).not.toHaveBeenCalled();
    const text = styleEl()?.textContent ?? '';
    expect(text).not.toContain('--ui-bg:'); // 无 colors → 无 UI vars
    expect(text).toContain('--vv-ts-keyword: #c792ea');
    expect(text).not.toContain('\n\n'); // 空段跳过：组装不残留空行
    await deleteTheme(t.id);
  });

  it('三段全空（无 colors 且 tokenColors 均无 foreground）：回退 default 注入文案不 warn', async () => {
    // validateVscodeTheme 只要求 colors/tokenColors 至少其一非空——settings 无
    // foreground 的 tokenColors 可通过校验却产不出任何变量（T4 顺手项边界）
    const t: ImportedTheme = {
      id: 'imported:emptysec',
      name: 'Empty Sections',
      kind: 'dark',
      colors: {},
      tokenColors: [{ scope: 'comment', settings: {} }],
      source: 'json',
      addedAt: Date.now()
    };
    await putTheme(t);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await applyAppearance('imported:emptysec', 'dark', 'serika-dark');
    expect(warn).not.toHaveBeenCalled(); // ref 可解析，非异常：静默回退
    expect(styleEl()?.textContent).toBe(await legacyExpectedText('serika-dark', 'dark'));
    await deleteTheme(t.id);
  });
});

describe('applyAppearance 并发弃单（spec：last-INITIATED 胜）', () => {
  it('先发慢调用（IndexedDB 宏任务）被后发快调用（缓存微任务）超越：终态=后发', async () => {
    // putTheme 写真库（fake-indexeddb）：imported 路径经 listImportedThemes 的
    // IndexedDB 回调（宏任务）恢复，必然晚于 default 路径的缓存 tablesPromise
    //（纯微任务）——token 规则下后发 p2 胜与完成顺序无关，断言确定性成立
    const theme: ImportedTheme = {
      id: 'imported:imp-race',
      name: 'Race Theme',
      kind: 'dark',
      colors: { 'editor.background': '#101010' },
      tokenColors: [],
      source: 'json',
      addedAt: 1
    };
    await putTheme(theme);
    const p1 = applyAppearance('imported:imp-race', 'dark', 'serika-dark');
    const p2 = applyAppearance('default', 'dark', 'onelight');
    await Promise.all([p1, p2]);
    expect(styleEl()?.textContent).toBe(await legacyExpectedText('onelight', 'dark'));
    await deleteTheme(theme.id);
  });
});

describe('hljs 兜底近似映射（M7 Task 3：--hljs-* 跟随代码主题）', () => {
  it('映射表恰为契约 9 条（capture → --hljs-* 变量）', () => {
    expect(HLJS_CAPTURE_TO_VAR).toEqual([
      ['keyword', '--hljs-keyword'],
      ['string', '--hljs-string'],
      ['comment', '--hljs-comment'],
      ['constant.numeric', '--hljs-number'],
      ['function', '--hljs-title'],
      ['type', '--hljs-type'],
      ['variable', '--hljs-variable'],
      ['tag', '--hljs-tag'],
      ['attribute', '--hljs-attr']
    ]);
  });

  it('applyCodeTheme 后 --hljs-* 有主题色值（resolveCapture 最长前缀回退），未命中不覆盖', async () => {
    await applyCodeTheme('gruvbox', 'dark');
    const theme = (await getTheme('gruvbox'))!;
    const text = styleEl()?.textContent ?? '';
    for (const [capture, cssVar] of HLJS_CAPTURE_TO_VAR) {
      const fg = resolveCapture(theme, capture).fg;
      if (fg) expect(text, `${cssVar} 应取 ${capture} 的 fg`).toContain(`${cssVar}: ${fg};`);
      else expect(text, `${capture} 无 fg 时不应输出 ${cssVar}`).not.toContain(`${cssVar}:`);
    }
  });

  it('切主题后 --hljs-* 变化（hljs 兜底着色跟随当前代码主题）', async () => {
    await applyCodeTheme('serika-dark', 'dark');
    const before = styleEl()?.textContent?.match(/--hljs-keyword: ([^;]+);/)?.[1];
    await applyCodeTheme('onelight', 'light');
    const after = styleEl()?.textContent?.match(/--hljs-keyword: ([^;]+);/)?.[1];
    expect(before).toBeTruthy();
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it('--hljs-* 与 --vv-ts-* 同在 style#vv-code-theme 单节点内（同一节点追加，不另开 style）', async () => {
    await applyCodeTheme('gruvbox', 'dark');
    expect(document.querySelectorAll(`#${STYLE_ID}`).length).toBe(1);
    const text = styleEl()?.textContent ?? '';
    expect(text).toContain('--vv-ts-keyword:');
    expect(text).toContain('--hljs-keyword:');
  });

  it('注入选择器包含全部四种 root 形态（暗色级联提权防回归）', async () => {
    // jsdom 不做真实 cascade：这里只锁注入文本的形态——app.css 暗色块
    // `:root[data-theme-mode="dark"]` 与 `@media dark :root[data-theme-mode="system"]`
    // specificity (0,2,0)，裸 `:root` 注入会被覆盖（暗色下 --hljs-* 回退默认值）；
    // 四形态列表使暗色形态拿到同等 specificity 靠文档序胜出。
    // 真实级联的最终裁决由 e2e/m7.spec.ts 的 computed style 抽查覆盖。
    await applyCodeTheme('gruvbox', 'dark');
    const text = styleEl()?.textContent ?? '';
    expect(text).toContain('/* vviewer 代码主题');
    expect(text).toContain('*/\n:root, :root[data-theme-mode="light"], :root[data-theme-mode="dark"], :root[data-theme-mode="system"] {');
    for (const form of [
      ':root,',
      ':root[data-theme-mode="light"],',
      ':root[data-theme-mode="dark"],',
      ':root[data-theme-mode="system"] {'
    ]) {
      expect(text, `注入规则缺少 root 形态 ${form}`).toContain(form);
    }
    expect(text).toContain('\n:root,'); // 变量体挂在提权选择器后（非裸 :root 单独成块）
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
    const rules = [...css.matchAll(/\.ts-([a-z0-9-]+) \{/g)].map((m) => m[1]!);
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
