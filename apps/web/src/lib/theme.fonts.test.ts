// theme.fonts.test.ts — applyFonts（style#vv-font 注入）与 fonts 签名 diff 单测
// （spec 2026-10-19 字体系统 §2.2/§2.3，Task 1）。注入节点独立于外观注入
// （style#vv-code-theme）：字体变化不触发外观重注入，反之亦然。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyFonts,
  applyFontsFromSettings,
  codeLineHeight,
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_UI_FONT_STACK,
  fontSig
} from './theme';
import type { Settings } from './stores/settings';
import { DEFAULT_LAYOUT } from './layout';

const FONT_STYLE_ID = 'vv-font';

function fontEl(): HTMLStyleElement | null {
  return document.getElementById(FONT_STYLE_ID) as HTMLStyleElement | null;
}

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
    diagrams: { krokiHost: '', modes: {} },
    fonts: { uiFamily: '', uiSize: 16, codeFamily: '', codeSize: 13, ...fonts },
    layout: { ...DEFAULT_LAYOUT }
  };
}

afterEach(() => {
  document.head.innerHTML = '';
  vi.restoreAllMocks();
});

describe('codeLineHeight（行高公式：max(16, round(codeSize × 1.5))）', () => {
  it('边界：9→16（下限 clamp）、13→20（现值归一）、28→42', () => {
    expect(codeLineHeight(9)).toBe(16);
    expect(codeLineHeight(13)).toBe(20);
    expect(codeLineHeight(28)).toBe(42);
  });
});

describe('applyFonts（注入 style#vv-font）', () => {
  it('默认设置注入五个变量的现值：双默认栈 / 16px / 13px / 20px', () => {
    applyFonts(baseSettings());
    const el = fontEl();
    expect(el).not.toBeNull();
    const text = el!.textContent ?? '';
    expect(text).toContain(`--vv-ui-font: ${DEFAULT_UI_FONT_STACK};`);
    expect(text).toContain('--vv-ui-font-size: 16px;');
    expect(text).toContain(`--vv-code-font: ${DEFAULT_CODE_FONT_STACK};`);
    expect(text).toContain('--vv-code-font-size: 13px;');
    expect(text).toContain('--vv-code-line-height: 20px;');
  });

  it('自定义 codeFamily：引号对抗用例 a"b → 转义注入 + 回退栈收尾', () => {
    applyFonts(baseSettings({ codeFamily: 'a"b' }));
    const text = fontEl()?.textContent ?? '';
    expect(text).toContain(`--vv-code-font: "a\\"b", ${DEFAULT_CODE_FONT_STACK};`);
  });

  it('多级回退栈 A, B：整栈保留（不拆栈语义），逐段引号包裹 + 回退栈收尾', () => {
    applyFonts(baseSettings({ codeFamily: 'A, B' }));
    const text = fontEl()?.textContent ?? '';
    expect(text).toContain(`--vv-code-font: "A", "B", ${DEFAULT_CODE_FONT_STACK};`);
  });

  it('通用族关键字段不加引号（修复轮 m1）：JetBrains Mono, monospace 末段裸写——引号化即失效回退位', () => {
    applyFonts(baseSettings({ codeFamily: 'JetBrains Mono, monospace' }));
    const text = fontEl()?.textContent ?? '';
    expect(text).toContain(`--vv-code-font: "JetBrains Mono", monospace, ${DEFAULT_CODE_FONT_STACK};`);
    // 大小写不敏感（CSS 通用族关键字 case-insensitive）；原文大小写保留不改写
    applyFonts(baseSettings({ codeFamily: 'MONOSPACE' }));
    expect(fontEl()?.textContent).toContain(`--vv-code-font: MONOSPACE, ${DEFAULT_CODE_FONT_STACK};`);
    // uiFamily 槽同函数：混合栈同样裸写关键字段
    applyFonts(baseSettings({ uiFamily: 'My Font, system-ui' }));
    expect(fontEl()?.textContent).toContain(`--vv-ui-font: "My Font", system-ui, ${DEFAULT_UI_FONT_STACK};`);
  });

  it('通用族清单覆盖 CSS Fonts 4 全集（终审 M-3）：math/fangsong 裸写不引号', () => {
    applyFonts(baseSettings({ codeFamily: 'STIX Two Math, math' }));
    expect(fontEl()?.textContent).toContain(`--vv-code-font: "STIX Two Math", math, ${DEFAULT_CODE_FONT_STACK};`);
    applyFonts(baseSettings({ uiFamily: 'FangSong, fangsong' }));
    expect(fontEl()?.textContent).toContain(
      `--vv-ui-font: FangSong, fangsong, ${DEFAULT_UI_FONT_STACK};`
    );
  });

  it('uiFamily/uiSize 注入 body 槽变量；uiFamily 注入同样过引号转义', () => {
    applyFonts(baseSettings({ uiFamily: 'My; Font', uiSize: 22 }));
    const text = fontEl()?.textContent ?? '';
    expect(text).toContain('--vv-ui-font: "My; Font", ' + DEFAULT_UI_FONT_STACK + ';');
    expect(text).toContain('--vv-ui-font-size: 22px;');
  });

  it('行高随 codeSize 联动：codeSize 16 → line-height 24px', () => {
    applyFonts(baseSettings({ codeSize: 16 }));
    expect(fontEl()?.textContent).toContain('--vv-code-line-height: 24px;');
  });

  it('单节点幂等：两次注入不叠加 style 节点，内容整体替换', () => {
    applyFonts(baseSettings({ codeSize: 13 }));
    applyFonts(baseSettings({ codeSize: 16 }));
    expect(document.querySelectorAll(`#${FONT_STYLE_ID}`)).toHaveLength(1);
    const text = fontEl()?.textContent ?? '';
    expect(text).toContain('--vv-code-font-size: 16px;');
    expect(text).toContain('--vv-code-line-height: 24px;');
    expect(text).not.toContain('--vv-code-font-size: 13px;');
  });
});

describe('applyFontsFromSettings（fonts 签名 diff，spec §2.3）', () => {
  it('首调注入并返回 true（变更）；同签名重调不注入返回 false', () => {
    expect(applyFontsFromSettings(baseSettings())).toBe(true);
    const text = fontEl()?.textContent;
    expect(text).not.toBeNull();
    expect(applyFontsFromSettings(baseSettings())).toBe(false);
    expect(fontEl()?.textContent).toBe(text);
  });

  it('fonts 四元组任一变化 → 重注入返回 true；无关字段变化不注入返回 false', () => {
    applyFontsFromSettings(baseSettings());
    expect(applyFontsFromSettings(baseSettings({ codeSize: 16 }))).toBe(true);
    expect(applyFontsFromSettings(baseSettings({ codeSize: 16, uiFamily: 'X' }))).toBe(true);
    const unrelated = { ...baseSettings({ codeSize: 16, uiFamily: 'X' }), excludedPatterns: ['.git'] };
    expect(applyFontsFromSettings(unrelated)).toBe(false);
  });

  it('fonts 变化不触发外观重注入：无 style#vv-code-theme 节点、不派发 vv:appearance-applied', () => {
    const seen: Event[] = [];
    document.addEventListener('vv:appearance-applied', (e) => seen.push(e));
    applyFontsFromSettings(baseSettings());
    applyFontsFromSettings(baseSettings({ codeSize: 20 }));
    expect(document.getElementById('vv-code-theme')).toBeNull();
    expect(seen).toHaveLength(0);
  });
});

describe('fontSig（Task 2 订阅消费的四元组签名）', () => {
  it('同 fonts 同签名；任一字段变化即不同签名', () => {
    const a = fontSig(baseSettings());
    expect(fontSig(baseSettings())).toBe(a);
    expect(fontSig(baseSettings({ codeSize: 16 }))).not.toBe(a);
    expect(fontSig(baseSettings({ uiSize: 18 }))).not.toBe(a);
    expect(fontSig(baseSettings({ uiFamily: 'X' }))).not.toBe(a);
    expect(fontSig(baseSettings({ codeFamily: 'Y' }))).not.toBe(a);
  });
});

describe('app.css 变量化消费契约（CSS 变量 fallback 与 theme.ts 常量同源防漂移）', () => {
  const css = readFileSync(resolve(__dirname, '../app.css'), 'utf8');
  it(':root 默认值与 theme.ts 默认栈/现值字号一致', () => {
    expect(css).toContain(`--vv-code-font: ${DEFAULT_CODE_FONT_STACK};`);
    expect(css).toContain(`--vv-ui-font: ${DEFAULT_UI_FONT_STACK};`);
    expect(css).toContain('--vv-ui-font-size: 16px;');
    expect(css).toContain('--vv-code-font-size: 13px;');
  });
  it('消费点改变量：body 字族/字号、.vv-code-pre/.vv-hex-dump/.vv-jsonl-body 字号均走 var 且保留现值 fallback（终审 I-2：三消费面清零硬编码）', () => {
    expect(css).toMatch(/body \{[^}]*font-family: var\(--vv-ui-font, system-ui, -apple-system, sans-serif\)/);
    expect(css).toMatch(/body \{[^}]*font-size: var\(--vv-ui-font-size, 16px\)/);
    expect(css).toMatch(/\.vv-code-pre \{[^}]*font-size: var\(--vv-code-font-size, 13px\)/);
    expect(css).toMatch(/\.vv-hex-dump \{[^}]*font-size: var\(--vv-code-font-size, 12px\)/);
    expect(css).toMatch(/\.vv-jsonl-body \{[^}]*font-size: var\(--vv-code-font-size, 13px\)/);
  });
});
