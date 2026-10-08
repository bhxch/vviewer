import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { RenderedInstance, SearchMatch } from '@vviewer/core';
import { searchCode } from '../src/search';
import { renderCode } from '../src/code';
import { markdownRenderer } from '../src/markdown/markdownRenderer';
import type { Detection, FileSource } from '@vviewer/core';

// ---------- searchCode 纯函数 ----------

describe('searchCode（行级扫描纯函数）', () => {
  it('默认大小写不敏感；返回行号与行内 UTF-16 偏移（slice 可验证）', () => {
    const lines = ['const Alpha = 1;', 'let beta = alpha;'];
    const matches = searchCode(lines, 'ALPHA');
    expect(matches.map((m) => [m.line, m.start, m.end])).toEqual([[0, 6, 11], [1, 11, 16]]);
    for (const m of matches) {
      expect(lines[m.line]!.slice(m.start, m.end).toLowerCase()).toBe('alpha');
    }
  });

  it('caseSensitive: true 时严格区分大小写', () => {
    const lines = ['Alpha alpha ALPHA'];
    expect(searchCode(lines, 'alpha', { caseSensitive: true })).toEqual([
      { line: 0, start: 6, end: 11, preview: lines[0] }
    ]);
  });

  it('多命中：同行多次与跨行，互不重叠按序推进', () => {
    const sameLine = searchCode(['aXbXc'], 'X', { caseSensitive: true });
    expect(sameLine.map((m) => [m.line, m.start, m.end])).toEqual([[0, 1, 2], [0, 3, 4]]);
    const crossLine = searchCode(['aX', 'Xb'], 'X', { caseSensitive: true });
    expect(crossLine.map((m) => [m.line, m.start, m.end])).toEqual([[0, 1, 2], [1, 0, 1]]);
  });

  it('空 query 返回 []；无命中返回 []', () => {
    expect(searchCode(['abc'], '')).toEqual([]);
    expect(searchCode(['abc'], 'zzz')).toEqual([]);
    expect(searchCode([], 'a')).toEqual([]);
  });

  it('CJK 命中按 UTF-16 偏移', () => {
    const [m] = searchCode(['中文测试文本'], '测试');
    expect(m).toMatchObject({ line: 0, start: 2, end: 4 });
  });

  it('preview：命中前后各 40 字符截断，两侧越界加省略号', () => {
    const long = 'x'.repeat(50) + 'NEEDLE' + 'y'.repeat(50);
    const [m] = searchCode([long], 'needle');
    expect(m?.preview).toBe('…' + 'x'.repeat(40) + 'NEEDLE' + 'y'.repeat(40) + '…');
  });

  it('preview：命中贴近行首/行尾时不加省略号', () => {
    const [m1] = searchCode(['short NEEDLE tail'], 'needle');
    expect(m1?.preview).toBe('short NEEDLE tail'); // 全行不足前后 40 字符，原样
    const [m2] = searchCode(['NEEDLE' + 'z'.repeat(60)], 'needle');
    expect(m2?.preview).toBe('NEEDLE' + 'z'.repeat(40) + '…'); // 只有尾侧截断
  });
});

// ---------- code 实例 search/gotoMatch（fake DOM） ----------

describe('renderCode 实例 search/gotoMatch', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  /** jsdom 无 ResizeObserver，stub 之（同 code.test.ts） */
  function stubResizeObserver(): void {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  }

  it('search 用行数组扫描（大小写不敏感），返回 core SearchMatch 形状', async () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('alpha\nBeta gamma\nbeta delta\n'), host, { highlight: false });
    const matches = await handle.search('beta');
    expect(matches.map((m) => [m.line, m.start, m.end])).toEqual([[1, 0, 4], [2, 0, 4]]);
    handle.destroy();
  });

  it('相同 query 复用缓存（同一引用）；query 变化重扫；空 query 返回 []', async () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('a\nb\n'), host, { highlight: false });
    const first = await handle.search('a');
    expect(await handle.search('a')).toBe(first); // 缓存命中
    expect(await handle.search('b')).not.toBe(first);
    expect(await handle.search('')).toEqual([]);
    handle.destroy();
  });

  it('gotoMatch：当前命中行叠 active（1.5s 语义），全部命中行保持 vv-search-hit-line 背景（BUG-18）', async () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('one\nbeta two\nthree\nbeta four\n'), host, { highlight: false });
    await handle.search('beta');
    handle.gotoMatch(0);
    const row1 = host.querySelector('[data-line="1"]');
    // 行级背景由 searchState 驱动：两个命中行都有；当前命中行额外叠 active
    expect(row1?.classList.contains('vv-search-hit-line')).toBe(true);
    expect(row1?.classList.contains('vv-search-hit-line-active')).toBe(true);
    expect(host.querySelector('[data-line="3"]')?.classList.contains('vv-search-hit-line')).toBe(true);
    handle.gotoMatch(1);
    // 切换命中：旧当前行的 active 移除（命中行背景保持），新当前行叠 active
    expect(row1?.classList.contains('vv-search-hit-line-active')).toBe(false);
    expect(row1?.classList.contains('vv-search-hit-line')).toBe(true);
    const row3 = host.querySelector('[data-line="3"]');
    expect(row3?.classList.contains('vv-search-hit-line-active')).toBe(true);
    handle.destroy();
  });

  it("search('') 立即清除行级高亮（退出搜索语义，不等 1.5s 计时）", async () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('beta one\nplain\n'), host, { highlight: false });
    await handle.search('beta');
    handle.gotoMatch(0);
    expect(host.querySelector('.vv-search-hit-line')).not.toBeNull();
    await handle.search('');
    expect(host.querySelector('.vv-search-hit-line')).toBeNull();
    handle.destroy();
  });

  it('gotoMatch 越界/未搜索时不抛错也不置 active（命中行背景仍随 searchState）', async () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('a\nb\n'), host, { highlight: false });
    expect(() => handle.gotoMatch(0)).not.toThrow(); // 尚未 search
    await handle.search('a');
    expect(() => handle.gotoMatch(99)).not.toThrow();
    // 无当前命中 → 无 active；行 0 是搜索命中行，仍有 searchState 驱动的行级背景
    expect(host.querySelector('.vv-search-hit-line-active')).toBeNull();
    expect(host.querySelector('[data-line="0"]')?.classList.contains('vv-search-hit-line')).toBe(true);
    handle.destroy();
  });
});

// ---------- markdown 渲染视图 search/gotoMatch ----------

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

/** markdownRenderer 实例必带 search/gotoMatch（Task 6 契约；search 带 BUG-23 的 opts） */
function searchOf(instance: RenderedInstance): {
  search(q: string, opts?: { caseSensitive?: boolean }): Promise<SearchMatch[]>;
  gotoMatch(i: number): void;
} {
  if (!instance.search || !instance.gotoMatch) throw new Error('markdown 实例应提供 search/gotoMatch');
  const s = instance.search as (q: string, opts?: { caseSensitive?: boolean }) => Promise<SearchMatch[]>;
  return { search: s.bind(instance), gotoMatch: instance.gotoMatch.bind(instance) };
}

describe('markdown 实例 search/gotoMatch（DOM TreeWalker + mark 包裹）', () => {
  beforeEach(() => {
    // jsdom 无 scrollIntoView（原型上本无此方法，vi.spyOn 无从 spy）：先注入替身再
    // spyOn 跟踪调用。遗留 T6 测试卫生——原直赋 vi.fn() 不还原会泄漏到其他用例；
    // afterEach 先 restoreAllMocks 复位 spy、再删自有属性彻底还原原型
    Element.prototype.scrollIntoView ??= ((): void => {}) as typeof Element.prototype.scrollIntoView;
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('命中包 mark.vv-search-hit（大小写不敏感），整段文本无损', async () => {
    const { target, instance } = await renderMd('包含 Keyword 的段落，keyword 两次出现。\n');
    const before = target.querySelector('p')?.textContent;
    const { search } = searchOf(instance);
    const matches = await search('keyword');
    expect(matches).toHaveLength(2);
    const marks = target.querySelectorAll('mark.vv-search-hit');
    expect(marks).toHaveLength(2);
    expect(marks[0]?.textContent).toBe('Keyword');
    expect(marks[1]?.textContent).toBe('keyword');
    expect(target.querySelector('p')?.textContent).toBe(before); // 包裹不改变可见文本
  });

  it('跨块命中按文档序排列（line 复用为命中序号）', async () => {
    const { instance } = await renderMd('# 甲乙\n\n段落一 甲乙。\n\n段落二 甲乙。\n');
    const { search } = searchOf(instance);
    const matches = await search('甲乙');
    expect(matches.map((m) => m.line)).toEqual([0, 1, 2]);
  });

  it('gotoMatch 加 vv-search-hit-active 并滚动；切换时旧 active 移除', async () => {
    const { target, instance } = await renderMd('甲乙 甲乙\n');
    const { search, gotoMatch } = searchOf(instance);
    await search('甲乙');
    const marks = target.querySelectorAll('mark.vv-search-hit');
    gotoMatch(1);
    expect(marks[0]?.classList.contains('vv-search-hit-active')).toBe(false);
    expect(marks[1]?.classList.contains('vv-search-hit-active')).toBe(true);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    gotoMatch(0);
    expect(marks[1]?.classList.contains('vv-search-hit-active')).toBe(false);
    expect(marks[0]?.classList.contains('vv-search-hit-active')).toBe(true);
  });

  it('gotoMatch 越界不抛错、保持当前 active 不变', async () => {
    const { target, instance } = await renderMd('甲乙\n');
    const { search, gotoMatch } = searchOf(instance);
    await search('甲乙');
    gotoMatch(0);
    expect(() => gotoMatch(5)).not.toThrow();
    expect(target.querySelector('mark.vv-search-hit-active')).not.toBeNull();
  });

  it('再次 search 前还原上一次包裹（无 mark 嵌套、文本不重复）', async () => {
    const { target, instance } = await renderMd('重复 词语 与 词语 再次。\n');
    const text = target.querySelector('p')?.textContent;
    const { search } = searchOf(instance);
    await search('词语');
    await search('词语'); // 同词重搜
    expect(target.querySelectorAll('mark.vv-search-hit')).toHaveLength(2);
    expect(target.querySelectorAll('mark mark')).toHaveLength(0);
    await search('再次');
    expect(target.querySelectorAll('mark.vv-search-hit')).toHaveLength(1);
    expect(target.querySelector('p')?.textContent).toBe(text);
  });

  it('destroy 还原包裹；lightbox overlay 已从 body 移除（遗留泄漏修复）', async () => {
    const { target, instance } = await renderMd('![图](photo.png)\n\n含 关键词 段落。\n');
    target.querySelector('img')!.click(); // 打开 body 级 lightbox overlay
    expect(document.getElementById('md-lightbox-overlay')).not.toBeNull();
    const { search } = searchOf(instance);
    await search('关键词');
    expect(target.querySelectorAll('mark.vv-search-hit')).toHaveLength(1);
    instance.destroy();
    expect(document.getElementById('md-lightbox-overlay')).toBeNull();
    expect(target.innerHTML).toBe('');
  });

  it('destroy 后 search 返回 []（防御）', async () => {
    const { instance } = await renderMd('文本\n');
    const { search } = searchOf(instance);
    instance.destroy();
    await expect(search('文')).resolves.toEqual([]);
  });

  it('caseSensitive 透传（BUG-23）：默认不敏感 2 命中，敏感 1 命中', async () => {
    const { target, instance } = await renderMd('Keyword keyword\n');
    const { search } = searchOf(instance);
    expect((await search('keyword')).length).toBe(2);
    const sensitive = await search('keyword', { caseSensitive: true });
    expect(sensitive).toHaveLength(1);
    expect(target.querySelectorAll('mark.vv-search-hit')).toHaveLength(1);
    expect(target.querySelector('mark.vv-search-hit')?.textContent).toBe('keyword');
  });

  it('getMeta（BUG-04）：encoding/size 按 det/buffer 透传，无 lines（渲染视图无行概念）', async () => {
    const { instance } = await renderMd('# 标题\n');
    const meta = (instance as RenderedInstance & {
      getMeta?(): { encoding?: string; size: number; lines?: number };
    }).getMeta;
    expect(typeof meta).toBe('function');
    const m = meta!.call(instance);
    expect(m.encoding).toBe('utf-8');
    expect(m.size).toBe(new TextEncoder().encode('# 标题\n').byteLength);
    expect(m.lines).toBeUndefined();
    instance.destroy();
  });
});
