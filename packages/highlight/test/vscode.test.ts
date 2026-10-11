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
  it('themeKind 缺省回归上游语义：缺省/light→light，dark→dark，hc-*→dark', () => {
    // VSCode uiTheme 的 type 缺省即 light（contributes.themes 缺 vs 选项按 light 处理）
    const kindOf = (t?: string) => {
      const r = validateVscodeTheme({ name: 'x', type: t, colors: { 'editor.background': '#111111' } });
      return r.ok ? r.theme.kind : 'rejected';
    };
    expect(kindOf(undefined)).toBe('light'); // 缺省 → light（终审 Minor 2：原误按 dark）
    expect(kindOf('light')).toBe('light');
    expect(kindOf('dark')).toBe('dark');
    expect(kindOf('hc-black')).toBe('dark'); // hc-* 归 dark（plan Global Constraints）不变
    expect(kindOf('hc-light')).toBe('dark');
  });
  it('色值白名单：colors 非法值逐键过滤、合法值保留（容错不整体拒绝）', () => {
    const r = validateVscodeTheme({
      name: 'x',
      type: 'dark',
      colors: {
        'editor.background': '#1f1f1f', // 合法 hex 保留
        'sideBar.background': 'red;}', // 含 ;} 的注入值 → 该键剔除
        'editor.foreground': 42 as unknown as string, // 数字 → 该键剔除
        'focusBorder': 'url(https://evil)' // 非 hex/rgb 形态 → 该键剔除
      }
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.theme.colors).toEqual({ 'editor.background': '#1f1f1f' });
  });
  it('色值白名单：foreground 非法（数字/含 ;}）的 tokenColors 规则整条跳过，合法规则保留', () => {
    const r = validateVscodeTheme({
      name: 'x',
      type: 'dark',
      tokenColors: [
        { scope: 'keyword', settings: { foreground: '#569cd6' } }, // 合法保留
        { scope: 'comment', settings: { foreground: 123 as unknown as string } }, // 数字 fg → 整条跳过
        { scope: 'string', settings: { foreground: '#ce9178;}' } }, // 注入值 → 整条跳过
        { scope: 'comment', settings: {} } // 无 foreground：保留（映射层本就跳过，行为不变）
      ]
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.theme.tokenColors).toEqual([{ scope: 'keyword', settings: { foreground: '#569cd6' } }, { scope: 'comment', settings: {} }]);
  });
  it('色值全部非法时过滤后两手全空 → 拒绝（至少其一非空）', () => {
    expect(
      validateVscodeTheme({ name: 'x', type: 'dark', colors: { 'editor.background': 'p;}' } }).ok
    ).toBe(false);
    expect(
      validateVscodeTheme({ name: 'x', type: 'dark', tokenColors: [{ scope: 'keyword', settings: { foreground: 1 as unknown as string } }] }).ok
    ).toBe(false);
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
  it('畸形 scope（数字/null/对象/数组含非字符串）不炸且跳过非法项', () => {
    // 导入 JSON 不可信：scope 形态异常不让单条坏规则炸掉映射（Markpad filter_map(as_str) 同精神）
    const t = tokenColorsToThemeTable(
      [
        { scope: 123 as unknown as string, settings: { foreground: '#111' } },
        { scope: null as unknown as string, settings: { foreground: '#222' } },
        { scope: { nested: true } as unknown as string, settings: { foreground: '#333' } },
        { scope: [1, 'a', null, 'keyword'] as unknown as string[], settings: { foreground: '#444' } },
      ],
      ['keyword'],
    );
    expect(t.keyword).toEqual({ fg: '#444' }); // 仅数组内合法的 'keyword' 生效
    expect(Object.keys(t)).toEqual(['keyword']);
  });
  it('foreground 白名单双重闸：数字/含 ;} 的 fg 直入映射层也被过滤（兜底存量主题）', () => {
    // 存量导入主题（早于 validate 收口）不经 validate 直读注入，映射层同规则兜底
    const t = tokenColorsToThemeTable(
      [
        { scope: 'keyword', settings: { foreground: '#569cd6' } },
        { scope: 'comment', settings: { foreground: 123 as unknown as string } },
        { scope: 'string', settings: { foreground: '#ce9178;}' } },
        { scope: 'entity.name.function', settings: { foreground: '#dcdcaa' } },
      ],
      ['keyword', 'comment', 'string', 'function'],
    );
    expect(t.keyword).toEqual({ fg: '#569cd6' });
    expect(t.function).toEqual({ fg: '#dcdcaa' });
    expect(t.comment).toBeUndefined();
    expect(t.string).toBeUndefined();
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
  it('色值白名单双重闸：已知键上非法值（;}/数字）不落注入文本', () => {
    const vars = colorsToUiVars({
      'editor.background': '#ffffff;}', // 注入值 → 跳过
      'focusBorder': 42 as unknown as string, // 数字 → 跳过
      'editor.foreground': 'rgb(31, 35, 40)' // rgb() 函数形态合法 → 保留
    });
    expect(vars).toEqual(['--ui-fg: rgb(31, 35, 40);']);
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
