import { describe, expect, it } from 'vitest';
import { mergeAbortSignals } from './mergeAbortSignals';

// deferred 清偿 Task 5：effect 级取消的信号合并——ViewerPane effect 的 read 闭包把
// 「dispatcher 渲染链透传的实例级 signal（可缺省）」与「effectAbort.signal」合并后
// 传 store.read，cleanup 时 abort 覆盖 pre-instance 在飞读窗口。

describe('mergeAbortSignals', () => {
  it('缺省直通：undefined+undefined → undefined；单侧 undefined → 另一侧同一引用', () => {
    const s = new AbortController().signal;
    expect(mergeAbortSignals(undefined, undefined)).toBeUndefined();
    expect(mergeAbortSignals(undefined, s)).toBe(s);
    expect(mergeAbortSignals(s, undefined)).toBe(s);
  });

  it('任一 abort → 结果 aborted，reason 同步传播（a 向与 b 向）', () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = mergeAbortSignals(a.signal, b.signal);
    expect(merged?.aborted).toBe(false);
    const reasonA = new DOMException('effect 取消', 'AbortError');
    a.abort(reasonA);
    expect(merged?.aborted).toBe(true);
    expect(merged?.reason).toBe(reasonA);

    const a2 = new AbortController();
    const b2 = new AbortController();
    const merged2 = mergeAbortSignals(a2.signal, b2.signal);
    const reasonB = new DOMException('实例取消', 'AbortError');
    b2.abort(reasonB);
    expect(merged2?.aborted).toBe(true);
    expect(merged2?.reason).toBe(reasonB);
  });

  it('入参已 aborted：结果构造即 aborted（同步传播，不等事件循环）', () => {
    const a = new AbortController();
    a.abort();
    const b = new AbortController();
    expect(mergeAbortSignals(a.signal, b.signal)?.aborted).toBe(true);
    expect(mergeAbortSignals(b.signal, a.signal)?.aborted).toBe(true);
  });

  it('AbortSignal.any 缺失时回退手写组合：语义一致（任一断即断 + 已断同步 + reason 传播）', () => {
    const host = AbortSignal as unknown as { any?: unknown };
    const original = host.any;
    host.any = undefined; // 特性探测注入：强制走手写回退分支
    try {
      const a = new AbortController();
      const b = new AbortController();
      const merged = mergeAbortSignals(a.signal, b.signal);
      expect(merged?.aborted).toBe(false);
      const reason = new DOMException('取消', 'AbortError');
      a.abort(reason);
      expect(merged?.aborted).toBe(true);
      expect(merged?.reason).toBe(reason);

      const c = new AbortController();
      const d = new AbortController();
      d.abort();
      expect(mergeAbortSignals(c.signal, d.signal)?.aborted).toBe(true);
    } finally {
      host.any = original;
    }
  });
});
