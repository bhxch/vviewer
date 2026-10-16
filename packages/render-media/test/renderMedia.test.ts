import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FileSource, RenderedInstance } from '@vviewer/core';
import { isAbortError } from '@vviewer/core';
import { imageRenderer, sanitizeSvg } from '../src/image';

describe('sanitizeSvg', () => {
  it('strips scripts, event handlers, external refs', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(2)</script>
      <a href="javascript:alert(3)"><text>x</text></a>
      <image href="https://evil.example/x.png"/>
      <circle fill="red" r="10"/>
    </svg>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('onload');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('evil.example');
    expect(clean).toContain('<circle');
  });
});

// BUG-04（SHELL-12 验收）：打开 pixel.png 状态栏至少含大小与编码——image 渲染器
// 实例暴露 getMeta（ViewerPane 按 'getMeta' in 探测，core 类型零改动）。
describe('imageRenderer getMeta（BUG-04 代工）', () => {
  it('返回 buffer 大小与 det.encoding；destroy 撤销 blob URL', async () => {
    // jsdom 不实现 createObjectURL/revokeObjectURL，测试桩之（同 av.test.ts）
    const create = vi.fn(() => 'blob:mock-img');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
    const source: FileSource = {
      storeId: 's',
      storeLabel: '样本',
      path: 'pixel.png',
      name: 'pixel.png',
      store: { id: 's', displayName: () => '样本', listChildren: async () => [], read: async () => new Uint8Array() }
    };
    // BUG-53 解码校验适配：jsdom 无 decode 且不为 img 派发 load/error（渲染前校验
    // 会等待落定），桩 decode 立即 resolve 走主路径
    (HTMLImageElement.prototype as { decode?: unknown }).decode = () => Promise.resolve();
    const target = document.createElement('div');
    document.body.append(target);
    const instance = await imageRenderer.render(new Uint8Array(16), target, source, {
      ext: 'png',
      encoding: 'utf-8'
    } as never);
    expect(target.querySelector('img')).not.toBeNull();
    const meta = (instance as RenderedInstance & { getMeta(): { size: number; encoding?: string } }).getMeta();
    expect(meta.size).toBe(16);
    expect(meta.encoding).toBe('utf-8');
    instance.destroy();
    expect(revoke).toHaveBeenCalledTimes(1);
    delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
    target.remove();
  });
});

describe('imageRenderer 解码校验（BUG-53）', () => {
  const create = vi.fn(() => 'blob:mock');
  const revoke = vi.fn();
  beforeEach(() => {
    create.mockClear();
    revoke.mockClear();
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
    document.body.innerHTML = '';
  });
  function fakeSource(name: string): FileSource {
    return {
      storeId: 'localfiles:s', storeLabel: 's', path: name, name,
      store: { id: 'x', displayName: () => 'x', listChildren: async () => [], read: async () => new Uint8Array() }
    };
  }
  const target = (): HTMLElement => {
    const el = document.createElement('div');
    document.body.append(el);
    return el;
  };

  it('decode() reject → render throw「图片解码失败」+ blob 已 revoke + DOM 未污染', async () => {
    (HTMLImageElement.prototype as { decode?: unknown }).decode = () => Promise.reject(new DOMException('bad', 'EncodingError'));
    const target = document.createElement('div');
    document.body.append(target);
    await expect(
      imageRenderer.render(new Uint8Array(8), target, fakeSource('broken.jpg'), { ext: 'jpg' } as never)
    ).rejects.toThrow('图片解码失败');
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(target.querySelector('.vv-image'), '校验失败不得污染 DOM').toBeNull();
  });

  it('decode() resolve → 正常渲染零回归', async () => {
    (HTMLImageElement.prototype as { decode?: unknown }).decode = () => Promise.resolve();
    const target = document.createElement('div');
    document.body.append(target);
    const instance = await imageRenderer.render(new Uint8Array(8), target, fakeSource('good.png'), { ext: 'png' } as never);
    expect(target.querySelector('.vv-image img')).not.toBeNull();
    instance.destroy();
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  // 审计 R1 I-1：解码 await 窗内的取消（tab 重派/切走/destroy → effectAbort）——
  // render 第 6 参 signal aborted 即快速失败（abortReadError 身份，isAbortError 判真
  // → dispatch catch 的 abort 分类 no-op 不上屏），revoke 成对、DOM 未污染——
  // 迟到 resolve/reject 不再覆写或污染新渲染
  it('decode 挂窗内 abort → render reject AbortError（isAbortError 真）+ revoke + DOM 未污染', async () => {
    // decode 永不落定 = 解码挂窗（大图/畸形编码的竞态窗口）
    (HTMLImageElement.prototype as { decode?: unknown }).decode = () => new Promise(() => {});
    const target = document.createElement('div');
    document.body.append(target);
    const ctrl = new AbortController();
    const p = imageRenderer.render(
      new Uint8Array(8), target, fakeSource('slow.png'), { ext: 'png' } as never,
      undefined, { signal: ctrl.signal }
    );
    ctrl.abort(); // 手动驱动：effect 重跑/tab 切换的 effectAbort.abort() 等价面
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err, '挂窗内取消必须 reject（不得按成功放行覆写新渲染）').not.toBeNull();
    expect(isAbortError(err), '取消身份：isAbortError 判真（dispatch catch abort 分类接管）').toBe(true);
    expect(revoke, 'blob URL 成对回收').toHaveBeenCalledTimes(1);
    expect(target.querySelector('.vv-image'), 'DOM 未污染').toBeNull();
  });

  it('无 decode 环境（jsdom）：load 事件回退正常渲染', async () => {
    // 渲染前校验（BUG-53）落定前 img 尚未入 DOM，jsdom 又不为 blob src 派发
    // load/error——经 createElement 捕获 img 引用，在 detached 节点上派发 load
    let captured: HTMLImageElement | null = null;
    const rawCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const el = rawCreate(tagName, options);
      if (String(tagName).toLowerCase() === 'img') captured = el as HTMLImageElement;
      return el;
    }) as typeof document.createElement);
    const target = document.createElement('div');
    document.body.append(target);
    const p = imageRenderer.render(new Uint8Array(8), target, fakeSource('good.png'), { ext: 'png' } as never);
    const img = captured!;
    img.dispatchEvent(new Event('load'));
    const instance = await p;
    expect(target.querySelector('.vv-image img')).not.toBeNull();
    instance.destroy();
  });

  it('10s 超时护栏：按成功放行 + 迟到 error 兜底内构卡（重试按钮；hex 未注册不出现）', async () => {
    vi.useFakeTimers();
    const target = document.createElement('div');
    document.body.append(target);
    const p = imageRenderer.render(new Uint8Array(8), target, fakeSource('slow.png'), { ext: 'png' } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    const instance = await p;
    expect(target.querySelector('.vv-image img'), '超时按成功放行（大图不阻塞查看器）').not.toBeNull();
    // 迟到解码失败 → 渲染器内构兜底卡（不走 dispatcher——render 已 resolve）
    (target.querySelector('.vv-image img') as HTMLImageElement).dispatchEvent(new Event('error'));
    const card = target.querySelector('.vv-error-card');
    expect(card, '迟到失败应出兜底卡').not.toBeNull();
    expect(card!.querySelector('.vv-error-detail')!.textContent).toContain('图片解码失败');
    expect([...card!.querySelectorAll('.vv-error-action')].map((b) => b.textContent)).toContain('重试');
    instance.destroy();
    vi.useRealTimers();
  });

  it('SVG 分支不接解码校验（spec 铁律）：render 立即 resolve，不等待解码事件', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
    const instance = await imageRenderer.render(svg, target(), fakeSource('ok.svg'), { ext: 'svg' } as never);
    expect(document.querySelector('.vv-image img')).not.toBeNull();
    instance.destroy();
  });

  it('destroy 后迟到 error 不出兜底卡（监听生命周期收口）', async () => {
    vi.useFakeTimers();
    // destroy 已把 img 随 wrap 摘出文档，document.querySelector 取不到（可选链会
    // 静默跳过 dispatch，无修复也绿）——经 createElement 捕获引用派发迟到 error，
    // 真实验证监听生命周期收口（同「load 事件回退」用例手法）
    let captured: HTMLImageElement | null = null;
    const rawCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
      const el = rawCreate(tagName, options);
      if (String(tagName).toLowerCase() === 'img') captured = el as HTMLImageElement;
      return el;
    }) as typeof document.createElement);
    const t = target();
    const p = imageRenderer.render(new Uint8Array(8), t, fakeSource('slow.png'), { ext: 'png' } as never);
    await vi.advanceTimersByTimeAsync(10_000);
    const instance = await p;
    instance.destroy();
    captured!.dispatchEvent(new Event('error'));
    expect(t.querySelector('.vv-error-card'), 'destroy 后不再画卡').toBeNull();
    vi.useRealTimers();
  });
});
