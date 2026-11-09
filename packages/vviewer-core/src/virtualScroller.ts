// virtualScroller —— 固定行高虚拟滚动（零 DOM 依赖纯模块，自 render-text 上移：
// BUG-16 的 hex 行虚拟滚动与 render-text code 渲染器共用同一实现；render-text 原
// 路径保留一行 re-export shim，code.ts 的相对 import 与包 exports 均不变）。
export interface VirtualScrollerHandle {
  destroy(): void;
  /** force=true 时即使可视行范围未变也强制重绘（异步高亮结果到达后刷新用） */
  refresh(force?: boolean): void;
  /**
   * 按虚拟内容坐标（行号×lineHeight 语义，与 onRange 同域）定位滚动。
   * 调用方一律经此跳转，不得直写 container.scrollTop——总高超
   * SCROLL_PX_CAP 后滚动域被压缩，scrollTop 与虚拟坐标不再恒等（BUG-55）。
   */
  scrollTo(y: number): void;
  /** 行 i 的内容起始 y（行号×lineHeight；i 钳入 [0,n]） */
  offsetOf(row: number): number;
  /** 行 i 的行高（恒构造参 lineHeight） */
  heightOf(row: number): number;
  /** 内容 y 所在行（行号×lineHeight 前缀；y 越界钳 [0,n-1]） */
  rowAt(y: number): number;
  /** 视口顶所在行（scrollTop → 行号，钳 [0,n-1]；与 update 的取行算式同源） */
  firstVisibleRow(): number;
}

/**
 * 可变行高虚拟滚动的行高模型（分块前缀和；与 virtualScroller 的固定行高算式
 * 同一查询面 offsetOf/heightOf/rowAt/total，供 code 渲染器在换行/不换行两种
 * 模式下共用同一滚动器装配代码）：
 * - 未测行按估算函数外推（估算可随行号变化——如按行字节长粗估折行数）；
 * - measure 写入实测高（px），返回相对前值（未测即估算）的差值——调用方据非零
 *   差值做滚动补偿与 spacer 重设；同值幂等、越界/非正值忽略；
 * - setRowCount 增长保留既有测高（新行按估算），缩容丢弃越界测高；
 * - invalidate 清全部测高（估算闭包变化——如容器变宽改了每行列数——后按新估算重估）。
 * 结构：块（BLOCK_ROWS 行）和 + 块前缀（惰性增量重建，测高只使其后块前缀失效）；
 * offsetOf = 块前缀 + 块内 ≤BLOCK_ROWS 项累加，rowAt = 块前缀二分 + 块内线性，
 * 百万行级稳态查询 O(log n + BLOCK_ROWS)；实测高按块稀疏存储，只读查询零分配。
 */
export class RowHeights {
  /** 块号 → 块内实测高（0 = 未测） */
  #measured = new Map<number, Float64Array>();
  /** 块号 → 块内行高和（实测/估算混合）；NaN = 待重算 */
  #blockSums = new Float64Array(0);
  /** blockPrefix[b] = 块 [0,b) 行高和；[0..prefixValid] 有效 */
  #blockPrefix = new Float64Array(1);
  #prefixValid = 0;
  rowCount = 0;

  constructor(
    /** 行号 → 估算行高（px）。须对任意 i∈[0,rowCount) 返回正值 */
    private readonly estimate: (row: number) => number
  ) {}

  setRowCount(n: number): void {
    const old = this.rowCount;
    if (n === old) return;
    if (n < old) {
      // 缩容：越界实测作废（边界块内截断、其后整块删除）
      for (const [b, arr] of this.#measured) {
        if (b * BLOCK_ROWS >= n) this.#measured.delete(b);
        else if ((b + 1) * BLOCK_ROWS > n) arr.fill(0, n - b * BLOCK_ROWS);
      }
    }
    this.rowCount = n;
    const blocks = Math.ceil(n / BLOCK_ROWS);
    if (this.#blockSums.length < blocks) {
      const sums = new Float64Array(Math.max(blocks, this.#blockSums.length * 2));
      sums.set(this.#blockSums);
      this.#blockSums = sums;
      const prefix = new Float64Array(sums.length + 1);
      prefix.set(this.#blockPrefix);
      this.#blockPrefix = prefix;
    }
    // 新旧行数边界所在块起（行数变了的边界块 + 新增块）块和待重算，前缀自该块失效
    const from = Math.floor(Math.min(old, n) / BLOCK_ROWS);
    this.#blockSums.fill(Number.NaN, from);
    this.#prefixValid = Math.min(this.#prefixValid, from);
  }

  #measuredOf(row: number): number {
    return this.#measured.get(Math.floor(row / BLOCK_ROWS))?.[row % BLOCK_ROWS] ?? 0;
  }

  heightOf(row: number): number {
    const m = row >= 0 && row < this.rowCount ? this.#measuredOf(row) : 0;
    return m > 0 ? m : this.estimate(row);
  }

  #blockSum(b: number): number {
    let s = this.#blockSums[b]!;
    if (Number.isNaN(s)) {
      s = 0;
      const end = Math.min(this.rowCount, (b + 1) * BLOCK_ROWS);
      for (let r = b * BLOCK_ROWS; r < end; r++) s += this.heightOf(r);
      this.#blockSums[b] = s;
    }
    return s;
  }

  /** 块 [0,b) 行高和（自最后有效前缀增量补算） */
  #prefixOf(b: number): number {
    while (this.#prefixValid < b) {
      this.#blockPrefix[this.#prefixValid + 1] = this.#blockPrefix[this.#prefixValid]! + this.#blockSum(this.#prefixValid);
      this.#prefixValid++;
    }
    return this.#blockPrefix[b]!;
  }

  /** 行 i 内容起始 y（未测段按估算；i 越界钳 [0,n]） */
  offsetOf(row: number): number {
    const i = Math.min(Math.max(0, Math.round(row)), this.rowCount);
    const b = Math.floor(i / BLOCK_ROWS);
    let y = this.#prefixOf(b);
    for (let r = b * BLOCK_ROWS; r < i; r++) y += this.heightOf(r);
    return y;
  }

  total(): number {
    return this.#prefixOf(Math.ceil(this.rowCount / BLOCK_ROWS));
  }

  /** 记录实测高，返回相对前值（未测即估算）的差值（0 = 无变化/忽略） */
  measure(row: number, height: number): number {
    if (!(row >= 0) || row >= this.rowCount || !(height > 0)) return 0;
    const b = Math.floor(row / BLOCK_ROWS);
    const prev = this.#measuredOf(row);
    if (prev === height) return 0;
    const before = prev > 0 ? prev : this.estimate(row);
    let arr = this.#measured.get(b);
    if (!arr) {
      arr = new Float64Array(BLOCK_ROWS);
      this.#measured.set(b, arr);
    }
    arr[row % BLOCK_ROWS] = height;
    const delta = height - before;
    if (delta !== 0) {
      this.#blockSums[b] = Number.NaN;
      this.#prefixValid = Math.min(this.#prefixValid, b); // 块 b 之后的前缀失效
    }
    return delta;
  }

  /** y（内容坐标）所在行：前缀 ≤ y 的最大行，越界钳 [0,n-1] */
  rowAt(y: number): number {
    const n = this.rowCount;
    if (n <= 0 || !(y > 0)) return 0;
    const blocks = Math.ceil(n / BLOCK_ROWS);
    if (y >= this.#prefixOf(blocks)) return n - 1; // 同时把块前缀补全为有效
    let lo = 0;
    let hi = blocks - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.#blockPrefix[mid]! <= y) lo = mid;
      else hi = mid - 1;
    }
    let row = lo * BLOCK_ROWS;
    let acc = this.#blockPrefix[lo]!;
    const end = Math.min(n, row + BLOCK_ROWS) - 1;
    for (; row < end; row++) {
      const h = this.heightOf(row);
      if (acc + h > y) return row;
      acc += h;
    }
    return end;
  }

  /** 清全部实测高（估算闭包变化后按新估算重估） */
  invalidate(): void {
    this.#measured.clear();
    this.#blockSums.fill(Number.NaN);
    this.#prefixValid = 0;
  }
}

/** 可变行高滚动器 handle：行几何同 VirtualScrollerHandle，另暴露测高注入通道 */
export interface VariableScrollerHandle extends VirtualScrollerHandle {
  /** 注入行实测高（渲染后自动测高之外的补充通道；返回值同 RowHeights.measure） */
  measure(row: number, height: number): number;
}

/**
 * 可变行高虚拟滚动（code 换行模式；RowHeights 语义见类注）。与固定行高
 * virtualScroller 同一容器/spacer/viewport 结构与滚动监听面，差异：
 * - 可视行范围按 RowHeights 前缀（rowAt/offsetOf）换算，总高 total()；
 * - 自动测高：每次 onRange 渲染后同步量 data-line 行的 offsetHeight（jsdom/隐藏为 0
 *   跳过）——逐屏滚动自然收敛，估算偏差被渲染实测持续修正；
 * - 锚定补偿：测高致视口顶锚行之上的前缀变化时同步平移 scrollTop（视口内容不跳），
 *   再按新前缀重算范围（至多 4 轮收敛）。
 * onRange 内不得直写 container.scrollTop（会与锚定补偿打架）；跳转一律 scrollTo。
 */
export function variableScroller(
  container: HTMLElement,
  model: RowHeights,
  onRange: (first: number, last: number, viewport: HTMLElement) => void,
  overscan = 10
): VariableScrollerHandle {
  container.classList.add('vv-virtual');
  const spacer = document.createElement('div');
  spacer.className = 'vv-virtual-spacer';
  spacer.style.height = '0px';
  const viewport = document.createElement('div');
  viewport.className = 'vv-virtual-viewport';
  container.replaceChildren(spacer, viewport);
  let first = -1;
  let last = -1;
  let destroyed = false;

  function total(): number {
    return Math.min(model.total(), SCROLL_PX_CAP);
  }

  function syncSpacer(): void {
    spacer.style.height = `${total()}px`;
  }

  /** 视口顶所在行（滚动域压缩时先还原虚拟 y；与固定行高 update 同构） */
  function topRow(): number {
    const virtualY = toVirtual(container.scrollTop);
    return model.rowAt(virtualY);
  }

  function toVirtual(scrollTop: number): number {
    const t = model.total();
    if (t <= SCROLL_PX_CAP) return scrollTop;
    const scrollable = Math.max(1, SCROLL_PX_CAP - container.clientHeight);
    return (scrollTop / scrollable) * Math.max(1, t - container.clientHeight);
  }

  function toScroll(y: number): number {
    const t = model.total();
    if (t <= SCROLL_PX_CAP) return y;
    const virtual = Math.max(1, t - container.clientHeight);
    return (y / virtual) * Math.max(1, SCROLL_PX_CAP - container.clientHeight);
  }

  function update(force = false): void {
    if (destroyed) return;
    // 至多 4 轮收敛：渲染 → 同步测高 → 有变化则锚定补偿并按新前缀重算范围（行变矮时
    // 视口下方需补渲染新行，再测）。测高只量本轮新渲染的行；范围未变即停
    for (let pass = 0; pass < 4; pass++) {
      syncSpacer();
      const virtualY = toVirtual(container.scrollTop);
      const anchor = model.rowAt(virtualY + 1e-6);
      const intoAnchor = virtualY - model.offsetOf(anchor); // 视口顶在锚行内的偏移
      const rowH = Math.max(1, model.heightOf(anchor));
      // 可视行数 = clientHeight/行高（锚行行高近似——折行面行高差异由 overscan 吸收）；
      // f/l 口径与固定行高 virtualScroller 一致（f=锚-overscan、l=f+可视+2×overscan）
      const visible = Math.ceil(container.clientHeight / rowH);
      const f = Math.min(model.rowCount - 1, Math.max(0, anchor - overscan));
      const l = Math.min(model.rowCount - 1, f + visible + overscan * 2);
      const rerender = force || f !== first || l !== last;
      if (rerender) {
        first = f;
        last = l;
        force = false;
        onRange(f, l, viewport);
      }
      viewport.style.transform = `translateY(${model.offsetOf(first)}px)`;
      if (!rerender || !measureViewport()) return;
      // 锚定补偿：测高改变了锚行之上的前缀 → scrollTop 随之平移，锚行与行内偏移
      // 钉在视口顶（内容不跳）；spacer 先行重设，否则超出旧总高的 scrollTop 被钳
      syncSpacer();
      const target = Math.max(0, toScroll(model.offsetOf(anchor) + intoAnchor));
      if (Math.abs(target - container.scrollTop) >= 0.5) container.scrollTop = target;
      viewport.style.transform = `translateY(${model.offsetOf(first)}px)`;
    }
  }

  /** 渲染后同步测高：量视口内 data-line 行的 offsetHeight（无布局为 0 跳过），返回是否有变化 */
  function measureViewport(): boolean {
    let changed = false;
    for (const row of viewport.querySelectorAll<HTMLElement>('[data-line]')) {
      const i = Number(row.dataset.line);
      if (!Number.isInteger(i) || i < 0 || i >= model.rowCount) continue;
      const h = row.offsetHeight;
      if (h > 0 && model.measure(i, h) !== 0) changed = true;
    }
    return changed;
  }

  const onUpdate = (): void => update();
  container.addEventListener('scroll', onUpdate, { passive: true });
  const ro = new ResizeObserver(onUpdate);
  ro.observe(container);
  update();
  return {
    destroy() {
      destroyed = true;
      ro.disconnect();
      container.removeEventListener('scroll', onUpdate);
    },
    refresh: (force = false) => update(force),
    scrollTo: (y: number) => {
      container.scrollTop = Math.max(0, toScroll(y));
    },
    offsetOf: (row) => model.offsetOf(row),
    heightOf: (row) => model.heightOf(row),
    rowAt: (y) => model.rowAt(y),
    firstVisibleRow: () => topRow(),
    measure: (row, height) => model.measure(row, height)
  };
}


/**
 * Chromium 单元素高度/可滚动区域上限（px）：2^25-4，实测同钳（元素与 scroller
 * 滚动域分别验证：>该值的单元素高度与分段多元素的 scrollHeight 均停在 ~2^25）。
 * BUG-55：spacer 单元素定高超限被钳制 → 滚动区间缩短、尾部不可达。
 */
export const SCROLL_PX_CAP = 33_554_428;

/** RowHeights 分块大小：Float64Array 块 + 块级前缀缓存粒度（2 的幂便于取模） */
const BLOCK_ROWS = 64;

export function virtualScroller(
  container: HTMLElement,
  rowCount: number,
  lineHeight: number,
  onRange: (first: number, last: number, viewport: HTMLElement) => void,
  overscan = 10
): VirtualScrollerHandle {
  container.classList.add('vv-virtual');
  const totalHeight = rowCount * lineHeight;
  const capped = totalHeight > SCROLL_PX_CAP;
  const spacer = document.createElement('div');
  spacer.className = 'vv-virtual-spacer';
  spacer.style.height = `${Math.min(totalHeight, SCROLL_PX_CAP)}px`;
  const viewport = document.createElement('div');
  viewport.className = 'vv-virtual-viewport';
  // viewport 常驻：只在 init 时 replaceChildren 一次，之后仅做 transform 定位
  container.replaceChildren(spacer, viewport);
  let first = -1;
  let last = -1;
  /** 滚动域 scrollTop → 虚拟内容 y（未超限恒等） */
  function toVirtual(scrollTop: number): number {
    if (!capped) return scrollTop;
    const scrollable = Math.max(1, SCROLL_PX_CAP - container.clientHeight);
    return (scrollTop / scrollable) * Math.max(1, totalHeight - container.clientHeight);
  }
  /** 虚拟内容 y → 滚动域 scrollTop（toVirtual 的逆映射，未超限恒等） */
  function toScroll(y: number): number {
    if (!capped) return y;
    const virtual = Math.max(1, totalHeight - container.clientHeight);
    return (y / virtual) * Math.max(1, SCROLL_PX_CAP - container.clientHeight);
  }
  function update(force = false): void {
    const scrollTop = container.scrollTop;
    const virtualY = toVirtual(scrollTop);
    const shift = virtualY - scrollTop; // capped 时视口在压缩滚动域内的补偿量（未超限=0）
    const visible = Math.ceil(container.clientHeight / lineHeight);
    const f = Math.min(rowCount - 1, Math.max(0, Math.floor(virtualY / lineHeight) - overscan));
    const l = Math.min(rowCount - 1, f + visible + overscan * 2);
    if (force || f !== first || l !== last) {
      first = f;
      last = l;
      onRange(f, l, viewport);
    }
    // transform 恒刷：capped 模式 shift 随 scrollTop 连续变化，f/l 未变的滚动也须
    // 补偿；未超限时 shift=0，退化为原实现 f*lineHeight。
    viewport.style.transform = `translateY(${f * lineHeight - shift}px)`;
  }
  const onUpdate = (): void => update();
  container.addEventListener('scroll', onUpdate, { passive: true });
  const ro = new ResizeObserver(onUpdate);
  ro.observe(container);
  update();
  return {
    destroy() {
      ro.disconnect();
      container.removeEventListener('scroll', onUpdate);
    },
    refresh: (force = false) => update(force),
    scrollTo: (y: number) => {
      container.scrollTop = toScroll(Math.max(0, y));
    },
    // 行几何（换行模式 variableScroller 同接口——渲染器装配代码两模式共用）：
    // 固定行高即乘除法直算；i 钳入界与 rowAt 越界钳末行语义一致
    offsetOf: (row) => Math.min(Math.max(0, Math.round(row)), rowCount) * lineHeight,
    heightOf: () => lineHeight,
    rowAt: (y) => Math.min(Math.max(0, rowCount - 1), Math.max(0, Math.floor(Math.max(0, y) / lineHeight))),
    firstVisibleRow: () => Math.min(Math.max(0, rowCount - 1), Math.max(0, Math.floor(toVirtual(container.scrollTop) / lineHeight)))
  };
}


