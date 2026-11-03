import { describe, expect, it } from 'vitest';
import type { OutlineEntry } from '@bhxch/vviewer-highlight';
import { OUTLINE_DEPTH_CLAMP, outlineLogicalDepths } from './outlineDepth';

/** 构造条目：depth = 提取端全量 raw 栈深（pairsToOutline 口径，reference.* 入栈后
 * 由 AppShell 过滤掉，故此处只造 definition.* 残集）；byte 范围注 real 前缀的用例
 * 为真实 javascript.wasm + tags.scm 探针实测值（NESTED/SIBLING 两载体）。 */
function entry(name: string, byteStart: number, byteEnd: number, depth: number, kind = 'definition.function'): OutlineEntry {
  return { name, kind, line: 0, byteStart, byteEnd, depth };
}

describe('outlineLogicalDepths（reference 过滤后 depth 栈重算）', () => {
  it('钳制常量 = 8（spec §3；渲染端 12px/层 → 最深 96px，e2e/场景档对齐锚）', () => {
    expect(OUTLINE_DEPTH_CLAMP).toBe(8);
  });

  it('空集 → []', () => {
    expect(outlineLogicalDepths([])).toEqual([]);
  });

  it('无引用祖先的常规嵌套：逻辑深度 = raw depth（OUT-01 python 形态不回归）', () => {
    // class Calculator > add/run，同级 top_level/helper（各自独立顶层）
    const defs = [
      entry('Calculator', 0, 60, 0, 'definition.class'),
      entry('add', 10, 30, 1),
      entry('run', 31, 59, 1),
      entry('top_level', 61, 80, 0),
      entry('helper', 81, 95, 0)
    ];
    expect(outlineLogicalDepths(defs)).toEqual([0, 1, 1, 0, 0]);
  });

  it('real·NESTED（e2e OUT-12 载体1，引用嵌于存活 def 内）：齐层不跳层', () => {
    // outer > register(reference.call 已滤) > alpha/beta；gamma；tail
    // byte 范围为真实 grammar 实测：过滤集 [outer [0,168) raw0, alpha [32,74) raw2,
    // beta [76,117) raw2, gamma [124,166) raw1, tail [169,202) raw0]
    const defs = [
      entry('outer', 0, 168, 0),
      entry('alpha', 32, 74, 2),
      entry('beta', 76, 117, 2),
      entry('gamma', 124, 166, 1),
      entry('tail', 169, 202, 0)
    ];
    // 直读 raw 为 [0,2,2,1,0]（跳层）——重算后 alpha/beta/gamma 同为 outer 子层
    expect(outlineLogicalDepths(defs)).toEqual([0, 1, 1, 1, 0]);
  });

  it('real·SIBLING（复审反例，顶层引用兄弟）：namedTest 不误挂为已闭合 setup 的子项', () => {
    // setup [0,19) 与 describe(ref)>it(ref)>namedTest 为顶层兄弟；byte 范围真实实测：
    // 过滤集 [setup [0,19) raw0, namedTest [68,114) raw2]——namedTest 不在 setup 内，真值 0
    const defs = [entry('setup', 0, 19, 0), entry('namedTest', 68, 114, 2)];
    // raw depth 栈法在此形态得 [0,1]（把 namedTest 误挂为 setup 子项）——
    // 只有 byte 区间栈能区分「更深存活祖先」与「已闭合同层兄弟」
    expect(outlineLogicalDepths(defs)).toEqual([0, 0]);
  });

  it('同位双捕获（同 byteStart/byteEnd）：与提取端 pairsToOutline 一致地嵌套一层', () => {
    const defs = [entry('a', 10, 20, 0), entry('b', 10, 20, 0)];
    expect(outlineLogicalDepths(defs)).toEqual([0, 1]);
  });

  it('钳制 8 层：raw 范围含已滤引用的深嵌套逐层收敛，≥8 层钉死同值', () => {
    // 10 层连续嵌套区间 [i, 90-i)：逻辑深度 i，≥8 钳死
    const defs = Array.from({ length: 10 }, (_, i) => entry(`deep${i}`, i, 90 - i, i + 2));
    expect(outlineLogicalDepths(defs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 8]);
  });

  it('前缀稳定：文档序前缀的重算值 = 全量重算值的前缀（截断切片口径一致）', () => {
    const defs = [
      entry('outer', 0, 168, 0),
      entry('alpha', 32, 74, 2),
      entry('beta', 76, 117, 2),
      entry('gamma', 124, 166, 1),
      entry('tail', 169, 202, 0)
    ];
    const full = outlineLogicalDepths(defs);
    expect(outlineLogicalDepths(defs.slice(0, 3))).toEqual(full.slice(0, 3));
    expect(outlineLogicalDepths(defs.slice(0, 1))).toEqual(full.slice(0, 1));
  });

  it('输入数组不被改写（纯函数）', () => {
    const defs = [entry('a', 0, 10, 0), entry('b', 5, 8, 1)];
    outlineLogicalDepths(defs);
    expect(defs).toHaveLength(2);
    expect(defs[0]).toMatchObject({ name: 'a', byteStart: 0, byteEnd: 10, depth: 0 });
  });
});
