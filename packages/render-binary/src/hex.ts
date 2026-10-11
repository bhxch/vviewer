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

/**
 * 跳转输入解析（spec §2.1 语法消歧义）：`0x` 前缀按十六进制，其余按十进制；
 * 非法/负数/空 → null（空输入不动作）。独立纯函数便于单测。
 */
export function parseGotoInput(input: string): number | null {
  const s = input.trim();
  if (s === '') return null;
  const hex = /^0x([0-9a-f]+)$/i.exec(s);
  if (hex) return parseInt(hex[1]!, 16);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return null;
}

// .vv-hex-goto-flash 衰减样式（注入一次，模块级去重）：加类即着色（transition 0s），
// 移除类后经 .vv-hex-row 基态过渡 1s 渐隐。不依赖 app.css 到位（同 dump 字号锁定
// 思路）；Task 3 cursor 字节级高亮落地后由其统一收编。
let gotoFlashStyleInjected = false;
function ensureGotoFlashStyle(): void {
  if (gotoFlashStyleInjected) return;
  gotoFlashStyleInjected = true;
  const style = document.createElement('style');
  style.textContent =
    '.vv-hex-row{transition:background-color 1s ease-out}' +
    '.vv-hex-goto-flash{background-color:rgba(255,176,0,.4);transition:background-color 0s}';
  document.head.append(style);
}

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
  // ---- 工具条（spec §2.1）：dump 的兄弟节点而非子节点——virtualScroller 会
  // replaceChildren 滚动容器，放里面会被清掉且 spacer 定位被顶偏（code.ts 提示条
  // 先例）。Task 1 只渲染跳转框（搜索框 Task 2 再增补，占位 disabled 会误导）；
  // 状态位先行就位（超界提示 / Task 2 命中计数复用）。样式行内锁定（同 dump 思路，
  // 不依赖 app.css 到位）；位于滚动区上方、flex:none，即 sticky 语义。
  const toolbar = document.createElement('div');
  toolbar.className = 'vv-hex-toolbar';
  toolbar.style.cssText =
    'flex:none; display:flex; align-items:center; gap:8px; padding:4px 10px;' +
    'border-bottom:1px solid var(--ui-border, rgba(128,128,128,.35));';
  const gotoInput = document.createElement('input');
  gotoInput.className = 'vv-hex-goto';
  gotoInput.placeholder = '跳转 (0x10 或 16)';
  gotoInput.setAttribute('aria-label', '跳转到偏移');
  gotoInput.style.cssText = 'flex:0 1 auto; width:12em; min-width:0;';
  const toolbarStatus = document.createElement('span');
  toolbarStatus.className = 'vv-hex-toolbar-status';
  toolbarStatus.style.cssText = 'font-size:12px; color:var(--ui-fg-muted, inherit);';
  toolbar.append(gotoInput, toolbarStatus);
  root.append(status, toolbar, body);
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

  // ---- 跳转（spec §2.1）：解析 → 超界 clamp → 经既有虚拟滚动定位 → 瞬时高亮 ----
  const GOTO_FLASH_MS = 1000;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  function flashTargetRow(row: number): void {
    // 行级近似：按行首偏移列（8 位小写 hex，与 renderHexBytes 一致）匹配目标行，
    // 加临时类 1s 后移除。Task 3 的 cursor span 切分机制落地后升级为字节级高亮，
    // 此处随之收编。
    const want = (row * HEX_ROW_BYTES).toString(16).padStart(8, '0');
    for (const el of dump.querySelectorAll<HTMLElement>('.vv-hex-row')) {
      if (!(el.textContent ?? '').startsWith(want)) continue;
      el.classList.add('vv-hex-goto-flash');
      if (flashTimer !== null) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        el.classList.remove('vv-hex-goto-flash');
        flashTimer = null;
      }, GOTO_FLASH_MS);
      break;
    }
  }
  function gotoOffset(): void {
    const parsed = parseGotoInput(gotoInput.value);
    if (parsed === null || buffer.length === 0) return; // 空输入不动作（spec §2.1）
    const clamped = Math.min(parsed, buffer.length - 1); // 超界 clamp 到最后一个字节
    toolbarStatus.textContent = clamped < parsed ? '已跳至文件尾' : '';
    const row = Math.floor(clamped / HEX_ROW_BYTES);
    // scroller 无居中 API：目标行滚至视口中部（jsdom 等无布局环境 clientHeight=0
    // 退化为行顶对齐）。scrollTop 赋值即时生效，浏览器 scroll 事件随后到达时可视
    // 区间未变为 no-op；refresh(true) 保证目标行在下面的高亮查询前已同步渲染。
    dump.scrollTop = Math.max(0, row * HEX_LINE_HEIGHT - dump.clientHeight / 2);
    scroller.refresh(true);
    ensureGotoFlashStyle();
    flashTargetRow(row);
  }
  gotoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') gotoOffset();
  });

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
      if (flashTimer !== null) clearTimeout(flashTimer);
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
