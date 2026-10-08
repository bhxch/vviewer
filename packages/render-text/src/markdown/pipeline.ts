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
   * 生成），插入 code 元素；返回 null 时管线内 hljs 兜底；抛错（取消：tab 切换后
   * 请求作废）时静默跳过该块、不 hljs 兜底（结果即将随文档丢弃）。
   */
  highlightFence: (code: string, lang: string) => Promise<string | null>;
  /** 主题类前缀：管线生成元素（复制按钮/mermaid 容器/灯箱）的类名前缀，供主题作用域样式。 */
  themeClassPrefix?: string;
  /**
   * 灯箱归属实例代币（遗留 U3）：body 级 overlay 是跨渲染实例的单例，markdownRenderer
   * 每次 render 生成唯一值传入；openLightbox 把"最后打开者"记在 overlay 上，
   * removeLightboxOverlay 只许 owner 随自身 destroy 摘除——多 markdown 实例（多 tab）
   * 共存时，B 实例的 destroy 不得互删 A 正开着的灯箱。
   */
  lightboxOwner?: string;
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
    // 回调抛错（如取消：tab 切换后请求作废）→ 静默跳过该块，不走 hljs 兜底
    //（结果即将随整个文档被丢弃）；返回 null（普通失败）才回落 hljs
    let spanHtml: string | null;
    try {
      spanHtml = await ctx.highlightFence(raw, lang);
    } catch {
      continue;
    }
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
    // 复制反馈：成功/失败改 1.5s 文案（连点时重置计时，避免旧计时提前还原）
    let revertTimer: ReturnType<typeof setTimeout> | null = null;
    const feedback = (label: string): void => {
      btn.textContent = label;
      if (revertTimer !== null) clearTimeout(revertTimer);
      revertTimer = setTimeout(() => {
        revertTimer = null;
        btn.textContent = '复制';
      }, 1500);
    };
    btn.addEventListener('click', () => {
      const text = (pre.querySelector('code')?.textContent ?? '').replace(/\n$/, '');
      const p = navigator.clipboard?.writeText(text);
      if (p) void p.then(() => feedback('已复制'), () => feedback('复制失败'));
      else feedback('复制失败'); // 无剪贴板权限（非安全上下文等）
    });
    pre.appendChild(btn);
  }
}

// ---------- lightbox 步 ----------

/** body 级灯箱 overlay 的元素 id（openLightbox 创建；markdownRenderer destroy 时清理防泄漏） */
export const LIGHTBOX_OVERLAY_ID = 'md-lightbox-overlay';

/** overlay 上的打开者代币属性（openLightbox 写入、removeLightboxOverlay 校验，遗留 U3） */
export const LIGHTBOX_OWNER_ATTR = 'data-md-lightbox-owner';

/** overlay → 其 document 级 Esc 监听（removeLightboxOverlay / 点击关闭时随之摘除，防监听器累积） */
const escHandlers = new WeakMap<HTMLElement, (ev: KeyboardEvent) => void>();

/**
 * 从文档移除灯箱 overlay（markdownRenderer destroy 调用；overlay 挂在 body，不随渲染节点销毁）。
 * ownerId 传时校验打开者代币：非当前 owner 的 destroy 直接跳过（多 markdown 实例
 * 共存时互删对方正开着的灯箱，遗留 U3）；不传（Esc / overlay 点击等自有关场景）
 * 行为不变，无条件移除。
 */
export function removeLightboxOverlay(doc: Document, ownerId?: string): void {
  const overlay = doc.getElementById(LIGHTBOX_OVERLAY_ID);
  if (!overlay) return;
  if (ownerId !== undefined && overlay.getAttribute(LIGHTBOX_OWNER_ATTR) !== ownerId) return;
  const onKey = escHandlers.get(overlay);
  if (onKey) doc.removeEventListener('keydown', onKey);
  escHandlers.delete(overlay);
  overlay.remove();
}

function openLightbox(img: HTMLImageElement, ctx: PipelineCtx): void {
  const doc = img.ownerDocument;
  // body 级单例：首次点击创建，之后所有图共用
  let overlay = doc.getElementById(LIGHTBOX_OVERLAY_ID);
  if (!overlay) {
    overlay = doc.createElement('div');
    overlay.id = LIGHTBOX_OVERLAY_ID;
    overlay.className = cls(ctx, 'lightboxOverlay');
    const clone = doc.createElement('img');
    clone.className = cls(ctx, 'lightbox');
    overlay.appendChild(clone);
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') removeLightboxOverlay(doc);
    };
    escHandlers.set(overlay, onKey);
    doc.addEventListener('keydown', onKey);
    overlay.addEventListener('click', () => removeLightboxOverlay(doc));
    (doc.body ?? doc.documentElement).appendChild(overlay);
  }
  const clone = overlay.querySelector('img');
  if (clone) {
    clone.setAttribute('src', img.getAttribute('src') ?? '');
    clone.setAttribute('alt', img.getAttribute('alt') ?? '');
  }
  // 最后打开者即 owner（覆盖旧记号）：其后仅 owner 的 destroy 可随生命周期摘除（U3）
  overlay.setAttribute(LIGHTBOX_OWNER_ATTR, ctx.lightboxOwner ?? '');
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
