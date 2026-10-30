/**
 * Encoding 值单源（终审 I-1）：联合类型由本常量数组派生，需「全量编码值清单」的
 * 运行时消费点（remote.ts X-VV-Encoding 响应头白名单等）直接 import 本数组，
 * 扩列时不再出现「类型扩了、运行时白名单漏跟」的静默丢弃。
 * 本常量为运行时值，随 @vviewer/detect 包发布；core/types.ts 转发导出保持既有
 * import 路径零改动。
 */
export const ENCODING_VALUES = [
  'utf-8', 'utf-16le', 'utf-16be', 'utf-32le', 'utf-32be', 'gb18030',
  'shift_jis', 'euc-jp', 'iso-2022-jp', 'euc-kr', 'big5',
  'windows-1250', 'windows-1251', 'windows-1252', 'windows-1253', 'windows-1254',
  'windows-1255', 'windows-1256', 'windows-1257', 'windows-1258',
  'koi8-r', 'ibm866', 'iso-8859-2', 'iso-8859-5', 'iso-8859-7', 'iso-8859-15',
  'x-mac-cyrillic'
] as const;

/**
 * 议题三扩列（§4.3）：追加 chardet 精判白名单标签——仅「严格 UTF-8 失败的文本」经
 * 精判分层（detect/encodingRefine）采纳，置信度 + 白名单双闸，映射外维持 gb18030。
 * 消费面：strategy.ts DECODERS（TextDecoder 标签表，编译期强制同步）与 decodeText。
 */
export type Encoding = typeof ENCODING_VALUES[number];

/**
 * 文件级判别结果的基础形状（本包单源）：扩展名/语言/编码/二进制/magic 签名五类
 * 判别字段。core 的 `Detection extends BaseDetection` 追加派发链标记
 * （extless/reclassifiedFrom）——基础字段扩列改本包，派发语义字段改 core。
 */
export interface BaseDetection {
  ext: string;            // 小写无点；无扩展名为 ''（签名纠偏后为规范扩展名）
  lang?: string;          // 代码语言（helix 名，M2 接入 languages.json；无扩展名回退链写入 shebang 语言）
  encoding?: Encoding;
  binary?: boolean;       // magic 或编码检测判定
  /**
   * magic 签名（20 值枚举；null = 无命中）。core 的 SIGNATURE_ROUTES 按值路由，
   * 枚举扩列需 @vviewer/detect 与 @vviewer/core 两包同步发版。
   */
  signature?: 'zip' | 'ole' | 'png' | 'jpeg' | 'gif' | 'pdf' | 'mpegts'
    | 'mp4' | 'm4a' | 'avif' | 'webm' | 'webp' | 'wav' | 'ico' | 'gz' | '7z' | 'rar' | 'flac' | 'ogg' | 'bmp' | null;
}
