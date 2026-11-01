// gitDiff.test.ts — Myers diff 纯函数向量（brief Step 1）：增删改/公共前后缀/多
// hunk/D 封顶回落/输出重建一致性；归一（BOM/CRLF/CR）；unified hunk 上下文与截断
// 尾注；blame 行归属推进（两提交演进/工作区未提交哨兵/截断透传/CRLF 行号对齐）。
import { describe, expect, it } from 'vitest';
import {
  BLAME_MAX_COMMITS,
  DIFF_MAX_BYTES,
  DIFF_MAX_ROWS,
  UNCOMMITTED_SHA,
  blameWalk,
  diffOps,
  normalizeBlobText,
  splitLines,
  unifiedDiff,
  type BlameHistoryEntry,
  type DiffOp
} from './gitDiff';

const enc = new TextEncoder();

/** op 流重建新数组（正确性判据：对 a 施加 del/add 恰得 b，且 eq 对两侧文本相等）。 */
function rebuild(a: readonly string[], b: readonly string[], ops: readonly DiffOp[]): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if (op.type === 'eq') {
      expect(a[op.a]).toBe(b[op.b]);
      out.push(a[op.a]!);
    } else if (op.type === 'del') {
      expect(op.b).toBe(-1);
    } else {
      expect(op.a).toBe(-1);
      out.push(b[op.b]!);
    }
  }
  return out;
}

describe('diffOps（Myers）', () => {
  it('相等输入：全 eq', () => {
    const lines = ['a', 'b', 'c'];
    const ops = diffOps(lines, lines);
    expect(ops.every((o) => o.type === 'eq')).toBe(true);
    expect(rebuild(lines, lines, ops)).toEqual(lines);
  });

  it('纯插入/纯删除/纯替换', () => {
    const a = ['a', 'b', 'c'];
    expect(rebuild(a, ['a', 'b', 'c', 'd'], diffOps(a, ['a', 'b', 'c', 'd']))).toEqual(['a', 'b', 'c', 'd']);
    expect(rebuild(a, ['a', 'c'], diffOps(a, ['a', 'c']))).toEqual(['a', 'c']);
    expect(rebuild(a, ['a', 'X', 'c'], diffOps(a, ['a', 'X', 'c']))).toEqual(['a', 'X', 'c']);
  });

  it('空侧边界：空→有 / 有→空', () => {
    expect(diffOps([], ['x', 'y']).map((o) => o.type)).toEqual(['add', 'add']);
    expect(diffOps(['x', 'y'], []).map((o) => o.type)).toEqual(['del', 'del']);
    expect(rebuild([], ['x', 'y'], diffOps([], ['x', 'y']))).toEqual(['x', 'y']);
  });

  it('多 hunk：分散变更的 op 流覆盖并保持对齐', () => {
    const a = ['h1', 'a', 'b', 'c', 'd', 'e', 'f', 'h2'];
    const b = ['h1', 'a', 'B', 'c', 'd', 'E', 'f', 'h2'];
    const ops = diffOps(a, b);
    expect(rebuild(a, b, ops)).toEqual(b);
    // 公共首尾行必须 eq 对齐（快剪路径）
    expect(ops[0]).toEqual({ type: 'eq', a: 0, b: 0 });
    expect(ops[ops.length - 1]).toEqual({ type: 'eq', a: 7, b: 7 });
  });

  it('D 封顶回落整段 replace：结果仍正确（可重建）', () => {
    const a = Array.from({ length: 40 }, (_, i) => `old-${i}`);
    const b = Array.from({ length: 35 }, (_, i) => `new-${i}`);
    const ops = diffOps(a, b, 3); // maxD=3：必然超预算
    expect(rebuild(a, b, ops)).toEqual(b);
    // 回落形态 = 全 del + 全 add
    expect(ops.filter((o) => o.type === 'del')).toHaveLength(40);
    expect(ops.filter((o) => o.type === 'add')).toHaveLength(35);
  });

  it('同行重复内容的歧义文本：重建恒正确', () => {
    const a = ['x', 'x', 'x', 'x'];
    const b = ['x', 'x'];
    expect(rebuild(a, b, diffOps(a, b))).toEqual(b);
  });
});

describe('normalizeBlobText / splitLines（渲染归一对齐）', () => {
  it('CRLF→LF、lone CR→LF', () => {
    expect(normalizeBlobText(enc.encode('a\r\nb\rc\n'))).toBe('a\nb\nc\n');
  });

  it('UTF-8 BOM 剥除（BOM+CRLF 组合）', () => {
    const bomCrlf = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('l1\r\nl2\r\n')]);
    expect(normalizeBlobText(bomCrlf)).toBe('l1\nl2\n');
  });

  it('splitLines 与渲染 buildLineIndex 同口径：尾 \\n 不产伪行', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('a\n\nb\n')).toEqual(['a', '', 'b']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('\n')).toEqual(['']);
  });
});

describe('unifiedDiff', () => {
  it('无差异：零行零计数', () => {
    const r = unifiedDiff(['a', 'b'], ['a', 'b']);
    expect(r.rows).toEqual([]);
    expect(r.addCount).toBe(0);
    expect(r.delCount).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it('单行替换：1 add + 1 del，上下文 3 行（含行号域）', () => {
    const a = ['l1', 'l2', 'l3', 'l4', 'l5'];
    const b = ['l1', 'l2', 'X', 'l4', 'l5'];
    const r = unifiedDiff(a, b);
    expect(r.addCount).toBe(1);
    expect(r.delCount).toBe(1);
    expect(r.rows.map((row) => row.type)).toEqual(['ctx', 'ctx', 'del', 'add', 'ctx', 'ctx']);
    const del = r.rows.find((row) => row.type === 'del');
    const add = r.rows.find((row) => row.type === 'add');
    expect(del).toMatchObject({ oldLine: 2, newLine: -1, text: 'l3' });
    expect(add).toMatchObject({ oldLine: -1, newLine: 2, text: 'X' });
  });

  it('远距变更分 hunk（间隔 > 2×context），近距合并', () => {
    const a = ['c', 'a1', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'b1', 'c'];
    const b = ['c', 'A1', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'B1', 'c'];
    const r = unifiedDiff(a, b, { context: 1 });
    // a1→A1 与 b1→B1 间隔 7 行 eq > 2：两个独立 hunk
    const delRows = r.rows.filter((row) => row.type === 'del');
    expect(delRows).toHaveLength(2);
    expect(r.addCount).toBe(2);
    // 近距（间隔 ≤ 2）合并且中间 eq 保留
    const r2 = unifiedDiff(['k', 'x', 'm', 'n', 'y', 'k'], ['k', 'X', 'm', 'n', 'Y', 'k'], { context: 1 });
    expect(r2.rows.map((row) => row.type)).toEqual(['ctx', 'del', 'add', 'ctx', 'ctx', 'del', 'add', 'ctx']);
  });

  it('行预算截断：truncated + 尾注（常量进实现）', () => {
    const a = Array.from({ length: 100 }, (_, i) => `old${i}`);
    const b = Array.from({ length: 100 }, (_, i) => `new${i}`); // 全替换 = 200 变更行
    const r = unifiedDiff(a, b, { context: 0, maxRows: 50 });
    expect(r.rows.length).toBe(50);
    expect(r.truncated).toBe(true);
    expect(r.note).toContain('50');
    // 统计不受截断影响
    expect(r.addCount).toBe(100);
    expect(r.delCount).toBe(100);
  });

  it('字节预算截断（默认 DIFF_MAX_BYTES/DIFF_MAX_ROWS 常量）', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `l${i}-${'x'.repeat(100)}`);
    const r = unifiedDiff(a, Array.from({ length: 3000 }, (_, i) => `L${i}-${'y'.repeat(100)}`), {
      context: 0,
      maxRows: DIFF_MAX_ROWS,
      maxBytes: DIFF_MAX_BYTES
    });
    expect(r.truncated).toBe(true);
    expect(r.rows.length).toBeLessThanOrEqual(DIFF_MAX_ROWS);
    expect(r.note).toContain('200KB');
  });
});

// ---------- blameWalk ----------

function entry(oid: string, lines: string[], author = 'a', timestamp = 1700000000, message = `${oid} msg`): BlameHistoryEntry {
  return { oid, author, timestamp, message, lines };
}

describe('blameWalk（行归属推进）', () => {
  it('两提交演进：eq 继承 / add 归新提交', () => {
    const c1 = entry('c1', ['a', 'b', 'c']);
    const c2 = entry('c2', ['a', 'X', 'c', 'd']);
    const r = blameWalk([c1, c2], null, false);
    expect(r.truncated).toBe(false);
    // 游程分组：b→X 替换 + 尾插 d → 全部孤立组
    expect(r.lines).toEqual([
      { sha: 'c1', line: 0, numLines: 1, author: 'a', timestamp: 1700000000, message: 'c1 msg' },
      { sha: 'c2', line: 1, numLines: 1, author: 'a', timestamp: 1700000000, message: 'c2 msg' },
      { sha: 'c1', line: 2, numLines: 1, author: 'a', timestamp: 1700000000, message: 'c1 msg' },
      { sha: 'c2', line: 3, numLines: 1, author: 'a', timestamp: 1700000000, message: 'c2 msg' }
    ]);
  });

  it('连续同行归属合并为游程（numLines）', () => {
    const c1 = entry('c1', ['k1', 'k2', 'k3']);
    const c2 = entry('c2', ['k1', 'k2', 'k3', 'tail']);
    const r = blameWalk([c1, c2], null, false);
    expect(r.lines).toEqual([
      { sha: 'c1', line: 0, numLines: 3, author: 'a', timestamp: 1700000000, message: 'c1 msg' },
      { sha: 'c2', line: 3, numLines: 1, author: 'a', timestamp: 1700000000, message: 'c2 msg' }
    ]);
  });

  it('工作区新增行落「未提交」哨兵；未变行保持 HEAD 归属', () => {
    const c1 = entry('head', ['a', 'b']);
    const r = blameWalk([c1], ['a', 'b', 'new'], false);
    expect(r.lines).toEqual([
      { sha: 'head', line: 0, numLines: 2, author: 'a', timestamp: 1700000000, message: 'head msg' },
      { sha: UNCOMMITTED_SHA, line: 2, numLines: 1, author: '（未提交）', timestamp: r.lines[1]!.timestamp, message: '' }
    ]);
  });

  it('CRLF blob 归一后行号对齐：行号域 = 渲染归一域', () => {
    // blob 字节 CRLF：归一后 3 行（非 3 行 + \r 残留）——worker 侧 normalize+split 后入 walk
    const blob = normalizeBlobText(enc.encode('alpha line 1\r\nalpha line 2\r\nalpha line 3 committed\r\n'));
    const c1 = entry('crlf', splitLines(blob));
    const r = blameWalk([c1], splitLines(blob), false);
    expect(r.lines).toEqual([
      { sha: 'crlf', line: 0, numLines: 3, author: 'a', timestamp: 1700000000, message: 'crlf msg' }
    ]);
    // 尾行号 = 行数-1（与 data-line 域一致）
    expect(r.lines[0]!.line + r.lines[0]!.numLines - 1).toBe(2);
  });

  it('截断透传 + 窗外最老提交兜底归属（历史超上限语义）', () => {
    // 模拟 log depth 截断：最老提交 c0 被切出窗外，窗内最老 c1 拥有全部基线行
    const c1 = entry('c1', ['base1', 'base2', 'base3']);
    const c2 = entry('c2', ['base1', 'base2', 'base3', 'c2 line']);
    const r = blameWalk([c1, c2], null, true);
    expect(r.truncated).toBe(true);
    expect(r.lines[0]!.sha).toBe('c1'); // 窗外历史的行落到窗内最老提交
    expect(r.lines.map((g) => g.sha)).not.toContain('c0');
  });

  it('历史超上限常量语义：BLAME_MAX_COMMITS 参与', () => {
    expect(BLAME_MAX_COMMITS).toBe(200);
  });
});
