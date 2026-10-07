import { describe, it, expect, vi, afterEach } from 'vitest';
import hljs from 'highlight.js';
import { HighlightCanceledError } from '@vviewer/highlight';
import { RemoteComputeError } from '@vviewer/core';
import {
  buildLineIndex,
  buildLineOffsets,
  splitHighlightedLines,
  resolveStrategy,
  assignIntervalsToLines,
  renderLineHtml,
  renderCode,
  attachHighlightClient,
  evictOldestEntries,
  resolveHljsLang,
  HLJS_ALIASES,
  BLOCK_CACHE_MAX_ROWS,
  TREE_SITTER_MAX_BYTES,
  HLJS_MAX_BYTES,
  type HighlightInterval,
} from '../src/code';

describe('buildLineIndex', () => {
  it('splits keeping line count', () => {
    expect(buildLineIndex('a\nb\nc')).toEqual(['a', 'b', 'c']);
    expect(buildLineIndex('a\nb\n')).toEqual(['a', 'b', '']);
    expect(buildLineIndex('')).toEqual(['']);
  });
});

describe('splitHighlightedLines', () => {
  it('splits hljs html preserving spans across lines', () => {
    const html = '<span class="hljs-keyword">const</span> <span class="hljs-params">a</span>';
    const lines = splitHighlightedLines(html, 1);
    expect(lines).toHaveLength(1);
  });
  it('multi-line: reopening spans per line', () => {
    const html = '<span class="hljs-keyword">func\nbody</span>';
    const lines = splitHighlightedLines(html, 2);
    expect(lines[0]).toContain('hljs-keyword');
    expect(lines[1]).toContain('hljs-keyword'); // 第二行重新打开 span
    expect(lines[1]).toContain('</span>');
  });
});

describe('resolveStrategy（降级链阈值）', () => {
  it('≤2MB → tree-sitter（实测 ~2.1-2.4s/MB，阈值据 spec 5.11 预算校准）', () => {
    expect(resolveStrategy(0)).toBe('tree-sitter');
    expect(resolveStrategy(1024)).toBe('tree-sitter');
    expect(resolveStrategy(TREE_SITTER_MAX_BYTES)).toBe('tree-sitter');
    expect(TREE_SITTER_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
  it('2MB–20MB → hljs-block', () => {
    expect(resolveStrategy(TREE_SITTER_MAX_BYTES + 1)).toBe('hljs-block');
    expect(resolveStrategy(HLJS_MAX_BYTES)).toBe('hljs-block');
  });
  it('>20MB → plain', () => {
    expect(resolveStrategy(HLJS_MAX_BYTES + 1)).toBe('plain');
  });
});

describe('resolveHljsLang / HLJS_ALIASES（hljs 别名桥接）', () => {
  it('桥接表全部键直查失败、全部值经 hljs.getLanguage 命中（表即"真实差异"全集）', () => {
    expect(Object.keys(HLJS_ALIASES).length).toBeGreaterThanOrEqual(15);
    for (const [helixName, hljsId] of Object.entries(HLJS_ALIASES)) {
      expect(hljs.getLanguage(helixName), `${helixName} 应直查失败才需要桥接`).toBeUndefined();
      expect(hljs.getLanguage(hljsId), `${helixName} → ${hljsId} 应在 hljs 命中`).toBeTruthy();
    }
  });

  it('直查命中原样返回；桥接命中返回 hljs id；未知返回 null', () => {
    expect(resolveHljsLang(hljs, 'rust')).toBe('rust'); // hljs 直查命中
    expect(resolveHljsLang(hljs, 'c-sharp')).toBe('csharp');
    expect(resolveHljsLang(hljs, 'objective-c')).toBe('objectivec');
    expect(resolveHljsLang(hljs, 'shell')).toBe('shell'); // hljs 自带别名（不在桥接表）
    expect(resolveHljsLang(hljs, 'zig')).toBeNull(); // hljs 无对应语言
    expect(resolveHljsLang(hljs, null)).toBeNull();
  });
});

describe('evictOldestEntries（blockCache 淘汰）', () => {
  it('超出上限按插入序淘汰最早条目', () => {
    const m = new Map<number, string>([[1, 'a'], [2, 'b'], [3, 'c']]);
    evictOldestEntries(m, 2);
    expect([...m.keys()]).toEqual([2, 3]);
    evictOldestEntries(m, 0);
    expect(m.size).toBe(0);
  });
  it('未超上限不动', () => {
    const m = new Map<number, string>([[1, 'a'], [2, 'b']]);
    evictOldestEntries(m, BLOCK_CACHE_MAX_ROWS);
    expect(m.size).toBe(2);
  });
});

describe('buildLineOffsets', () => {
  it('累计偏移含换行符（UTF-16 偏移）', () => {
    expect(buildLineOffsets(['ab', 'cd', 'e'])).toEqual([0, 3, 6]);
    expect(buildLineOffsets([''])).toEqual([0]);
    expect(buildLineOffsets(['a', ''])).toEqual([0, 2]); // 'a\n' 长度 2，'' 起点 2
  });
});

describe('assignIntervalsToLines（区间 → 行分配）', () => {
  // 文本 "ab\ncd\n" → 行偏移 [0, 3, 6]，行长 2/2/0
  const offsets = [0, 3, 6];

  it('单行内区间给出相对行首的段', () => {
    const out = assignIntervalsToLines([{ start: 0, end: 2, capture: 'keyword' }], offsets);
    expect(out).toEqual([{ line: 0, segs: [{ start: 0, end: 2, capture: 'keyword' }] }]);
  });

  it('跨行区间拆到各行', () => {
    const out = assignIntervalsToLines([{ start: 1, end: 5, capture: 'string' }], offsets);
    expect(out).toEqual([
      { line: 0, segs: [{ start: 1, end: 2, capture: 'string' }] },
      { line: 1, segs: [{ start: 0, end: 2, capture: 'string' }] },
    ]);
  });

  it('嵌套区间内层优先（父区间不再吞并子区间）', () => {
    const intervals: HighlightInterval[] = [
      { start: 0, end: 5, capture: 'parent' },
      { start: 1, end: 3, capture: 'child' }, // 完全落在 parent 内 → 内层可见
    ];
    const out = assignIntervalsToLines(intervals, offsets);
    expect(out).toEqual([
      { line: 0, segs: [
        { start: 0, end: 1, capture: 'parent' },
        { start: 1, end: 2, capture: 'child' },
      ] },
      { line: 1, segs: [{ start: 0, end: 2, capture: 'parent' }] },
    ]);
  });

  it('rust 转义形态：外层 @string 内的 @constant.character.escape 保留', () => {
    // 单行 offsets=[0]；"a\nb" 字符串整体 @string，转义序列 \n 内层 @constant.character.escape
    const offsets1 = [0];
    const out = assignIntervalsToLines(
      [
        { start: 0, end: 14, capture: 'string' },
        { start: 4, end: 6, capture: 'constant.character.escape' },
      ],
      offsets1
    );
    expect(out).toEqual([
      { line: 0, segs: [
        { start: 0, end: 4, capture: 'string' },
        { start: 4, end: 6, capture: 'constant.character.escape' },
        { start: 6, end: 14, capture: 'string' },
      ] },
    ]);
  });

  it('注入场景（markdown fence 形态）：外层 literal 罩整块、内层 token 逐段可见', () => {
    // 模拟 fenced code block：@text.literal 覆盖整块，注入语言的 keyword 散布其中
    const offsets1 = [0];
    const out = assignIntervalsToLines(
      [
        { start: 0, end: 20, capture: 'text.literal' },
        { start: 2, end: 5, capture: 'keyword' },
        { start: 10, end: 13, capture: 'keyword' },
      ],
      offsets1
    );
    expect(out).toEqual([
      { line: 0, segs: [
        { start: 0, end: 2, capture: 'text.literal' },
        { start: 2, end: 5, capture: 'keyword' },
        { start: 5, end: 10, capture: 'text.literal' },
        { start: 10, end: 13, capture: 'keyword' },
        { start: 13, end: 20, capture: 'text.literal' },
      ] },
    ]);
  });

  it('兄弟部分重叠无嵌套时先到者优先（tie 确定性）', () => {
    const intervals: HighlightInterval[] = [
      { start: 0, end: 4, capture: 'a' },
      { start: 2, end: 6, capture: 'b' }, // 与 a 重叠且互不包含 → 段 [2,4) tie 按字典序归 'a'
    ];
    const out = assignIntervalsToLines(intervals, offsets);
    expect(out).toEqual([
      { line: 0, segs: [{ start: 0, end: 2, capture: 'a' }] },
      { line: 1, segs: [
        { start: 0, end: 1, capture: 'a' }, // 偏移 [3,4)：行 1 的 "c"
        { start: 1, end: 2, capture: 'b' }, // 偏移 [4,6)：行 1 的 "d"
      ] },
    ]);
  });

  it('空输入返回空', () => {
    expect(assignIntervalsToLines([], offsets)).toEqual([]);
    expect(assignIntervalsToLines([{ start: 0, end: 1, capture: 'x' }], [])).toEqual([]);
  });
});

describe('renderLineHtml（行 HTML 渲染）', () => {
  it('无段落时转义整行', () => {
    expect(renderLineHtml('<a> & "b"', undefined)).toBe('&lt;a&gt; &amp; "b"');
  });

  it('段落包 ts-<capture> span（点转 -），段外文本转义', () => {
    const html = renderLineHtml('let x = "<s>"', [
      { start: 0, end: 3, capture: 'keyword' },
      { start: 8, end: 13, capture: 'string.special' },
    ]);
    expect(html).toContain('<span class="ts-keyword">let</span>');
    expect(html).toContain('<span class="ts-string-special">');
    expect(html).toContain('&lt;s&gt;');
    expect(html.startsWith('&nbsp;') || html.includes(' x = ')).toBe(true);
  });

  it('段越界（超过行尾）被裁剪', () => {
    const html = renderLineHtml('ab', [{ start: 1, end: 99, capture: 'x' }]);
    expect(html).toBe('a<span class="ts-x">b</span>');
  });
});

describe('renderCode（tree-sitter 主路径，fake client）', () => {
  afterEach(() => {
    attachHighlightClient(null);
    document.body.innerHTML = '';
  });

  /** jsdom 无 ResizeObserver，stub 之 */
  function stubResizeObserver(): void {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  }

  it('区间渲染为 .ts-<capture> span', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => [{ start: 0, end: 3, capture: 'keyword' }],
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('let x'), host, { ext: 'rs', lang: 'rust' });
    await vi.waitFor(() => {
      expect(host.querySelectorAll('.ts-keyword').length).toBeGreaterThan(0);
    });
    expect(host.querySelector('.ts-keyword')?.textContent).toBe('let');
    expect(handle.getScrollHost().className).toContain('vv-code-pre'); // virtualScroller 会加 vv-virtual
    handle.destroy();
  });

  it('嵌套区间渲染：外层 @string 内的转义序列保留内层样式（rust 形态）', async () => {
    stubResizeObserver();
    // 文本 `let x = "a\nb"`（\n 为字面反斜杠+n 两字符）：字符串 [8,14)，转义 [10,12)
    const text = 'let x = "a\\nb"';
    attachHighlightClient({
      highlight: async () => [
        { start: 8, end: 14, capture: 'string' },
        { start: 10, end: 12, capture: 'constant.character.escape' },
      ],
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode(text), host, { ext: 'rs', lang: 'rust' });
    await vi.waitFor(() => {
      expect(host.querySelector('.ts-constant-character-escape')).not.toBeNull();
    });
    expect(host.querySelector('.ts-constant-character-escape')?.textContent).toBe('\\n');
    // 内层两侧的间隙仍由外层 @string 着色
    expect(host.querySelector('.ts-string')?.textContent).toBe('"a');
    handle.destroy();
  });

  it('注入场景渲染：外层 literal 罩整块时内层 keyword span 可见（markdown fence 形态）', async () => {
    stubResizeObserver();
    const text = 'AB keyword CD keyword EF'; // 三段：外层覆盖全文，keyword 散布其中
    const k1 = text.indexOf('keyword');
    const k2 = text.lastIndexOf('keyword');
    attachHighlightClient({
      highlight: async () => [
        { start: 0, end: text.length, capture: 'text.literal' },
        { start: k1, end: k1 + 7, capture: 'keyword' },
        { start: k2, end: k2 + 7, capture: 'keyword' },
      ],
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode(text), host, { ext: 'md', lang: 'markdown' });
    await vi.waitFor(() => {
      expect(host.querySelectorAll('.ts-keyword').length).toBe(2);
    });
    // 内层完整可见，外层只覆盖间隙
    expect([...host.querySelectorAll('.ts-keyword')].map((el) => el.textContent)).toEqual(['keyword', 'keyword']);
    expect(host.querySelector('.ts-text-literal')?.textContent).toBe('AB ');
    handle.destroy();
  });

  it('client reject（非取消）→ 降级 hljs 整文件', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => {
        throw new Error('boom');
      },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('const a = 1'), host, { ext: 'js', lang: 'javascript' });
    await vi.waitFor(() => {
      // highlightAuto 的具体类名取决于识别出的语言，断言出现了任一 hljs 高亮 span
      expect(host.querySelectorAll('[class*="hljs-"]').length).toBeGreaterThan(0);
    });
    handle.destroy();
  });

  it('取消错误静默放弃（不降级）', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => {
        throw new HighlightCanceledError(); // 真实 client 取消时抛的类型
      },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('let x'), host, { ext: 'rs', lang: 'rust' });
    await new Promise((r) => setTimeout(r, 10));
    expect(host.querySelectorAll('[class*="hljs-"]').length).toBe(0);
    handle.destroy();
  });

  it('plain 策略不做任何高亮', async () => {
    stubResizeObserver();
    const spy = vi.fn(async () => [] as HighlightInterval[]);
    attachHighlightClient({ highlight: spy });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('let x'), host, { highlight: false, ext: 'rs' });
    await new Promise((r) => setTimeout(r, 10));
    expect(spy).not.toHaveBeenCalled();
    expect(host.querySelector('.vv-code-body')?.textContent).toBe('let x');
    expect(handle.getEngine()).toBe('plain');
    handle.destroy();
  });

  it('getEngine 实时反映引擎：pending → tree-sitter', async () => {
    stubResizeObserver();
    let resolveHighlight!: (v: HighlightInterval[]) => void;
    attachHighlightClient({
      highlight: () => new Promise<HighlightInterval[]>((res) => { resolveHighlight = res; }),
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('let x'), host, { ext: 'rs', lang: 'rust' });
    expect(handle.getEngine()).toBe('pending');
    resolveHighlight([{ start: 0, end: 3, capture: 'keyword' }]);
    await vi.waitFor(() => expect(handle.getEngine()).toBe('tree-sitter'));
    handle.destroy();
  });

  it('getEngine：client 失败降级 hljs 整文件后为 hljs', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => {
        throw new Error('boom');
      },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('const a = 1'), host, { ext: 'js', lang: 'javascript' });
    await vi.waitFor(() => expect(handle.getEngine()).toBe('hljs'));
    handle.destroy();
  });

  it('显式 remote 失败（RemoteComputeError）→ 错误卡而非静默降级 hljs', async () => {
    stubResizeObserver();
    // withDebug 在 routeHighlight 返回 {where:'remote', ok:false} 时抛 RemoteComputeError
    //（routeMock remote 500 的下游身份）；此处直接模拟该类型化错误穿过到渲染端
    attachHighlightClient({
      highlight: async () => {
        throw new RemoteComputeError('远程高亮失败: HTTP 500');
      },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('fn main() {}'), host, {
      ext: 'rs',
      lang: 'rust',
      computeSrc: { path: 'src/main.rs' },
    });
    await vi.waitFor(() => {
      expect(host.querySelector('.vv-error-card')).not.toBeNull();
    });
    expect(host.querySelector('.vv-error-card')?.textContent).toContain('HTTP 500');
    expect(host.innerHTML).not.toContain('hljs-'); // 未静默降级 hljs 整文件
    expect(host.querySelector('[class*="ts-"]')).toBeNull();
    handle.destroy();
  });

  it('CRLF/CR 文本：行索引与高亮区间在归一化（LF）文本上计算', async () => {
    stubResizeObserver();
    // 'let x\r\nlet y\r\n' 归一化为 'let x\nlet y\n'：第二行起点 6，'y' 偏移 [10,11)。
    // 若不归一化，\r 计入第一行长度（起点 7），区间会命中 'e' 而非 'y'
    attachHighlightClient({
      highlight: async () => [{ start: 10, end: 11, capture: 'keyword' }],
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('let x\r\nlet y\r\n'), host, { ext: 'rs', lang: 'rust' });
    await vi.waitFor(() => {
      const row = host.querySelector('[data-line="1"] .vv-code-body');
      expect(row?.innerHTML).toContain('<span class="ts-keyword">y</span>');
    });
    handle.destroy();
  });

  it('buildLineIndex 之外的 CRLF 归一化发生在 renderCode 内（行数按 LF 计）', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => [],
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('a\r\nb\rc\nd'), host, { ext: 'rs', lang: 'rust' });
    await vi.waitFor(() => expect(handle.getEngine()).toBe('tree-sitter'));
    // 4 行：a/b/c/d（\r\n 与孤 \r 都算一个换行）
    for (const [i, ch] of ['a', 'b', 'c', 'd'].entries()) {
      expect(host.querySelector(`[data-line="${i}"] .vv-code-body`)?.textContent).toBe(ch);
    }
    expect(host.querySelector('[data-line="4"]')).toBeNull();
    handle.destroy();
  });
});
