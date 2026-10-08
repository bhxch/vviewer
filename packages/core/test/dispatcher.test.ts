import { describe, it, expect } from 'vitest';
import { createRegistry } from '../src/registry/registry';
import { createDispatcher, signatureRouteOf } from '../src/dispatch/dispatcher';
import type { Renderer } from '../src/types';

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
});

describe('dispatcher 错误卡片 actions（BUG-14）', () => {
  it('render 失败的卡片带「重试」「降级查看」按钮；重试成功即恢复渲染', async () => {
    const reg = createRegistry();
    let attempts = 0;
    reg.install(mk('flaky', ['txt'], {
      render: async (_b, t) => {
        attempts++;
        if (attempts === 1) throw new Error('boom');
        t.replaceChildren('rendered'); // 模拟真实渲染器挂载内容
        return { destroy() {} };
      }
    }));
    reg.install(mk('hex', ['bin']));
    const target = document.createElement('div');
    document.body.append(target);
    const { rendererId } = await createDispatcher(reg).dispatch(
      source('a.txt'), new TextEncoder().encode('hi'), target);
    expect(rendererId).toBe('error');
    const buttons = [...target.querySelectorAll<HTMLButtonElement>('button.vv-error-action')];
    expect(buttons.map((b) => b.textContent)).toEqual(['重试', '降级查看']);
    buttons[0]!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(2);
    // 重试成功后卡片被渲染实例替换（无按钮残留）
    expect(target.querySelector('.vv-error-card')).toBeNull();
    expect(target.textContent).toContain('rendered');
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
