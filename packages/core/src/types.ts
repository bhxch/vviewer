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
}

export interface Renderer {
  id: RendererId;
  label: string;
  extensions: string[];   // 该 renderer 拥有的扩展名（小写无点）
  /** 可选：基于文件头部做签名纠偏，返回应改派的 rendererId */
  sniff?(head: Uint8Array, det: Detection): Promise<RendererId | null> | RendererId | null;
  render(buffer: Uint8Array, target: HTMLElement, source: FileSource, det: Detection): Promise<RenderedInstance>;
}
