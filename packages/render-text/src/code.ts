import type { Renderer, Encoding } from '@vviewer/core';
import { virtualScroller, type VirtualScrollerHandle } from './virtualScroller';

const MAX_HIGHLIGHT_BYTES = 5 * 1024 * 1024;
export const LINE_HEIGHT = 20;

const DECODERS: Record<Encoding, string> = {
  'utf-8': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'gb18030': 'gb18030'
};

export function buildLineIndex(text: string): string[] {
  return text.split('\n');
}

/** 把 hljs 高亮 HTML 按行切分；跨行 span 在每行末尾全部闭合、下一行开头按原序重开 */
export function splitHighlightedLines(html: string, lineCount: number): string[] {
  const out: string[] = new Array(lineCount).fill('');
  const stack: string[] = []; // 打开的 <span ...> 标签
  const re = /<span [^>]*>|<\/span>|\n|[^<\n]+/g;
  let line = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tok = m[0] ?? '';
    if (tok === '\n') {
      out[line] = (out[line] ?? '') + stack.map(() => '</span>').join('');
      line += 1;
      if (line >= lineCount) break;
      out[line] = (out[line] ?? '') + stack.join('');
      continue;
    }
    if (tok === '</span>') {
      stack.pop();
      out[line] = (out[line] ?? '') + tok;
      continue;
    }
    if (tok.startsWith('<span')) {
      stack.push(tok);
      out[line] = (out[line] ?? '') + tok;
      continue;
    }
    out[line] = (out[line] ?? '') + tok;
  }
  return out;
}

const STYLE_ID = 'vv-render-text-style';
const CODE_CSS = `
.vv-virtual { position: relative; overflow: auto; }
.vv-virtual-spacer { position: absolute; top: 0; left: 0; width: 1px; }
.vv-virtual-viewport { position: absolute; top: 0; left: 0; right: 0; will-change: transform; }
.vv-code-pre { position: relative; overflow: auto; height: 100%; }
.vv-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 13px;
  line-height: ${LINE_HEIGHT}px;
}
.vv-code-line { display: flex; white-space: pre; }
.vv-code-gutter { flex: none; min-width: 3em; padding-right: 12px; text-align: right; user-select: none; }
.vv-code-body { flex: 1 1 auto; min-width: 0; }
`;
let stylesInjected = false;
function ensureStyles(): void {
  if (stylesInjected) return;
  if (!document.getElementById(STYLE_ID)) {
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CODE_CSS;
    document.head.append(el);
  }
  stylesInjected = true;
}

export interface RenderCodeHandle {
  destroy(): void;
  setScrollTop(top: number): void;
  scrollTop(): number;
}

export function renderCode(
  buffer: Uint8Array,
  target: HTMLElement,
  opts: { encoding?: Encoding; highlight?: boolean } = {}
): RenderCodeHandle {
  ensureStyles();
  const enc = DECODERS[opts.encoding ?? 'utf-8'];
  const text = new TextDecoder(enc, { fatal: false }).decode(buffer);
  const lines = buildLineIndex(text);
  const doHighlight = (opts.highlight ?? true) && buffer.byteLength <= MAX_HIGHLIGHT_BYTES;
  target.classList.add('vv-code');
  const pre = document.createElement('div');
  pre.className = 'vv-code-pre'; // 即 virtualScroller 的滚动容器
  target.replaceChildren(pre);
  let hlLines: string[] | null = null;
  let scroller: VirtualScrollerHandle | null = null;
  let destroyed = false;
  async function start(): Promise<void> {
    if (doHighlight) {
      const hljs = (await import('highlight.js')).default;
      const { value } = hljs.highlightAuto(text);
      if (destroyed) return;
      hlLines = splitHighlightedLines(value, lines.length);
    }
    if (destroyed) return;
    scroller = virtualScroller(pre, lines.length, LINE_HEIGHT, (first, last, viewport) => {
      const frag = document.createDocumentFragment();
      for (let i = first; i <= last; i++) {
        const row = document.createElement('div');
        row.className = 'vv-code-line';
        row.style.height = `${LINE_HEIGHT}px`;
        const gutter = document.createElement('span');
        gutter.className = 'vv-code-gutter';
        gutter.textContent = String(i + 1);
        const body = document.createElement('span');
        body.className = 'vv-code-body';
        if (hlLines) body.innerHTML = hlLines[i] ?? '';
        else body.textContent = lines[i] ?? '';
        row.append(gutter, body);
        frag.append(row);
      }
      viewport.replaceChildren(frag);
    });
  }
  void start();
  return {
    destroy() {
      destroyed = true;
      scroller?.destroy();
      scroller = null;
      pre.remove();
    },
    setScrollTop(top) {
      pre.scrollTop = top;
    },
    scrollTop() {
      return pre.scrollTop;
    }
  };
}

export const codeRenderer: Renderer = {
  id: 'code',
  label: '代码/文本',
  // 注：不含 'svg'——svg 归 @vviewer/render-media 的 imageRenderer（消毒预览），registry 拒绝重复注册
  extensions: [
    'txt', 'md', 'markdown', 'log', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'csv',
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm', 'xml',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'sh', 'bash', 'zsh', 'fish', 'sql',
    'lua', 'php', 'pl', 'swift', 'dart', 'vue', 'svelte', 'gradle', 'cmake', 'properties', 'gitignore',
    'license', 'makefile', 'diff', 'patch'
  ],
  async render(buffer, target, source, det) {
    void source;
    const inst = renderCode(buffer, target, { encoding: det.encoding, highlight: true });
    return { destroy() { inst.destroy(); } };
  }
};
