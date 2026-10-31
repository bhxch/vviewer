// markdown-it-footnote 4.x 无自带类型（MIT，协议见 THIRD_PARTY_NOTICES.md）；
// 仅用其默认导出作为 markdown-it 插件。
declare module 'markdown-it-footnote' {
  import type { MarkdownIt } from 'markdown-it';
  const plugin: (md: MarkdownIt) => void;
  export default plugin;
}
