# 媒体错误兜底 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 media 域三条 fixme 缺陷——BUG-52 音频错误静默（av.ts 音频分支接错误卡片装置）、BUG-54 video 错误文案恒「未知错误」（video:error 同步点缓存 code）、BUG-53 图片解码失败无兜底（同步解码校验 throw，兼解锁 dispatcher 级「二进制→hex 排前」排序锚）——三条 e2e fixme 转正 + 新增排序锚用例。

**Architecture:** av.ts 把 BUG-14 错误卡片装置（release/buildActions/showMediaError）上提为双分支共享（release 以分支装配点注入）；视频错误文案经 `video:error` 同步事件缓存 MediaError code（ArtPlayer 重连清空 `video.error` 之前的真值），现有 `'error'` 时序不动。image.ts 在 raster 分支渲染前做解码校验（`img.decode()` 主路径 / load-error 事件回退 + 10s 超时护栏），失败 revoke 后 throw → dispatcher 现成错误卡片；超时按成功放行 + 迟到 error 渲染器内构兜底卡。

**Tech Stack:** TypeScript（render-media/core）+ vitest（jsdom，仓库根跑）+ Playwright e2e。

**Spec:** docs/superpowers/specs/2026-10-16-media-error-fallback-design.md

## Global Constraints

- 文中行号为实施起点 HEAD 参考，以符号定位为准；改动前先读目标代码确认现文。
- vitest 必须在仓库根执行（`pnpm vitest run <file>`）；包目录直跑缺 jsdom。
- 每任务原子提交，Angular 规范、先 why 后 what。
- BUG-54 铁律：缓存 code 只改文案来源，**卡片时机、ArtPlayer 重连语义、`'error'` 事件接线全部不动**；`videoErrorMessage` 映射表与其既有单测（av.test.ts）不动。
- BUG-53 铁律：SVG 分支不接解码校验（sanitizeSvg throw → dispatcher 卡片是既有 OWX-02 锚）；校验只在 raster 分支。
- e2e 转正用 t-media.spec.ts 既有 `openDir`/`openFile` 页内注入装置构造载体（无需服务端实例）；README §3.2.4：修复合入 PR 内 fixme 转正。
- 既有测试是契约锚：av.test.ts 全部既有用例（含 T7 构造失败回归、artplayer mock 的构造抛错默认态）、renderMedia.test.ts sanitizeSvg/getMeta、b-media-office-viewer MEDIA-11/BUG-14——零翻转。

---

### Task 1: BUG-52 音频分支错误卡片（装置上提）

**Files:**
- Modify: `packages/render-media/src/av.ts`（音频分支 :367-384 与视频装置段 :414-480——装置上提为分支前共享，音频分支接 `el.addEventListener('error')`）
- Test: `packages/render-media/test/av.test.ts`（avRenderer describe 内新增音频错误用例）

**Interfaces:**
- Consumes: 既有 `videoErrorMessage(code)`、`showErrorCard`、`getHexFallbackRenderer`（av.ts 已导入）；jsdom 手动派发 error 事件。
- Produces: 音频分支行为——解码失败 → `.vv-error-card`（重试 + 以 hex 打开〔hex 已注册时〕），首错收口；`liveChild` 级联并入音频实例 destroy。av.ts 导出面零变化。

- [ ] **Step 1: 写失败测试**

`av.test.ts` 的 avRenderer describe 内、既有「音频保持原生」用例之后新增：

```ts
  it('BUG-52：损坏音频 error → 错误卡片（文案含映射表条目 + 重试按钮）；首错收口不双弹；destroy 幂等', async () => {
    const create = vi.fn(() => 'blob:mock');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
    const target = document.createElement('div');
    document.body.append(target);
    const instance = await avRenderer.render(new Uint8Array(8), target, fakeSource('broken.mp3'), { ext: 'mp3' } as never);
    const el = target.querySelector('audio');
    expect(el).not.toBeNull();
    // 注入 MediaError（code=4 与实机 DEMUXER_ERROR 同值）后派发 error
    Object.defineProperty(el!, 'error', { value: { code: 4 }, configurable: true });
    el!.dispatchEvent(new Event('error'));
    const card = target.querySelector('.vv-error-card');
    expect(card, '解码失败应出错误卡片').not.toBeNull();
    expect(card!.querySelector('.vv-error-detail')!.textContent).toContain('无法播放此媒体');
    expect(card!.querySelector('.vv-error-detail')!.textContent).toContain('MEDIA_ERR_SRC_NOT_SUPPORTED');
    expect([...card!.querySelectorAll('.vv-error-action')].map((b) => b.textContent)).toContain('重试');
    // 首错收口：二次 error 不重弹（cardShown guard）——卡片仍恰一张
    el!.dispatchEvent(new Event('error'));
    expect(target.querySelectorAll('.vv-error-card').length).toBe(1);
    // 播放器已 release（revoke 恰一次）；实例 destroy 幂等不再 revoke
    instance.destroy();
    expect(revoke).toHaveBeenCalledTimes(1);
    target.remove();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-media/test/av.test.ts`
Expected: 新用例 FAIL（音频分支无监听，`.vv-error-card` 为 null）；既有用例全绿。

- [ ] **Step 3: 实现装置上提 + 音频接卡**

av.ts 改造（保持全部既有注释语义，只移动与注写增量）：

① 把视频路径的装置段（`released`/`release`/`cardShown`/`liveChild`/`takeOver`/`buildActions`/`showMediaError`，现 :414-474）整体**上提到音频分支之前**，改为双分支共享形态：`release` 声明提前为 `let release: () => void = () => {};`，各分支在创建自己的资源后覆写赋值；`buildActions`/`showMediaError` 函数体逐字保留（`showMediaError` 内 `release()` 调用不变）。

② 音频分支（现 :367-384）在 `target.replaceChildren(el);` 之后补：

```ts
      release = () => {
        if (released) return;
        released = true;
        el.pause();
        URL.revokeObjectURL(url);
        el.remove();
      };
      // BUG-52：音频解码失败不再静默——对齐视频分支 showMediaError（首错收口，
      // MediaError code 语义音视频一致，映射表复用）
      el.addEventListener('error', () => {
        showMediaError(videoErrorMessage(el.error?.code));
      });
```

音频分支 `return` 的 instance `destroy()` 改为 `release(); liveChild?.destroy();`（级联对齐视频实例）。

③ 视频路径原 :414-426 的 `released`/`release` 声明删除（已上提），`release = () => { ...原函数体... };`（art 创建之后赋值——保持「art 构造失败 revoke 后 rethrow」路径不受影响：该路径在赋值前 throw，release 仍为 no-op 缺省）。`mediaFatal = showMediaError;` 与 `art.on('error', ...)` 原样保留。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/render-media/test/av.test.ts`
Expected: 全 PASS（新用例转绿；T7 构造失败回归等既有用例零翻转）

- [ ] **Step 5: 提交**

```bash
git add packages/render-media/src/av.ts packages/render-media/test/av.test.ts
git commit -m "fix(render-media): 音频解码失败接错误卡片——BUG-14 装置上提双分支共享

why：音频分支零 error 监听且提前 return 够不着视频路径的卡片装置，损坏音频
完全静默（BUG-52，medium）；装置闭包捕获视频状态无法直接复用，需上提改造。
what：release/buildActions/showMediaError 上提为分支前共享（release 分支装配
点注入），音频分支挂 error 监听 → 首错收口弹卡（重试/以 hex 打开），liveChild
级联并入音频实例 destroy。"
```

---

### Task 2: BUG-54 video:error 同步点缓存 code

**Files:**
- Modify: `packages/render-media/src/av.ts`（视频路径错误接线段，现 :476-480 一带）
- Modify: `packages/render-media/test/av.test.ts`（artplayer mock 改造为可控双态 + 新增用例）

**Interfaces:**
- Consumes: Task 1 上提后的 `showMediaError`；artplayer.mjs 的 `video:error` 转发契约（第一参为同步捕获的 DOM ErrorEvent，此刻 `target.error` 尚未清空）。
- Produces: 错误卡片文案恢复映射表可达（code=4 → MEDIA_ERR_SRC_NOT_SUPPORTED）；时序零变化。

- [ ] **Step 1: 改造 artplayer mock + 写失败测试**

`av.test.ts` 顶部 `vi.mock('artplayer', ...)` 改为可控双态（`vi.hoisted` 供工厂引用外部态；**默认 `failConstruct: true` 保持 T7 用例不变**）：

```ts
const artMock = vi.hoisted(() => ({
  state: {
    failConstruct: true,
    instances: [] as Array<{
      on(event: string, cb: (ev?: unknown) => void): void;
      emit(event: string, ev?: unknown): void;
      destroy(remove?: boolean): void;
    }>
  }
}));

vi.mock('artplayer', () => ({
  default: class {
    private handlers = new Map<string, Array<(ev?: unknown) => void>>();
    constructor() {
      if (artMock.state.failConstruct) throw new Error('artplayer 构造失败（测试注入）');
      artMock.state.instances.push(this);
    }
    on(event: string, cb: (ev?: unknown) => void): void {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
    }
    emit(event: string, ev?: unknown): void {
      for (const cb of this.handlers.get(event) ?? []) cb(ev);
    }
    destroy(_remove?: boolean): void {}
  }
}));
```

avRenderer describe 内新增（`getHexFallbackRenderer` 未注册——hex 动作缺席是预期，只断「重试」）：

```ts
  it('BUG-54：video:error 同步点缓存 code——卡片文案命中映射表而非「未知错误」（时序不动）', async () => {
    const create = vi.fn(() => 'blob:mock');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true });
    artMock.state.failConstruct = false;
    artMock.state.instances = [];
    const target = document.createElement('div');
    document.body.append(target);
    await avRenderer.render(new Uint8Array(16), target, fakeSource('broken.mp4'), { ext: 'mp4' } as never);
    const art = artMock.state.instances[0];
    expect(art, '前置：ArtPlayer 已构造').toBeDefined();
    // 复刻 ArtPlayer 真实时序：video:error（error 仍在）→ 1s 后重设源（error 清空）→ 'error'
    art.emit('video:error', { target: { error: { code: 4 } } });
    art.emit('error', { target: { error: null } });
    const detail = target.querySelector('.vv-error-card .vv-error-detail')!.textContent!;
    expect(detail).toContain('MEDIA_ERR_SRC_NOT_SUPPORTED');
    expect(detail).not.toContain('未知错误');
    expect(revoke).toHaveBeenCalledTimes(1); // release 摘播放器并回收 blob
    artMock.state.failConstruct = true;
    target.remove();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-media/test/av.test.ts`
Expected: 新用例 FAIL（`video.error` 已被 emit 前清空的模拟形态 → 文案「未知错误」）；T7 等既有用例零翻转（mock 默认态未变）。

- [ ] **Step 3: 实现**

av.ts 视频路径 `art.on('error', ...)` 段改为：

```ts
    // video 运行期解码错误（截断 mp4 等）：ArtPlayer 转发 video 'error' 事件。
    // BUG-54：ArtPlayer 的 'error' 在 sleep(1s) + 重设 url（media load 算法清空
    // video.error）之后才 emit，彼时读 art.video.error 恒 null → 映射表不可达、
    // 文案恒「未知错误」。video:error 转发点是同步捕获的 DOM ErrorEvent（此刻
    // error 还在），在此缓存 code 供 'error' 处理器查表——卡片时机/重连语义零变化
    let lastVideoErrCode: number | null | undefined;
    art.on('video:error', (event: unknown) => {
      lastVideoErrCode = (event as { target?: { error?: { code: number } | null } } | undefined)?.target?.error?.code;
    });
    art.on('error', () => {
      const mediaErr = (art as unknown as { video?: HTMLVideoElement | null }).video?.error;
      showMediaError(videoErrorMessage(lastVideoErrCode ?? mediaErr?.code));
    });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/render-media/test/av.test.ts`
Expected: 全 PASS（新用例转绿；T7/audio/纯函数映射表用例零翻转）

- [ ] **Step 5: 提交**

```bash
git add packages/render-media/src/av.ts packages/render-media/test/av.test.ts
git commit -m "fix(render-media): video:error 同步点缓存 code 修文案映射——BUG-54

why：ArtPlayer 的 'error' 在 1s 重连 sleep + 重设 url 清空 video.error 之后
才 emit，映射表恒落「未知错误」，诊断信息量归零（BUG-54，low）。
what：video:error 转发点（同步 DOM ErrorEvent，error 尚在）缓存 code，
'error' 处理器查缓存表；卡片时机与重连语义零变化，映射表不动。"
```

---

### Task 3: BUG-53 图片同步解码校验 + throw

**Files:**
- Modify: `packages/render-media/src/image.ts`（raster 分支解码校验；`observeImageDecode` 新增；迟到兜底卡装置）
- Test: `packages/render-media/test/renderMedia.test.ts`（新增解码校验 describe）

**Interfaces:**
- Consumes: `showErrorCard` / `getHexFallbackRenderer` / `ErrorCardAction`（`@vviewer/core` 包根已导出，image.ts 增补值导入）。
- Produces: raster 解码失败 → render throw「图片解码失败：…」→ dispatcher 卡片（损坏二进制图片 → hex 排前）；超时放行 + 迟到 error 内构兜底卡（重试/以 hex 打开）。SVG 分支零变化。

- [ ] **Step 1: 写失败测试**

`renderMedia.test.ts` import 区改为：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FileSource, RenderedInstance } from '@vviewer/core';
import { imageRenderer, sanitizeSvg } from '../src/image';
```

文件尾部新增（URL blob 桩沿 av.test.ts 同款手法）：

```ts
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

  it('无 decode 环境（jsdom）：load 事件回退正常渲染', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    const p = imageRenderer.render(new Uint8Array(8), target, fakeSource('good.png'), { ext: 'png' } as never);
    const img = target.querySelector('img') ?? await vi.waitFor(() => {
      const el = target.querySelector('img');
      expect(el).not.toBeNull();
      return el!;
    });
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
});
```

（`beforeEach` 需从 vitest 导入——import 行已含。）注意第二用例 `img` 查询时机：校验通过前 img 尚未入 DOM，`decode` 原型桩保证同步 resolve 后立即上屏，`target.querySelector('img')` 在 render await 之后可用——第三用例的 `vi.waitFor` 形态仅在无 decode 回退分支需要。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-media/test/renderMedia.test.ts`
Expected: 新 describe 用例 FAIL（现状无校验：decode reject 用例不 throw、超时用例不出卡）；sanitizeSvg/getMeta 既有用例零翻转。

- [ ] **Step 3: 实现**

image.ts：import 区改 `import { getHexFallbackRenderer, showErrorCard, type Encoding, type ErrorCardAction, type RenderedInstance, type Renderer } from '@vviewer/core';`（原 type-only import 行合并），文件头部新增：

```ts
/** 超时护栏（spec §4.2）：decode 挂死（异常大图/畸形编码）时按成功放行，迟到失败
 * 走渲染器内构兜底卡——不阻塞查看器主路径。 */
const IMAGE_DECODE_TIMEOUT_MS = 10_000;

type DecodeOutcome = { kind: 'ok' } | { kind: 'failed' } | { kind: 'timeout' };

/**
 * 解码校验观察（BUG-53）：decode() 主路径、load/error 事件回退（jsdom/无 decode
 * 环境）、超时三路竞待。结果枚举而非 promise reject——竞待落定后迟到的另一路
 * 不产生 unhandled rejection。finish 幂等（首达移除全部监听与计时器）。
 */
function observeImageDecode(img: HTMLImageElement, timeoutMs: number): Promise<DecodeOutcome> {
  return new Promise((resolve) => {
    const finish = (outcome: DecodeOutcome): void => {
      clearTimeout(timer);
      img.removeEventListener('error', onError);
      img.removeEventListener('load', onLoad);
      resolve(outcome);
    };
    const onError = (): void => finish({ kind: 'failed' });
    const onLoad = (): void => finish({ kind: 'ok' });
    img.addEventListener('error', onError);
    img.addEventListener('load', onLoad);
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    if (typeof img.decode === 'function') {
      img.decode().then(
        () => finish({ kind: 'ok' }),
        () => finish({ kind: 'failed' })
      );
    }
  });
}
```

imageRenderer.render 的 raster else 分支（`img.src = url; img.alt = source.name;` 之后、`wrap.append(img)` 之前）插入：

```ts
    // BUG-53 解码校验：失败即 revoke + throw（DOM 未污染）→ dispatcher 现成错误
    // 卡片（重试/以 hex/以纯文本；损坏二进制图片经 looksTextual 走「以 hex 打开」
    // 排前）；超时按成功放行 + 迟到 error 渲染器内构兜底卡（超时路径动作面较窄，
    // 无 dispatcher 级 open-as，注释明示的降级体验）
    const outcome = await observeImageDecode(img, IMAGE_DECODE_TIMEOUT_MS);
    if (outcome.kind === 'failed') {
      URL.revokeObjectURL(url);
      throw new Error('图片解码失败：数据损坏或格式不支持');
    }
    const lateGuard = outcome.kind === 'timeout';
```

`target.replaceChildren(wrap);` 之后（原 attachZoom 附近）补迟到兜底装置：

```ts
    // —— 迟到兜底（BUG-53 超时路径专属）：渲染器内构卡，av 同款形态 ——
    let cardShown = false;
    let liveChild: RenderedInstance | null = null;
    const takeOver = (instance: RenderedInstance): void => {
      liveChild?.destroy();
      liveChild = instance;
    };
    const detachImage = (): void => {
      URL.revokeObjectURL(url);
      wrap.remove();
    };
    const buildActions = (): ErrorCardAction[] => {
      const actions: ErrorCardAction[] = [
        {
          label: '重试',
          onClick: () => {
            imageRenderer.render(buffer, target, source, det)
              .then(takeOver)
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                showErrorCard(target, message, source, { actions: buildActions() });
              });
          }
        }
      ];
      const hex = getHexFallbackRenderer();
      if (hex) {
        actions.push({
          label: '以 hex 打开',
          onClick: () => {
            detachImage();
            Promise.resolve(hex.render(buffer, target, source, det))
              .then(takeOver)
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                showErrorCard(target, message, source);
              });
          }
        });
      }
      return actions;
    };
    if (lateGuard) {
      img.addEventListener('error', () => {
        if (cardShown) return;
        cardShown = true;
        detach();
        detachImage();
        showErrorCard(target, '图片解码失败：数据损坏或格式不支持', source, { actions: buildActions() });
      });
    }
```

instance `destroy()` 改为 `detach(); detachImage(); liveChild?.destroy();`（revoke 幂等：URL.revokeObjectURL 对已 revoke 的 URL 重复调用是规范定义的 no-op）。注意 `detach`（attachZoom 返回值）声明位置须先于上述装置引用——按现文件语句序把 attachZoom 调用提前到装置块之前即可。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run packages/render-media/test/renderMedia.test.ts packages/render-media/test/av.test.ts`
Expected: 全 PASS（新 describe 转绿；既有 sanitizeSvg/getMeta 零翻转）

- [ ] **Step 5: 提交**

```bash
git add packages/render-media/src/image.ts packages/render-media/test/renderMedia.test.ts
git commit -m "fix(render-media): 图片同步解码校验 throw 接错误卡片——BUG-53

why：img 解码异步失败无任何兜底（裂图+alt），render 恒 resolve 使错误永落
dispatcher 之外；throw 形态兼解锁「二进制→hex 排前」dispatcher 级排序锚。
what：raster 分支渲染前 observeImageDecode 三路竞待（decode 主路径/load-error
回退/10s 超时护栏，结果枚举防 unhandled rejection），失败 revoke+throw；
超时放行 + 迟到 error 内构兜底卡（重试/以 hex 打开）。SVG 分支不动。"
```

---

### Task 4: e2e 转正三 fixme + 排序锚 + 域文档注记

**Files:**
- Modify: `apps/web/e2e/t-media.spec.ts`（三处 test.fixme 转正式断言）
- Modify: `apps/web/e2e/b-error-card-open-as.spec.ts`（新增二进制图片 hex 排前排序锚用例）
- Modify: `docs/e2e/error-card-open-as.md`（排序窄化知情现状注记）

**Interfaces:**
- Consumes: Task 1-3 的产品行为；t-media 既有 `openDir`/`openFile` 注入装置（:38-57）与 `sampleOf` 载体手法；b-media-office-viewer.spec.ts:406 的 `mp4.slice(0, 300)` 截断口径。
- Produces: 三条 fixme 转正 + OWX 排序双向锚补全（文本侧既有 OWX-02 损坏 SVG → 纯文本排前）。

- [ ] **Step 1: BUG-52 fixme 转正**

`t-media.spec.ts` BUG-52 的 `test.fixme(...)` 改 `test(...)`，保留标题（去「[探索]」后缀语义不变可保留原题）与最小复现注释（压缩为背景说明），断言体：

```ts
test('BUG-52：损坏音频解码失败 → 统一错误卡片（重试按钮）', async ({ page }) => {
  const dir = await openDir(page, [
    // mp3 头 + 垃圾字节：浏览器 demux 失败（code=4 同族）
    { name: 'broken.mp3', type: 'audio/mpeg', bytes: new Uint8Array(300).map((_, i) => (i < 3 ? 0x49 : 0xba)) }
  ]);
  await openFile(page, 'broken.mp3');
  const card = page.locator('.vv-error-card');
  await expect(card, '音频解码失败出统一错误卡片（BUG-52 修复面）').toBeVisible({ timeout: 30_000 });
  await expect(card.locator('.vv-error-detail')).toContainText('无法播放此媒体');
  await expect(card.locator('.vv-error-action', { hasText: '重试' })).toBeVisible();
  expect(dir).toBeDefined(); // 装置句柄占位（与文件内既有用例形态一致）
});
```

（断言细节以页面真实 DOM 为准：`dir` 变量若装置返回 void 则去掉该行——实施时对照 :38-57 装置签名与同文件既有用例调用形态逐字对齐。）

- [ ] **Step 2: BUG-53 fixme 转正**

```ts
test('BUG-53：损坏图片解码失败 → dispatcher 错误卡片（hex 排前），无残留裂图', async ({ page }) => {
  await openDir(page, [
    { name: 'broken.jpg', type: 'image/jpeg', bytes: new Uint8Array(512).fill(0xba) }
  ]);
  await openFile(page, 'broken.jpg');
  const card = page.locator('.vv-error-card');
  await expect(card, '解码失败 throw → dispatcher 卡片').toBeVisible({ timeout: 30_000 });
  const labels = card.locator('.vv-error-action');
  await expect(labels.first(), '垃圾字节判非文本 → 「以 hex 打开」排前（排序锚）').toHaveText('以 hex 打开');
  await expect(page.locator('.vv-image'), '无残留裂图 img').toHaveCount(0);
});
```

- [ ] **Step 3: BUG-54 fixme 转正**

```ts
test('BUG-54：video 运行期错误文案命中映射表（code=4 → MEDIA_ERR_SRC_NOT_SUPPORTED）', async ({ page }) => {
  const sample = sampleOf('sample.mp4'); // 沿文件既有 sampleOf 载体手法
  await openDir(page, [
    { name: 'broken.mp4', type: 'video/mp4', bytes: sample.slice(0, 300) }
  ]);
  await openFile(page, 'broken.mp4');
  const card = page.locator('.vv-error-card');
  // ArtPlayer video:error → 1s sleep 重连 → emit error：文案在卡片出现即查缓存表
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator('.vv-error-detail')).toContainText('MEDIA_ERR_SRC_NOT_SUPPORTED', { timeout: 30_000 });
});
```

（`sampleOf('sample.mp4')` 的确切形态实施时对照 :62-72 的 `sampleOf` 定义与 b-media-office-viewer.spec.ts:400-410 的 mp4 载体装载方式逐字对齐；若 t-media 无 mp4 样本装载 helper，则按该文件既有 bytes 构造手法内联。）三处转正后文件头「回归占位」注释块相应更新（三条全部转正完毕，占位说明段落删除或改写为已完成记录）。

- [ ] **Step 4: b-error-card-open-as 排序锚 + 文档注记**

`b-error-card-open-as.spec.ts` 沿既有用例形态新增（对照 OWX-02 损坏 SVG → 纯文本排前的既有断言写法逐字对齐装置与选择器）：

```ts
test('OWX-03：损坏二进制图片（垃圾字节 .jpg）→ 卡片动作「以 hex 打开」排前（looksTextual 二分）', async ({ page }) => {
  // 载体：纯垃圾字节（无 NUL 亦无文本特征）——looksTextual(head)=false → hex 排前；
  // 解码失败 throw 落 dispatcher catch（BUG-53 修复解锁的本分支 e2e 锚）
  await openAsTestSetup(page, [{ name: 'garbage.jpg', type: 'image/jpeg', bytes: new Uint8Array(512).fill(0xba) }]);
  await page.getByText('garbage.jpg').click();
  const card = page.locator('.vv-error-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  const labels = card.locator('.vv-error-action');
  await expect(labels.first()).toHaveText('以 hex 打开');
  await expect(labels.nth(1)).toHaveText('以纯文本打开');
});
```

（`openAsTestSetup` 为示意——实施时对照该文件既有 OWX-01/OWX-02 的真实 setup helper 名与调用形态逐字对齐。）

`docs/e2e/error-card-open-as.md` 末尾追加注记：

```markdown
## 动态排序口径（2026-10-16 裁决）

open-as 动作排序 = `looksTextual(head)` 二分（判文本 → 纯文本在前，否则 hex 在前；
head 为 8KB 探测块）。`detect()` 的签名/binary 探测链结论**不参与排序**——知情现状
（SUSP-10 同类口径）：两判据罕有分歧，卡片构造于全量拉取前，以 head 近似是声明过的
可接受退化（dispatcher.ts buildRenderErrorActions 注释在案）。OWX-03（垃圾字节图片 →
hex 排前）与 OWX-02（损坏 SVG → 纯文本排前）构成双向锚。
```

- [ ] **Step 5: 本地验证**

Run: `pnpm --filter web exec playwright test t-media b-error-card-open-as`
Expected: 转正三用例 + 新排序锚全绿（t-media 的三用例此前为 fixme/skip，转正后实跑）

- [ ] **Step 6: 提交**

```bash
git add apps/web/e2e/t-media.spec.ts apps/web/e2e/b-error-card-open-as.spec.ts docs/e2e/error-card-open-as.md
git commit -m "test(e2e): BUG-52/53/54 三 fixme 转正 + OWX 排序锚补全

why：README §3.2.4 约定修复合入 PR 内转正；BUG-53 throw 形态解锁的
「二进制→hex 排前」分支需 dispatcher 级 e2e 锚（2026-10-13 报告缺口①）。
what：t-media 三缺陷转正（截断 mp3/垃圾 jpg/截断 mp4 载体）+ 排序锚 OWX-03
（与 OWX-02 纯文本排前成双向锚）+ 域文档补排序窄化知情现状注记。"
```

---

### Task 5: 收口门禁

**Files:** 无新改动（发现回归时修复并单独提交）

- [ ] **Step 1: 全量单测**

Run: `pnpm vitest run`
Expected: 全 PASS

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 error

- [ ] **Step 3: playwright 默认通道**

Run: `VV_GRAMMAR_CDN=https://cdn.grammars.test/grammars/ pnpm --filter web build && pnpm --filter web exec playwright test`
Expected: 全 PASS（含转正三用例与排序锚；既有 MEDIA-11/BUG-14 锚零翻转）

- [ ] **Step 4: 收口**

门禁数字记入台账；如有修复按 Angular 规范单独提交。
