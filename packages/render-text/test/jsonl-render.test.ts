import { afterEach, describe, expect, it, vi } from 'vitest';
import { HighlightCanceledError, type HighlightInterval } from '@vviewer/highlight';
import type { Detection, FileSource, RenderedInstance, StreamCtx } from '@vviewer/core';
import { STREAM_MAX_BYTES } from '../src/blockStream';
import { attachHighlightClient, type CodeFileMeta } from '../src/code';
import { jsonlRenderer, jsonlWindowedInternals, shouldDelegateToCode } from '../src/jsonl/index';

/** fake ctx 的请求区间记录（blockStream.test.ts 同款） */
interface RangeCall {
  start: number;
  end: number;
}

/** jsonlRenderer.render 按 Renderer 接口返回 RenderedInstance；getMeta 为鸭子扩展 */
type JsonlInstance = RenderedInstance & { getMeta(): CodeFileMeta };

const source: FileSource = {
  storeId: 'local',
  storeLabel: 'local',
  path: '/x.jsonl',
  name: 'x.jsonl',
  store: {} as FileSource['store']
};
const det: Detection = { ext: 'jsonl', encoding: 'utf-8' };
const enc = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  return host;
}

/** jsdom 无 ResizeObserver，stub 之（code.test.ts 同款） */
function stubResizeObserver(): void {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
}

afterEach(() => {
  attachHighlightClient(null);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('shouldDelegateToCode（>200MB 委托 code 的阈值裁决）', () => {
  it('200MB 整不委托，200MB+1 委托', () => {
    expect(shouldDelegateToCode(200 * 1024 * 1024)).toBe(false);
    expect(shouldDelegateToCode(200 * 1024 * 1024 + 1)).toBe(true);
  });
});

describe('renderJsonl 卡片渲染', () => {
  it('ok/failed/oversize 混合：卡片数=非空行数、failed 带 badge+title、oversize 64KB 预览+徽标、状态条计数', async () => {
    stubResizeObserver();
    const oversize = 'x'.repeat(1_048_576); // ≥1MB 阈值即 oversize（不进 JSON.parse）
    const text = '{"a":1}\nnot json\n' + oversize + '\n';
    const host = mount();
    const inst = (await jsonlRenderer.render(enc(text), host, source, det)) as JsonlInstance;
    const cards = host.querySelectorAll('.vv-jsonl-card');
    expect(cards.length).toBe(3); // 尾空行不入列

    const ok = cards[0]!;
    expect(ok.querySelector('.vv-jsonl-gutter')?.textContent).toBe('1');
    expect((ok.querySelector('.vv-jsonl-body') as HTMLElement).textContent).toBe('{\n  "a": 1\n}');

    const failed = cards[1] as HTMLElement;
    expect(failed.classList.contains('vv-jsonl-card-failed')).toBe(true);
    expect(failed.title).not.toBe(''); // reason 写入 title
    expect(failed.querySelector('.vv-jsonl-badge')?.textContent).toBe('解析失败');

    const oversizeCard = cards[2]!;
    expect(oversizeCard.querySelector('.vv-jsonl-badge')?.textContent).toBe('行过大（>1MB）');
    expect((oversizeCard.querySelector('.vv-jsonl-body') as HTMLElement).textContent!.length)
      .toBe(65_536); // 只保留 64KB 预览

    expect(host.querySelector('.vv-jsonl-status')?.textContent).toBe('共 3 行 · 1 行解析失败');
    expect(host.querySelector('.vv-jsonl-status')?.getAttribute('aria-live')).toBe('polite'); // 恒挂
    expect(inst.getMeta()).toEqual({ encoding: 'utf-8', lang: 'json', size: enc(text).length, lines: 3 });
    inst.destroy();
  });

  it('全空行文件：不进窗口循环，空状态「共 0 行」，无卡片', async () => {
    stubResizeObserver();
    const host = mount();
    const inst = (await jsonlRenderer.render(enc('\n\n  \n'), host, source, det)) as JsonlInstance;
    expect(host.querySelector('.vv-jsonl-status')?.textContent).toBe('共 0 行');
    expect(host.querySelectorAll('.vv-jsonl-card').length).toBe(0);
    expect(inst.getMeta().lines).toBe(0);
    inst.destroy();
  });
});

describe('renderJsonl 卡片级高亮', () => {
  it('首屏只高亮可视卡片（调用量=可视卡片数而非全量），lang 恒 json', async () => {
    stubResizeObserver();
    const calls: Array<[string, string]> = [];
    attachHighlightClient({
      highlight: async (text, lang) => {
        calls.push([text, lang]);
        return [];
      }
    });
    const rows = Array.from({ length: 40 }, (_, i) => JSON.stringify({ i }));
    const host = mount();
    const inst = await jsonlRenderer.render(enc(rows.join('\n')), host, source, det);
    const cards = host.querySelectorAll('.vv-jsonl-card');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.length).toBeLessThan(rows.length); // 窗口内而非全量
    expect(calls.length).toBe(cards.length); // 每可视卡片恰好一次
    expect(calls.every(([, lang]) => lang === 'json')).toBe(true);
    inst.destroy();
  });

  it('pretty 超 1M 字符上限：跳过自动高亮保持纯文本，console.debug 仅一次', async () => {
    stubResizeObserver();
    const calls: Array<[string, string]> = [];
    attachHighlightClient({
      highlight: async (text, lang) => {
        calls.push([text, lang]);
        return [];
      }
    });
    const dbg = vi.spyOn(console, 'debug').mockImplementation(() => {});
    // 27 万个数字元素：raw ≈ 0.54MB（<1MB 不判 oversize），pretty ≈ 1.08M 字符（>1M 上限）
    const compact = '[' + '0,'.repeat(269_999) + '0]';
    const host = mount();
    const inst = await jsonlRenderer.render(enc(compact), host, source, det);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(0); // 跳过自动高亮
    expect(
      (host.querySelector('.vv-jsonl-body') as HTMLElement).textContent!.startsWith('[\n  0,')
    ).toBe(true); // pretty 纯文本仍在
    expect(dbg).toHaveBeenCalledTimes(1); // 每卡只留痕一次
    dbg.mockRestore();
    inst.destroy();
  });

  it('intervals 转行 span HTML：highlight 到达后卡片着色（复用 renderLineHtml 管线）', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => [{ start: 0, end: 1, capture: 'keyword' }] as HighlightInterval[]
    });
    const host = mount();
    const inst = await jsonlRenderer.render(enc('{"a":1}'), host, source, det);
    await vi.waitFor(() => {
      expect(host.querySelector('.vv-jsonl-card .ts-keyword')).not.toBeNull();
    });
    expect(host.querySelector('.vv-jsonl-card .ts-keyword')?.textContent).toBe('{');
    inst.destroy();
  });

  it('highlight reject HighlightCanceledError → 不写 DOM 高亮、静默（无未处理 rejection）', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: async () => {
        throw new HighlightCanceledError();
      }
    });
    const host = mount();
    const inst = await jsonlRenderer.render(enc('{"a":1}'), host, source, det);
    await new Promise((r) => setTimeout(r, 20));
    expect(host.querySelector('.ts-')).toBeNull(); // 取消不写高亮 DOM
    expect((host.querySelector('.vv-jsonl-body') as HTMLElement).textContent).toBe('{\n  "a": 1\n}');
    inst.destroy();
  });

  it('destroy 后在途 reject 被 swallow（不抛未处理 rejection）', async () => {
    stubResizeObserver();
    attachHighlightClient({
      highlight: () =>
        new Promise<HighlightInterval[]>((_, reject) =>
          setTimeout(() => reject(new HighlightCanceledError()), 20)
        )
    });
    const host = mount();
    const inst = await jsonlRenderer.render(enc('{"a":1}'), host, source, det);
    inst.destroy();
    await new Promise((r) => setTimeout(r, 50)); // reject 落在 destroy 之后：被 swallow
    expect(host.querySelector('.vv-jsonl-card')).toBeNull();
    expect(host.classList.contains('vv-jsonl')).toBe(false);
  });
});

describe('renderJsonl 折叠/封顶', () => {
  it('>40 行初始 40 行可见 + 展开按钮；点击后 ≤400 全显', async () => {
    stubResizeObserver();
    // 39 元素数组 pretty 后 41 行（[ + 39 项 + ]），prettyLines 口径 42 > 40 → 折叠
    const compact = JSON.stringify(Array.from({ length: 39 }, (_, i) => i));
    const host = mount();
    const inst = await jsonlRenderer.render(enc(compact), host, source, det);
    const card = host.querySelector('.vv-jsonl-card')!;
    const body = card.querySelector('.vv-jsonl-body') as HTMLElement;
    expect(body.textContent!.split('\n').length).toBe(40); // 折叠 40 行可见
    const btn = card.querySelector('.vv-jsonl-expand') as HTMLButtonElement;
    expect(btn.textContent).toBe('展开全部');
    btn.click(); // 展开全量重渲染该卡片
    const expandedBody = host.querySelector('.vv-jsonl-body') as HTMLElement;
    expect(expandedBody.textContent!.split('\n').length).toBe(41); // slice 容忍 visibleLines=真实+1
    expect(host.querySelector('.vv-jsonl-expand')).toBeNull(); // 展开后按钮移除
    inst.destroy();
  });

  it('>400 行：折叠初始 40 行；展开封顶 400 行 + .vv-jsonl-cap + 卡片内滚动', async () => {
    stubResizeObserver();
    const compact = JSON.stringify(Array.from({ length: 420 }, (_, i) => i)); // pretty 422 行 > 400 封顶
    const host = mount();
    const inst = await jsonlRenderer.render(enc(compact), host, source, det);
    const card = host.querySelector('.vv-jsonl-card')!;
    // spec：默认折叠显示首 40 行（capped 不改变折叠初始态，不再初始 400 行）
    expect((card.querySelector('.vv-jsonl-body') as HTMLElement).textContent!.split('\n').length)
      .toBe(40);
    expect(card.querySelector('.vv-jsonl-cap')).toBeNull(); // 未展开无截断提示
    (card.querySelector('.vv-jsonl-expand') as HTMLButtonElement).click();
    const body = host.querySelector('.vv-jsonl-body') as HTMLElement;
    expect(body.textContent!.split('\n').length).toBe(400); // 展开仍封顶 400 行
    const cap = host.querySelector('.vv-jsonl-cap');
    expect(cap?.textContent).toBe('已截断显示（400 行）'); // N = min(400, 实际 422) = 400
    expect(body.style.maxHeight).not.toBe(''); // 卡片内 max-height 滚动
    expect(body.style.overflowY).toBe('auto');
    expect(host.querySelector('.vv-jsonl-expand')).toBeNull();
    inst.destroy();
  });

  it('failed 巨行（>64KB）：预览截断 + 截断徽标，仍计入失败数', async () => {
    stubResizeObserver();
    const text = '{"a":1}\n' + '{oops' + 'x'.repeat(70_000) + '\n';
    const host = mount();
    const inst = await jsonlRenderer.render(enc(text), host, source, det);
    const failed = host.querySelector('.vv-jsonl-card-failed') as HTMLElement;
    expect((failed.querySelector('.vv-jsonl-body') as HTMLElement).textContent!.length).toBe(65_536);
    expect(failed.textContent).toContain('已截断');
    expect(host.querySelector('.vv-jsonl-status')?.textContent).toBe('共 2 行 · 1 行解析失败');
    inst.destroy();
  });
});

// ---------------------------------------------------------------------------
// 窗口模式（第 4 参 ctx：UTF-8 流式索引 + 块解码缓存 + 滚动续读，spec §4.2）
// ---------------------------------------------------------------------------

/** 窗口模式块大小（与实现 WINDOW_BLOCK_BYTES 同值；实现侧为模块私有常量） */
const BLOCK = 256 * 1024;

/** fake StreamCtx：content 为底层全量数据，read 记录每次请求区间（blockStream.test.ts 同款） */
function streamCtx(opts: {
  size: number | null;
  content: Uint8Array<ArrayBuffer>;
  head?: Uint8Array<ArrayBuffer>;
  calls?: RangeCall[];
}): StreamCtx {
  return {
    size: opts.size,
    head: opts.head ?? new Uint8Array(0),
    read: async (r) => {
      opts.calls?.push({ start: r.start, end: r.end });
      return opts.content.slice(r.start, r.end + 1);
    }
  };
}

/** 固定字长的合法 JSONL 行内容（纯 ASCII，行长 ≈ lineBytes 字节） */
function padLines(n: number, lineBytes: number): string {
  return Array.from({ length: n }, (_, i) => {
    const head = `{"i":${i},"pad":"`;
    const tail = '"}';
    return head + 'p'.repeat(Math.max(0, lineBytes - head.length - tail.length)) + tail;
  }).join('\n');
}

/** gb18030 字节串构造（测试专用极简表：'中'=0xd6 0xd0，其余字符走 UTF-8 直通——
 * 仅用于构造「非 UTF-8 探测头」形态的假字节，解码侧由被测代码的 DECODERS 表承担） */
function gbBytes(rows: string[]): Uint8Array<ArrayBuffer> {
  const parts: number[] = [];
  for (const row of rows) {
    for (const ch of row) {
      if (ch === '中') parts.push(0xd6, 0xd0);
      else parts.push(...new TextEncoder().encode(ch));
    }
    parts.push(0x0a); // LF 终结符
  }
  return Uint8Array.from(parts);
}

/** 模拟滚动到最底（jsdom 无布局：scrollTop 大值 → rowAt 夹到末行） */
function scrollToBottom(host: HTMLElement): void {
  const scroll = host.querySelector('.vv-jsonl-scroll') as HTMLElement;
  scroll.scrollTop = Number.MAX_SAFE_INTEGER;
  scroll.dispatchEvent(new Event('scroll'));
}

describe('renderJsonl 窗口模式（ctx + UTF-8 流式）', () => {
  // A1（遗留清偿）：首屏并行预取——prefetchThrough(1) 一次 RTT 并发发出前两块的
  // read（IO-05 同款夹持思路到单测）：两块都未决时观测发起面，旧串行实现此处
  // calls 停在 1（首块 resolve 前第二块绝不发出），并行化后恰 2。
  it('首屏并行预取：前两块 read 在任一放行前并发发出（夹持），放行后零新增拉取完成首屏', async () => {
    stubResizeObserver();
    const text = padLines(400, 1500); // ≈600KB > 2×256KB：首屏恰前两块
    const content = enc(text);
    const calls: RangeCall[] = [];
    const resolvers = new Map<number, () => void>();
    let n = 0;
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: (r) => {
        calls.push({ start: r.start, end: r.end });
        const k = n++;
        return new Promise((resolve) => {
          resolvers.set(k, () => resolve(content.slice(r.start, r.end + 1)));
        });
      }
    };
    const host = mount();
    const renderP = jsonlRenderer.render(content.slice(0, 8192), host, source, det, ctx) as Promise<JsonlInstance>;
    await new Promise((r) => setTimeout(r, 0));
    // 夹持断言：两块 read 均已发出且都未决（串行旧实现 calls 停在 1，此处红）
    expect(calls).toStrictEqual([
      { start: 0, end: BLOCK - 1 },
      { start: BLOCK, end: 2 * BLOCK - 1 }
    ]);
    resolvers.forEach((release) => release());
    const inst = await renderP;
    expect(calls.length).toBe(2); // 并行不增请求数（IO-05「探针+2 块」计量口径）
    expect(host.querySelectorAll('.vv-jsonl-card').length).toBeGreaterThan(0);
    expect(host.querySelector('.vv-jsonl-status')!.textContent!.startsWith('已加载 ')).toBe(true);
    inst.destroy();
  });

  it('首屏只拉 2 块（fake ctx 区间断言，8KB head 部分块被整块重拉）；状态条「已加载 N 行」与 meta.lines 动态一致；首屏不触发续读', async () => {
    stubResizeObserver();
    const text = padLines(400, 1500); // ≈600KB > 2×256KB，第 3 块未拉
    const content = enc(text);
    const calls: RangeCall[] = [];
    const host = mount();
    const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, det,
      streamCtx({ size: null, content, head: content.slice(0, 8192), calls }))) as JsonlInstance;
    expect(calls).toStrictEqual([
      { start: 0, end: BLOCK - 1 },
      { start: BLOCK, end: 2 * BLOCK - 1 }
    ]);
    const status = host.querySelector('.vv-jsonl-status')!.textContent!;
    expect(status.startsWith('已加载 ')).toBe(true);
    expect(status.endsWith(' 行')).toBe(true);
    const loaded = Number(status.slice('已加载 '.length, -' 行'.length));
    expect(loaded).toBeGreaterThan(0);
    expect(loaded).toBeLessThan(400); // EOF 未确认，非终值
    expect(inst.getMeta().lines).toBe(loaded); // getMeta().lines = 动态已加载行数
    await new Promise((r) => setTimeout(r, 20)); // 首屏窗口远离已加载尾部：不触发续读
    expect(calls.length).toBe(2);
    inst.destroy();
  });

  // 项 4（ViewerPane meta 轮询的消费面契约）：apps/web 无 .svelte 组件测试基建
  //（根 vitest 配置无 svelte 插件），此处钉渲染层契约——窗口模式 getMeta 的
  // size/lines 随续读动态增长（ViewerPane 的 250ms 周期重读上行消费的就是它，
  // 重读非 no-op）；组件侧接线由 svelte-check 与 e2e 兜底（报告已说明取舍）。
  it('meta 动态消费面：size 未知时 getMeta 的 size/lines 随续读增长，EOF 后 size=全量', async () => {
    stubResizeObserver();
    const text = padLines(400, 1500);
    const content = enc(text);
    const host = mount();
    const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, det,
      streamCtx({ size: null, content, head: content.slice(0, 8192) }))) as JsonlInstance;
    await vi.waitFor(() => expect(inst.getMeta().lines).toBeGreaterThan(0));
    const first = inst.getMeta();
    expect(first.size).toBeLessThan(content.length); // 首屏：size 未知 → 已确认字节（未 EOF）
    scrollToBottom(host);
    await vi.waitFor(() => expect(inst.getMeta().lines).toBe(400));
    expect(inst.getMeta().size).toBe(content.length); // EOF：已确认字节=全量（轮询可见增长）
    inst.destroy();
  });

  it('滚动到底触发续读至 EOF：状态条变「共 N 行」；EOF 后再滚动无新 read（finish 后不再 advance）', async () => {
    stubResizeObserver();
    const text = padLines(400, 1500);
    const content = enc(text);
    const calls: RangeCall[] = [];
    const host = mount();
    const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, det,
      streamCtx({ size: null, content, head: content.slice(0, 8192), calls }))) as JsonlInstance;
    scrollToBottom(host);
    await vi.waitFor(() => {
      expect(host.querySelector('.vv-jsonl-status')!.textContent!.startsWith('共 400 行')).toBe(true);
    });
    expect(inst.getMeta().lines).toBe(400);
    expect(host.querySelector('[data-line="399"]')).not.toBeNull(); // 尾行卡片已渲染
    const readsAtEnd = calls.length;
    for (let k = 0; k < 3; k++) {
      host.querySelector('.vv-jsonl-scroll')!.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(calls.length).toBe(readsAtEnd); // EOF 已确认：不再产生任何 read
    inst.destroy();
  });

  it('同文件双模式 DOM 逐字节一致（BOM/CRLF/跨块多字节字符/折叠/失败行/oversized/悬挂尾行；块 0 尾恰切「中」字）', async () => {
    stubResizeObserver();
    // 字节布局：BOM + CRLF 行 + 空行 + 纯空白行 = 17 字节；填充行使「中」的首字节
    // 恰落在 256KB 块边界前 1 字节（跨块字符不得被打成 U+FFFD）
    const headPart = '\uFEFF{"a":1}\r\n\n   \n';
    const headBytes = enc(headPart).length;
    const padLine = 'p'.repeat(BLOCK - 1 - headBytes - 1); // 填充行 + '\n' 恰至块边界前 1 字节
    const text = headPart + padLine + '\n'
      + '中{"b":"跨块字符"}🎉\n'
      + JSON.stringify(Array.from({ length: 39 }, (_, i) => i)) + '\n' // pretty 41 行 → 折叠
      + 'not json\n'
      + 'plain\rline\n'
      + 'x'.repeat(1_048_576) + '\n'
      + '{"tail":"no trailing newline"}';
    const bytes = enc(text);
    expect(bytes[BLOCK - 1]).toBe(0xe4); // 「中」（E4 B8 AD）首字节在块 0 尾
    expect(bytes[BLOCK]).toBe(0xb8); // 其余续字节跨入块 1（切口不得打碎该字符）

    const hostA = mount();
    const instA = (await jsonlRenderer.render(bytes, hostA, source, det)) as JsonlInstance; // 全量模式（无 ctx）
    const hostB = mount();
    const calls: RangeCall[] = [];
    const instB = (await jsonlRenderer.render(bytes.slice(0, 8192), hostB, source, det,
      streamCtx({ size: bytes.length, content: bytes, head: bytes.slice(0, 8192), calls }))) as JsonlInstance;
    await vi.waitFor(() => { // 检查点为 EOF 排空后而非首帧：本文件行数少（9 行 < 可视窗
      // ~20 行），首帧任意可视末行都「近尾部」→ 静默续读直至 EOF 的设计行为（首帧即终态）
      expect(hostB.querySelector('.vv-jsonl-status')!.textContent!.startsWith('共 9 行')).toBe(true);
    });
    const domA = () => (hostA.querySelector('.vv-jsonl-scroll') as HTMLElement).innerHTML;
    const domB = () => (hostB.querySelector('.vv-jsonl-scroll') as HTMLElement).innerHTML;
    expect(hostB.querySelector('.vv-jsonl-status')!.textContent)
      .toBe(hostA.querySelector('.vv-jsonl-status')!.textContent);
    expect(domB()).toBe(domA()); // EOF 排空后的窗口 DOM 逐字节一致（非首帧快照，见上检查点注释）
    // 跨块多字节显式断言（等价性比对之外的独立钉面）：块 0 尾「中」字切口必须字节域
    // 缝合——两种模式的行 body 均含完整多字节字符且无 U+FFFD（切口打碎即现替换符）
    for (const h of [hostA, hostB]) {
      const cross = [...h.querySelectorAll<HTMLElement>('.vv-jsonl-body')]
        .find((el) => (el.textContent ?? '').includes('跨块字符'));
      expect(cross).toBeDefined(); // 跨块行已入窗（EOF 后窗口覆盖首部行段）
      expect(cross!.textContent).toContain('中');
      expect(cross!.textContent).toContain('跨块字符');
      expect(cross!.textContent).toContain('🎉');
      expect(cross!.textContent).not.toContain('\uFFFD');
    }
    scrollToBottom(hostA);
    scrollToBottom(hostB);
    await new Promise((r) => setTimeout(r, 20));
    expect(domB()).toBe(domA()); // 滚动到底后仍逐字节一致（oversized/失败行/尾行窗口）
    expect(instA.getMeta().lines).toBe(instB.getMeta().lines);
    instA.destroy();
    instB.destroy();
  });

  it('块解码缓存 LRU 上限 8 块：滚动扫过 10 个块后缓存恰好压到上限', async () => {
    stubResizeObserver();
    const text = padLines(2000, 1200); // ≈2.4MB ≈ 10 块
    const content = enc(text);
    const host = mount();
    const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, det,
      streamCtx({ size: content.length, content, head: content.slice(0, 8192) }))) as JsonlInstance;
    scrollToBottom(host); // 先续读到全文加载
    await vi.waitFor(() => {
      expect(host.querySelector('.vv-jsonl-status')!.textContent!.startsWith('共 2000 行')).toBe(true);
    });
    // 分步扫过整文件：行文本提取触及 >8 个块（15000px ≈ 125 行 ≈ 0.6 块/步）
    for (let y = 0; y <= 250_000; y += 15_000) {
      const scroll = host.querySelector('.vv-jsonl-scroll') as HTMLElement;
      scroll.scrollTop = y;
      scroll.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 5));
    }
    const internals = jsonlWindowedInternals.get(inst);
    expect(internals).toBeDefined();
    expect(internals!.blockTextCache.size).toBe(8); // 触及 >8 块才可能顶到上限（自我校验非空转）
    inst.destroy();
  });

  it('oversized 行（索引判 ≥1MB）：不跨块拼装，前 2 块内不出现；滚动加载后 64KB 预览 + 徽标与全量一致', async () => {
    stubResizeObserver();
    const text = '{"a":1}\n' + 'x'.repeat(1_048_576) + '\n{"b":2}\n';
    const content = enc(text);
    const host = mount();
    const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, det,
      streamCtx({ size: content.length, content, head: content.slice(0, 8192) }))) as JsonlInstance;
    expect(host.querySelectorAll('.vv-jsonl-card').length).toBe(1); // 巨行未终结：只加载第 1 行
    scrollToBottom(host);
    await vi.waitFor(() => {
      expect(host.querySelector('.vv-jsonl-status')!.textContent).toBe('共 3 行');
    });
    const oversizeCard = host.querySelector('[data-line="1"]') as HTMLElement;
    expect(oversizeCard.querySelector('.vv-jsonl-badge')!.textContent).toBe('行过大（>1MB）');
    const body = oversizeCard.querySelector('.vv-jsonl-body') as HTMLElement;
    expect(body.textContent).toBe('x'.repeat(65_536)); // 与全量 parseJsonlLine 64KB 截断逐字符一致
    inst.destroy();
  });

  it('BOM 文件：索引/解码前剥离字节（首行正常解析不 failed）——T2→T3 指令①断言钉住', async () => {
    stubResizeObserver();
    const body = enc('{"a":1}\n{"b":2}');
    const content = new Uint8Array(3 + body.length);
    content.set([0xef, 0xbb, 0xbf], 0);
    content.set(body, 3);
    const host = mount();
    const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, det,
      streamCtx({ size: null, content, head: content.slice(0, 8192) }))) as JsonlInstance;
    expect(host.querySelector('.vv-jsonl-status')!.textContent).toBe('共 2 行'); // 无「解析失败」徽标
    const first = host.querySelector('.vv-jsonl-card') as HTMLElement;
    expect(first.classList.contains('vv-jsonl-card-failed')).toBe(false);
    expect((first.querySelector('.vv-jsonl-body') as HTMLElement).textContent).toBe('{\n  "a": 1\n}');
    inst.destroy();
  });

  it('流式中途失败行：徽标文案不变，「已加载 N 行 · X 行解析失败」→ EOF 后「共 N 行 · X 行解析失败」', async () => {
    stubResizeObserver();
    const text = 'not json\n' + padLines(400, 1500); // 401 行，失败行在首屏
    const content = enc(text);
    const host = mount();
    const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, det,
      streamCtx({ size: null, content, head: content.slice(0, 8192) }))) as JsonlInstance;
    expect(host.querySelector('.vv-jsonl-status')!.textContent)
      .toMatch(/^已加载 \d+ 行 · 1 行解析失败$/);
    scrollToBottom(host);
    await vi.waitFor(() => {
      expect(host.querySelector('.vv-jsonl-status')!.textContent).toBe('共 401 行 · 1 行解析失败');
    });
    inst.destroy();
  });

  it('非 UTF-8 encoding（gb18030）+ ctx：走全量路径（现状行为），ctx.read 未被调用', async () => {
    stubResizeObserver();
    const content = Uint8Array.from([0xd6, 0xd0]); // 「中」的 gb18030 编码
    const calls: RangeCall[] = [];
    const host = mount();
    const gbDet: Detection = { ext: 'jsonl', encoding: 'gb18030' };
    const inst = (await jsonlRenderer.render(content, host, source, gbDet,
      streamCtx({ size: content.length, content, head: content, calls }))) as JsonlInstance;
    expect(calls).toStrictEqual([]); // 全量路径不触碰 ctx
    expect(host.querySelector('.vv-jsonl-status')!.textContent).toBe('共 1 行 · 1 行解析失败');
    expect((host.querySelector('.vv-jsonl-body') as HTMLElement).textContent).toBe('中'); // gb18030 解码正确
    expect(inst.getMeta().encoding).toBe('gb18030');
    inst.destroy();
  });

  // streaming 声明后的回退矩阵收口：dispatcher streaming 分支（capable 且 size>1MB 或
  // size 未知）只交付 8KB 探测头作 buffer——非 UTF-8 不进窗口模式，全量路径若直接解码
  // 头部即静默截断。render 入口须先经 ctx.read 补拉全量（head 已覆盖全文件时不触发）。
  it('非 UTF-8 + 探测头 ctx（head 短于 size）：render 入口补拉全量，行数以全文件计', async () => {
    stubResizeObserver();
    // 每行 gb 字节「中」开头 + ASCII 填充：gb18030 解码必非 JSON（确定性全 failed），
    // 行数与字节数可精确预算（600 行 ≈ 12KB > 8KB 探测头）
    const rows = Array.from({ length: 600 }, (_, i) => `中${'p'.repeat(15)}${i}`);
    const content = gbBytes(rows);
    expect(content.length).toBeGreaterThan(8192); // 探测头形态成立
    const calls: RangeCall[] = [];
    const host = mount();
    const gbDet: Detection = { ext: 'jsonl', encoding: 'gb18030' };
    const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, gbDet,
      streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls }))) as JsonlInstance;
    expect(calls).toStrictEqual([{ start: 0, end: Number.MAX_SAFE_INTEGER }]); // 恰一次全量补拉
    // 总行数以全文件计（截断面只会有头部行数）；失败徽标为渐进统计（随窗口解析），
    // 不钉具体值（Task 3 报告设计裁决：失败行数随滚动渐进）
    expect(host.querySelector('.vv-jsonl-status')!.textContent!.startsWith('共 600 行')).toBe(true);
    expect(inst.getMeta().lines).toBe(600);
    expect((host.querySelector('.vv-jsonl-card') as HTMLElement).textContent).toContain('中'); // gb18030 解码正确（UTF-8 解码此处必为替换符）
    inst.destroy();
  });

  // 项 6（retry 免重拉）：入口 {0,MAX} 补拉此前每次 render 重入都重发——错误卡片
  // retry 场景同一 ctx 重复全量下载。修后以模块级 WeakMap 记忆同 ctx 的补拉
  //（memoizedFullRead：成功即记忆、失败出表可重试），ctx 随实例 GC 回收。
  it('入口补拉记忆：同 ctx 两次 render（retry 场景）→ 全量 read 仅一次，行数以全文件计', async () => {
    stubResizeObserver();
    const rows = Array.from({ length: 600 }, (_, i) => `中${'p'.repeat(15)}${i}`);
    const content = gbBytes(rows);
    const calls: RangeCall[] = [];
    const ctx = streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls });
    const gbDet: Detection = { ext: 'jsonl', encoding: 'gb18030' };
    const host = mount();
    const inst1 = (await jsonlRenderer.render(content.slice(0, 8192), host, source, gbDet, ctx)) as JsonlInstance;
    inst1.destroy();
    const host2 = mount();
    const inst2 = (await jsonlRenderer.render(content.slice(0, 8192), host2, source, gbDet, ctx)) as JsonlInstance;
    expect(calls).toStrictEqual([{ start: 0, end: Number.MAX_SAFE_INTEGER }]); // 第二次零新读
    expect(inst2.getMeta().lines).toBe(600); // 记忆的全量字节同样可用（非截断面）
    inst2.destroy();
  });

  // 终审 I-2：入口补拉后的编码精判——capable 且 size 未知/超限时 det 仅由 8KB head
  // 判定（dispatcher.test ⑬ 同构，渲染器侧镜像）：head 截断多字节误判 gb18030，补拉
  // 全量后须以 full 重算翻转 utf-8（随之落窗口模式），否则以误判值解码整文件 mojibake。
  it('head 误判 gb18030 + 入口补拉：补拉后以全量重算编码翻转 utf-8（窗口模式正确解码）', async () => {
    stubResizeObserver();
    // 真实 utf-8 内容（head 若真解码须为 utf-8）：行 0 含 emoji，gb18030 解码必为
    // 替换符——翻转成功（utf-8 解码）才可能原样上屏
    const rows: string[] = [];
    for (let i = 0; i < 200; i++) {
      rows.push(i === 0 ? JSON.stringify({ i, s: '🎉' }) : JSON.stringify({ i, s: 'p'.repeat(90) }));
    }
    const content = enc(rows.join('\n') + '\n');
    expect(content.length).toBeGreaterThan(8192); // 探测头形态成立
    const calls: RangeCall[] = [];
    const host = mount();
    const gbDet: Detection = { ext: 'jsonl', encoding: 'gb18030' }; // dispatcher head 口径的误判形态
    const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, gbDet,
      streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls }))) as JsonlInstance;
    // 入口补拉恰一次全量 + 翻转 utf-8 后落窗口模式的首块拉取（翻转生效的形态证明：
    // 未翻转将停留全量模式，绝无第二笔按块读）
    expect(calls).toStrictEqual([
      { start: 0, end: Number.MAX_SAFE_INTEGER },
      { start: 0, end: content.length - 1 }
    ]);
    expect(inst.getMeta().encoding).toBe('utf-8'); // 精判翻转（head 口径为 gb18030）
    expect(host.querySelector('.vv-jsonl-status')!.textContent).toBe('共 200 行'); // 翻转 utf-8 → 窗口模式
    const first = host.querySelector('[data-line="0"] .vv-jsonl-body') as HTMLElement;
    expect(first.textContent).toContain('🎉'); // 精判解码正确
    expect(first.textContent).not.toContain('\ufffd'); // 无替换符（误判解码必然产生）
    inst.destroy();
  });

  it('全量视图退化形态（head=全量预置全部块）：窗口模式零 read 天然工作，状态条直接「共 N 行」', async () => {
    stubResizeObserver();
    const text = padLines(50, 200);
    const content = enc(text);
    const calls: RangeCall[] = [];
    const host = mount();
    const inst = (await jsonlRenderer.render(content, host, source, det,
      streamCtx({ size: content.length, content, head: content, calls }))) as JsonlInstance;
    // head（约 10KB）短于 256KB 块：按 BlockStream 契约⑦对部分预置块做恰一次
    // 整块重拉（read 为 dispatcher 的同步切片，零网络 IO）；此后零 read
    expect(calls).toStrictEqual([{ start: 0, end: content.length - 1 }]);
    expect(host.querySelector('.vv-jsonl-status')!.textContent).toBe('共 50 行');
    expect(host.querySelectorAll('.vv-jsonl-card').length).toBeGreaterThan(0);
    expect(inst.getMeta().lines).toBe(50);
    inst.destroy();
  });

  it('续读读失败（块 2 失败一次）：无 unhandled rejection、同块重试不跳块、失败停机不自动重试、用户滚动动作恢复续读到 EOF', async () => {
    stubResizeObserver();
    const text = padLines(1200, 1500); // ≈1.8MB ≈ 7 块
    const content = enc(text);
    const calls: RangeCall[] = [];
    let readCount = 0;
    const ctx: StreamCtx = {
      size: null,
      head: content.slice(0, 8192),
      read: async (r) => {
        calls.push({ start: r.start, end: r.end });
        readCount += 1;
        if (readCount === 3) throw new Error('块 2 网络抖动'); // 首屏 2 块后的首次续读失败
        return content.slice(r.start, r.end + 1);
      }
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => { unhandled.push(err); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const host = mount();
      const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, det, ctx)) as JsonlInstance;
      scrollToBottom(host); // 触发续读 → 块 2 read 失败
      await vi.waitFor(() => expect(readCount).toBeGreaterThanOrEqual(3));
      await new Promise((r) => setTimeout(r, 30)); // 失败处理链（catch/停机/refresh）落地
      expect(unhandled).toStrictEqual([]); // 失败被 catch 自兜底，无 unhandled rejection
      // 失败停机：refresh 重评不再自动重试（read 数不增长——无「失败→重评→再失败」活锁）
      const readsAfterFail = calls.length;
      expect(readsAfterFail).toBe(3); // 块 0/1 成功 + 块 2 失败尝试
      await new Promise((r) => setTimeout(r, 30));
      expect(calls.length).toBe(readsAfterFail);
      // 用户滚动动作（离开末位再回来）→ 解除停机，单次重试
      const scroll = host.querySelector('.vv-jsonl-scroll') as HTMLElement;
      scroll.scrollTop = 0;
      scroll.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 10));
      scroll.scrollTop = Number.MAX_SAFE_INTEGER;
      scroll.dispatchEvent(new Event('scroll'));
      await vi.waitFor(() => {
        expect(host.querySelector('.vv-jsonl-status')!.textContent!.startsWith('共 1200 行')).toBe(true);
      });
      // 同块重试（不跳块）：第 4 次 read 与失败尝试（第 3 次）区间相同
      expect(calls[3]).toStrictEqual(calls[2]);
      expect(calls[2]).toStrictEqual({ start: 2 * BLOCK, end: 3 * BLOCK - 1 });
      expect(inst.getMeta().lines).toBe(1200);
      inst.destroy();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  // 计划 3 Task 1（B1 块表有界化）：窗口模式接入 maxBlocks（16 块）。跳入文本缓存与
  // 块表都已逐出且从未渲染解析的区间 → 占位卡 + 按需重拉 + 重渲实卡（hex 同语义）。
  it('窗口模式块表 LRU（16 块）：滚动跳入已逐出块区间，占位后按需重拉、内容正确且无失败卡', async () => {
    stubResizeObserver();
    const text = padLines(3400, 1500); // ≈5.1MB ≈ 20 块 > 16：滚到底后块 0..3 已逐出
    const content = enc(text);
    const calls: RangeCall[] = [];
    const host = mount();
    const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, det,
      streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls }))) as JsonlInstance;
    scrollToBottom(host); // 续读到 EOF：前向喂块恰好每块一次，表内只留块 4..19
    await vi.waitFor(() => {
      expect(host.querySelector('.vv-jsonl-status')!.textContent!.startsWith('共 3400 行')).toBe(true);
    });
    expect(calls.length).toBe(20);
    // 跳到行 350 附近（块 1/2：两缓存均已逐出且这些行从未解析）——未测行估算高
    // 120px，rowAt(42000) 精确落行 350，可视窗口 345..355
    const scroll = host.querySelector('.vv-jsonl-scroll') as HTMLElement;
    scroll.scrollTop = 120 * 350;
    scroll.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      const body = host.querySelector('[data-line="345"] .vv-jsonl-body') as HTMLElement | null;
      expect(body?.textContent ?? '').toContain('"i": 345'); // 重拉完成后实卡渲染
    });
    // 块 1/2 各恰重拉一次（pendingReload 去重：占位期不重复登记，refresh 后零多余 IO）
    expect(calls.filter((c) => c.start === BLOCK && c.end === 2 * BLOCK - 1).length).toBe(2);
    expect(calls.filter((c) => c.start === 2 * BLOCK && c.end === 3 * BLOCK - 1).length).toBe(2);
    expect(host.querySelector('[data-line="345"]')!.querySelector('.vv-jsonl-card-failed')).toBeNull();
    inst.destroy();
  });

  // M-3（与 code.ts reloadFailed 同款停机闩）：回看重拉失败后任何自动 update/refresh
  // 不得重试重拉（防活锁），用户滚动动作解除后单次重试成功。
  it('回看重拉失败：停机闩挡住自动重试（无活锁），用户滚动动作解除后单次重试成功', async () => {
    stubResizeObserver();
    const text = padLines(3400, 1500); // ≈5.1MB ≈ 20 块 > 16：滚到底后块 0..3 已逐出
    const content = enc(text);
    const calls: RangeCall[] = [];
    let block1Reads = 0;
    const ctx: StreamCtx = {
      size: content.length,
      head: content.slice(0, 8192),
      read: async (r) => {
        calls.push({ start: r.start, end: r.end });
        if (r.start === BLOCK) {
          block1Reads += 1;
          if (block1Reads === 2) throw new Error('块 1 回看重拉失败'); // 初始喂块成功，第 2 次（回看重拉）失败
        }
        return content.slice(r.start, r.end + 1);
      }
    };
    const host = mount();
    const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, det, ctx)) as JsonlInstance;
    scrollToBottom(host); // 续读到 EOF：前向喂块恰每块一次
    await vi.waitFor(() => {
      expect(host.querySelector('.vv-jsonl-status')!.textContent!.startsWith('共 3400 行')).toBe(true);
    });
    expect(calls.length).toBe(20);
    const scroll = host.querySelector('.vv-jsonl-scroll') as HTMLElement;
    scroll.scrollTop = 120 * 350; // 跳入块 1/2 区间：占位卡 + 回看重拉 → 块 1 失败 → 停机
    scroll.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(block1Reads).toBe(2)); // 失败落地
    await new Promise((r) => setTimeout(r, 30));
    const readsAtFail = calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(readsAtFail); // 停机闩：无自动重试（整批待办冻结，块 2 也不拉）
    // 用户滚动动作（notifyUserAction）：解除停机 → 单次重试（恢复批串行 ensure：块 1/2）
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 10));
    scroll.scrollTop = 120 * 350; // 补块到位：窗口实卡渲染
    scroll.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      const body = host.querySelector('[data-line="345"] .vv-jsonl-body') as HTMLElement | null;
      expect(body?.textContent ?? '').toContain('"i": 345');
    });
    expect(calls.filter((c) => c.start === BLOCK && c.end === 2 * BLOCK - 1).length).toBe(3); // 块 1 恰重试一次
    await new Promise((r) => setTimeout(r, 30)); // 恢复批全部落地
    const stable = calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(stable); // 成功后无额外拉取（无重试风暴）
    inst.destroy();
  });

  // 计划 3 Task 2 / T2 遗留钉：oversized 预览的跨块多字节此前无专测——4 字节
  // emoji 骑在块切口上，预览 gather 必须字节域缝合（与全量 64KB 字符截断逐字符一致）。
  it('oversized 预览跨块多字节：emoji 骑块边界，窗口与全量 64KB 预览逐字符一致', async () => {
    stubResizeObserver();
    // 字节布局：row0 = 8B；row1 填充使行 2 恰始于块 0 末字节（262143）；
    // row2 = 65534 个 🎉（4B/字符）+ y 填充，字节长恰 1MB（阈值取等即 oversize）
    const row1 = '"' + 'z'.repeat(262_132) + '"\n'; // 合法 JSON 字符串行
    expect(8 + row1.length).toBe(BLOCK - 1); // 行 2 起点 = 块 0 末字节（自校验非空转）
    const row2 = '🎉'.repeat(65_534) + 'y'.repeat(786_440);
    expect(enc(row2).length).toBe(1_048_576);
    const text = '{"a":1}\n' + row1 + row2;
    const bytes = enc(text);
    expect(bytes[BLOCK - 1]).toBe(0xf0); // 🎉 首字节落在块 0 尾
    expect(bytes[BLOCK]).toBe(0x9f); // 续字节跨入块 1（切口打碎该字符）

    const hostA = mount();
    const instA = (await jsonlRenderer.render(bytes, hostA, source, det)) as JsonlInstance;
    const hostB = mount();
    const instB = (await jsonlRenderer.render(bytes.slice(0, 8192), hostB, source, det,
      streamCtx({ size: bytes.length, content: bytes, head: bytes.slice(0, 8192) }))) as JsonlInstance;
    await vi.waitFor(() => {
      expect(hostB.querySelector('.vv-jsonl-status')!.textContent!.startsWith('共 3 行')).toBe(true);
    });
    const bodyA = hostA.querySelector('[data-line="2"] .vv-jsonl-body') as HTMLElement;
    const bodyB = hostB.querySelector('[data-line="2"] .vv-jsonl-body') as HTMLElement;
    // 64KB 字符预览（UTF-16 码元口径）= 32768 个 emoji（每个占 2 码元）；
    // 切口处的 emoji 完整（字节域缝合），无 U+FFFD、无孤立代理对
    expect(bodyA.textContent).toBe('🎉'.repeat(32_768));
    expect(bodyB.textContent).toBe(bodyA.textContent);
    expect(hostB.querySelector('[data-line="2"] .vv-jsonl-badge')?.textContent).toBe('行过大（>1MB）');
    instA.destroy();
    instB.destroy();
  });

  it('窗口模式尺寸防线（STREAM_MAX_BYTES）：size 超限 → 零续读停机，状态条追加建议以 hex 打开（非失败态）', async () => {
    stubResizeObserver();
    const content = enc(padLines(3, 100)); // 微型内容：防线由 ctx.size 触发，不真造 512MB
    const calls: RangeCall[] = [];
    const host = mount();
    const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, det,
      streamCtx({ size: STREAM_MAX_BYTES + 1, content, head: content.slice(0, 8192), calls }))) as JsonlInstance;
    expect(calls).toStrictEqual([]); // 防线在 IO 之前：一个块都不拉
    expect(host.querySelector('.vv-jsonl-status')!.textContent)
      .toBe('已加载 0 行 · 已达流式上限，建议以 hex 打开'); // 非失败态：无错误卡片
    expect(host.querySelectorAll('.vv-jsonl-card').length).toBe(0);
    expect(host.querySelectorAll('.vv-jsonl-card-failed').length).toBe(0);
    expect(inst.getMeta().lines).toBe(0);
    inst.destroy();
  });

  // 项 5（恰界收紧）：size 未知流式此前 confirmedBytes 超 512MB 后才停（越限一块
  // ≤256KB 才触发 > 判定）；修后达限即停——恰 2048 块、无越限块读。恒满块 fake ctx
  //（无换行索引零行）经滚动续读级联喂块至达限，无需真造 512MB 内容。
  it('STREAM_MAX_BYTES 恰界：size 未知达限即停，恰 2048 块、无越限块读', async () => {
    stubResizeObserver();
    const block = new Uint8Array(BLOCK).fill(0x70); // 256KB 无换行：索引零行
    let reads = 0;
    const ctx: StreamCtx = {
      size: null,
      head: block.subarray(0, 8192),
      read: async () => {
        reads += 1;
        return block; // 恒满块：无短读即无 EOF 证据，confirmedBytes 随每块 +256KB
      }
    };
    const host = mount();
    const inst = (await jsonlRenderer.render(block, host, source, det, ctx)) as JsonlInstance;
    scrollToBottom(host); // 触发续读级联（一次滚动即逐块推进）至达限停机
    await vi.waitFor(
      () => {
        expect(host.querySelector('.vv-jsonl-status')!.textContent).toBe(
          '已加载 0 行 · 已达流式上限，建议以 hex 打开'
        );
      },
      { timeout: 10_000 }
    );
    expect(reads).toBe(STREAM_MAX_BYTES / BLOCK); // 恰 2048（修前 2049：越限一块）
    inst.destroy();
  }, 20_000); // 整用例显式超时：一次滚动的 2046 次级联 update（DOM churn）在全仓
  // 高负载下会超默认 5s（waitFor 的 10s 只约束等待循环，不约束整用例）——逻辑非慢路径

  // F1 回归钉（fix round 1）：size 已知 + head=全量 + 尺寸非块对齐——末块为部分
  // 预置块（nextBlock 停在 blockCount-1），构造期 atEnd 须为真（head 触达文件尾
  // 即 EOF 证据），否则排空循环不进入：索引滞留前 2 块、状态条滞留「已加载 N 行」、
  // meta.lines 少计。生产可达形态：!rangeCapable 全量切片视图、capable≤1MB 直读。
  it('head=全量 + 尺寸非块对齐：状态条直接「共 N 行」、meta.lines 全量、部分末块恰一次重拉', async () => {
    stubResizeObserver();
    const text = padLines(409, 1500); // 613,908B ≈ 600KB：3 块（0/1 满、块 2 部分预置 89,620B）
    const content = enc(text);
    expect(content.length % BLOCK).not.toBe(0); // 非对齐自校验（非空转）
    const calls: RangeCall[] = [];
    const host = mount();
    const inst = (await jsonlRenderer.render(content, host, source, det,
      streamCtx({ size: content.length, content, head: content, calls }))) as JsonlInstance;
    expect(host.querySelector('.vv-jsonl-status')!.textContent).toBe('共 409 行');
    expect(inst.getMeta().lines).toBe(409);
    expect(host.querySelectorAll('.vv-jsonl-card').length).toBeGreaterThan(0);
    // 排空仅触发部分预置末块的契约⑦整块重拉（块 0/1 零 IO 直取）
    expect(calls).toStrictEqual([{ start: 2 * BLOCK, end: content.length - 1 }]);
    inst.destroy();
  });

  // 项 1（遗留清偿波 3）：head 干净 + 尾部 GB18030——head 探测误判 utf-8，窗口模式
  // 首块正常；续读触达脏块 → 流内嗅探判非 UTF-8 → 与「判出的非 UTF-8」入口回退同
  // 路径（memoizedFullRead 补拉 + redetectWithFull 精判 + 全量重渲）：全文正确解码、
  // 无 U+FFFD 扩散、状态条/meta 落精判值。
  /** head 干净 + 尾部 GB18030 的字节构造：干净前缀跨块 0..1，脏区自块 2 起（首屏
   * 两拉不触脏，降级只能由滚动续读触发——用例形态即「续读触发降级」）；GBK「汉」
   * = BA BA，两字节均为非法 UTF-8 lead（非合法形态的 mojibake，必产 U+FFFD 计数） */
  function utf8HeadGbTail(cleanRows: number, dirtyRows: number): Uint8Array<ArrayBuffer> {
    const parts: number[] = [...new TextEncoder().encode(`${padLines(cleanRows, 1500)}\n`)];
    for (let i = 0; i < dirtyRows; i++) {
      parts.push(...new TextEncoder().encode(`{"i":${i},"gb":"`));
      for (let k = 0; k < 50; k++) parts.push(0xba, 0xba); // 每行 100 处非法 ≫ 嗅探阈值
      parts.push(...new TextEncoder().encode('"}\n'));
    }
    return Uint8Array.from(parts);
  }

  it('项 1 流内嗅探降级：head 干净 + 尾部 GB18030 → 首块正常，续读触发全量重渲（无 U+FFFD、精判 gb18030）', async () => {
    stubResizeObserver();
    const content = utf8HeadGbTail(500, 100); // ≈850KB：干净 ≈750KB（块 0..2 前段）+ 脏 100 行
    const calls: RangeCall[] = [];
    const host = mount();
    const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, det,
      streamCtx({ size: content.length, content, head: content.slice(0, 8192), calls }))) as JsonlInstance;
    // 首块正常：窗口模式在跑（无全量补拉）、首屏无替换符、状态条「已加载」口径
    expect(calls.some((c) => c.end === Number.MAX_SAFE_INTEGER)).toBe(false);
    await vi.waitFor(() => expect(host.querySelector('[data-line="0"]')).not.toBeNull());
    expect(host.textContent).not.toContain('\uFFFD');
    expect(host.querySelector('.vv-jsonl-status')!.textContent!.startsWith('已加载 ')).toBe(true);
    // 滚动续读触达脏块 → 嗅探判非 UTF-8 → 全量重渲（状态条转「共 N 行」全量口径）
    scrollToBottom(host);
    await vi.waitFor(() => {
      expect(host.querySelector('.vv-jsonl-status')!.textContent).toBe('共 600 行');
    });
    expect(calls.some((c) => c.start === 0 && c.end === Number.MAX_SAFE_INTEGER)).toBe(true); // 补拉全量
    // 全文正确解码：滚到底看脏区行（重渲后视口回顶），'汉' 就位、无 U+FFFD 扩散
    const rescroll = host.querySelector('.vv-jsonl-scroll') as HTMLElement;
    rescroll.scrollTop = Number.MAX_SAFE_INTEGER;
    rescroll.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => {
      expect([...host.querySelectorAll('.vv-jsonl-body')].some((b) => b.textContent!.includes('汉'))).toBe(true);
    });
    expect(host.textContent).not.toContain('\uFFFD');
    // meta 落精判值：encoding=det 就地翻转（redetectWithFull），lines/size 回环全量
    expect(inst.getMeta().encoding).toBe('gb18030');
    expect(inst.getMeta().lines).toBe(600);
    expect(inst.getMeta().size).toBe(content.length);
    inst.destroy();
    // 复合销毁收口（降级产物随宿主）：全量实例与窗口实例的滚动容器均移除
    //（status 元素的留存为 mountJsonlView destroy 既有语义，不在本项范围）
    expect(host.querySelector('.vv-jsonl-scroll')).toBeNull();
  });

  // 项 D（Minor，W3-2）：jsonl 降级后 metaSize 未转投——`ctx.size ?? bs.confirmedBytes`
  // 仍指旧底座：size 未知文件降级后状态栏 size 停在判脏前缀字节数。修法：对齐 code
  // 整体转投口径——降级后经全量实例返回全量字节数（metaLines 同款）。
  it('项 D 降级后 metaSize 转投全量：size 未知文件降级后 size=全量字节数（非判脏前缀）', async () => {
    stubResizeObserver();
    const content = utf8HeadGbTail(500, 500); // 干净 ≈750KB（块 0..2 前段）+ 脏 500 行 ≈809KB
    const calls: RangeCall[] = [];
    const host = mount();
    // 局部 det：describe 级共享 det 会被前序用例的 redetectWithFull 就地翻转
    //（encoding→gb18030 不恢复），沿用会误入「非 UTF-8 全量补拉」入口
    const localDet: Detection = { ext: 'jsonl', encoding: 'utf-8' };
    const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, localDet,
      streamCtx({ size: null, content, head: content.slice(0, 8192), calls }))) as JsonlInstance;
    await vi.waitFor(() => expect(host.querySelector('[data-line="0"]')).not.toBeNull());
    expect(inst.getMeta().size).toBeLessThan(content.length); // 降级前：size 未知 → 已确认字节
    scrollToBottom(host); // 续读触脏 → 嗅探判非 UTF-8 → 全量重渲
    await vi.waitFor(() => {
      expect(host.querySelector('.vv-jsonl-status')!.textContent).toBe(`共 ${1000} 行`);
    });
    expect(inst.getMeta().size).toBe(content.length); // 项 D：降级后转投全量字节（旧底座为判脏前缀）
    inst.destroy();
  });

  // 流式硬化 Task 3（code.ts 同款）：实例级 AbortController——destroy 即取消在飞
  // 块读；abort 产生的 reject 是取消而非读失败，续读 catch 静默（闩不动、不打印）。
  // jsonl 无后台泵/扫描，catch 面即 maybeContinue 的续读/回看重拉两处。controller
  // 归实例内部，测试只观测 ctx.read 收到的 signal。
  it('destroy 取消在飞读：signal aborted，续读 catch 静默（continueFailed 闩不置位）', async () => {
    stubResizeObserver();
    const debugSpy = vi.spyOn(console, 'debug');
    const text = padLines(1200, 1500); // ≈1.8MB ≈ 7 块：首屏 2 块后仍有大量块可拉
    const content = enc(text);
    const calls: RangeCall[] = [];
    let sawSignal: AbortSignal | undefined;
    const ctx: StreamCtx = {
      size: null,
      head: content.slice(0, 8192),
      read: (r, signal) => {
        calls.push({ start: r.start, end: r.end });
        sawSignal = signal;
        if (r.start === 2 * BLOCK) {
          // 块 2（滚动续读首块）挂起在飞：destroy 时经 signal 取消（首屏两块照常返回
          // ——render 须先 resolve 才有实例可 destroy）
          return new Promise((resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        }
        return Promise.resolve(content.slice(r.start, r.end + 1));
      }
    };
    const host = mount();
    // 局部 det：describe 级共享 det 会被前序用例的 redetectWithFull 就地翻转
    //（encoding→gb18030 不恢复），沿用会误入「非 UTF-8 全量补拉」入口（项 D 同款）
    const localDet: Detection = { ext: 'jsonl', encoding: 'utf-8' };
    const inst = (await jsonlRenderer.render(content.slice(0, 8192), host, source, localDet, ctx)) as JsonlInstance;
    expect(calls.length).toBe(2); // 首屏恰前两块（自校验非空转）
    scrollToBottom(host); // 触发续读：块 2 read 在飞挂起
    await vi.waitFor(() => expect(calls.length).toBe(3));
    inst.destroy();
    // 断言 1：destroy 后实例持有的 signal 立即 aborted（在飞读被取消，不等自然结束）
    await vi.waitFor(() => expect(sawSignal!.aborted).toBe(true), { timeout: 2_000 });
    await new Promise((r) => setTimeout(r, 20)); // abort reject 落地：续读 catch 静默路径执行完
    // 断言 2：续读 catch 静默——不打印「流式续读失败」（abort ≠ 读失败）
    expect(debugSpy).not.toHaveBeenCalledWith(expect.stringContaining('流式续读失败'), expect.anything());
    debugSpy.mockRestore();
  });
});
