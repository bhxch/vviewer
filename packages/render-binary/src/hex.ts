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
import { virtualScroller, type VirtualScrollerHandle, type Detection, type FileSource, type RenderedInstance, type Renderer } from '@vviewer/core';
import { renderHexBytes, HEX_ROW_BYTES, byteIndexAtColumn } from './hexBytes';
import type { HexHighlight, HexRow } from './hexBytes';
import { decodeAt, type InspectorRow, type InspectorSnapshot } from './inspector';
import type { BinaryClient, SearchDoneInfo, SearchProgressInfo } from './client';
import { scanAll } from './searchScan';
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
 * hex dump DOM 渲染（hexRenderer.render 的主体，独立导出便于复用）。
 * 返回实例 destroy：移除 DOM、终止 worker；getInspector/setLittle：数据检查器
 * 鸭子接口（Task 3，ViewerPane 轮询上行/总线下行）。
 */
export function renderHex(
  buffer: Uint8Array,
  target: HTMLElement,
  opts: HexDomOptions = {}
): {
  destroy(): void;
  structReady: Promise<void>;
  getInspector(): InspectorSnapshot | null;
  setLittle(v: boolean): void;
} {
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
        const slice = buffer.subarray(start, end);
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
    if (buffer.length === 0) return; // 空文件不动作（spec §2.1）
    const parsed = parseGotoInput(gotoInput.value);
    if (parsed === null) {
      toolbarStatus.textContent = ''; // 非法输入清空过期状态位（如「已跳至文件尾」残留）
      return;
    }
    const clamped = Math.min(parsed, buffer.length - 1); // 超界 clamp 到最后一个字节
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

  function startSearch(): void {
    const parsed = parseSearchInput(searchInput.value);
    if (parsed === null || buffer.length === 0) return; // 空输入/空文件不动作
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
    progressTotal = buffer.length;
    setSearchBusy(true);
    renderSearchStatus();
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
        client.search(parsed.bytes, { data: buffer, caseInsensitive, onProgress, onDone });
        return;
      }
      void scanAll(buffer, parsed.bytes, {
        fold: caseInsensitive,
        shouldContinue: () => seq === searchSeq,
        onChunk: (info) => {
          onProgress({ scanned: info.scanned, total: info.total, hits: info.hits, offsets: info.offsets });
        }
      }).then((res) => {
        if (seq !== searchSeq || res.aborted) return;
        onDone({ truncated: res.truncated, offsets: res.offsets });
      });
    });
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
    if (cursor !== null) inspectorRows = decodeAt(buffer, cursor, little);
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
    const rowLen = Math.min(HEX_ROW_BYTES, buffer.length - rowStart);
    const col = Math.floor((e.clientX - rect.left) / charW);
    setCursor(rowStart + byteIndexAtColumn(col, rowLen));
  });
  dump.addEventListener('keydown', (e) => {
    if (e.isComposing) return; // IME 组合期不动作
    if (cursor === null) return; // 未定位光标：方向键交还容器默认滚动
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = cursor + (e.key === 'ArrowLeft' ? -1 : 1);
    setCursor(Math.min(buffer.length - 1, Math.max(0, next))); // 首尾字节 clamp
    e.preventDefault(); // 光标移动取代容器滚动
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
