// gitDiff.ts — Myers diff 与行归属推进的纯函数单源（git 信息面板 spec §3.2/§3.3，
// Task 3）：主线程（GitSection diff 视图 / log 展开的逐提交 diff）与 worker（blame
// 行归属推进）同模块复用——自研不引 npm diff（brief 裁决）。无 DOM/worker 依赖，
// vitest 直测前提（markdownImages.ts 先例）。
//
// 归一口径（简报裁决，Review Focus）：blob 字节与工作区字节一律先经 normalizeBlobText
//（BOM 剥 + CRLF/CR→LF）再切行 diff——与渲染器解码链逐条对齐（TextDecoder 自动剥
// BOM，decodeText.ts 头注释；`\r\n?`→`\n` 正则同 renderCode.ts:77），行号域与渲染
// data-line（归一域）一致，blame hover 才能按行查询。与状态判定不同轨：status op 是
// 原始字节 hash 比对（CRLF 原样入 hash 不误报，spec 红线），本模块只服务显示层归一
// ——两条通道职责不同，不互相替代。
//
// 截断口径（spec §3.3「>2000 行/>200KB 截断 + 尾注」）：unifiedDiff 的输出行数与
// 字节预算（常量进实现，UI 可见）；blame 截断按提交数（BLAME_MAX_COMMITS），由
// worker 侧 log depth 探测、blameWalk 透传。

// ---------- 常量（spec §3.2/§3.3 冻结值，UI 尾注/说明行直引） ----------

/** diff 输出行数上限（超出截断 + 尾注） */
export const DIFF_MAX_ROWS = 2000;
/** diff 输出字节上限（UTF-16 码元近似计，见 unifiedDiff 内注释） */
export const DIFF_MAX_BYTES = 200 * 1024;
/** blame 参与历史提交上限（isogit log depth；超出仅最近 N 个提交参与归属） */
export const BLAME_MAX_COMMITS = 200;
/** 文件历史列表条数上限（spec §3.4） */
export const LOG_MAX_ENTRIES = 50;

// ---------- 归一与切行（渲染行域对齐） ----------

/**
 * blob/工作区字节 → 渲染归一文本：UTF-8 BOM 剥除 + CRLF/CR→LF。与 renderCode 的
 * `decodeText(buffer).replace(/\r\n?/g, '\n')` 在 UTF-8 域逐条对齐（非 UTF-8 文件
 * 经检测解码的行数差异属已知边界——blame hover 行域以 UTF-8 归一为锚，见 Task 3
 * 报告备案；仓库内文本默认 UTF-8）。
 */
export function normalizeBlobText(bytes: Uint8Array): string {
  let b = bytes;
  // UTF-8 BOM（EF BB BF）：TextDecoder 不剥 subarray 形态之外的场景——恒在文件头，
  // 显式剥（jsonl/index.ts 同裁决）
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  return new TextDecoder('utf-8', { fatal: false }).decode(b).replace(/\r\n?/g, '\n');
}

/** 归一文本 → 行数组（renderCode buildLineIndex 同口径：尾 \n 不产伪行；'' → []）。 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

// ---------- Myers diff（贪心 O(ND)，D 封顶回落整段 replace） ----------

/** 单个编辑操作：eq 双侧对齐，del 只带旧侧行号，add 只带新侧行号（缺侧 -1）。 */
export interface DiffOp {
  readonly type: 'eq' | 'del' | 'add';
  readonly a: number;
  readonly b: number;
}

/** 单轮最大编辑距离预算：超出即放弃最优解回落「整段删除+整段插入」（正确性不变，
 *  粒度变粗）——防完全不同的超大文件把 O(ND) 退化到不可用。相邻版本 diff 的实际
 *  D 远低于此（blame 逐提交推进/diff 视图皆为同文件相邻态）。 */
export const MYERS_MAX_D = 1000;

/**
 * 行级 diff：公共前后缀快剪 + 中段 Myers 最短编辑脚本。返回按序覆盖两数组的 op 流
 * （eq/del/add），消费方（unifiedDiff/blameWalk）按需取对齐对或变更行。
 */
export function diffOps(a: readonly string[], b: readonly string[], maxD: number = MYERS_MAX_D): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const ops: DiffOp[] = [];
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
  for (let i = 0; i < pre; i++) ops.push({ type: 'eq', a: i, b: i });
  appendMiddle(ops, a, b, pre, n - suf, m - suf, maxD);
  for (let i = 0; i < suf; i++) ops.push({ type: 'eq', a: n - suf + i, b: m - suf + i });
  return ops;
}

/** 中段 [lo,hiA)×[lo,hiB)（公共前缀已剥故两段同起点）：Myers 脚本或整段 replace。 */
function appendMiddle(
  ops: DiffOp[],
  a: readonly string[],
  b: readonly string[],
  lo: number,
  hiA: number,
  hiB: number,
  maxD: number
): void {
  const n = hiA - lo;
  const m = hiB - lo;
  if (n === 0 && m === 0) return;
  if (n === 0) {
    for (let j = 0; j < m; j++) ops.push({ type: 'add', a: -1, b: lo + j });
    return;
  }
  if (m === 0) {
    for (let i = 0; i < n; i++) ops.push({ type: 'del', a: lo + i, b: -1 });
    return;
  }
  const script = myersCapped(a, b, lo, n, m, maxD);
  if (script !== null) {
    for (const op of script) ops.push(op);
    return;
  }
  for (let i = 0; i < n; i++) ops.push({ type: 'del', a: lo + i, b: -1 });
  for (let j = 0; j < m; j++) ops.push({ type: 'add', a: -1, b: lo + j });
}

/**
 * 贪心 Myers（Coglan「The Myers diff algorithm」逐行移植，V 快照栈回溯）：在 D ≤ maxD
 * 内求最短编辑脚本；超出预算返回 null（调用方回落）。Int32Array 复用 + 逐轮快照，
 * 边界哨兵依赖 v[1]=0 的零初始化种子（d=0 的 k=0 起步读它）。
 */
function myersCapped(
  a: readonly string[],
  b: readonly string[],
  lo: number,
  n: number,
  m: number,
  maxD: number
): DiffOp[] | null {
  const max = maxD;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[max + k - 1]! < v[max + k + 1]!)) x = v[max + k + 1]!;
      else x = v[max + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[lo + x] === b[lo + y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  return backtrack(trace, lo, n, m, max, found);
}

/** V 快照栈逆向回溯：逐轮还原 eq 蛇段与 del/add 步，产出正序 op 流。 */
function backtrack(
  trace: Int32Array[],
  lo: number,
  n: number,
  m: number,
  max: number,
  dFinal: number
): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = dFinal; d >= 1; d--) {
    const v = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && v[max + k - 1]! < v[max + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[max + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ type: 'eq', a: lo + x, b: lo + y });
    }
    if (x === prevX) {
      y--;
      ops.push({ type: 'add', a: -1, b: lo + y });
    } else {
      x--;
      ops.push({ type: 'del', a: lo + x, b: -1 });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ type: 'eq', a: lo + x, b: lo + y });
  }
  ops.reverse();
  return ops;
}

// ---------- unified diff（git 风格 hunk + 上下文 + 截断预算） ----------

/** diff 展示行：ctx/add 行号取新侧，del 取旧侧（归一域 0 起；另一侧 -1）。 */
export interface DiffRow {
  readonly type: 'ctx' | 'add' | 'del';
  readonly oldLine: number;
  readonly newLine: number;
  readonly text: string;
}

export interface DiffResult {
  readonly rows: DiffRow[];
  /** 全量统计（含截断未显示部分——git diff --stat 同口径） */
  readonly addCount: number;
  readonly delCount: number;
  readonly truncated: boolean;
  /** 截断尾注（truncated 时 UI 直显；未截断为 ''） */
  readonly note: string;
}

/**
 * unified diff：变更游程按「eq 间隔 > 2×context 即分 hunk」合并，hunk 两侧扩
 * context 行；行/字节预算超限即停（截断处收口，不产半行）。统计为全量（不受截断
 * 影响），尾注由常量拼装（spec：常量进实现，UI 可见）。
 */
export function unifiedDiff(
  aLines: readonly string[],
  bLines: readonly string[],
  opts?: { context?: number; maxRows?: number; maxBytes?: number }
): DiffResult {
  const context = Math.max(0, opts?.context ?? 3);
  const maxRows = opts?.maxRows ?? DIFF_MAX_ROWS;
  const maxBytes = opts?.maxBytes ?? DIFF_MAX_BYTES;
  const ops = diffOps(aLines, bLines);
  let addCount = 0;
  let delCount = 0;
  for (const op of ops) {
    if (op.type === 'add') addCount++;
    else if (op.type === 'del') delCount++;
  }
  // hunk 区间（op 下标闭开）：变更点游程 + 间隔 ≤ 2×context 合并，两侧扩 context
  const hunks: Array<[number, number]> = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.type === 'eq') {
      i++;
      continue;
    }
    let lastChange = i;
    let j = i;
    while (j < ops.length) {
      if (ops[j]!.type !== 'eq') {
        lastChange = j;
        j++;
        continue;
      }
      let run = 0;
      let k2 = j;
      while (k2 < ops.length && ops[k2]!.type === 'eq') {
        run++;
        k2++;
      }
      if (run > 2 * context) break;
      j = k2;
    }
    const start = Math.max(0, i - context);
    const end = Math.min(ops.length, lastChange + 1 + context);
    hunks.push([start, end]);
    i = end;
  }
  const rows: DiffRow[] = [];
  let truncated = false;
  let bytes = 0;
  outer: for (const [s, e] of hunks) {
    for (let k = s; k < e; k++) {
      const op = ops[k]!;
      const row: DiffRow =
        op.type === 'eq'
          ? { type: 'ctx', oldLine: op.a, newLine: op.b, text: aLines[op.a] ?? '' }
          : op.type === 'del'
            ? { type: 'del', oldLine: op.a, newLine: -1, text: aLines[op.a] ?? '' }
            : { type: 'add', oldLine: -1, newLine: op.b, text: bLines[op.b] ?? '' };
      // 字节预算按 UTF-16 码元近似（ASCII 差异为零；CJK 文本最多 ~3 倍低估——截断
      // 略晚但仍有界，备案）；+2 = 前缀符与换行
      const cost = row.text.length + 2;
      if (rows.length >= maxRows || bytes + cost > maxBytes) {
        truncated = true;
        break outer;
      }
      rows.push(row);
      bytes += cost;
    }
  }
  const note = truncated
    ? `diff 过大已截断（上限 ${maxRows} 行 / ${Math.round(maxBytes / 1024)}KB），仅显示前段`
    : '';
  return { rows, addCount, delCount, truncated, note };
}

// ---------- blame 行归属推进（spec §3.2，worker 消费） ----------

/** blame 历史条目（worker 侧由 isogit log 条目 + 逐提交 readBlob 归一切行组装）。 */
export interface BlameHistoryEntry {
  readonly oid: string;
  readonly author: string;
  /** epoch 秒（git author timestamp 原始口径） */
  readonly timestamp: number;
  readonly message: string;
  /** 归一后行数组（normalizeBlobText + splitLines 产物，渲染行域一致） */
  readonly lines: readonly string[];
}

/** blame 归属行组（连续同行提交合并；与 gitClient.GitBlameLine 结构同形）。 */
export interface BlameGroup {
  sha: string;
  line: number;
  numLines: number;
  author: string;
  timestamp: number;
  message: string;
}

/** 工作区新增行的归属哨兵（sha=''，UI 特判渲染「未提交」态）。 */
export const UNCOMMITTED_SHA = '';

export interface BlameWalkResult {
  readonly lines: BlameGroup[];
  readonly truncated: boolean;
}

/**
 * 行归属推进（简报裁决「旧→新推进行归属」）：history 旧→新，初始归属全给最老提交
 * （历史截断时超出部分的行自然落到走查窗内最老提交——git blame 同语义），逐对相邻
 * blob diff：eq 行继承旧归属，add 行归当前提交，del 行连同归属丢弃。worktreeLines
 * 非 null（工作区字节在场）时再向工作区推进一轮：eq 继承 HEAD 归属，add 行落
 * 「未提交」哨兵（UNCOMMITTED_SHA）。输出为最终域（worktree 或最新 blob）归一行号
 * 上的游程分组。truncated 仅透传（log depth 探测在 worker）。
 */
export function blameWalk(
  history: readonly BlameHistoryEntry[],
  worktreeLines: readonly string[] | null,
  truncated: boolean
): BlameWalkResult {
  if (history.length === 0) return { lines: [], truncated };
  const first = history[0]!;
  let attr: number[] = new Array<number>(first.lines.length).fill(0);
  for (let i = 1; i < history.length; i++) {
    const ops = diffOps(history[i - 1]!.lines, history[i]!.lines);
    const next: number[] = new Array<number>(history[i]!.lines.length).fill(i);
    for (const op of ops) {
      if (op.type === 'eq') next[op.b] = attr[op.a]!;
    }
    attr = next;
  }
  let domain: readonly string[] = history[history.length - 1]!.lines;
  if (worktreeLines !== null) {
    const ops = diffOps(domain, worktreeLines);
    const next: number[] = new Array<number>(worktreeLines.length).fill(-1);
    for (const op of ops) {
      if (op.type === 'eq') next[op.b] = attr[op.a]!;
    }
    attr = next;
    domain = worktreeLines;
  }
  void domain; // 行号即数组下标，行文本不外送（保留形状注释：域=归一渲染行）
  const groups: BlameGroup[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  let i = 0;
  while (i < attr.length) {
    const v = attr[i]!;
    let j = i + 1;
    while (j < attr.length && attr[j] === v) j++;
    if (v === -1) {
      groups.push({
        sha: UNCOMMITTED_SHA,
        line: i,
        numLines: j - i,
        author: '（未提交）',
        timestamp: nowSec,
        message: ''
      });
    } else {
      const c = history[v]!;
      groups.push({ sha: c.oid, line: i, numLines: j - i, author: c.author, timestamp: c.timestamp, message: c.message });
    }
    i = j;
  }
  return { lines: groups, truncated };
}
