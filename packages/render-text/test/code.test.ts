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
  attachHighlightRouter,
  evictOldestEntries,
  evictChunksByLines,
  chunkRangeFor,
  mergeChunkLines,
  resolveHljsLang,
  overlaySearchHits,
  renderDegradedCode,
  HLJS_ALIASES,
  CHUNK_LINES,
  CHUNK_CACHE_MAX_LINES,
  PLAIN_MAX_BYTES,
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
  it('2MB–200MB → lazy（可视区 chunk 懒高亮；PLAIN_MAX_BYTES 参数化 200MB）', () => {
    expect(resolveStrategy(TREE_SITTER_MAX_BYTES + 1)).toBe('lazy');
    expect(resolveStrategy(HLJS_MAX_BYTES)).toBe('lazy');
    expect(resolveStrategy(PLAIN_MAX_BYTES)).toBe('lazy');
    expect(PLAIN_MAX_BYTES).toBe(200 * 1024 * 1024);
  });
  it('>200MB → plain（lazy 后无整文件解析，上限只防解码文本内存失控）', () => {
    expect(resolveStrategy(PLAIN_MAX_BYTES + 1)).toBe('plain');
  });
});

describe('chunkRangeFor（可视区 → 200 行对齐 chunk 区间，纯函数）', () => {
  it('窗口落在单 chunk 内：按 CHUNK_LINES 对齐返回整个 chunk', () => {
    expect(CHUNK_LINES).toBe(200);
    expect(chunkRangeFor(100, 130, 10000)).toEqual({ startLine: 0, lineCount: 200 });
  });
  it('跨 chunk 边界：两侧 chunk 都进区间（overscan+2 重叠防边界行漏高亮）', () => {
    expect(chunkRangeFor(190, 210, 10000)).toEqual({ startLine: 0, lineCount: 400 });
  });
  it('视口恰在边界后：前侧重叠仍覆盖上一 chunk 尾部', () => {
    expect(chunkRangeFor(201, 230, 10000)).toEqual({ startLine: 0, lineCount: 400 });
  });
  it('尾部夹边界：lineCount 不越过文件末行', () => {
    expect(chunkRangeFor(950, 990, 1000)).toEqual({ startLine: 800, lineCount: 200 });
    expect(chunkRangeFor(995, 999, 1000)).toEqual({ startLine: 800, lineCount: 200 });
  });
  it('空文件（虚拟滚动对 0 行传 -1,-1）：lineCount 0', () => {
    expect(chunkRangeFor(-1, -1, 0)).toEqual({ startLine: 0, lineCount: 0 });
  });
});

describe('mergeChunkLines（chunk 相对区间 → 绝对行平移，纯函数）', () => {
  const offsets = [0, 3, 6]; // 子文本 'ab\ncd\ne' 的行偏移表

  it('相对行 + startLine 平移到绝对行', () => {
    const m = mergeChunkLines([{ start: 0, end: 2, capture: 'keyword' }], offsets, 200);
    expect([...m.keys()]).toEqual([200]);
    expect(m.get(200)).toEqual([{ start: 0, end: 2, capture: 'keyword' }]);
  });

  it('跨行区间拆行后逐行平移（嵌套展平沿用 assignIntervalsToLines）', () => {
    const m = mergeChunkLines([{ start: 1, end: 5, capture: 'string' }], offsets, 400);
    expect(m.get(400)).toEqual([{ start: 1, end: 2, capture: 'string' }]);
    expect(m.get(401)).toEqual([{ start: 0, end: 2, capture: 'string' }]);
  });

  it('空区间 → 空 Map（chunk 已缓存标记，行回落纯文本）', () => {
    expect(mergeChunkLines([], offsets, 0).size).toBe(0);
  });
});

describe('evictChunksByLines（chunk 粒度逐出，5000 行等价）', () => {
  function chunkOf(entries: Array<[number, string]>): Map<number, string> {
    return new Map(entries);
  }

  it('超限按插入序整 chunk 淘汰，直到总行数 ≤ 上限', () => {
    const m = new Map<number, Map<number, string>>([
      [0, chunkOf([[0, 'a'], [1, 'b']])],
      [200, chunkOf([[200, 'c'], [201, 'd']])],
      [400, chunkOf([[400, 'e']])]
    ]);
    evictChunksByLines(m, 4); // 总 5 行 → 删最早 chunk(0)（2 行）→ 剩 3 行
    expect([...m.keys()]).toEqual([200, 400]);
    evictChunksByLines(m, 0);
    expect(m.size).toBe(0);
  });

  it('未超上限不动；上限常量为 5000（原 blockCache 行数等价）', () => {
    const m = new Map([[0, chunkOf([[0, 'a']])]]);
    evictChunksByLines(m, CHUNK_CACHE_MAX_LINES);
    expect(m.size).toBe(1);
    expect(CHUNK_CACHE_MAX_LINES).toBe(5000);
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

describe('evictOldestEntries（Map 插入序淘汰原语）', () => {
  it('超出上限按插入序淘汰最早条目', () => {
    const m = new Map<number, string>([[1, 'a'], [2, 'b'], [3, 'c']]);
    evictOldestEntries(m, 2);
    expect([...m.keys()]).toEqual([2, 3]);
    evictOldestEntries(m, 0);
    expect(m.size).toBe(0);
  });
  it('未超上限不动', () => {
    const m = new Map<number, string>([[1, 'a'], [2, 'b']]);
    evictOldestEntries(m, CHUNK_CACHE_MAX_LINES);
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
    attachHighlightRouter(null);
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

// ---------- BUG-04：getMeta 元数据快照 ----------

describe('renderCode getMeta（BUG-04：状态栏/属性面板元数据）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  function stubResizeObserver(): void {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  }

  it('行数为内容行数口径：以 \\n 结尾的 301 行文件报 301（非 split 产物的 302）', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const trailing = renderCode(new TextEncoder().encode('a\nb\n'), host, { highlight: false });
    expect(trailing.getMeta().lines).toBe(2); // split 产出 3 元素（末尾空串），报 2
    trailing.destroy();

    const noTrailing = renderCode(new TextEncoder().encode('a\nb'), host, { highlight: false });
    expect(noTrailing.getMeta().lines).toBe(2);
    noTrailing.destroy();

    const empty = renderCode(new TextEncoder().encode(''), host, { highlight: false });
    expect(empty.getMeta().lines).toBe(0); // 空文件 0 行（与 wc -l 一致）
    empty.destroy();

    const wc301 = renderCode(new TextEncoder().encode('line\n'.repeat(301)), host, { highlight: false });
    expect(wc301.getMeta().lines).toBe(301); // SHELL-12 验收口径：302 即不通过
    wc301.destroy();
  });

  it('encoding/lang/size 按 opts 透传（服务端检测头/编码链路的消费端）', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const buf = new TextEncoder().encode('x = 1');
    const handle = renderCode(buf, host, { encoding: 'gb18030', lang: 'python', highlight: false });
    expect(handle.getMeta()).toEqual({ encoding: 'gb18030', lang: 'python', size: 5, lines: 1 });
    handle.destroy();
    // 缺省：utf-8 + lang null
    const plain = renderCode(buf, host, { highlight: false });
    expect(plain.getMeta()).toEqual({ encoding: 'utf-8', lang: null, size: 5, lines: 1 });
    plain.destroy();
  });

  it('lang 与实际高亮语言同源：opts.lang 缺失时按 ext 的 detectLanguage 推导（评审③）', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    // 本地 .js（无服务端 x-vv-lang）：按扩展名检测出 javascript，语言段与引擎一致
    const js = renderCode(new TextEncoder().encode('let x = 1;\n'), host, { ext: 'js', highlight: false });
    expect(js.getMeta().lang).toBe('javascript');
    js.destroy();
    // 无 ext 且无 lang：null（不虚构）
    const noExt = renderCode(new TextEncoder().encode('text\n'), host, { highlight: false });
    expect(noExt.getMeta().lang).toBeNull();
    noExt.destroy();
  });
});

// ---------- BUG-20：超限提示条（plain >200MB / lazy >20MB 懒高亮提示） ----------

describe('renderCode 超限提示条（BUG-20）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  function stubResizeObserver(): void {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  }

  /** 目标字节数的多行 js 文本（小行：hljs 分块只高亮可视行，单行巨文本会拖死 hljs） */
  function bytesOfJs(targetBytes: number): Uint8Array {
    return new TextEncoder().encode('const a = 1;\n'.repeat(Math.ceil(targetBytes / 13)));
  }

  it('>PLAIN_MAX_BYTES 且自然 plain 路径：pre 外的兄弟节点插入提示条（含 200MB 字样）', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    // byteLength 仅参与 strategy/提示阈值/meta.size 判定：stub 到 200MB+1，
    // 避免测试真建 200MB 缓冲（解码仍用真实数据）
    const small = new TextEncoder().encode('let x = 1;\n');
    Object.defineProperty(small, 'byteLength', { value: PLAIN_MAX_BYTES + 1 });
    const handle = renderCode(small, host, { ext: 'txt' });
    const card = host.querySelector('.vv-oversize-card');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('200MB');
    expect(host.querySelector('.vv-code-pre')).not.toBeNull();
    // 提示条在滚动容器之外（virtualScroller replaceChildren 不得清掉它）
    expect(card!.contains(host.querySelector('.vv-code-pre'))).toBe(false);
    expect(handle.getEngine()).toBe('plain');
    handle.destroy();
  });

  it('>20MB lazy 文件：一次性「懒高亮」提示条（含 20MB 字样，不阻断滚动）', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(bytesOfJs(HLJS_MAX_BYTES + 1), host, { ext: 'js', lang: 'javascript' });
    const card = host.querySelector('.vv-oversize-card');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('20MB');
    expect(card?.textContent).toContain('懒');
    expect(host.querySelector('.vv-code-pre')).not.toBeNull();
    expect(handle.getEngine()).toBe('pending'); // lazy：首 chunk 到达前置 pending
    handle.destroy();
  });

  it('≤20MB lazy 与 renderDegradedCode 降级路径不出现提示卡', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    // lazy（2MB+1，≤20MB）无提示条
    const mid = renderCode(bytesOfJs(TREE_SITTER_MAX_BYTES + 1), host, { ext: 'js', lang: 'javascript' });
    expect(host.querySelector('.vv-oversize-card')).toBeNull();
    mid.destroy();
    host.replaceChildren();
    // renderDegradedCode（markdown 降级）自带降级卡：content 内不再叠加超限卡
    const degraded = renderDegradedCode(bytesOfJs(HLJS_MAX_BYTES + 1), host, {
      name: 'big.md',
      mode: '纯文本',
      highlight: false
    });
    expect(host.querySelectorAll('.vv-oversize-card')).toHaveLength(1); // 仅降级卡自身
    degraded.destroy();
  });
});

// ---------- BUG-18/23：词级 mark + 全命中行级背景 + caseSensitive ----------

describe('overlaySearchHits（BUG-18 词级 mark 纯函数）', () => {
  it('无命中原样返回', () => {
    expect(overlaySearchHits('<span class="ts-keyword">let</span>', [])).toBe(
      '<span class="ts-keyword">let</span>'
    );
  });

  it('纯文本行：命中段包 mark，其余转义输出', () => {
    expect(overlaySearchHits('alpha beta', [{ start: 6, end: 10 }])).toBe(
      'alpha <mark class="vv-search-hit">beta</mark>'
    );
  });

  it('命中段切开语法 span：span 在命中边界闭合、命中后按原序重开', () => {
    const base = renderLineHtml('abcd', [{ start: 0, end: 4, capture: 'keyword' }]);
    expect(base).toBe('<span class="ts-keyword">abcd</span>');
    expect(overlaySearchHits(base, [{ start: 1, end: 3 }])).toBe(
      '<span class="ts-keyword">a</span><mark class="vv-search-hit">bc</mark><span class="ts-keyword">d</span>'
    );
  });

  it('实体按显示字符切分：命中 &amp; 的 & 时 mark 内仍是合法转义', () => {
    // 'a & b' → 转义 'a &amp; b'；& 在显示偏移 [2,3)
    expect(overlaySearchHits('a &amp; b', [{ start: 2, end: 3 }])).toBe(
      'a <mark class="vv-search-hit">&amp;</mark> b'
    );
  });

  it('同 span 内多命中逐段 mark、段间恢复原 span', () => {
    expect(overlaySearchHits('xaxax', [{ start: 1, end: 2 }, { start: 3, end: 4 }])).toBe(
      'x<mark class="vv-search-hit">a</mark>x<mark class="vv-search-hit">a</mark>x'
    );
  });
});

describe('renderCode search（BUG-18 词级/行级 + BUG-23 caseSensitive）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  function stubResizeObserver(): void {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  }

  it('全部命中行有行级背景 + 命中文本包 mark.vv-search-hit；非命中行无', async () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(
      new TextEncoder().encode('alpha beta\nbeta alpha\nplain line\n'),
      host,
      { highlight: false }
    );
    await handle.search('beta');
    expect(host.querySelector('[data-line="0"]')?.classList.contains('vv-search-hit-line')).toBe(true);
    expect(host.querySelector('[data-line="1"]')?.classList.contains('vv-search-hit-line')).toBe(true);
    expect(host.querySelector('[data-line="2"]')?.classList.contains('vv-search-hit-line')).toBe(false);
    const mark = host.querySelector('[data-line="0"] mark.vv-search-hit');
    expect(mark?.textContent).toBe('beta'); // 词级命中可见文本正确
    handle.destroy();
  });

  it('tree-sitter 路径叠加：命中段为 mark，非命中段保留 ts-* span', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => [{ start: 0, end: 5, capture: 'keyword' }], // 整行 'alpha'
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('alpha beta\n'), host, { ext: 'rs', lang: 'rust' });
    await vi.waitFor(() => expect(handle.getEngine()).toBe('tree-sitter'));
    await handle.search('beta');
    const body = host.querySelector('[data-line="0"] .vv-code-body')!;
    const mark = body.querySelector('mark.vv-search-hit');
    expect(mark?.textContent).toBe('beta');
    expect(body.querySelector('span.ts-keyword')?.textContent).toBe('alpha'); // 语法段保留
    handle.destroy();
  });

  it("search('') 清空词级 mark 与全部命中行背景（退出搜索语义）", async () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('beta one\nplain\n'), host, { highlight: false });
    await handle.search('beta');
    expect(host.querySelector('mark.vv-search-hit')).not.toBeNull();
    await handle.search('');
    expect(host.querySelector('mark.vv-search-hit')).toBeNull();
    expect(host.querySelector('.vv-search-hit-line')).toBeNull();
    handle.destroy();
  });

  it('caseSensitive 透传：默认不敏感 vs 严格敏感命中数不同，缓存按 query×case 双键', async () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(
      new TextEncoder().encode('Alpha alpha ALPHA\n'),
      host,
      { highlight: false }
    );
    expect((await handle.search('alpha')).length).toBe(3);
    expect((await handle.search('alpha', { caseSensitive: true })).map((m) => m.start)).toEqual([6]);
    expect((await handle.search('alpha')).length).toBe(3); // 切回不敏感：不复用敏感缓存
    handle.destroy();
  });
});

// ---------- BUG-09：revealLine（全局搜索跳转定位） ----------

describe('renderCode revealLine（BUG-09）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function stubResizeObserver(): void {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  }

  it('跳到目标行：滚至视口中部（未布局回落贴顶）+ 行级 active 高亮，无需先 search', async () => {
    vi.useFakeTimers();
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(
      new TextEncoder().encode('l0\nl1\nl2\nl3\nl4\n'),
      host,
      { highlight: false }
    );
    handle.revealLine(3, 1); // col 参数预留，不参与
    expect(handle.getScrollHost().scrollTop).toBe(3 * 20 - 0 + 10); // clientHeight=0 → 贴顶
    const row = host.querySelector('[data-line="3"]');
    expect(row?.classList.contains('vv-search-hit-line-active')).toBe(true);
    expect(row?.classList.contains('vv-search-hit-line')).toBe(true);
    // 1.5s 超时后 active 消退（非搜索命中行：行级背景一并消退）
    vi.advanceTimersByTime(1500);
    expect(host.querySelector('.vv-search-hit-line-active')).toBeNull();
    expect(host.querySelector('[data-line="3"]')?.classList.contains('vv-search-hit-line')).toBe(false);
    handle.destroy();
  });

  it('越界/非整数行号静默无副作用', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(new TextEncoder().encode('a\nb\n'), host, { highlight: false });
    expect(() => handle.revealLine(99)).not.toThrow();
    expect(() => handle.revealLine(-1)).not.toThrow();
    expect(() => handle.revealLine(1.5)).not.toThrow();
    expect(host.querySelector('.vv-search-hit-line')).toBeNull();
    handle.destroy();
  });
});

// ---------- 阶段 4：lazy 路径（>2MB 可视区 chunk 懒高亮） ----------

describe('renderCode lazy 本地 chunk 管线', () => {
  afterEach(() => {
    attachHighlightClient(null);
    attachHighlightRouter(null);
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  function stubResizeObserver(): void {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  }

  /** >2MB（lazy 策略区间）的多行 js 文本：13B/行，约 16 万行 */
  function lazyJsBuffer(): Uint8Array {
    const line = 'const a = 1;\n';
    return new TextEncoder().encode(line.repeat(Math.ceil((TREE_SITTER_MAX_BYTES + 1) / line.length)));
  }

  it('本地 worker chunk：按 200 行对齐请求（ctx.chunk 标注），区间相对子文本平移到绝对行', async () => {
    stubResizeObserver();
    const calls: Array<{ chunk?: { startLine: number; lineCount: number } }> = [];
    attachHighlightClient({
      highlight: async (_text, _lang, ctx) => {
        calls.push({ chunk: ctx?.chunk });
        return [{ start: 0, end: 5, capture: 'keyword' }]; // chunk 内行 0 的 'const'
      }
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(lazyJsBuffer(), host, { ext: 'js', lang: 'javascript' });
    await vi.waitFor(() => expect(handle.getEngine()).toBe('tree-sitter'));
    expect(handle.getComputeWhere()).toBe('local');
    // 初始可视窗口（jsdom 高度 0 → ~30 行）落在 chunk 0：只请求这一个 chunk
    expect(calls).toHaveLength(1);
    expect(calls[0]!.chunk).toEqual({ startLine: 0, lineCount: 200 });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-line="0"] .ts-keyword')?.textContent).toBe('const');
    });
    handle.destroy();
  });

  it('engine 实时值：lazy 渲染即 pending，首 chunk 到达置 tree-sitter', async () => {
    stubResizeObserver();
    let resolveChunk!: (v: HighlightInterval[]) => void;
    attachHighlightClient({
      highlight: () => new Promise<HighlightInterval[]>((res) => { resolveChunk = res; })
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(lazyJsBuffer(), host, { ext: 'js', lang: 'javascript' });
    expect(handle.getEngine()).toBe('pending');
    resolveChunk([{ start: 0, end: 5, capture: 'keyword' }]);
    await vi.waitFor(() => expect(handle.getEngine()).toBe('tree-sitter'));
    handle.destroy();
  });

  it('滚动连发串行化：单在-flight（同语言 pendingByLang 去重的渲染侧防线），最新窗口优先', async () => {
    stubResizeObserver();
    let active = 0;
    let maxActive = 0;
    const chunkStarts: number[] = [];
    attachHighlightClient({
      highlight: async (_text, _lang, ctx) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        chunkStarts.push(ctx?.chunk?.startLine ?? -1);
        return [];
      }
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(lazyJsBuffer(), host, { ext: 'js', lang: 'javascript' });
    handle.revealLine(5000);
    handle.revealLine(12000);
    handle.revealLine(80000);
    await vi.waitFor(() => expect(handle.getEngine()).toBe('tree-sitter'));
    await new Promise((r) => setTimeout(r, 80)); // 队列排空
    expect(maxActive).toBe(1); // 串行：任一时刻至多 1 个在-flight chunk
    // 全部按 200 行对齐；过期窗口（5000/12000 处）被裁剪，只补最新窗口（80000 附近）
    expect(chunkStarts.every((s) => s % 200 === 0 && s >= 0)).toBe(true);
    expect(chunkStarts[chunkStarts.length - 1]).toBeGreaterThanOrEqual(79800);
    handle.destroy();
  });

  it('chunk 失败（非取消）→ 该 chunk 行级 hljs 兜底写 hljsChunkCache，engine=hljs', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => {
        throw new Error('wasm boom');
      }
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(lazyJsBuffer(), host, { ext: 'js', lang: 'javascript' });
    await vi.waitFor(() => expect(handle.getEngine()).toBe('hljs'));
    expect(handle.getComputeWhere()).toBe('local');
    expect(host.querySelector('[data-line="0"] [class*="hljs-"]')).not.toBeNull();
    handle.destroy();
  });

  it('chunk 取消（HighlightCanceledError）→ 只逐出在-flight，不写 hljs 兜底、不自续（取消≠失败）', async () => {
    stubResizeObserver();
    let calls = 0;
    attachHighlightClient({
      highlight: async () => {
        calls++;
        throw new HighlightCanceledError(); // HL-09 tab 切换 cancelAll 的下游形态
      }
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(lazyJsBuffer(), host, { ext: 'js', lang: 'javascript' });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1); // 无重试风暴：取消后等下次 onRange 再发
    expect(host.innerHTML).not.toContain('hljs-'); // hljs 兜底不得首写（否则永久遮蔽 tree-sitter 质量）
    expect(handle.getEngine()).toBe('pending');
    handle.destroy();
  });

  it('搜索叠加兼容：词级 mark 与 chunk 语法 span 共存（经 lineHtml 统一入口）', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => [{ start: 0, end: 5, capture: 'keyword' }]
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(lazyJsBuffer(), host, { ext: 'js', lang: 'javascript' });
    await vi.waitFor(() => expect(handle.getEngine()).toBe('tree-sitter'));
    await handle.search('a = 1');
    const body = host.querySelector('[data-line="0"] .vv-code-body')!;
    expect(body.querySelector('mark.vv-search-hit')?.textContent).toBe('a = 1');
    expect(body.querySelector('span.ts-keyword')?.textContent).toBe('const');
    handle.destroy();
  });
});

describe('renderCode lazy 服务端 range 路由（阶段 4 契约，接替 BUG-10 整文件路由）', () => {
  afterEach(() => {
    attachHighlightClient(null);
    attachHighlightRouter(null);
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  function stubResizeObserver(): void {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
  }

  function lazyJsBuffer(): Uint8Array {
    const line = 'const a = 1;\n';
    return new TextEncoder().encode(line.repeat(Math.ceil((TREE_SITTER_MAX_BYTES + 1) / line.length)));
  }

  it('server-served：router 收到 (src, lang, range)，{intervals, baseLine} 平移到绝对行（where=remote），本地 worker 不被问', async () => {
    stubResizeObserver();
    // 每 chunk 返回「chunk 内行 40（偏移 520）的 'const'」区间，baseLine 回显请求 startLine
    const router = vi.fn(async (_src, _lang, range?: { startLine: number; lineCount: number }) => ({
      intervals: [{ start: 520, end: 525, capture: 'keyword' } as HighlightInterval],
      baseLine: range?.startLine ?? 0
    }));
    attachHighlightRouter(router);
    const clientSpy = vi.fn(async () => [] as HighlightInterval[]);
    attachHighlightClient({ highlight: clientSpy });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(lazyJsBuffer(), host, {
      ext: 'js',
      lang: 'javascript',
      computeSrc: { path: 'big.js' }
    });
    await vi.waitFor(() => expect(handle.getEngine()).toBe('tree-sitter'));
    expect(handle.getComputeWhere()).toBe('remote');
    expect(router).toHaveBeenCalledWith({ path: 'big.js' }, 'javascript', { startLine: 0, lineCount: 200 });
    // 滚到 chunk 200：请求 range {200,200}，区间按 baseLine=200 平移到绝对行 240
    handle.revealLine(250);
    await vi.waitFor(() => {
      expect(router).toHaveBeenCalledWith({ path: 'big.js' }, 'javascript', { startLine: 200, lineCount: 200 });
      expect(host.querySelector('[data-line="240"] .ts-keyword')?.textContent).toBe('const');
    });
    expect(clientSpy).not.toHaveBeenCalled(); // server-served chunk 失败才落 hljs，不落本地 wasm
    handle.destroy();
  });

  it('router null（auto warn+null 回退门）：该 chunk 行级 hljs，不回落本地 wasm', async () => {
    stubResizeObserver();
    attachHighlightRouter(async () => null);
    const clientSpy = vi.fn(async () => [] as HighlightInterval[]);
    attachHighlightClient({ highlight: clientSpy });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(lazyJsBuffer(), host, {
      ext: 'js',
      lang: 'javascript',
      computeSrc: { path: 'big.js' }
    });
    await vi.waitFor(() => expect(handle.getEngine()).toBe('hljs'));
    expect(handle.getComputeWhere()).toBe('local');
    expect(host.querySelector('[data-line="0"] [class*="hljs-"]')).not.toBeNull();
    expect(clientSpy).not.toHaveBeenCalled();
    handle.destroy();
  });

  it('router 抛错（显式 remote 失败）：错误卡片，不静默降级，engine 置非 pending 终值', async () => {
    stubResizeObserver();
    attachHighlightRouter(async () => {
      throw new Error('远程高亮失败: HTTP 500');
    });
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(lazyJsBuffer(), host, {
      ext: 'js',
      lang: 'javascript',
      computeSrc: { path: 'big.js' }
    });
    await vi.waitFor(() => expect(host.querySelector('.vv-error-card')).not.toBeNull());
    expect(host.querySelector('.vv-error-card')?.textContent).toContain('HTTP 500');
    expect(host.innerHTML).not.toContain('hljs-');
    expect(handle.getEngine()).toBe('plain');
    expect(handle.getComputeWhere()).toBeNull();
    handle.destroy();
  });

  it('lang 未知：不问路由，行级 hljs（highlightAuto）chunk', async () => {
    stubResizeObserver();
    const router = vi.fn(async () => null as never);
    attachHighlightRouter(router);
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(lazyJsBuffer(), host, {
      ext: 'unknownext',
      computeSrc: { path: 'big.unknownext' }
    });
    await vi.waitFor(() => expect(handle.getEngine()).toBe('hljs'));
    expect(router).not.toHaveBeenCalled();
    expect(handle.getComputeWhere()).toBe('local');
    handle.destroy();
  });
});
