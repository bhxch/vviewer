import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Detection, FileSource, RenderedInstance, TreeStore } from '@vviewer/core';
import { HighlightCanceledError, type HighlightInterval } from '@vviewer/highlight';
import {
  markdownRenderer,
  fenceToHtml,
  slugifyHeading,
  assignHeadingIds,
  setMarkdownBackend,
  getMarkdownBackend,
  setMarkdownImageResolver,
  getMarkdownImageResolver,
  renderMarkdownBody,
  type MarkdownEngineState
} from '../src/markdown/markdownRenderer';
import { LIGHTBOX_OVERLAY_ID } from '../src/markdown/pipeline';
import { attachHighlightClient, type CodeHighlightClient } from '../src/code';

const SOURCE: FileSource = {
  storeId: 's',
  storeLabel: '样本',
  path: 'demo.md',
  name: 'demo.md',
  store: {
    id: 's',
    displayName: () => '样本',
    listChildren: async () => [],
    read: async () => new Uint8Array()
  }
};

const DET: Detection = { ext: 'md', encoding: 'utf-8' };

async function renderMd(md: string): Promise<{ target: HTMLElement; instance: RenderedInstance }> {
  const target = document.createElement('div');
  const instance = await markdownRenderer.render(new TextEncoder().encode(md), target, SOURCE, DET);
  return { target, instance };
}

/** RenderedInstance 上可选的 getToc（core types 已声明） */
function tocOf(instance: RenderedInstance): { level: number; text: string; id: string }[] {
  if (!instance.getToc) throw new Error('markdownRenderer 实例应提供 getToc');
  return instance.getToc();
}

afterEach(() => {
  attachHighlightClient(null);
  setMarkdownBackend(null);
  setMarkdownImageResolver(null);
  document.body.innerHTML = '';
});

describe('markdownRenderer——渲染与 TOC', () => {
  it('管线全链：heading 落入 target，getToc 按 h1-h4 提取 level/text/id 且 heading 均有 id', async () => {
    const md = '# 标题一\n\n## 标题二\n\n正文\n\n### 标题三\n\n#### 标题四\n';
    const { target, instance } = await renderMd(md);
    expect(target.querySelector('h1')?.textContent).toBe('标题一');
    const toc = tocOf(instance);
    expect(toc.map((t) => [t.level, t.text])).toEqual([
      [1, '标题一'],
      [2, '标题二'],
      [3, '标题三'],
      [4, '标题四']
    ]);
    for (const t of toc) {
      expect(t.id).not.toBe('');
      expect(target.querySelector(`[id="${t.id}"]`)).not.toBeNull();
    }
  });

  it('无 id 的 heading 生成 slug id；重复标题唯一化；既有 id 保留', async () => {
    const md = [
      '# Hello World!',
      '',
      '## Hello World',
      '',
      '<h2 id="custom-id">自定标题</h2>',
      '',
      '### 自定标题',
      ''
    ].join('\n');
    const { target, instance } = await renderMd(md);
    const toc = tocOf(instance);
    const ids = toc.map((t) => t.id);
    expect(ids[0]).toBe('hello-world'); // slug：去标点、空格转 -
    expect(ids[1]).toBe('hello-world-2'); // 重复标题唯一化
    expect(ids[2]).toBe('custom-id'); // 既有 id 保留
    expect(ids[3]).toBe('自定标题'); // 无 id 的 CJK 标题生成 CJK slug
    expect(new Set(ids).size).toBe(ids.length);
    // DOM 内 id 与 TOC 一一对应
    for (const t of toc) expect(target.querySelector(`[id="${t.id}"]`)).not.toBeNull();
  });

  it('CJK 标题生成 CJK slug', () => {
    expect(slugifyHeading('中文 标题')).toBe('中文-标题');
    expect(slugifyHeading('!!!')).toBe('section'); // 全空 slug 回退
  });

  it('destroy 清空 target，getToc 数据保持最后一次渲染的结果', async () => {
    const { target, instance } = await renderMd('# 存留\n');
    const toc = tocOf(instance);
    expect(toc).toHaveLength(1);
    instance.destroy();
    expect(target.innerHTML).toBe('');
    expect(tocOf(instance)).toEqual(toc);
  });
});

describe('markdownRenderer——heading id 与灯箱 overlay id 共存（F4）', () => {
  it('assignHeadingIds：标题 slug 恰为灯箱 overlay id 时自动加 -2 后缀（overlay id 预占）', () => {
    const doc = new DOMParser().parseFromString(
      `<h1>${LIGHTBOX_OVERLAY_ID}</h1><div id="${LIGHTBOX_OVERLAY_ID}"></div>`,
      'text/html'
    );
    assignHeadingIds(doc);
    // overlay id 不被标题占用（openLightbox 按 id 单例查找、removeLightboxOverlay 按 id 清理）
    expect(doc.querySelector('h1')!.id).toBe(`${LIGHTBOX_OVERLAY_ID}-2`);
    expect(doc.getElementById(LIGHTBOX_OVERLAY_ID)!.tagName).toBe('DIV');
  });

  it('正文标题恰为 md-lightbox-overlay：标题加后缀，点击图片灯箱仍正常打开', async () => {
    const { target, instance } = await renderMd(`# ${LIGHTBOX_OVERLAY_ID}\n\n![图](a.png)\n`);
    const h1 = target.querySelector('h1')!;
    expect(h1.id).toBe(`${LIGHTBOX_OVERLAY_ID}-2`);
    // 灯箱仍正常：点击图片 → body 上出现唯一 overlay 且展示图片
    (target.querySelector('img') as HTMLImageElement).click();
    const overlay = document.getElementById(LIGHTBOX_OVERLAY_ID);
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector('img')?.getAttribute('src')).toBe('a.png');
    expect(document.querySelectorAll(`#${LIGHTBOX_OVERLAY_ID}`)).toHaveLength(1);
    instance.destroy(); // destroy 清理 body 级 overlay
    expect(document.getElementById(LIGHTBOX_OVERLAY_ID)).toBeNull();
  });
});

describe('markdownRenderer——超大输入降级（F2）', () => {
  /** jsdom 无 ResizeObserver，降级路径的 virtualScroller 需要（照 htmlRenderer.test 的 stub） */
  function stubResizeObserver(): void {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
  }

  it('>20MB：降级为纯文本代码视图 + 提示卡，不走富文本管线', async () => {
    stubResizeObserver();
    const big = new Uint8Array(20 * 1024 * 1024 + 1); // 内容任意：守卫只看 byteLength
    const target = document.createElement('div');
    const instance = await markdownRenderer.render(big, target, SOURCE, DET);
    expect(target.querySelector('.vv-error-card')).not.toBeNull();
    expect(target.textContent).toContain('文件过大');
    expect(target.querySelector('.vv-code-pre')).not.toBeNull(); // 代码/纯文本视图承接
    expect(target.classList.contains('vv-markdown')).toBe(false); // 富文本管线未走
    expect(target.classList.contains('vv-degraded')).toBe(true);
    expect(tocOf(instance)).toEqual([]); // 降级视图无标题结构
    instance.destroy();
    expect(target.innerHTML).toBe('');
    expect(target.classList.contains('vv-degraded')).toBe(false);
  });
});

describe('fenceToHtml——highlightFence 接线（依赖倒置）', () => {
  it('注入 fake client：区间 → 行 HTML（captureToCssClass 类名），多行分段正确', async () => {
    const fake: CodeHighlightClient = {
      highlight: async (text: string): Promise<HighlightInterval[]> =>
        text.startsWith('const') ? [{ start: 0, end: 5, capture: 'keyword' }] : [{ start: 0, end: 3, capture: 'keyword.control' }]
    };
    attachHighlightClient(fake);
    expect(await fenceToHtml('const a = 1;', 'js')).toBe(
      '<span class="ts-keyword">const</span> a = 1;'
    );
    expect(await fenceToHtml('if x:\nelse y:', 'py')).toBe(
      '<span class="ts-keyword-control">if </span>x:\nelse y:'
    );
  });

  it('client 抛错（含取消）/未注入 → 返回 null（管线内 hljs 兜底）', async () => {
    attachHighlightClient({
      highlight: async () => {
        throw new Error('boom');
      }
    });
    expect(await fenceToHtml('x', 'js')).toBeNull();
    attachHighlightClient(null);
    expect(await fenceToHtml('x', 'js')).toBeNull();
  });

  it('client 取消（HighlightCanceledError）→ 重抛给管线跳过该块，不 hljs 兜底', async () => {
    attachHighlightClient({
      highlight: async () => {
        throw new HighlightCanceledError();
      }
    });
    await expect(fenceToHtml('x', 'js')).rejects.toThrow(HighlightCanceledError);
    // 管线集成：取消后该块保持原文（无 hljs-* span，也无 ts-* span）
    const { target } = await renderMd('```js\nconst a = 1;\n```\n');
    await vi.waitFor(() => {
      expect(target.querySelector('pre code span[class^="hljs-"]')).toBeNull();
      expect(target.querySelector('pre code .ts-keyword')).toBeNull();
      expect(target.querySelector('pre code')?.textContent).toBe('const a = 1;\n');
    });
  });

  it('渲染集成：注入 fake 后围栏代码块内出现 ts-* span', async () => {
    attachHighlightClient({
      highlight: async (): Promise<HighlightInterval[]> => [{ start: 0, end: 5, capture: 'keyword' }]
    });
    const { target } = await renderMd('```js\nconst a = 1;\n```\n');
    const span = target.querySelector('pre code .ts-keyword');
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe('const');
  });

  it('渲染集成：client 失败时围栏回落 hljs（hljs-* span）', async () => {
    attachHighlightClient({
      highlight: async (): Promise<HighlightInterval[]> => {
        throw new Error('boom');
      }
    });
    const { target } = await renderMd('```js\nconst a = 1;\n```\n');
    await vi.waitFor(() => {
      expect(target.querySelector('pre code span[class^="hljs-"]')).not.toBeNull();
    });
  });
});

describe('markdownRenderer——后端注入（M7 远程引擎，M6 遗留）', () => {
  function engineOf(instance: RenderedInstance): MarkdownEngineState {
    const fn = (instance as { getEngine?: () => MarkdownEngineState }).getEngine;
    if (!fn) throw new Error('markdown 实例应提供 getEngine');
    return fn();
  }

  it('注入 backend 时优先调用之，本地引擎不参与；getEngine 落 backend 返回的 where', async () => {
    const calls: string[] = [];
    setMarkdownBackend(async ({ text }) => {
      calls.push(text);
      return { html: '<h2 id="remote-h">远程标题</h2><p>来自 comrak</p>', where: 'remote' };
    });
    const { target, instance } = await renderMd('# 本地标题\n');
    expect(calls).toEqual(['# 本地标题\n']); // 原文交给 backend（路由在调用方）
    expect(target.querySelector('h2#remote-h')).not.toBeNull();
    expect(target.querySelector('p')?.textContent).toBe('来自 comrak');
    expect(target.querySelector('h1')).toBeNull(); // 本地 markdown-it 未渲染
    expect(engineOf(instance)).toBe('remote');
    instance.destroy();
  });

  it('backend 报 where=local 时 getEngine 为 local（auto 回退本地后如实标注）', async () => {
    setMarkdownBackend(async () => ({ html: '<p>回退渲染</p>', where: 'local' }));
    const { instance } = await renderMd('x\n');
    expect(engineOf(instance)).toBe('local');
  });

  it('comrak unsafe 输出必经净化：script/事件属性/javascript: href 全剥除', async () => {
    setMarkdownBackend(async () => ({
      html:
        '<p onclick="alert(1)">x</p><script>alert(1)</script>' +
        '<a href="javascript:alert(1)">y</a><img src="a.png" onerror="alert(1)">',
      where: 'remote'
    }));
    const { target } = await renderMd('dirty\n');
    expect(target.querySelector('script')).toBeNull();
    expect(target.querySelector('p')?.hasAttribute('onclick')).toBe(false);
    const a = target.querySelector('a');
    expect(a?.hasAttribute('href')).toBe(false); // javascript: 连属性一起剥
    expect(target.querySelector('img')?.hasAttribute('onerror')).toBe(false);
    expect(target.querySelector('img')?.getAttribute('src')).toBe('a.png'); // 正常属性保留
  });

  it('返回的 HTML 仍走 enrich+pipeline 全管线：comrak 任务列表补 task-list-item 类、TOC 可提取', async () => {
    setMarkdownBackend(async () => ({
      // comrak tasklist 输出形态：li 无类（markdown-it-task-lists 会加 task-list-item）
      html: '<h2>设备</h2><ul><li><input type="checkbox" checked="" disabled="" /> done</li></ul>',
      where: 'remote'
    }));
    const { target, instance } = await renderMd('x\n');
    expect(target.querySelector('li.task-list-item input[type="checkbox"]')).not.toBeNull();
    expect(tocOf(instance).map((t) => t.text)).toEqual(['设备']);
  });

  it('remote 显式失败语义：backend 抛错 → render 拒绝（错误卡片由调用方渲染）', async () => {
    setMarkdownBackend(async () => {
      throw new Error('远程 markdown 渲染失败: HTTP 413');
    });
    await expect(renderMd('# x\n')).rejects.toThrow('HTTP 413');
  });

  it('backend 收到的是剥掉 front matter 的 body（comrak 不识别 front matter）', async () => {
    const calls: string[] = [];
    setMarkdownBackend(async ({ text }) => {
      calls.push(text);
      return { html: '<p>ok</p>', where: 'remote' };
    });
    await renderMd('---\ntitle: x\n---\n\n正文\n');
    expect(calls).toEqual(['正文\n']);
  });

  it('未注入 backend：本地 markdown-it 渲染，getEngine 为 local（现状不回归）', async () => {
    const { target, instance } = await renderMd('# 本地\n');
    expect(target.querySelector('h1')?.textContent).toBe('本地');
    expect(engineOf(instance)).toBe('local');
  });

  it('getMarkdownBackend 返回最近注入的 fn；传 null 解绑', () => {
    expect(getMarkdownBackend()).toBeNull();
    const fn = async (): Promise<{ html: string; where: 'local' }> => ({ html: '', where: 'local' });
    setMarkdownBackend(fn);
    expect(getMarkdownBackend()).toBe(fn);
    setMarkdownBackend(null);
    expect(getMarkdownBackend()).toBeNull();
  });

  it('renderMarkdownBody：直接渲染 body（不再剥 front matter），apps/web 本地回退用', () => {
    expect(renderMarkdownBody('# t\n')).toContain('<h1>t</h1>');
    expect(renderMarkdownBody('| a |\n|---|\n| 1 |\n')).toContain('<table>');
  });
});

describe('markdownRenderer——相对图片经 store 解析（终审 M3：404 现状的补齐）', () => {
  /** store 桩：files 为「store 内路径 → 字节」的映射，read 未命中抛错（同真实 store 语义） */
  function storeStub(files: Record<string, Uint8Array>): TreeStore {
    return {
      id: 'stub',
      displayName: () => 'stub',
      listChildren: async () => [],
      read: async (path: string) => {
        const hit = files[path];
        if (!hit) throw new Error(`no such file: ${path}`);
        return hit;
      }
    };
  }

  function sourceWith(store: TreeStore, path: string): FileSource {
    return { storeId: 'stub', storeLabel: 'stub', path, name: path.split('/').pop() ?? path, store };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    // 挂掉本组补上的 revoke 桩（jsdom 无该 API，renderer 有 typeof 守卫）
    const anyUrl = URL as unknown as { revokeObjectURL?: unknown };
    delete anyUrl.revokeObjectURL;
  });

  it('命中 resolver：img src 换为同 store 文件的 URL，resolver 收到（src, source）', async () => {
    const store = storeStub({ 'docs/img/a.png': new Uint8Array([1]) });
    const source = sourceWith(store, 'docs/readme.md');
    const seen: Array<[string, string]> = [];
    setMarkdownImageResolver(async (src, s) => {
      seen.push([src, s.path]);
      // 模拟 apps/web 实现：按目录解析路径后读 store，返回 blob URL 形态字符串
      return src === 'img/a.png' ? 'blob:stub-1' : null;
    });
    const target = document.createElement('div');
    const instance = await markdownRenderer.render(
      new TextEncoder().encode('![图](img/a.png)\n'), target, source, DET
    );
    expect(seen).toEqual([['img/a.png', 'docs/readme.md']]);
    expect(target.querySelector('img')?.getAttribute('src')).toBe('blob:stub-1');
    instance.destroy();
  });

  it('未命中（null）/resolver 抛错：保留原 src', async () => {
    const store = storeStub({});
    const source = sourceWith(store, 'readme.md');
    setMarkdownImageResolver(async (src) => (src === 'ok.png' ? 'blob:stub-ok' : null));
    const target = document.createElement('div');
    const instance = await markdownRenderer.render(
      new TextEncoder().encode('![](ok.png)\n![](missing.png)\n'), target, source, DET
    );
    const imgs = target.querySelectorAll('img');
    expect(imgs[0]?.getAttribute('src')).toBe('blob:stub-ok');
    expect(imgs[1]?.getAttribute('src')).toBe('missing.png'); // 404 现状

    setMarkdownImageResolver(async () => {
      throw new Error('store read boom');
    });
    const target2 = document.createElement('div');
    const instance2 = await markdownRenderer.render(
      new TextEncoder().encode('![](x.png)\n'), target2, source, DET
    );
    expect(target2.querySelector('img')?.getAttribute('src')).toBe('x.png');
    instance.destroy();
    instance2.destroy();
  });

  it('绝对地址（scheme/根相对/片段）不进 resolver', async () => {
    const store = storeStub({});
    const source = sourceWith(store, 'readme.md');
    const seen: string[] = [];
    setMarkdownImageResolver(async (src) => {
      seen.push(src);
      return null;
    });
    const md = '![](https://e.com/x.png)\n![](data:image/png;base64,AA)\n![](/root.png)\n![](https://x.com#[a](b))\n![](local.png)\n';
    const target = document.createElement('div');
    const instance = await markdownRenderer.render(new TextEncoder().encode(md), target, source, DET);
    expect(seen).toEqual(['local.png']);
    instance.destroy();
  });

  it('destroy 时 revoke 解析产出的 URL（实例生命周期对齐，渲染不泄漏 blob）', async () => {
    const revoke = vi.fn();
    // jsdom 无 URL.revokeObjectURL：renderer 的 typeof 守卫下补桩观察调用
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true, writable: true });
    const store = storeStub({});
    const source = sourceWith(store, 'readme.md');
    setMarkdownImageResolver(async () => 'blob:stub-revoke');
    const target = document.createElement('div');
    const instance = await markdownRenderer.render(
      new TextEncoder().encode('![](a.png)\n'), target, source, DET
    );
    expect(revoke).not.toHaveBeenCalled();
    instance.destroy();
    expect(revoke).toHaveBeenCalledWith('blob:stub-revoke');
  });

  it('getMarkdownImageResolver 返回最近注入的 fn；传 null 解绑（404 现状）', () => {
    expect(getMarkdownImageResolver()).toBeNull();
    const fn = async (): Promise<string | null> => null;
    setMarkdownImageResolver(fn);
    expect(getMarkdownImageResolver()).toBe(fn);
    setMarkdownImageResolver(null);
    expect(getMarkdownImageResolver()).toBeNull();
  });
});

describe('markdownRenderer——灯箱 overlay 归属（遗留 U3：多实例互删防线）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function overlay(): HTMLElement | null {
    return document.getElementById('md-lightbox-overlay');
  }

  it('A 打开灯箱后 B destroy：overlay 保留；owner（A）destroy 才移除', async () => {
    const a = await renderMd('![图](photo.png)\n');
    const b = await renderMd('![图](other.png)\n');
    a.target.querySelector('img')!.click(); // A 打开 body 级共享 overlay
    expect(overlay()).not.toBeNull();
    b.instance.destroy(); // B 非打开者：不得互删 A 正开着的灯箱
    expect(overlay()).not.toBeNull();
    a.instance.destroy(); // owner 销毁：随生命周期移除
    expect(overlay()).toBeNull();
  });

  it('overlay 被后打开者接管（B 点图）：A destroy 不再能摘，B destroy 摘除', async () => {
    const a = await renderMd('![a](a.png)\n');
    const b = await renderMd('![b](b.png)\n');
    a.target.querySelector('img')!.click();
    b.target.querySelector('img')!.click(); // 最后打开者即 owner
    a.instance.destroy();
    expect(overlay()).not.toBeNull();
    b.instance.destroy();
    expect(overlay()).toBeNull();
  });
});
