/**
 * contrast.test.ts —— token 对比度机检（设计系统 ui-design-system.md §2.3 WCAG AA 闭环的
 * D14 配对穷举 + 三块级联同写等值机检）。只读解析 apps/web/src/app.css，零产品代码改动。
 *
 * 口径与纪律：
 * - 三块解析：首个 `:root`（light）、`:root[data-theme-mode="dark"]`、
 *   `@media (prefers-color-scheme: dark)` 内 `:root[data-theme-mode="system"]`。
 *   先全局剥 CSS 注释再切 decl——块内中文注释含 "4.5:1"/"2.95:1" 类半角冒号，
 *   不剥会污染 decl 切分（aelrova 同款坑）。
 * - 颜色形态：`#rgb`/`#rrggbb`/`rgb(r g b / a%)`/`rgba(r,g,b,a)`（本仓非 oklch）。
 *   α 合成在 sRGB gamma 空间：浏览器对 rgba() 的真实合成即按编码后通道线性混合，
 *   本仓 token 本就是编码通道，故为精确值而非近似（aelrova 的 oklch→linear sRGB
 *   需 linear 近似，形态不同不照搬）；设计系统 §2.3 表载实测锚值（fg/bg 亮 15.80 /
 *   暗 16.02、warning 亮 4.87/暗 7.50、暗双层 ≥4.94 等）即此口径，见对拍锚 describe。
 * - 配对清单（D14，穷举）：文本 16 对 ≥4.5:1；非文本 5 对 ≥3.0:1；hit 系叠加 8 组合
 *   （4 单层 + 2×2 mark×行态双层全矩阵，覆盖 app.css §12.3.5 注释「含双层在内六组合」
 *   口径的超集）≥4.5 vs code-fg；hljs 七色 ≥4.5 vs code-bg（实测全过，故入测不入豁免）。
 * - 知情维持豁免（不入清单，理由登记于 EXEMPT）：
 *   `--ui-border`——Primer border.default 同款立场：分隔线/装饰性边界豁免 WCAG 1.4.11
 *   （非文本对比仅约束「理解内容所必需」的部件），且控件另有 §7 全局 focus-visible
 *   焦点环与 hover 底色冗余提示；实测亮 #d0d7de 1.45:1 / 暗 #30363d 1.55:1。
 *   `--code-gutter`——行号辅助文本、GitHub 同款灰现值；实测亮 3.04 / 暗 4.12:1，
 *   达非文本线、知情维持未达正文 4.5。
 *   `--vv-scrim`——模态背板半遮罩，功能即压暗全屏的功能层，其上浮层自带完整底色
 *   对比，非「文字×底色」配对。
 * - 穷举纪律（机检承接待办）：每块颜色 token 集合必须 === 已测 ∪ 豁免。新增颜色 token
 *   不同步增补配对（或 EXEMPT 登记理由）即红，杜绝「加了 token 忘了对比度」。
 * - 三块级联同写纪律（机检承接 §2.2）：dark 块与 system 块 token 键集合一致 +
 *   逐 token 等值——漏块即 pdf-page-label 式事故、错块即暗值漂移。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_CSS = resolve(process.cwd(), 'apps/web/src/app.css');

interface TokenSet {
  [name: string]: string;
}
interface Srgb {
  r: number;
  g: number;
  b: number;
  alpha: number;
}
interface Channels {
  r: number;
  g: number;
  b: number;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseDecls(body: string): TokenSet {
  const tokens: TokenSet = {};
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const name = decl.slice(0, i).trim();
    if (name.startsWith('--')) tokens[name] = decl.slice(i + 1).trim();
  }
  return tokens;
}

function extractBlock(css: string, re: RegExp, label: string): TokenSet {
  const m = re.exec(css);
  expect(m, `app.css 应存在${label}块（结构变更须同步本机检）`).toBeTruthy();
  return parseDecls(m![1]!);
}

const css = stripComments(readFileSync(APP_CSS, 'utf-8'));
const light = extractBlock(css, /:root\s*\{([^}]*)\}/, ':root（light）');
const dark = extractBlock(css, /:root\[data-theme-mode="dark"\]\s*\{([^}]*)\}/, '[data-theme-mode="dark"]');
const system = extractBlock(
  css,
  /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\[data-theme-mode="system"\]\s*\{([^}]*)\}/,
  'media 内 [data-theme-mode="system"]'
);

const HEX3_RE = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGB_SPACE_RE = /^rgb\(\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*(?:\/\s*([\d.]+)\s*(%?)\s*)?\)$/;
const RGBA_COMMA_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*([\d.]+)\s*\)$/;

/** 解析为 0..1 的 sRGB gamma 编码通道 + α（α：`%` 形态除 100，裸值即 0..1 小数） */
function parseColor(value: string): Srgb {
  let m = HEX3_RE.exec(value);
  if (m) {
    const d = (s: string) => (parseInt(s, 16) * 16 + parseInt(s, 16)) / 255;
    return { r: d(m[1]!), g: d(m[2]!), b: d(m[3]!), alpha: 1 };
  }
  m = HEX6_RE.exec(value);
  if (m) return { r: parseInt(m[1]!, 16) / 255, g: parseInt(m[2]!, 16) / 255, b: parseInt(m[3]!, 16) / 255, alpha: 1 };
  m = RGB_SPACE_RE.exec(value);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[5] === '%' ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: Number(m[1]) / 255, g: Number(m[2]) / 255, b: Number(m[3]) / 255, alpha };
  }
  m = RGBA_COMMA_RE.exec(value);
  if (m) return { r: Number(m[1]) / 255, g: Number(m[2]) / 255, b: Number(m[3]) / 255, alpha: parseFloat(m[4]!) };
  throw new Error(`无法解析的 token 颜色值：${value}（机检只覆盖 #rgb/#rrggbb/rgb()/rgba()，新增形态须扩解析器）`);
}

/** sRGB gamma 解码（WCAG 2.1 官方分段；8-bit 通道值下 0.03928/0.04045 两阈值无差异） */
function linearChannel(c: number): number {
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** 底色链合成：layers[0] 为最底不透明底色，其后自底向顶逐层 α 混合（sRGB gamma 空间） */
function compositeLayers(layers: Srgb[]): Channels {
  let out: Channels = { r: layers[0]!.r, g: layers[0]!.g, b: layers[0]!.b };
  for (const layer of layers.slice(1)) {
    out = {
      r: layer.alpha * layer.r + (1 - layer.alpha) * out.r,
      g: layer.alpha * layer.g + (1 - layer.alpha) * out.g,
      b: layer.alpha * layer.b + (1 - layer.alpha) * out.b
    };
  }
  return out;
}

/** WCAG 2.1 相对亮度：linear 化后 0.2126/0.7152/0.0722 加权；透明色先对底合成 */
function relativeLuminance(color: Srgb, backdrop?: Channels): number {
  let { r, g, b } = color;
  if (color.alpha < 1 && backdrop) {
    r = color.alpha * r + (1 - color.alpha) * backdrop.r;
    g = color.alpha * g + (1 - color.alpha) * backdrop.g;
    b = color.alpha * b + (1 - color.alpha) * backdrop.b;
  }
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  return 0.2126 * linearChannel(clamp01(r)) + 0.7152 * linearChannel(clamp01(g)) + 0.0722 * linearChannel(clamp01(b));
}

/** 文本色（fg，透明则对底合成）× 底色链 的 WCAG 对比度 */
function contrastRatio(fg: Srgb, bgLayers: Srgb[]): number {
  const backdrop = compositeLayers(bgLayers);
  const l1 = relativeLuminance(fg, fg.alpha < 1 ? backdrop : undefined);
  const l2 = relativeLuminance({ ...backdrop, alpha: 1 });
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

function tokenOf(set: TokenSet, name: string): Srgb {
  const value = set[`--${name}`];
  expect(value, `token --${name} 未定义于解析块（配对清单与块内容脱节）`).toBeTruthy();
  return parseColor(value!);
}

/** 文本配对（≥4.5:1）——D14 清单原文顺序 */
const TEXT_PAIRS: Array<[string, string]> = [
  ['ui-fg', 'ui-bg'],
  ['ui-fg', 'ui-side-bg'],
  ['ui-fg', 'ui-tab-bg'],
  ['ui-fg', 'ui-tab-active-bg'],
  ['ui-fg', 'ui-input-bg'],
  ['ui-fg', 'ui-statusbar-bg'],
  ['ui-fg', 'ui-hover-bg'],
  ['ui-fg', 'ui-selection-bg'],
  ['ui-fg-muted', 'ui-bg'],
  ['ui-fg-muted', 'ui-side-bg'],
  ['ui-accent', 'ui-bg'],
  ['ui-danger', 'ui-bg'],
  ['ui-success', 'ui-bg'],
  ['ui-warning', 'ui-bg'],
  ['ui-accent-2', 'ui-bg'],
  ['code-fg', 'code-bg']
];

/** 非文本配对（≥3.0:1）——语义实心色/焦点环/图标底 */
const NON_TEXT_PAIRS: Array<[string, string]> = [
  ['ui-accent', 'ui-bg'],
  ['ui-danger', 'ui-bg'],
  ['ui-success', 'ui-bg'],
  ['ui-warning', 'ui-bg'],
  ['ui-accent-2', 'ui-bg']
];

/** hit 系单层（搜索命中底 × code-bg，其上文本为 code-fg） */
const HIT_SINGLES: string[] = ['vv-hit-bg', 'vv-hit-active', 'vv-hit-line', 'vv-hit-line-active'];

/** hit 系双层（mark 叠在行底之上——app.css §12.3.5 注释口径，2×2 全矩阵） */
const HIT_DOUBLES: Array<[string, string]> = [
  ['vv-hit-bg', 'vv-hit-line'],
  ['vv-hit-bg', 'vv-hit-line-active'],
  ['vv-hit-active', 'vv-hit-line'],
  ['vv-hit-active', 'vv-hit-line-active']
];

/** 语法高亮七色（三块均定义，实测全过 4.5，入测） */
const HLJS_TOKENS: string[] = ['hljs-keyword', 'hljs-string', 'hljs-comment', 'hljs-number', 'hljs-title', 'hljs-built_in', 'hljs-attr'];

/** hex 系命中（仅 :root 定义，暗色不覆盖恒用亮值） */
const HEX_TOKENS: string[] = ['vv-hex-hit', 'vv-hex-hit-active', 'vv-hex-flash'];

describe.each([
  ['light（:root）', light],
  ['dark（[data-theme-mode="dark"]）', dark],
  ['system（media 内 [data-theme-mode="system"]）', system]
])('对比度机检（%s）', (_label, tokens) => {
  it.each(TEXT_PAIRS)('文本配对 --%s / --%s ≥ 4.5:1', (fg, bg) => {
    const ratio = contrastRatio(tokenOf(tokens, fg), [tokenOf(tokens, bg)]);
    expect(ratio, `--${fg} / --${bg} 实测 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(NON_TEXT_PAIRS)('非文本配对 --%s / --%s ≥ 3.0:1', (fg, bg) => {
    const ratio = contrastRatio(tokenOf(tokens, fg), [tokenOf(tokens, bg)]);
    expect(ratio, `--${fg} / --${bg} 实测 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3.0);
  });

  it.each(HIT_SINGLES)('hit 单层 --%s / code-bg → code-fg ≥ 4.5:1', (mark) => {
    const ratio = contrastRatio(tokenOf(tokens, 'code-fg'), [tokenOf(tokens, 'code-bg'), tokenOf(tokens, mark)]);
    expect(ratio, `--${mark} 单层实测 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(HIT_DOUBLES)('hit 双层 --%s ⊥ --%s / code-bg → code-fg ≥ 4.5:1', (mark, row) => {
    const ratio = contrastRatio(tokenOf(tokens, 'code-fg'), [
      tokenOf(tokens, 'code-bg'),
      tokenOf(tokens, row),
      tokenOf(tokens, mark)
    ]);
    expect(ratio, `--${mark} ⊥ --${row} 实测 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(HLJS_TOKENS)('语法高亮 --%s / code-bg ≥ 4.5:1', (name) => {
    const ratio = contrastRatio(tokenOf(tokens, name), [tokenOf(tokens, 'code-bg')]);
    expect(ratio, `--${name} 实测 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

describe('hex 系命中（仅 :root 定义，暗色恒用亮值）', () => {
  it.each(HEX_TOKENS)('--%s / code-bg → code-fg ≥ 4.5:1', (name) => {
    const ratio = contrastRatio(tokenOf(light, 'code-fg'), [tokenOf(light, 'code-bg'), tokenOf(light, name)]);
    expect(ratio, `--${name} 实测 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });
});

describe('dark ≡ system（三块级联同写纪律 §2.2）', () => {
  const darkKeys = Object.keys(dark).sort();
  const systemKeys = Object.keys(system).sort();

  it('两块 token 键集合一致（漏块即叠加失守/主题漂移）', () => {
    expect(systemKeys, 'dark 与 system 块 token 集合须一致').toEqual(darkKeys);
  });

  it.each(darkKeys)('--%s 两块逐 token 等值', (key) => {
    expect(system[key], `--${key} 在 dark 与 system 两块取值不同`).toBe(dark[key]);
  });
});

const COLOR_VALUE_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$|^rgba?\(/i;

function colorTokensOf(set: TokenSet): string[] {
  return Object.keys(set)
    .filter((k) => COLOR_VALUE_RE.test(set[k]!))
    .sort();
}

/** 豁免登记（理由必填，见文件头注） */
const EXEMPT: Record<string, string> = {
  '--ui-border':
    'Primer border.default 同款知情维持：分隔线/装饰性边界豁免 WCAG 1.4.11（非「理解内容所必需」部件），控件另有 §7 focus-visible 焦点环与 hover 底色冗余提示；实测亮 1.45 / 暗 1.55:1',
  '--code-gutter':
    '行号辅助文本、GitHub 同款灰现值知情维持：实测亮 3.04 / 暗 4.12:1——达非文本线，未达正文 4.5',
  '--vv-scrim':
    '模态背板半遮罩：功能即压暗全屏的功能层，其上浮层自带完整底色对比，非「文字×底色」配对'
};

const TESTED = new Set<string>();
for (const [fg, bg] of [...TEXT_PAIRS, ...NON_TEXT_PAIRS]) {
  TESTED.add(`--${fg}`);
  TESTED.add(`--${bg}`);
}
for (const name of [...HIT_SINGLES, ...HLJS_TOKENS, ...HEX_TOKENS]) TESTED.add(`--${name}`);
for (const [mark, row] of HIT_DOUBLES) {
  TESTED.add(`--${mark}`);
  TESTED.add(`--${row}`);
}

const REQUIRED_LIGHT = [...TESTED, ...Object.keys(EXEMPT)].sort();
// hex 三枚仅 :root 定义、--vv-scrim 不做暗覆盖（暗色恒用亮值），不入暗块必需集
const REQUIRED_DARK = [...TESTED, ...Object.keys(EXEMPT)]
  .filter((n) => !HEX_TOKENS.includes(n.slice(2)) && n !== '--vv-scrim')
  .sort();

describe('清单穷举（新增颜色 token 必须同步增补配对或 EXEMPT 登记）', () => {
  it('light 块颜色 token 集合 === 已测 ∪ 豁免', () => {
    expect(colorTokensOf(light), `light 未纳管：${colorTokensOf(light).filter((n) => !REQUIRED_LIGHT.includes(n)).join(' ')}`).toEqual(REQUIRED_LIGHT);
  });

  it('dark 块颜色 token 集合 === 已测 ∪ 豁免', () => {
    expect(colorTokensOf(dark), `dark 未纳管：${colorTokensOf(dark).filter((n) => !REQUIRED_DARK.includes(n)).join(' ')}`).toEqual(REQUIRED_DARK);
  });

  it('system 块颜色 token 集合 === 已测 ∪ 豁免', () => {
    expect(colorTokensOf(system), `system 未纳管：${colorTokensOf(system).filter((n) => !REQUIRED_DARK.includes(n)).join(' ')}`).toEqual(REQUIRED_DARK);
  });
});

describe('转换函数正确性（对拍锚）', () => {
  it('白 #ffffff 相对亮度 ≈ 1；黑 #000000 ≈ 0', () => {
    expect(relativeLuminance(parseColor('#ffffff'))).toBeGreaterThan(0.99);
    expect(relativeLuminance(parseColor('#000000'))).toBeLessThan(0.01);
  });

  it('黑底白字对比度 ≈ 21', () => {
    expect(contrastRatio(parseColor('#ffffff'), [parseColor('#000000')])).toBeCloseTo(21, 0);
  });

  it('#1f2328 hex→sRGB 通道与手算亮度对拍（R31/G35/B40，亮度 ≈ 0.01646）', () => {
    const c = parseColor('#1f2328');
    expect(Math.round(c.r * 255)).toBe(31);
    expect(Math.round(c.g * 255)).toBe(35);
    expect(Math.round(c.b * 255)).toBe(40);
    // 手算：31/255→linear 0.013702、35/255→0.016806、40/255→0.021217，
    // 0.2126/0.7152/0.0722 加权 = 0.016464
    expect(relativeLuminance(c)).toBeCloseTo(0.01646, 4);
  });

  it('rgb() 空格形与 rgba() 逗号形的通道与 α 解析', () => {
    expect(parseColor('rgb(255 213 0 / 45%)')).toEqual({ r: 1, g: 213 / 255, b: 0, alpha: 0.45 });
    expect(parseColor('rgba(255, 176, 0, .22)')).toEqual({ r: 1, g: 176 / 255, b: 0, alpha: 0.22 });
    expect(parseColor('#abc')).toEqual({ r: 170 / 255, g: 187 / 255, b: 204 / 255, alpha: 1 });
  });

  it('α 合成口径锚：rgb(255 213 0 / 45%) 单层混入暗 code-bg 后 vs code-fg ≈ 4.61（§2.3 表载值）', () => {
    const ratio = contrastRatio(tokenOf(dark, 'code-fg'), [tokenOf(dark, 'code-bg'), parseColor('rgb(255 213 0 / 45%)')]);
    expect(ratio).toBeCloseTo(4.61, 1);
  });

  it('设计系统 §2.3 表载锚值：fg/bg 亮 15.80 / 暗 16.02、warning 亮 4.87 / 暗 7.50', () => {
    expect(contrastRatio(tokenOf(light, 'ui-fg'), [tokenOf(light, 'ui-bg')])).toBeCloseTo(15.8, 1);
    expect(contrastRatio(tokenOf(dark, 'ui-fg'), [tokenOf(dark, 'ui-bg')])).toBeCloseTo(16.02, 1);
    expect(contrastRatio(tokenOf(light, 'ui-warning'), [tokenOf(light, 'ui-bg')])).toBeCloseTo(4.87, 1);
    expect(contrastRatio(tokenOf(dark, 'ui-warning'), [tokenOf(dark, 'ui-bg')])).toBeCloseTo(7.5, 1);
  });

  it('app.css §12.3.5 注释锚：暗双层 hit-bg⊥hit-line-active ≈ 4.94（「六组合全 ≥4.94」下界）', () => {
    const ratio = contrastRatio(tokenOf(dark, 'code-fg'), [
      tokenOf(dark, 'code-bg'),
      tokenOf(dark, 'vv-hit-line-active'),
      tokenOf(dark, 'vv-hit-bg')
    ]);
    expect(ratio).toBeCloseTo(4.94, 1);
  });
});
