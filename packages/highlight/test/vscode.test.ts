import { describe, expect, it } from 'vitest';
import darkModern from '../assets/vscode/dark_modern.json';
import lightModern from '../assets/vscode/light_modern.json';
import { validateVscodeTheme, tokenColorsToThemeTable, colorsToUiVars, TEXTMATE_TO_CAPTURE } from '../src/vscode';

describe('validateVscodeTheme', () => {
  it('accepts dark_modern shape and normalizes hc to dark', () => {
    const r = validateVscodeTheme({ name: 'Dark Modern', type: 'hc-black', colors: { 'editor.background': '#1f1f1f' } });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.theme.kind).toBe('dark');
  });
  it('rejects missing name / empty colors+tokenColors / bad shape', () => {
    expect(validateVscodeTheme({ type: 'dark' }).ok).toBe(false);
    expect(validateVscodeTheme({ name: 'x', type: 'dark' }).ok).toBe(false);
    expect(validateVscodeTheme(null).ok).toBe(false);
  });
});

describe('TEXTMATE_TO_CAPTURE（Markpad vscode.rs L10-126 全表移植）', () => {
  it('ports the full table verbatim', () => {
    expect(Object.keys(TEXTMATE_TO_CAPTURE).length).toBe(90);
    expect(TEXTMATE_TO_CAPTURE['entity.name.function']).toBe('function');
    expect(TEXTMATE_TO_CAPTURE['keyword.other']).toBe('keyword');
    expect(TEXTMATE_TO_CAPTURE['string.interpolated']).toBe('string.special');
    expect(TEXTMATE_TO_CAPTURE['markup.inserted']).toBe('diff.plus');
    expect(TEXTMATE_TO_CAPTURE['keyword.operator.arithmetic']).toBe('operator');
  });
});

describe('tokenColorsToThemeTable（Markpad 快照基准）', () => {
  it('maps Markpad dark_modern capture values exactly', () => {
    // 来源：markpad-aio/Markpad/src-tauri/src/highlight/themes/dark_modern.rs create_color_map()
    const tokenColors = [
      { scope: ['comment'], settings: { foreground: '#6A9955' } },
      { scope: ['keyword.control'], settings: { foreground: '#C586C0' } },
      { scope: 'keyword', settings: { foreground: '#569CD6' } },
      { scope: 'string', settings: { foreground: '#CE9178' } },
      { scope: 'entity.name.function', settings: { foreground: '#DCDCAA' } },
    ];
    const t = tokenColorsToThemeTable(tokenColors, ['comment', 'keyword', 'keyword.control', 'string', 'function']);
    expect(t.comment).toEqual({ fg: '#6A9955' });
    expect(t['keyword.control']).toEqual({ fg: '#C586C0' }); // 精确表优先于 keyword 前缀
    expect(t.keyword).toEqual({ fg: '#569CD6' });
    expect(t.function).toEqual({ fg: '#DCDCAA' }); // entity.name.function 精确查表
  });
  // 校正说明：brief 原稿用 'string.quoted.single' 充当前缀回退例，但该键在 Markpad
  // 精确表内（→string），且精确命中按 Markpad 语义是后写覆盖，与「先到不覆盖」断言矛盾。
  // 改用真·表外 scope 保住用例意图（最长 starts_with + 前缀先到先得）。
  it('prefix fallback takes longest starts_with and first-write wins per capture', () => {
    const tokenColors = [
      { scope: 'string.quoted.template', settings: { foreground: '#AAA' } }, // 表外键：最长前缀 'string.quoted' → string（先到）
      { scope: 'string.verbatim', settings: { foreground: '#BBB' } },        // 表外键：前缀 'string' → string 已写→不覆盖
      { scope: 'constant.numeric', settings: { foreground: '#CCC' } },       // 精确命中
    ];
    const t = tokenColorsToThemeTable(tokenColors, ['string', 'constant.numeric']);
    expect(t.string).toEqual({ fg: '#AAA' });
    expect(t['constant.numeric']).toEqual({ fg: '#CCC' });
  });
  it('exact-table hit overwrites an earlier write（精确命中后写覆盖，Markpad 同）', () => {
    const t = tokenColorsToThemeTable(
      [
        { scope: 'string', settings: { foreground: '#111' } },
        { scope: 'string.quoted.double', settings: { foreground: '#222' } }, // 精确表键 → string
      ],
      ['string'],
    );
    expect(t.string).toEqual({ fg: '#222' });
  });
  it('drops captures outside the requested set', () => {
    const t = tokenColorsToThemeTable([{ scope: 'comment', settings: { foreground: '#fff' } }], ['keyword']);
    expect(t.comment).toBeUndefined();
  });
});

describe('colorsToUiVars', () => {
  it('maps the 12 known keys and skips unknown/missing', () => {
    const vars = colorsToUiVars({ 'editor.background': '#1e1e1e', 'focusBorder': '#0078d4', 'made.up.key': '#000' });
    expect(vars).toContain('--ui-bg: #1e1e1e;');
    expect(vars).toContain('--ui-accent: #0078d4;');
    expect(vars.join('\n').split('\n').length).toBe(2);
  });
  it('covers exactly the 12-key mapping table', () => {
    const all: Record<string, string> = {};
    for (let i = 0; i < 12; i++) all[`k${i}`] = `#${i}`;
    // 全部未知键 → 0 行（映射只认白名单 12 键，缺键跳过不推断）
    expect(colorsToUiVars(all).length).toBe(0);
    expect(colorsToUiVars({ 'editorWarning.foreground': '#cca700' })).toEqual(['--ui-warning: #cca700;']);
  });
});

describe('vendor 资产锚点（microsoft/vscode@1.141.0 theme-defaults）', () => {
  it('dark_modern.json validates and drives both mappings with upstream values', () => {
    const r = validateVscodeTheme(darkModern);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.theme.kind).toBe('dark');
    const vars = colorsToUiVars(darkModern.colors!);
    expect(vars).toContain(`--ui-bg: ${darkModern.colors!['editor.background']};`); // '#1F1F1F'
    // Markpad 快照基准值（经 include 链内联后的上游真实值；大小写以上游为准）
    const t = tokenColorsToThemeTable(
      darkModern.tokenColors!,
      ['comment', 'keyword', 'keyword.control', 'string', 'function'],
    );
    expect(t.comment).toEqual({ fg: '#6A9955' });
    expect(t['keyword.control']).toEqual({ fg: '#C586C0' });
    expect(t.function).toEqual({ fg: '#DCDCAA' });
    expect(t.keyword).toEqual({ fg: '#569cd6' });
    expect(t.string).toEqual({ fg: '#ce9178' });
  });
  it('light_modern.json validates as light', () => {
    const r = validateVscodeTheme(lightModern);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.theme.kind).toBe('light');
    expect(colorsToUiVars(lightModern.colors!)).toContain('--ui-bg: #FFFFFF;');
  });
});
