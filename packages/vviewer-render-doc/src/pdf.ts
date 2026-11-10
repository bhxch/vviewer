// pdf.ts — PDF 渲染器（M4 Task 1）。pdfjs-dist 动态 import（重依赖不进主包、SSR 不加载），
// worker 以 vite 原生资产 URL 提供（new URL + import.meta.url，vite ≥5.1 支持裸说明符，
// build 时输出为哈希资产——实测见任务报告）。主模块与 worker 按 preferModernBuild
// 能力感知选构建：特性齐备取现代构建（零 polyfill），任一缺失（旧浏览器）取 legacy
//（core-js 先注册全局再运行 pdfjs 本体），见 loadPdfjs/preferModernBuild 注释。
// 渲染结构：工具条（页码/缩放）+ 滚动容器内逐页 canvas；前 3 页立即渲染，
// 其余 IntersectionObserver 懒渲染；缩放为连续值（auto 默认适宽且封顶 100% / fit 精确
// 适宽 / manual −/＋ 档位步进，见 ZoomMode），变更时全量重渲染。
// 搜索：search 时懒提取各页 textContent 并缓存，跨页扫描用 pdfText 纯函数；gotoMatch 跳页。
// 流式（io-streaming 计划 5 Task 1，spec §6.6）：声明 streaming 后 dispatcher 交付
// head 探测块 + StreamCtx；capable 且 size 已知且 buffer 短于 size 时走
// PDFDataRangeTransport（requestRange → ctx.read 窗段）渐进加载，回退矩阵见 render 入口注释。
import { isAbortError } from '@bhxch/vviewer-core';
import type { Detection, FileSource, RenderedInstance, Renderer, StreamCtx } from '@bhxch/vviewer-core';
import type {
  PDFDataRangeTransport,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageText, searchPdfPages, type PdfSearchMatch, type PdfTextItem } from './pdfText';

// 类型与运行期同取 legacy 入口（legacy/build/pdf.d.mts 即 `export * from "pdfjs-dist"`，
// 类型面与现代入口等价；同源书写免得两处入口分叉）
type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

/**
 * 缩放预设档位（0.25x-3x）：manual 模式下工具条 −/＋ 从当前连续缩放值出发，步进到严格
 * 小于/大于它的相邻档位（auto/fit 求出的适宽值通常不在档位上）
 */
const SCALE_PRESETS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
/**
 * 步进判同档容差：与缩放标签的取整粒度（1%）对齐——与档位相差不足半个百分点视为同档，
 * 否则标签同显 100% 的 0.998 按 ＋ 会先落到 1，出现标签不变的空步
 */
const SCALE_STEP_EPS = 0.005;
/** 适宽值下限：容器极窄时避免 0/负值缩放与退化画布 */
const FIT_SCALE_MIN = 0.1;
/** 容器宽变化后重算适宽的防抖时长（ms）：合并拖拽调宽/转屏期间的连串通知 */
const REFIT_DEBOUNCE_MS = 150;
/** 重算所得缩放与现值的相对差超过该比例才重排（全量重渲染代价高，亚像素抖动不值得） */
const REFIT_MIN_RATIO = 0.005;
/** 打开文件后立即渲染的页数，其余懒渲染 */
const IMMEDIATE_PAGES = 3;
/** 懒渲染预热边距：提前渲染视口外 200px 内的页，翻页不露白 */
const LAZY_ROOT_MARGIN = '200px';
/** gotoMatch 跳页后命中页的高亮时长（ms） */
const HIT_FLASH_MS = 1200;

/**
 * 缩放模式（缩放值本身是连续值，模式决定它怎么来）：
 * - auto：默认。适应宽度但不超过 100%，即 min(1, 适宽值)——窄屏（手机竖屏看横向发票）
 *   首屏不超宽，宽屏维持 1pt:1px；
 * - fit：点工具条「适应宽度」进入，精确适宽，可超过 100%；
 * - manual：−/＋ 步进后进入，停在档位上，不再跟随容器宽。
 * auto/fit 随容器宽变化重算（ResizeObserver，见 render 内「容器宽跟随」段）。
 */
type ZoomMode = 'auto' | 'fit' | 'manual';

/** 从连续缩放值 cur 出发取严格小于（dir=-1）/大于（dir=1）它的相邻档位；没有则 null（按钮禁用） */
function adjacentPreset(cur: number, dir: -1 | 1): number | null {
  if (dir > 0) return SCALE_PRESETS.find((p) => p > cur + SCALE_STEP_EPS) ?? null;
  return [...SCALE_PRESETS].reverse().find((p) => p < cur - SCALE_STEP_EPS) ?? null;
}

/** 特性探针的取值助手：静态成员 / 原型成员是否为函数（宿主可为构造器或 JSON/Math 等普通对象） */
type AnyFn = { [key: string]: unknown };
const staticHas = (host: unknown, method: string): boolean =>
  typeof (host as unknown as AnyFn | undefined)?.[method] === 'function';
const protoHas = (ctor: unknown, method: string): boolean =>
  typeof (ctor as { prototype?: AnyFn } | undefined)?.prototype?.[method] === 'function';

/**
 * 浏览器感知的构建选择（UFB-04 感知版）：现代构建不带 polyfill，其源码直接使用以下
 * 现代特性——legacy 构建的 core-js polyfill 清单即这份清单（构建产物逐模块核对）：
 * 迭代器 helper、Set 方法、Uint8Array base64/hex、Map.getOrInsert、Promise.try、
 * URL.parse、JSON 源访问、Math.sumPrecise。任一缺失即选 legacy——core-js 先注册全局
 * 再运行 pdfjs 本体（旧浏览器不再「Iterator is not defined」），特性齐备的现代浏览器
 * 不再白背 polyfill 与双倍体积。判定首次调用定格：legacy 加载后 core-js 会把缺失特性
 * 补回全局，探针复评即翻面——不定格则 dataset 标记会与实际加载的构建漂移（e2e
 * UFB-04 实证）。
 */
let pdfBuildDecision: boolean | null = null;
const MODERN_FEATURE_PROBES: Array<[string, () => boolean]> = [
  ['迭代器 helper', () => protoHas((globalThis as AnyFn).Iterator, 'map')],
  ['Set 方法', () => protoHas(Set, 'union')],
  ['Uint8Array base64/hex', () => staticHas(Uint8Array, 'fromBase64')],
  ['Map.getOrInsert', () => protoHas(Map, 'getOrInsert')],
  ['Promise.try', () => staticHas(Promise, 'try')],
  ['URL.parse', () => staticHas(URL, 'parse')],
  ['JSON 源访问', () => staticHas(JSON, 'rawJSON')],
  ['Math.sumPrecise', () => staticHas(Math, 'sumPrecise')]
];

/** true = 特性齐备，选现代构建；false = 任一缺失（或探针异常），选 legacy 构建 */
export function preferModernBuild(): boolean {
  pdfBuildDecision ??= evaluateModernSupport();
  return pdfBuildDecision;
}

function evaluateModernSupport(): boolean {
  for (const [name, probe] of MODERN_FEATURE_PROBES) {
    try {
      if (!probe()) return false;
    } catch {
      console.debug(`[pdf] 特性探针异常（按缺失处理）：${name}`);
      return false;
    }
  }
  return true;
}

/** 测试缝：复位定格（构建选型真值表逐例需要干净判定；生产路径不调用） */
export function resetPdfBuildDecisionForTest(): void {
  pdfBuildDecision = null;
}

/** 按 preferModernBuild 选主模块入口（legacy/build/pdf.d.mts 即 `export * from
 * "pdfjs-dist"`，两入口类型面等价，类型统一取 legacy 位） */
async function importPdfjs(): Promise<Pdfjs> {
  return preferModernBuild() ? import('pdfjs-dist') : import('pdfjs-dist/legacy/build/pdf.mjs');
}

/** worker 资产 URL 与主模块同一判定：worker 跑在独立全局（WorkerGlobalScope），
 * 主线程的 polyfill 带不过去，两份产物须同构建。vite 对 new URL(裸说明符,
 * import.meta.url) 的资产化只识别字面量实参——三元合成的条件串不会被处理（运行期
 * fetch 到未打包的原始路径，e2e 实证），两个分支各自保持完整调用形态。 */
function pdfWorkerUrl(): string {
  return preferModernBuild()
    ? new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
    : new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString();
}

let pdfjsPromise: Promise<Pdfjs> | null = null;

/**
 * pdfjs 懒加载（单例）：getDocument 前必须设好 workerSrc，避免走主线程假 worker。
 *
 * 主模块与 worker 经 preferModernBuild 能力感知选构建（注释见其上）：现代构建在
 * 无全局 Iterator 等特性的旧浏览器（Chrome/Edge<122、Firefox<131、Safari<18.4）模块
 * 顶层即抛「Iterator is not defined」，legacy 构建内置 core-js 先注册全局再运行本体。
 * 两份产物文件名同为 pdf.worker.min.<hash>.mjs（内容不同、哈希不同，vite 资产不冲突；
 * 构建脚本/e2e 按文件名匹配的口径不变）。加载失败不入单例（chunk 网络抖动/离线未
 * 缓存）：清空后下次打开或错误卡「重试」重新加载——否则一次失败即永久报错，只能
 * 刷新页面。
 * 回退防线：test/pdf-legacy-build.test.ts（删除全局 Iterator 后真实求值 + 源码契约锚）。
 */
function loadPdfjs(): Promise<Pdfjs> {
  if (pdfjsPromise === null) {
    const loading = (async () => {
      const pdfjs = await importPdfjs();
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl();
      return pdfjs;
    })();
    pdfjsPromise = loading;
    // 加载失败不入单例（chunk 网络抖动/离线未缓存）：清空后下次打开或错误卡「重试」重新
    // 加载——否则一次失败即永久报错，只能刷新页面
    loading.catch(() => {
      if (pdfjsPromise === loading) pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}

function isCancelledError(e: unknown): boolean {
  return e instanceof Error && e.name === 'RenderingCancelledException';
}

// ---------- Range transport（spec §6.6，io-streaming 计划 5 Task 1） ----------

/**
 * 守卫补拉记忆（render-text/blockStream.ts memoizedFullRead 同源形态；终审 I-2 分歧备案）：
 * size 未知回退的 {0, MAX_SAFE_INTEGER} 全量补拉按 ctx 记忆——错误卡片 retry 重入 render
 * （同一 renderCtx 透传，评审指令②）不再重复全量下载；失败不记忆（retry 可重新发起）。
 * 与 text 侧的关键分歧：pdfjs getDocument 会 transfer data.buffer 到 worker（主线程副本
 * detach 归零）——memo 直存/直还 Promise 值实例时，重试即命中零长 buffer → getDocument
 * 必抛（transfer 毒化，重试恒败且错误文案被换）。故 memo 存字节本体、每次消费返回
 * .slice() 新副本（首消费同样拷贝：getDocument transfer 的是副本，memo 保有体不 detach）。
 */
const fullReadMemo = new WeakMap<StreamCtx, Uint8Array<ArrayBuffer>>();

async function memoizedFullRead(ctx: StreamCtx): Promise<Uint8Array<ArrayBuffer>> {
  const memo = fullReadMemo.get(ctx);
  if (memo !== undefined) return memo.slice(); // 消费即拷贝（重入拿到的恒是非零新副本）
  // 全量读端点 {0, MAX_SAFE_INTEGER}：远端 Range 超界由服务端钳制返回整文件、本地
  // slice 越界自然钳制（hex.ts size-null 回退同款单发读，signal 不传——与 code 全量
  // 补拉同口径，读失败经 dispatcher ctx.read 包装标 DispatchReadError 向上 reject）
  const bytes = await ctx.read({ start: 0, end: Number.MAX_SAFE_INTEGER });
  fullReadMemo.set(ctx, bytes);
  return bytes.slice(); // 首消费同样交副本：memo 保有体与 getDocument transfer 面分离
}

/**
 * ctx.read 窗段 → pdfjs 渐进交付的 transport 装配（可测纯装配形态，spec §6.6）。
 *
 * pdfjs API 实态（pdfjs-dist 6.4.299，types/src/display/api.d.ts:758）：基类形参序为
 * `constructor(length, initialData, progressiveDone?, contentDispositionFilename?)`——
 * length 在前、initialData 在后（spec 行文「PDFDataRangeTransport(head, size)」系笔误，
 * 实装按真实 API 逆序传入）；基类 requestDataRange 为抽象抛错，须子类覆写。
 *
 * 窗段语义换算（本实现的唯一跨域换算点）：pdfjs 的 requestDataRange(begin, end) 端点
 * 为 [begin, end) 不含端（worker ChunkedStreamManager._requestChunks：`end =
 * Math.min(endChunk * chunkSize, length)`，即 end 指向末字节后一位置）；core ByteRange
 * 端点为 end 含（types.ts:16）→ 请求时换算 `end - 1`。交付以 pdfjs 原始 begin 回调
 * onDataRange（PDFDataTransportStream 按 `r._begin === begin` 匹配 range reader，
 * 不得改写）；窗段为单块交付语义（PDFDataTransportStreamRangeReader._enqueue 后即
 * _done）：一次 requestDataRange 恰对应一次 onDataRange 完整窗段。
 *
 * BaseCtor 经参注入而非静态 import：pdf.ts 对 pdfjs-dist 保持纯动态加载（重依赖不进
 * 主包、SSR 不加载），子类在装配期才触达基类。
 */
export function createPdfRangeTransport(
  BaseCtor: typeof PDFDataRangeTransport,
  opts: {
    size: number;
    head: Uint8Array;
    read: StreamCtx['read'];
    signal?: AbortSignal;
    /** 非 abort 读失败回调（M1）：mid-load 收口钩子，携带原始读错误（render 侧据
     * docOpened 门控收口，错误经竞速门让 doc-open promise 立即 reject——见 render 侧注） */
    onReadFailure?: (err: unknown) => void;
  }
): PDFDataRangeTransport & { requestRange(begin: number, end: number): Promise<void> } {
  const { size, head, read, signal, onReadFailure } = opts;
  class CtxReadTransport extends BaseCtor {
    constructor() {
      // progressiveDone=false：initialData 是探测头前缀而非完整文件（head 即全量的
      // 文件走 data 路径，不入本分支）
      super(size, head, false);
    }
    /** 可测面：读窗段并交付；reject 原样透传（abort 身份/读失败身份层不变） */
    async requestRange(begin: number, end: number): Promise<void> {
      // [begin, end) 不含端 → ByteRange {start: begin, end: end - 1} 含端
      const chunk = await read({ start: begin, end: end - 1 }, signal);
      this.onDataRange(begin, chunk);
    }
    requestDataRange(begin: number, end: number): void {
      // pdfjs transport API 无 per-chunk 错误回传通道（worker 侧 RangeReader.read 只
      // 有 onDataRange/_enqueue 的 resolve 面，cancel 亦 resolve 为 EOF——6.4.299 实核），
      // 读失败/取消无法直接让 loadingTask.promise reject。收口分两路（M1 评审）：
      // - abort 身份（signal 取消，store 层统一抛 abortReadError）：静默——render 失败
      //   清理与实例 destroy 均前置 signal abort，在飞 ctx.read 先行 reject，无字节再
      //   交付，挂起的 range reader 由 loadingTask.destroy() 收口；
      // - 非 abort 读失败（DispatchReadError/网络错）：交 onReadFailure（携带原始错误，
      //   render 侧 docOpened 门控）——文档未开时经读失败门竞速使 doc-open 立即 reject
      //   进 render 既有 catch → 错误卡片路径（否则 range reader 永久 pending → render
      //   挂死）；doc 已开后懒页 chunk 读失败维持静默（单页空白不渲染，可接受）。
      // 错误身份在此不改写（isAbortError 纯身份判定，见 core/dispatch/errors）。
      void this.requestRange(begin, end).catch((err: unknown) => {
        if (isAbortError(err)) return;
        onReadFailure?.(err);
      });
    }
  }
  return new CtxReadTransport();
}

interface PageState {
  num: number; // 1 起
  wrap: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  renderedScale: number | null;
  rendering: boolean;
  renderTask: { cancel(): void; promise: Promise<void> } | null;
}

export const pdfRenderer: Renderer = {
  id: 'pdf',
  label: 'PDF',
  extensions: ['pdf'],
  // streaming（io-streaming 计划 5 Task 1，spec §6.6）：dispatcher 只交付 head 探测块 +
  // StreamCtx；transport/回退分流在 render 入口自处（下方判定）。本地/退化全量来源
  // 交付的 buffer 即全量，data 路径零变化。lineMetrics/langOverride（第 6 参其余字段）
  // 对 pdf 无消费面，不读即零感知。
  streaming: true,
  async render(buffer: Uint8Array, target: HTMLElement, source: FileSource, _det: Detection, ctx?: StreamCtx, opts?: { signal?: AbortSignal }) {
    const pdfjs = await loadPdfjs();
    // 读取消信号（实例级）：destroy abort 在飞窗段读；外部 signal（dispatch 第 6 参，
    // effect 级取消）合并进同一 controller——两源任一触发皆取消，取消错误身份由
    // ctx.read 契约透传（store 层统一 abortReadError）
    const readAbort = new AbortController();
    const externalSignal = opts?.signal;
    const onExternalAbort = (): void => readAbort.abort();
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) readAbort.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    // 分流判定（spec §6.6 回退矩阵 + dispatcher 读策略镜像，code.ts 守卫同款形态）：
    // transport 分支 = ctx 在场 && store 具备 Range 能力 && size 已知 && buffer 短于
    // size。末项即「dispatcher 只交付了 head 探测块」的充要形态（dispatcher streaming
    // 分支：capable 且 size>1MB 时 buffer=8KB probe；≤1MB 直读全量与 !capable 退化
    // 全量视图均交付全量 buffer，byteLength === size 不入本支）。StreamCtx 无
    // rangeCapable 承载字段（纯 {size, head, read}），rangeCapable 自 source.store 判
    // （与 dispatcher capable 判定同源）。回退矩阵（非 transport 态均落
    // getDocument({data}) 全量现路径）：
    // - ctx 缺失（直调兼容面）：buffer 即全量，data 路径零变化
    // - size null：head 无法确认截断与否 → memoizedFullRead 全量补拉后 data 路径
    // - !rangeCapable：dispatcher 已交付全量（退化视图 byteLength === size）→ data 路径
    //   零变化
    // - 本地 ≤1MB（localFiles/localFs 全量直读）：同上退化视图 → data 路径零变化
    // - 本地 >1MB：localFiles/localFs 同为 rangeCapable:true（File.slice 零网络）→
    //   dispatcher 8KB 探测块 + ctx → transport（终审 I-1 语义对齐：非「data 路径」，
    //   行为良性偏优——按需窗段读替代一次性全量物化）
    // typeof ctx.read === 'function'（I1 纵深防御）：对齐 dispatcher capable 判定的
    // read 在场项（`capable = store.rangeCapable === true && read !== undefined`）——
    // 渲染器无 dispatch read 直通面，以 ctx.read 在场为代理；正常 dispatcher 交付恒真，
    // 仅拦截违约 ctx（read 缺失 → 落全量守卫，memoizedFullRead 处快速失败）
    const transport =
      ctx !== undefined &&
      ctx.size !== null &&
      source.store.rangeCapable === true &&
      typeof ctx.read === 'function' &&
      buffer.byteLength < ctx.size
        ? { size: ctx.size, head: buffer, read: ctx.read }
        : null;
    if (transport === null && ctx !== undefined && (ctx.size === null || buffer.byteLength < ctx.size)) {
      // 全量守卫补拉：size 未知时 head 不可当全量用。读失败在此 await 处 reject
      // （dispatcher 已标 DispatchReadError → 调用方读取失败面）；补拉按 ctx 记忆
      // （memoizedFullRead），错误卡片 retry 重入不重复下载
      buffer = await memoizedFullRead(ctx);
    }
    // BUG-04 握手点 2 代工：size 须在 getDocument 前捕获——pdfjs 会 transfer 该 buffer
    // 到 worker（detach），detach 后 byteLength 归零，getMeta 再读就是 0。transport
    // 分支 buffer 是 head 探测块，size 取 ctx.size（全量文件字节数）
    const size = transport !== null ? transport.size : buffer.length;
    // pdfjs 会 transfer 该 buffer 到 worker（detach）：调用方每次 dispatch 前重新 read，无复用问题。
    // ↑ 该假设仅对「调用方重新 read」的路径成立；**buffer 直传**路径（嵌套附件派发：
    // 派发器把同一份字节交给渲染器，调用方不重新 read）下 detach 会打穿调用方手
    // 里的字节面——pdfjs 打开失败后，dispatcher 的错误卡动作构建（buffer.slice）
    // 对 detached buffer 抛 TypeError，异常逃出 dispatch → 错误卡整个不落地。
    // 故 data 分支与 transport 分支同款：给 pdfjs 一份**副本**
    // （transport 分支见下方 `head: transport.head.slice()`），调用方/dispatcher
    // 手里的 buffer 不再被 transfer 走；与 memoizedFullRead 的「消费即拷贝」契约
    // （:48-55）一致——getDocument transfer 的是副本，保有体不 detach。
    // pdfjs 6 起移除 PDFDocumentProxy.prototype.destroy（api-major，upstream PR 21245）：
    // 资源释放改走 loadingTask.destroy()，故保留 loadingTask 引用
    // M1（评审跟进）：mid-load 读失败收口——transport 的 requestRange 非 abort 读失败
    // 时经 onReadFailure 回调（pdfjs 无 per-chunk 错误通道）；文档未开（promise 未决）
    // → loadingTask.destroy() 使 promise reject 进下方 catch（错误卡片路径），否则
    // range reader 永久 pending → render 挂死且无 destroy 路径；doc 已开后（懒页
    // chunk 读失败）维持静默——单页空白不渲染可接受，不因尾块抖动整页报错
    let docOpened = false;
    // M1 收口双件套（统一验证阶段两段实证）：
    // ①读失败门（firstReadFailure）：pdfjs 6.4.299 的 loadingTask.destroy() 在文档
    //   打开中段挂起（`await this._setupCapability.promise` 永不落定——setup 卡在
    //   range reader 的只 resolve 无 reject 面），destroy 收口路径不可达。onReadFailure
    //   触发门 reject，下方以 Promise.race 让 doc-open 立即按读失败收口；
    // ②身份剥壳：destroy/竞速 reject 的错误若按 AbortException 身份会被 dispatch 错误
    //   身份层归类「abort 不上屏」，错误卡片永不出现——M1 读失败退化剥 abort 身份重抛
    //   （generic → 错误卡片 + 重试），真实取消维持 abort 静默。
    let m1ReadFailed = false;
    let rejectFirstReadFailure: (err: Error) => void = () => {};
    const firstReadFailure = new Promise<never>((_, reject) => {
      rejectFirstReadFailure = reject;
    });
    // onReadFailure 闭包在本初始化式内自引用 loadingTask：回调只在读失败时异步触发，
    // 届时绑定早已完成初始化
    const loadingTask: PDFDocumentLoadingTask =
      transport !== null
        ? pdfjs.getDocument({
            range: createPdfRangeTransport(pdfjs.PDFDataRangeTransport, {
              size: transport.size,
              // initialData 传副本：pdfjs 对 range 参数的 initialData 同样 transfer 到
              // worker（与 data 参数同语义，统一验证阶段 R-06 实证）——直传 head 探测块
              // 会在 render 失败后把 dispatcher 手里的 probe 底座 detach，错误卡片的
              // open-as/retry 动作构建（probe.slice）即抛 detached ArrayBuffer，卡片
              // 丢失全部动作钮。8KB 一次性拷贝换错误路径的字节面完整
              head: transport.head.slice(),
              read: transport.read,
              signal: readAbort.signal,
              onReadFailure: (err) => {
                if (!docOpened) {
                  m1ReadFailed = true;
                  rejectFirstReadFailure(err instanceof Error ? err : new Error(String(err ?? '读取窗段失败')));
                  // destroy 为尽力清理（中段调用会挂起在 setup await 上，promise 永不
                  // 落定——竞速门已先行收口，此处只护资源回收路径）；worker 由下方
                  // catch 显式终止（destroy 挂起期间其内部 terminate 不可达）
                  void loadingTask.destroy().catch(() => {});
                }
              }
            })
          })
        : pdfjs.getDocument({ data: buffer.slice() });
    let doc: PDFDocumentProxy;
    try {
      doc = await Promise.race([loadingTask.promise, firstReadFailure]);
      docOpened = true; // 文档已开：后续懒页 chunk 读失败走静默分支（onReadFailure 门控）
    } catch (e) {
      const cancelled = readAbort.signal.aborted || externalSignal?.aborted === true;
      // 打开失败（损坏 PDF/读失败）：释放 worker 端资源并取消在飞窗段读。真实取消维持
      // abort 身份（dispatch 既有分类：取消 no-op 不上屏）；M1 读失败退化（非 abort
      // 读失败且文档未开 → onReadFailure 门竞速）剥 abort 身份重抛——不改写会被归为
      // 取消而静默，错误卡片永不出现（DispatchReadError/generic 经 dispatcher catch
      // 既有分类，generic 落错误卡片 + 重试，R-06 锚语义）。沿用 errors.ts 既有分类，
      // 不新造错误类别。
      readAbort.abort();
      externalSignal?.removeEventListener('abort', onExternalAbort);
      void loadingTask.destroy().catch(() => {});
      if (m1ReadFailed && !cancelled) {
        // destroy 中段挂起（setup await）→ 其内部 worker terminate 不可达：显式终止
        // 卡在 pending range reader 的 worker（仅 M1 错误路径触达，防每次读失败重试
        // 泄漏一个假死 worker）。
        //
        // 【升级复核点 · pnpm-upgrade 面】（残余 A9 在码锚，pdfjs-dist@6.4.299 实核）：
        // 本行直访 pdfjs PDFDocumentLoadingTask 的私有字段 `_worker`（无公开销毁缝）。
        // 升级 pdfjs-dist 时必须复核两点：①`_worker` 字段是否仍存在且具 `destroy()`；
        // ②上游 `destroy()` 是否已改为同步 terminate 内部 worker（若已修复中段挂起，
        // 本行直访与上方「destroy 挂起」备案一并移除）。复核手段：legacy/build/pdf.mjs
        // （运行期实际加载的构建）搜 `_worker`/`_webWorker` 定义与 destroy 体，或以挂起
        // 形态复现 M1 错误路径验证 terminate 到达性。字段消失时本行 `?.` 静默 no-op
        // 不炸——但泄漏面回归，须以 b-pdf-range 错误路径重试锚复核。
        (loadingTask as unknown as { _worker?: { destroy(): void } })._worker?.destroy();
        throw new Error(e instanceof Error ? e.message : String(e));
      }
      throw e;
    }

    let destroyed = false;
    // 连续缩放值（取代原预设档位下标）：首屏值按 auto 模式在占位入流后求出，见「首屏缩放」段
    let zoomMode: ZoomMode = 'auto';
    let curScale = 1;
    const scale = (): number => curScale;

    const root = document.createElement('div');
    root.className = 'vv-pdf';
    // 构建标记（e2e 判别面）：本次实际加载的 pdfjs 构建（能力感知选择的结果）
    root.dataset.pdfBuild = preferModernBuild() ? 'modern' : 'legacy';
    const toolbar = document.createElement('div');
    toolbar.className = 'vv-pdf-toolbar';
    const pagesHost = document.createElement('div');
    pagesHost.className = 'vv-pdf-pages';
    root.append(toolbar, pagesHost);
    target.replaceChildren(root);

    // ---- 页状态与占位 ----
    // 占位尺寸统一取第一页（绝大多数 PDF 页面尺寸一致）；个别不一致的页渲染完成后
    // 以实际 viewport 修正自身 wrap 尺寸
    const firstPage = await doc.getPage(1);
    const firstViewport = firstPage.getViewport({ scale: 1 });
    const pageW = firstViewport.width;
    const pageH = firstViewport.height;
    const pageCache = new Map<number, Promise<PDFPageProxy>>([[1, Promise.resolve(firstPage)]]);

    function getPage(n: number): Promise<PDFPageProxy> {
      let p = pageCache.get(n);
      if (!p) {
        p = doc.getPage(n);
        pageCache.set(n, p);
      }
      return p;
    }

    const pageStates: PageState[] = [];
    const stateByWrap = new Map<Element, PageState>();
    for (let n = 1; n <= doc.numPages; n++) {
      const wrap = document.createElement('div');
      wrap.className = 'vv-pdf-page';
      const label = document.createElement('span');
      label.className = 'vv-pdf-page-label';
      label.textContent = `${n} / ${doc.numPages}`;
      wrap.append(label);
      setPlaceholderSize(wrap);
      pagesHost.append(wrap);
      const st: PageState = {
        num: n,
        wrap,
        canvas: null,
        renderedScale: null,
        rendering: false,
        renderTask: null
      };
      pageStates.push(st);
      stateByWrap.set(wrap, st);
    }

    function setPlaceholderSize(wrap: HTMLElement): void {
      wrap.style.width = `${pageW * scale()}px`;
      wrap.style.height = `${pageH * scale()}px`;
    }

    // ---- 适宽 ----
    /**
     * 适宽值 = pagesHost 内容可用宽 / 首页 scale 1 的 viewport 宽。可用宽取 clientWidth
     * （含 padding、已扣竖向滚动条）减左右 padding（读计算样式，与 app.css 同源，不写死
     * 12px）。clientWidth<=0（jsdom 或尚未布局）回落 1，与改造前固定 100% 同义。
     */
    function fitScale(): number {
      const cw = pagesHost.clientWidth;
      if (!(cw > 0) || !(pageW > 0)) return 1;
      const cs = getComputedStyle(pagesHost);
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      return Math.max(FIT_SCALE_MIN, (cw - pad) / pageW);
    }

    /** 按当前模式求目标缩放（manual 停在现值） */
    function modeScale(): number {
      if (zoomMode === 'manual') return curScale;
      const fit = fitScale();
      return zoomMode === 'auto' ? Math.min(1, fit) : fit;
    }

    // 首屏缩放：等占位入流后再量宽——多页文档的竖向滚动条此刻已出现、clientWidth 已扣除，
    // 适宽后不会被滚动条再挤出横向溢出；量完按结果重设占位（scale 仍为 1 时重设无变化）。
    // lastHostW 记下此刻的边框盒宽，供「容器宽跟随」段判断宽度是否真的变了
    curScale = modeScale();
    let lastHostW = pagesHost.offsetWidth;
    for (const st of pageStates) setPlaceholderSize(st.wrap);

    // ---- 懒渲染 ----
    async function ensureRender(st: PageState): Promise<void> {
      if (destroyed || st.rendering || (st.canvas !== null && st.renderedScale === scale())) return;
      st.rendering = true;
      const s = scale();
      try {
        const page = await getPage(st.num);
        if (destroyed) return;
        const viewport = page.getViewport({ scale: s });
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const task = page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
        });
        st.renderTask = task;
        try {
          await task.promise;
        } catch (e) {
          if (!isCancelledError(e)) throw e;
          canvas.remove(); // 缩放切换/销毁取消：丢弃本次画布即可
          return;
        }
        if (destroyed || scale() !== s) {
          canvas.remove();
          return;
        }
        st.canvas?.remove();
        st.canvas = canvas;
        st.renderedScale = s;
        st.wrap.append(canvas);
        // 页面尺寸与占位（第一页）不一致时按实际修正
        st.wrap.style.width = `${viewport.width}px`;
        st.wrap.style.height = `${viewport.height}px`;
      } finally {
        st.rendering = false;
        st.renderTask = null;
      }
    }

    // 可视页集合（IO 回调维护）：页码指示与缩放后"立即重渲染可视页"都用它
    const visible = new Set<number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const st = stateByWrap.get(en.target);
          if (!st) continue;
          if (en.isIntersecting) {
            visible.add(st.num);
            void ensureRender(st);
          } else {
            visible.delete(st.num);
          }
        }
        const nums = [...visible].sort((a, b) => a - b);
        if (nums.length > 0) pageIndicator.textContent = `第 ${nums[0]} / ${doc.numPages} 页`;
      },
      { root: pagesHost, rootMargin: LAZY_ROOT_MARGIN }
    );
    for (const st of pageStates) io.observe(st.wrap);

    // 前 3 页立即渲染（IO 只覆盖预热边距内的页，初始视口可能不足 3 页）
    for (const st of pageStates.slice(0, IMMEDIATE_PAGES)) void ensureRender(st);

    // ---- 工具条 ----
    const pageIndicator = document.createElement('span');
    pageIndicator.className = 'vv-pdf-page-indicator';
    pageIndicator.textContent = `第 1 / ${doc.numPages} 页`;
    const zoomBtn = document.createElement('span');
    zoomBtn.className = 'vv-pdf-zoom-label';
    const zoomOut = document.createElement('button');
    zoomOut.type = 'button';
    zoomOut.textContent = '−';
    zoomOut.setAttribute('aria-label', '缩小');
    const zoomIn = document.createElement('button');
    zoomIn.type = 'button';
    zoomIn.textContent = '＋';
    zoomIn.setAttribute('aria-label', '放大');
    const fitBtn = document.createElement('button');
    fitBtn.type = 'button';
    fitBtn.textContent = '↔';
    fitBtn.setAttribute('aria-label', '适应宽度');
    fitBtn.title = '适应宽度';
    toolbar.append(zoomOut, zoomBtn, zoomIn, fitBtn, pageIndicator);

    function syncZoomUi(): void {
      zoomBtn.textContent = `${Math.round(scale() * 100)}%`;
      // 禁用态与步进同一判定：从连续值出发找不到严格相邻档位即禁用
      zoomOut.disabled = adjacentPreset(scale(), -1) === null;
      zoomIn.disabled = adjacentPreset(scale(), 1) === null;
    }

    /**
     * 阅读锚：视口顶部所在页（首个底边越过视口顶的页）+ 视口顶在该页内的纵向比例，横向取
     * 视口中心占内容宽的比例。缩放（含 auto/fit 随容器宽重算、转屏）前取锚、重设占位后
     * 复位——否则 scrollTop 不变而页高按比例变，阅读位置跳到别处。无布局（jsdom/隐藏）
     * 时矩形全 0，取不到锚即不动滚动。
     */
    function readingAnchor(): { st: PageState; frac: number; cx: number } | null {
      const hostTop = pagesHost.getBoundingClientRect().top;
      for (const st of pageStates) {
        const r = st.wrap.getBoundingClientRect();
        if (r.bottom > hostTop) {
          const sw = pagesHost.scrollWidth;
          return {
            st,
            frac: r.height > 0 ? (hostTop - r.top) / r.height : 0,
            cx: sw > 0 ? (pagesHost.scrollLeft + pagesHost.clientWidth / 2) / sw : 0.5
          };
        }
      }
      return null;
    }

    /** 切换到连续缩放值 next 并全量重渲染（三种模式共用；与现值相同即 no-op） */
    function applyScale(next: number): void {
      if (destroyed || next === curScale) return;
      const anchor = readingAnchor();
      curScale = next;
      syncZoomUi();
      // 全量重渲染：取消在途任务、清空已渲染画布、重设占位尺寸；
      // 可视页立即重渲染，其余交还 IO（scroll 位置不变时 IO 不会再触发）
      for (const st of pageStates) {
        st.renderTask?.cancel();
        st.canvas?.remove();
        st.canvas = null;
        st.renderedScale = null;
        setPlaceholderSize(st.wrap);
      }
      if (anchor) {
        // 占位已同步重设尺寸：锚页新位置即刻可量，把「锚页顶 + 页内比例」拉回视口顶
        const r = anchor.st.wrap.getBoundingClientRect();
        pagesHost.scrollTop += r.top - pagesHost.getBoundingClientRect().top + anchor.frac * r.height;
        pagesHost.scrollLeft = Math.max(0, anchor.cx * pagesHost.scrollWidth - pagesHost.clientWidth / 2);
      }
      const nums = visible.size > 0
        ? [...visible]
        : pageStates.slice(0, IMMEDIATE_PAGES).map((s) => s.num);
      for (const n of nums) {
        const st = pageStates[n - 1];
        if (st) void ensureRender(st);
      }
    }

    /** manual 步进：从当前连续值到严格相邻档位（无相邻档时按钮已禁用，此处兜底 no-op） */
    function stepZoom(dir: -1 | 1): void {
      const next = adjacentPreset(curScale, dir);
      if (next === null) return;
      zoomMode = 'manual';
      applyScale(next);
    }

    zoomOut.onclick = () => stepZoom(-1);
    zoomIn.onclick = () => stepZoom(1);
    fitBtn.onclick = () => {
      zoomMode = 'fit';
      lastHostW = pagesHost.offsetWidth;
      applyScale(modeScale());
    };
    syncZoomUi();

    // ---- 容器宽跟随（auto/fit） ----
    // 观察 pagesHost 的边框盒而非内容盒：滚动条出没只改内容盒宽，若跟着重算，临界尺寸下会
    // 「适宽 → 页变高出竖向滚动条 → 内容变窄 → 再适宽 → 页变矮滚动条消失 → …」来回重排。
    // 回调里再以边框盒宽（offsetWidth）与上次量宽比对：observe 时的首次通知、只变高度的
    // 通知都不重算；150ms 防抖合并拖拽调宽/转屏的连串通知；重算结果与现值差不足 0.5% 不重排。
    // 容器暂不可见（clientWidth 归 0，如所在面板被隐藏）时不重算，保持现缩放——否则会先
    // 回落 100% 再恢复，白白两轮全量重渲染。jsdom/旧浏览器无 ResizeObserver：守卫跳过，
    // 只是失去跟随，首屏适宽照常。
    let refitTimer: ReturnType<typeof setTimeout> | null = null;

    function refit(): void {
      refitTimer = null;
      if (destroyed || zoomMode === 'manual') return;
      const hostW = pagesHost.offsetWidth;
      if (hostW === lastHostW || pagesHost.clientWidth <= 0) return;
      lastHostW = hostW;
      const next = modeScale();
      if (Math.abs(next - curScale) > curScale * REFIT_MIN_RATIO) applyScale(next);
    }

    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            if (destroyed || zoomMode === 'manual') return;
            if (refitTimer !== null) clearTimeout(refitTimer);
            refitTimer = setTimeout(refit, REFIT_DEBOUNCE_MS);
          })
        : null;
    ro?.observe(pagesHost, { box: 'border-box' });

    // ---- 搜索 ----
    let pageTexts: string[] | null = null; // 首次搜索时懒提取并缓存
    let lastMatches: PdfSearchMatch[] = [];

    async function ensurePageTexts(): Promise<string[]> {
      if (pageTexts) return pageTexts;
      const out: string[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await getPage(n);
        const tc = await page.getTextContent();
        // items 联合类型含 TextMarkedContent（无 str）：in 收窄到 TextItem 后取最窄字段
        const items: PdfTextItem[] = [];
        for (const it of tc.items) {
          if ('str' in it) items.push({ str: it.str, hasEOL: it.hasEOL === true });
        }
        out.push(extractPageText(items));
      }
      pageTexts = out;
      return out;
    }

    const instance: RenderedInstance & { getMeta(): { size: number } } = {
      // BUG-04 握手点 2 代工：PDF 实例暴露大小（ViewerPane 'getMeta' in inst 探测自动消费，
      // 状态栏/MetaPanel 得以显示「大小」段）
      getMeta: () => ({ size }),
      // BUG-23：caseSensitive 透传（searchPdfPages 纯函数本就支持）；多传 opts 对
      // 旧调用方向后兼容，SearchPanel 的 Aa 开关对 PDF 视图同等生效
      async search(query: string, opts?: { caseSensitive?: boolean }): Promise<PdfSearchMatch[]> {
        if (query === '') {
          lastMatches = [];
          return [];
        }
        const texts = await ensurePageTexts();
        lastMatches = searchPdfPages(texts, query, opts);
        return lastMatches;
      },
      gotoMatch(index: number): void {
        const m = lastMatches[index];
        if (!m) return;
        // line 复用为 0 起页号（见 pdfText.ts 的 PdfSearchMatch 注释）
        const st = pageStates[m.line];
        if (!st) return;
        st.wrap.scrollIntoView({ block: 'start' });
        st.wrap.classList.add('vv-pdf-page-hit');
        setTimeout(() => st.wrap.classList.remove('vv-pdf-page-hit'), HIT_FLASH_MS);
      },
      destroy() {
        destroyed = true;
        readAbort.abort(); // 在飞窗段读（transport requestRange）取消，abort 身份经 ctx.read 契约透传
        externalSignal?.removeEventListener('abort', onExternalAbort);
        io.disconnect();
        ro?.disconnect();
        if (refitTimer !== null) clearTimeout(refitTimer); // 在途防抖不再落地
        for (const st of pageStates) st.renderTask?.cancel();
        pageStates.length = 0;
        stateByWrap.clear();
        void loadingTask.destroy(); // 释放 worker 端文档资源（pdfjs 6：destroy 移至 loadingTask）
        root.remove(); // canvas 一并移除释放
      }
    };
    return instance;
  }
};
