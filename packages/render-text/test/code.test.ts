import { describe, it, expect, vi, afterEach } from 'vitest';
import hljs from 'highlight.js';
import { HighlightCanceledError } from '@vviewer/highlight';
import { RemoteComputeError, type ComputeWhere, type FileSource, type RenderedInstance, type StreamCtx } from '@vviewer/core';
import { STREAM_MAX_BYTES } from '../src/blockStream';
import * as searchModule from '../src/search';
import { searchCode as originalSearchCode } from '../src/search';
import {
  buildLineIndex,
  buildLineOffsets,
  splitHighlightedLines,
  resolveStrategy,
  assignIntervalsToLines,
  renderLineHtml,
  renderCode,
  codeRenderer,
  codeWindowedPumpControls,
  attachHighlightClient,
  waitForAttachedClient,
  __resetAttachPhaseForTest,
  attachHighlightRouter,
  evictOldestEntries,
  evictChunksByLines,
  capChunkCoverage,
  isAbortError,
  CHUNK_COVERAGE_MAX_ENTRIES,
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
  type CodeEngine,
  type CodeFileMeta,
  type HighlightInterval,
} from '../src/code';

// 模块求值期捕获原始函数值（任何 spyOn 之前 → 必为原函数；ES import 声明提升，
// 求值时 ../src/search 命名空间尚未被改写）。named import 是活绑定：spyOn 改写
// 命名空间后 `originalSearchCode(...)` 会路由回 spy（双层 spy 帧，真实函数永不
// 执行）；需真实透传的 mock 须用此常量，不能用 named import。
const REAL_SEARCH_CODE = searchModule.searchCode;

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

// R-1：chunkCoverage 与 chunk 缓存逐出联动加界——512MB 流式上限 × 短行下条目数
// 无界增长收口为常量上限；被清条目的 chunk 由 hasChunkData 未处理面兜底重发
describe('capChunkCoverage（chunkCoverage 条目加界，R-1）', () => {
  it('超出上限按插入序清最旧，恰好收敛到上限', () => {
    const m = new Map<number, number>();
    for (let i = 0; i < CHUNK_COVERAGE_MAX_ENTRIES + 500; i++) m.set(i * CHUNK_LINES, CHUNK_LINES);
    capChunkCoverage(m);
    expect(m.size).toBe(CHUNK_COVERAGE_MAX_ENTRIES);
    expect(m.has(0)).toBe(false); // 最旧的 500 条已清
    expect([...m.keys()][0]).toBe(500 * CHUNK_LINES);
    expect([...m.keys()][CHUNK_COVERAGE_MAX_ENTRIES - 1]).toBe(
      (CHUNK_COVERAGE_MAX_ENTRIES + 499) * CHUNK_LINES
    );
  });
  it('未超上限不动；上限常量为 4096 条（≈82 万行覆盖窗口，足够滚回复用）', () => {
    const m = new Map<number, number>([[0, CHUNK_LINES], [CHUNK_LINES, CHUNK_LINES]]);
    capChunkCoverage(m);
    expect(m.size).toBe(2);
    expect(CHUNK_COVERAGE_MAX_ENTRIES).toBe(4096);
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

  // attach 竞态（P2 CDN 层：create() 含真实网络 fetch，预热不再保证早于首开）：
  // start() 时 client 未注入须等待而非直接 hljs 兜底（否则首开文件引擎永久错锁）

  it('attach 晚于渲染启动：等待注入后落 tree-sitter，不错锁 hljs', async () => {
    __resetAttachPhaseForTest(); // 前序用例 afterEach 已 attach(null)（failed 终态）：重建 pending 竞态窗口
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    // 渲染启动时未 attach（模拟 boot 期资产链未完成），10ms 后注入
    const handle = renderCode(new TextEncoder().encode('let x'), host, { ext: 'rs', lang: 'rust' });
    setTimeout(() => {
      attachHighlightClient({ highlight: async () => [{ start: 0, end: 3, capture: 'keyword' }] });
    }, 10);
    await vi.waitFor(() => {
      expect(handle.getEngine()).toBe('tree-sitter');
    });
    expect(host.querySelector('.ts-keyword')?.textContent).toBe('let');
    handle.destroy();
  });

  it('waitForAttachedClient：已 attach 即刻返回', async () => {
    const fake = { highlight: async () => [] };
    attachHighlightClient(fake);
    await expect(waitForAttachedClient(1)).resolves.toBe(fake);
  });

  it('waitForAttachedClient：attach(null)（创建失败解绑，failed 终态）即刻以 null 放行', async () => {
    const pending = waitForAttachedClient(1000);
    attachHighlightClient(null);
    await expect(pending).resolves.toBeNull();
    // 终态语义：解绑后不再等待（降级路径不占超时）
    const t0 = Date.now();
    await expect(waitForAttachedClient(1000)).resolves.toBeNull();
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('waitForAttachedClient：pending 相位超时以当前值放行（兜底创建期永久挂起）', async () => {
    __resetAttachPhaseForTest(); // pending：无 attach 也无 failed 终态
    const pending = waitForAttachedClient(20);
    const client = await pending;
    expect(client).toBeNull();
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

// ---------- deferred 清偿 Task 5：lineAtOffset（全量模式偏移 → 物理行号） ----------
//
// jsonl 委托降级锚行映射的上游接口：jsonl 侧锚行字节偏移（index.offsets[anchorLine]
// + bomLen）经本方法二分换算为 code 物理行号再 revealLine。实现前 handle 类型尚无
// 此方法，测试统一走鸭子探测（类型中立写法）。

describe('renderCode lineAtOffset（deferred 清偿 Task 5：仅全量模式）', () => {
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

  function lineAtOffsetOf(handle: ReturnType<typeof renderCode>): ((o: number) => number) | undefined {
    return (handle as { lineAtOffset?: (o: number) => number }).lineAtOffset;
  }

  it('行起始/行中/恰在换行符上 → 本行；下一行起始 → 下一行；超文件尾钳末行', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    // 'ab\ncd\n\nef\n'：归一文本行表 ['ab','cd','','ef','']，行起始 [0,3,6,7,10]
    const handle = renderCode(enc('ab\ncd\n\nef\n'), host, { highlight: false });
    const lineAtOffset = lineAtOffsetOf(handle);
    expect(lineAtOffset, '全量模式 handle 应提供 lineAtOffset').toBeTypeOf('function');
    if (lineAtOffset === undefined) return;
    expect(lineAtOffset.call(handle, 0)).toBe(0); // 首行起始
    expect(lineAtOffset.call(handle, 1)).toBe(0); // 行中
    expect(lineAtOffset.call(handle, 2)).toBe(0); // 恰在行尾换行符上：未达下一行起始，归本行
    expect(lineAtOffset.call(handle, 3)).toBe(1); // 恰在下一行起始
    expect(lineAtOffset.call(handle, 6)).toBe(2); // 空行起始（含空行文件锚点不漂移的关键面）
    expect(lineAtOffset.call(handle, 7)).toBe(3);
    expect(lineAtOffset.call(handle, 10)).toBe(4); // trailing \n 后的末空串元素
    expect(lineAtOffset.call(handle, 99)).toBe(4); // 超文件尾：钳末行
    handle.destroy();
  });

  it('BOM 前缀：偏移以剥 BOM 后文本为基准（TextDecoder 现状口径）', () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = enc('ab\ncd\n');
    const buf = new Uint8Array(bom.length + body.length);
    buf.set(bom, 0);
    buf.set(body, bom.length);
    const handle = renderCode(buf, host, { highlight: false });
    const lineAtOffset = lineAtOffsetOf(handle);
    expect(lineAtOffset, '全量模式 handle 应提供 lineAtOffset').toBeTypeOf('function');
    if (lineAtOffset === undefined) return;
    expect(lineAtOffset.call(handle, 0)).toBe(0); // 剥 BOM 后 'ab' 行起始
    expect(lineAtOffset.call(handle, 3)).toBe(1); // 'cd' 行起始
    handle.destroy();
  });

  it('空文件偏移钳 0；窗口流式模式不暴露 lineAtOffset（仅全量形态有 lineOffsets）', async () => {
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const empty = renderCode(enc(''), host, { highlight: false });
    const emptyFn = lineAtOffsetOf(empty);
    expect(emptyFn, '空文件（全量模式）同样应提供 lineAtOffset').toBeTypeOf('function');
    if (emptyFn !== undefined) expect(emptyFn.call(empty, 123)).toBe(0);
    empty.destroy();

    const content = enc(codeLines(40)); // 60KB：单块窗口
    const win = renderCode(content.slice(0, 8192), host, {
      highlight: false,
      ctx: streamCtx({ size: content.length, content, head: content.slice(0, 8192) })
    });
    expect(lineAtOffsetOf(win), '窗口模式无全量 lineOffsets，不暴露 lineAtOffset').toBeUndefined();
    win.destroy();
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

  it('attach 晚于渲染启动：懒 chunk 等待注入后落 tree-sitter，不错锁 hljs 兜底', async () => {
    // CDN 构建竞态（BUG-20/HL-03/FSEARCH-02/m2 家族）：attach 前泵入 hljsChunk 会
    // 双锁——hljsChunkCache 使该 chunk 永不重发 tree-sitter 且 engine 锁定 'hljs'
    __resetAttachPhaseForTest(); // 前序用例 afterEach 已 attach(null)：重建 pending 竞态窗口
    stubResizeObserver();
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(lazyJsBuffer(), host, { ext: 'js', lang: 'javascript' });
    expect(handle.getEngine()).toBe('pending');
    setTimeout(() => {
      attachHighlightClient({
        highlight: async () => [{ start: 0, end: 5, capture: 'keyword' }]
      });
    }, 10);
    await vi.waitFor(() => expect(handle.getEngine()).toBe('tree-sitter'));
    expect(handle.getComputeWhere()).toBe('local');
    await vi.waitFor(() => {
      expect(host.querySelector('[data-line="0"] .ts-keyword')?.textContent).toBe('const');
    });
    expect(host.querySelector('[data-line="1"] .hljs-keyword')).toBeNull(); // 未落行级 hljs 兜底
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

  it('旧服务端 wholeFile 应答（baseLine=0 整文件区间）：入库裁剪到请求窗口行，不触发重复请求（自抖动回归锚）', async () => {
    stubResizeObserver();
    const buf = lazyJsBuffer(); // ~16 万行，> CHUNK_CACHE_MAX_LINES(5000)
    // 旧服务端契约形状：不感知 range → 整文件单区间 + baseLine=0（>5000 高亮行大文件形态）
    const router = vi.fn(async () => ({
      intervals: [{ start: 0, end: buf.length, capture: 'keyword' } as HighlightInterval],
      baseLine: 0
    }));
    attachHighlightRouter(router);
    const host = document.createElement('div');
    document.body.append(host);
    const handle = renderCode(buf, host, { ext: 'js', lang: 'javascript', computeSrc: { path: 'big.js' } });
    await vi.waitFor(() => expect(handle.getEngine()).toBe('tree-sitter'));
    // 首窗口恰请求一次（chunk 0），窗口行着色
    expect(router).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-line="0"] .ts-keyword')).not.toBeNull();
    // 同 chunk 内移动可视区（行 150 仍在 [0,200)）：chunk 0 裁剪后仅 200 行不被
    // evictChunksByLines 逐出 → 不重发。修前整文件条目（16 万行）超限被整块逐出，
    // 下一次 onRange 必重发全文件请求（写入→逐出→重发无限自抖动）
    handle.revealLine(150);
    await new Promise((r) => setTimeout(r, 40));
    expect(router).toHaveBeenCalledTimes(1);
    // 跨 chunk 窗口照常请求（(240,260) 经 chunkRangeFor 恰落 chunk 200 单 chunk）；
    // 应答同样裁剪到自身窗口 [200,400)——行 250 的着色来自窗口切片，非整文件条目泄漏
    handle.revealLine(250);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-line="250"] .ts-keyword')).not.toBeNull();
    });
    expect(router).toHaveBeenCalledTimes(2);
    // 回到 chunk 0 窗口：缓存仍在（未逐出），不重发
    handle.revealLine(10);
    await new Promise((r) => setTimeout(r, 40));
    expect(router).toHaveBeenCalledTimes(2);
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

// ---------------------------------------------------------------------------
// 窗口流式模式（io-streaming 计划 3 Task 4：ctx + UTF-8 流式索引 + textWindow
// 窗口解码 + lazy 高亮按已构建索引 + STREAM_MAX_BYTES 防线）
// ---------------------------------------------------------------------------

/** 窗口模式块大小（与实现 CODE_WINDOW_BLOCK_BYTES 同值；实现侧为模块私有常量） */
const WINDOW_BLOCK = 256 * 1024;

interface RangeCall {
  start: number;
  end: number;
}

/** fake StreamCtx（jsonl-render.test.ts 同款）：content 为底层全量数据，read 记录区间 */
function streamCtx(opts: {
  size: number | null;
  content: Uint8Array<ArrayBuffer>;
  head?: Uint8Array<ArrayBuffer>;
  calls?: RangeCall[];
  /** 模拟 Range-less 服务器：任何区间都回全量（BlockStream 200-回退触发形态） */
  ignoreRange?: boolean;
}): StreamCtx {
  return {
    size: opts.size,
    head: opts.head ?? new Uint8Array(0),
    read: async (r) => {
      opts.calls?.push({ start: r.start, end: r.end });
      return opts.ignoreRange ? opts.content.slice(0) : opts.content.slice(r.start, r.end + 1);
    }
  };
}

const enc = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

/** 固定字长代码行（行内嵌行号供内容定位断言；每行含 \n 恰 lineBytes 字节） */
function codeLines(n: number, lineBytes = 1500): string {
  return Array.from({ length: n }, (_, i) => {
    const head = `const a = ${i}; // `;
    return head + 'x'.repeat(Math.max(0, lineBytes - head.length - 1)) + '\n';
  }).join('');
}

/** gb18030 字节串构造（jsonl-render.test.ts 同款极简表：'中'=0xd6 0xd0） */
function gbBytes(rows: string[]): Uint8Array<ArrayBuffer> {
  const parts: number[] = [];
  for (const row of rows) {
    for (const ch of row) {
      if (ch === '中') parts.push(0xd6, 0xd0);
      else parts.push(...new TextEncoder().encode(ch));
    }
    parts.push(0x0a);
  }
  return Uint8Array.from(parts);
}

const winSource: FileSource = {
  storeId: 'local',
  storeLabel: 'local',
  path: '/big.js',
  name: 'big.js',
  store: {} as FileSource['store']
};

/** codeRenderer.render 按 Renderer 接口返回 RenderedInstance；code 扩展为鸭子形态 */
type CodeInstance = RenderedInstance & {
  getEngine(): CodeEngine;
  getComputeWhere(): ComputeWhere | null;
  getMeta(): CodeFileMeta;
  revealLine(line: number, col?: number): void;
};

function newHost(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  return host;
}

/** code 的滚动容器即 .vv-code-pre（virtualScroller 监听其 scroll） */
function scrollCode(host: HTMLElement, top: number): void {
  const pre = host.querySelector('.vv-code-pre') as HTMLElement;
  pre.scrollTop = top;
  pre.dispatchEvent(new Event('scroll'));
}

function preHtml(host: HTMLElement): string {
  return (host.querySelector('.vv-code-pre') as HTMLElement).innerHTML;
}

function bodyText(host: HTMLElement, line: number): string | undefined {
  return host.querySelector(`[data-line="${line}"] .vv-code-body`)?.textContent ?? undefined;
}

describe('renderCode 窗口流式模式（ctx + UTF-8）', () => {
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

  /** 泵测试开关（BUG-201 后台索引泵引入后的重定基手段）：pause 冻结后台推进，
   * 使既有「首屏最小 IO / 滚动驱动续读 / 扫描自驱动 IO」契约用例逐字保持可断言
   * ——这些用例的期望面（首块后 174 行、读计数、渐进时序）正是泵所改变的行为。 */
  function pausePump(handle: ReturnType<typeof renderCode>): void {
    codeWindowedPumpControls.get(handle)!.pause();
  }

  it('首屏只读 head+首块（8KB 部分块整块重拉，零全量 read）；行文本经窗口解码正确；getMeta lines 为已加载行数', async () => {
    stubResizeObserver();
    const content = enc(codeLines(400)); // 600KB ≈ 2.3 块
    const calls: RangeCall[] = [];
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, {
      ext: 'js',
      lang: 'javascript',
      ctx: streamCtx({ size: null, content, head: content.slice(0, 8192), calls })
    });
    pausePump(handle); // 冻结后台泵：本用例锁「首屏最小 IO、不滚动零续读」契约面
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    expect(bodyText(host, 0)!.startsWith('const a = 0; // ')).toBe(true);
    expect(bodyText(host, 12)!.startsWith('const a = 12;')).toBe(true); // 视口内行（jsdom 高度 0 → ~20+ 行窗口）
    expect(calls).toStrictEqual([{ start: 0, end: WINDOW_BLOCK - 1 }]); // 仅首块
    // 262144/1500：行 0..173 的终结符在首块内（行 174 跨块未提交）——已加载行数
    expect(handle.getMeta().lines).toBe(174);
    expect(handle.getMeta().size).toBe(WINDOW_BLOCK); // size 未知：已确认字节
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1); // 首屏远离已加载尾部：不触发续读
    handle.destroy();
  });

  it('双模式 DOM 逐字节一致（BOM/CRLF/空行/空白行/跨块多字节/巨行/孤立 CR/无尾换行；「中」与 emoji 骑块切口；lazy chunk 高亮同构）', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => [{ start: 0, end: 5, capture: 'keyword' }] // chunk 内 [0,5) 恒为 'const'/'let x' 等行首
    });
    const LINE = 'const a = 0;\n'; // 13B
    const parts: string[] = [];
    let cur = 0;
    const push = (s: string): void => {
      parts.push(s);
      cur += enc(s).length;
    };
    const fillTo = (target: number): void => {
      const gap = target - cur;
      expect(gap).toBeGreaterThanOrEqual(0);
      const full = Math.floor(gap / LINE.length);
      for (let i = 0; i < full; i++) push(LINE);
      const rem = gap - full * LINE.length;
      if (rem > 0) push('x'.repeat(rem - 1) + '\n'); // 调整行
    };
    push('\uFEFFconst head = 1;\r\n\n   \n'); // BOM + CRLF 行 + 空行 + 纯空白行
    fillTo(WINDOW_BLOCK - 5);
    push('let 中 = 1;\n'); // 13B：「中」(E4 B8 AD) 首字节恰在块 0 末字节
    fillTo(2 * WINDOW_BLOCK - 7);
    push('const 🎉 = 2;\n'); // 16B：🎉 首字节恰在块 1 末字节
    fillTo(4 * WINDOW_BLOCK - 1000);
    push('/* ' + '巨'.repeat(100_000) + ' */\n'); // 300KB 巨行跨块 4 边界（索引单条目 + gather 拼装）
    push('old\rnew\r'); // 孤立 CR 两个终结符
    fillTo(2_100_000);
    push('const end = 1;'); // 悬挂尾行（无尾换行）
    const bytes = enc(parts.join(''));
    expect(bytes[WINDOW_BLOCK - 1]).toBe(0xe4); // 「中」首字节骑在块 0 切口
    expect(bytes[WINDOW_BLOCK]).toBe(0xb8);
    expect(bytes[2 * WINDOW_BLOCK - 1]).toBe(0xf0); // 🎉 首字节骑在块 1 切口
    expect(bytes.length).toBeGreaterThan(TREE_SITTER_MAX_BYTES); // 双模式同为 lazy 策略

    const hostA = newHost();
    const instA = renderCode(bytes, hostA, { ext: 'js', lang: 'javascript' }); // 全量模式（无 ctx）
    const hostB = newHost();
    const instB = renderCode(bytes.slice(0, 8192), hostB, {
      ext: 'js',
      lang: 'javascript',
      ctx: streamCtx({ size: bytes.length, content: bytes, head: bytes.slice(0, 8192) })
    });
    pausePump(instB); // B 冻结泵：与 A 同为滚动驱动口径，逐字节比对不受后台推进扰动
    await vi.waitFor(() => expect(instA.getEngine()).toBe('tree-sitter'));
    await vi.waitFor(() => expect(instB.getEngine()).toBe('tree-sitter'));
    // 先双双滚到底：B 经续读排空到 EOF（spacer 总行数与 meta 与 A 一致）后再比对
    scrollCode(hostA, Number.MAX_SAFE_INTEGER);
    scrollCode(hostB, Number.MAX_SAFE_INTEGER);
    await vi.waitFor(() => expect(instB.getMeta().lines).toBe(instA.getMeta().lines)); // EOF 且 wc-l 口径一致
    expect(instB.getMeta().size).toBe(instA.getMeta().size);
    // 底部窗口逐字节一致（悬挂尾行 + 行级渐进 chunk 的覆盖率补齐收敛）
    await vi.waitFor(() => expect(preHtml(hostB)).toBe(preHtml(hostA)));
    // 回顶部（「中」/emoji 骑切口行 + chunk 覆盖率重发收敛）
    scrollCode(hostA, 0);
    scrollCode(hostB, 0);
    await vi.waitFor(() => expect(preHtml(hostB)).toBe(preHtml(hostA)));
    // 中部（巨行所在窗口：跨块 gather 解码）
    scrollCode(hostA, 1_600_000);
    scrollCode(hostB, 1_600_000);
    await vi.waitFor(() => expect(preHtml(hostB)).toBe(preHtml(hostA)));
    // 再回顶部（窗口侧行进中缓存的自然回看）
    scrollCode(hostA, 0);
    scrollCode(hostB, 0);
    await vi.waitFor(() => expect(preHtml(hostB)).toBe(preHtml(hostA)));
    instA.destroy();
    instB.destroy();
  });

  it('size≤2MB 走全量 tree-sitter：renderer 入口守卫补拉全量恰一次 {0,MAX}（8KB 探测头不得静默截断）；head 覆盖全文件时零额外读', async () => {
    stubResizeObserver();
    attachHighlightClient({ highlight: async () => [{ start: 0, end: 5, capture: 'keyword' }] });
    const content = enc(codeLines(1000)); // 1.5MB：>1MB 交付形态=探测头，≤2MB=全量路径
    const calls: RangeCall[] = [];
    const host = newHost();
    const inst = (await codeRenderer.render(content.slice(0, 8192), host, winSource,
      { ext: 'js', encoding: 'utf-8', lang: 'javascript' },
      streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls }))) as CodeInstance;
    expect(calls).toStrictEqual([{ start: 0, end: Number.MAX_SAFE_INTEGER }]); // 守卫补拉全量
    expect(inst.getEngine()).toBe('tree-sitter');
    expect(inst.getMeta()).toMatchObject({ encoding: 'utf-8', size: content.length, lines: 1000 });
    inst.revealLine(999); // 全量在手：跳转渲染视口外行（非 8KB 截断）
    expect(bodyText(host, 999)!.startsWith('const a = 999;')).toBe(true);
    inst.destroy();

    // head 即全量（dispatcher ≤1MB 直读形态）：守卫不触发，零额外读
    const calls2: RangeCall[] = [];
    const host2 = newHost();
    const inst2 = (await codeRenderer.render(content, host2, winSource,
      { ext: 'js', encoding: 'utf-8', lang: 'javascript' },
      streamCtx({ size: content.length, content, head: content, calls: calls2 }))) as CodeInstance;
    expect(calls2).toStrictEqual([]);
    expect(inst2.getEngine()).toBe('tree-sitter');
    inst2.destroy();
  });

  it('size>2MB 走窗口流式（streaming 声明 + renderer 透传 ctx）：首块索引即可渲染，lazy chunk 高亮按窗口文本工作', async () => {
    stubResizeObserver();
    expect(codeRenderer.streaming).toBe(true); // dispatcher 只交付 head + StreamCtx
    const text = codeLines(1400); // 2.1MB > 2MB
    const content = enc(text);
    const calls: RangeCall[] = [];
    const chunkCalls: Array<{ text: string; chunk?: { startLine: number; lineCount: number } }> = [];
    attachHighlightClient({
      highlight: async (t, _lang, hctx) => {
        chunkCalls.push({ text: t, chunk: hctx?.chunk });
        return [{ start: 0, end: 5, capture: 'keyword' }];
      }
    });
    const host = newHost();
    const inst = (await codeRenderer.render(content.slice(0, 8192), host, winSource,
      { ext: 'js', encoding: 'utf-8', lang: 'javascript' },
      streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls }))) as CodeInstance;
    expect(calls).toStrictEqual([{ start: 0, end: WINDOW_BLOCK - 1 }]); // 窗口模式：无全量 read
    await vi.waitFor(() => expect(inst.getEngine()).toBe('tree-sitter'));
    expect(inst.getComputeWhere()).toBe('local');
    // chunk 按已构建索引渐进：首块后 rows()=174 → 首请求 174 行（索引驱动边界）
    expect(chunkCalls[0]!.chunk).toEqual({ startLine: 0, lineCount: 174 });
    // chunk 行文本来自窗口解码（非 8KB 截断面）
    expect(chunkCalls[0]!.text).toBe(text.split('\n').slice(0, 174).join('\n'));
    expect(host.querySelector('[data-line="0"] .ts-keyword')?.textContent).toBe('const');
    expect(inst.getMeta().size).toBe(content.length);
    // 续读到 EOF 后回顶部：chunk 0 覆盖率裁决（174 < 200）触发重发，补齐 chunk 尾段高亮
    scrollCode(host, Number.MAX_SAFE_INTEGER);
    await vi.waitFor(() => expect(inst.getMeta().lines).toBe(1400));
    scrollCode(host, 0);
    await vi.waitFor(() => {
      expect(chunkCalls.some((c) => c.chunk?.startLine === 0 && c.chunk.lineCount === 200)).toBe(true);
    });
    const refilled = chunkCalls.find((c) => c.chunk?.startLine === 0 && c.chunk.lineCount === 200)!;
    expect(refilled.text).toBe(text.split('\n').slice(0, 200).join('\n'));
    inst.destroy();
  });

  // 首拉失败面（codeRenderer.render 收口）：窗口模式 whenReady（start 的首块拉取）
  // 失败 → 销毁半装配实例后原样 rethrow——dispatcher 已把 ctx.read 失败标为
  // DispatchReadError，走调用方读取失败面（无「错误卡片 + 重试」通道）。本用例在
  // 渲染器层钉：render promise rejects（错误实例身份不变）且 target 无 .vv-code-pre
  // 残留（destroy 已执行，无空壳 scroller/DOM 泄漏）。
  it('首拉失败（首块 read 即 reject）：render rejects 且销毁半装配实例（无 .vv-code-pre 残留）', async () => {
    stubResizeObserver();
    const content = enc(codeLines(400));
    const boom = new Error('首块网络故障');
    const ctx: StreamCtx = {
      size: null,
      head: content.slice(0, 8192),
      read: async () => {
        throw boom; // 首调即失败：拉取面无任何成功字节
      }
    };
    const host = newHost();
    await expect(
      codeRenderer.render(content.slice(0, 8192), host, winSource,
        { ext: 'js', encoding: 'utf-8', lang: 'javascript' }, ctx)
    ).rejects.toBe(boom); // 原样上抛（调用方按 DispatchReadError 口径识别）
    expect(host.querySelector('.vv-code-pre')).toBeNull(); // destroy 已执行：半装配实例无 DOM 残留
  });

  it('getMeta().lines 动态：首块后为已加载行数，滚动续读到 EOF 后=内容行数（末尾空串条目展示层减 1，wc-l 口径）', async () => {
    stubResizeObserver();
    const content = enc(codeLines(400)); // 600KB，以 \n 收尾
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, {
      ext: 'js',
      lang: 'javascript',
      ctx: streamCtx({ size: content.length, content, head: content.slice(0, 8192) })
    });
    pausePump(handle); // 冻结泵：首块 174 / 滚动续读到 400 的动态口径逐字保留
    expect(handle.getMeta().lines).toBe(0); // 同步构造期：首拉未落地（异步 start）
    await vi.waitFor(() => expect(handle.getMeta().lines).toBe(174)); // 首块已加载行数
    scrollCode(host, Number.MAX_SAFE_INTEGER);
    await vi.waitFor(() => expect(handle.getMeta().lines).toBe(400)); // 400 非 401（索引层含末尾空串条目，getMeta 展示层减 1）
    // 滚动到底：末视口行 = 末尾空串条目（行 400，与全量 lines.length=401 同构的空行）
    await vi.waitFor(() => expect(host.querySelector('[data-line="400"]')).not.toBeNull());
    expect(bodyText(host, 400)).toBe('');
    // 尾实行走 revealLine（视口上行 399）
    handle.revealLine(399);
    await vi.waitFor(() => expect(bodyText(host, 399)).toBeDefined());
    expect(bodyText(host, 399)!.startsWith('const a = 399;')).toBe(true);
    handle.destroy();
  });

  it('STREAM_MAX_BYTES（512MB）防线：size 超限 → 零读停机 + 提示条（建议 hex，非失败态）+ engine 非 pending 终值', async () => {
    stubResizeObserver();
    const content = enc(codeLines(3, 100));
    const calls: RangeCall[] = [];
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, {
      ext: 'js',
      lang: 'javascript',
      ctx: streamCtx({ size: STREAM_MAX_BYTES + 1, content, head: content.slice(0, 8192), calls })
    });
    expect(calls).toStrictEqual([]); // 防线在 IO 之前：一个块都不拉
    const card = host.querySelector('.vv-code-oversize-card');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('512MB');
    expect(card!.textContent).toContain('hex');
    expect(host.querySelector('.vv-code-pre')).not.toBeNull(); // 提示条与滚动容器并存
    expect(host.querySelector('.vv-code-line')).toBeNull(); // 0 行
    expect(handle.getEngine()).toBe('plain');
    expect(handle.getMeta().lines).toBe(0);
    handle.destroy();
  });

  // 项 5（恰界收紧）：size 未知流式此前 confirmedBytes 超 512MB 后才停（越限一块
  // ≤256KB 才触发 > 判定）；修后达限即停——不发起会越限的块读，恰在 LIMIT 停。
  // 恒满块 fake ctx（无换行索引零行）经 search 扫描自驱动前向喂块至达限，无需真造
  // 512MB 内容。size 已知路径构造期判定不变（恰等于上限的文件可完整流式）。
  it('STREAM_MAX_BYTES 恰界：size 未知达限即停，恰 2048 块、无越限块读', async () => {
    stubResizeObserver();
    const block = new Uint8Array(WINDOW_BLOCK).fill(0x61); // 256KB 无换行：索引零行
    let reads = 0;
    const ctx: StreamCtx = {
      size: null,
      head: new Uint8Array(0),
      read: async () => {
        reads += 1;
        return block; // 恒满块：无短读即无 EOF 证据，confirmedBytes 随每块 +256KB
      }
    };
    const host = newHost();
    const handle = renderCode(block, host, { ext: 'js', lang: 'javascript', ctx });
    await handle.search('zzneedle'); // 扫描自驱动前向喂块至达限停机（部分结果收场）
    expect(reads).toBe(STREAM_MAX_BYTES / WINDOW_BLOCK); // 恰 2048（修前 2049：越限一块）
    expect(handle.getMeta().size).toBe(STREAM_MAX_BYTES); // size 未知：已确认字节停在恰界
    await new Promise((r) => setTimeout(r, 30));
    expect(reads).toBe(STREAM_MAX_BYTES / WINDOW_BLOCK); // 停机：无进一步读
    expect(host.querySelector('.vv-code-oversize-card')).not.toBeNull(); // 提示条（建议 hex）
    handle.destroy();
  }, 20_000); // 整用例显式超时：2048 块扫描自驱动的级联 update（DOM churn）在全仓并行
  // 负载的 CI 2 核机上超 vitest 默认 5s——jsonl 侧恰界用例同款先例（7bdf48b）

  it('非 UTF-8（gb18030）+ 探测头 ctx：render 入口守卫补拉全量（指令①，解码/行数以全文件计）；head 覆盖全文件时不触发', async () => {
    stubResizeObserver();
    const rows: string[] = [];
    for (let i = 0; i < 600; i++) rows.push(`中${'p'.repeat(14)}${i}`);
    const content = gbBytes(rows);
    expect(content.length).toBeGreaterThan(8192); // 探测头形态成立
    const calls: RangeCall[] = [];
    const host = newHost();
    const inst = (await codeRenderer.render(content.slice(0, 8192), host, winSource,
      { ext: 'log', encoding: 'gb18030' },
      streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls }))) as CodeInstance;
    expect(calls).toStrictEqual([{ start: 0, end: Number.MAX_SAFE_INTEGER }]); // 恰一次全量补拉
    expect(inst.getMeta().lines).toBe(600); // 行数以全文件计（截断面只会有头部行数）
    expect(inst.getMeta().encoding).toBe('gb18030');
    expect(bodyText(host, 0)).toBe(`中${'p'.repeat(14)}0`); // gb18030 解码正确（UTF-8 解码此处必为替换符）
    inst.destroy();

    // head 覆盖全文件：守卫不触发
    const calls2: RangeCall[] = [];
    const host2 = newHost();
    const inst2 = (await codeRenderer.render(content, host2, winSource,
      { ext: 'log', encoding: 'gb18030' },
      streamCtx({ size: content.length, content, head: content, calls: calls2 }))) as CodeInstance;
    expect(calls2).toStrictEqual([]);
    expect(inst2.getMeta().lines).toBe(600);
    inst2.destroy();
  });

  // 项 6（retry 免重拉）：守卫 {0,MAX} 补拉此前每次 render 重入都重发——错误卡片
  // retry 场景同一 ctx 重复全量下载。修后以模块级 WeakMap 记忆同 ctx 的补拉
  //（memoizedFullRead：成功即记忆、失败出表可重试），ctx 随实例 GC 回收。
  it('守卫补拉记忆：同 ctx 两次 render（retry 场景）→ 全量 read 仅一次，记忆字节同样可用', async () => {
    stubResizeObserver();
    const rows: string[] = [];
    for (let i = 0; i < 600; i++) rows.push(`中${'p'.repeat(14)}${i}`);
    const content = gbBytes(rows);
    const calls: RangeCall[] = [];
    const ctx = streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls });
    const host = newHost();
    const inst1 = (await codeRenderer.render(content.slice(0, 8192), host, winSource,
      { ext: 'log', encoding: 'gb18030' }, ctx)) as CodeInstance;
    inst1.destroy();
    const host2 = newHost();
    const inst2 = (await codeRenderer.render(content.slice(0, 8192), host2, winSource,
      { ext: 'log', encoding: 'gb18030' }, ctx)) as CodeInstance;
    expect(calls).toStrictEqual([{ start: 0, end: Number.MAX_SAFE_INTEGER }]); // 第二次零新读
    expect(inst2.getMeta().lines).toBe(600); // 记忆的全量字节同样可用（非截断面）
    inst2.destroy();
  });

  // 终审 I-2：守卫补拉后的编码精判——capable 且 head（8KB 探测）短于 size 时 det 仅
  // 由 head 判定，截断多字节误判 gb18030（dispatcher.test ⑬ 同构，渲染器侧镜像）；
  // 补拉全量后须以 full 重算翻转，否则 renderOpts.encoding 以误判值解码整文件 mojibake。
  it('head 误判 gb18030 + 守卫补拉：补拉后以全量重算编码翻转 utf-8，行文本按精判解码', async () => {
    stubResizeObserver();
    // 4 字节 emoji 横跨 8KB 探测边界（head 只含前 2 字节 → gb18030 误判；全量完整 →
    // utf-8）：每行恰 100 字节，行 81 起于 8100，行内 90 字节处即 8190
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(i === 81 ? 'A'.repeat(90) + '🎉' + 'A'.repeat(5) : 'A'.repeat(99));
    }
    const content = enc(lines.join('\n') + '\n');
    expect(content[8190]).toBe(0xf0); // emoji 首字节恰骑在探测边界（自校验非空转）
    expect(content.length).toBe(100 * 100);
    const calls: RangeCall[] = [];
    const host = newHost();
    const inst = (await codeRenderer.render(content.slice(0, 8192), host, winSource,
      { ext: 'log', encoding: 'gb18030' }, // dispatcher head 口径的误判形态（⑬ 同构）
      streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls }))) as CodeInstance;
    expect(calls).toStrictEqual([{ start: 0, end: Number.MAX_SAFE_INTEGER }]); // 守卫补拉恰一次
    expect(inst.getMeta().encoding).toBe('utf-8'); // 精判翻转抵达渲染（head 口径为 gb18030）
    expect(inst.getMeta().lines).toBe(100); // 全文件行数
    inst.revealLine(81); // 行 81 在首屏视口外（jsdom 高度 0）：跳转后断言行文本
    await vi.waitFor(() => expect(bodyText(host, 81)).toBeDefined());
    expect(bodyText(host, 81)).toBe('A'.repeat(90) + '🎉' + 'A'.repeat(5)); // 精判解码正确（gb18030 解码此处必为替换符）
    inst.destroy();
  });

  it('BlockStream 200-回退（Range-less 服务器回全量）：degraded 后索引排空到 EOF，内容完整（二次路径自查）', async () => {
    stubResizeObserver();
    const content = enc(codeLines(1400)); // 2.1MB
    const calls: RangeCall[] = [];
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, {
      ext: 'js',
      lang: 'javascript',
      ctx: streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls, ignoreRange: true })
    });
    await vi.waitFor(() => expect(handle.getMeta().lines).toBe(1400)); // 排空到 EOF（全量底座零 IO）
    expect(calls).toStrictEqual([
      { start: 0, end: WINDOW_BLOCK - 1 }, // 首块请求收到全量 → 触发回退
      { start: 0, end: Number.MAX_SAFE_INTEGER } // 回退重取全量
    ]);
    expect(handle.getMeta().size).toBe(content.length);
    handle.revealLine(1399);
    expect(bodyText(host, 1399)!.startsWith('const a = 1399;')).toBe(true); // 尾行完整
    handle.destroy();
  });

  it('续读读失败：无 unhandled rejection、同块重试不跳块、失败停机不自动重试、用户滚动动作恢复续读到 EOF', async () => {
    stubResizeObserver();
    const content = enc(codeLines(1200)); // 1.8MB ≈ 7 块
    const calls: RangeCall[] = [];
    let readCount = 0;
    const ctx: StreamCtx = {
      size: null,
      head: content.slice(0, 8192),
      read: async (r) => {
        calls.push({ start: r.start, end: r.end });
        readCount += 1;
        if (readCount === 3) throw new Error('块 2 网络抖动'); // 首块 + 续读块 1 后的首次续读失败
        return content.slice(r.start, r.end + 1);
      }
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => { unhandled.push(err); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const host = newHost();
      const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
      scrollCode(host, Number.MAX_SAFE_INTEGER); // 触发续读 → 块 2 read 失败
      await vi.waitFor(() => expect(readCount).toBeGreaterThanOrEqual(3));
      await new Promise((r) => setTimeout(r, 30)); // 失败处理链（停机/refresh）落地
      expect(unhandled).toStrictEqual([]); // 失败被 catch 自兜底
      expect(calls.length).toBe(3); // 块 0/1 成功 + 块 2 失败尝试
      await new Promise((r) => setTimeout(r, 30));
      expect(calls.length).toBe(3); // 停机：无「失败→重评→再失败」活锁
      scrollCode(host, 0); // 用户动作：解除停机
      await new Promise((r) => setTimeout(r, 10));
      scrollCode(host, Number.MAX_SAFE_INTEGER);
      await vi.waitFor(() => expect(handle.getMeta().lines).toBe(1200));
      expect(calls[3]).toStrictEqual(calls[2]); // 同块重试（不跳块）
      expect(calls[2]).toStrictEqual({ start: 2 * WINDOW_BLOCK, end: 3 * WINDOW_BLOCK - 1 });
      handle.destroy();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // 项 1（对齐 jsonl 口径）：窗口模式停机双闩此前仅 scroll 解除——视口 resize 同为
  // 用户动作面（jsonl 的 ResizeObserver→notifyUserAction 双入口同构）。窗口 RO 回调
  // 须清双闩 + 单次重评：续读失败停机后不经任何 scroll 事件，resize 即单次重试恢复。
  it('窗口 resize 解锁续读停机：RO 回调清双闩并单次重评，同块重试恢复到 EOF', async () => {
    const roCallbacks: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) {
        roCallbacks.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    const content = enc(codeLines(1200)); // 1.8MB ≈ 7 块
    const calls: RangeCall[] = [];
    let readCount = 0;
    const ctx: StreamCtx = {
      size: null,
      head: content.slice(0, 8192),
      read: async (r) => {
        calls.push({ start: r.start, end: r.end });
        readCount += 1;
        if (readCount === 3) throw new Error('块 2 网络抖动'); // 首块 + 续读块 1 后的首次续读失败
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    scrollCode(host, Number.MAX_SAFE_INTEGER); // 触发续读 → 块 2 失败 → 停机
    await vi.waitFor(() => expect(readCount).toBeGreaterThanOrEqual(3));
    await new Promise((r) => setTimeout(r, 30)); // 失败处理链（停机闩）落地
    const readsAtFail = calls.length;
    expect(roCallbacks.length).toBeGreaterThanOrEqual(1); // 窗口 RO 已挂载（自校验非空转）
    roCallbacks[0]!(); // 模拟视口 resize：解锁停机 + 单次重评（不经 scroll 事件）
    await vi.waitFor(() => expect(handle.getMeta().lines).toBe(1200)); // 恢复续读到 EOF
    expect(calls.length).toBeGreaterThan(readsAtFail); // 重试真实发生
    expect(calls[3]).toStrictEqual(calls[2]); // 同块重试（不跳块）
    handle.destroy();
  });

  it('窗口模式块表 LRU（16 块）：滚动跳入已逐出块区间，占位后按需重拉、内容正确且恰一次补块', async () => {
    stubResizeObserver();
    const content = enc(codeLines(3400)); // 5.1MB ≈ 20 块 > 16：滚到底后块 0..3 已逐出
    const calls: RangeCall[] = [];
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, {
      ext: 'js',
      lang: 'javascript',
      ctx: streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls })
    });
    scrollCode(host, Number.MAX_SAFE_INTEGER); // 续读到 EOF：前向喂块恰每块一次
    await vi.waitFor(() => expect(handle.getMeta().lines).toBe(3400));
    expect(calls.length).toBe(20);
    // 跳到行 350 附近（字节 525,000 → 块 1/2：块表与文本缓存均已逐出且从未渲染）
    scrollCode(host, 7000); // 行 350 × 20px
    await vi.waitFor(() => expect(bodyText(host, 345)).toContain('= 345;')); // 重拉完成后实行渲染
    // 块 1/2 各恰重拉一次（pendingReload 去重：占位期不重复登记，refresh 后零多余 IO）
    expect(calls.filter((c) => c.start === WINDOW_BLOCK && c.end === 2 * WINDOW_BLOCK - 1).length).toBe(2);
    expect(calls.filter((c) => c.start === 2 * WINDOW_BLOCK && c.end === 3 * WINDOW_BLOCK - 1).length).toBe(2);
    handle.destroy();
  });

  it('BOM 文件：索引/解码前剥离（首行无 BOM 残留，meta 行数与全量 TextDecoder 口径一致）', async () => {
    stubResizeObserver();
    const body = enc('const first = 1;\nconst second = 2;\n');
    const content = new Uint8Array(3 + body.length);
    content.set([0xef, 0xbb, 0xbf], 0);
    content.set(body, 3);
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, {
      ext: 'js',
      lang: 'javascript',
      ctx: streamCtx({ size: content.length, content, head: content.slice(0, 8192) })
    });
    await vi.waitFor(() => expect(handle.getMeta().lines).toBe(2));
    expect(bodyText(host, 0)).toBe('const first = 1;'); // 无 \uFEFF 残留
    expect(bodyText(host, 1)).toBe('const second = 2;');
    handle.destroy();
  });

  // fix round 1 Important 1：reloadFailed 停机闩必须真实生效——回看重拉失败后任何
  // 自动 onRange/refresh 不得重试重拉（防活锁），用户滚动动作解除后单次重试。
  it('回看重拉失败：停机闩挡住自动重试（无活锁），用户滚动动作解除后单次重试成功', async () => {
    stubResizeObserver();
    const content = enc(codeLines(3400)); // 5.1MB ≈ 20 块 > 16：滚到底后块 0..3 已逐出
    const calls: RangeCall[] = [];
    let block1Reads = 0;
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: async (r) => {
        calls.push({ start: r.start, end: r.end });
        if (r.start === WINDOW_BLOCK) {
          block1Reads += 1;
          if (block1Reads === 2) throw new Error('块 1 回看重拉失败'); // 初始喂块成功，第 2 次（回看重拉）失败
        }
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    scrollCode(host, Number.MAX_SAFE_INTEGER); // 续读到 EOF：前向喂块恰每块一次
    await vi.waitFor(() => expect(handle.getMeta().lines).toBe(3400));
    expect(calls.length).toBe(20);
    scrollCode(host, 7000); // 跳入块 1/2 区间：占位 + 回看重拉 → 块 1 失败 → 停机
    await vi.waitFor(() => expect(block1Reads).toBe(2)); // 失败落地
    await new Promise((r) => setTimeout(r, 30));
    const readsAtFail = calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(readsAtFail); // 停机闩：无自动重试（整批待办冻结，块 2 也不拉）
    // 用户滚动动作（onUserScroll）：解除停机 → 单次重试（恢复批串行 ensure：块 1/2/0）
    scrollCode(host, 0);
    scrollCode(host, 7000); // 补块到位：窗口实卡渲染
    await vi.waitFor(() => expect(bodyText(host, 345)).toContain('= 345;'));
    expect(calls.filter((c) => c.start === WINDOW_BLOCK && c.end === 2 * WINDOW_BLOCK - 1).length).toBe(3);
    await new Promise((r) => setTimeout(r, 30)); // 恢复批全部落地
    const stable = calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(stable); // 成功后无额外拉取（无重试风暴）
    handle.destroy();
  });

  // Task 5 重写（原 snapshotLines 补块防护——后台全文扫描已接管）：空 query 短路
  // 零补读；扫描期对块表 LRU 逐出的已确认块按行序单飞补拉。工作集（25 块）> LRU
  //（16）时顺序扫描必然级联逐出（先补的块被后补挤出）：全量扫描每块恰读一次即为
  // 该场景最优——「风暴面」以每块无重复读 + 单飞在飞钉住（snapshotLines 旧实现是
  // 先验全量并发补块，同块随补随逐白拉重传）。
  it('搜索扫描补块：空 query 短路零读；非空 query 每块恰补读一次且单飞', async () => {
    stubResizeObserver();
    const content = enc(codeLines(4200)); // 6.3MB ≈ 25 块 > 16：滚到底后缺块 0..8（9 个）
    let readCount = 0;
    let inflight = 0;
    let maxInflight = 0;
    const lateReads: number[] = [];
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: async (r) => {
        readCount += 1;
        if (readCount > 25) lateReads.push(r.start); // EOF 后（搜索期）的读分布
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((res) => setTimeout(res, 3)); // 拉开并发重叠窗口
        inflight -= 1;
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    pausePump(handle); // 冻结泵：EOF 前的读全由滚动续读驱动，扫描补读计数不受泵干扰
    scrollCode(host, Number.MAX_SAFE_INTEGER); // 续读到 EOF：25 次串行前向喂块（在飞 1）
    await vi.waitFor(() => expect(handle.getMeta().lines).toBe(4200));
    expect(maxInflight).toBe(1); // 自证：续读链全串行，非空在飞只来自扫描补拉
    const readsAtEof = readCount;
    await handle.search(''); // 空 query（退出搜索）：短路扫描/补拉面
    expect(readCount).toBe(readsAtEof); // 零补读
    const matches = await handle.search('const a = 42;'); // 唯一命中在块 0（已被 LRU 逐出）
    expect(matches.map((m) => m.line)).toEqual([42]); // 逐出不丢命中（行序补拉）
    expect(readCount - readsAtEof).toBe(25); // 全文扫描触及全部块：每块恰读一次（无重复补拉）
    expect(new Set(lateReads).size).toBe(lateReads.length); // 无同块重复读（风暴面消除）
    expect(maxInflight).toBe(1); // 扫描补拉单飞（行序 ensure）：无并发风暴
    handle.destroy();
  });

  // 项 3（补拉失败突发收敛）：scanLineText 对已逐出块逐行 ensureBlock——持续失败时
  // 每行一次失败请求（块内 ~174 行 = ~174 次突发）。修法：失败块按扫描记忆（每扫描
  // 一份），同块只发一次失败请求，该块行以空串跳过、其余块照常扫描。
  it('扫描补块失败按块收敛：失败块恰一次失败请求（非每行一次），其余块照常扫描', async () => {
    stubResizeObserver();
    // fake client：chunk 高亮即时返回（隔离 hljs highlightAuto 的测试环境开销——
    // 行数渐进增长使底部视口 chunk 键随行数移动，真实 Auto 高亮会淹没本测试语义）
    attachHighlightClient({ highlight: async () => [] });
    const lines: string[] = [];
    for (let i = 0; i < 4200; i++) {
      const head = i === 42 ? 'zzneedle early ' : i === 1000 ? 'zzneedle mid ' : `row ${i} `;
      lines.push(head + 'p'.repeat(Math.max(0, 1499 - head.length)) + '\n'); // 每行恰 1500B
    }
    const content = enc(lines.join('')); // ≈ 6.3MB ≈ 25 块 > 16：滚到底后块 0..8 已逐出
    const calls: RangeCall[] = [];
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: async (r) => {
        calls.push({ start: r.start, end: r.end });
        // 初始前向喂块（首屏 25 次内）成功；扫描期对块 1 的重拉恒失败
        if (r.start === WINDOW_BLOCK && calls.length > 25) throw new Error('块 1 补拉持续失败');
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    scrollCode(host, Number.MAX_SAFE_INTEGER); // 续读到 EOF：前向喂块恰每块一次
    await vi.waitFor(() => expect(handle.getMeta().lines).toBe(4200));
    expect(calls.length).toBe(25);
    const matches = await handle.search('zzneedle');
    expect(matches.map((m) => m.line)).toEqual([42, 1000]); // 其余块照常扫描（块 0/5 重拉成功）
    // 块 1 的读 = 初始喂块 1 次 + 扫描期失败重拉 1 次（修前为逐行 ~174 次突发）
    expect(calls.filter((c) => c.start === WINDOW_BLOCK && c.end === 2 * WINDOW_BLOCK - 1).length).toBe(2);
    handle.destroy();
  });

  // ---------- Task 5：后台全文扫描搜索（替换 snapshotLines 快照过渡实现） ----------
  //
  // 语义基线：search() 即刻返回 Promise，后台从文件头驱动 BlockStream 逐块前向喂
  // 索引扫描到 EOF；命中随扫描渐进上屏（先到先出）；取消 = 新搜索/空查询/destroy
  // 令牌失效（旧 Promise 以部分结果收场）；gotoMatch 先 ensure 目标块再跳转高亮。

  it('全文扫描命中未加载区与跨块行：扫描自驱动 IO 到 EOF，行号/行内偏移正确', async () => {
    stubResizeObserver();
    // 巨行横跨块 0/1 切口（文件字节 262144）：行起始于文件偏移 14（'zzneedle head\n'
    // 之长），行内偏移 262128 的 'zzneedle' 落在文件字节 262142..262150——恰跨切口
    const straddle = `${'A'.repeat(262128)}zzneedle${'B'.repeat(60)}`;
    const lines: string[] = ['zzneedle head', straddle];
    for (let i = 2; i < 4000; i++) {
      lines.push(i === 3000 ? 'deep zzneedle hit' : `pad ${i} ${'x'.repeat(100)}`);
    }
    const content = enc(lines.join('\n') + '\n');
    const calls: RangeCall[] = [];
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, {
      ext: 'js',
      lang: 'javascript',
      ctx: streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls })
    });
    pausePump(handle); // 冻结泵：readsAtMount 之后的前向读全部由扫描自驱动（原契约面）
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    const readsAtMount = calls.length;
    const matches = await handle.search('zzneedle');
    expect(matches.map((m) => m.line)).toEqual([0, 1, 3000]);
    expect(calls.length).toBeGreaterThan(readsAtMount); // 扫描自驱动了未加载区的前向读取
    expect(matches[1]).toMatchObject({ line: 1, start: 262128, end: 262136 }); // 跨块行命中
    handle.destroy();
  });

  it('重入搜索令牌失效：旧扫描以部分结果收场且不触碰状态，新查询完整落地', async () => {
    stubResizeObserver();
    const lines: string[] = [];
    for (let i = 0; i < 6000; i++) {
      if (i === 5) lines.push('beta here');
      else if (i === 5990) lines.push('alpha deep');
      else lines.push(`row ${i} ${'p'.repeat(90)}`);
    }
    const content = enc(lines.join('\n') + '\n'); // ≈ 553KB ≈ 3 块
    let releaseTail: (() => void) | null = null;
    const tailGate = new Promise<void>((res) => {
      releaseTail = res;
    });
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: async (r) => {
        if (r.start >= 2 * WINDOW_BLOCK) await tailGate; // 末块（alpha 所在）挂起
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    let aSettled = false;
    const pA = handle.search('alpha').then((m) => {
      aSettled = true;
      return m;
    });
    // 旧扫描推进到块 1（无 alpha）后在末块闸前停住
    await vi.waitFor(() => expect(handle.getMeta().lines).toBeGreaterThan(5000));
    expect(aSettled).toBe(false);
    const pB = handle.search('beta'); // 重入：旧扫描令牌即刻失效
    releaseTail!();
    const [aMatches, bMatches] = await Promise.all([pA, pB]);
    expect(aMatches).toEqual([]); // 取消 = 部分结果语义：alpha 在未扫区，旧 Promise 空手收场
    expect(bMatches.map((m) => m.line)).toEqual([5]); // 新查询扫到全文（含末块）
    expect(preHtml(host)).toContain('<mark class="vv-search-hit">beta</mark>'); // 新查询命中已上屏
    expect(preHtml(host)).not.toContain('alpha'); // 旧查询（alpha）零痕迹
    handle.destroy();
  });

  it('空查询（退出搜索）取消在飞扫描：旧 Promise 部分结果收场且零补读', async () => {
    stubResizeObserver();
    const lines: string[] = [];
    for (let i = 0; i < 6000; i++) {
      lines.push(i === 5990 ? 'zzneedle deep' : `row ${i} ${'p'.repeat(90)}`);
    }
    const content = enc(lines.join('\n') + '\n');
    let releaseTail: (() => void) | null = null;
    const tailGate = new Promise<void>((res) => {
      releaseTail = res;
    });
    let readCount = 0;
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: async (r) => {
        readCount += 1;
        if (r.start >= 2 * WINDOW_BLOCK) await tailGate;
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    let aSettled = false;
    const pA = handle.search('zzneedle').then((m) => {
      aSettled = true;
      return m;
    });
    await vi.waitFor(() => expect(handle.getMeta().lines).toBeGreaterThan(5000)); // 块 0/1 已扫
    const readsBeforeCancel = readCount; // 含已发起而挂闸的末块读（取消前发起不计数变化）
    handle.search(''); // 退出搜索：取消在飞扫描
    releaseTail!();
    const aMatches = await pA;
    expect(aSettled).toBe(true); // 取消后 Promise 收场（不悬挂）
    expect(aMatches).toEqual([]); // 针在未扫区：部分结果为空
    expect(readCount).toBe(readsBeforeCancel); // 取消后零补读
    expect(preHtml(host)).not.toContain('<mark'); // 退出搜索：痕迹清除
    handle.destroy();
  });

  // 项 2（缓存键纳入扫描进度）：scan===null && 同键 短路此前不区分收场形态——
  // 停机收场（limitReached/continueFailed）的部分结果也被短路，同 query 重搜无法
  // 续扫。语义分界：全文完成（indexFinished+扫描至尾）才短路零读；停机收场后同
  // query 重搜触发续扫（重搜即用户动作，解除续读停机闩）并合并既有命中。
  it('停机收场后同 query 重搜续扫合并命中；全文完成后同 query 短路零读', async () => {
    stubResizeObserver();
    const lines: string[] = [];
    for (let i = 0; i < 3400; i++) {
      const head = i === 5 ? 'zzneedle early ' : i === 3300 ? 'zzneedle deep ' : `row ${i} `;
      lines.push(head + 'p'.repeat(Math.max(0, 1499 - head.length)) + '\n'); // 每行恰 1500B
    }
    const content = enc(lines.join('')); // ≈ 5.1MB ≈ 20 块（行 5 在块 0，行 3300 在块 18）
    let readCount = 0;
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: async (r) => {
        readCount += 1;
        if (readCount === 3) throw new Error('块 2 续读网络抖动'); // 首查在块 2 停机
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    const first = await handle.search('zzneedle');
    expect(first.map((m) => m.line)).toEqual([5]); // 停机收场：仅已加载区部分结果
    const readsAtStop = readCount;
    const second = await handle.search('zzneedle'); // 同 query 重搜：不短路，续扫
    expect(readCount).toBeGreaterThan(readsAtStop); // 扫描继续推进（续读真实发生）
    expect(second.map((m) => m.line)).toEqual([5, 3300]); // 既有命中合并 + 新命中
    const readsAtDone = readCount;
    const third = await handle.search('zzneedle'); // 全文完成：短路零读
    expect(readCount).toBe(readsAtDone);
    expect(third.map((m) => m.line)).toEqual([5, 3300]);
    handle.destroy();
  });

  // SUSP-01（e2e 富化定档 confirmed-design 优化候选落地）：退出搜索（空 query）此前
  // 走换键重置分支（清 lastQuery/命中集/游标），重输同词触发全新全文扫描（≥20 块级
  // 请求）。落地后空 query 只做令牌失效 + 视觉清理，短路缓存保留——同词重搜走既有
  // 完成态短路，零块级拉取；命中视觉（词级 mark/行级背景）自缓存命中集零 IO 复现。
  it('SUSP-01：退出搜索（空 query）不作废短路缓存——同词重搜零读、命中视觉复现', async () => {
    stubResizeObserver();
    const lines: string[] = [];
    for (let i = 0; i < 3400; i++) {
      const head = i === 5 ? 'zzneedle early ' : i === 3300 ? 'zzneedle deep ' : `row ${i} `;
      lines.push(head + 'p'.repeat(Math.max(0, 1499 - head.length)) + '\n'); // 每行恰 1500B
    }
    const content = enc(lines.join('')); // ≈ 5.1MB ≈ 20 块（行 5 在块 0，行 3300 在块 18）
    let readCount = 0;
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: async (r) => {
        readCount += 1;
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    pausePump(handle); // 冻结后台泵：前向读全部由扫描自驱动，读计数确定
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    const first = await handle.search('zzneedle'); // 首扫自驱动至 EOF：全文完成
    expect(first.map((m) => m.line)).toEqual([5, 3300]);
    const readsAfterFirst = readCount;
    expect(readsAfterFirst).toBeGreaterThan(1); // 首扫有真实块级 IO
    await handle.search(''); // 退出搜索：视觉清理照旧（词级 mark/行级背景消退）
    expect(host.querySelector('mark.vv-search-hit')).toBeNull();
    const second = await handle.search('zzneedle'); // 同词重搜：完成态短路（同步 resolve 路径）
    expect(readCount).toBe(readsAfterFirst); // 零新增块级拉取（SUSP-01 断言核心）
    expect(second.map((m) => m.line)).toEqual([5, 3300]); // 命中集自短路缓存原样返回
    expect(host.querySelector('mark.vv-search-hit')).not.toBeNull(); // 命中视觉自缓存复现
    handle.destroy();
  });

  // SUSP-01 fix wave（终局评审发现的跨任务交互回归）：扫描在飞时退出 → 同词重搜走
  // 续扫（sameKey && !lastScanComplete）——退出清空了行级命中索引，而 runScan 截断
  // 只删 >= startFrom，游标前既有命中留在 lastMatches 却不进 searchHitsByLine：
  // 计数/gotoMatch 报告它们、行内 mark/行级背景却消失（fillRows 唯一消费面）。
  // 修复后续扫分支自缓存重建 line < lastScanCursor 的条目（与截断语义精确互补）。
  it('SUSP-01 修复：扫描中途退出→同词重搜续扫——游标前命中行 mark/行级背景保留', async () => {
    stubResizeObserver();
    const lines: string[] = [];
    for (let i = 0; i < 3400; i++) {
      const head = i === 5 ? 'zzneedle early ' : i === 3300 ? 'zzneedle deep ' : `row ${i} `;
      lines.push(head + 'p'.repeat(Math.max(0, 1499 - head.length)) + '\n'); // 每行恰 1500B
    }
    const content = enc(lines.join('')); // ≈ 5.1MB ≈ 20 块（行 5 在块 0，行 3300 在块 18）
    let readCount = 0;
    let block0Reads = 0;
    let releaseTail: (() => void) | null = null;
    const tailGate = new Promise<void>((res) => {
      releaseTail = res;
    });
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: async (r) => {
        readCount += 1;
        if (r.start === 0) block0Reads += 1;
        if (r.start >= 2 * WINDOW_BLOCK) await tailGate; // 块 2 起挂闸：首扫只覆盖块 0/1
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    pausePump(handle); // 冻结后台泵：前向读全部由扫描自驱动，读计数确定
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    const first = handle.search('zzneedle'); // 在飞：块 0/1 已扫（行 5 已入命中集），块 2 闸前挂起
    await vi.waitFor(() => expect(handle.getMeta().lines).toBeGreaterThan(300)); // 块 0/1 已入索引
    const readsAtExit = readCount;
    handle.search(''); // 扫描中途退出：令牌失效 + 视觉清理，短路缓存（命中集/游标）保留
    expect(host.querySelector('[data-line="5"] mark.vv-search-hit')).toBeNull(); // 视觉清理照旧
    releaseTail!(); // 放行在飞读：旧扫描下一检查点令牌失效退出（部分结果收场）
    expect((await first).map((m) => m.line)).toEqual([5]); // 取消 = 部分结果语义
    const second = await handle.search('zzneedle'); // 同词重搜：sameKey && !complete → 断点续扫
    expect(second.map((m) => m.line)).toEqual([5, 3300]); // 游标前命中保留 + 续扫新命中
    expect(readCount).toBeGreaterThan(readsAtExit); // 续扫真实发生（非短路）
    expect(block0Reads).toBe(1); // 游标前块 0 不重读（续扫自 lastScanCursor 推进）
    // Fix 1 断言核心：游标前既有命中的视觉不丢——mark 与行级背景在 fillRows 产物中
    expect(host.querySelector('[data-line="5"] mark.vv-search-hit')).not.toBeNull();
    expect(host.querySelector('[data-line="5"]')?.classList.contains('vv-search-hit-line')).toBe(true);
    handle.destroy();
  });

  // SUSP-02（e2e 富化定档 confirmed-design UX 候选落地）：后台全文扫描逐块喂入时，
  // 块表 LRU（16×256KB）曾把视口所在块挤出——视口行经 lineAvailable 占位化 +
  // pendingReload 回看重拉（SCAN-08 一次续扫内 ≥2 次，可见闪烁）。修后 runScan
  // 每块落地对可视区所需块 bs.block 触新（自带 LRU touch）：视口块恒驻留、占位化
  // 面消失。断言面：视口块 0 的块级读恰 1 次——任何「挤出→占位化」episode 都必然
  // 经 pendingReload→ensureBlock 产生第 2 次读，读计数是占位化的忠实代理。
  it('SUSP-02：扫描推进期视口块被触新——不触发回看重拉（pendingReload 恒空）', async () => {
    stubResizeObserver();
    const lines: string[] = [];
    for (let i = 0; i < 3400; i++) {
      const head = i === 100 ? 'zzneedle here ' : `row ${i} `;
      lines.push(head + 'q'.repeat(Math.max(0, 1499 - head.length)) + '\n'); // 每行恰 1500B
    }
    const content = enc(lines.join('')); // ≈ 5.1MB ≈ 20 块 > 块表 LRU 16：挤出压力成立
    let block0Reads = 0;
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: async (r) => {
        if (r.start === 0) block0Reads += 1;
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = newHost();
    // 钉 attach 相位 failed（顺序无关，杜绝 pending 相位 10s 挂起泄漏）：chunk 走
    // hljs 兜底 = 视口 chunk 高亮缓存的生产行态——此后渲染经 lineHtml 缓存取行、
    // 不再经 lineText/charOffsetOf 触块（渲染路径触新的缺席正是 SUSP-02 现象的
    // 成立前提：视口块 LRU 位随喂块推进自然变陈旧）
    __resetAttachPhaseForTest();
    attachHighlightClient(null);
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    pausePump(handle); // 冻结泵：前向喂块全由扫描自驱动（SCAN 域既有口径），读计数归因唯一
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    expect(block0Reads).toBe(1); // 自证：打开首拉恰一次
    const matches = await handle.search('zzneedle'); // 扫描自驱动喂块 1..19 到 EOF（视口驻块 0）
    expect(matches.map((m) => m.line)).toEqual([100]); // 全文扫描完成（布点行入集）
    await vi.waitFor(() => expect(handle.getMeta().lines).toBe(3400));
    // 断言核心：视口（顶部行 0..~20 ∈ 块 0）全程实卡——扫描新块未将块 0 挤出
    //（修前：喂块至 16 块挤出块 0 → 视口行占位化 → pendingReload 回拉 = 第 2 次读）
    expect(block0Reads, '视口块 0 应恰 1 次读（扫描期触新驻留，无占位化回拉）').toBe(1);
    expect(bodyText(host, 0)!.startsWith('row 0 ')).toBe(true); // 视口首行实行非占位
    handle.destroy();
  });

  // SUSP-02 落地后的形态改造（原「扫描期视口补拉预置失败」前提已被触新消除——
  // 顶部视口驻留块 0 在扫描期恒被触新、不再逐出重拉）：gotoMatch 的 ensure 闸面
  // 改由「视口先离顶（贴底驱动续读）→ 前向 40 块 LRU(16) 逐出块 0..24 → 扫描补拉
  // 块 0 后又被第 17 次后续插入挤出」承担。补齐前不跳转、补齐后高亮落实到实行
  // 的钉住语义不变；本用例不经 runScan 喂块落地点（indexFinished 纯内存扫描），
  // 对触新实现前后不变。
  it('gotoMatch 先 ensure 目标块再跳转：补齐前不跳转，补齐后高亮落实到实行', async () => {
    stubResizeObserver();
    const lines: string[] = [];
    for (let i = 0; i < 7000; i++) {
      const head = i === 100 ? 'zzneedle here ' : `row ${i} `;
      lines.push(head + 'q'.repeat(Math.max(0, 1499 - head.length)) + '\n'); // 每行恰 1500B
    }
    const content = enc(lines.join('')); // ≈ 10.5MB ≈ 41 块 > 16（块表 LRU）
    let block0Reads = 0;
    let releaseEnsure: (() => void) | null = null;
    const ensureGate = new Promise<void>((res) => {
      releaseEnsure = res;
    });
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: async (r) => {
        if (r.start === 0) {
          block0Reads += 1;
          // 读 1 = 打开首拉、读 2 = 扫描面对已逐出块 0 的补拉（布点行 100 所在，
          // 须成功）；读 3 = gotoMatch 的回看 ensure（补拉后再逐出）——挂闸钉住
          // 「补齐前不跳转」
          if (block0Reads >= 3) await ensureGate;
        }
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, {
      ext: 'js',
      lang: 'javascript',
      highlight: false, // plain 策略：零 chunk 管线（前沿推进不触发逐块 hljs 高亮）——
      // 本用例钉的是回看 ensure 面，与高亮无关；词级 mark/行级高亮走搜索 overlay 面
      ctx
    });
    pausePump(handle); // 冻结泵：EOF 前的前向读全由贴底滚动续读驱动（读计数归因唯一）
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    scrollCode(host, Number.MAX_SAFE_INTEGER); // 视口离顶贴前沿：块 0 停触，续读至 EOF
    await vi.waitFor(() => expect(handle.getMeta().lines).toBe(7000));
    const matches = await handle.search('zzneedle'); // EOF 已至：纯内存扫描 + 已逐出块补拉
    expect(matches.map((m) => m.line)).toEqual([100]); // 块 0 补拉（读 2）时布点已入集
    const topBefore = handle.scrollTop();
    handle.gotoMatch(0);
    await new Promise((r) => setTimeout(r, 30)); // ensure 读挂闸：同步阶段与微任务均不得提前跳转
    expect(handle.scrollTop()).toBe(topBefore); // ensure 未完成：不跳转
    releaseEnsure!(); // 放行 gotoMatch 的补块读
    await vi.waitFor(() => {
      const row = host.querySelector('[data-line="100"]');
      expect(row?.classList.contains('vv-search-hit-line-active')).toBe(true);
      expect(row?.querySelector('mark.vv-search-hit')?.textContent).toBe('zzneedle');
      expect(row?.querySelector('.vv-code-body')?.textContent).toContain('zzneedle'); // 实行非占位
    });
    expect(handle.scrollTop()).not.toBe(topBefore); // ensure 完成后才跳转
    expect(block0Reads).toBe(3); // 首块重拉 + 扫描补拉 + gotoMatch 的 ensure
    handle.destroy();
  });

  it('扫描渐进可用：前块命中先于全文完成上屏（先到先出），完成时全量收场', async () => {
    stubResizeObserver();
    const lines: string[] = [];
    for (let i = 0; i < 6000; i++) {
      if (i === 3) lines.push('early zzneedle');
      else if (i === 3000) lines.push('mid zzneedle');
      else lines.push(`row ${i} ${'r'.repeat(90)}`);
    }
    const content = enc(lines.join('\n') + '\n'); // ≈ 553KB ≈ 3 块（块 1 ≈ 行 2700..5350）
    const releases: Array<() => void> = [];
    let armed = false;
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: async (r) => {
        if (armed) await new Promise<void>((res) => releases.push(res)); // 每笔读挂起待放行（FIFO）
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    pausePump(handle); // 冻结泵：armed 门只拦扫描的读，渐进时序不被泵抢跑
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    armed = true;
    let settled = false;
    const pending = handle.search('zzneedle').then((m) => {
      settled = true;
      return m;
    });
    // 块 0 命中即时上屏（行已驻留，无需任何 IO）
    await vi.waitFor(() =>
      expect(host.querySelector('[data-line="3"] mark.vv-search-hit')).not.toBeNull()
    );
    expect(settled).toBe(false); // 全文未扫完：Promise 不落地
    scrollCode(host, 60_000); // 视口移到行 ~3000：索引未及 → 占位行
    releases[0]!(); // 放行块 1：扫描推进并渐进落地行 3000 的命中
    await vi.waitFor(() =>
      expect(host.querySelector('[data-line="3000"] mark.vv-search-hit')).not.toBeNull()
    );
    expect(settled).toBe(false); // 末块仍在闸前：前块命中先于全文完成可见
    for (const rel of releases) rel();
    const matches = await pending;
    expect(settled).toBe(true);
    expect(matches.map((m) => m.line)).toEqual([3, 3000]);
    handle.destroy();
  });

  // 终审 I-1（BUG-09 大文件回归面）：全局搜索跳转（pendingLine）指向远部未加载行
  // ——revealLine 不得静默丢弃（此前 `line >= rows()` 即 return），须驱动续读至该行
  // 入索引后跳转到位。ViewerPane 消费 pendingLine 即清，本调用是唯一补读机会。
  it('revealLine 未加载行（全局搜索跳转形态）：驱动续读至该行入索引后跳转到位（实行 + active 高亮）', async () => {
    stubResizeObserver();
    const content = enc(codeLines(3400)); // 5.1MB ≈ 20 块：行 3300 在末块（首块后不可见）
    const calls: RangeCall[] = [];
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, {
      ext: 'js',
      lang: 'javascript',
      ctx: streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls })
    });
    pausePump(handle); // 冻结泵：行 3300 的未加载状态由 reveal 驱动续读抵达（原契约面）
    await vi.waitFor(() => expect(handle.getMeta().lines).toBe(174)); // 仅首块已加载
    const readsAtJump = calls.length;
    handle.revealLine(3300); // 目标行远部未加载
    await vi.waitFor(() => {
      const row = host.querySelector('[data-line="3300"]');
      expect(row?.classList.contains('vv-search-hit-line-active')).toBe(true); // 跳转已落地
    });
    expect(bodyText(host, 3300)!.startsWith('const a = 3300;')).toBe(true); // 实行非占位
    expect(handle.getMeta().lines).toBeGreaterThan(174); // 续读已推进索引（补读真实发生）
    expect(calls.length).toBeGreaterThan(readsAtJump);
    handle.destroy();
  });

  it('revealLine 越出 EOF：续读到 EOF 确认后静默不跳转（全量路径越界同口径）', async () => {
    stubResizeObserver();
    const content = enc(codeLines(400)); // 600KB ≈ 3 块
    const calls: RangeCall[] = [];
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, {
      ext: 'js',
      lang: 'javascript',
      ctx: streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls })
    });
    pausePump(handle); // 冻结泵：EOF 确认由 reveal 驱动续读达成（原契约面）
    await vi.waitFor(() => expect(handle.getMeta().lines).toBe(174));
    handle.revealLine(999_999); // 越出 EOF：驱动续读到 EOF 才能判定不存在
    await vi.waitFor(() => expect(handle.getMeta().lines).toBe(400)); // EOF 已确认（补读非空转）
    await new Promise((r) => setTimeout(r, 20));
    expect(host.querySelector('.vv-search-hit-line-active')).toBeNull(); // 静默兜底：不跳转
    handle.destroy();
  });

  it('revealLine 续读失败：continueFailed 停机静默兜底不跳转，无 unhandled rejection', async () => {
    stubResizeObserver();
    const content = enc(codeLines(3400));
    let readCount = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => { unhandled.push(err); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const host = newHost();
      const handle = renderCode(content.slice(0, 8192), host, {
        ext: 'js',
        lang: 'javascript',
        ctx: {
          size: content.length,
          head: content.slice(0, 8192),
          read: async (r) => {
            void r;
            readCount += 1;
            if (readCount === 2) throw new Error('续读网络抖动'); // 首块成功后的首次续读失败
            return content.slice(r.start, r.end + 1);
          }
        }
      });
      await vi.waitFor(() => expect(handle.getMeta().lines).toBe(174));
      handle.revealLine(3300);
      await vi.waitFor(() => expect(readCount).toBeGreaterThanOrEqual(2)); // 失败落地
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toStrictEqual([]); // 失败被 catch 自兜底
      expect(host.querySelector('.vv-search-hit-line-active')).toBeNull(); // 静默兜底：不跳转
      handle.destroy();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // 项 1（遗留清偿波 3）：head 干净 + 尾部 GB18030 的窗口流式形态——续读触达脏块
  // 时流内嗅探判非 UTF-8，经 codeRenderer.render 注入的降级出口（与入口「判出的
  // 非 UTF-8」回退同路径：memoizedFullRead 补拉 + redetectWithFull 精判 + 全量重渲）
  // 重渲，实例方法面转投全量实例（getMeta/getEngine/revealLine…），销毁复合收口。
  it('项 1 流内嗅探降级：head 干净 + 尾部 GB18030 → 首块正常渲染，续读触发全量重渲（无 U+FFFD、meta 精判 gb18030）', async () => {
    stubResizeObserver();
    attachHighlightClient({ highlight: async () => [{ start: 0, end: 5, capture: 'keyword' }] });
    const parts: number[] = [...enc(codeLines(1400))]; // 干净前缀 ≈2.1MB >2MB（窗口分支门槛；块 0..7 全净）
    for (let i = 0; i < 100; i++) {
      parts.push(...enc(`// gb ${i} `));
      for (let k = 0; k < 50; k++) parts.push(0xba, 0xba); // GBK「汉」：两字节均非法 UTF-8 lead
      parts.push(0x0a);
    }
    const content = Uint8Array.from(parts);
    const calls: RangeCall[] = [];
    const host = newHost();
    const inst = (await codeRenderer.render(content.slice(0, 8192), host, winSource,
      { ext: 'js', encoding: 'utf-8', lang: 'javascript' },
      streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls }))) as CodeInstance;
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    expect(calls.some((c) => c.end === Number.MAX_SAFE_INTEGER)).toBe(false); // 窗口模式：无全量补拉
    expect(host.textContent).not.toContain('\uFFFD'); // 首块干净
    scrollCode(host, Number.MAX_SAFE_INTEGER); // 续读触达脏块 → 嗅探判非 UTF-8 → 降级
    await vi.waitFor(() => expect(inst.getMeta().encoding).toBe('gb18030')); // 精判回填（方法面转投）
    expect(calls.some((c) => c.start === 0 && c.end === Number.MAX_SAFE_INTEGER)).toBe(true); // 补拉全量
    // 全文正确解码：脏区行（1400..1499）'汉' 就位、无 U+FFFD 扩散
    inst.revealLine(1450);
    await vi.waitFor(() => expect(bodyText(host, 1450)).toBeDefined());
    expect(bodyText(host, 1450)).toContain('汉');
    expect(host.textContent).not.toContain('\uFFFD');
    expect(inst.getMeta().lines).toBe(1500); // wc-l 口径回环全量
    await vi.waitFor(() => expect(inst.getEngine()).toBe('tree-sitter')); // 引擎指示随全量实例
    inst.destroy(); // 复合销毁：全量实例随宿主收口，无 DOM 残留
    expect(host.querySelector('.vv-code-pre')).toBeNull();
  });

  // 项 2（遗留清偿波 3）：后台扫描进度条（spec §4.3 承诺兑现）——扫描期间 target
  // 顶部（oversize 条同位，pre 的兄弟节点）一次性 .vv-code-scan-progress 元素，
  // 完成/取消（destroy）即移除；SearchPanel/getMeta 零变更（进度承载在渲染器 DOM 层）。
  it('项 2 后台扫描进度条：扫描期间出现（扫描中 N% + 已命中 M 处形态），destroy 取消与扫描完成均移除', async () => {
    stubResizeObserver();
    const content = enc(codeLines(1400)); // 2.1MB ≈ 9 块：首块后仍有大量块可拉（读闸控节奏）
    let release: (() => void) | null = null;
    let gated = false;
    const ctx = streamCtx({ size: content.length, content, head: content.slice(0, 8192) });
    const rawRead = ctx.read.bind(ctx);
    ctx.read = async (r) => {
      if (r.start >= WINDOW_BLOCK && !gated) {
        gated = true; // 仅首个续块挂起：扫描停在半途供断言（fake ctx 读闸）
        await new Promise<void>((res) => {
          release = res;
        });
      }
      return rawRead(r);
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    expect(host.querySelector('.vv-code-scan-progress')).toBeNull(); // 未搜索：无进度元素
    // —— 取消态：destroy 即移除（不待在途读闸收场）。闸被扫描拉取面实际持有
    //（release 非空）才断言——bar 出现早于首个续块拉取，时序不确定会假挂 ——
    void handle.search('zzz-no-hit');
    await vi.waitFor(() => expect(release).not.toBeNull());
    const barText = host.querySelector('.vv-code-scan-progress')!.textContent!;
    expect(barText).toMatch(/扫描中 \d+%/); // size 已知：百分比形态
    expect(barText).toContain('已命中 0 处');
    handle.destroy();
    expect(host.querySelector('.vv-code-scan-progress')).toBeNull();
    // —— 完成态：闸已放行（gated 锁存），扫描全速至 EOF 后移除（search 完成制
    // Promise 契约不变）。runScan 同步执行至首个 await：search 返回时元素必已挂 ——
    const host2 = newHost();
    const handle2 = renderCode(content.slice(0, 8192), host2, { ext: 'js', lang: 'javascript', ctx });
    await vi.waitFor(() => expect(bodyText(host2, 0)).toBeDefined());
    const pending = handle2.search('zzz-no-hit');
    expect(host2.querySelector('.vv-code-scan-progress')).not.toBeNull();
    const hits = await pending;
    expect(hits).toStrictEqual([]);
    expect(host2.querySelector('.vv-code-scan-progress')).toBeNull();
    handle2.destroy();
  });

  // 项 A（Important，W3-4）：进度条属主竞态——扫描在飞换 query 时，新扫描的
  // showScanProgress 因 scanBar !== null 早退复用旧条，随后被取消旧扫描的
  // hideScanProgress 把条移除，新扫描数分钟无进度。修法：条与 scanSeq 绑定属主
  //（show 记录 ownerSeq、hide 仅属主匹配才移除、新扫描接管并复用同一元素）。
  it('项 A 进度条属主：扫描在飞换 query，旧扫描取消不移除新扫描已接管的进度条', async () => {
    stubResizeObserver();
    const content = enc(codeLines(1400)); // 2.1MB ≈ 9 块：首块后仍有大量块可拉
    let release: (() => void) | null = null;
    let gated = false;
    const ctx = streamCtx({ size: content.length, content, head: content.slice(0, 8192) });
    const rawRead = ctx.read.bind(ctx);
    ctx.read = async (r) => {
      if (r.start >= WINDOW_BLOCK && !gated) {
        gated = true; // 仅首个续块挂起：扫描 A 停在半途供断言（fake ctx 读闸）
        await new Promise<void>((res) => {
          release = res;
        });
      }
      return rawRead(r);
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    const pA = handle.search('qqq-no-hit'); // 扫描 A 在飞：拉块 1 挂闸
    await vi.waitFor(() => expect(release).not.toBeNull());
    expect(host.querySelector('.vv-code-scan-progress')).not.toBeNull();
    const pB = handle.search('const'); // 换 query：新扫描 B 接管进度条（属主切换）
    // 文本随新扫描更新：块 0 行全含 const，命中数 > 0（旧查询无命中，形态可分辨）
    await vi.waitFor(() =>
      expect(host.querySelector('.vv-code-scan-progress')!.textContent).toMatch(/已命中 [1-9]/)
    );
    release!(); // 放行：扫描 A 令牌已失效，取消收场（finally 清理路径）
    await pA; // 旧扫描以部分结果收场
    expect(host.querySelector('.vv-code-scan-progress')).not.toBeNull(); // 核心：旧扫描的 hide 不得移除新扫描已接管的条
    const hits = await pB; // 新扫描完成
    expect(hits.length).toBeGreaterThan(0);
    expect(host.querySelector('.vv-code-scan-progress')).toBeNull(); // 新扫描完成才移除
    handle.destroy();
  });

  // 项 B（Minor，W3-5）：进度条更新节流——拉块等待期 SCAN_POLL_MS=4ms 自旋每轮
  // updateScanProgress（≈250Hz DOM 写）。修法：updateScanProgress 内部 ≥100ms 才写
  // DOM；收场路径属主绕过节流强制末写。轮询形态 = 滚动续读持有 pulling（扫描在
  // await pullBlock 之前自旋），故先触发续读挂闸、再发起搜索。
  it('项 B 进度更新节流：拉块等待轮询期 DOM 写频次受限（≥100ms 间隔，非每轮 4ms 一写）', async () => {
    stubResizeObserver();
    const content = enc(codeLines(1400)); // 2.1MB ≈ 9 块：首块后仍有大量块可拉
    let release: (() => void) | null = null;
    let gated = false;
    const ctx = streamCtx({ size: content.length, content, head: content.slice(0, 8192) });
    const rawRead = ctx.read.bind(ctx);
    ctx.read = async (r) => {
      if (r.start >= WINDOW_BLOCK && !gated) {
        gated = true; // 首个续块长闸：滚动续读持有 pulling，扫描进入 4ms 轮询等待期
        await new Promise<void>((res) => {
          release = res;
        });
      }
      return rawRead(r);
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    scrollCode(host, Number.MAX_SAFE_INTEGER); // 滚动续读在飞：pulling 由续读持有（块 1 挂闸）
    await vi.waitFor(() => expect(release).not.toBeNull());
    const pending = handle.search('qqq-no-hit'); // 续读在飞期间启动扫描 → 4ms 轮询等待期
    await vi.waitFor(() =>
      expect(host.querySelector('.vv-code-scan-progress')!.textContent).not.toBe('')
    ); // 扫描已挂条并写过首轮进度（自证非空转）
    const bar = host.querySelector('.vv-code-scan-progress')!;
    let writes = 0;
    let text = bar.textContent;
    Object.defineProperty(bar, 'textContent', {
      get: () => text,
      set: (v: string) => {
        writes += 1;
        text = v;
      }
    });
    await new Promise((r) => setTimeout(r, 250)); // 轮询 ≈60 轮：未节流会写 ~60 次
    expect(writes).toBeLessThanOrEqual(3); // ≥100ms 节流：250ms 窗口至多 3 次
    release!();
    await pending;
    handle.destroy();
  });

  // 项 E（Minor，W2-1）：runScan 异常路径退出时 search 的 catch 兜底不回写
  // lastScanComplete=false——残留 true 可使后续同键搜索以部分结果短路。修法：
  // catch 内补置位。异常注入面：searchCode 模块导出 spy（扫描推进途中抛）。
  it('项 E 扫描异常收场回写完成旗标：同 query 重搜重新扫描（非短路部分结果）', async () => {
    stubResizeObserver();
    attachHighlightClient({ highlight: async () => [] });
    const lines: string[] = [];
    for (let i = 0; i < 3400; i++) {
      const head = i === 10 ? 'alpha here ' : i === 3300 ? 'beta deep ' : `row ${i} `;
      lines.push(head + 'p'.repeat(Math.max(0, 1499 - head.length)) + '\n'); // 每行恰 1500B
    }
    const content = enc(lines.join('')); // ≈5.1MB ≈ 20 块
    let readCalls = 0;
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: async (r) => {
        readCalls += 1;
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    const first = await handle.search('alpha'); // 全文完成：完成旗标置 true
    expect(first.map((m) => m.line)).toEqual([10]);
    const spy = vi.spyOn(searchModule, 'searchCode');
    try {
      let injected = 0;
      spy.mockImplementation((linesArg, query, opts) => {
        injected += 1;
        // 扫描推进途中抛（约行 700 后：落在被 LRU 逐出的中间块区，注入前的推进
        // 已发生真实补块读——可视区常触的块 0/1 驻留零读，不构成「已推进」证据）
        if (injected > 700) throw new Error('扫描注入异常');
        return originalSearchCode(linesArg, query, opts);
      });
      const partial = await handle.search('beta'); // 换键扫描异常收场：catch 兜底部分结果
      expect(partial).toEqual([]); // beta 在未扫区（行 3300）：空手收场
      spy.mockRestore(); // 注入仅覆盖异常收场一拍：重搜须在干净 searchCode 下重扫
      const readsAtFail = readCalls;
      const second = await handle.search('beta'); // 同 query 重搜：旗标已回写 false → 重扫
      expect(readCalls).toBeGreaterThan(readsAtFail); // 重扫真实发生（非短路零读）
      expect(second.map((m) => m.line)).toEqual([3300]); // 完整命中（非部分结果短路）
    } finally {
      spy.mockRestore(); // 幂等兜底：断言失败路径同样不得泄漏至后续用例
    }
    handle.destroy();
  });

  // 项 F（Minor，W2-2）：scanLineText 补块失败的行按 '' 计入已扫（游标越过），续扫
  // 永不回访——命中静默永久缺失。修法：块拉取失败时记录失败块起始行（failedResume），
  // 收场游标不越过它；停机解除后的续扫自失败块起重扫（与项 E 配合覆盖失败区间）。
  // 返修（fix round 2）：回退点之后首扫已成功的命中（行 400）须在续扫起扫前截断——
  // 否则重扫再 push 一次（实证 [42, 400, 200, 400]）：命中数虚高、gotoMatch 索引
  // 错位、行级高亮区间重复。期望形态 [42, 200, 400]。
  it('项 F 补块失败游标回退：收场游标不越过失败块，同 query 重搜重访块 1（命中补齐且无重复）', async () => {
    stubResizeObserver();
    attachHighlightClient({ highlight: async () => [] });
    const lines: string[] = [];
    for (let i = 0; i < 4200; i++) {
      const head =
        i === 42
          ? 'zzneedle early '
          : i === 200
            ? 'zzneedle in block1 '
            : i === 400
              ? 'zzneedle later ' // 回退点（块 1 起始行 174）之后的首扫成功命中
              : `row ${i} `;
      lines.push(head + 'p'.repeat(Math.max(0, 1499 - head.length)) + '\n'); // 每行恰 1500B
    }
    const content = enc(lines.join('')); // ≈6.3MB ≈ 25 块 > 16：滚到底后早期块已逐出
    const reads: RangeCall[] = [];
    let readCalls = 0;
    let block1Retries = 0;
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: async (r) => {
        readCalls += 1;
        reads.push({ start: r.start, end: r.end });
        // 初始前向喂块成功；扫描期对块 1 的重拉首次失败、续扫放行
        if (r.start === WINDOW_BLOCK && readCalls > 25) {
          block1Retries += 1;
          if (block1Retries === 1) throw new Error('块 1 补拉失败（首扫）');
        }
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    scrollCode(host, Number.MAX_SAFE_INTEGER); // 续读到 EOF
    await vi.waitFor(() => expect(handle.getMeta().lines).toBe(4200));
    expect(readCalls).toBe(25); // 自校验：初始前向喂块恰每块一次（与项 3 用例同基线）
    const first = await handle.search('zzneedle');
    expect(first.map((m) => m.line)).toEqual([42, 400]); // 首扫：块 1 补拉失败行 200 缺失，失败块之后的行 400 照常命中
    const readsAtStop = readCalls;
    const second = await handle.search('zzneedle'); // 续扫自失败块 1 起始行（游标回退）
    expect(readCalls).toBeGreaterThan(readsAtStop); // 续扫真实发生
    expect(second.map((m) => m.line)).toEqual([42, 200, 400]); // 命中补齐且无重复（截断后重扫，行 400 不重复入集）
    const block1Reads = reads.filter((c) => c.start === WINDOW_BLOCK).length;
    expect(block1Reads).toBe(3); // 块 1 读 = 初始喂块 + 首扫失败重拉 + 续扫重拉（read 再次请求块 1）
    handle.destroy();
  });

  // 项 F 残留角（复审）：startFrom=0 的同键续扫（块 0 命中后扫描途中异常、游标未
  // 写点）——截断无条件执行（不按 startFrom > 0 设门）后重扫自 0 重收，命中不重复。
  // 注入面用 REAL_SEARCH_CODE 透传（顶层捕获的原函数值）：call 1（行 0）真实执行
  // 命中入 acc，call 2（行 1）抛——若误用 named import 透传会路由回 spy，行 0 命中
  // 永不入集，用例退化为平凡成立（回退源码修复依然全绿，锚不住截断）。
  it('项 F 残留角：块 0 命中后扫描异常（游标未写）——同 query 重搜命中不重复', async () => {
    stubResizeObserver();
    attachHighlightClient({ highlight: async () => [] });
    const lines: string[] = [];
    for (let i = 0; i < 3400; i++) {
      const head = i === 0 ? 'aa early ' : i === 3000 ? 'aa deep ' : `row ${i} `;
      lines.push(head + 'p'.repeat(Math.max(0, 1499 - head.length)) + '\n'); // 每行恰 1500B
    }
    const content = enc(lines.join('')); // ≈5.1MB ≈ 20 块
    let readCalls = 0;
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: async (r) => {
        readCalls += 1;
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = newHost();
    const handle = renderCode(content.slice(0, 8192), host, { ext: 'js', lang: 'javascript', ctx });
    await vi.waitFor(() => expect(bodyText(host, 0)).toBeDefined());
    const spy = vi.spyOn(searchModule, 'searchCode');
    try {
      let injected = 0;
      spy.mockImplementation((linesArg, query, opts) => {
        injected += 1;
        // 块 0 内、行 0 命中已入集后的下一行抛（游标未写点：异常前无块级检查点）
        if (injected === 2) throw new Error('扫描注入异常'); // 行 0 已命中入 acc、检查点未写
        return REAL_SEARCH_CODE(linesArg, query, opts);
      });
      const partial = await handle.search('aa'); // 异常收场：游标残留 0（未达块级检查点，
      // lastScanCursor 未写）。runScan 的 acc 即 lastAcc 同一引用，search catch 返回
      // lastAcc=[行 0 命中]——部分结果含已入集命中（异常在检查点前，acc 即所得）
      expect(partial.map((m) => m.line)).toEqual([0]);
      spy.mockRestore();
      const second = await handle.search('aa'); // 同 query 重搜：自 0 重扫
      expect(second.map((m) => m.line)).toEqual([0, 3000]); // 无重复（截断无条件生效）
    } finally {
      spy.mockRestore();
    }
    handle.destroy();
  });

  // 流式硬化 Task 3：实例级 AbortController（DEG-08 排队根因的修复面）——destroy
  // 即取消全部在飞块读；abort 产生的 reject 是取消而非读失败，catch 静默（闩不动、
  // 不打印）。controller 归实例内部，测试只观测 ctx.read 收到的 signal。在飞挂起
  // 点必须选在泵 tick 的块 1（首块立即 resolve 成功 mount）——abort reject 真实落
  // 在泵 catch 上，断言 2 才对静默分支有杀伤力（评审变异验证：挂起点若在 start()
  // 首拉，reject 经 whenReady 上抛、泵 catch 不执行，断言 vacuous pass）。
  it('destroy 取消在飞读：signal aborted，泵 catch 静默（continueFailed 闩不置位）', async () => {
    stubResizeObserver();
    const debugSpy = vi.spyOn(console, 'debug');
    const content = enc(codeLines(1280)); // ≈1.9MB ≈ 8 块：首块成功 mount 后仍有大量块可拉
    const calls: Array<{ start: number; end: number }> = [];
    let sawSignal: AbortSignal | undefined;
    const ctx: StreamCtx = {
      size: 5 * WINDOW_BLOCK,
      head: content.slice(0, 8192),
      read: (r, signal) => {
        calls.push({ start: r.start, end: r.end });
        sawSignal = signal;
        if (r.start === 0) {
          return Promise.resolve(content.slice(0, WINDOW_BLOCK)); // 块 0 立即 resolve：首屏成功 mount
        }
        // 块 1+（后台索引泵的续拉）挂起在飞：destroy 时经 signal 取消（reject 落泵 catch）
        return new Promise((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
    };
    const host = newHost();
    const inst = renderCode(content.slice(0, 8192), host, { ctx, ext: 'js', highlight: false });
    await vi.waitFor(() => expect(calls.length).toBe(2)); // 首块成功 + 泵 tick 已发出块 1 读（在飞挂起）
    expect(calls[1]!.start).toBe(WINDOW_BLOCK); // 在飞的正是泵的续拉（自校验非首块）
    inst.destroy();
    // 断言 1：destroy 后实例持有的 signal 立即 aborted（不等读自然结束）
    await vi.waitFor(() => expect(sawSignal!.aborted).toBe(true), { timeout: 2_000 });
    await new Promise((r) => setTimeout(r, 20)); // abort reject 落地：泵 catch 静默路径执行完
    // 断言 2：泵 catch 静默——不打印「后台索引泵拉块失败」（abort ≠ 读失败）
    expect(debugSpy).not.toHaveBeenCalledWith(expect.stringContaining('后台索引泵拉块失败'), expect.anything());
    debugSpy.mockRestore();
  });

  // deferred 清偿 Task 3 锚 A：非 abort 读失败照常置闩 + debug（收紧的反面不误伤）。
  // 块 1 立即以普通 Error reject（ECONNRESET 形态），无任何 abort 参与——失败经
  // 后台索引泵 catch 落 continueFailed 停机闩 + 留痕。
  it('abort 判定收紧锚 A：非 abort 读失败照常置闩+日志（无 abort 参与）', async () => {
    stubResizeObserver();
    const debugSpy = vi.spyOn(console, 'debug');
    const content = enc(codeLines(1280)); // ≈1.9MB ≈ 8 块：首块成功 mount 后仍有大量块可拉
    const ctx: StreamCtx = {
      size: 5 * WINDOW_BLOCK,
      head: content.slice(0, 8192),
      read: (r) =>
        r.start === 0
          ? Promise.resolve(content.slice(0, WINDOW_BLOCK)) // 块 0 立即 resolve：首屏成功 mount
          : Promise.reject(Object.assign(new Error('连接被重置'), { code: 'ECONNRESET' })) // 块 1+：真实读失败（无 abort 参与）
    };
    const host = newHost();
    const inst = renderCode(content.slice(0, 8192), host, { ctx, ext: 'js', highlight: false });
    await vi.waitFor(
      () => expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('后台索引泵拉块失败'), expect.anything()),
      { timeout: 2_000 }
    );
    debugSpy.mockRestore();
    inst.destroy();
  });

  // deferred 清偿 Task 3 锚 B（收紧主断言）：destroy 竞态下的真实读失败不被误吞。
  // 块 1 读先挂起（无视 signal）→ destroy（signal 已 aborted）→ read 随后以普通
  // Error reject——catch 时刻 signal.aborted 为真但 err 非 AbortError：旧判定按
  // 「catch 时 signal 状态」会静默误吞，收紧后按错误身份判定照常置闩 + 留痕
  // （destroyed 终态无消费方，日志如实）。
  it('abort 判定收紧：destroy 竞态下的真实读失败不被误吞（置闩+日志，非静默）', async () => {
    stubResizeObserver();
    const debugSpy = vi.spyOn(console, 'debug');
    const content = enc(codeLines(1280));
    const calls: Array<{ start: number; end: number }> = [];
    let sawSignal: AbortSignal | undefined;
    const ctx: StreamCtx = {
      size: 5 * WINDOW_BLOCK,
      head: content.slice(0, 8192),
      read: (r, signal) => {
        calls.push({ start: r.start, end: r.end });
        sawSignal = signal;
        if (r.start === 0) {
          return Promise.resolve(content.slice(0, WINDOW_BLOCK)); // 块 0 立即 resolve：首屏成功 mount
        }
        // 块 1+：忽略 signal 挂起 50ms 后以真实读失败 reject——「先失败/挂起、
        // 等待期 destroy abort、catch 时 signal 已 aborted」的竞态形态
        return new Promise((_, reject) => {
          setTimeout(() => reject(Object.assign(new Error('连接被重置'), { code: 'ECONNRESET' })), 50);
        });
      }
    };
    const host = newHost();
    const inst = renderCode(content.slice(0, 8192), host, { ctx, ext: 'js', highlight: false });
    await vi.waitFor(() => expect(calls.length).toBe(2)); // 首块成功 + 泵 tick 已发出块 1 读（挂起中）
    expect(calls[1]!.start).toBe(WINDOW_BLOCK); // 在飞的正是泵的续拉（自校验非首块）
    inst.destroy(); // 竞态注入点：块 1 在飞挂起中 destroy → signal aborted
    await vi.waitFor(() => expect(sawSignal!.aborted).toBe(true), { timeout: 2_000 });
    // 收紧断言：catch 时 signal 已 aborted 且 err 非 AbortError → 不静默（旧实现误吞）
    await vi.waitFor(
      () => expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('后台索引泵拉块失败'), expect.anything()),
      { timeout: 2_000 }
    );
    debugSpy.mockRestore();
  });
});

describe('isAbortError（deferred 清偿 Task 3：取消错误身份判定矩阵）', () => {
  it('DOMException AbortError / Error name AbortError → true；普通 Error / 非 Abort 的 DOMException / 非 Error 值 → false', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true); // localFiles/singleFile 预 abort 形态（Task 1 统一）
    expect(isAbortError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true); // DOMException 非 Error 子类环境的兜底形态
    expect(isAbortError(new Error('连接被重置'))).toBe(false); // 真实读失败（ECONNRESET 形态）
    expect(isAbortError(new DOMException('普通 DOM 异常', 'SyntaxError'))).toBe(false); // 非 Abort 的 DOMException
    expect(isAbortError(Object.assign(new Error('fail'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isAbortError('abort')).toBe(false); // 非 Error 值
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});
