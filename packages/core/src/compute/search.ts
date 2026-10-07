/**
 * 跨文件搜索（M6 T4）：两条实现共用 GrepMatch 形状。
 *
 * - local（grepStoreLocal）：纯前端内存 grep——递归 listChildren（限深 5），
 *   文本扩展名白名单 + 单文件 ≤2MB，逐个 read 后按行扫描；上限 2000 文件 /
 *   200MB 累计 / 1000 命中（超限 truncated + 停止），onProgress 汇报进度，
 *   canceled() 回调支持外部取消（全局搜索面板的代际防护）。
 * - remote（grepRemote）：vviewer 文件服务器 POST /api/search 的 NDJSON 流
 *   （每命中一行 `{"file","line","col","text"}`，终帧 `{"done","truncated"}`，
 *   error 字段可选）→ 展开为 GrepMatch[]。非 2xx / done.error 抛错，由
 *   ComputeRouter 的 auto 策略回退本地（remote 策略如实报错）。
 *
 * 行列约定与服务端一致：line/col 均为 1 起；col 按 UTF-16 码元计；
 * preview 为命中行文本、超长截 200 字符。glob 仅服务端支持（rg -g），
 * 本地实现忽略（无 UI 入口，P2）。
 */

import type { TreeStore } from '../types';

/** 跨文件搜索命中（服务端 NDJSON 帧与本地扫描的统一形状）。 */
export interface GrepMatch {
  storeId: string;
  path: string;
  /** 命中行（1 起） */
  line: number;
  /** 命中起始列（1 起，UTF-16 码元） */
  col: number;
  /** 命中行文本（截断 200 字符） */
  preview: string;
}

/** 本地内存 grep 选项与可覆盖上限（maxXxx 主要供测试收紧行为）。 */
export interface GrepLocalOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  /** 累计扫描文件数上限（默认 2000） */
  maxFiles?: number;
  /** 累计字节上限（默认 200MB） */
  maxBytes?: number;
  /** 单文件字节上限，超出跳过（默认 2MB） */
  maxFileBytes?: number;
  /** 目录递归深度上限（根 = 0 层，默认 5） */
  maxDepth?: number;
  /** 命中数上限（默认 1000，与服务端截断一致） */
  maxMatches?: number;
  /** 取消探测：返回 true 时尽快中止（结果作废由调用方代际防护裁决） */
  canceled?: () => boolean;
}

export const GREP_MAX_FILES = 2000;
export const GREP_MAX_BYTES = 200 * 1024 * 1024;
export const GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const GREP_MAX_DEPTH = 5;
export const GREP_MAX_MATCHES = 1000;
export const GREP_PREVIEW_CHARS = 200;

/**
 * 可搜索的文本扩展名白名单（约 40 项，取自代码渲染器文本集合理念的最常用子集）。
 * core 不依赖 render-text，独立成表；无扩展名 / dotfile 不扫。
 */
const TEXT_EXTS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'jsonc',
  'md', 'markdown', 'txt', 'log', 'csv', 'tsv',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env',
  'py', 'rb', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'h',
  'cpp', 'hpp', 'cs', 'sh', 'sql', 'php', 'lua', 'vue', 'svelte'
]);

function isTextPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false; // 无扩展名或 ".gitignore" 类 dotfile：跳过
  return TEXT_EXTS.has(name.slice(dot + 1).toLowerCase());
}

/** 行内命中区间（UTF-16 偏移，左闭右开）；供扫描与面板预览高亮共用。 */
export function matchRanges(
  text: string,
  query: string,
  opts: { caseSensitive?: boolean; regex?: boolean } = {}
): Array<{ start: number; end: number }> {
  if (query === '') return [];
  const out: Array<{ start: number; end: number }> = [];
  if (opts.regex) {
    let re: RegExp;
    try {
      re = new RegExp(query, opts.caseSensitive ? 'g' : 'gi');
    } catch {
      throw new Error(`无效正则表达式: ${query}`);
    }
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      out.push({ start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) re.lastIndex += 1; // 零宽匹配防死循环
    }
    return out;
  }
  const haystack = opts.caseSensitive ? text : text.toLowerCase();
  const needle = opts.caseSensitive ? query : query.toLowerCase();
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) {
    out.push({ start: i, end: i + needle.length });
  }
  return out;
}

function truncatePreview(line: string): string {
  const chars = Array.from(line);
  return chars.length > GREP_PREVIEW_CHARS ? chars.slice(0, GREP_PREVIEW_CHARS).join('') : line;
}

/**
 * 纯前端内存 grep：递归遍历 store（限深），文本白名单 + 单文件大小过滤，
 * 逐个 read 扫描。任一上限触达即置 truncated 并停止；store.read 失败
 * （竞态删除/权限）跳过该文件不中断。
 */
export async function grepStoreLocal(
  store: TreeStore,
  query: string,
  opts: GrepLocalOptions = {},
  onProgress?: (filesDone: number) => void
): Promise<{ matches: GrepMatch[]; truncated: boolean }> {
  const maxFiles = opts.maxFiles ?? GREP_MAX_FILES;
  const maxBytes = opts.maxBytes ?? GREP_MAX_BYTES;
  const maxFileBytes = opts.maxFileBytes ?? GREP_MAX_FILE_BYTES;
  const maxDepth = opts.maxDepth ?? GREP_MAX_DEPTH;
  const maxMatches = opts.maxMatches ?? GREP_MAX_MATCHES;

  const matches: GrepMatch[] = [];
  let truncated = false;
  let filesDone = 0;
  let bytesTotal = 0;

  // 显式栈 DFS：[目录路径, 深度]；根 = 0 层，depth 达上限的目录不再入栈
  const stack: Array<[string, number]> = [['', 0]];
  walk: while (stack.length > 0) {
    if (opts.canceled?.()) return { matches, truncated: false };
    const [dir, depth] = stack.pop()!;
    let entries;
    try {
      entries = await store.listChildren(dir);
    } catch {
      continue; // 目录消失等瞬时错误：跳过
    }
    // 文件按字典序就地扫描；目录收集后逆序入栈，使下一层仍按字典序出栈
    const subdirs: Array<[string, number]> = [];
    for (const entry of entries) {
      if (entry.kind === 'dir') {
        if (depth < maxDepth) subdirs.push([entry.path, depth + 1]);
        continue;
      }
      if (!isTextPath(entry.path)) continue;
      if (entry.size !== undefined && entry.size > maxFileBytes) continue;
      if (filesDone >= maxFiles || bytesTotal >= maxBytes) {
        truncated = true; // 还有待扫文件却触达上限：如实报告不完整
        break walk;
      }
      let bytes: Uint8Array;
      try {
        bytes = await store.read(entry.path);
      } catch {
        continue;
      }
      bytesTotal += bytes.byteLength;
      filesDone += 1;
      onProgress?.(filesDone);
      if (bytes.byteLength > maxFileBytes) continue; // size 缺失时的读取兜底
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const lines = text.split('\n');
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li]!;
        for (const range of matchRanges(line, query, opts)) {
          matches.push({
            storeId: store.id,
            path: entry.path,
            line: li + 1,
            col: range.start + 1,
            preview: truncatePreview(line)
          });
        }
        if (matches.length >= maxMatches) {
          truncated = true; // 命中上限即停（保守：后续可能仍有命中）
          break walk;
        }
      }
    }
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]!);
  }
  return { matches, truncated };
}

// ---------- 远端 ripgrep（NDJSON 流） ----------

/** 远程调用描述（与 ComputeRouter.remoteCall 产出同形）。 */
export interface RemoteGrepEndpoint {
  url: string;
  headers: Record<string, string>;
}

/** POST /api/search 请求体（与服务端 SearchRequest 同形）。 */
export interface RemoteGrepRequest {
  pattern: string;
  glob?: string;
  caseSensitive?: boolean;
  regex?: boolean;
  path?: string;
}

/** NDJSON 帧（子集）：命中帧或终帧。 */
interface GrepFrame {
  file?: unknown;
  line?: unknown;
  col?: unknown;
  text?: unknown;
  done?: unknown;
  truncated?: unknown;
  error?: unknown;
}

function isGrepMatchFrame(f: GrepFrame): f is GrepFrame & { file: string; line: number; col: number; text: string } {
  return (
    typeof f.file === 'string' &&
    typeof f.line === 'number' &&
    typeof f.col === 'number' &&
    typeof f.text === 'string'
  );
}

/**
 * 调用服务器 ripgrep：POST endpoint（body JSON）→ 读 NDJSON 流 → GrepMatch[]。
 * 非 2xx 抛错（含状态码）；终帧 error 字段抛错（如 rg 非法正则）——
 * ComputeRouter auto 策略据此回退本地，remote 策略如实报错。
 * signal 贯穿 fetch 与流读取，供调用方取消。
 */
export async function grepRemote(
  endpoint: RemoteGrepEndpoint,
  request: RemoteGrepRequest,
  opts: { storeId: string; signal?: AbortSignal }
): Promise<{ matches: GrepMatch[]; truncated: boolean }> {
  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers: { ...endpoint.headers, 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: opts.signal
  });
  if (!res.ok) throw new Error(`服务器搜索失败: HTTP ${res.status}`);
  if (!res.body) throw new Error('服务器搜索响应无内容流');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const matches: GrepMatch[] = [];
  let truncated = false;
  let buffer = '';

  const consume = (chunk: string): void => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (raw.trim() === '') continue;
      let frame: GrepFrame;
      try {
        frame = JSON.parse(raw) as GrepFrame;
      } catch {
        continue; // 非 JSON 行：忽略（与服务端 skip 语义对齐）
      }
      if (frame.done === true) {
        truncated = frame.truncated === true;
        if (typeof frame.error === 'string' && frame.error !== '') {
          throw new Error(frame.error);
        }
        continue;
      }
      if (isGrepMatchFrame(frame)) {
        matches.push({
          storeId: opts.storeId,
          path: frame.file,
          line: frame.line,
          col: frame.col,
          preview: frame.text
        });
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    consume(decoder.decode(value, { stream: true }));
  }
  consume(decoder.decode()); // 冲出残余多字节序列与最后无换行帧
  return { matches, truncated };
}
