import { describe, expect, it, afterEach } from 'vitest';
import { anySignal } from './signals';

const ANY_DESC = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
afterEach(() => { if (ANY_DESC) Object.defineProperty(AbortSignal, 'any', ANY_DESC); });

describe('anySignal', () => {
  it('原生 any 存在时直用（reason 随源传播）', async () => {
    const a = new AbortController(), b = new AbortController();
    const m = anySignal(a.signal, b.signal);
    a.abort(new DOMException('x', 'AbortError'));
    expect(m.reason?.name).toBe('AbortError');
  });
  it('缺失时手写桥接：任一 abort 同步传播', () => {
    const desc = ANY_DESC; Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
    const a = new AbortController(), b = new AbortController();
    const m = anySignal(a.signal, b.signal);
    b.abort(new DOMException('y', 'AbortError'));
    expect(m.aborted).toBe(true);
    expect(m.reason?.message).toBe('y');
  });
  it('预 abort 一侧同步断', () => {
    const a = new AbortController(); a.abort(new DOMException('pre', 'AbortError'));
    expect(anySignal(a.signal, new AbortController().signal).aborted).toBe(true);
  });
});
