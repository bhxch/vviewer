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

export interface TreeStore {
  readonly id: string;    // 实例唯一 id，会话恢复用
  displayName(): string;
  listChildren(path: string): Promise<TreeNode[]>;
  read(path: string, opts?: { range?: ByteRange }): Promise<Uint8Array>;
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
  signature?: 'zip' | 'ole' | 'png' | 'jpeg' | 'gif' | 'pdf' | 'mpegts' | null;
}

export type RendererId = string;

export interface FileSource {
  storeId: string;
  storeLabel: string;     // 目录显示名
  path: string;           // store 内路径
  name: string;           // 文件显示名（含扩展名）
  store: TreeStore;
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
  render(buffer: Uint8Array, target: HTMLElement, source: FileSource, det: Detection): Promise<RenderedInstance>;
}
