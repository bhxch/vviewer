// types.ts — @bhxch/vviewer-markdown 包内最小结构类型面：本包不依赖 @bhxch/vviewer-core，
// 渲染器/实例/来源等契约以结构类型自持（形状与 core 同名类型逐字段兼容，宿主
// 侧 core 值可直接传入；core 值消费方以本类型承接零转换）。

/**
 * Encoding 值清单镜像（@bhxch/vviewer-detect ENCODING_VALUES 同列自持）：decodeText 的
 * TextDecoder 标签表按本联合编译期强制同步。扩列需同步 decodeText.ts DECODERS。
 */
export const ENCODING_VALUES = [
  'utf-8', 'utf-16le', 'utf-16be', 'utf-32le', 'utf-32be', 'gb18030',
  'shift_jis', 'euc-jp', 'iso-2022-jp', 'euc-kr', 'big5',
  'windows-1250', 'windows-1251', 'windows-1252', 'windows-1253', 'windows-1254',
  'windows-1255', 'windows-1256', 'windows-1257', 'windows-1258',
  'koi8-r', 'ibm866', 'iso-8859-2', 'iso-8859-5', 'iso-8859-7', 'iso-8859-15',
  'x-mac-cyrillic'
] as const;

export type Encoding = typeof ENCODING_VALUES[number];

/** 文件级判别结果的最小消费形状（core Detection 的结构子集：markdown 渲染只读 ext/encoding）。 */
export interface DetectionLike {
  /** 小写无点扩展名；无扩展名为 '' */
  ext?: string;
  encoding?: Encoding;
}

/** 渲染来源的最小消费形状（core FileSource 的结构子集：markdown 渲染只读五字段）。 */
export interface FileSourceLike {
  storeId: string;
  storeLabel: string;
  /** store 内路径（远程计算路由与图片 resolver 的 path 语义） */
  path: string;
  /** 文件显示名（含扩展名） */
  name: string;
}

/** 文件内搜索命中（core SearchMatch 同形）：行号 + 行内 UTF-16 偏移。 */
export interface SearchMatch {
  line: number;
  start: number;
  end: number;
}

/** 目录条目（getToc 输出）：level 为标题级 1-4，id 为渲染 DOM 内 heading 元素 id。 */
export interface TocEntry {
  level: number;
  text: string;
  id: string;
}

/** 执行位置：local = 前端本地引擎；remote = 服务器 /api/compute/*。 */
export type ComputeWhere = 'local' | 'remote';

/**
 * 计算来源描述（core ComputeSource 同形）：path 为服务端相对路径，只有远程 store
 * 文件才有服务端 path 语义。
 */
export interface ComputeSource {
  path?: string;
  text?: string;
  storeId?: string;
  pathInStore?: string;
}

/**
 * 围栏代码高亮回调契约（pipeline 的 highlightFence）：返回 span HTML（如
 * HighlightClient 区间 + resolveCaptureClass 生成，或包内默认 tree-sitter 高亮器
 * highlightDefault 产物）；返回 null 时管线内 hljs 兜底；抛错（取消：tab 切换后
 * 请求作废）时管线静默跳过该块、不 hljs 兜底（结果即将随文档丢弃）。
 */
export type HighlightFence = (code: string, lang: string) => Promise<string | null>;
