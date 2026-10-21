/**
 * 双信号合并（终审 M-1：AbortSignal.any 存在性守卫——与紧邻 timeout 守卫同款
 * 谨慎度，Safari 17.0–17.3 有 timeout 无 any）：原生 any 优先（reason 随源传播）；
 * 缺失时手写桥接（AbortController + 一次性 abort 监听互拆，apps/web
 * mergeAbortSignals 同款语义——已断同步传播，reason 取先断一侧）。
 */
export function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const merged = new AbortController();
  if (a.aborted) {
    merged.abort(a.reason);
    return merged.signal;
  }
  if (b.aborted) {
    merged.abort(b.reason);
    return merged.signal;
  }
  const onAbort = (ev: Event): void => {
    a.removeEventListener('abort', onAbort);
    b.removeEventListener('abort', onAbort);
    merged.abort((ev.target as AbortSignal).reason);
  };
  a.addEventListener('abort', onAbort);
  b.addEventListener('abort', onAbort);
  return merged.signal;
}
