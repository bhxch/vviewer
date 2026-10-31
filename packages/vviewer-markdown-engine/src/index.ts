// index.ts — @bhxch/vviewer-markdown-engine 包根导出面：markdown→HTML 引擎预设
// （markdown-it GFM 全家装配 + GFM slug 锚 + LaTeX 定界符保护 + front matter），
// 面向任何 markdown-it 项目的即插预设。跨包消费一律经包根 import。
export {
  createMarkdownEngine,
  renderMarkdownToHtml,
  protectLatexDelimiters,
  GfmAnchorizer,
  type MarkdownEngine,
  type MarkdownRenderResult,
} from './engine';
export { parseFrontMatter, type FrontMatterResult } from './frontMatter';
