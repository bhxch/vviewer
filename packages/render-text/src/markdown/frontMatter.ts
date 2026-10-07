// frontMatter.ts — markdown 源文首部 `---` YAML 块的定位与解析。
// 移植自 markpad src/lib/utils/frontMatter.ts（findFrontMatterRange / 映射校验规则），
// 按 vviewer 契约裁剪：解析失败返回 frontMatter=null 且原文整体渲染（不剥离）。
import { parse } from 'yaml';

export interface FrontMatterResult {
  /** 解析成功且为映射（可为空对象）时返回键值；无块/解析失败/非映射返回 null。 */
  frontMatter: Record<string, unknown> | null;
  /** 渲染用正文：front matter 非 null 时为剥离后的剩余原文，否则为原文。 */
  body: string;
}

/** 定位首部 `---` 块：容忍 BOM/CRLF，返回块内 raw 与其后 body；无块返回 null。 */
function findFrontMatterRange(content: string): { raw: string; body: string } | null {
  const firstLineMatch = content.match(/^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/);
  if (!firstLineMatch) return null;

  let cursor = firstLineMatch[0].length;
  while (cursor <= content.length) {
    const nextNewline = content.indexOf('\n', cursor);
    const lineEnd = nextNewline === -1 ? content.length : nextNewline + 1;
    const line = content.slice(cursor, lineEnd).replace(/\r?\n$/, '');
    if (line.trim() === '---') {
      const raw = content.slice(firstLineMatch[0].length, cursor);
      let bodyStart = lineEnd;
      if (content.startsWith('\r\n', bodyStart)) bodyStart += 2;
      else if (content.startsWith('\n', bodyStart)) bodyStart += 1;
      return { raw, body: content.slice(bodyStart) };
    }
    if (nextNewline === -1) break;
    cursor = lineEnd;
  }
  return null;
}

// front matter 是元数据，必须是 YAML 映射：Jekyll/Hugo 均拒绝标量与序列。
// 空块（`---\n---`）合法，返回空对象。非映射时开头 `---` 是主题分割线，
// 剥离会删掉可见正文，故整体视为普通 markdown。
function isMapping(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

export function parseFrontMatter(content: string): FrontMatterResult {
  const range = findFrontMatterRange(content);
  if (!range) return { frontMatter: null, body: content };

  let parsed: unknown;
  try {
    parsed = parse(range.raw);
  } catch {
    // 契约：解析失败 frontMatter=null 且原文整体渲染
    return { frontMatter: null, body: content };
  }
  if (!isMapping(parsed)) return { frontMatter: null, body: content };
  return { frontMatter: (parsed ?? {}) as Record<string, unknown>, body: range.body };
}
