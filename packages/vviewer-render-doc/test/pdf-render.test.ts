// pdf-render.test.ts — pdfRenderer 渲染分流单测（计划 5 Task 1，spec §6.6 pdf Range transport）。
// jsdom 下 pdfjs 无法真渲染（无 canvas 位图后端；真渲染/渐进锚走 Playwright E2E），此处以
// vi.mock 桩 pdfjs-dist：fake PDFDataRangeTransport 形态对齐真实 API（constructor(length,
// initialData, progressiveDone?) 形参序、requestDataRange 抽象抛错、onDataRange 经
// transportReady listener 交付），覆盖：
// - 本地/退化全量 ctx → getDocument({data}) 引用不变（逐字节不变的最强形态）、零补拉读
// - transport 分支装配：initialData=head 字节、length=size、progressiveDone=false
// - requestRange 窗段换算（pdfjs [begin,end) 不含端 → ByteRange end 含，end-1）与交付
// - 回退三态：ctx 缺失 / size null（memoizedFullRead 补拉）/ !rangeCapable（全量在手零读）
// - abort 身份：在飞 requestRange 随 signal 取消，reject 即 abortReadError 身份
// - destroy 链：loadingTask.destroy + 实例 signal 取消在飞窗段
// - 终审修复波锚：memo 命中重入仍可成功打开（I-2 transfer 毒化）/ 本地 >1MB →
//   transport 且零网络读（I-1 实态对齐）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abortReadError, isAbortError } from '@bhxch/vviewer-core';
import type { ByteRange, Detection, FileSource, StreamCtx, TreeStore } from '@bhxch/vviewer-core';
import { PDFDataRangeTransport } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createPdfRangeTransport, pdfRenderer } from '../src/pdf';

const getDocumentMock = vi.hoisted(() => vi.fn());

// 桩的说明符须与 pdf.ts 运行期加载的入口一致（legacy 构建，见 pdf.ts loadPdfjs 注释），
// 否则 mock 落空、真实 pdfjs 被加载
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  // fake PDFDataRangeTransport：仅覆盖本测试消费的真实类面（pdf.mjs 导出同名基类，
  // 字段/方法签名逐一对齐 types/src/display/api.d.ts:758）
  class PDFDataRangeTransport {
    length: number;
    initialData: Uint8Array | null;
    progressiveDone: boolean;
    contentDispositionFilename: string;
    #listener: ((args: { type: string; begin?: number; chunk?: Uint8Array | null }) => void) | null =
      null;
    constructor(
      length: number,
      initialData: Uint8Array | null,
      progressiveDone = false,
      contentDispositionFilename = ''
    ) {
      this.length = length;
      this.initialData = initialData;
      this.progressiveDone = progressiveDone;
      this.contentDispositionFilename = contentDispositionFilename;
    }
    transportReady(
      listener: (args: { type: string; begin?: number; chunk?: Uint8Array | null }) => void
    ): void {
      this.#listener = listener;
    }
    onDataRange(begin: number, chunk: Uint8Array | null): void {
      this.#listener?.({ type: 'range', begin, chunk });
    }
    onDataProgressiveRead(_chunk: Uint8Array | null): void {}
    onDataProgressiveDone(): void {}
    requestDataRange(_begin: number, _end: number): void {
      throw new Error('abstract method PDFDataRangeTransport.requestDataRange（应由子类覆写）');
    }
    abort(): void {}
  }
  return {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: getDocumentMock,
    PDFDataRangeTransport
  };
});

// ---- 夹具 ----

/** dispatcher 探测头形态：HEAD_SIZE=8192 字节（%PDF 前缀 + 填充） */
const HEAD = ((): Uint8Array<ArrayBuffer> => {
  const b = new Uint8Array(8192);
  b.set([0x25, 0x50, 0x44, 0x46]); // %PDF
  for (let i = 4; i < b.length; i++) b[i] = i & 0xff;
  return b;
})();

/** 全量小样本（data 路径逐字节断言用） */
const FULL: Uint8Array<ArrayBuffer> = Uint8Array.from(new TextEncoder().encode('PDF-FULL-FIXTURE-0123456789'));

/** transport 分支的 size 形态：>1MB（dispatcher 仅 size 超限时交付 8KB 探测块） */
const BIG_SIZE = 2 * 1024 * 1024;

const DET = { ext: 'pdf' } as Detection;

function makeSource(opts?: { rangeCapable?: boolean }): FileSource {
  const store = (opts?.rangeCapable ? { rangeCapable: true } : {}) as TreeStore;
  return { storeId: 's-test', storeLabel: '测试 store', path: '/doc.pdf', name: 'doc.pdf', store };
}

/** 窗段 mock read：按 ByteRange 切 FULL（越界自然钳制，镜像 store 侧行为） */
function windowRead(): ReturnType<typeof vi.fn> {
  return vi.fn(async (r: ByteRange) => FULL.slice(r.start, Math.min(r.end + 1, FULL.length)));
}

function asCtxRead(fn: unknown): StreamCtx['read'] {
  return fn as StreamCtx['read'];
}

function makeCtx(opts: {
  size: number | null;
  head: Uint8Array<ArrayBuffer>;
  read: StreamCtx['read'];
}): StreamCtx {
  return { size: opts.size, head: opts.head, read: opts.read };
}

function stubIO(): void {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): unknown[] {
        return [];
      }
    }
  );
}

function makeDoc(): unknown {
  return {
    numPages: 1,
    getPage: async () => ({
      getViewport: () => ({ width: 612, height: 792 })
    })
  };
}

/** getDocument 最近一次调用的实参（data / range 捕获） */
function lastGetDocumentArg(): { data?: Uint8Array; range?: PDFDataRangeTransport } {
  const calls = getDocumentMock.mock.calls as Array<[{ data?: Uint8Array; range?: PDFDataRangeTransport }]>;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0];
}

let lastDestroy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getDocumentMock.mockReset();
  lastDestroy = vi.fn(async () => {});
  getDocumentMock.mockImplementation(() => ({ promise: Promise.resolve(makeDoc()), destroy: lastDestroy }));
  stubIO();
  // jsdom 无 canvas 后端：getContext 恒 null（ensureRender 早退，page.render 不触）
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('pdfRenderer 分流入口（spec §6.6）', () => {
  it('声明 streaming: true（dispatcher 只交付 head + StreamCtx 的契约前提）', () => {
    expect(pdfRenderer.streaming).toBe(true);
  });

  it('ctx 缺失（直调兼容面）→ data 路径：getDocument({data}) 收副本（pdfjs transfer 不打穿调用方 buffer）、零 range、destroy 调 loadingTask.destroy', async () => {
    const host = document.createElement('div');
    const inst = await pdfRenderer.render(FULL, host, makeSource(), DET);
    const arg = lastGetDocumentArg();
    // 副本语义（终审 FOM-EX 修复：pdfjs transfer data.buffer → 主线程副本 detach；
    // 直传路径调用方不重新 read，detach 会打穿调用方字节面 → dispatcher 错误卡的
    // 动作构建（buffer.slice）抛 detached 异常 → 错误卡不落地）。故 data 必须是
    // **字节等值但非同一引用**的副本，与 transport 分支的 head.slice() 同款。
    expect(arg.data).not.toBe(FULL);
    expect([...arg.data!]).toEqual([...FULL]);
    expect(arg.range).toBeUndefined();
    inst.destroy();
    expect(lastDestroy).toHaveBeenCalledTimes(1);
  });

  it('本地/!rangeCapable 来源（dispatcher 退化全量视图 ctx：byteLength === size）→ data 路径字节等值、零补拉读', async () => {
    const host = document.createElement('div');
    const read = vi.fn();
    const ctx = makeCtx({ size: FULL.length, head: FULL, read: asCtxRead(read) });
    const inst = await pdfRenderer.render(FULL, host, makeSource(), DET, ctx);
    const arg = lastGetDocumentArg();
    expect(arg.data).not.toBe(FULL); // 收副本（pdfjs transfer 不打穿调用方 buffer）
    expect([...arg.data!]).toEqual([...FULL]);
    expect(arg.range).toBeUndefined();
    expect(read).not.toHaveBeenCalled(); // 全量在手：零额外读
    inst.destroy();
    expect(lastDestroy).toHaveBeenCalledTimes(1);
  });

  it('本地 >1MB（终审 I-1 实态锚）：localFiles/localFs rangeCapable:true + File.slice——8KB 探测块 < ctx.size → transport 装配、render 期零读（零网络）', async () => {
    const host = document.createElement('div');
    const read = vi.fn();
    const ctx = makeCtx({ size: BIG_SIZE, head: HEAD, read: asCtxRead(read) });
    // 本地 store 实态（localFiles.ts:70 / localFs.ts:75）：rangeCapable:true，read range
    // 分支 File.slice；dispatcher 对 size>1MB capable 来源交付 8KB 探测块 + ctx——
    // 分流只认 buffer<ctx.size && rangeCapable，本地来源不豁免（非「本地 → data 路径」，
    // 行为良性偏优：按需窗段读替代一次性全量物化，承诺面以此锚钉死）
    const localSource: FileSource = {
      storeId: 's-local',
      storeLabel: '本地文件',
      path: '/local-big.pdf',
      name: 'local-big.pdf',
      store: { rangeCapable: true } as TreeStore
    };
    const inst = await pdfRenderer.render(HEAD, host, localSource, DET, ctx);
    const arg = lastGetDocumentArg();
    expect(arg.data).toBeUndefined();
    expect(arg.range).toBeInstanceOf(PDFDataRangeTransport);
    expect(arg.range!.length).toBe(BIG_SIZE);
    expect(read).not.toHaveBeenCalled(); // render 期零主动读：File.slice 按需窗段，零网络
    inst.destroy();
  });

  it('transport 分支（capable + size 已知 + buffer=head 探测块）→ getDocument 收到 PDFDataRangeTransport：initialData=head 字节、length=size、非 progressiveDone', async () => {
    const host = document.createElement('div');
    const read = vi.fn();
    const ctx = makeCtx({ size: BIG_SIZE, head: HEAD, read: asCtxRead(read) });
    const inst = await pdfRenderer.render(HEAD, host, makeSource({ rangeCapable: true }), DET, ctx);
    const arg = lastGetDocumentArg();
    expect(arg.data).toBeUndefined();
    const transport = arg.range!;
    expect(transport).toBeInstanceOf(PDFDataRangeTransport);
    expect(transport.length).toBe(BIG_SIZE);
    expect(transport.progressiveDone).toBe(false);
    expect([...transport.initialData!]).toEqual([...HEAD]);
    expect(read).not.toHaveBeenCalled(); // render 期零主动读：字节全按需
    inst.destroy();
  });

  it('getMeta size：transport 分支报告 ctx.size 全量字节数（head 探测块不冒充大小）', async () => {
    const host = document.createElement('div');
    const ctx = makeCtx({ size: BIG_SIZE, head: HEAD, read: asCtxRead(vi.fn()) });
    const inst = await pdfRenderer.render(HEAD, host, makeSource({ rangeCapable: true }), DET, ctx);
    expect((inst as unknown as { getMeta(): { size: number } }).getMeta().size).toBe(BIG_SIZE);
    inst.destroy();
  });

  it('getMeta size：data 路径维持 buffer.length（既有 BUG-04 握手点 2 行为不变）', async () => {
    const host = document.createElement('div');
    const inst = await pdfRenderer.render(FULL, host, makeSource(), DET);
    expect((inst as unknown as { getMeta(): { size: number } }).getMeta().size).toBe(FULL.length);
    inst.destroy();
  });

  it('size null → 全量补拉（memoizedFullRead 形态：{0, MAX_SAFE_INTEGER} 单发读）后 data 路径', async () => {
    const host = document.createElement('div');
    const read = windowRead();
    const ctx = makeCtx({ size: null, head: HEAD, read: asCtxRead(read) });
    const inst = await pdfRenderer.render(HEAD, host, makeSource({ rangeCapable: true }), DET, ctx);
    const arg = lastGetDocumentArg();
    expect(arg.range).toBeUndefined();
    expect([...arg.data!]).toEqual([...FULL]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toEqual({ start: 0, end: Number.MAX_SAFE_INTEGER });
    inst.destroy();
  });

  it('memo 命中重入仍可成功打开（终审 I-2 transfer 毒化锚）：首次渲染失败后重试 → getDocument 收到非零、与源字节等值的 buffer（零重复下载）', async () => {
    const host = document.createElement('div');
    const read = windowRead();
    const ctx = makeCtx({ size: null, head: HEAD, read: asCtxRead(read) });
    // 镜像真实 pdfjs：getDocument transfer data.buffer 到 worker（主线程副本 detach 归零）
    // ——旧实现 memo 直存 Promise 值实例时，重试命中零长 buffer → getDocument 必抛
    //（transfer 毒化）；首开失败 = 错误卡片重试的实态前提
    getDocumentMock.mockImplementationOnce(({ data }: { data?: Uint8Array<ArrayBuffer> }) => {
      structuredClone(data, { transfer: [data!.buffer] });
      return { promise: Promise.reject(new Error('首次打开失败')), destroy: lastDestroy };
    });
    const first = pdfRenderer.render(HEAD, host, makeSource({ rangeCapable: true }), DET, ctx);
    await expect(first).rejects.toThrow('首次打开失败');
    // 重试：memo 命中（零重复下载）→ 非零、与源字节等值的新副本 → 打开成功
    const inst = await pdfRenderer.render(HEAD, host, makeSource({ rangeCapable: true }), DET, ctx);
    const arg = lastGetDocumentArg();
    expect(arg.range).toBeUndefined();
    expect(arg.data!.byteLength).toBe(FULL.length); // 非零（毒化形态为 0）
    expect([...arg.data!]).toEqual([...FULL]); // 与源字节等值
    expect(read).toHaveBeenCalledTimes(1); // memo 命中：重试零重复全量下载
    inst.destroy();
  });

  it('I1 纵深防御：ctx.read 缺失（违约形态）→ 不进 transport 分支（getDocument 不被调），全量守卫处快速失败', async () => {
    const host = document.createElement('div');
    // 对齐 dispatcher capable 判定的 read 在场项：read 缺失 → 即使 capable+size 已知
    // 也不装配 transport（无读通道的 transport 是死面），落全量守卫 reject
    const ctx = { size: BIG_SIZE, head: HEAD, read: undefined as unknown as StreamCtx['read'] };
    const renderPromise = pdfRenderer.render(HEAD, host, makeSource({ rangeCapable: true }), DET, ctx);
    await expect(renderPromise).rejects.toThrow();
    expect(getDocumentMock).not.toHaveBeenCalled();
  });
});

describe('mid-load 读失败收口（M1 评审：requestRange 非 abort 读失败 → destroy 兜底）', () => {
  function stubPendingGetDocument(): {
    promise: Promise<unknown>;
    resolveDoc: (d: unknown) => void;
    rejectDoc: (e: unknown) => void;
  } {
    // 手写 deferred（执行器同步赋值，解构时即可用；target ES2022 无 Promise.withResolvers）
    let resolveDoc!: (d: unknown) => void;
    let rejectDoc!: (e: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolveDoc = res;
      rejectDoc = rej;
    });
    getDocumentMock.mockImplementationOnce(() => ({ promise, destroy: lastDestroy }));
    return { promise, resolveDoc, rejectDoc };
  }

  it('非 abort 读失败（文档未开）→ 读失败门竞速使 render 立即 reject（携原始读错误）→ 错误卡片路径；destroy 尽力清理', async () => {
    const host = document.createElement('div');
    stubPendingGetDocument();
    // 统一验证阶段实证重定基：pdfjs 6.4.299 的 loadingTask.destroy() 在文档打开中段
    // 挂起（await this._setupCapability.promise 永不落定）——「destroy 使 promise
    // reject」不可达。现语义：onReadFailure 触发读失败门（Promise.race）立即按原始
    // 读错误 reject（错误卡片显示真实读失败原因而非 destroy 的 Worker was destroyed），
    // destroy 降级为尽力清理（fire-and-forget，不 await）
    lastDestroy.mockImplementation(async () => {
      await new Promise(() => {}); // 镜像真实 pdfjs：中段 destroy 永不落定
    });
    const read = vi.fn(async () => {
      throw new Error('模拟网络错');
    });
    const ctx = makeCtx({ size: BIG_SIZE, head: HEAD, read: asCtxRead(read) });
    const renderPromise = pdfRenderer.render(HEAD, host, makeSource({ rangeCapable: true }), DET, ctx);
    await vi.waitFor(() => expect(getDocumentMock).toHaveBeenCalled());
    lastGetDocumentArg().range!.requestDataRange(0, 100); // mid-load 读失败
    await expect(renderPromise).rejects.toThrow('模拟网络错');
    expect(lastDestroy).toHaveBeenCalled();
  });

  it('abort 读失败（文档未开）→ 静默：destroy 不被调，render 正常落定', async () => {
    const host = document.createElement('div');
    const { resolveDoc } = stubPendingGetDocument();
    const read = vi.fn(async () => {
      throw abortReadError();
    });
    const ctx = makeCtx({ size: BIG_SIZE, head: HEAD, read: asCtxRead(read) });
    const renderPromise = pdfRenderer.render(HEAD, host, makeSource({ rangeCapable: true }), DET, ctx);
    await vi.waitFor(() => expect(getDocumentMock).toHaveBeenCalled());
    lastGetDocumentArg().range!.requestDataRange(0, 100);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0)); // reject 传播（catch 判 abort 静默）完
    expect(lastDestroy).not.toHaveBeenCalled();
    resolveDoc(makeDoc());
    const inst = await renderPromise;
    inst.destroy();
    expect(lastDestroy).toHaveBeenCalledTimes(1); // destroy 链本身不受影响
  });

  it('doc 已开后非 abort 懒页 chunk 读失败 → 维持静默（单页空白可接受），destroy 不被调', async () => {
    const host = document.createElement('div');
    const read = vi.fn(async () => {
      throw new Error('懒页网络错');
    });
    const ctx = makeCtx({ size: BIG_SIZE, head: HEAD, read: asCtxRead(read) });
    // 默认 mock：loadingTask.promise 立即 resolve → render 完成即 docOpened=true
    const inst = await pdfRenderer.render(HEAD, host, makeSource({ rangeCapable: true }), DET, ctx);
    lastGetDocumentArg().range!.requestDataRange(0, 100);
    await new Promise((r) => setTimeout(r, 0));
    expect(read).toHaveBeenCalledTimes(1);
    expect(lastDestroy).not.toHaveBeenCalled();
    inst.destroy();
  });
});

describe('requestRange 窗段（PDFDataRangeTransport → ctx.read 换算与交付）', () => {
  it('requestDataRange(begin, end)（end 不含）→ ctx.read({start: begin, end: end-1}（end 含），窗段字节经 onDataRange 以原始 begin 交付', async () => {
    const host = document.createElement('div');
    const read = windowRead();
    const ctx = makeCtx({ size: BIG_SIZE, head: HEAD, read: asCtxRead(read) });
    const inst = await pdfRenderer.render(HEAD, host, makeSource({ rangeCapable: true }), DET, ctx);
    const transport = lastGetDocumentArg().range!;
    // 真实 pdfjs 接线形态：PDFDataTransportStream 构造期 transportReady(listener)，
    // range 字节经 onDataRange → listener {type:'range', begin, chunk} 交付
    const delivered: Array<{ begin: number; chunk: Uint8Array }> = [];
    transport.transportReady((args: { type: string; begin?: number; chunk?: Uint8Array | null }) => {
      if (args.type === 'range') delivered.push({ begin: args.begin as number, chunk: args.chunk as Uint8Array });
    });
    transport.requestDataRange(2, 10); // pdfjs 语义 [2, 10)
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toEqual({ start: 2, end: 9 }); // end-1 换算
    expect(read.mock.calls[0]![1]).toBeDefined(); // signal 贯穿窗段读
    expect(delivered[0]!.begin).toBe(2); // 原始 begin 回传（stream 侧按 _begin 匹配 reader）
    expect([...delivered[0]!.chunk]).toEqual([...FULL.slice(2, 10)]);
    inst.destroy();
  });

  it('abort：在飞 requestRange 随 signal 取消，reject 落 abortReadError 身份（isAbortError 判真）', async () => {
    const ctrl = new AbortController();
    // 镜像 store 侧契约：signal abort → reject（abortReadError 单源形态）
    const read = vi.fn(
      (_r: ByteRange, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> =>
        new Promise((_resolve, reject) => {
          const rejectAbort = (): void => reject(abortReadError());
          signal?.addEventListener('abort', rejectAbort, { once: true });
          if (signal?.aborted) rejectAbort();
        })
    );
    const transport = createPdfRangeTransport(PDFDataRangeTransport, {
      size: 1024,
      head: new Uint8Array(16),
      read: asCtxRead(read),
      signal: ctrl.signal
    });
    const p = transport.requestRange(0, 100);
    ctrl.abort();
    let caught: unknown;
    try {
      await p;
    } catch (e) {
      caught = e;
    }
    expect(isAbortError(caught)).toBe(true);
    expect((caught as Error).name).toBe('AbortError');
    expect((caught as Error).message).toBe('读取已取消');
  });
});

describe('生命周期（destroy 链）', () => {
  it('transport 分支 destroy：loadingTask.destroy 调用 + 在飞窗段随实例 signal 取消', async () => {
    const host = document.createElement('div');
    let seenSignal: AbortSignal | undefined;
    const read = vi.fn((_r: ByteRange, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> => {
      seenSignal = signal;
      return new Promise(() => {}); // 永挂起（在飞形态）
    });
    const ctx = makeCtx({ size: BIG_SIZE, head: HEAD, read: asCtxRead(read) });
    const inst = await pdfRenderer.render(HEAD, host, makeSource({ rangeCapable: true }), DET, ctx);
    const transport = lastGetDocumentArg().range!;
    transport.requestDataRange(0, 100); // 在飞窗段
    expect(seenSignal).toBeDefined();
    expect(seenSignal!.aborted).toBe(false);
    inst.destroy();
    expect(seenSignal!.aborted).toBe(true); // 实例 signal 取消在飞读
    expect(lastDestroy).toHaveBeenCalledTimes(1);
  });
});
