// foreignAssets.ts — foreign 渲染资产三层解析链（spec §6.2，计划 3 Task 3）。
// grammars 三层链（grammarLayers.ts）先例形态的 base 解析版：foreign 资产 base 是
// 交给 @file-viewer/core 全局基座（setDefaultFileViewerAssetBaseUrl——T2 探针裁决的
// 权威机制，per-mount options 形态作废）的单一 URL，无逐层 fetch——三层体现在
// 「解析优先级」：env 显式 →（同源预留槽，plan 4 接线）→ 缺省 CDN。纯函数、零
// DOM/零 $app 依赖（vite.config define 与装配层可共享同一消费面）。
//
// 目录结构实测（Task 3，jsdelivr data API 逐包核对）：assets-standard@3.3.3 的
// viewer/vendor/ 仅含 docx/libarchive/pdf/pptx/xlsx 五族；chm/hangul/iwork/
// wordperfect/ppt（legacy 二进制管线 pptjs 运行时）的 worker/wasm 资产在各自
// assets-* 包——缺省 CDN 链下按包名替换派生 per-package 基座（
// resolveForeignAssetPackageBase）；env 自托管形态为 asset-installer 合并树根
// （全部 assets-* 的 viewer/vendor/ 合一），per-package 同 base。

/** 缺省 CDN 层：@file-viewer/assets-standard 精确版本直链（版本锁定纪律：禁
 * ^/~ 范围前缀，升级=代码依赖与 CDN 同步的显式单独 commit）。 */
export const FOREIGN_ASSETS_CDN_DEFAULT = 'https://cdn.jsdelivr.net/npm/@file-viewer/assets-standard@3.3.3/viewer/';

/** 同源预留槽（plan 4）：自托管 asset-installer 合并树根挂于此前缀。空串 = 未
 * 启用——链解析跳过该层，接线时改为指向合并树根的 base 即三层齐备。 */
export const FOREIGN_ASSETS_SAME_ORIGIN_PREFIX = '';

/** foreign 资产包清单（assets-standard + 第一波实测需资产的五个独立包 + 第二波四个：
 * data/design/typst/drawing——计划 4 Task 2 探针实测，core assets 清单 defaultPath 均
 * 相对基座派生；jsdelivr 均有 3.3.3 发布。计划 4 Task 3 HEAD 实测台账（jsdelivr，
 * content-length 全量字节）：assets-data sql-wasm.wasm 685,235B、assets-design
 * paged_introspect_wasm_bg.wasm 14,704,821B / stet_wasm_bg.wasm 14,706,940B、
 * assets-drawing viewer-static.min.js 3,909,101B 均 ≤20MB 预案线；assets-typst
 * typst_ts_web_compiler_bg.wasm 28,325,178B ≈27MB **超 20MB**——spec §6.2 预案
 * 备案（记台账即可，不构建自托管 fallback 包：编译器 wasm 仅 .typ 源首渲染消费，
 * CDN 直链 + vv-foreign-assets CacheFirst 单次拉取可控）。 */
export const FOREIGN_ASSET_PACKAGES = [
  'assets-standard',
  'assets-chm',
  'assets-hangul',
  'assets-iwork',
  'assets-ppt',
  'assets-wordperfect',
  'assets-data',
  'assets-design',
  'assets-typst',
  'assets-drawing'
] as const;

export type ForeignAssetPackage = (typeof FOREIGN_ASSET_PACKAGES)[number];

/** 三层链形态（grammars 先例的槽位表达）：env/同源可为空（未启用），cdn 恒非空。 */
export interface ForeignAssetBaseChain {
  /** 层 1：构建期 env VV_FOREIGN_ASSETS（vite define 注入，VV_GRAMMAR_CDN 同款）。
   * 语义 = 自托管 asset-installer 合并树根（全部资产包 vendor/ 同一 base）。 */
  env: string;
  /** 层 2：同源预留槽（plan 4），空 = 未启用。 */
  sameOrigin: string;
  /** 层 3：缺省 CDN（assets-standard 基座，恒非空）。 */
  cdn: string;
}

/** 目录型 base 归一：trim + 尾斜杠收口；空白串归空（层缺失语义）。 */
function normalizeBaseDir(value: string): string {
  const v = value.trim();
  if (v === '') return '';
  return v.endsWith('/') ? v : `${v}/`;
}

function readForeignAssetsEnv(): string {
  // vite define 注入面；vitest/node 下 import.meta.env 可能缺省——防御性可选链
  const env = (import.meta as { env?: { VV_FOREIGN_ASSETS?: string } }).env;
  return env?.VV_FOREIGN_ASSETS ?? '';
}

/** 组装三层链（env 未传时读构建期注入值）。 */
export function foreignAssetBaseChain(env?: string): ForeignAssetBaseChain {
  return {
    env: normalizeBaseDir(env ?? readForeignAssetsEnv()),
    sameOrigin: FOREIGN_ASSETS_SAME_ORIGIN_PREFIX,
    cdn: FOREIGN_ASSETS_CDN_DEFAULT
  };
}

/**
 * 解析 foreign 资产基座（链首非空层，尾斜杠归一）：env 显式 →（同源预留槽，
 * plan 4）→ 缺省 CDN。缺省返回 assets-standard 基座——word/spreadsheet/presentation
 * (pptx 系) 资产直接可用；chm/hangul/iwork/wordperfect/ppt 组经
 * resolveForeignAssetPackageBase 取各自包基座。
 */
export function resolveForeignAssetBase(env?: string): string {
  const chain = foreignAssetBaseChain(env);
  return chain.env || chain.sameOrigin || chain.cdn;
}

/**
 * per-package 基座派生：base 含 `/@file-viewer/assets-standard@` 段时按包名替换
 * （同版本钉死）；无该段时 String.replace 无匹配自然原样返回（无检测分支）——
 * 这正是 env 自托管合并树语义的承接点（全部包同 base），但区分是「合并树根」还是
 * 「形态漂移的坏 base」不在本函数职责内，均静默原样返回。
 *
 * 已知边界（评审 I-3 勘误备案）：若 env base 恰含 assets-standard@ 段（如操作者
 * 把 env 直接指向某个 assets-standard 的镜像 URL），替换照样发生——per-package
 * 基座派生为同域其余 assets-* 包 URL。镜像域同托管全部 assets-* 包时这是期望
 * 行为；仅托管 assets-standard 时其余包 URL 会静默 404（渲染错误卡片承接），
 * 本函数与消费侧均不感知。assets-standard 恒等于 base 本身。
 */
export function resolveForeignAssetPackageBase(pkg: ForeignAssetPackage, base?: string): string {
  const resolved = base ?? resolveForeignAssetBase();
  if (pkg === 'assets-standard') return resolved;
  return resolved.replace('/@file-viewer/assets-standard@', `/@file-viewer/${pkg}@`);
}
