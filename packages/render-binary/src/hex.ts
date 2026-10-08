// hex.ts — hex 渲染器（M4 Task 2）。经典三列 dump（等宽行字符串，列对齐由空格保证）。
// BUG-16：1MB 全量一次性渲染（~6.5 万 DOM 行）首屏 1.4~1.8s，改行虚拟滚动——
// buffer 全量已在参数内，可视行经 renderHexBytes 即时格式化，行高固定 18px
// 与 render-text 的 virtualScroller（上移后由 @vviewer/core 提供）共用。
// 原分页「加载更多」语义随之取消：滚动到底即达数据末偏移，无续读步骤。
// 结构树走 binary.worker（BinaryClient），状态行展示大小/识别类型。
import { virtualScroller, type VirtualScrollerHandle, type Detection, type FileSource, type RenderedInstance, type Renderer } from '@vviewer/core';
import { renderHexBytes, HEX_ROW_BYTES } from './hexBytes';
import { STRUCT_TAIL_BYTES, type ParseResult, type StructNode } from './struct';

/** hex 行高（px）：字号 12px × 1.5 行距，与 app.css .vv-hex-dump 一致；行内样式显式锁定 */
export const HEX_LINE_HEIGHT = 18;
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
  summary.textContent = node.name;
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
  const root = document.createElement('div');
  root.className = 'vv-hex';
  const status = document.createElement('div');
  status.className = 'vv-hex-status';
  status.textContent = formatSize(buffer.length);
  const body = document.createElement('div');
  body.className = 'vv-hex-body';
  const dump = document.createElement('div');
  dump.className = 'vv-hex-dump';
  // dump 即虚拟滚动容器（.vv-virtual 由 virtualScroller 加）：自身滚动、占满 body
  // 剩余空间，结构树出现在其后不需滚过全部行。字号/行距行内锁定（行高常量
  // HEX_LINE_HEIGHT 依赖此值），不依赖 app.css 到位。
  dump.style.cssText =
    'flex:1 1 auto; min-height:0; overflow:auto;' +
    'font-family:var(--vv-code-font, monospace); font-size:12px; line-height:1.5; white-space:pre;';
  body.append(dump);
  root.append(status, body);
  target.replaceChildren(root);

  // ---- 虚拟滚动 dump：总行数 = ceil(大小/16)，可视行即时格式化 ----
  const rowCount = Math.ceil(buffer.length / HEX_ROW_BYTES);
  const scroller: VirtualScrollerHandle = virtualScroller(
    dump,
    rowCount,
    HEX_LINE_HEIGHT,
    (first, last, viewport) => {
      const start = first * HEX_ROW_BYTES;
      const end = Math.min(buffer.length, (last + 1) * HEX_ROW_BYTES);
      const frag = document.createDocumentFragment();
      if (start < end) {
        for (const row of renderHexBytes(buffer.subarray(start, end), start)) {
          const el = document.createElement('div');
          el.className = 'vv-hex-row';
          el.textContent = row;
          frag.append(el);
        }
      }
      viewport.replaceChildren(frag);
    }
  );

  // ---- 结构树（Worker 化，失败降级主线程）----
  let worker: Worker | null = null;
  const structReady = (async (): Promise<void> => {
    try {
      // head 供 magic 识别；tail（EOCD 尾窗，≤64KB+22）供 ZIP 分支扫描——本地来源
      // buffer 全量在手，同步 slice 即可，无 IO 改动。两段 slice 各自独立可 transfer；
      // 交给 worker 的副本会被 transfer 脱离原 buffer，兜底路径重新 slice（同旧版
      // head 被转移后兜底失效的坑，这里一并规避）。
      const tailLen = Math.min(STRUCT_TAIL_BYTES, buffer.length);
      const fallbackParse = async (): Promise<ParseResult> => {
        const { parseStruct } = await import('./struct');
        return parseStruct(buffer.slice(0, STRUCT_HEAD_BYTES), {
          tail: buffer.slice(buffer.length - tailLen),
          totalSize: buffer.length
        });
      };
      let result: ParseResult;
      const w = opts.createWorker?.();
      if (w) {
        worker = w;
        // 动态 import 避免把 client 静态拖进依赖图（同 highlight 薄壳模式）
        const { BinaryClient } = await import('./client');
        const client = new BinaryClient(w);
        try {
          result = await client.parseStruct(
            buffer.slice(0, STRUCT_HEAD_BYTES),
            { tail: buffer.slice(buffer.length - tailLen), totalSize: buffer.length }
          );
        } catch {
          result = await fallbackParse(); // worker 出错/无响应：主线程同构兜底
        } finally {
          client.dispose();
        }
      } else {
        result = await fallbackParse(); // 无 Worker 可用（环境不支持/创建失败）
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
      scroller.destroy();
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
