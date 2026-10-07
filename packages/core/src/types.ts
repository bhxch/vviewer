export type Kind = 'file' | 'dir';

export interface TreeNode {
  name: string;
  path: string;           // 相对 store 根的路径，'/' 分隔
  kind: Kind;
  size?: number;
  mtime?: number;         // epoch ms
}

export interface ByteRange { start: number; end: number; } // end 含

export interface TreeStore {
  readonly id: string;    // 实例唯一 id，会话恢复用
  displayName(): string;
  listChildren(path: string): Promise<TreeNode[]>;
  read(path: string, opts?: { range?: ByteRange }): Promise<Uint8Array>;
}

export type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';

export interface Detection {
  ext: string;            // 小写无点；无扩展名为 ''
  lang?: string;          // 代码语言（helix 名，M2 接入 languages.json）
  encoding?: Encoding;
  binary?: boolean;       // magic 或编码检测判定
  signature?: 'zip' | 'ole' | 'png' | 'jpeg' | 'gif' | 'pdf' | null;
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
