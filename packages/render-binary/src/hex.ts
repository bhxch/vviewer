// hex.ts — hex 渲染器（M4 Task 2）。经典三列 dump（等宽行字符串，列对齐由空格保证）。
// BUG-16：1MB 全量一次性渲染（~6.5 万 DOM 行）首屏 1.4~1.8s，改行虚拟滚动——
// buffer 全量已在参数内，可视行经 renderHexBytes 即时格式化，行高固定 18px
// 与 render-text 的 virtualScroller（上移后由 @vviewer/core 提供）共用。
// 原分页「加载更多」语义随之取消：滚动到底即达数据末偏移，无续读步骤。
// 结构树走 binary.worker（BinaryClient），状态行展示大小/识别类型。
// Task 2（spec H §2.2）：工具条搜索——worker 分块扫描（进度/取消/截断），
// 命中列表驻主线程镜像（数组 + 行号 Set），命中行两档 span 切分高亮与导航。
// Task 3（spec H §2.3）：数据检查器——cursor 点击/键盘定位 + 光标字节高亮（复用
// span 切分，cursor/flash 档与命中档按字节叠加），跳转行级 flash 收编为字节级；
// getInspector/setLittle 鸭子接口供 ViewerPane 轮询上行/总线下行（本包不依赖 web）。
// Task 5（io-streaming）：renderHex 增末参 StreamCtx——size 已知来源走窗口模式
//（hexSource 块缓存供数：可视行命中直取、未就绪占位 + ensure 拉块重渲），size
// 未知由 hexRenderer 先做全量回退读再进既有全量装配。行格式输出与全量模式逐字节
// 一致（spec §4.1，hex.test 窗口用例钉住）。
// Task 6（io-streaming）：窗口模式搜索接 need/chunk 握手——worker 以 search-need
//（1MB 步进）驱动、client 经 ctx.read 逐块回灌，超大文件不再整件预读（T5 全量
// 回退过渡方案移除，仅存于无 Worker 降级路径）。
import { virtualScroller, type VirtualScrollerHandle, type Detection, type FileSource, type RenderedInstance, type Renderer, type StreamCtx } from '@vviewer/core';
import { renderHexBytes, HEX_ROW_BYTES, byteIndexAtColumn } from './hexBytes';
import type { HexHighlight, HexRow } from './hexBytes';
import { decodeAt, INSPECTOR_WINDOW_BYTES, type InspectorRow, type InspectorSnapshot } from './inspector';
import type { BinaryClient, SearchDoneInfo, SearchProgressInfo } from './client';
import { scanAll } from './searchScan';
import { createHexSource, HexSourceRangeError, type HexSource } from './hexSource';
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

/**
 * 搜索输入解析（Task 2，spec §2.2 hex/文本消歧义）：去空白后为偶数位合法 hex 串
 * → 按字节；奇数位 hex → invalid（aria-invalid 内联提示）；其余（含 0x 前缀、
 * 一般文本）→ 文本（UTF-8 编码）；空 → null（不动作）。独立纯函数便于单测。
 */
export type ParsedSearchInput =
  | { kind: 'hex'; bytes: Uint8Array }
  | { kind: 'text'; bytes: Uint8Array }
  | { kind: 'invalid' };

export function parseSearchInput(input: string): ParsedSearchInput | null {
  const s = input.trim();
  if (s === '') return null;
  const hexStr = s.replace(/\s+/g, '');
  if (/^[0-9a-f]+$/i.test(hexStr)) {
    if (hexStr.length % 2 !== 0) return { kind: 'invalid' };
    const bytes = new Uint8Array(hexStr.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
    }
    return { kind: 'hex', bytes };
  }
  return { kind: 'text', bytes: new TextEncoder().encode(s) };
}

// 高亮样式（命中两档 / 光标 / 跳转衰减）已收编 app.css 的 .vv-hex-* 段落（Task 3
// 裁决）：原运行时 <style> 注入不随 destroy 清理的问题随之消除。

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
 * 搜索扫描数据源（io-streaming Task 6）：full = buffer 直用（全量模式现状，data
 * 协议）；window = size + read 交 client need/chunk 握手逐块拉取（worker 驱动）。
 */
type SearchScanSource =
  | { kind: 'full'; bytes: Uint8Array }
  | { kind: 'window'; size: number; read: (r: { start: number; end: number }) => Promise<Uint8Array<ArrayBuffer>> };

/**
 * hex dump DOM 渲染（hexRenderer.render 的主体，独立导出便于复用）。
 * 末参 ctx（Task 5）：streaming 渲染时由 hexRenderer 透传 dispatch 构造的 StreamCtx。
 * ctx === undefined → 现状全量逻辑（buffer 直用，零行为变化）；ctx.size 已知 →
 * 窗口模式（hexSource 块缓存）。size 未知的 ctx 不进本函数（hexRenderer 已先做
 * 全量回退读；此处收到即调用违约，抛错而非以 head 静默截断）。
 * 返回实例 destroy：移除 DOM、终止 worker；getInspector/setLittle：数据检查器
 * 鸭子接口（Task 3，ViewerPane 轮询上行/总线下行）。
 */
export function renderHex(
  buffer: Uint8Array,
  target: HTMLElement,
  opts: HexDomOptions = {},
  ctx?: StreamCtx
): {
  destroy(): void;
  structReady: Promise<void>;
  getInspector(): InspectorSnapshot | null;
  setLittle(v: boolean): void;
} {
  // size 未知的 ctx 属调用违约：hexRenderer 已先做全量回退读；renderHex 若直接以
  // 8KB head 静默续渲即截断活面——宁抛不截
  const ctxSize = ctx?.size ?? null;
  if (ctx !== undefined && ctxSize === null) {
    throw new Error('renderHex 不接受 size 未知的 ctx：size 未知来源应由 hexRenderer 先做全量回退读');
  }
  // 窗口模式判定（窗口模式不变量：ctx.head 即 dispatch 的 base/probe，与 buffer
  // 形参同一字节——headOnly 时为 8KB 探测块，≤1MB 全量策略/非 rangeCapable 时为
  // 全量，后者块缓存全部预置命中、read 永不触发，自然退化为全量行为）。
  const src: HexSource | null =
    ctx !== undefined && ctxSize !== null ? createHexSource(ctxSize, ctx.head, ctx.read) : null;
  /**
   * Range-less 全量切换（终审 F3）：ensure 抛 HexSourceRangeError（块读超返回 =
   * 服务器忽略 Range 回 200 全量）时，以错误携带的全量响应重建块底座——此后
   * slice 恒命中、ensure 零 IO。返回是否已切换，调用方据此重渲/重算而非落失败面。
   */
  function adoptFull(e: unknown): boolean {
    if (!(e instanceof HexSourceRangeError)) return false;
    src?.replaceWithFull(e.full);
    return true;
  }
  /** 总字节数：全量模式 = buffer.length；窗口模式 = ctx.size（行数/状态行/clamp 的事实来源） */
  const totalSize = src !== null ? src.size : buffer.length;
  const root = document.createElement('div');
  root.className = 'vv-hex';
  const status = document.createElement('div');
  status.className = 'vv-hex-status';
  status.textContent = formatSize(totalSize);
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
  // ---- 工具条（spec §2.1/§2.2）：dump 的兄弟节点而非子节点——virtualScroller 会
  // replaceChildren 滚动容器，放里面会被清掉且 spacer 定位被顶偏（code.ts 提示条
  // 先例）。Task 1 跳转框 + Task 2 搜索簇（输入/大小写开关/上下导航/状态位/取消）。
  // 样式行内锁定（同 dump 思路，不依赖 app.css 到位）；位于滚动区上方、flex:none，
  // 即 sticky 语义。
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
  // 搜索簇（Task 2）
  const searchInput = document.createElement('input');
  searchInput.className = 'vv-hex-search';
  searchInput.placeholder = '搜索 (hex 或文本)';
  searchInput.setAttribute('aria-label', '搜索（hex 字节或文本）');
  searchInput.style.cssText = 'flex:0 1 auto; width:12em; min-width:0;';
  const caseToggle = document.createElement('input');
  caseToggle.type = 'checkbox';
  caseToggle.className = 'vv-hex-search-case';
  caseToggle.setAttribute('aria-label', '区分大小写（仅文本搜索）');
  caseToggle.checked = true; // spec §Global Constraints：大小写开关默认敏感

  const btnCss = 'flex:none; font-size:12px; padding:1px 6px; cursor:pointer;';
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'vv-hex-search-prev';
  prevBtn.textContent = '↑';
  prevBtn.setAttribute('aria-label', '上一处命中');
  prevBtn.style.cssText = btnCss;
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'vv-hex-search-next';
  nextBtn.textContent = '↓';
  nextBtn.setAttribute('aria-label', '下一处命中');
  nextBtn.style.cssText = btnCss;
  const searchStatus = document.createElement('span');
  searchStatus.className = 'vv-hex-search-status';
  searchStatus.style.cssText = 'font-size:12px; color:var(--ui-fg-muted, inherit);';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'vv-hex-search-cancel';
  cancelBtn.textContent = '取消';
  cancelBtn.style.cssText = `${btnCss} display:none;`;
  toolbar.append(gotoInput, toolbarStatus, searchInput, caseToggle, prevBtn, nextBtn, searchStatus, cancelBtn);
  root.append(status, toolbar, body);
  target.replaceChildren(root);

  // ---- 搜索状态（Task 2）：声明先于 virtualScroller（其初始化即触发 onRange，
  // 闭包引用这些变量，声明在后会 TDZ）。命中列表驻主线程镜像（数组 + 行号 Set：
  // onRange 按行 O(1) 判定该行走 span 切分，其余行整串零开销）。----
  let searchClient: BinaryClient | null = null; // 常驻（structReady 的 client 解析完即 dispose 终止）
  let searchClientPromise: Promise<BinaryClient | null> | null = null;
  let searchSeq = 0; // 主线程取消令牌：兜底扫描与迟滞回调的失效判据
  let hitOffsets: number[] = [];
  let hitIndex = -1;
  const hitRows = new Set<number>();
  let hitNeedleLen = 0;
  let hitTruncated = false;
  let lastSearchedInput: string | null = null;
  let progressScanned = 0;
  let progressTotal = 0;
  let searchBusy = false;

  // ---- 检查器状态（Task 3，spec §2.3）：cursor 单字节 + 跳转 flash 单区间 + 字节序。
  // 声明先于 virtualScroller（其初始化即触发 onRange，闭包引用这些变量，声明在后会
  // TDZ，同搜索状态注记）。inspectorRows 为 cursor 处解码缓存（cursor/字节序变化时
  // 重算，getInspector 直读，ViewerPane 轮询上行）----
  let cursor: number | null = null; // 光标字节（绝对偏移；null = 未定位）
  let flashOffset: number | null = null; // 跳转目标字节（绝对偏移；1s 衰减）
  let little = true; // 检查器字节序（spec §2.3：默认小端）
  let inspectorRows: InspectorRow[] = [];

  // ---- 虚拟滚动 dump：总行数 = ceil(大小/16)，可视行即时格式化 ----
  const rowCount = Math.ceil(totalSize / HEX_ROW_BYTES);
  const scroller: VirtualScrollerHandle = virtualScroller(
    dump,
    rowCount,
    HEX_LINE_HEIGHT,
    (first, last, viewport) => {
      const start = first * HEX_ROW_BYTES;
      const end = Math.min(totalSize, (last + 1) * HEX_ROW_BYTES);
      const frag = document.createDocumentFragment();
      if (start < end) {
        // 窗口取数（Task 5）：全量模式 buffer 直取（现状）；窗口模式经 src 块缓存——
        // 未就绪返回 null，走「占位 + ensure + 重渲」路径
        const slice = src !== null ? src.slice(start, end) : buffer.subarray(start, end);
        if (slice === null) {
          // 窗口块未就绪（io-streaming Task 5）：占位行保行高（单个空格在
          // white-space:pre 下撑起 18px 行高，行格式与真实行同构仅无文本），
          // ensure 到位后 refresh 重渲当前窗口。读失败自兜底（评审指令①口径）：
          // 占位保留 + 工具条状态位提示，不落错误卡片、不影响其余窗口滚动。
          for (let r = first; r <= last; r++) {
            const el = document.createElement('div');
            el.className = 'vv-hex-row';
            el.textContent = ' ';
            frag.append(el);
          }
          viewport.replaceChildren(frag);
          void src!.ensure(start, end).then(() => {
            if (root.isConnected) scroller.refresh(true); // 就绪后重渲当前窗口
          }).catch((e: unknown) => {
            // Range-less 服务器（终审 F3）：超返回已在 hexSource 判定为全量——切换
            // 全量底座后重渲当前窗口，行字节随即正确；其余读失败自兜底（评审指令①
            // 口径）：占位保留 + 工具条状态位提示，不落错误卡片、不影响其余窗口滚动。
            if (adoptFull(e)) {
              if (root.isConnected) scroller.refresh(true);
              return;
            }
            if (root.isConnected) toolbarStatus.textContent = '窗口读取失败';
          });
          return;
        }
        // 装饰行判定 O(1)：命中行 Set ∪ 光标行 ∪ flash 行，窗口含任一装饰才走
        // span 切分，否则整串（与原版逐字节一致，零开销）
        const cursorRow = cursor === null ? -1 : Math.floor(cursor / HEX_ROW_BYTES);
        const flashRow = flashOffset === null ? -1 : Math.floor(flashOffset / HEX_ROW_BYTES);
        let windowHasDecor = false;
        for (let r = first; r <= last; r++) {
          if (hitRows.has(r) || r === cursorRow || r === flashRow) {
            windowHasDecor = true;
            break;
          }
        }
        if (!windowHasDecor) {
          for (const row of renderHexBytes(slice, start)) {
            const el = document.createElement('div');
            el.className = 'vv-hex-row';
            el.textContent = row;
            frag.append(el);
          }
        } else {
          // 窗口内装饰 → 字节区间（窗口相对坐标；needle 起点可越窗界，一并纳入）。
          // 四档互斥按字节叠加、高档胜出（cursor > flash > 当前命中 > 普通命中，
          // 合并逻辑在 hexBytes highlightIntervals）——cursor 单区间与命中区间
          // 同行/同字节共存即天然合并，此处只需把各装饰区间线性并入。
          const activeOff = hitIndex >= 0 ? hitOffsets[hitIndex]! : -1;
          const hls: HexHighlight[] = [];
          if (hitNeedleLen > 0) {
            for (const off of hitOffsets) {
              if (off + hitNeedleLen <= start || off >= end) continue;
              hls.push({ start: off - start, end: off - start + hitNeedleLen, active: off === activeOff });
            }
          }
          if (cursor !== null && cursor >= start && cursor < end) {
            hls.push({ start: cursor - start, end: cursor - start + 1, active: false, cursor: true });
          }
          if (flashOffset !== null && flashOffset >= start && flashOffset < end) {
            hls.push({ start: flashOffset - start, end: flashOffset - start + 1, active: false, flash: true });
          }
          for (const row of renderHexBytes(slice, start, hls)) {
            const el = document.createElement('div');
            el.className = 'vv-hex-row';
            if (typeof row === 'string') {
              el.textContent = row;
            } else {
              for (const span of (row as HexRow).spans) {
                if (span.active === undefined && !span.cursor && !span.flash) {
                  el.append(document.createTextNode(span.text));
                } else {
                  const s = document.createElement('span');
                  s.className = span.cursor
                    ? 'vv-hex-cursor'
                    : span.flash
                      ? 'vv-hex-goto-flash'
                      : span.active
                        ? 'vv-hex-hit vv-hex-hit-active'
                        : 'vv-hex-hit';
                  s.textContent = span.text;
                  el.append(s);
                }
              }
            }
            frag.append(el);
          }
        }
      }
      viewport.replaceChildren(frag);
    }
  );

  // ---- 跳转（spec §2.1）：解析 → 超界 clamp → 经既有虚拟滚动定位 → 字节级瞬时
  // 高亮（Task 1 行级 flash 收编为 Task 3 span 切分 flash 档；样式在 app.css
  // .vv-hex-goto-flash，衰减动画由其 keyframes 承担，1s 后重绘摘除——span 随重绘
  // 重建，transition 渐隐不可行）----
  const GOTO_FLASH_MS = 1000;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  function setFlash(offset: number | null): void {
    flashOffset = offset;
    if (flashTimer !== null) clearTimeout(flashTimer);
    flashTimer = null;
    if (offset !== null) {
      flashTimer = setTimeout(() => {
        flashOffset = null;
        flashTimer = null;
        scroller.refresh(true); // 衰减结束：重绘摘除高亮
      }, GOTO_FLASH_MS);
    }
    scroller.refresh(true);
  }
  function gotoOffset(): void {
    // 空文件分支置于非法输入清态之前（终审 Minor 4）：空文件任何输入都不动作，
    // 不存在「合法输入早退绕过清态致旧文案残留」的路径分歧
    if (totalSize === 0) return; // 空文件不动作（spec §2.1）
    const parsed = parseGotoInput(gotoInput.value);
    if (parsed === null) {
      toolbarStatus.textContent = ''; // 非法输入清空过期状态位（如「已跳至文件尾」残留）
      return;
    }
    const clamped = Math.min(parsed, totalSize - 1); // 超界 clamp 到最后一个字节
    toolbarStatus.textContent = clamped < parsed ? '已跳至文件尾' : '';
    const row = Math.floor(clamped / HEX_ROW_BYTES);
    // scroller 无居中 API：目标行滚至视口中部（jsdom 等无布局环境 clientHeight=0
    // 退化为行顶对齐）。scrollTop 赋值即时生效，浏览器 scroll 事件随后到达时可视
    // 区间未变为 no-op；refresh(true) 保证目标行在下面的高亮查询前已同步渲染。
    dump.scrollTop = Math.max(0, row * HEX_LINE_HEIGHT - dump.clientHeight / 2);
    scroller.refresh(true);
    setFlash(clamped);
  }
  gotoInput.addEventListener('keydown', (e) => {
    if (e.isComposing) return; // IME 组合期不提交
    if (e.key === 'Enter') gotoOffset();
  });

  // ---- 搜索行为（Task 2，spec §2.2）：worker 分块扫描 + 兜底主线程 scanAll ----
  // 搜索 worker 与结构树分离：懒创建常驻（structReady 的 client 解析完即 dispose
  // 终止其 worker，搜索需要长生命周期）；环境无 Worker 时兜底主线程 scanAll
  // （同分块语义，块间让出可取消，小文件同步量级）。
  function ensureSearchClient(): Promise<BinaryClient | null> {
    if (searchClientPromise) return searchClientPromise;
    searchClientPromise = (async (): Promise<BinaryClient | null> => {
      const w = opts.createWorker?.() ?? null;
      if (!w) return null;
      try {
        // 动态 import 避免把 client 静态拖进依赖图（同 structReady 薄壳模式）
        const { BinaryClient: BinaryClientImpl } = await import('./client');
        searchClient = new BinaryClientImpl(w);
        return searchClient;
      } catch (e) {
        w.terminate(); // 终审 Minor 3：import/构造失败终止已建 worker，避免泄漏
        throw e;
      }
    })().catch(() => null); // 建连失败降级主线程 scanAll，且缓存 promise 不再拒
    return searchClientPromise;
  }

  function setSearchBusy(busy: boolean): void {
    searchBusy = busy;
    cancelBtn.style.display = busy ? '' : 'none';
  }

  function addHitRows(offsets: number[]): void {
    for (const off of offsets) hitRows.add(Math.floor(off / HEX_ROW_BYTES));
  }

  function renderSearchStatus(): void {
    const n = hitOffsets.length;
    if (searchBusy) {
      searchStatus.textContent = `${progressScanned}/${progressTotal}`;
    } else if (n === 0) {
      searchStatus.textContent = lastSearchedInput !== null ? '无命中' : '';
    } else if (hitIndex >= 0) {
      searchStatus.textContent = `${hitIndex + 1}/${n} 处命中${hitTruncated ? '（截断）' : ''}`;
    } else {
      searchStatus.textContent = `${n} 处命中${hitTruncated ? '（截断）' : ''}`;
    }
  }

  /** 命中导航：循环取模；滚动定位同 goto（jsdom 无布局退化为行顶对齐）+ 同步重绘 */
  function gotoHit(index: number): void {
    const n = hitOffsets.length;
    if (n === 0) return;
    hitIndex = ((index % n) + n) % n;
    const row = Math.floor(hitOffsets[hitIndex]! / HEX_ROW_BYTES);
    dump.scrollTop = Math.max(0, row * HEX_LINE_HEIGHT - dump.clientHeight / 2);
    scroller.refresh(true); // 当前命中行以 active 档重绘
    renderSearchStatus();
  }

  /** 搜索执行（数据底座就绪后）：worker 分块扫描 + 兜底主线程 scanAll。Task 6 数
   * 据源参数化为两形态——全量（buffer 直用，data 协议现状）与窗口（size+read 交
   * worker need/chunk 握手逐块拉取）；令牌/回调逻辑两形态共用（legacy 路径时序不变）。 */
  function runSearch(
    parsed: NonNullable<Exclude<ParsedSearchInput, { kind: 'invalid' }>>,
    source: SearchScanSource,
    seq: number
  ): void {
    const caseInsensitive = parsed.kind === 'text' && !caseToggle.checked;
    const onProgress = (p: SearchProgressInfo): void => {
      if (seq !== searchSeq) return;
      progressScanned = p.scanned;
      progressTotal = p.total;
      addHitRows(p.offsets);
      renderSearchStatus();
      scroller.refresh(true); // 进度到达即重绘可视区命中
    };
    const onDone = (r: SearchDoneInfo): void => {
      if (seq !== searchSeq) return;
      if (r.error !== undefined) {
        // 窗口模式供数失败（读失败/短读/超时）：复位忙碌 + 状态位提示，不落错误卡片
        setSearchBusy(false);
        searchStatus.textContent = '搜索数据读取失败';
        return;
      }
      hitOffsets = r.offsets;
      hitTruncated = r.truncated;
      addHitRows(r.offsets);
      setSearchBusy(false);
      if (hitOffsets.length > 0) {
        gotoHit(0); // 首个命中滚动定位 + active 档
      } else {
        renderSearchStatus();
        scroller.refresh(true); // 清除上一轮残留高亮
      }
    };
    void ensureSearchClient().then((client) => {
      if (seq !== searchSeq) return; // 建连期间已被新搜索/取消取代
      if (client) {
        if (source.kind === 'window') {
          // 窗口模式：无 data 请求，worker 经 search-need 驱动、client 注入的 read
          // 闭包逐块回灌（Task 6 协议）
          client.search(parsed.bytes, { size: source.size, read: source.read, caseInsensitive, onProgress, onDone });
          return;
        }
        client.search(parsed.bytes, { data: source.bytes, caseInsensitive, onProgress, onDone });
        return;
      }
      // 无 Worker 兜底：主线程 scanAll。窗口模式需备齐全量字节——head 已覆盖全文
      // 件直用 buffer（零读），否则一次全量回退读（T5 过渡语义仅存于本降级路径）。
      // 读失败自兜底（终审 F1：链尾 catch 与 worker 主路径 r.error 同口径——复位
      // 忙碌 + 状态位提示，不落错误卡片；此前 reject 无 handler 会 unhandled
      // rejection 且忙碌态永不复位，base===null 死分支随之消除）。
      void (async (): Promise<Uint8Array> => {
        if (source.kind === 'full') return source.bytes;
        if (buffer.length >= source.size) return buffer;
        // M-2：Range-less 降级（replaceWithFull）后全量已在 src 手里——复用之，
        // 不再对已在本地的一件多付一次全量读（head 即全量的形态已由上一行判定，
        // 与 src.degradedFull 互补覆盖两种全量在手形态）。兜底取数与降级并发竞态
        // 的最坏代价是回落一次回退读（修前行为），不另加锁。
        const degraded = src?.degradedFull() ?? null;
        if (degraded !== null) return degraded;
        return ctx!.read({ start: 0, end: Number.MAX_SAFE_INTEGER });
      })().then((base) => {
        if (seq !== searchSeq) return; // 拉取期间已被新搜索/取消取代
        void scanAll(base, parsed.bytes, {
          fold: caseInsensitive,
          shouldContinue: () => seq === searchSeq,
          onChunk: (info) => {
            onProgress({ scanned: info.scanned, total: info.total, hits: info.hits, offsets: info.offsets });
          }
        }).then((res) => {
          if (seq !== searchSeq || res.aborted) return;
          onDone({ truncated: res.truncated, offsets: res.offsets });
        });
      }).catch(() => {
        if (seq !== searchSeq) return; // 已被新搜索/取消取代：不覆盖新任务的状态位
        setSearchBusy(false);
        searchStatus.textContent = '搜索数据读取失败';
      });
    });
  }

  function startSearch(): void {
    const parsed = parseSearchInput(searchInput.value);
    if (parsed === null || totalSize === 0) return; // 空输入/空文件不动作
    if (parsed.kind === 'invalid') {
      searchInput.setAttribute('aria-invalid', 'true');
      searchStatus.textContent = 'hex 位数须为偶数';
      return;
    }
    searchInput.removeAttribute('aria-invalid');
    // 新搜索自动取消旧任务：seq 失效兜底回调；client.search 覆盖处理器（旧 id
    // 消息丢弃），worker 收到新请求后亦因搜索 id 失效在块边界停扫
    const seq = ++searchSeq;
    hitOffsets = [];
    hitIndex = -1;
    hitRows.clear();
    hitNeedleLen = parsed.bytes.length;
    hitTruncated = false;
    lastSearchedInput = searchInput.value;
    progressScanned = 0;
    progressTotal = totalSize;
    setSearchBusy(true);
    renderSearchStatus();
    if (src === null) {
      runSearch(parsed, { kind: 'full', bytes: buffer }, seq); // 全量模式：buffer 即扫描底座（Task 2 原路径）
      return;
    }
    // 窗口模式（io-streaming Task 6 need/chunk 握手）：worker 逐块经 ctx.read 拉取
    // 扫描（1MB 步进、末块钳制），超大文件不再整件预读（T5 全量回退过渡方案移除）。
    // 命中行的块加载仍走「slice null → ensure + 重渲」——gotoHit 定位行未就绪时
    // 占位、到位后高亮重绘，命中 offset 所在块由 ensure 保证。
    runSearch(parsed, { kind: 'window', size: src.size, read: ctx!.read }, seq);
  }

  searchInput.addEventListener('input', () => {
    const parsed = parseSearchInput(searchInput.value);
    if (parsed?.kind === 'invalid') {
      searchInput.setAttribute('aria-invalid', 'true');
      searchStatus.textContent = 'hex 位数须为偶数';
    } else {
      searchInput.removeAttribute('aria-invalid');
      if (!searchBusy) renderSearchStatus();
    }
    caseToggle.disabled = parsed?.kind !== 'text'; // 大小写开关仅文本模式有意义
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.isComposing) return; // IME 组合期不提交
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (searchInput.value !== lastSearchedInput) {
      startSearch(); // 输入变化 → 发起新搜索
    } else if (e.shiftKey) {
      gotoHit(hitIndex < 0 ? hitOffsets.length - 1 : hitIndex - 1); // Shift+Enter 上一处（循环）
    } else {
      gotoHit(hitIndex + 1); // Enter 下一处（循环）
    }
  });

  prevBtn.addEventListener('click', () => gotoHit(hitIndex < 0 ? hitOffsets.length - 1 : hitIndex - 1));
  nextBtn.addEventListener('click', () => gotoHit(hitIndex + 1));
  cancelBtn.addEventListener('click', () => {
    ++searchSeq; // 兜底扫描/迟滞回调一并失效
    searchClient?.cancelSearch();
    setSearchBusy(false);
    // 终审 Minor 1：取消即弃部分命中——不清则屏上残留已上屏的部分高亮，与状态位
    // 「已取消」（及后续输入触发的 renderSearchStatus「无命中」）语义漂移
    hitRows.clear();
    hitNeedleLen = 0;
    scroller.refresh(true); // 重绘摘除残留高亮
    searchStatus.textContent = '已取消';
  });

  // ---- 数据检查器（Task 3，spec §2.3）：cursor 点击/键盘定位 + 光标字节高亮 +
  // getInspector/setLittle 鸭子接口。上行/下行均不在本包内：ViewerPane 轮询
  // getInspector 快照写 metaStore（引擎指示器 watchEngine 同款先例），MetaPanel
  // 字节序 select 写 inspectorBus、ViewerPane 探测 setLittle 透传 ----
  function refreshInspectorRows(): void {
    if (cursor === null) return;
    if (src === null) {
      inspectorRows = decodeAt(buffer, cursor, little); // 全量模式：现状直解
      return;
    }
    // 窗口模式（Task 5）：取 cursor 起 ≤16 字节窗口解码——窗口字节与全量模式
    // decodeAt(buffer, cursor) 各行 available/值逐行一致（截断窗口语义同构）。
    // 未就绪先清快照，ensure 到位后重算；读失败静默留空（自兜底，检查器灰显
    // 不阻塞交互），不落错误卡片。
    const winEnd = Math.min(src.size, cursor + INSPECTOR_WINDOW_BYTES);
    const win = src.slice(cursor, winEnd);
    if (win === null) {
      inspectorRows = [];
      void src.ensure(cursor, winEnd).then(() => {
        if (root.isConnected && cursor !== null) refreshInspectorRows();
      }).catch((e: unknown) => {
        // Range-less（终审 F3）已切换全量底座：字节即可得，重算快照；其余读失败
        // 静默留空（自兜底，检查器灰显不阻塞交互），不落错误卡片。
        if (adoptFull(e) && root.isConnected && cursor !== null) refreshInspectorRows();
      });
      return;
    }
    inspectorRows = decodeAt(win, 0, little);
  }
  function setCursor(offset: number): void {
    cursor = offset;
    refreshInspectorRows();
    scroller.refresh(true); // 光标行以 cursor 档重绘
  }
  dump.tabIndex = 0; // 键盘 ±1 需容器可聚焦（点击行内即获得焦点）
  dump.addEventListener('click', (e) => {
    const rowEl = (e.target as HTMLElement | null)?.closest?.('.vv-hex-row') as HTMLElement | null;
    if (!rowEl) return;
    const text = rowEl.textContent ?? '';
    // 整行字符串下按 x 坐标定位字节：等宽布局下行宽/字符数 = 单字符宽（行总宽恒
    // 77 字符——renderHexBytes 尾行空格补齐保证）；无布局环境（jsdom）行宽为 0
    // 无法换算，忽略点击。字符列 → 字节序号经 byteIndexAtColumn（行布局单一来源
    // 在 hexBytes）。行首偏移取自偏移列（8 位小写 hex，与 renderHexBytes 同构）。
    const rect = rowEl.getBoundingClientRect();
    if (rect.width <= 0 || text.length < 10) return;
    const charW = rect.width / text.length;
    const rowStart = parseInt(text.slice(0, 8), 16);
    const rowLen = Math.min(HEX_ROW_BYTES, totalSize - rowStart);
    const col = Math.floor((e.clientX - rect.left) / charW);
    setCursor(rowStart + byteIndexAtColumn(col, rowLen));
  });
  dump.addEventListener('keydown', (e) => {
    if (e.isComposing) return; // IME 组合期不动作
    if (cursor === null) return; // 未定位光标：方向键交还容器默认滚动
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = cursor + (e.key === 'ArrowLeft' ? -1 : 1);
    setCursor(Math.min(totalSize - 1, Math.max(0, next))); // 首尾字节 clamp
    e.preventDefault(); // 光标移动取代容器滚动
  });

  // ---- 结构树（Worker 化，失败降级主线程）----
  let worker: Worker | null = null;
  const structReady = (async (): Promise<void> => {
    try {
      // head 供 magic 识别；tail（EOCD 尾窗，≤64KB+22）供 ZIP 分支扫描。全量模式
      // buffer 全量在手同步 slice；窗口模式 head 即 buffer（探测块），尾窗块先经
      // src ensure 按需拉取（异步语义本就在 structReady promise 内，读失败走下方
      // catch 自兜底「结构解析失败」）。尾窗一律每次调用点取独立拷贝副本：交给
      // worker 的副本会被 transfer 脱离原 ArrayBuffer，兜底路径重新拷贝仍可用
      //（src 缓存块同样绝不能被 detach），窗口/全量两模式语义对齐。
      const tailLen = Math.min(STRUCT_TAIL_BYTES, totalSize);
      if (src !== null) {
        await src.ensure(totalSize - tailLen, totalSize).catch((e: unknown) => {
          // Range-less（终审 F3）已切换全量底座：尾窗块即可得，继续解析；其余读
          // 失败照旧上抛走下方 catch 自兜底「结构解析失败」
          if (!adoptFull(e)) throw e;
        });
      }
      /** 独立尾窗副本：窗口模式经 src（slice 视图 → 拷贝），全量模式 buffer 直 slice */
      const tailSlice = (): Uint8Array => {
        if (src !== null) {
          const t = src.slice(totalSize - tailLen, totalSize);
          if (t === null) throw new Error('结构尾窗块不可得');
          return t.slice();
        }
        return buffer.slice(buffer.length - tailLen);
      };
      const fallbackParse = async (): Promise<ParseResult> => {
        const { parseStruct } = await import('./struct');
        return parseStruct(buffer.slice(0, STRUCT_HEAD_BYTES), {
          tail: tailSlice(),
          totalSize
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
            { tail: tailSlice(), totalSize }
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
        status.textContent = `${formatSize(totalSize)} · ${result.root.name}${result.truncated ? '（解析超时，结构不完整）' : ''}`;
        const details = document.createElement('details');
        details.className = 'vv-hex-struct';
        const summary = document.createElement('summary');
        summary.textContent = '结构';
        details.append(summary, nodeToDetails(result.root, false));
        body.append(details);
      } else {
        status.textContent = `${formatSize(totalSize)} · 未知二进制`;
      }
    } catch {
      status.textContent = `${formatSize(totalSize)} · 结构解析失败`;
    }
  })();

  return {
    destroy() {
      ++searchSeq; // 兜底扫描/迟滞回调失效
      // 终止搜索 worker（与结构树 worker 分离）；建连竞态（client 未就绪）经 promise 兜底
      if (searchClient) searchClient.dispose();
      else void searchClientPromise?.then((c) => c?.dispose());
      if (flashTimer !== null) clearTimeout(flashTimer);
      scroller.destroy();
      worker?.terminate();
      root.remove();
    },
    structReady,
    getInspector(): InspectorSnapshot | null {
      // hex 实例激活但光标未定位 → null（ViewerPane 据此清空 MetaPanel 区块）
      if (cursor === null) return null;
      return { offset: cursor, little, rows: inspectorRows };
    },
    setLittle(v: boolean): void {
      if (little === v) return;
      little = v;
      refreshInspectorRows(); // 字节序变换后重解码（ViewerPane 轮询拾取新快照上行）
    }
  };
}

export const hexRenderer: Renderer = {
  id: 'hex',
  label: '二进制',
  extensions: ['bin', 'exe', 'dll', 'so', 'dylib', 'elf', 'o', 'a', 'class', 'wasm', 'dat', 'img', 'iso', 'dmg'],
  // streaming（io-streaming Task 5）：dispatch 只交付 head + StreamCtx（render 第 5
  // 参），全量字节按需经 ctx.read 拉取（窗口模式），不再整文件预取
  streaming: true,
  async render(buffer: Uint8Array, target: HTMLElement, _source: FileSource, _det: Detection, ctx?: StreamCtx): Promise<RenderedInstance> {
    // size 未知来源回退（spec §5）：一次全量读后走既有全量装配（=旧行为）。远端
    // Range 端点由服务端钳制返回整文件、本地 slice 越界自然钳制。读失败在此 await
    // 处 reject——dispatcher 已把 ctx.read 失败标为 DispatchReadError，直抛调用方
    // 读取失败面（评审指令①口径：不落「错误卡片 + 8KB probe 重试」截断活面）。
    if (ctx !== undefined && ctx.size === null) {
      buffer = await ctx.read({ start: 0, end: Number.MAX_SAFE_INTEGER });
      ctx = undefined;
    }
    // Worker 构建：vite 把 new URL(worker 模块) 打包为独立 chunk；失败（如环境不支持）降级主线程解析
    const instance = renderHex(buffer, target, {
      createWorker: () => {
        try {
          return new Worker(new URL('./binary.worker.ts', import.meta.url), { type: 'module' });
        } catch {
          return null;
        }
      }
    }, ctx);
    await instance.structReady;
    // getInspector/setLittle 供 ViewerPane 属性面板上行/字节序下行（Task 3，鸭子
    // 探测同 code 的 getMeta 先例）；结构化扩展 RenderedInstance 不动 core。
    const rendered: RenderedInstance & {
      getInspector(): InspectorSnapshot | null;
      setLittle(v: boolean): void;
    } = {
      destroy() {
        instance.destroy();
      },
      getInspector: () => instance.getInspector(),
      setLittle: (v) => instance.setLittle(v)
    };
    return rendered;
  }
};
