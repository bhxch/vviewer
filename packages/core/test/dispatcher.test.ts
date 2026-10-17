import { describe, it, expect, vi } from 'vitest';
import { createRegistry } from '../src/registry/registry';
import { createDispatcher, signatureRouteOf } from '../src/dispatch/dispatcher';
import type { Detection, Renderer, StreamCtx, TreeStore } from '../src/types';

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

// ---------- deferred 清偿 Task 5：abort 不上屏 ----------
//
// effect 级取消（ViewerPane effectAbort）使「AbortError 经 render 冒泡 → dispatch
// catch」路径可达：取消 ≠ 渲染失败——catch 识别 abort 错误时必须静默（不落错误卡片
// DOM），返回 no-op 实例交调用方既有 cancelled 面丢弃。

describe('dispatch abort 不上屏（deferred 清偿 Task 5）', () => {
  it('render 抛 DOMException AbortError：不落错误卡片，返回 rendererId=error 的 no-op 实例', async () => {
    const reg = createRegistry();
    reg.install(mk('code', ['txt'], {
      render: async () => { throw new DOMException('读取已取消', 'AbortError'); }
    }));
    const target = document.createElement('div');
    const res = await createDispatcher(reg).dispatch(
      source('a.txt'), new TextEncoder().encode('hi'), target);
    expect(res.rendererId).toBe('error');
    expect(target.querySelector('.vv-error-card'), '取消不得落错误卡片 DOM').toBeNull();
    expect(target.textContent).not.toContain('读取已取消');
    expect(() => res.instance.destroy()).not.toThrow();
  });

  it('Error 且 name=AbortError 同判为取消（code.ts isAbortError 同源口径）；其余 DOMException 照常落卡片', async () => {
    const reg = createRegistry();
    const err = new Error('取消');
    err.name = 'AbortError';
    reg.install(mk('code', ['txt'], { render: async () => { throw err; } }));
    const targetA = document.createElement('div');
    const resA = await createDispatcher(reg).dispatch(
      source('a.txt'), new TextEncoder().encode('hi'), targetA);
    expect(resA.rendererId).toBe('error');
    expect(targetA.querySelector('.vv-error-card')).toBeNull();

    const reg2 = createRegistry();
    reg2.install(mk('code', ['txt'], {
      render: async () => { throw new DOMException('boom', 'DataCloneError'); }
    }));
    const targetB = document.createElement('div');
    const resB = await createDispatcher(reg2).dispatch(
      source('a.txt'), new TextEncoder().encode('hi'), targetB);
    expect(resB.rendererId).toBe('error');
    expect(targetB.querySelector('.vv-error-card'), '非 abort 错误照常落错误卡片').not.toBeNull();
  });
});

// 错误身份与字节映射 Task 2：retry/open-as 的 catch 面接分类层。第二用例是止跌锚
// 而非真 RED——本场景的重入 abort 在 dispatch 主 catch 已被吞为 no-op（dispatch
// resolve，不进 openAsAction 的 catch），现状下也应绿；过滤器防的是 try 块外策略读/
// 未来路径的裸 AbortError reject。保留为防回归锚。

describe('dispatch retry/open-as 的 abort 过滤（错误身份与字节映射 Task 2）', () => {
  it('重试被取消：不重画卡片、原卡保留在屏', async () => {
    const reg = createRegistry();
    let calls = 0;
    reg.install(mk('code', ['txt'], {
      render: async () => {
        calls += 1;
        if (calls === 1) throw new Error('首次渲染失败');
        throw new DOMException('读取已取消', 'AbortError');
      }
    }));
    const target = document.createElement('div');
    await createDispatcher(reg).dispatch(source('a.txt'), new TextEncoder().encode('hi'), target);
    expect(target.querySelector('.vv-error-card'), '前置：首次失败已落卡').not.toBeNull();
    const retryBtn = [...target.querySelectorAll<HTMLButtonElement>('.vv-error-action')]
      .find((b) => b.textContent === '重试');
    expect(retryBtn, '前置：卡片含重试按钮').toBeDefined();
    retryBtn!.click();
    await vi.waitFor(() => expect(calls).toBe(2));
    // 重试失败链跨多个微任务（render reject → .catch → showErrorCard 重画），宏任务
    // 边界冲刷后再断言：calls 同步递增会让 waitFor 在重画前放行，钉不住行为
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(target.textContent, '取消文案不得上屏').not.toContain('读取已取消');
    expect(target.querySelector('.vv-error-card'), '原卡保留（不重画也不清空）').not.toBeNull();
  });

  it('open-as 重入被取消：不 console.error 留痕', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reg = createRegistry();
    let calls = 0;
    reg.install(mk('code', ['txt'], {
      render: async () => {
        calls += 1;
        if (calls === 1) throw new Error('首次渲染失败');
        throw new DOMException('读取已取消', 'AbortError');
      }
    }));
    const target = document.createElement('div');
    await createDispatcher(reg).dispatch(source('a.txt'), new TextEncoder().encode('hi'), target);
    const openAsBtn = [...target.querySelectorAll<HTMLButtonElement>('.vv-error-action')]
      .find((b) => b.textContent === '以纯文本打开');
    expect(openAsBtn, '前置：卡片含以纯文本打开按钮').toBeDefined();
    openAsBtn!.click();
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    // 重入链跨多个微任务，宏任务边界冲刷后再断言：确保若 console.error 会发生，必已
    // 发生在断言前（缺席断言必须等链路沉降，否则锚不住回归）
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(errSpy).not.toHaveBeenCalledWith('[vviewer] open-as 重入失败', expect.anything());
    errSpy.mockRestore();
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

  // 计划 1 遗留②：① 的互补分支——size ≤ FULL_LIMIT(1MB) 时读策略先行全量直读
  //（无 head 探测），capable 分支不再补任何读：渲染前恰一次读，base/ctx.head 均为全量。
  it('①b streaming + capable + size≤1MB：全量直读恰一次，ctx.head=全量、ctx.size=size，渲染前零额外读', async () => {
    const reg = createRegistry();
    const FULL = new TextEncoder().encode('hello jsonl!'); // 12B ≤ FULL_LIMIT
    const calls: Array<{ start: number; end: number } | undefined> = [];
    const read = readOf(FULL, calls);
    let seenBuf: Uint8Array | undefined;
    let seenCtx: StreamCtx | undefined;
    let callsAtRender = -1;
    reg.install(mk('st', ['stx'], {
      streaming: true,
      render: async (buffer, _t, _s, _det, ctx) => {
        seenBuf = buffer;
        seenCtx = ctx;
        callsAtRender = calls.length;
        return { destroy() {} };
      }
    }));
    const target = document.createElement('div');
    const { rendererId } = await createDispatcher(reg).dispatch(
      srcWith('a.stx', fakeStore(true), FULL.length), null, target, { read });
    expect(rendererId).toBe('st');
    expect(calls).toStrictEqual([undefined]); // size≤1MB 策略直读全量：无 head 探测区间读
    expect(callsAtRender).toBe(1); // 渲染前零额外读（capable 分支不触发降级补读）
    expect(seenBuf).toEqual(FULL); // buffer 形参 = 全量（非 head 探测块）
    expect(seenCtx?.size).toBe(FULL.length); // ctx.size = source.size 透传
    expect(seenCtx?.head).toEqual(FULL); // capable 分支 probe 即全量 → ctx.head = 全量
    const chunk = await seenCtx!.read({ start: 2, end: 5 }); // 按需区间读仍经 read 闭包
    expect([...chunk]).toEqual([...FULL.slice(2, 6)]);
    expect(calls).toStrictEqual([undefined, { start: 2, end: 5 }]);
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

  // ⑥ 的钉力补强（终审遗留清偿）：⑥ 未注册 'code' 渲染器，「以纯文本打开」按钮无论
  // looksTextual 真假都不出现，排序断言恒真、钉不住「head-only 退化：open-as 排序以
  // 8KB head 探测块裁决 looksTextual（buildRenderErrorActions catch 分支，full ?? probe
  // 退化为 probe）」。本组变体补注册 code 渲染器两向钉死排序；probe 均只经 8KB head
  // 探测（size>1MB 不预取全量），即排序判据确为 head 探测块而非全量。
  // 注意：非文本 probe 不能用全 0xFF——looksTextual 只计 NUL/<0x20 控制符/0x7f 为嫌，
  // 0xFF 不计嫌（判文本）；含 0x00 的循环模式字节（i & 0xff）才判非文本。
  it('⑥a 失败卡片 open-as 排序（code 已注册）：head 探测块非文本 → hex 在前', async () => {
    const reg = createRegistry();
    const BIG = Uint8Array.from({ length: 2_000_000 }, (_, i) => i & 0xff); // 含 0x00 → 非文本
    const calls: Array<{ start: number; end: number } | undefined> = [];
    const read = readOf(BIG, calls);
    reg.install(mk('boom', ['stx'], { streaming: true, render: async () => { throw new Error('boom'); } }));
    reg.install(mk('code', ['txt']));
    reg.install(mk('hex', ['bin']));
    const target = document.createElement('div');
    await createDispatcher(reg).dispatch(
      srcWith('a.stx', fakeStore(true), BIG.length), null, target, { read });
    expect(calls).toStrictEqual([{ start: 0, end: 8191 }]); // 仅 head 探测：排序判据 = 探测块
    const buttons = [...target.querySelectorAll<HTMLButtonElement>('button.vv-error-action')];
    expect(buttons.map((b) => b.textContent)).toEqual(['重试', '以 hex 打开', '以纯文本打开']);
  });

  it('⑥b 失败卡片 open-as 排序（code 已注册）：head 探测块为文本 → 纯文本在前', async () => {
    const reg = createRegistry();
    const BIG = new TextEncoder().encode(('x'.repeat(127) + '\n').repeat(16_000)); // ≈2MB 文本
    const calls: Array<{ start: number; end: number } | undefined> = [];
    const read = readOf(BIG, calls);
    reg.install(mk('boom', ['stx'], { streaming: true, render: async () => { throw new Error('boom'); } }));
    reg.install(mk('code', ['txt']));
    reg.install(mk('hex', ['bin']));
    const target = document.createElement('div');
    await createDispatcher(reg).dispatch(
      srcWith('a.stx', fakeStore(true), BIG.length), null, target, { read });
    expect(calls).toStrictEqual([{ start: 0, end: 8191 }]);
    const buttons = [...target.querySelectorAll<HTMLButtonElement>('button.vv-error-action')];
    expect(buttons.map((b) => b.textContent)).toEqual(['重试', '以纯文本打开', '以 hex 打开']);
  });

  // 读失败 ≠ 渲染失败（T3 评审活面）：延迟全量读在选路 try 内，失败若落错误卡片，
  // 「重试」会以 8KB head 探测块当完整文件静默截断渲染——必须向上 reject，不落卡片。
  describe('读失败向上 reject（不落渲染错误卡片）', () => {
    /** head 探测（8KB 区间）成功、全量读失败的 read 闭包（模拟盘故障/句柄失效） */
    function headOkFullFails(message: string) {
      return async (range?: { start: number; end: number }): Promise<Uint8Array<ArrayBuffer>> => {
        if (range) return new Uint8Array(range.end - range.start + 1);
        throw new Error(message);
      };
    }

    it('⑦ 非 streaming + size 未知：延迟全量读失败 → dispatch reject，render 不执行、target 无卡片', async () => {
      const reg = createRegistry();
      let rendered = false;
      reg.install(mk('plain', ['pln'], { render: async () => { rendered = true; return { destroy() {} }; } }));
      const target = document.createElement('div');
      document.body.append(target);
      await expect(
        createDispatcher(reg).dispatch(
          srcWith('a.pln', fakeStore(true), null), null, target, { read: headOkFullFails('disk error') })
      ).rejects.toThrow('disk error');
      expect(rendered).toBe(false); // 全量从未到手：不得以 8KB head 截断渲染
      expect(target.querySelector('.vv-error-card')).toBeNull(); // 不落渲染错误卡片（无重试通道）
      target.remove();
    });

    it('⑧ streaming + !rangeCapable：降级全量读失败 → dispatch reject，render 不执行', async () => {
      const reg = createRegistry();
      let rendered = false;
      reg.install(mk('st', ['stx'], {
        streaming: true,
        render: async () => { rendered = true; return { destroy() {} }; }
      }));
      const target = document.createElement('div');
      await expect(
        createDispatcher(reg).dispatch(
          srcWith('a.stx', fakeStore(), null), null, target, { read: headOkFullFails('io gone') })
      ).rejects.toThrow('io gone');
      expect(rendered).toBe(false);
      expect(target.querySelector('.vv-error-card')).toBeNull(); // 不落渲染错误卡片（⑦ 同口径补齐）
    });

    it('⑨ 策略读失败（size ≤ 1MB 首次全量即失败）→ dispatch reject（try 外路径同语义）', async () => {
      const reg = createRegistry();
      let rendered = false;
      reg.install(mk('plain', ['pln'], { render: async () => { rendered = true; return { destroy() {} }; } }));
      const target = document.createElement('div');
      await expect(
        createDispatcher(reg).dispatch(
          srcWith('a.pln', fakeStore(true), 100), null, target, { read: headOkFullFails('gone') })
      ).rejects.toThrow('gone');
      expect(rendered).toBe(false);
      expect(target.querySelector('.vv-error-card')).toBeNull(); // 不落渲染错误卡片（⑦ 同口径补齐）
    });

    // Task 5 评审指令①：渲染期 ctx.read 失败与 Task 4 同口径——dispatcher 侧标记
    // DispatchReadError 向上直抛，不落「错误卡片 + 8KB probe 重试」的截断活面
    it('⑩ 渲染期 ctx.read 失败 → dispatch reject，target 无错误卡片（无重试通道）', async () => {
      const reg = createRegistry();
      const BIG = Uint8Array.from({ length: 2_000_000 }, (_, i) => i & 0xff);
      const read = async (range?: { start: number; end: number }): Promise<Uint8Array<ArrayBuffer>> => {
        if (range && !(range.start === 0 && range.end === 8191)) throw new Error('range io gone');
        return range ? BIG.slice(0, 8192) : BIG;
      };
      let rendered = false;
      reg.install(mk('st', ['stx'], {
        streaming: true,
        render: async (_b, _t, _s, _det, ctx) => {
          await ctx!.read({ start: 65536, end: 65536 }); // 渲染期按需读失败
          rendered = true;
          return { destroy() {} };
        }
      }));
      const target = document.createElement('div');
      document.body.append(target);
      await expect(
        createDispatcher(reg).dispatch(srcWith('a.stx', fakeStore(true), BIG.length), null, target, { read })
      ).rejects.toThrow('range io gone');
      expect(rendered).toBe(false); // await 的按需读失败即失败，渲染未完成
      expect(target.querySelector('.vv-error-card')).toBeNull(); // 不落渲染错误卡片
      target.remove();
    });

    // Task 5 评审指令②：streaming 渲染器失败卡片的「重试」须透传 ctx 重跑 render
    //（字节经 ctx.read 重读），不得以裸 probe、无第 5 参重跑（必次次失败）
    it('⑪ streaming 渲染器重试收到 ctx（第 5 参）而非裸 probe，字节经 ctx.read 重读可用', async () => {
      const reg = createRegistry();
      const BIG = Uint8Array.from({ length: 2_000_000 }, (_, i) => i & 0xff);
      const calls: Array<{ start: number; end: number } | undefined> = [];
      const read = readOf(BIG, calls);
      let attempts = 0;
      let retryBufLen = -1;
      let retryCtx: StreamCtx | undefined;
      reg.install(mk('flaky', ['stx'], {
        streaming: true,
        render: async (buffer, t, _s, _det, ctx) => {
          attempts++;
          if (attempts === 1) throw new Error('render boom');
          retryBufLen = buffer.length;
          retryCtx = ctx;
          t.replaceChildren('retried'); // 模拟真实渲染器挂载内容（替换错误卡片）
          return { destroy() {} };
        }
      }));
      const target = document.createElement('div');
      document.body.append(target);
      const { instance: cardInstance } = await createDispatcher(reg).dispatch(
        srcWith('a.stx', fakeStore(true), BIG.length), null, target, { read });
      const buttons = [...target.querySelectorAll<HTMLButtonElement>('button.vv-error-action')];
      expect(buttons[0]!.textContent).toBe('重试');
      buttons[0]!.click();
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); }); // 重试链路跨微任务，宏任务边界冲刷
      expect(attempts).toBe(2);
      expect(retryBufLen).toBe(8192); // buffer = head 探测块（streaming 交付形态不变）
      expect(retryCtx).toBeDefined(); // 收到 ctx 而非裸 probe——重试以 ctx.read 重读取数
      expect(retryCtx!.size).toBe(BIG.length);
      const chunk = await retryCtx!.read({ start: 0, end: 3 });
      expect([...chunk]).toEqual([0, 1, 2, 3]); // 重试后的 ctx.read 仍可用（经同一 read 闭包）
      expect(target.querySelector('.vv-error-card')).toBeNull(); // 重试成功，卡片被实例替换
      expect(target.textContent).toContain('retried');
      cardInstance.destroy();
      target.remove();
    });
  });

  // 终审 F2：headOnly（size 未知）时 det 仅以 8KB head 短样本判编码——旧「≤1MB
  // full 精判」退化面。全量到手后须重算再 render，否则非 streaming 渲染器以退化
  // det 渲染（潜在 mojibake）。head 口径下本用例 encoding 必为 gb18030（head 只含
  // 截断多字节序列前 2 字节），断言 utf-8 即证明 detect 收到了 full（非 undefined）。
  it('⑫ size 未知 + 非 streaming：全量到手后重算编码——head 截断多字节误判 gb18030 恢复 full 精判 utf-8', async () => {
    const reg = createRegistry();
    // 4 字节 UTF-8 序列横跨 8KB 探测边界：head 截断 → gb18030；全量完整 → utf-8。
    // 2MB 全量 > FULL_LIMIT：钉住重算不做 1MB 钳制、full 参数恒传
    const FULL = new Uint8Array(2_000_000).fill(0x41);
    FULL.set([0xf0, 0x9f, 0x98, 0x80], 8190);
    const calls: Array<{ start: number; end: number } | undefined> = [];
    const read = readOf(FULL, calls);
    let seenDet: Detection | undefined;
    reg.install(mk('plain', ['pln'], {
      render: async (_b, _t, _s, det) => { seenDet = det; return { destroy() {} }; }
    }));
    const target = document.createElement('div');
    const { det } = await createDispatcher(reg).dispatch(
      srcWith('a.pln', fakeStore(true), null), null, target, { read });
    expect(calls).toStrictEqual([{ start: 0, end: 8191 }, undefined]); // head 探测 + 延迟全量（读策略不变）
    expect(seenDet?.encoding).toBe('utf-8'); // full 精判抵达 render（head 口径为 gb18030）
    expect(det.encoding).toBe('utf-8');
    expect(det.binary).toBe(false); // encoding 翻转连带派生 binary 同步（gb18030 判二进制 → utf-8 不判）
  });

  // T4 评审指令：⑫ 的 streaming 分支镜像——size 未知 + streaming + !rangeCapable 降级
  // 全量（openUrl 打开 url jsonl 可达路径）。redet 缺失时 head 截断多字节误判 gb18030
  // 直抵 render（jsonl 非 UTF-8 全量回退面误触发/尾部 mojibake）；补 redet 后 full 精判
  // 翻转 utf-8。断言 utf-8 即证明 streaming 降级路径同样以 full 重算了 det。
  it('⑬ size 未知 + streaming + !capable：降级全量到手后同样重算编码——head 截断多字节误判 gb18030 恢复 full 精判 utf-8', async () => {
    const reg = createRegistry();
    // 4 字节 UTF-8 序列横跨 8KB 探测边界：head 截断 → gb18030；全量完整 → utf-8
    const FULL = new Uint8Array(500_000).fill(0x41);
    FULL.set([0xf0, 0x9f, 0x98, 0x80], 8190);
    const calls: Array<{ start: number; end: number } | undefined> = [];
    const read = readOf(FULL, calls);
    let seenDet: Detection | undefined;
    let seenCtx: StreamCtx | undefined;
    reg.install(mk('st', ['stx'], {
      streaming: true,
      render: async (_b, _t, _s, det, ctx) => { seenDet = det; seenCtx = ctx; return { destroy() {} }; }
    }));
    const target = document.createElement('div');
    const { det } = await createDispatcher(reg).dispatch(
      srcWith('a.stx', fakeStore()), null, target, { read }); // fakeStore() 无 rangeCapable → 降级
    expect(calls).toStrictEqual([{ start: 0, end: 8191 }, undefined]); // head 探测 + 降级全量（读策略不变）
    expect(seenDet?.encoding).toBe('utf-8'); // full 精判抵达 streaming render（head 口径为 gb18030）
    expect(det.encoding).toBe('utf-8');
    expect(det.binary).toBe(false); // 派生 binary 同步翻转
    expect(seenCtx?.size).toBe(FULL.length); // 降级 ctx 形态不变：size = 全量长
  });

  // 流式硬化终审 deferred（Task 1 ①）：渲染期 ctx.read 的取消透传——destroy 取消
  //（signal.aborted）时的 reject 是取消而非读失败，真实包装层原样上抛不标
  // DispatchReadError（取消不该被渲染器当读失败处置）；非 abort 的读失败仍标
  // DispatchReadError（对照）。断言经真实包装层：render 收到的第 5 参 ctx.read 即
  // dispatcher 构造的 streaming 渲染期闭包（capable 分支），非测试自造等价物。
  describe('渲染期 ctx.read 取消透传（abort 原样上抛，不标 DispatchReadError）', () => {
    const BIG = Uint8Array.from({ length: 2_000_000 }, (_, i) => i & 0xff);

    /** head 探测（{0,8191}）正常交付、渲染期读（其余区间）挂起的可编程 read 闭包：
     * 挂起 promise 监听 signal abort（以预建 AbortError reject）；非 abort 的读失败
     * 由测试经 rejectInflight 显式注入（对照场景用） */
    function programmableRead() {
      const calls: Array<{ start: number; end: number } | undefined> = [];
      const abortErr = new DOMException('The operation was aborted.', 'AbortError');
      let inflight: ((err: unknown) => void) | null = null;
      const read = (
        range?: { start: number; end: number },
        signal?: AbortSignal
      ): Promise<Uint8Array<ArrayBuffer>> => {
        calls.push(range);
        if (range && !(range.start === 0 && range.end === 8191)) {
          return new Promise((resolve, reject) => {
            inflight = reject;
            signal?.addEventListener('abort', () => reject(abortErr));
          });
        }
        return Promise.resolve(range ? BIG.slice(0, 8192) : BIG);
      };
      return { read, calls, abortErr, rejectInflight: () => inflight! };
    }

    it('⑭ abort：渲染期读挂起中取消 → 渲染器收到 AbortError 原样实例（非 DispatchReadError）', async () => {
      const reg = createRegistry();
      const controller = new AbortController();
      const r = programmableRead();
      let caught: unknown;
      reg.install(mk('t', ['stx'], {
        streaming: true,
        render: async (_b, _tg, _s, _det, ctx) => {
          try {
            await ctx!.read({ start: 8192, end: 8195 }, controller.signal);
          } catch (err) { caught = err; } // 渲染器自行捕获取消（真实渲染器静默收场形态）
          return { destroy() {} };
        }
      }));
      const p = createDispatcher(reg).dispatch(
        srcWith('a.stx', fakeStore(true), BIG.length), null, document.createElement('div'), { read: r.read });
      await vi.waitFor(() => expect(r.calls.length).toBe(2)); // head 探测 + 渲染期读已在飞
      controller.abort();
      const { rendererId } = await p;
      expect(rendererId).toBe('t'); // 取消被渲染器捕获：渲染正常完成，不落错误卡片
      await vi.waitFor(() => expect(caught).toBeDefined());
      expect(caught).toBe(r.abortErr); // 原样实例上抛：包装层未重建/未包装错误
      expect((caught as Error).name).toBe('AbortError'); // 非 DispatchReadError
    });

    it('⑮ 对照：非 abort 的渲染期读失败 → 渲染器收到 DispatchReadError（读失败口径）', async () => {
      const reg = createRegistry();
      const r = programmableRead();
      let caught: unknown;
      reg.install(mk('t', ['stx'], {
        streaming: true,
        render: async (_b, _tg, _s, _det, ctx) => {
          try {
            await ctx!.read({ start: 8192, end: 8195 });
          } catch (err) { caught = err; }
          return { destroy() {} };
        }
      }));
      const p = createDispatcher(reg).dispatch(
        srcWith('a.stx', fakeStore(true), BIG.length), null, document.createElement('div'), { read: r.read });
      await vi.waitFor(() => expect(r.calls.length).toBe(2));
      r.rejectInflight()(new Error('range io gone')); // 非 abort 读失败（无 signal 参与）
      const { rendererId } = await p;
      expect(rendererId).toBe('t');
      await vi.waitFor(() => expect(caught).toBeDefined());
      expect((caught as Error).name).toBe('DispatchReadError'); // 读失败被标记
      expect((caught as Error).message).toBe('range io gone'); // 原错误 message 透传
    });
  });
});
