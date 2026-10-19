// katexExportCss.ts — 导出用 KaTeX 排印样式装配（md-export Task 2b，spec §6 全嵌
// 上限形态；「按文档实际用到的字体族裁剪」列未来优化，spec 二选一取全嵌并注记）。
// 独立模块供 MetaPanel 动态 import（点击导出才加载）：katex.min.css 文本 + 20 个
// woff2 data URI 总计约 500KB，不进主包 chunk。读取走 vite 资产后缀（?raw/?inline，
// 构建期内联），apps/web 侧不做运行时 fs——纯函数 collectExportHtml 的 katexCss
// 选项由本模块产出文本传入。
import katexCssRaw from 'katex/dist/katex.min.css?raw';
import katexAmsRegular from 'katex/dist/fonts/KaTeX_AMS-Regular.woff2?inline';
import katexCaligraphicBold from 'katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?inline';
import katexCaligraphicRegular from 'katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?inline';
import katexFrakturBold from 'katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?inline';
import katexFrakturRegular from 'katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?inline';
import katexMainBold from 'katex/dist/fonts/KaTeX_Main-Bold.woff2?inline';
import katexMainBoldItalic from 'katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?inline';
import katexMainItalic from 'katex/dist/fonts/KaTeX_Main-Italic.woff2?inline';
import katexMainRegular from 'katex/dist/fonts/KaTeX_Main-Regular.woff2?inline';
import katexMathBoldItalic from 'katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?inline';
import katexMathItalic from 'katex/dist/fonts/KaTeX_Math-Italic.woff2?inline';
import katexSansSerifBold from 'katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?inline';
import katexSansSerifItalic from 'katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?inline';
import katexSansSerifRegular from 'katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?inline';
import katexScriptRegular from 'katex/dist/fonts/KaTeX_Script-Regular.woff2?inline';
import katexSize1Regular from 'katex/dist/fonts/KaTeX_Size1-Regular.woff2?inline';
import katexSize2Regular from 'katex/dist/fonts/KaTeX_Size2-Regular.woff2?inline';
import katexSize3Regular from 'katex/dist/fonts/KaTeX_Size3-Regular.woff2?inline';
import katexSize4Regular from 'katex/dist/fonts/KaTeX_Size4-Regular.woff2?inline';
import katexTypewriterRegular from 'katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?inline';

/** 字体文件名 → data URI（vite ?inline 产出 data:font/woff2;base64,…）。键与
 * katex.min.css 内 url(fonts/KaTeX_*.woff2) 的文件名对齐（实读 dist/fonts 清单，
 * 20 个 woff2 全集；woff/ttf 回退段不内联——见下方移除逻辑）。 */
const FONT_DATA_URIS: ReadonlyMap<string, string> = new Map([
  ['KaTeX_AMS-Regular.woff2', katexAmsRegular],
  ['KaTeX_Caligraphic-Bold.woff2', katexCaligraphicBold],
  ['KaTeX_Caligraphic-Regular.woff2', katexCaligraphicRegular],
  ['KaTeX_Fraktur-Bold.woff2', katexFrakturBold],
  ['KaTeX_Fraktur-Regular.woff2', katexFrakturRegular],
  ['KaTeX_Main-Bold.woff2', katexMainBold],
  ['KaTeX_Main-BoldItalic.woff2', katexMainBoldItalic],
  ['KaTeX_Main-Italic.woff2', katexMainItalic],
  ['KaTeX_Main-Regular.woff2', katexMainRegular],
  ['KaTeX_Math-BoldItalic.woff2', katexMathBoldItalic],
  ['KaTeX_Math-Italic.woff2', katexMathItalic],
  ['KaTeX_SansSerif-Bold.woff2', katexSansSerifBold],
  ['KaTeX_SansSerif-Italic.woff2', katexSansSerifItalic],
  ['KaTeX_SansSerif-Regular.woff2', katexSansSerifRegular],
  ['KaTeX_Script-Regular.woff2', katexScriptRegular],
  ['KaTeX_Size1-Regular.woff2', katexSize1Regular],
  ['KaTeX_Size2-Regular.woff2', katexSize2Regular],
  ['KaTeX_Size3-Regular.woff2', katexSize3Regular],
  ['KaTeX_Size4-Regular.woff2', katexSize4Regular],
  ['KaTeX_Typewriter-Regular.woff2', katexTypewriterRegular]
]);

/**
 * katex.min.css → 自包含排印样式文本：woff2 url 逐个替换为 data URI；woff/ttf
 * 回退段移除（导出单文件无相对资产可引，现代浏览器 woff2 全覆盖，留着即死链）。
 * 替换后产物不含任何 fonts/ 相对引用（外链 katex url 零残留）。
 */
export function buildKatexExportCss(): string {
  return katexCssRaw
    .replace(/url\(fonts\/(KaTeX_[\w-]+\.woff2)\)/g, (whole, file: string) => {
      const dataUri = FONT_DATA_URIS.get(file);
      return dataUri !== undefined ? `url(${dataUri})` : whole; // 未知字体保留原样（清单漂移由测试抓住）
    })
    .replace(/,?url\(fonts\/KaTeX_[\w-]+\.woff\) format\("woff"\)/g, '')
    .replace(/,?url\(fonts\/KaTeX_[\w-]+\.ttf\) format\("truetype"\)/g, '');
}
