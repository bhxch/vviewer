// hex.ts — hex 渲染器（M4 Task 2）。经典三列 dump（等宽行字符串，列对齐由空格保证），
// 前 1MB 立即渲染 + "加载更多"每次追加 1MB（单页 DocumentFragment 一次插入，不做虚拟滚动）。
// 结构树走 binary.worker（BinaryClient），状态行展示大小/识别类型。
import type { Detection, FileSource, RenderedInstance, Renderer } from '@vviewer/core';
import { renderHexBytes, HEX_ROW_BYTES } from './hexBytes';
import type { ParseResult, StructNode } from './struct';

/** hex dump 单页字节数（前 1MB 立即渲染，加载更多每次追加同量） */
export const HEX_PAGE_BYTES = 1 << 20;
/** 结构树解析取头部字节数 */
const STRUCT_HEAD_BYTES = 8192;

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 结构树 → 折叠 details 树（叶子为 name: value 行，内部节点可展开） */
function nodeToDetails(node: StructNode, open: boolean): HTMLDetailsElement {
  const details = document.createElement('details');
  details.open = open;
  const summary = document.createElement('summary');
  summary.textContent = node.size > 0 ? `${node.name}` : node.name;
  const value = document.createElement('span');
  value.className = 'vv-hex-node-value';
  value.textContent = ` = ${node.value}`;
  summary.append(value);
  details.append(summary);
  if (node.children && node.children.length > 0) {
    const wrap = document.createElement('div');
    wrap.className = 'vv-hex-children';
    for (const c of node.children) wrap.append(nodeToDetails(c, open));
    details.append(wrap);
  }
  return details;
}

export interface HexDomOptions {
  pageBytes?: number;
  /** 注入 worker 创建器（测试/无 Worker 环境可替换）；默认 new Worker(binary.worker) */
  createWorker?: () => Worker | null;
}

/**
 * hex dump DOM 渲染（hexRenderer.render 的主体，独立导出便于复用）。
 * 返回实例 destroy：移除 DOM、终止 worker。
 */
export function renderHex(
  buffer: Uint8Array,
  target: HTMLElement,
  opts: HexDomOptions = {}
): { destroy(): void; structReady: Promise<void> } {
  const pageBytes = opts.pageBytes ?? HEX_PAGE_BYTES;
  const root = document.createElement('div');
  root.className = 'vv-hex';
  const status = document.createElement('div');
  status.className = 'vv-hex-status';
  status.textContent = formatSize(buffer.length);
  const body = document.createElement('div');
  body.className = 'vv-hex-body';
  const dump = document.createElement('div');
  dump.className = 'vv-hex-dump';
  body.append(dump);
  root.append(status, body);
  target.replaceChildren(root);

  // ---- 分页 dump ----
  let rendered = 0;
  let loadMore: HTMLButtonElement | null = null;

  function renderPage(): void {
    const end = Math.min(buffer.length, rendered + pageBytes);
    const frag = document.createDocumentFragment();
    for (const row of renderHexBytes(buffer.subarray(rendered, end), rendered)) {
      const el = document.createElement('div');
      el.className = 'vv-hex-row';
      el.textContent = row;
      frag.append(el);
    }
    if (loadMore !== null) loadMore.remove();
    dump.append(frag);
    rendered = end;
    if (rendered < buffer.length) {
      loadMore = document.createElement('button');
      loadMore.type = 'button';
      loadMore.className = 'vv-hex-more';
      loadMore.textContent = `加载更多（已显示 ${formatSize(rendered)} / ${formatSize(buffer.length)}）`;
      loadMore.onclick = () => renderPage();
      dump.append(loadMore);
    } else {
      loadMore = null;
    }
  }

  renderPage();

  // ---- 结构树（Worker 化）----
  let worker: Worker | null = null;
  const structReady = (async (): Promise<void> => {
    try {
      const head = buffer.slice(0, STRUCT_HEAD_BYTES);
      let result: ParseResult;
      if (opts.createWorker) {
        worker = opts.createWorker();
        if (!worker) return;
        // 动态 import 避免把 client 静态拖进依赖图（同 highlight 薄壳模式）
        const { BinaryClient } = await import('./client');
        const client = new BinaryClient(worker);
        try {
          result = await client.parseStruct(head);
        } finally {
          client.dispose();
        }
      } else {
        const { parseStruct } = await import('./struct');
        result = parseStruct(head);
      }
      if (!root.isConnected) return;
      if (result.root) {
        status.textContent = `${formatSize(buffer.length)} · ${result.root.name}${result.truncated ? '（解析超时，结构不完整）' : ''}`;
        const details = document.createElement('details');
        details.className = 'vv-hex-struct';
        const summary = document.createElement('summary');
        summary.textContent = '结构';
        details.append(summary, nodeToDetails(result.root, false));
        body.append(details);
      } else {
        status.textContent = `${formatSize(buffer.length)} · 未知二进制`;
      }
    } catch {
      status.textContent = `${formatSize(buffer.length)} · 结构解析失败`;
    }
  })();

  return {
    destroy() {
      worker?.terminate();
      root.remove();
    },
    structReady
  };
}

export const hexRenderer: Renderer = {
  id: 'hex',
  label: '二进制',
  extensions: ['bin', 'exe', 'dll', 'so', 'dylib', 'elf', 'o', 'a', 'class', 'wasm', 'dat', 'img', 'iso', 'dmg'],
  async render(buffer: Uint8Array, target: HTMLElement, _source: FileSource, _det: Detection): Promise<RenderedInstance> {
    // Worker 构建：vite 把 new URL(worker 模块) 打包为独立 chunk；失败（如环境不支持）降级主线程解析
    const instance = renderHex(buffer, target, {
      createWorker: () => {
        try {
          return new Worker(new URL('./binary.worker.ts', import.meta.url), { type: 'module' });
        } catch {
          return null;
        }
      }
    });
    await instance.structReady;
    return {
      destroy() {
        instance.destroy();
      }
    };
  }
};
