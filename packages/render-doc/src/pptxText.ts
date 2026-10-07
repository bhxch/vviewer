// pptxText.ts — pptx 幻灯片文本提取纯函数（无 DOM/依赖，单测直测；模式同 pdfText.ts）。
// pptx 渲染为降级路径（SDD Task 5 裁决）：无合格可视化预览库（pptx-preview ISC/
// 无仓库主页/强依赖 echarts，见任务报告），降级为逐页文本提纲。

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
};

/** 解码 XML 预定义实体与十进制/十六进制字符引用；未知实体原样保留 */
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (raw, body: string) => {
    let code: number | null = null;
    if (body.startsWith('#x') || body.startsWith('#X')) code = parseInt(body.slice(2), 16);
    else if (body.startsWith('#')) code = parseInt(body.slice(1), 10);
    if (code !== null) {
      // Number.isNaN：坏引用；> 0x10FFFF：fromCodePoint 会抛 RangeError，均原样保留
      if (Number.isNaN(code) || code > 0x10ffff || code < 0) return raw;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? raw;
  });
}

/**
 * 从 slideN.xml 提取文本行：一个 <a:p> 段落为一行，段内 <a:t> 文本 run 直接拼接
 * （a:br 换行 run 不产生新行——提纲视图不还原段落内换行）。a:p/a:t 均不嵌套自身，
 * 非贪婪匹配安全；表格/图表内文本同为 a:t，自然纳入提纲。
 */
export function extractSlideLines(slideXml: string): string[] {
  const lines: string[] = [];
  for (const p of slideXml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)) {
    let line = '';
    for (const t of (p[1] ?? '').matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)) {
      line += decodeXmlEntities(t[1] ?? '');
    }
    lines.push(line);
  }
  return lines;
}
