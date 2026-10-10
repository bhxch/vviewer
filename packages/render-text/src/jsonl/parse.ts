/**
 * JSONL 渲染器的解析核心：行切分、单行三态解析（ok/failed/oversize）、折叠计算。
 * 全部为纯函数（无 DOM / 无 IO），以便独立单测并被渲染层组合。
 */

/** 超大行阈值：单行字节长达到 1MB 即不再尝试 JSON.parse */
export const JSONL_OVERSIZE_LINE_BYTES = 1_048_576;
/** oversize 行保留的原始文本预览长度（64KB），防止超大串撑爆 DOM */
export const JSONL_OVERSIZE_PREVIEW_BYTES = 65_536;
/** 折叠阈值：pretty 后超过 40 行的卡片默认折叠到 40 行可见 */
export const JSONL_COLLAPSE_LINES = 40;
/** 展开封顶：即使展开也最多渲染 400 行，超出走卡片内滚动 */
export const JSONL_EXPAND_CAP_LINES = 400;
/** 卡片自动高亮的输入上限（UTF-16 字符数，1MB）：深嵌套小行 pretty 后可放大数倍
 * （单行 <1MB、pretty 可达数 MB），超限跳过自动高亮保持纯文本（防 worker 载荷
 * 与主线程卡顿）。与解析阈值同置本模块，作为 jsonl 渲染管线的规模阈值清单。 */
export const JSONL_HIGHLIGHT_MAX_CHARS = 1_048_576;

/** 单行解析结果三态：成功（pretty 形态）/ 失败（保原始文本+短原因）/ 超大（仅预览） */
export type JsonlLineState =
  | { kind: 'ok'; pretty: string; prettyLines: number }
  | { kind: 'failed'; raw: string; reason: string; truncated?: boolean }
  | { kind: 'oversize'; raw: string };

/** 模块级单例：TextEncoder 构造有开销，行级调用（每行一次）不应重复创建 */
const encoder = new TextEncoder();

/**
 * 按 JSONL 惯例切行：
 * - 剥单个 UTF-8 BOM：解码侧（fetch+TextDecoder）通常已剥，此处兜底，重复剥离为空串无害；
 * - 按 \n 切分（CRLF 归一属解码侧职责，调用方保证）；
 * - 丢弃空行与纯空白行：JSONL 惯例容忍尾空行，空串既非合法 JSON 也无展示价值。
 */
export function splitJsonlLines(text: string): string[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines: string[] = [];
  for (const line of body.split('\n')) {
    if (line.trim() === '') continue;
    lines.push(line);
  }
  return lines;
}

/**
 * 解析单行：字节长 ≥ 1MB 直接判 oversize（不进 JSON.parse，避免解析+stringify
 * 的内存放大；阈值取等号即 oversize，测试锚定 1MB 整为超限），原始文本只截前
 * 64KB 作预览；否则尝试 JSON.parse——成功转 2 空格缩进的 pretty 形态
 * （stringify 保对象键插入序），失败保留原文（超 64KB 截断并标 truncated，
 * 防巨行撑爆 DOM）并给出去换行、截 120 字符的短原因
 * （防多行报错破坏单行展示与 title 属性）。
 */
export function parseJsonlLine(raw: string): JsonlLineState {
  if (encoder.encode(raw).length >= JSONL_OVERSIZE_LINE_BYTES) {
    return { kind: 'oversize', raw: raw.slice(0, JSONL_OVERSIZE_PREVIEW_BYTES) };
  }
  try {
    const value: unknown = JSON.parse(raw);
    const pretty = JSON.stringify(value, null, 2);
    // 行数按「每行以换行符收尾」口径计（pretty + '\n' 再切分）：渲染层逐行成块、
    // 块间以换行衔接，7 行 pretty 即 8 个行单元（测试锚定），折叠/封顶阈值用此口径
    const prettyLines = (pretty + '\n').split('\n').length;
    return { kind: 'ok', pretty, prettyLines };
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err))
      .replace(/\s+/g, ' ')
      .slice(0, 120);
    // 截断口径与 oversize 预览一致（字符切片；字符数 > 64KB 即截，容差可接受）
    return raw.length > JSONL_OVERSIZE_PREVIEW_BYTES
      ? { kind: 'failed', raw: raw.slice(0, JSONL_OVERSIZE_PREVIEW_BYTES), reason, truncated: true }
      : { kind: 'failed', raw, reason };
  }
}

/**
 * 折叠计算（spec：pretty 后超 40 行默认折叠显示首 40 行；展开仍封顶 400 行）：
 * ≤40 行全显；>40 行一律折叠 40 行可见——capped 与否不改变折叠初始态；capped
 * 含义为「展开时将被封顶」（prettyLines > 400），渲染层据此在展开后把切片截到
 * 400 行并挂卡片内滚动与「已截断显示」提示。展开点击由渲染层重渲染，不做渐进。
 */
export function collapseFor(prettyLines: number): { collapsed: boolean; visibleLines: number; capped: boolean } {
  if (prettyLines <= JSONL_COLLAPSE_LINES) {
    return { collapsed: false, visibleLines: prettyLines, capped: false };
  }
  return {
    collapsed: true,
    visibleLines: JSONL_COLLAPSE_LINES,
    capped: prettyLines > JSONL_EXPAND_CAP_LINES
  };
}
