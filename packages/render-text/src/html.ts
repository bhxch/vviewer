// html.ts — html/htm 渲染器（Task 4）：沙箱双层防御预览。
// 第一层：DOMPurify WHOLE_DOCUMENT 净化（复用 markdown 的共享净化策略）；
// 第二层：净化后 DOM 的属性二次清洗（on* 全剥、src/href 白名单复核、href 的
// data:* 一律剥除——data: 仅限 src/srcset，与共享策略钩子同规则）——两层
// 独立生效，任一层单独失效仍安全。随后注入 CSP meta（净化之后注入，必然存活）
// 并经 <iframe sandbox srcdoc> 呈现。
// sandbox 裁决：只给 allow-same-origin、不给 allow-scripts——文档内脚本一律不
// 执行（opaque 可执行性），同源保持父页面可读 contentDocument（E2E 断言脚本
// 未执行用）；CSP default-src 'none' 为第三道纵深。
// 源码/渲染视图切换：默认渲染视图；源码视图复用 code.ts 的 renderCode（同一
// 高亮降级链）。样式统一由 apps/web/src/app.css 提供（单一来源，同 code.ts）。
// 超大输入（>20MB）：净化/DOM 遍历无分块能力，跳过沙箱管线降级为源码视图
// + 提示卡（renderDegradedCode；降级而非拒绝）。
import type { Renderer, RenderedInstance, Detection, FileSource } from '@vviewer/core';
import { ALLOWED_URI_REGEXP, sanitizeHtml } from './markdown/sanitize';
import {
  DECODERS,
  MARKUP_MAX_BYTES,
  renderCode,
  renderDegradedCode,
  type RenderCodeHandle
} from './code';

/** srcdoc 文档的 CSP：脚本面已被 sandbox 封死，CSP 管资源加载纵深（作者文档可含图片/行内样式） */
const CSP_CONTENT =
  "default-src 'none'; img-src data: blob: http: https:; media-src data: blob: http: https:; style-src 'unsafe-inline'; font-src data:";

/** URI 属性白名单复核（与共享净化策略同一正则；不匹配即剥属性） */
function uriAllowed(value: string): boolean {
  return ALLOWED_URI_REGEXP.test(value);
}

/**
 * 不可信 HTML → 沙箱化 srcdoc 字符串：WHOLE_DOCUMENT 净化 → 属性二次清洗
 * （on* 全剥；src/href 白名单，href 的 data:* 一律剥）→ CSP meta 注入。
 * 纯字符串进出，便于单测。
 */
export function buildSandboxedSrcdoc(raw: string): string {
  const clean = sanitizeHtml(raw, { wholeDocument: true });
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  // 第二层防御：独立于 DOMPurify 复核（净化结果之上再走一遍规则）
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if (name === 'href' && /^\s*data:/i.test(attr.value)) {
        // data: 仅放行 src/srcset（共享策略钩子同规则）：href 上的 data:image
        // 过白名单正则，但导航至 SVG data URL 可执行其脚本，一律剥除
        el.removeAttribute(attr.name);
      } else if ((name === 'src' || name === 'href') && !uriAllowed(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', CSP_CONTENT);
  (doc.head ?? doc.documentElement).prepend(meta);
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

type HtmlView = 'rendered' | 'source';

export const htmlRenderer: Renderer = {
  id: 'html',
  label: 'HTML 预览',
  extensions: ['html', 'htm'],
  async render(buffer: Uint8Array, target: HTMLElement, source: FileSource, det: Detection) {
    // 超大输入守卫：沙箱管线（净化/DOM 遍历/序列化）无分块能力，>20MB 会长时间
    // 阻塞主线程。降级为源码视图 + 提示卡（不建 toolbar，渲染视图本档不提供）。
    if (buffer.byteLength > MARKUP_MAX_BYTES) {
      target.classList.add('vv-html'); // 撑满宿主高度（同正常路径），降级内容纵向排布
      const code = renderDegradedCode(buffer, target, {
        name: source.name,
        mode: '源码',
        encoding: det.encoding,
        ext: det.ext,
        highlight: true
      });
      const instance: RenderedInstance & { toggleView(): void } = {
        destroy() {
          code.destroy();
          target.replaceChildren();
          target.classList.remove('vv-html', 'vv-degraded');
        },
        toggleView() {
          // 降级视图无渲染视图可切：保持接口形状，操作为空
        },
        search: (query) => code.search(query),
        gotoMatch: (index) => code.gotoMatch(index)
      };
      return instance;
    }

    let destroyed = false;
    let view: HtmlView = 'rendered';
    let codeInst: RenderCodeHandle | null = null;

    const raw = new TextDecoder(DECODERS[det.encoding ?? 'utf-8'], { fatal: false }).decode(buffer);
    const srcdoc = buildSandboxedSrcdoc(raw);

    const toolbar = document.createElement('div');
    toolbar.className = 'vv-html-toolbar';
    const renderedBtn = document.createElement('button');
    renderedBtn.type = 'button';
    renderedBtn.className = 'vv-html-btn-rendered active';
    renderedBtn.textContent = '渲染';
    const sourceBtn = document.createElement('button');
    sourceBtn.type = 'button';
    sourceBtn.className = 'vv-html-btn-source';
    sourceBtn.textContent = '源码';
    toolbar.append(renderedBtn, sourceBtn);
    const content = document.createElement('div');
    content.className = 'vv-html-content';
    target.classList.add('vv-html');
    target.replaceChildren(toolbar, content);

    function unmount(): void {
      codeInst?.destroy();
      codeInst = null;
      content.replaceChildren();
    }

    function mountRendered(): void {
      const frame = document.createElement('iframe');
      frame.className = 'vv-html-frame';
      // 裁决：allow-same-origin（父页面可读 contentDocument 做沙箱断言），无 allow-scripts
      // → 文档内脚本不执行；srcdoc 文档为不可信来源，另加 no-referrer
      frame.setAttribute('sandbox', 'allow-same-origin');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('srcdoc', srcdoc);
      frame.setAttribute('title', `${source.name} 渲染预览`);
      content.replaceChildren(frame);
    }

    function mountSource(): void {
      // 源码视图复用 code 渲染器：同一虚拟滚动与高亮降级链
      codeInst = renderCode(buffer, content, { encoding: det.encoding, highlight: true, ext: det.ext });
    }

    /** 渲染/源码切换（按钮与实例方法同通道） */
    function setView(next: HtmlView): void {
      if (destroyed || next === view) return;
      view = next;
      renderedBtn.classList.toggle('active', next === 'rendered');
      sourceBtn.classList.toggle('active', next === 'source');
      unmount();
      if (next === 'rendered') mountRendered();
      else mountSource();
    }

    renderedBtn.addEventListener('click', () => setView('rendered'));
    sourceBtn.addEventListener('click', () => setView('source'));
    mountRendered();

    const instance: RenderedInstance & { toggleView(): void } = {
      destroy() {
        destroyed = true;
        unmount();
        target.replaceChildren();
        target.classList.remove('vv-html');
      },
      toggleView() {
        setView(view === 'rendered' ? 'source' : 'rendered');
      },
      // 文件内搜索（Task 6）：源码视图复用 code 实现；渲染视图是沙箱 iframe
      // （allow-same-origin 但内容不可信），不做跨文档搜索，返回空结果。
      search(query) {
        return view === 'source' && codeInst ? codeInst.search(query) : Promise.resolve([]);
      },
      gotoMatch(index) {
        if (view === 'source') codeInst?.gotoMatch(index);
      }
    };
    return instance;
  }
};
