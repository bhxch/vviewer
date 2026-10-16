export type Kind = 'file' | 'dir';

export interface TreeNode {
  name: string;
  path: string;           // 相对 store 根的路径，'/' 分隔
  kind: Kind;
  size?: number;
  mtime?: number;         // epoch ms
  /**
   * 该条目已加密（zip 中心目录通用标志 bit0 检出）：树 UI 显示锁形标记；
   * read 该条目将抛"加密不支持预览"。仅 zip 混合包（明文+加密条目）路径产出。
   */
  encrypted?: boolean;
}

export interface ByteRange { start: number; end: number; } // end 含

/**
 * 流式渲染上下文（spec 2026-10-12-io-streaming §2.1）：streaming 渲染器按需取字节
 * 的唯一通道，由 dispatcher 构造、经 render 第 5 参注入。纯增量类型——非 streaming
 * 渲染器不接触该参数，缺省即旧行为（全量 buffer 交付），既有实现零改动。
 */
export interface StreamCtx {
  /** 文件总字节数；null = store 无法预知（渲染器应走全量回退路径） */
  readonly size: number | null;
  /**
   * 已就绪的头部字节：探测策略下为文件前 min(文件长度, HEAD_SIZE) 字节（短文件为
   * 全量，可短于 HEAD_SIZE）；size ≤1MB 直读全量策略与非 rangeCapable 来源下为
   * 全量字节（可远超 HEAD_SIZE）。
   */
  readonly head: Uint8Array<ArrayBuffer>;
  /** 按字节区间读取（end 含，同 ByteRange 语义）；store 无 range 能力时为
   * 全量 buffer 的切片视图（同步 resolve，零拷贝 subarray）。可选 signal：渲染实例
   * destroy 时取消在飞读——aborted 即 reject，取消错误不视为读失败（由 dispatcher
   * 侧区分标注）。 */
  read(range: ByteRange, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
}

export interface TreeStore {
  readonly id: string;    // 实例唯一 id，会话恢复用
  displayName(): string;
  listChildren(path: string): Promise<TreeNode[]>;
  // 返回值按 ArrayBuffer 显式标注：各实现均以自有 ArrayBuffer 构造
  //（fetch/arrayBuffer → new Uint8Array(...)），收窄后结果可直接作 BlobPart（TS 5.7+
  // 泛型 TypedArray：默认 Uint8Array<ArrayBufferLike> 含 SharedArrayBuffer，不满足
  // Blob 构造的 ArrayBufferView<ArrayBuffer> 约束）。
  // opts.signal（流式硬化）：destroy 时取消在飞读——aborted 即 reject（remote 抛
  // fetch 原生 AbortError；非 remote 实现（localFs/localFiles，及 singleFile 的
  // createSingleFileStore/createUrlStore）统一抛 DOMException('读取已取消', 'AbortError')）。
  // 本地实现统一经 core/dispatch/errors 的 abortReadError() 抛出（单源形态）。
  read(path: string, opts?: { range?: ByteRange; signal?: AbortSignal }): Promise<Uint8Array<ArrayBuffer>>;
  /**
   * 能力标记（spec 2026-10-12-io-streaming §2.3）：read 支持 opts.range（bytes
   * 区间语义，end 含）；缺省 false = 仅全量。dispatcher 据此决定 streaming 渲染器
   * 的 StreamCtx 形态（有 range 能力 → 按需读取；无 → 全量构造 ctx）。纯增量
   * 可选标记，既有 store 实现不声明即保持旧行为。
   */
  readonly rangeCapable?: boolean;
  /**
   * 可选：释放 store 持有的底层资源（libarchive worker/wasm 堆等）。
   * 由引用计数接线调用（openFlow：最后一个持有该实例的 tab 关闭时）；
   * 无底层资源的 store（zip/localfiles 等）不实现，调用方以 `store.close?.()` 触达。
   */
  close?(): void;
}

export type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';

export interface Detection {
  ext: string;            // 小写无点；无扩展名为 ''（签名纠偏后为规范扩展名）
  lang?: string;          // 代码语言（helix 名，M2 接入 languages.json；无扩展名回退链写入 shebang 语言）
  encoding?: Encoding;
  binary?: boolean;       // magic 或编码检测判定
  /**
   * 无扩展名回退链命中标记（BUG-07）：ext 为空、经文本性探测交 code 渲染器时置位；
   * 此后 ext 可能已被签名纠偏为规范扩展名，本标记保留"原始无扩展名"事实。
   */
  extless?: boolean;
  /** C 项探测改派标记：内容探测/签名改派生效时记录原扩展名（原生无扩展名不置位（保持 undefined））；
   * 渲染器/错误卡片据此显示「已按内容识别」提示。原生路由不置位。 */
  reclassifiedFrom?: string;
  signature?: 'zip' | 'ole' | 'png' | 'jpeg' | 'gif' | 'pdf' | 'mpegts' | null;
}

export type RendererId = string;

export interface FileSource {
  storeId: string;
  storeLabel: string;     // 目录显示名
  path: string;           // store 内路径
  name: string;           // 文件显示名（含扩展名）
  store: TreeStore;
  /**
   * 文件总字节数（spec 2026-10-12-io-streaming §3：从 TreeNode.size / File.size /
   * remote Content-Length 透传）：UI/渲染器免二次探测即可显示大小或做容量决策；
   * null/缺省 = store 无法预知（渲染器走全量回退）。纯增量可选字段，既有构造点
   * 零改动。
   */
  size?: number | null;
}

export interface RenderedInstance {
  destroy(): void;
  /**
   * 可选：文档目录（markdown 渲染器提供；level 为标题级 1-4，id 为渲染 DOM 内
   * heading 的元素 id——TOC 点击按 id 定位）。无目录数据的渲染器不实现。
   */
  getToc?(): TocEntry[];
  /** 可选：文件内搜索（Task 6 实现；返回命中列表，空 query 返回 []） */
  search?(query: string): Promise<SearchMatch[]>;
  /** 可选：跳转到第 index 个搜索命中（0 起，配合 search 的返回序） */
  gotoMatch?(index: number): void;
}

/** 目录条目（getToc 输出；core 定义避免各渲染器重复形状） */
export interface TocEntry {
  level: number;          // 标题级（h1-h4 → 1-4）
  text: string;           // 标题文本（trim 后）
  id: string;             // 渲染 DOM 内 heading 的元素 id
}

/**
 * 文件内搜索命中（Task 6 的最窄形状：行号 + 行内偏移）。
 * code/markdown/html 源码视图共用行级语义；markdown 渲染视图如需不同定位
 * 信息，由 Task 6 在 render-text 侧扩展，不改 core。
 */
export interface SearchMatch {
  line: number;           // 命中行（0 起）
  start: number;          // 行内起始偏移（UTF-16）
  end: number;            // 行内结束偏移（不含）
}

export interface Renderer {
  id: RendererId;
  label: string;
  extensions: string[];   // 该 renderer 拥有的扩展名（小写无点）
  /** 可选：基于文件头部做签名纠偏，返回应改派的 rendererId */
  sniff?(head: Uint8Array, det: Detection): Promise<RendererId | null> | RendererId | null;
  /**
   * 流式渲染器标记（spec 2026-10-12-io-streaming §2.2）：置位后 dispatcher 只交付
   * head + StreamCtx（render 第 5 参），不交付全量 buffer。缺省 = 既有全量语义，
   * 第 5 参被忽略——未迁移渲染器零改动。
   */
  streaming?: boolean;
  /**
   * 第 5 参 ctx（spec 2026-10-12-io-streaming §2.2）为流式读上下文，向后兼容：
   * streaming 渲染器的 buffer 形参收到的是 head（探测块），全量字节一律经
   * ctx.read；非 streaming 渲染器照常收到全量 buffer，忽略该参即旧行为。
   *
   * 第 6 参 opts.signal：可选取消 signal——超时/异步渲染器的迟到落定校验
   * （image 解码窗）：aborted 即快速失败（abortReadError 身份），由 dispatch
   * catch 的 abort 分类接管（no-op 不上屏）。可选参，渲染器不读即零破坏；
   * 与第 5 参语义独立（code 的窗口模式仅由 ctx 触发，不受本参影响）。
   */
  render(
    buffer: Uint8Array,
    target: HTMLElement,
    source: FileSource,
    det: Detection,
    ctx?: StreamCtx,
    opts?: { signal?: AbortSignal }
  ): Promise<RenderedInstance>;
}
