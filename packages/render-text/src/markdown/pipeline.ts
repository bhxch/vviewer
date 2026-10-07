// pipeline.ts — markdown 渲染五步管线（移植自 markpad src/lib/pipeline/index.ts 的
// 固定顺序与单步容错语义，按 vviewer M3 契约裁剪）：highlight → diagrams(mermaid)
// → katex → copyCode → lightbox。输入是净化后的 Document（sanitize 在管线外完成）。
// - highlight 步经注入回调（依赖倒置）：render-text 不依赖 @vviewer/highlight，
//   viewer.ts 接线 HighlightClient（tree-sitter 完整降级链），null 返回时管线内
//   hljs 兜底（动态 import）。
// - mermaid/katex/highlight.js 均动态 import（mermaid 必须懒加载）。
// - 每步独立 try/catch：单步失败不阻塞后续步骤。

export interface PipelineCtx {
  /**
   * 围栏代码高亮回调：返回 span HTML（如 HighlightClient 区间 + captureToCssClass
   * 生成），插入 code 元素；返回 null 时管线内 hljs 兜底。
   */
  highlightFence: (code: string, lang: string) => Promise<string | null>;
  /** 主题类前缀：管线生成元素（复制按钮/mermaid 容器/灯箱）的类名前缀，供主题作用域样式。 */
  themeClassPrefix?: string;
}

export interface PipelineStep {
  name: 'highlight' | 'diagrams' | 'katex' | 'copyCode' | 'lightbox';
  run: (root: Document, ctx: PipelineCtx) => Promise<void>;
}

/** 生成元素的基础类名（可被 ctx.themeClassPrefix 前缀）。 */
const CLS = {
  copyBtn: 'md-copy-btn',
  mermaid: 'md-mermaid',
  mermaidError: 'md-mermaid-error',
  lightbox: 'md-lightbox',
  lightboxOverlay: 'md-lightbox-overlay',
} as const;

function cls(ctx: PipelineCtx, base: keyof typeof CLS): string {
  const name = CLS[base];
  return ctx.themeClassPrefix ? ctx.themeClassPrefix + name : name;
}

// ---------- highlight 步 ----------

async function runHighlight(root: Document, ctx: PipelineCtx): Promise<void> {
  for (const code of Array.from(root.querySelectorAll('pre code'))) {
    if (code.hasAttribute('data-md-highlight')) continue;
    // mermaid 块归 diagrams 步，不参与代码高亮
    if (code.classList.contains('language-mermaid')) continue;
    code.setAttribute('data-md-highlight', '');
    const langClass = Array.from(code.classList).find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.slice('language-'.length) : '';
    // 围栏内容自带格式性尾换行（markdown-it 原样保留），高亮/复制均不应带上
    const raw = (code.textContent ?? '').replace(/\n$/, '');
    const spanHtml = await ctx.highlightFence(raw, lang);
    if (spanHtml) {
      code.innerHTML = spanHtml;
      continue;
    }
    // 兜底：注入回调失败/null → hljs 全量包
    try {
      const hljs = (await import('highlight.js')).default;
      hljs.highlightElement(code as HTMLElement);
    } catch {
      /* 保留原文 */
    }
  }
}

// ---------- diagrams（mermaid）步 ----------

let mermaidSeq = 0;

async function runDiagrams(root: Document, ctx: PipelineCtx): Promise<void> {
  const blocks = Array.from(root.querySelectorAll('code.language-mermaid'));
  if (blocks.length === 0) return;
  // 动态 import 失败按每块错误路径处理（保留原文）
  const mermaid = await import('mermaid')
    .then((m) => m.default)
    .catch(() => null);

  for (const code of blocks) {
    // 围栏内容自带格式性尾换行，源码属性/错误展示均不应带上
    const source = (code.textContent ?? '').replace(/\n$/, '');
    const host = code.closest('pre') ?? code;
    const container = root.createElement('div');
    container.className = cls(ctx, 'mermaid');
    container.setAttribute('data-mermaid', source);
    host.replaceWith(container);

    if (!mermaid) {
      container.classList.add(cls(ctx, 'mermaidError'));
      container.textContent = source;
      continue;
    }
    try {
      mermaid.initialize({ startOnLoad: false });
      const { svg } = await mermaid.render(`md-mermaid-${(mermaidSeq += 1)}`, source);
      container.innerHTML = svg;
    } catch {
      // 失败保留原文 + 错误样式（源码同时留在 data-mermaid 供点击重渲染/复制）
      container.classList.add(cls(ctx, 'mermaidError'));
      container.textContent = source;
    }
  }
}

// ---------- katex 步 ----------

// 公式扫描跳过的祖先标签：代码/脚本/样式内 $ 是字面量；.katex 防重入。
const MATH_SKIP_TAGS = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'KATEX']);

type MathSegment = { kind: 'text'; value: string } | { kind: 'math'; value: string; display: boolean };

/**
 * 简单分隔符扫描：`$$...$$` 块级（可跨行）、`$...$` 行内（止于行尾，
 * 开定界符后与闭定界符前不允许紧邻空白——金额 $100 与 $200 不误判）。
 * 无有效公式返回空数组（原文不动）。
 */
function scanMathSegments(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch !== '$') {
      buf += ch;
      i += 1;
      continue;
    }
    if (text[i + 1] === '$') {
      const end = text.indexOf('$$', i + 2);
      const inner = end === -1 ? '' : text.slice(i + 2, end).trim();
      if (end !== -1 && inner) {
        if (buf) segments.push({ kind: 'text', value: buf });
        segments.push({ kind: 'math', value: inner, display: true });
        buf = '';
        i = end + 2;
        continue;
      }
      buf += '$$';
      i += 2;
      continue;
    }
    const next = text[i + 1] ?? '';
    if (next && !/[\s$]/.test(next)) {
      let j = i + 1;
      while (j < text.length && text[j] !== '$' && text[j] !== '\n') j += 1;
      if (text[j] === '$' && j > i + 1 && !/\s/.test(text[j - 1]!)) {
        if (buf) segments.push({ kind: 'text', value: buf });
        segments.push({ kind: 'math', value: text.slice(i + 1, j), display: false });
        buf = '';
        i = j + 1;
        continue;
      }
    }
    buf += '$';
    i += 1;
  }
  if (buf) segments.push({ kind: 'text', value: buf });
  return segments.some((s) => s.kind === 'math') ? segments : [];
}

async function runKatex(root: Document): Promise<void> {
  const scope: Node = root.body ?? root;
  const katex = (await import('katex').catch(() => null))?.default;
  if (!katex) return;

  const walker = root.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let cur: Node | null = node.parentNode;
      while (cur && cur !== scope) {
        if (cur.nodeType === 1 && MATH_SKIP_TAGS.has((cur as Element).tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        cur = cur.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if ((node.nodeValue ?? '').includes('$')) targets.push(node as Text);
  }

  for (const target of targets) {
    const segments = scanMathSegments(target.nodeValue ?? '');
    if (segments.length === 0) continue;
    try {
      const frag = root.createDocumentFragment();
      for (const seg of segments) {
        if (seg.kind === 'text') {
          frag.appendChild(root.createTextNode(seg.value));
          continue;
        }
        const span = root.createElement('span');
        span.innerHTML = katex.renderToString(seg.value, { displayMode: seg.display, throwOnError: true });
        frag.appendChild(span);
      }
      target.replaceWith(frag);
    } catch {
      /* 非法 LaTeX：保留原文 */
    }
  }
}

// ---------- copyCode 步 ----------

async function runCopyCode(root: Document, ctx: PipelineCtx): Promise<void> {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    if (pre.hasAttribute('data-md-copy')) continue;
    pre.setAttribute('data-md-copy', '');
    const btn = root.createElement('button');
    btn.type = 'button';
    btn.className = cls(ctx, 'copyBtn');
    btn.textContent = '复制';
    btn.addEventListener('click', () => {
      const text = (pre.querySelector('code')?.textContent ?? '').replace(/\n$/, '');
      void navigator.clipboard?.writeText(text).catch(() => {});
    });
    pre.appendChild(btn);
  }
}

// ---------- lightbox 步 ----------

function openLightbox(img: HTMLImageElement, ctx: PipelineCtx): void {
  const doc = img.ownerDocument;
  // body 级单例：首次点击创建，之后所有图共用
  let overlay = doc.getElementById('md-lightbox-overlay');
  if (!overlay) {
    overlay = doc.createElement('div');
    overlay.id = 'md-lightbox-overlay';
    overlay.className = cls(ctx, 'lightboxOverlay');
    const clone = doc.createElement('img');
    clone.className = cls(ctx, 'lightbox');
    overlay.appendChild(clone);
    overlay.addEventListener('click', () => overlay!.remove());
    (doc.body ?? doc.documentElement).appendChild(overlay);
  }
  const clone = overlay.querySelector('img');
  if (clone) {
    clone.setAttribute('src', img.getAttribute('src') ?? '');
    clone.setAttribute('alt', img.getAttribute('alt') ?? '');
  }
}

async function runLightbox(root: Document, ctx: PipelineCtx): Promise<void> {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (img.hasAttribute('data-md-lightbox')) continue;
    img.setAttribute('data-md-lightbox', '');
    img.addEventListener('click', (ev) => {
      ev.preventDefault();
      openLightbox(img, ctx);
    });
  }
}

// ---------- 装配与执行 ----------

/** 当前配置下的五步有序列表（单一代码来源；runPipeline 即按此顺序执行）。 */
export function getPipelineSteps(ctx: PipelineCtx): PipelineStep[] {
  return [
    { name: 'highlight', run: (r, c) => runHighlight(r, c) },
    { name: 'diagrams', run: (r, c) => runDiagrams(r, c) },
    { name: 'katex', run: (r) => runKatex(r) },
    { name: 'copyCode', run: (r, c) => runCopyCode(r, c) },
    { name: 'lightbox', run: (r, c) => runLightbox(r, c) },
  ];
}

/** 顺序执行各步，单步 try/catch 不阻塞后续。 */
export async function runSteps(
  steps: readonly PipelineStep[],
  root: Document,
  ctx: PipelineCtx,
): Promise<void> {
  for (const step of steps) {
    try {
      await step.run(root, ctx);
    } catch {
      /* 单步失败不阻塞后续步骤 */
    }
  }
}

/** 五步管线入口：输入为净化后的 Document（sanitize/enrich 在外部完成后调用）。 */
export async function runPipeline(root: Document, ctx: PipelineCtx): Promise<void> {
  await runSteps(getPipelineSteps(ctx), root, ctx);
}
