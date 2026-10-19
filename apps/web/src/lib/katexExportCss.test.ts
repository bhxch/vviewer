// katexExportCss.test.ts — 导出用 KaTeX 排印样式装配（Task 2b）：真实读取构建期
// 内联资产（vitest 走 vite 转换管线，?raw/?inline 可用），断言自包含语义——字体
// 全部 data URI 化、外链归零、katex 规则在。
import { describe, expect, it } from 'vitest';
import { buildKatexExportCss } from './katexExportCss';

describe('buildKatexExportCss——自包含排印样式', () => {
  const css = buildKatexExportCss();

  it('katex 规则与 20 个 @font-face 全在（woff2 内联为 data URI）', () => {
    expect(css).toContain('.katex');
    expect(css.match(/@font-face/g)?.length).toBe(20);
    expect(css.match(/data:font\/woff2;base64,/g)?.length).toBe(20);
    expect(css.match(/format\("woff2"\)/g)?.length).toBe(20);
  });

  it('外链归零：不含任何 fonts/ 相对引用与 woff/ttf 回退段（导出单文件死链不残留）', () => {
    expect(css).not.toContain('fonts/KaTeX_');
    expect(css).not.toContain('format("woff")');
    expect(css).not.toContain('format("truetype")');
  });
});
