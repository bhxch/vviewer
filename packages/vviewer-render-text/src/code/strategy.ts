/**
 * code/strategy.ts — 降级策略常量与 hljs 桥（FE-2 自 code.ts 分块迁出，函数体
 * 逐字搬移）。本块为子模块 DAG 底层（无块内依赖）：策略阈值/行高常量、
 * resolveStrategy、DECODERS 与 hljs 别名桥三函数。
 */
import type { Encoding } from '@bhxch/vviewer-core';

/** hljs 动态导入的默认导出类型（HLJSApi）；internal：renderCode/renderCodeWindowed
 * 的 hljs 懒加载变量类型（拆分前为 code.ts 模块内私有类型，跨块共享升导出） */
export type HLJS = (typeof import('highlight.js'))['default'];

/**
 * hljs 别名桥接：helix 语言名 → hljs 语言 id（仅收录 hljs.getLanguage 直查失败的键；
 * sh/shell/zsh/golang/rb/md/yml/c++ 等 hljs 自带别名已直查命中，不在此列）。
 * 目标 id 全部经 hljs.getLanguage 实测命中；hljs 无对应语言的键（zig/wgsl 等）不收录，
 * 回落 highlightAuto。
 */
export const HLJS_ALIASES: Readonly<Record<string, string>> = {
  'c-sharp': 'csharp',
  'objective-c': 'objectivec',
  'fish': 'bash', // fish 语法近似 POSIX shell
  'htmldjango': 'django',
  'ocaml-interface': 'ocaml',
  'textproto': 'protobuf',
  'docker-compose': 'yaml', // compose 文件即 YAML 语法
  'vue': 'xml', // SFC 模板为 XML 形态（hljs 11 无 vue 语言）
  'svelte': 'html',
  'astro': 'html',
  'markdown.inline': 'markdown',
  'markdown-rustdoc': 'markdown',
  'common-lisp': 'lisp',
  'elisp': 'lisp',
  'fennel': 'lisp',
  'racket': 'scheme',
  'purescript': 'haskell',
  'env': 'ini',
  'gdscript': 'python',
  'starlark': 'python', // starlark 为 Python 方言
  'gomod': 'go',
  'gotmpl': 'jinja' // 模板语法近似
};

/**
 * helix 语言名 → hljs 可用语言 id：直查命中原样返回，否则查桥接表；
 * 都无返回 null（调用方回落 highlightAuto）。
 */
export function resolveHljsLang(hljs: HLJS, lang: string | null): string | null {
  if (lang === null) return null;
  if (hljs.getLanguage(lang)) return lang;
  const mapped = HLJS_ALIASES[lang];
  return mapped !== undefined && hljs.getLanguage(mapped) ? mapped : null;
}

/**
 * highlightAuto 灾难输入采样防线（MM-17 flaky 根因修复）：hljs 的 highlightAuto
 * 对全量输入遍历全部语言评分，长重复 token 输入（base64/minified/填充串——40KB
 * 实测 minified 2.4s、base64 >35s，abnf 规则名正则灾难回溯）在主线程同步冻结页面。
 * 检测只需语言特征，head 采样足够（512B 实测 ≤24ms）；命中后按指定语言全量高亮，
 * 指定语言路径为线性耗时（abnf 40KB 实测 4ms）。
 */
export const HLJS_AUTO_PROBE_BYTES = 512;

/** 采样检测语言：head 采样喂 highlightAuto 取语言 id；未检出/异常返回 null。 */
export function highlightAutoDetect(hljs: HLJS, text: string): string | null {
  const probe = text.length > HLJS_AUTO_PROBE_BYTES ? text.slice(0, HLJS_AUTO_PROBE_BYTES) : text;
  try {
    return hljs.highlightAuto(probe).language ?? null;
  } catch {
    return null;
  }
}

/** 采样检测 + 指定语言全量高亮（highlightAuto 的安全替身）：返回完整行数的高亮
 * HTML；未检出语言/高亮异常返回 null（调用方回落纯文本面，与 auto 未命中同义）。 */
export function highlightAutoSafe(hljs: HLJS, text: string): string | null {
  const language = highlightAutoDetect(hljs, text);
  if (language === null) return null;
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/** 降级链阈值：≤2MB tree-sitter 整文件；≤200MB lazy（可视区 chunk 懒高亮）；更大纯文本。
 * tree-sitter 阈值 2MB 的依据：实测 ~2.1-2.4s/MB，2MB≈4-5s，与移动端预算同量级，
 * 据 spec 5.11 预算校准。plain 上限 200MB：lazy 化后不再有整文件解析成本，上限只防
 * 解码文本的内存失控（Uint8Array+string ≈ 字节数的 3-4 倍持有）。 */
export const TREE_SITTER_MAX_BYTES = 2 * 1024 * 1024;
export const HLJS_MAX_BYTES = 20 * 1024 * 1024;
/** 纯文本降级上限（参数化，spec §5.2）：>此值不做任何语法高亮 */
export const PLAIN_MAX_BYTES = 200 * 1024 * 1024;
/** markdown/html 富文本渲染输入上限（与 hljs 阈值同源 20MB）：净化与 DOM 遍历
 * 管线无分块，超大输入会长时间阻塞主线程；超限跳过富文本管线，降级为代码/纯
 * 文本视图（renderDegradedCode）。 */
export const MARKUP_MAX_BYTES = 20 * 1024 * 1024;
export const LINE_HEIGHT = 20;
/**
 * 行高常量缺省值注记（字体系统 Task 2）：常量保留为 opts.lineMetrics 缺省回落值
 * （直调兼容面，跨包零破坏）。应用内字号联动经 CodeRenderOptions.lineMetrics
 * （codeRenderer.render 第 6 参透传）——全部行高消费点（虚拟滚动装配/行占位高度/
 * 跳转虚拟坐标，全量与窗口两路径）一律取局部 lineHeight，不得直引本常量。
 */

export type HighlightStrategy = 'tree-sitter' | 'lazy' | 'plain';

/** 降级链（按字节大小）：≤2MB tree-sitter（失败→hljs 整文件）；2MB–200MB lazy
 * （可视区驱动 chunk，tree-sitter 质量、chunk 失败行级 hljs 兜底）；>200MB 纯文本 */
export function resolveStrategy(size: number): HighlightStrategy {
  if (size <= TREE_SITTER_MAX_BYTES) return 'tree-sitter';
  if (size <= PLAIN_MAX_BYTES) return 'lazy';
  return 'plain';
}

/** Encoding → TextDecoder 标签（decodeText 消费；UTF-32 不在表内——WHATWG TextDecoder
 * 不支持，decodeText 自带定长解码器分流）。议题三扩列由本 Record 编译期强制同步。 */
export const DECODERS: Record<Exclude<Encoding, 'utf-32le' | 'utf-32be'>, string> = {
  'utf-8': 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16be': 'utf-16be',
  'gb18030': 'gb18030',
  'shift_jis': 'shift_jis',
  'euc-jp': 'euc-jp',
  'iso-2022-jp': 'iso-2022-jp',
  'euc-kr': 'euc-kr',
  'big5': 'big5',
  'windows-1250': 'windows-1250',
  'windows-1251': 'windows-1251',
  'windows-1252': 'windows-1252',
  'windows-1253': 'windows-1253',
  'windows-1254': 'windows-1254',
  'windows-1255': 'windows-1255',
  'windows-1256': 'windows-1256',
  'windows-1257': 'windows-1257',
  'windows-1258': 'windows-1258',
  'koi8-r': 'koi8-r',
  'ibm866': 'ibm866',
  'iso-8859-2': 'iso-8859-2',
  'iso-8859-5': 'iso-8859-5',
  'iso-8859-7': 'iso-8859-7',
  'iso-8859-15': 'iso-8859-15',
  'x-mac-cyrillic': 'x-mac-cyrillic'
};
