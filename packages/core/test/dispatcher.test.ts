import { describe, it, expect, vi } from 'vitest';
import { createRegistry } from '../src/registry/registry';
import { createDispatcher, signatureRouteOf } from '../src/dispatch/dispatcher';
import type { Renderer, StreamCtx, TreeStore } from '../src/types';

const mk = (id: string, exts: string[], over: Partial<Renderer> = {}): Renderer => ({
  id, label: id, extensions: exts, render: async () => ({ destroy() {} }), ...over
});

/** MPEG-TS 头（0/188/376 三重 0x47）与常见 magic 字节 */
const MPEGTS = (() => {
  const b = new Uint8Array(377);
  b[0] = b[188] = b[376] = 0x47;
  return b;
})();
const PK = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = new TextEncoder().encode('%PDF-1.7 rest');

function source(name: string): Parameters<ReturnType<typeof createDispatcher>['dispatch']>[0] {
  return { storeId: 's', storeLabel: 's', path: name, name, store: {} as never };
}

describe('dispatcher', () => {
  it('routes by extension', async () => {
    const reg = createRegistry();
    let called = '';
    reg.install(mk('text', ['txt'], { render: async () => { called = 'text'; return { destroy() {} }; } }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(
      source('a.txt'), new TextEncoder().encode('hi'), target);
    expect(rendererId).toBe('text');
    expect(called).toBe('text');
  });
  it('sniff redirect happens once', async () => {
    const reg = createRegistry();
    let zipCalls = 0;
    reg.install(mk('fake', ['txt'], {
      sniff: () => { zipCalls++; return 'archive'; }
    }));
    let archiveCalls = 0;
    let archiveRendered = false;
    reg.install(mk('archive', ['zip'], {
      // 二次 sniff 返回已注册的 'text'：若派发器错误地二次改派，rendererId 会漂到 text——
      // 该用例钉住「第二次 sniff 可解析但不改派」（M1 deferred minor）
      sniff: () => { archiveCalls++; return 'text'; },
      render: async () => { archiveRendered = true; return { destroy() {} }; }
    }));
    let textRendered = false;
    reg.install(mk('text', ['log'], {
      render: async () => { textRendered = true; return { destroy() {} }; }
    }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(
      source('a.txt'), new TextEncoder().encode('hi'), target);
    expect(rendererId).toBe('archive');
    expect(archiveRendered).toBe(true);
    expect(textRendered).toBe(false);
    expect(zipCalls).toBe(1);
    // 恰一次：redirect 后为最终 renderer 补充 sniff 元数据的调用，返回值被忽略
    expect(archiveCalls).toBe(1);
  });
  it('falls back to error renderer for unknown ext', async () => {
    const reg = createRegistry();
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(
      source('x.unknownext'), new Uint8Array([1,2,3]), target);
    expect(rendererId).toBe('error');
    expect(target.textContent).toContain('unknownext');
  });
  it('falls back to error renderer when render throws', async () => {
    const reg = createRegistry();
    reg.install(mk('boom', ['txt'], { render: async () => { throw new Error('boom'); } }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(
      source('a.txt'), new TextEncoder().encode('hi'), target);
    expect(rendererId).toBe('error');
    expect(target.textContent).toContain('boom');
  });
});

describe('dispatcher magic 预检改派（BUG-13/BUG-01.3）', () => {
  it('.ts 扩展名 + mpegts 签名 → 改派 av 渲染器（det.ext 纠偏为 ts）', async () => {
    const reg = createRegistry();
    let codeRendered = false;
    let avRendered = false;
    let seenDet: { ext?: string } | undefined;
    reg.install(mk('code', ['ts'], { render: async () => { codeRendered = true; return { destroy() {} }; } }));
    reg.install(mk('av', ['m3u8'], {
      render: async (_b, _t, _s, det) => { avRendered = true; seenDet = det; return { destroy() {} }; }
    }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(source('video.ts'), MPEGTS, target);
    expect(rendererId).toBe('av');
    expect(avRendered).toBe(true);
    expect(codeRendered).toBe(false);
    expect(seenDet?.ext).toBe('ts');
  });
  it('.txt + zip 签名 → 改派 archive（正向正向样本，zip-as-txt 场景）', async () => {
    const reg = createRegistry();
    let archiveRendered = false;
    reg.install(mk('code', ['txt']));
    reg.install(mk('archive', ['zip'], { render: async () => { archiveRendered = true; return { destroy() {} }; } }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(source('zip-as-txt.txt'), PK, target);
    expect(rendererId).toBe('archive');
    expect(archiveRendered).toBe(true);
  });
  it('.txt + pdf 签名 → 改派 pdf 且只改派一次（预检不重复触发；最终 renderer 仍补一次 sniff 元数据）', async () => {
    const reg = createRegistry();
    let pdfCalls = 0;
    let codeRendered = false;
    reg.install(mk('code', ['txt'], { render: async () => { codeRendered = true; return { destroy() {} }; } }));
    reg.install(mk('pdf', ['pdf'], { sniff: () => { pdfCalls++; return null; } }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(source('doc.txt'), PDF, target);
    expect(rendererId).toBe('pdf');
    expect(pdfCalls).toBe(1); // 预检改派后为最终 renderer 补充 sniff 元数据一次，预检本身不再触发
    expect(codeRendered).toBe(false);
  });
  it('.zip 扩展名 + png 签名 → 不改派（非文本类渲染器不参与，archive 自身错误兜底）', async () => {
    const reg = createRegistry();
    let imageRendered = false;
    let archiveRendered = false;
    reg.install(mk('image', ['png'], { render: async () => { imageRendered = true; return { destroy() {} }; } }));
    reg.install(mk('archive', ['zip'], { render: async () => { archiveRendered = true; return { destroy() {} }; } }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(source('fake.zip'), PNG, target);
    expect(rendererId).toBe('archive');
    expect(archiveRendered).toBe(true);
    expect(imageRendered).toBe(false);
  });
  it('ole 签名无改派路由（.txt + ole → code 保持）', async () => {
    const reg = createRegistry();
    let codeRendered = false;
    reg.install(mk('code', ['txt'], { render: async () => { codeRendered = true; return { destroy() {} }; } }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(
      source('a.txt'),
      new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), target);
    expect(rendererId).toBe('code');
    expect(codeRendered).toBe(true);
  });
  it('signatureRouteOf：ole 无路由、mpegts → av+ts', () => {
    expect(signatureRouteOf('ole')).toBeNull();
    expect(signatureRouteOf('mpegts')).toEqual({ rendererId: 'av', ext: 'ts' });
    expect(signatureRouteOf(null)).toBeNull();
  });
});

describe('dispatcher 无扩展名回退链（BUG-07）', () => {
  it('shebang 文本 → code 渲染器 + det.lang/det.extless 写入', async () => {
    const reg = createRegistry();
    let seenDet: { lang?: string; extless?: boolean } | undefined;
    reg.install(mk('code', ['txt'], {
      render: async (_b, _t, _s, det) => { seenDet = det; return { destroy() {} }; }
    }));
    const target = document.createElement('div');
    const { rendererId, det } = await createDispatcher(reg).dispatch(
      source('shebang-py'), new TextEncoder().encode('#!/usr/bin/env python3\nprint(1)\n'), target);
    expect(rendererId).toBe('code');
    expect(seenDet?.lang).toBe('python');
    expect(seenDet?.extless).toBe(true);
    expect(det.lang).toBe('python');
  });
  it('非 shebang 文本（Makefile）→ code 渲染器、lang 为空', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    const target = document.createElement('div');
    const { rendererId, det } = await createDispatcher(reg).dispatch(
      source('Makefile'), new TextEncoder().encode('all:\n\techo hi\n'), target);
    expect(rendererId).toBe('code');
    expect(det.lang).toBeUndefined();
    expect(det.extless).toBe(true);
  });
  it('无扩展名 + zip 签名 → 直进 archive（det.ext 纠偏）', async () => {
    const reg = createRegistry();
    let archiveRendered = false;
    reg.install(mk('archive', ['zip'], { render: async () => { archiveRendered = true; return { destroy() {} }; } }));
    const target = document.createElement('div');
    const { det } = await createDispatcher(reg).dispatch(source('bundle'), PK, target);
    expect(archiveRendered).toBe(true);
    expect(det.ext).toBe('zip');
    expect(det.extless).toBeUndefined(); // 签名改派不算 extless 文本回退
  });
  it('无扩展名 + mpegts 签名 → av（ext 纠偏为 ts，media 分派不落 audio 分支）', async () => {
    const reg = createRegistry();
    let seenDet: { ext?: string } | undefined;
    reg.install(mk('av', ['m3u8'], { render: async (_b, _t, _s, det) => { seenDet = det; return { destroy() {} }; } }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(source('stream'), MPEGTS, target);
    expect(rendererId).toBe('av');
    expect(seenDet?.ext).toBe('ts');
  });
  it('真二进制无扩展名 → 错误卡片，文案特化且无 `""` 字样', async () => {
    const reg = createRegistry();
    const target = document.createElement('div');
    const { rendererId, det } = await createDispatcher(reg).dispatch(
      source('blob'), new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x00]), target);
    expect(rendererId).toBe('error');
    expect(det.ext).toBe('');
    expect(target.textContent).toContain('无扩展名且无法识别内容');
    expect(target.textContent).not.toContain('""');
  });
  it('真二进制无扩展名 + hex 已注册 → hex 兜底，reclassifiedFrom 不置位（原生 extless 不算改派）', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    reg.install(mk('hex', []));
    const target = document.createElement('div');
    // 上一用例 registry 为空走「皆不命中」错误卡片；本例钉住 C 项 hex 兜底后的新行为：
    // extless 二进制 → hex（非 error），且原生无扩展名不改写 reclassifiedFrom
    const { rendererId, det } = await createDispatcher(reg).dispatch(
      source('blob'), new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x00]), target);
    expect(rendererId).toBe('hex');
    expect(det.reclassifiedFrom).toBeUndefined();
  });
});

describe('dispatcher 错误卡片 actions（BUG-14）', () => {
  it('render 失败的卡片带「重试」「以纯文本打开」「以 hex 打开」按钮；重试成功即恢复渲染且新实例被级联托管', async () => {
    const reg = createRegistry();
    let attempts = 0;
    const retryDestroyed = vi.fn();
    reg.install(mk('flaky', ['txt'], {
      render: async (_b, t) => {
        attempts++;
        if (attempts === 1) throw new Error('boom');
        t.replaceChildren('rendered'); // 模拟真实渲染器挂载内容
        return { destroy: retryDestroyed };
      }
    }));
    reg.install(mk('hex', ['bin']));
    const target = document.createElement('div');
    document.body.append(target);
    const { instance: cardInstance, rendererId } = await createDispatcher(reg).dispatch(
      source('a.txt'), new TextEncoder().encode('hi'), target);
    expect(rendererId).toBe('error');
    const buttons = [...target.querySelectorAll<HTMLButtonElement>('button.vv-error-action')];
    // 「降级查看」已更名「以 hex 打开」（C 项 open-as）；registry 无 code 渲染器 → 无文本按钮
    expect(buttons.map((b) => b.textContent)).toEqual(['重试', '以 hex 打开']);
    buttons[0]!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(2);
    // 重试成功后卡片被渲染实例替换（无按钮残留）
    expect(target.querySelector('.vv-error-card')).toBeNull();
    expect(target.textContent).toContain('rendered');
    // 级联托管：销毁 dispatch 返回的卡片实例（调用方持有的 live）→ 重试产出的新实例被释放
    cardInstance.destroy();
    expect(retryDestroyed).toHaveBeenCalledTimes(1);
    target.remove();
  });

  it('「以 hex 打开」（override 重入 dispatch）成功的 hex 实例同样被级联托管', async () => {
    const reg = createRegistry();
    reg.install(mk('boom', ['txt'], { render: async () => { throw new Error('boom'); } }));
    const hexDestroyed = vi.fn();
    reg.install(mk('hex', ['bin'], {
      render: async (_b, t) => {
        t.replaceChildren('hexdump');
        return { destroy: hexDestroyed };
      }
    }));
    const target = document.createElement('div');
    document.body.append(target);
    const { instance: cardInstance } = await createDispatcher(reg).dispatch(
      source('a.txt'), new TextEncoder().encode('hi'), target);
    const buttons = [...target.querySelectorAll<HTMLButtonElement>('button.vv-error-action')];
    expect(buttons.map((b) => b.textContent)).toEqual(['重试', '以 hex 打开']);
    buttons[1]!.click(); // 以 hex 打开 = rendererOverride 重入 dispatch（不再直调 hex.render）
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); }); // 重入链路跨多个微任务，宏任务边界冲刷
    expect(target.textContent).toContain('hexdump');
    cardInstance.destroy();
    expect(hexDestroyed).toHaveBeenCalledTimes(1);
    target.remove();
  });
  it('重试仍失败保留错误详情；registry 无 hex 时无降级按钮', async () => {
    const reg = createRegistry();
    reg.install(mk('boom', ['txt'], { render: async () => { throw new Error('boom'); } }));
    const target = document.createElement('div');
    document.body.append(target);
    await createDispatcher(reg).dispatch(source('a.txt'), new TextEncoder().encode('hi'), target);
    const buttons = [...target.querySelectorAll<HTMLButtonElement>('button.vv-error-action')];
    expect(buttons.map((b) => b.textContent)).toEqual(['重试']); // 无 hex 渲染器 → 无降级按钮
    buttons[0]!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(target.querySelector('.vv-error-detail')?.textContent).toBe('boom');
    expect([...target.querySelectorAll('button.vv-error-action')]).toHaveLength(1); // 按钮随卡片重建
    target.remove();
  });
  it('选路失败（未知扩展名）无重试按钮', async () => {
    const reg = createRegistry();
    const target = document.createElement('div');
    document.body.append(target);
    await createDispatcher(reg).dispatch(source('x.unknownext'), new Uint8Array([1]), target);
    expect(target.querySelectorAll('button.vv-error-action')).toHaveLength(0);
    target.remove();
  });
});

describe('unknown-extension probe chain (C 项)', () => {
  it('routes .foo PNG by signature to image', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    reg.install(mk('image', ['png']));
    reg.install(mk('hex', []));
    const d = createDispatcher(reg);
    const target = document.createElement('div');
    const { rendererId, det } = await d.dispatch(source('x.foo'), PNG, target);
    expect(rendererId).toBe('image');
    expect(det.reclassifiedFrom).toBe('foo');
  });

  it('routes .foo binary to hex and marks reclassified', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    reg.install(mk('hex', []));
    const d = createDispatcher(reg);
    const bin = new Uint8Array([0x00, 0x01, 0x02, 0xde, 0xad, 0xbe, 0xef, 0x00]);
    const { rendererId, det } = await d.dispatch(source('y.foo'), bin, document.createElement('div'));
    expect(rendererId).toBe('hex');
    expect(det.reclassifiedFrom).toBe('foo');
  });

  it('routes .foo textual content to code without extless flag', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    reg.install(mk('hex', []));
    const d = createDispatcher(reg);
    const text = new TextEncoder().encode('plain text\n');
    const { rendererId, det } = await d.dispatch(source('z.foo'), text, document.createElement('div'));
    expect(rendererId).toBe('code');
    expect(det.extless).toBeFalsy();
    expect(det.reclassifiedFrom).toBe('foo');
  });

  it('keeps extless flag only for extensionless files', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    reg.install(mk('hex', []));
    const d = createDispatcher(reg);
    const text = new TextEncoder().encode('#!/bin/sh\necho hi\n');
    const { det } = await d.dispatch(source('Makefile'), text, document.createElement('div'));
    expect(det.extless).toBe(true);               // 既有语义保持
    expect(det.reclassifiedFrom).toBeUndefined(); // 原生无扩展名不算改派
  });
});

describe('error card open-as actions (C 项)', () => {
  function failing(id: string, exts: string[]): Renderer {
    return { id, label: id, extensions: exts, render: async () => { throw new Error('boom'); } };
  }

  it('offers retry + open-as-text/hex on render failure, text first for textual det', async () => {
    const reg = createRegistry();
    reg.install(failing('code', ['txt']));
    reg.install(mk('hex', []));
    const d = createDispatcher(reg);
    const target = document.createElement('div');
    const text = new TextEncoder().encode('hello\n');
    await d.dispatch(source('a.txt'), text, target);
    const labels = [...target.querySelectorAll('.vv-error-action')].map(b => b.textContent);
    expect(labels).toEqual(['重试', '以纯文本打开', '以 hex 打开']);
  });

  it('hex failure offers only open-as-text (no duplicate hex)', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    const hexFailing = failing('hex', []);
    reg.install(hexFailing);
    const d = createDispatcher(reg);
    const target = document.createElement('div');
    const bin = new Uint8Array([0, 1, 2, 3, 0, 0, 0, 0]);
    await d.dispatch(source('b.foo'), bin, target);
    const labels = [...target.querySelectorAll('.vv-error-action')].map(b => b.textContent);
    // 当前 renderer 即 hex：不重复给「以 hex 打开」（重试保留，BUG-14 语义不变）
    expect(labels).toEqual(['重试', '以纯文本打开']);
  });

  it('routing failure still offers open-as actions', async () => {
    const reg = createRegistry();
    reg.install(failing('hex', [])); // 仅 hex 且失败 → 选路探到 hex → 走失败路径
    const d = createDispatcher(reg);
    const target = document.createElement('div');
    await d.dispatch(source('c.foo'), new Uint8Array([0, 1, 2, 3, 4, 5, 6, 0]), target);
    expect(target.querySelector('.vv-error-card')).toBeTruthy();
  });

  it('true routing failure (no renderer resolved) offers open-as-text only when hex absent', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt'])); // 有 code、无 hex：二进制内容探测链走不到底 → 选路失败
    const d = createDispatcher(reg);
    const target = document.createElement('div');
    const { rendererId } = await d.dispatch(
      source('blob.foo'), new Uint8Array([0, 1, 2, 3, 4, 5, 6, 0]), target,
    );
    expect(rendererId).toBe('error');
    const labels = [...target.querySelectorAll('.vv-error-action')].map(b => b.textContent);
    expect(labels).toEqual(['以纯文本打开']); // 无重试；hex 缺失只给文本
  });
});

describe('dispatch rendererOverride (C 项)', () => {
  it('forces the chosen renderer and skips BUG-13 magic precheck', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt']));
    reg.install(mk('image', ['png']));
    const d = createDispatcher(reg);
    // .png + PNG 字节本该走 image；override=code 强制文本且不被 magic 预检改派
    const { rendererId } = await d.dispatch(
      source('real.png'), PNG, document.createElement('div'), { rendererOverride: 'code' },
    );
    expect(rendererId).toBe('code');
  });

  it('falls back to normal routing when override id is unknown', async () => {
    const reg = createRegistry();
    reg.install(mk('image', ['png']));
    const d = createDispatcher(reg);
    const { rendererId } = await d.dispatch(
      source('real.png'), PNG, document.createElement('div'), { rendererOverride: 'ghost' },
    );
    expect(rendererId).toBe('image');
  });
});

describe('dispatch 读下沉（io-streaming §3：streaming 选路 + StreamCtx 构造 + 兼容路径）', () => {
  /** 构造 dispatch 级 read 闭包（区间语义 end 含；无 range = 全量），记录每次调用的 range */
  function readOf(content: Uint8Array<ArrayBuffer>, calls: Array<{ start: number; end: number } | undefined>) {
    return async (range?: { start: number; end: number }): Promise<Uint8Array<ArrayBuffer>> => {
      calls.push(range);
      return range ? content.slice(range.start, range.end + 1) : content;
    };
  }
  /** 最小 TreeStore 替身：dispatch 不经 store.read（全量读已下沉为 opts.read 闭包），只消费 rangeCapable */
  function fakeStore(rangeCapable?: boolean): TreeStore {
    return {
      id: 'fake',
      displayName: () => 'fake',
      listChildren: async () => [],
      read: async () => new Uint8Array(0),
      rangeCapable
    };
  }
  function srcWith(
    name: string,
    store: TreeStore,
    size?: number | null
  ): Parameters<ReturnType<typeof createDispatcher>['dispatch']>[0] {
    return { storeId: 's', storeLabel: 's', path: name, name, store, size };
  }

  it('① streaming + rangeCapable：render 收 8KB head 而非全量，第 5 参 ctx 带 size 与区间 read', async () => {
    const reg = createRegistry();
    const BIG = Uint8Array.from({ length: 2_000_000 }, (_, i) => i & 0xff); // > FULL_LIMIT(1MB)
    const calls: Array<{ start: number; end: number } | undefined> = [];
    const read = readOf(BIG, calls);
    let seenBuf: Uint8Array | undefined;
    let seenCtx: StreamCtx | undefined;
    reg.install(mk('st', ['stx'], {
      streaming: true,
      render: async (buffer, _t, _s, _det, ctx) => { seenBuf = buffer; seenCtx = ctx; return { destroy() {} }; }
    }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(
      srcWith('a.stx', fakeStore(true), BIG.length), null, target, { read });
    expect(rendererId).toBe('st');
    // 仅一次 head 探测读（0..8191 区间），全量从未被拉取
    expect(calls).toStrictEqual([{ start: 0, end: 8191 }]);
    expect(seenBuf?.length).toBe(8192); // buffer 形参 = head 探测块，不是全量
    expect(seenCtx?.size).toBe(BIG.length); // ctx.size = source.size
    const chunk = await seenCtx!.read({ start: 10, end: 14 }); // 区间 read 经 read 闭包直达 store
    expect([...chunk]).toEqual([...BIG.slice(10, 15)]);
    expect(calls).toStrictEqual([{ start: 0, end: 8191 }, { start: 10, end: 14 }]);
  });

  it('② streaming + !rangeCapable：降级全量 read，ctx.head 为全量、size = 全量长、read 同步切片', async () => {
    const reg = createRegistry();
    const FULL = new TextEncoder().encode('hello world!'); // 12B；source.size 未知
    const calls: Array<{ start: number; end: number } | undefined> = [];
    const read = readOf(FULL, calls);
    let seenBuf: Uint8Array | undefined;
    let seenCtx: StreamCtx | undefined;
    reg.install(mk('st', ['stx'], {
      streaming: true,
      render: async (buffer, _t, _s, _det, ctx) => { seenBuf = buffer; seenCtx = ctx; return { destroy() {} }; }
    }));
    const target = document.createElement('div');
    await createDispatcher(reg).dispatch(srcWith('a.stx', fakeStore()), null, target, { read });
    // 先 head 区间探测、再降级一次全量 read（无 range）
    expect(calls).toStrictEqual([{ start: 0, end: 8191 }, undefined]);
    expect(seenBuf).toEqual(FULL); // buffer 形参 = 全量
    expect(seenCtx?.size).toBe(FULL.length);
    expect(seenCtx?.head).toEqual(FULL);
    const chunk = await seenCtx!.read({ start: 2, end: 5 });
    expect([...chunk]).toEqual([...FULL.slice(2, 6)]);
    expect(chunk.buffer).toBe(FULL.buffer); // 零拷贝：全量底座的切片视图
  });

  it('③ 非 streaming + opts.read：render 收全量（read() 全量被拉取一次）、无 ctx', async () => {
    const reg = createRegistry();
    const FULL = new TextEncoder().encode('hello world!');
    const calls: Array<{ start: number; end: number } | undefined> = [];
    const read = readOf(FULL, calls);
    let seenBuf: Uint8Array | undefined;
    let seenCtx: StreamCtx | undefined;
    reg.install(mk('plain', ['pln'], {
      render: async (buffer, _t, _s, _det, ctx) => { seenBuf = buffer; seenCtx = ctx; return { destroy() {} }; }
    }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(
      srcWith('a.pln', fakeStore(true), FULL.length), null, target, { read });
    expect(rendererId).toBe('plain');
    expect(calls).toStrictEqual([undefined]); // size ≤ 1MB → 一次全量 read，零重复
    expect(seenBuf).toEqual(FULL);
    expect(seenCtx).toBeUndefined(); // 非 streaming 渲染器不接触第 5 参
  });

  it('④ 兼容路径：buffer 直传、无 read——行为与旧逐字节等价（render 收全量、size 不参与）', async () => {
    const reg = createRegistry();
    const text = 'v'.repeat(8999) + '!';
    const full = new TextEncoder().encode(text); // 9000B > HEAD_SIZE：head 切片与全量可区分
    let seenBuf: Uint8Array | undefined;
    reg.install(mk('plain', ['pln'], {
      render: async (buffer) => { seenBuf = buffer; return { destroy() {} }; }
    }));
    const target = document.createElement('div');
    // store.read 一旦被触达即抛错 + 故意矛盾的 size=7：兼容路径以 buffer 为准，不得触碰 store
    const store: TreeStore = {
      id: 'strict', displayName: () => 'strict', listChildren: async () => [],
      read: async () => { throw new Error('compat 路径不得触发 store.read'); }
    };
    const { rendererId, det } = await createDispatcher(reg).dispatch(
      srcWith('a.pln', store, 7), full, target);
    expect(rendererId).toBe('plain');
    expect(seenBuf).toEqual(full); // 全量字节逐字节等价（非 head 切片）
    expect(seenBuf?.length).toBe(9000);
    expect(det.encoding).toBeDefined(); // ≤1MB full 编码精判语义保持
  });

  it('⑤ buffer === null 且无 opts.read → 拒绝，错误信息含 dispatch', async () => {
    const reg = createRegistry();
    reg.install(mk('plain', ['pln']));
    const target = document.createElement('div');
    await expect(
      createDispatcher(reg).dispatch(srcWith('a.pln', fakeStore(true)), null, target)
    ).rejects.toThrow(/dispatch/);
  });

  it('⑥ streaming 渲染器失败卡片 open-as 重入：read 透传，重入后仍走 streaming 路径', async () => {
    const reg = createRegistry();
    const BIG = Uint8Array.from({ length: 2_000_000 }, (_, i) => i & 0xff);
    const calls: Array<{ start: number; end: number } | undefined> = [];
    const read = readOf(BIG, calls);
    reg.install(mk('boom', ['stx'], { streaming: true, render: async () => { throw new Error('boom'); } }));
    let hexBufLen = -1;
    let hexCtx: StreamCtx | undefined;
    reg.install(mk('hex', ['bin'], {
      streaming: true,
      render: async (buffer, _t, _s, _det, ctx) => { hexBufLen = buffer.length; hexCtx = ctx; return { destroy() {} }; }
    }));
    const target = document.createElement('div');
    document.body.append(target);
    const { instance: cardInstance } = await createDispatcher(reg).dispatch(
      srcWith('a.stx', fakeStore(true), BIG.length), null, target, { read });
    const buttons = [...target.querySelectorAll<HTMLButtonElement>('button.vv-error-action')];
    // 头部 0x00… 非文本：open-as 排序 hex 在前（head-only 时以 head 探测替代全量 looksTextual）
    expect(buttons.map((b) => b.textContent)).toEqual(['重试', '以 hex 打开']);
    buttons[1]!.click(); // open-as 重入：redisplay 必须透传 read，否则重入 dispatch 直接拒绝
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); }); // 重入链路跨多个微任务，宏任务边界冲刷
    expect(hexBufLen).toBe(8192); // 重入后仍 streaming：hex 收 head 而非全量
    expect(hexCtx?.size).toBe(BIG.length);
    const chunk = await hexCtx!.read({ start: 0, end: 3 });
    expect([...chunk]).toEqual([0, 1, 2, 3]); // 重入构造的 ctx.read 仍经同一 read 闭包可用
    cardInstance.destroy();
    target.remove();
  });
});
