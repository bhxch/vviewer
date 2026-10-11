import { describe, it, expect } from 'vitest';
import {
  CLOSED_STACK_MAX,
  ClosedStack,
  reorderIds,
  splitPinned,
  regroupPinned
} from './tabOrder';

// pinned 区语义锚：p1/p2 为固定 tab，n1/n2 为普通 tab
const PINNED = new Set(['p1', 'p2']);

describe('splitPinned（pinned 区拆分）', () => {
  it('pinned 区靠左拆出，区内/普通区内各自保持相对序', () => {
    expect(splitPinned(['p1', 'n1', 'p2', 'n2'], PINNED)).toEqual({
      pinnedIds: ['p1', 'p2'],
      normalIds: ['n1', 'n2']
    });
  });

  it('退化形状：空列表 / 全 pinned / 全普通', () => {
    expect(splitPinned([], PINNED)).toEqual({ pinnedIds: [], normalIds: [] });
    expect(splitPinned(['p1', 'p2'], PINNED)).toEqual({ pinnedIds: ['p1', 'p2'], normalIds: [] });
    expect(splitPinned(['n1'], new Set())).toEqual({ pinnedIds: [], normalIds: ['n1'] });
  });
});

describe('reorderIds（组内拖拽重排数学）', () => {
  it('组内换位：[a,b,c] from=b to=c after → [a,c,b]', () => {
    expect(reorderIds(['a', 'b', 'c'], 'b', 'c', false, new Set())).toEqual(['a', 'c', 'b']);
  });

  it('before 语义：[p1,p2,n1,n2] from=n2 to=n1 before → [p1,p2,n2,n1]', () => {
    expect(reorderIds(['p1', 'p2', 'n1', 'n2'], 'n2', 'n1', true, PINNED)).toEqual([
      'p1',
      'p2',
      'n2',
      'n1'
    ]);
  });

  it('跨 pinned 区边界拒绝：普通 → pinned 区内插入点 → null', () => {
    // to=p1 before = 插到 p1 前（pinned 区头之前）
    expect(reorderIds(['p1', 'p2', 'n1', 'n2'], 'n1', 'p1', true, PINNED)).toBeNull();
    // to=p2 before = 插到 p1 与 p2 之间（pinned 区内部）
    expect(reorderIds(['p1', 'p2', 'n1', 'n2'], 'n1', 'p2', true, PINNED)).toBeNull();
  });

  it('跨 pinned 区边界拒绝：pinned → 普通区内插入点 → null', () => {
    expect(reorderIds(['p1', 'p2', 'n1', 'n2'], 'p2', 'n2', true, PINNED)).toBeNull();
    // to=n1 after = 越过 pinned 区尾（p2 仍在 p1 右侧相邻）→ 普通区内 → null
    expect(reorderIds(['p1', 'p2', 'n1', 'n2'], 'p1', 'n1', false, PINNED)).toBeNull();
  });

  it('普通 tab 落 pinned 区尾之后的第一个普通位：to=末位 pinned after 受理', () => {
    expect(reorderIds(['p1', 'p2', 'n1', 'n2'], 'n2', 'p2', false, PINNED)).toEqual([
      'p1',
      'p2',
      'n2',
      'n1'
    ]);
  });

  it('pinned tab 在 pinned 区内重排（含区尾边界）不受限', () => {
    expect(reorderIds(['p1', 'p2', 'n1'], 'p1', 'p2', false, PINNED)).toEqual(['p2', 'p1', 'n1']);
  });

  it('不变式：重排后 splitPinned = pinnedIds(相对序) + normalIds(相对序)', () => {
    const next = reorderIds(['p1', 'p2', 'n1', 'n2', 'n3'], 'n3', 'n1', true, PINNED);
    expect(next).not.toBeNull();
    const { pinnedIds, normalIds } = splitPinned(next!, PINNED);
    expect([...pinnedIds, ...normalIds]).toEqual(next);
    expect(pinnedIds).toEqual(['p1', 'p2']);
  });

  it('同 tab 落点 / 未知 id → null（无动作）', () => {
    expect(reorderIds(['a', 'b'], 'a', 'a', true, new Set())).toBeNull();
    expect(reorderIds(['a', 'b'], 'x', 'a', true, new Set())).toBeNull();
    expect(reorderIds(['a', 'b'], 'a', 'x', true, new Set())).toBeNull();
  });
});

describe('regroupPinned（pin/unpin 后的组内重排）', () => {
  it('pin：新 pinned tab 落 pinned 区尾（区内相对序保持）', () => {
    expect(regroupPinned(['p1', 'n1', 'n2'], 'n2', true, new Set(['p1', 'n2']))).toEqual([
      'p1',
      'n2',
      'n1'
    ]);
    expect(regroupPinned(['p1', 'p2', 'n1'], 'n1', true, new Set(['p1', 'p2', 'n1']))).toEqual([
      'p1',
      'p2',
      'n1'
    ]);
  });

  it('unpin：落普通区首位（整个 pinned 区之后第一位；剩余 pinned 保持相对序）', () => {
    expect(regroupPinned(['p1', 'p2', 'p3', 'n1'], 'p2', false, new Set(['p1', 'p3']))).toEqual([
      'p1',
      'p3',
      'p2',
      'n1'
    ]);
    expect(regroupPinned(['p1', 'p2', 'n1'], 'p1', false, new Set(['p2']))).toEqual([
      'p2',
      'p1',
      'n1'
    ]);
  });
});

describe('ClosedStack（撤销关闭栈纯结构）', () => {
  it('LIFO：后进先出；空栈 pop 返回 null', () => {
    const s = new ClosedStack<string>();
    expect(s.pop()).toBeNull();
    s.push('a');
    s.push('b');
    s.push('c');
    expect(s.size).toBe(3);
    expect(s.pop()).toBe('c');
    expect(s.pop()).toBe('b');
    expect(s.pop()).toBe('a');
    expect(s.pop()).toBeNull();
  });

  it(`容量 ${CLOSED_STACK_MAX}：超限淘汰最旧（栈底）`, () => {
    const s = new ClosedStack<number>(CLOSED_STACK_MAX);
    for (let i = 1; i <= CLOSED_STACK_MAX + 1; i++) s.push(i);
    expect(s.size).toBe(CLOSED_STACK_MAX);
    for (let i = CLOSED_STACK_MAX + 1; i >= 2; i--) expect(s.pop()).toBe(i);
    expect(s.pop()).toBeNull(); // 1 号已在容量淘汰中丢失
  });

  it('clear 清空；淘汰后可继续入栈', () => {
    const s = new ClosedStack<string>(2);
    s.push('a');
    s.push('b');
    s.push('c'); // a 被淘汰
    expect(s.size).toBe(2);
    s.clear();
    expect(s.pop()).toBeNull();
    s.push('x');
    expect(s.pop()).toBe('x');
  });
});
