// shellCss.test.ts — 扩展壳样式常量契约（spec H T1 Step 2）。
//
// 覆盖面（计划 T1 Step 2 明列）：SHELL_CSS 非空；含壳类名；全部颜色/尺寸走
// `var(--token, 默认值)` 形态、不出现 `:root` 令牌定义——与 markdown.css 的 token 契约同族。
//
// 断言口径（把「同族契约」落成可机检的六条）：
// ① 非空 + 含壳类名锚（类名即 T3 壳 DOM 的契约，改名即视觉漂移）。
// ② 不出现 `:root` 选择器（不定义令牌块）。
// ③ 零新 token：全文无自定义属性声明（`--x:`）——只引用既有 `--ui-*`/`--code-*`/`--vv-*` 家族。
// ④ 每个 `var(--x)` 引用都带缺省（无裸 `var(--x)` 形态）。
// ⑤ 颜色类声明：值经 var() 表达式剥离后不得残留颜色字面量；除「纯 transparent/none
//    关键字」外必须含 `var(--token, 缺省)` 引用。
// ⑥ 尺寸类声明分两档：有既有令牌族可依的（间距/字号/圆角/行高）必须走 var()；
//    无令牌族可依的几何（宽高）必须是无色字面量长度。
import { describe, it, expect } from 'vitest';
import { SHELL_CSS } from '../src/webview/shellCss';

/** 去注释后的 CSS（注释内的类名/令牌不算契约面） */
const CSS = SHELL_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** 颜色承载属性（border-radius 等非颜色属性不在此列） */
const COLOR_PROPS = new Set([
  'color',
  'background',
  'background-color',
  'background-image',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline',
  'outline-color',
  'box-shadow',
  'fill',
  'stroke',
  'text-decoration-color',
  'accent-color',
  'caret-color'
]);

/** 有既有令牌族可依的尺寸属性（必须走 var(--token, 缺省)） */
const TOKEN_DRIVEN_SIZE_PROPS = new Set([
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'gap',
  'row-gap',
  'column-gap',
  'font-size',
  'line-height',
  'border-radius'
]);

/** 无令牌族可依的几何属性（必须是无色字面量长度） */
const GEOMETRY_SIZE_PROPS = new Set(['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height']);

/** 颜色字面量（hex / 色彩函数 / 常见具名色） */
const COLOR_LITERAL_RE =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|color)\s*\(|\b(?:white|black|red|green|blue|yellow|orange|purple|pink|brown|gray|grey|silver|gold|cyan|magenta|teal|navy|maroon|olive|lime|aqua|fuchsia|beige|ivory|coral|salmon|khaki|plum|orchid|tan|azure|lavender|indigo|violet|crimson)\b/i;

/** 允许的无主关键字（透明/无绘制，非主题色） */
const NEUTRAL_KEYWORDS = new Set(['none', 'transparent', 'inherit', 'initial', 'unset', 'auto', 'revert']);

/** 抽掉 var(--x, fallback) 表达式（含嵌套括号），返回残余文本 */
function stripVarExpressions(value: string): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf('var(', i);
    if (at < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    let depth = 0;
    let j = at;
    for (; j < value.length; j++) {
      if (value[j] === '(') depth++;
      else if (value[j] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    i = j + 1;
  }
  return out;
}

/** 逐条声明（prop: value） */
function declarations(css: string): Array<{ prop: string; value: string }> {
  const out: Array<{ prop: string; value: string }> = [];
  const re = /([a-zA-Z-]+)\s*:\s*([^;{}]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const prop = m[1]!.toLowerCase();
    if (prop.startsWith('--')) continue; // 自定义属性声明另行断言
    out.push({ prop, value: m[2]!.trim() });
  }
  return out;
}

describe('SHELL_CSS · 契约', () => {
  it('非空且含壳类名锚（T3 壳 DOM 的类名契约）', () => {
    expect(SHELL_CSS.length).toBeGreaterThan(0);
    for (const cls of [
      '.vv-shell',
      '.vv-shell__body',
      '.vv-shell__main',
      '.vv-shell__toc',
      '.vv-shell__toc--left',
      '.vv-shell__toc-head',
      '.vv-shell__toc-badge',
      '.vv-shell__toc-toggle',
      '.vv-shell__toc-list',
      '.vv-shell__toc-item',
      '.vv-shell__notice'
    ]) {
      expect(CSS).toContain(cls);
    }
  });

  it('不出现 :root 令牌块', () => {
    expect(CSS).not.toContain(':root');
  });

  it('零新 token：无自定义属性声明', () => {
    expect(/--[a-z0-9-]+\s*:/i.test(CSS)).toBe(false);
  });

  it('每个 var(--x) 引用都带缺省（无裸 var(--x) 形态）', () => {
    const bare = CSS.match(/var\(\s*--[a-z0-9-]+\s*\)/gi);
    expect(bare).toBeNull();
  });

  it('颜色类声明走 var(--token, 缺省)；残余不得有颜色字面量', () => {
    const decls = declarations(CSS).filter((d) => COLOR_PROPS.has(d.prop));
    expect(decls.length).toBeGreaterThan(0);
    for (const d of decls) {
      const rest = stripVarExpressions(d.value).trim();
      expect(rest, `声明 ${d.prop}: ${d.value} 残留颜色字面量`).not.toMatch(COLOR_LITERAL_RE);
      const neutral = NEUTRAL_KEYWORDS.has(rest.toLowerCase());
      if (!neutral) {
        expect(d.value, `颜色声明 ${d.prop}: ${d.value} 未走 var(--token, 缺省)`).toMatch(/var\(\s*--[a-z0-9-]+\s*,/i);
      }
    }
  });

  it('尺寸类声明：有令牌族可依的走 var()，几何为无色字面量长度', () => {
    const decls = declarations(CSS);
    for (const d of decls) {
      if (TOKEN_DRIVEN_SIZE_PROPS.has(d.prop)) {
        // 零值与 auto 无需令牌（无间距/自动外边距）；line-height 可为无单位行高比
        if (/^0(?:px|rem|em)?$/.test(d.value) || d.value.toLowerCase() === 'auto') continue;
        if (d.prop === 'line-height' && /^\d+(?:\.\d+)?$/.test(d.value)) continue;
        expect(d.value, `尺寸声明 ${d.prop}: ${d.value} 未走 var(--token, 缺省)`).toMatch(/var\(\s*--[a-z0-9-]+\s*,/i);
      }
      if (GEOMETRY_SIZE_PROPS.has(d.prop)) {
        const rest = stripVarExpressions(d.value).trim();
        expect(rest, `几何声明 ${d.prop}: ${d.value} 残留颜色字面量`).not.toMatch(COLOR_LITERAL_RE);
      }
    }
  });

  it('全文无颜色字面量（var() 缺省值内的除外）', () => {
    const withoutVars = stripVarExpressions(CSS);
    // 逐条声明粒度复核（去注释后无类名/选择器噪声）
    for (const d of declarations(withoutVars)) {
      expect(d.value, `声明 ${d.prop}: ${d.value} 含颜色字面量`).not.toMatch(COLOR_LITERAL_RE);
    }
  });

  it('焦点环可见：用 --ui-accent 且不抹焦点（无 outline: none）', () => {
    expect(CSS).toContain(':focus-visible');
    expect(CSS).toMatch(/:focus-visible\s*\{[^}]*var\(\s*--ui-accent\s*,/);
    expect(CSS).not.toMatch(/outline\s*:\s*(none|hidden)/i);
  });

  it('零动效（无 transition/animation——reduced-motion 门控义务不成立）', () => {
    expect(CSS).not.toMatch(/transition\s*:/i);
    expect(CSS).not.toMatch(/animation\s*:/i);
  });

  it('提示条与折叠态有可挂 a11y 属主的类（宿主挂 role=status / aria-expanded）', () => {
    expect(CSS).toContain('.vv-shell__notice');
    expect(CSS).toContain('[data-collapsed="true"]');
    expect(CSS).toContain('.vv-shell__notice--warn');
    expect(CSS).toContain('.vv-shell__notice--error');
  });
});
