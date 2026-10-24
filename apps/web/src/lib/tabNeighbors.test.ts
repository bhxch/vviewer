// tabNeighbors.test.ts — 关闭邻位/批量对齐算法的纯函数直测（FE-1 新增）：语义
// 自 openFlow.svelte.ts 的 TabCollection.close（先右后左，组内作用域不跨组抢
// 激活）与 alignActivationAfterBatch（按关闭前组序找最近存活邻位）抽出。
// neighborAfterClose 的输入契约与 close 调用点一致：关闭后的列表（被关元素已
// splice 移除）+ 被关元素原位索引（向右扫描起点）。
import { describe, expect, it } from 'vitest';
import { neighborAfterBatch, neighborAfterClose } from './tabNeighbors';

describe('neighborAfterClose（单关邻位：先右后左，组内作用域）', () => {
  it('右侧同组最近邻优先（跨组 tab 跳过不抢激活）', () => {
    // 关闭 b(w1) 后的列表 a(w1) c(w2) d(w1) e(w2)，b 原位 index 1：
    // j=1 是 c(w2) 跨组跳过 → 取 d(w1)
    const afterCloseB = [
      { id: 'a', workspaceId: 'w1' },
      { id: 'c', workspaceId: 'w2' },
      { id: 'd', workspaceId: 'w1' },
      { id: 'e', workspaceId: 'w2' }
    ];
    expect(neighborAfterClose(afterCloseB, 1, 'w1')).toBe('d');
  });

  it('关闭位右侧无同组 → 回左侧最近同组（同样跳过跨组）', () => {
    // 关闭 d(w1)（w1 组内最右）后的列表 a(w1) b(w1) c(w2)，d 原位 index 2：
    // j=2 是 c(w2) 跨组跳过；回左 j=1 b(w1)
    const afterCloseD = [
      { id: 'a', workspaceId: 'w1' },
      { id: 'b', workspaceId: 'w1' },
      { id: 'c', workspaceId: 'w2' }
    ];
    expect(neighborAfterClose(afterCloseD, 2, 'w1')).toBe('b');
  });

  it('组内无存活邻位（全组关闭）返回 null（不跨组）', () => {
    // 关闭 x(w1)（组内唯一）后的列表 y(w2) z(w2)，x 原位 index 0
    const afterCloseX = [
      { id: 'y', workspaceId: 'w2' },
      { id: 'z', workspaceId: 'w2' }
    ];
    expect(neighborAfterClose(afterCloseX, 0, 'w1')).toBeNull();
  });

  it('首 tab 关闭取右侧最近同组；尾 tab 关闭回左侧最近同组', () => {
    // 关闭 a(w1) 后的列表 b(w1) c(w2) d(w1)，a 原位 index 0
    const afterCloseA = [
      { id: 'b', workspaceId: 'w1' },
      { id: 'c', workspaceId: 'w2' },
      { id: 'd', workspaceId: 'w1' }
    ];
    expect(neighborAfterClose(afterCloseA, 0, 'w1')).toBe('b');
    // 关闭 e(w2)（列表尾）后的列表 a(w1) c(w2) d(w1)，e 原位 index 3：
    // 右侧越界；回左 j=2 d(w1) 跨组跳过 → j=1 c(w2)
    const afterCloseE = [
      { id: 'a', workspaceId: 'w1' },
      { id: 'c', workspaceId: 'w2' },
      { id: 'd', workspaceId: 'w1' }
    ];
    expect(neighborAfterClose(afterCloseE, 3, 'w2')).toBe('c');
  });
});

describe('neighborAfterBatch（批量对齐：原活动关闭时按关闭前组序先右后左找存活邻位）', () => {
  // 关闭前组序 a b c d e，prevActive = c（已批量关闭）
  const beforeIds = ['a', 'b', 'c', 'd', 'e'];

  it('原活动右侧有存活 → 最近右侧存活', () => {
    expect(neighborAfterBatch(beforeIds, new Set(['a', 'b', 'd']), 'c')).toBe('d');
  });

  it('右侧全灭 → 回左侧最近存活（跳过已关成员）', () => {
    expect(neighborAfterBatch(beforeIds, new Set(['a', 'b']), 'c')).toBe('b');
    expect(neighborAfterBatch(beforeIds, new Set(['a']), 'c')).toBe('a');
  });

  it('存活邻位按关闭前序就近取（跨过已灭的右侧成员取更远的）', () => {
    // d 已灭、e 存活：c 的右侧最近存活是 e（跨过 d）
    expect(neighborAfterBatch(beforeIds, new Set(['a', 'e']), 'c')).toBe('e');
  });

  it('组内全灭（含原活动）→ null（调用方不动激活）', () => {
    expect(neighborAfterBatch(beforeIds, new Set(), 'c')).toBeNull();
    expect(neighborAfterBatch(beforeIds, new Set(['x']), 'c')).toBeNull();
  });
});
