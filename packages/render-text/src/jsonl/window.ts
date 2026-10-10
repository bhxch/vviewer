/**
 * JSONL 渲染器的可变高度窗口数学（纯数学，无 DOM / 无 IO）。
 *
 * 为什么不复用 core 的 virtualScroller：卡片高度不一（折叠 40 行、展开至
 * 400 行、oversize 预览各异），固定行高 API 的 index = floor(y / rowH) 模型
 * 不适用，必须走「实测高度缓存 + 未测估算外推」的前缀和模型（spec D §2.3）。
 */

/** 未测卡片的估算高度（px）：折叠态（40 行可见）的典型值，仅用于外推与初值 */
export const JSONL_ESTIMATED_CARD_HEIGHT = 120;

/**
 * 可变高度模型：维护「行号 → 实测高」缓存，对外提供前缀和查询。
 *
 * 估算修正策略：
 * - 未测行一律按 estimate 外推（total 与 offsetOf/rowAt 中未测段同理）；
 * - measure 首测即替换估算；已测行偏差 ≤1px 视为亚像素抖动，忽略不计——
 *   否则取整/缩放导致的 0.x px 波动会反复失效前缀和缓存，滚动期持续 O(n) 重建。
 *
 * 脏标记双轨：
 * - 公开 `dirty`：供 DOM 适配层（index.ts）消费——批量 measure 后适配层据它
 *   重设容器总高并修正 translateY，消费完成后由适配层置回 false。模型自身
 *   不在查询时清它（查询不该有副作用）；
 * - 内部重建标记：measure 置脏，dirty 后首次查询 O(n) 重建前缀和数组，
 *   之后稳态查询 O(log n)（二分）。两轨分离保证即使适配层忘记清 `dirty`，
 *   查询复杂度也不退化。
 *
 * 已知限制（接受）：大幅跳跃滚动会有一次高度跳动——跳到未测区域时目标行
 * 位置按估算高计算，渲染实测后总高与行位被修正，视口内容可能偏移一次；
 * 这是「不预渲染就无法得知高度」的固有代价，正向连续滚动因逐屏实测几乎
 * 不受影响。
 */
export class HeightModel {
  /** 行号 → 实测高度（px）。只增删少量键，Map 查询 O(1) 足够，无需数组稀疏浪费 */
  private readonly measured = new Map<number, number>();
  /** 前缀和：prefix[i] = 行 [0, i) 高度之和；prefix[0] = 0。懒重建见类注释 */
  private prefix: number[] = [0];
  /** 当前 prefix 覆盖的行数（单调不缩：缩容场景旧数据无害，只按索引取用） */
  private prefixRows = 0;
  /** 查询侧重建标记：measure 置 true，重建后清 false */
  private prefixDirty = true;
  /** 公开脏标记：measure 置 true，由 DOM 适配层消费后置 false（模型不自动清） */
  dirty = false;

  constructor(private readonly estimate: number = JSONL_ESTIMATED_CARD_HEIGHT) {}

  /**
   * 记录一行实测高度：首测即写入；已测行偏差 >1px 才更新（见类注释，
   * 防亚像素抖动反复失效缓存）。任一写入都置双脏标记。
   */
  measure(row: number, height: number): void {
    const prev = this.measured.get(row);
    if (prev !== undefined && Math.abs(prev - height) <= 1) return;
    this.measured.set(row, height);
    this.dirty = true;
    this.prefixDirty = true;
  }

  /**
   * 按需重建前缀和：dirty 后首次查询走这里 O(n)；缓存覆盖行数单调不减，
   * 请求行数不超过已建缓存且未脏时直接复用（稳态 O(1)）。
   */
  private ensurePrefix(rows: number): number[] {
    const n = Math.max(rows, this.prefixRows);
    if (!this.prefixDirty && n === this.prefixRows) return this.prefix;
    const prefix = new Array<number>(n + 1);
    prefix[0] = 0;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += this.measured.get(i) ?? this.estimate;
      prefix[i + 1] = acc;
    }
    this.prefix = prefix;
    this.prefixRows = n;
    this.prefixDirty = false;
    return prefix;
  }

  /** 内容总高：实测行取实测值，未测行按估算外推 */
  total(rows: number): number {
    return this.ensurePrefix(rows)[rows] ?? 0;
  }

  /** 行 offset 的前缀和（行 [0, row) 高度之和）；row ≤ 0 恒为 0 */
  offsetOf(row: number): number {
    if (row <= 0) return 0;
    return this.ensurePrefix(row)[row] ?? 0;
  }

  /**
   * 像素 y → 行号：行 r 占据 [offsetOf(r), offsetOf(r)+height(r))，
   * 即取满足 prefix[r] ≤ y 的最大 r。prefix 非降序，二分 O(log n)；
   * y 越过内容末尾（含 scrollTo 超界）夹到 rows-1，y ≤ 0 归 0。
   */
  rowAt(y: number, rows: number): number {
    if (rows <= 0 || y <= 0) return 0;
    const prefix = this.ensurePrefix(rows);
    if ((prefix[rows] ?? Infinity) <= y) return rows - 1;
    let lo = 0;
    let hi = rows - 1;
    // 收缩至 lo===hi：区间内 prefix[lo] ≤ y < prefix[lo+1] 恒成立
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((prefix[mid] ?? Infinity) <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

export interface VisibleRange {
  first: number;
  last: number;
}

/**
 * 可见行窗口（语义契约，last 为含端 index）：
 * - first = max(0, rowAt(scrollTop) - overscan)
 * - last  = min(rows - 1, rowAt(scrollTop + viewportH) + overscan)
 * overscan 向上下各多渲一屏内若干行，吸收滚动与测量修正期间的边缘空白；
 * scrollTop 超出总高时 rowAt 夹到末行，两式自然夹紧到合法区间。
 */
export function visibleRange(
  model: HeightModel,
  scrollTop: number,
  viewportH: number,
  rows: number,
  overscan = 5,
): VisibleRange {
  const first = Math.max(0, model.rowAt(scrollTop, rows) - overscan);
  const last = Math.min(rows - 1, model.rowAt(scrollTop + viewportH, rows) + overscan);
  return { first, last };
}
