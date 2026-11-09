// foreignRenderers.ts — file-viewer 桥接装配（spec §6.3：计划 3 Task 2 第一波 +
// 计划 4 Task 2 第二波）。
// 20 组渲染器经 @bhxch/vviewer-render-foreign 的 wrapFileViewerRenderer 桥接为
// vviewer Renderer：扩展名绑定逐字取 spec §6.3 表（全局约束增补 pot 归 presentation，
// §6.3 序 7 注记；第二波序 12-21 逐字——jxl 不绑定：renderer-image dist 无 JS 解码器，
// 仅 mime 表列名 + 浏览器原生 img 解码面，目标浏览器不支持即恒错误卡，回退未注册），
// 挂载面按探针结论接线——各 @file-viewer/renderer-* 包导出
// `xxxRenderer: FileViewerRendererPlugin`（definitions 来自 core 的
// DEFAULT_RENDERER_DEFINITIONS 按 id 拾取 + handlers 按 rendererId 注册），handler
// 签名 `(buffer: ArrayBuffer, target, type?, context?) => Promise<FileViewerRenderedInstance>`，
// type 为小写扩展名。扩展名→handler 的组内路由用 core 的
// createFileViewerRendererDispatcher（definitions 注册面同源）。
// capability-* 为副作用启用包（import 即生效）：capability-rtf 向 renderer-word 注册
// rtf.js 懒加载器（word 组 loader 内随首渲染同载）、capability-drawio-official 启用
// renderer-drawing 的 diagrams.net 官方运行时（drawing 组，assets-drawing 基座承载）、
// capability-midi 向 renderer-media 注册 MIDI loader（midi 组；renderer-media 的媒体
// 扩展名不注册——vviewer av 占优，绑定面仅 midi/mid）。
//
// chunk 分离（Review Focus 4）：@file-viewer/* 全部动态 import——core 亦在 mount
// 首调时懒加载，本模块静态面零 file-viewer 代码（类型导入编译期擦除），主 chunk
// 不混入（T4 预算门禁锚）。capability-rtf 为副作用启用包（import 即
// enableFileViewerRtf()，向 renderer-word 注册 rtf.js 懒加载器），置于 word 组
// loader 内随首渲染同载。
import type { FileSource, Renderer, TreeStore } from '@bhxch/vviewer-core';
import {
  wrapFileViewerRenderer,
  disposeForeignRendered,
  type ForeignMount,
  type ForeignMountArgs,
  type ForeignMountResult,
  type NestedDispatch
} from '@bhxch/vviewer-render-foreign';
import { resolveForeignAssetBase, resolveForeignAssetPackageBase, type ForeignAssetPackage } from './foreignAssets';
// type-only：编译期擦除，零运行时 chunk 影响
import type {
  FileRenderContext,
  FileRenderHandler,
  FileViewerRenderedInstance,
  FileViewerRendererDispatcher,
  FileViewerRendererPlugin,
  RendererDefinition
} from '@file-viewer/core';

type ForeignPlugin = FileViewerRendererPlugin<FileRenderHandler<FileViewerRenderedInstance, HTMLDivElement>>;
type ForeignHandler = ForeignPlugin['handlers'] extends readonly (infer E)[] | undefined ? (E extends { handler: infer F } ? F : never) : never;
type ForeignDispatcher = FileViewerRendererDispatcher<ForeignHandler>;

/** 由文件名取小写扩展名（registry 归一语义同款：小写无点）。 */
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/**
 * Uint8Array → ArrayBuffer：恒拷贝。foreign handler 侧可能滞留/转交该 buffer
 * （解析器闭包持有、wasm 侧转移），绝不与 dispatcher 持有的全量 buffer 共享底层
 * ArrayBuffer——重渲染/open-as 重入的字节面不受 mount 侧破坏。收窄标注运行时
 * 不变量：vviewer 管线字节恒为 ArrayBuffer backed（store.read/物化泵产出）。
 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/** renderNestedBuffer 的 type 实参为裸扩展名（探针：email 传 getAttachmentExtension、
 * openDocument 传 odt/odp/rtf）——合成文件名供分派/下载兜底使用。空/空白 type
 * （T2 评审 M2：'attachment.' 尾点非法文件名）回落裸 'attachment'。导出仅测试锚用，
 * 装配面不另消费。 */
export function nestedName(type: string): string {
  const t = type.trim();
  if (t.includes('.')) return t;
  const ext = t.toLowerCase();
  return ext ? `attachment.${ext}` : 'attachment';
}

/**
 * 文件名化：取 basename（'/'、'\' 分隔符之后的部分），拒空/纯空白/'.'/'..'。
 * 派发名与下载落盘名共用此口径——落盘名含路径成分会让浏览器按目录语义落盘，
 * 派发名含路径成分会把 'z/evil' 这类后缀派成扩展名（registry 无此扩展名 →
 * 白白绕一圈路由）。导出仅测试锚用，装配面经 nestedDispatchName 消费。
 */
export function fileNameOnly(raw: string | undefined): string {
  if (raw === undefined) return '';
  const t = raw.trim();
  if (t === '') return '';
  const base = t.split(/[\\/]/).pop() ?? '';
  if (base === '' || base === '.' || base === '..') return '';
  return base;
}

/**
 * 嵌套派发名（= 路由依据 + 下载兜底落盘名）：
 * - 优先取上游 renderNestedBuffer 第 4 参 context.filename 里的附件**原名**
 *   （上游 email 渲染器把原名放在该参：`{ ...context, filename: attachment.name }`
 *   —— dist email.js:526-533；此前适配器只取三参、原名被丢弃，落盘名退化为
 *   扩展名派生的 'attachment.<ext>'，FOM-EX-08）；
 * - 原名须文件名化（fileNameOnly）： basename + 拒 '.'/'..'/空——防合成名携带
 *   路径成分（PAT-EX-01：恶意附件名 'x.z/evil' 不得派成扩展名 'z/evil'、
 *   不得落成 'attachment.z/evil'）；
 * - 原名不可用（缺失/纯空白/仅路径成分）时回落扩展名派生名 nestedName(type)，
 *   该派生名同样经文件名化（type 形如 'z/evil' 的恶意后缀不带出路径成分）。
 *
 * 派发名同时是嵌套派发的 source.name（viewer.ts:104-107）——错误卡的
 * '.vv-error-meta' 亦随之显示原名。
 */
export function nestedDispatchName(type: string, rawName?: string): string {
  const fromRaw = fileNameOnly(rawName);
  if (fromRaw !== '') return fromRaw;
  return fileNameOnly(nestedName(type)) || 'attachment';
}

/**
 * 组内 mount 装配：懒加载 core + 渲染器插件（各一次），按 definitions×handlers 建
 * 组内 dispatcher；mount 时扩展名取 handler 直调。context 形态依探针（contracts/
 * types.d.ts FileRenderContext）：filename/sourceFile/signal + renderNestedBuffer——
 * 嵌套回调适配为 ForeignMountArgs.renderNested（计划 2 契约面），返回 undefined
 * 安全（core disposeFileViewerRendered(undefined) no-op，宿主随外层实例统一销毁）。
 *
 * 资产基座（计划 3 Task 3，T2 探针裁决）：权威机制 = core 全局
 * setDefaultFileViewerAssetBaseUrl，per-mount options 形态作废。装配级一次（幂等
 * 护栏）：首个组 dispatcher 建成时把解析链首层基座设为全局缺省；此后 mount 期按
 * 组的资产包归属切换（终审修复 I1：基座切换+handler 调用整体入全局队列按序执行，
 * 见下「mount 串行队列」注——「setter+handler 同步块 run-to-completion 原子」仅
 * 对 9/10 组的同步前奏成立，spreadsheet 组强制串行）。
 * ForeignMountArgs.assetBaseUrl 透传契约保留（bridge 测试锚）但装配不填——
 * setter 已权威，透传留作外部注入缝。
 */
let coreModule: typeof import('@file-viewer/core') | null = null;
let appliedAssetBase: string | null = null;

function applyForeignAssetBase(base: string): void {
  if (!coreModule || appliedAssetBase === base) return;
  coreModule.setDefaultFileViewerAssetBaseUrl(base);
  appliedAssetBase = base;
}

// ---- mount 串行队列（终审修复 I1：spreadsheet 组基座切换交叉窗口）----
//
// renderer-spreadsheet dist 的 handler 首语句 `await loadEVirtTable(documentRef)`
// 先于 xlsx worker URL 解析——窗口内另一组 mount 切走全局基座 → xlsx worker URL
// 挂错包 → 404 降级主线程。其余 9 组 handler 在同步前奏内即完成 worker/wasm URL
// 解析（JS run-to-completion 使「基座切换+前奏」天然原子，本就安全）；spreadsheet
// 组窗口跨 await，必须串行。修法：顶层 mount 的「基座切换+handler 调用（含等待）」
// 整体入全局队列按序执行——任何组的切换-解析窗互不交叉。
//
// 嵌套豁免（死锁防线）：foreign handler 会 await context.renderNestedBuffer（email
// 附件预览 dist 实测 await）→ nestedDispatch → 可再入 foreign mount（eml 内嵌
// eml/odt 等，spec §6.4 深度限 3 的设计面）。嵌套调用发生时队列必被祖先 mount
// 任务占据，再入队即死锁——renderNestedBuffer（嵌套分派唯一入口）登记 target，
// mount 入口识别嵌套 target 即内联执行（祖先任务占队期间无其他顶层任务可交叉，
// 内联任务结束在 finally 恢复祖先基座）。并发兄弟嵌套同时跨组的基座交叉为已知
// 残余边界（email 附件预览 UI 单激活槽实测互斥，不叠加）。
const nestedForeignTargets = new WeakSet<HTMLElement>();
let mountQueueTail: Promise<unknown> = Promise.resolve();

function pluginMount(load: () => Promise<ForeignPlugin>, groupId: string): ForeignMount {
  let dispatcher: Promise<ForeignDispatcher> | null = null;
  const loadDispatcher = (): Promise<ForeignDispatcher> =>
    (dispatcher ??= (async () => {
      const [core, plugin] = await Promise.all([import('@file-viewer/core'), load()]);
      coreModule = core;
      if (appliedAssetBase === null) {
        // 装配级一次（幂等护栏）：链首层基座（env 显式 → 同源预留槽 → 缺省 CDN）
        appliedAssetBase = resolveForeignAssetBase();
        core.setDefaultFileViewerAssetBaseUrl(appliedAssetBase);
      }
      const registry = core.createRendererRegistry((plugin.definitions ?? []) as readonly RendererDefinition[]);
      return core.createFileViewerRendererDispatcher<ForeignHandler>({ registry, handlers: plugin.handlers ?? [] });
    })());
  const mountBody = async (args: ForeignMountArgs): Promise<ForeignMountResult> => {
    const d = await loadDispatcher();
    const ext = extOf(args.name);
    const handler = d.get(ext);
    if (!handler) throw new Error(`file-viewer 渲染器无 ".${ext}" 处理器（${args.name}）`);
    // 组资产包基座切换（无资产组为 null——保持当前基座不动）；与 handler 直调
    // 同步块执行（顶层任务由队列保证无交叉，见「mount 串行队列」注）
    const pkg = foreignGroupAssetPackage(groupId, ext);
    const savedBase = appliedAssetBase;
    if (pkg) applyForeignAssetBase(resolveForeignAssetPackageBase(pkg));
    const context: FileRenderContext = {
      filename: args.name,
      sourceFile: args.file,
      signal: args.signal,
      renderNestedBuffer: async (nestedBuffer, nestedType, nestedTarget, nestedCtx) => {
        // 嵌套 target 登记（见「mount 串行队列」注）：嵌套 foreign mount 据此豁免
        // 队列内联执行，防祖先任务占队死锁
        nestedForeignTargets.add(nestedTarget);
        // 嵌套字节恒拷贝（toArrayBuffer 同款不变量，:54-62）：上游 email 的附件
        // buffer 与 vviewer 渲染器的字节面不得共享底层 ArrayBuffer——渲染器可能
        // transfer/detach 它（pdfjs getDocument({data}) 零拷贝 transfer），打穿
        // 上游附件字节面（其 sizeLabel/后续读取拿到零长 buffer）。
        const nestedBytes = new Uint8Array(nestedBuffer).slice();
        // 派发名取附件原名（第 4 参 context.filename，经文件名化消毒）——原名此前
        // 被丢弃、落盘名为扩展名派生的 attachment.<ext>（FOM-EX-08）。
        await args.renderNested(nestedBytes, nestedDispatchName(nestedType, nestedCtx?.filename), nestedTarget);
        return undefined;
      }
    };
    try {
      const rendered = await handler(toArrayBuffer(args.data), args.target as HTMLDivElement, ext, context);
      return { destroy: () => disposeForeignRendered(rendered) };
    } finally {
      // 基座恢复：嵌套内联任务交还祖先基座；顶层任务恢复进入前值（下一 mount
      // 自带切换，resting 值无消费面）
      if (pkg) applyForeignAssetBase(savedBase ?? resolveForeignAssetBase());
    }
  };
  return (args: ForeignMountArgs): Promise<ForeignMountResult> => {
    // 嵌套重入：内联执行（见「mount 串行队列」注死锁防线）
    if (nestedForeignTargets.has(args.target)) return mountBody(args);
    // 顶层 mount：基座切换+handler 调用整体入队（见「mount 串行队列」注）；前序
    // 任务失败不阻断后续（防毒队列），本任务结果原样透传调用方
    const task = mountQueueTail.then(() => mountBody(args));
    mountQueueTail = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  };
}

/**
 * 每组资产包归属（Task 3 实测映射，jsdelivr data API 逐包核对；导出仅测试锚与
 * 文档面，装配经 pluginMount 消费）：
 * - assets-standard@3.3.3/viewer/vendor/：docx（word 组 docx 系 worker+jszip）、
 *   pptx（presentation pptx 系 worker）、xlsx（spreadsheet worker）、libarchive/pdf（本
 *   波未绑定，vviewer 自有管线不消费）；
 * - 独立包：assets-chm（chm worker+wasm 三件）、assets-hangul、assets-iwork（worker）、
 *   assets-wordperfect（worker+libwpd wasm/mjs）；
 * - assets-ppt（终审修复 I2 注记如实化）：presentation 组 ppt/pot 分流行保留此映射
 *   （无害——基座切换幂等，切了也没人消费），但 renderer-ppt 实际走内置
 *   import('@file-viewer/ppt') 运行时（ppt@1.0.2 dist wasmRequired:false）——ppt/pot
 *   当前零 CDN 资产消费，assets-ppt 的 vendor/ppt/dist 永不被交付面拉取；如需切
 *   CDN 须显式传 presentation.pptModuleUrl（renderer-ppt dist loadPptModule 的
 *   options 缝，实测 moduleUrl 存在时走 CDN 动态 import），届时本映射与 SW
 *   vv-foreign-assets 规则零改动生效；
 * - 第二波独立包（计划 4 Task 2 探针实测，core assets 清单 defaultPath 相对基座派生，
 *   jsdelivr 均有 3.3.3）：assets-data（sql wasm viewer/wasm/data/sql-wasm.wasm——
 *   sqlite 组内 renderSqlite 经 resolveFileViewerDataSqlWasmUrl 基座解析；字体面走
 *   FontFace API 零资产）、assets-design（vendor/design/ 系 worker+wasm——photoshop/
 *   illustrator/postscript/idml 等全部 design-* definition 消费）、assets-typst
 *   （wasm/typst/ 编译器+渲染器 wasm 与字体资产）、assets-drawing（vendor/drawio/
 *   viewer-static.min.js + 离线资产目录——官方 diagrams.net 运行时）；
 * - 无资产组：email/epub/ofd（epubjs、dltech ofd 随各 renderer dist 打包，相对
 *   import 非 CDN 资产）+ 第二波 image/geo/dicom/signature/eda/midi（heic2any/utif/
 *   dicom-parser/cfb 随 dist 打包；maplibre worker 内联源码 blob URL；signature 的
 *   openpgp worker 与 rpgp wasm 均在包 dist 内经 import.meta.url 解析、vite 静态
 *   发射自包含；midi loader 为纯 JS 能力注册）。
 */
export const FOREIGN_GROUP_ASSET_PACKAGE: Record<string, (ext: string) => ForeignAssetPackage | null> = {
  'foreign-email': () => null,
  'foreign-epub': () => null,
  'foreign-ofd': () => null,
  'foreign-chm': () => 'assets-chm',
  'foreign-word': () => 'assets-standard',
  'foreign-presentation': (ext) => (ext === 'ppt' || ext === 'pot' ? 'assets-ppt' : 'assets-standard'),
  'foreign-spreadsheet': () => 'assets-standard',
  'foreign-iwork': () => 'assets-iwork',
  'foreign-hangul': () => 'assets-hangul',
  'foreign-wordperfect': () => 'assets-wordperfect',
  'foreign-data': () => 'assets-data',
  'foreign-design': () => 'assets-design',
  'foreign-image': () => null,
  'foreign-geo': () => null,
  'foreign-typst': () => 'assets-typst',
  'foreign-dicom': () => null,
  'foreign-signature': () => null,
  'foreign-eda': () => null,
  'foreign-drawing': () => 'assets-drawing',
  'foreign-midi': () => null
};

function foreignGroupAssetPackage(groupId: string, ext: string): ForeignAssetPackage | null {
  return (FOREIGN_GROUP_ASSET_PACKAGE[groupId] ?? (() => null))(ext);
}

interface ForeignGroupSpec {
  id: string;
  label: string;
  extensions: readonly string[];
  /** 能渲染但不默认拥有的扩展名（Renderer.altExtensions）：上游定义覆盖、vviewer 已有
   * 所有者的格式——用户可在设置「打开方式」改为默认，或经「打开方式」临时改选 */
  altExtensions?: readonly string[];
  load: () => Promise<ForeignPlugin>;
}

/**
 * T2 评审 I-2 携带修复（spec §6.3 序 13 注记诉求：psd/ai/eps 高保真渲染）：
 * design 组 data-asset handler 接上游增强缝。根因（两包 dist 实核）：pluginMount
 * 的组内 registry 是裸 createRendererRegistry(definitions)——不走 core 的
 * enhancement-aware install plan（registry.js createRendererDefinitionInstallPlan
 * 仅 installFileViewerRenderers 装配路径生效），data-asset definition 自带的
 * psd/ai/eps 扩展名注册原样生效，dispatcher 按 byExtension 路由把 psd/ai/eps
 * 命中 data-asset 的 handler（renderer-data 的 renderFileViewerData 基础数据
 * 视图）；design definitions 的 enhancesRendererId/enhancesExtensions
 * （photoshop-design enhances psd、illustrator-pdf-design enhances ai、
 * postscript-design enhances eps）在裸 registry 下不迁移扩展名归属。上游为此
 * 预备的权威缝即 renderFileViewerDesignOrData（enhancedDataFormats = design
 * definitions enhancesExtensions 并集 {psd,ai,eps}，命中增强格式走
 * renderFileViewerDesign 高保真，否则原样 renderFileViewerData）——把 data-asset
 * handler 替换为它即完成缝。psb/pdd/psdt/ait/ps 是 design definitions 的直接
 * 扩展名，handler 本就指 renderFileViewerDesign，替换不触及。handler 形态同签名
 * （双侧均为 FileRenderHandler<FileViewerRenderedInstance, HTMLDivElement>，
 * dist d.ts 实核），零适配。dataId 取 renderer-data 的 dataRendererDefinition.id
 * ——与 renderer-design dist 内 enhancedDataFormats 的归属判定同源（该包本就静态
 * 依赖 renderer-data，零新增 chunk 级联）。导出仅测试锚用（装配经 FOREIGN_GROUPS
 * 消费），测试锚断言替换后 handler 身份与未动面。
 */
export function wireDesignOrDataSeam(
  design: typeof import('@file-viewer/renderer-design'),
  data: typeof import('@file-viewer/renderer-data')
): ForeignPlugin {
  const plugin = design.designRenderer;
  const dataId = data.dataRendererDefinition.id;
  return {
    ...plugin,
    handlers: (plugin.handlers ?? []).map((h) =>
      h.rendererId === dataId ? { ...h, handler: design.renderFileViewerDesignOrData } : h
    )
  };
}

/** 20 组绑定（spec §6.3 表逐字 + pot 增补 presentation；xlsx/xlsm/xls/csv/docx/pptx/
 * dot 维持 vviewer 既有渲染器，不在绑定面；第二波序 12-21——jxl 不绑定（探针裁决，
 * renderer-image dist 无解码器），renderer-media 的媒体扩展名不注册（av 占优），
 * drawing 仅 drawio/dio（mermaid/plantuml/excalidraw/bpmn 维持 vviewer 图表面，
 * bpmn-js 不装），design 组经 wireDesignOrDataSeam 接上游增强缝（T2 评审 I-2），
 * psd/ai/eps 随 data-asset handler 走 design 高保真。 */
const FOREIGN_GROUPS: readonly ForeignGroupSpec[] = [
  {
    id: 'foreign-email',
    label: '邮件',
    extensions: ['eml', 'msg', 'mbox'],
    load: () => import('@file-viewer/renderer-email').then((m) => m.emailRenderer)
  },
  {
    id: 'foreign-epub',
    label: '电子书',
    extensions: ['epub', 'fb2', 'umd'],
    load: () => import('@file-viewer/renderer-epub').then((m) => m.ebookRenderer)
  },
  {
    id: 'foreign-ofd',
    label: 'OFD 版式文档',
    extensions: ['ofd'],
    load: () => import('@file-viewer/renderer-ofd').then((m) => m.ofdRenderer)
  },
  {
    id: 'foreign-chm',
    label: 'CHM 帮助文档',
    extensions: ['chm'],
    load: () => import('@file-viewer/renderer-chm').then((m) => m.chmRenderer)
  },
  {
    // capability-rtf 副作用同载：open-document definition 的 rtf 面经 rtf.js 懒加载器启用
    id: 'foreign-word',
    // label 不得与 core docx 渲染器（render-doc/src/docx.ts 'Word 文档'，.docx 专有）
    // 同名：registry 全量面双同名项曾炸 TabContextMenu 的 label-keyed each（Svelte 5
    // each_key_duplicate prod 恒抛 → kit 错误边界整页换 500 错误页，CI OWM-03/04/05
    // 全灭实迹），且选择面出现两个不可分辨的「Word 文档」。本组覆盖 doc/docm/dotx/
    // dotm/odt/odp/rtf 兼容格式（.docx 由 core 专有），label 带限定后缀去重。
    label: 'Word 文档（兼容格式）',
    extensions: ['doc', 'docm', 'dotx', 'dotm', 'odt', 'odp', 'rtf'],
    load: () =>
      Promise.all([import('@file-viewer/renderer-word'), import('@file-viewer/capability-rtf')]).then(([m]) => m.wordRenderer)
  },
  {
    id: 'foreign-presentation',
    label: '演示文稿',
    extensions: ['ppt', 'pot', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm'],
    load: () => import('@file-viewer/renderer-presentation').then((m) => m.presentationRenderer)
  },
  {
    id: 'foreign-spreadsheet',
    label: '电子表格',
    extensions: ['xltx', 'xlsb', 'xlt', 'xla', 'xlam', 'xltm', 'ods', 'fods', 'dbf', 'tsv'],
    // 上游 spreadsheet-openxml 定义同样覆盖 xlsx/xlsm/xls/csv（vviewer 自有 xlsx 表格与
    // code 纯文本仍为内置默认）——作为候选可经设置/打开方式改选
    altExtensions: ['xlsx', 'xlsm', 'xls', 'csv'],
    load: () => import('@file-viewer/renderer-spreadsheet').then((m) => m.spreadsheetRenderer)
  },
  {
    id: 'foreign-iwork',
    label: 'iWork 文档',
    extensions: ['pages', 'numbers', 'key'],
    load: () => import('@file-viewer/renderer-iwork').then((m) => m.iworkRenderer)
  },
  {
    id: 'foreign-hangul',
    label: 'Hangul 文档',
    extensions: ['hwp', 'hwpx'],
    load: () => import('@file-viewer/renderer-hangul').then((m) => m.hangulRenderer)
  },
  {
    id: 'foreign-wordperfect',
    label: 'WordPerfect 文档',
    extensions: ['wpd', 'wp', 'wp5', 'wp6'],
    load: () => import('@file-viewer/renderer-wordperfect').then((m) => m.wordPerfectRenderer)
  },
  // ---- 第二波（spec §6.3 序 12-21，计划 4 Task 2）----

  {
    // 字体查看面（ttf/otf/woff/woff2）走 FontFace API，fonts store 加载职责不动
    // （spec §6.3 序 12 注记）；wasm 自 hex 清单同 commit 转移（模块结构/导出解析）。
    id: 'foreign-data',
    label: '数据与字体',
    extensions: ['sqlite', 'parquet', 'avro', 'webarchive', 'ttf', 'otf', 'woff', 'woff2', 'wasm'],
    load: () => import('@file-viewer/renderer-data').then((m) => m.dataRenderer)
  },
  {
    id: 'foreign-design',
    label: 'Adobe 设计',
    extensions: [
      'psb', 'pdd', 'psdt', 'psd', 'ait', 'ai', 'idml', 'icml', 'idms', 'inx', 'fla', 'xfl',
      'xd', 'indd', 'indt', 'ps', 'eps', 'ase', 'aco', 'abr', 'csh', 'pat', 'grd', 'asl'
    ],
    // data-asset handler 接 renderFileViewerDesignOrData（wireDesignOrDataSeam，
    // T2 评审 I-2/spec §6.3 序 13：psd/ai/eps 走 design 高保真而非 data 基础视图）
    load: () =>
      Promise.all([import('@file-viewer/renderer-design'), import('@file-viewer/renderer-data')]).then(
        ([design, data]) => wireDesignOrDataSeam(design, data)
      )
  },
  {
    // 仅新 4 扩展名（spec §6.3 序 14「仅新 5」减 jxl——探针裁决不绑定）；原 9 格式
    // 维持 vviewer imageRenderer。
    id: 'foreign-image',
    label: '扩展图片',
    extensions: ['tiff', 'tif', 'heic', 'heif'],
    load: () => import('@file-viewer/renderer-image').then((m) => m.imageRenderer)
  },
  {
    // geojson/kml/gpx 自 code 的 generated 兜底转移（装配块居前不被抢注）；shp 的
    // .dbf/.prj/.shx 边车经桥接 resolveSibling 统一回调读兄弟文件（spec §6.4）——
    // 裸单文件来源的 .shp 在 createForeignFileRenderers 装配点前置拦截为降级错误卡
    // （withSingleFileShpGuard，spec §6.4「裸单文件维持降级错误卡」）。
    id: 'foreign-geo',
    label: '地理数据',
    extensions: ['geojson', 'kml', 'gpx', 'shp'],
    load: () => import('@file-viewer/renderer-geo').then((m) => m.geoRenderer)
  },
  {
    id: 'foreign-typst',
    label: 'Typst 排版',
    extensions: ['typ', 'typst'],
    load: () => import('@file-viewer/renderer-typst').then((m) => m.typstRenderer)
  },
  {
    id: 'foreign-dicom',
    label: 'DICOM 影像',
    extensions: ['dcm', 'dicom'],
    load: () => import('@file-viewer/renderer-dicom').then((m) => m.dicomRenderer)
  },
  {
    id: 'foreign-signature',
    label: '电子签名',
    extensions: [
      'p7m', 'p7s', 'p7c', 'p7b', 'pkcs7', 'cms', 'cmsc', 'tsd', 'tst', 'tsq', 'tsr',
      'asics', 'scs', 'asice', 'sce', 'ers', 'asc', 'sig', 'pgp', 'gpg', 'jws'
    ],
    load: () => import('@file-viewer/renderer-signature').then((m) => m.signatureRenderer)
  },
  {
    id: 'foreign-eda',
    label: 'EDA 电路',
    extensions: ['olb', 'dra', 'gds', 'oas', 'oasis'],
    load: () => import('@file-viewer/renderer-eda').then((m) => m.edaRenderer)
  },
  {
    // capability-drawio-official 副作用同载：drawing definition 的 drawio 面经官方
    // diagrams.net 运行时启用（assets-drawing 基座承载 viewer-static.min.js）；
    // bpmn 不启用（bpmn-js 不装，.bpmn 维持计划 1 diagram-bpmn 渲染器）。
    id: 'foreign-drawing',
    label: 'Draw.io 图表',
    extensions: ['drawio', 'dio'],
    load: () =>
      Promise.all([import('@file-viewer/renderer-drawing'), import('@file-viewer/capability-drawio-official')]).then(
        ([m]) => m.drawingRenderer
      )
  },
  {
    // capability-midi 副作用同载：向 renderer-media 注册 MIDI loader；renderer-media
    // 的媒体扩展名不注册（vviewer av 占优），绑定面仅 midi/mid。
    id: 'foreign-midi',
    label: 'MIDI 音乐',
    extensions: ['midi', 'mid'],
    load: () =>
      Promise.all([import('@file-viewer/renderer-media'), import('@file-viewer/capability-midi')]).then(
        ([m]) => m.mediaRenderer
      )
  }
];

/**
 * 裸单文件 .shp 前置拦截（spec §6.4：裸单文件维持降级错误卡「Shapefile 需同目录
 * .shx/.dbf/.prj」，FOM-SHP-01 钉死）。
 *
 * 为什么只拦 `single:` 前缀来源（createSingleFileStore 的 storeId 形态
 * `single:<name>:<size>:<lastModified>`）：Shapefile 是多文件格式，.shp 本体只有
 * 几何，属性/投影/索引在 .dbf/.prj/.shx 边车里，边车必须经同目录 sibling 读取得来
 * ——而单文件来源（拖拽/文件 picker 单选）在模型上只有孤零零一个 File，**不存在
 * 「同目录」这回事**，边车原理上无法取得。上游 renderer-geo 只解 .shp 本体、不消费
 * 边车，且上游 FileRenderContext 契约无 sibling 字段，边车链路端到端不通（已知
 * 限制，记档于 docs/e2e/file-viewer-foreign-bridge.md）；对单文件来源若不拦截，
 * 结果是静默渲染出无属性几何——比报错更误导，故按 spec 落降级错误卡。throw 由
 * core dispatcher 的 render catch 承接为错误卡（重试/纯文本/hex 三动作）。
 *
 * 为什么目录/远端/zip 来源不拦：这些来源的 sibling 读取面存在（目录=store 路径
 * 读、远端=tree/file 通道、zip=归档兄弟条目），边车「能否取到」取决于用户数据里
 * 是否真有边车文件——数据问题应由渲染路径自然处理而非装配层一刀切拒绝。且目录来
 * 源在当前实现下静默出无属性几何是既有语义（上游限制所致，知情记档），本拦截不改
 * 变它，只兜住「边车原理上不可能存在」的单文件形态。
 *
 * 挂装点取 Renderer.render 包装层而非 pluginMount：ForeignMountArgs（桥接契约）
 * 不携带 storeId，只有 render 的 FileSource 实参有——在此拦是能拿到判定所需来源
 * 形态的最小侵入点（桥接包零改动）。仅 foreign-geo 组装配时套用；throw 在委托
 * bridge render 之前，不触发插件懒加载。
 */
const SINGLE_FILE_SHP_ERROR =
  'Shapefile 需同目录的 .shx/.dbf/.prj 边车文件，单文件来源无法读取；请改用包含这些文件的文件夹方式打开';

/** 裸单文件 .shp 判定（FOM-SHP-01）：.shp 扩展名 + storeId 为单文件来源形态。 */
export function isSingleFileShpSource(source: Pick<FileSource, 'name' | 'storeId'>): boolean {
  return extOf(source.name) === 'shp' && source.storeId.startsWith('single:');
}

/** 为 foreign-geo 组渲染器套上裸单文件 .shp 拦截（装配点见上注；导出仅测试锚用）。
 * async 包装：拦截以 rejection 而非同步 throw 冒泡——错误卡「重试」动作走
 * `render(...).then().catch()` 链，同步 throw 会绕过该链直接逃逸（卡片不重建）。 */
export function withSingleFileShpGuard(renderer: Renderer): Renderer {
  const inner = renderer.render.bind(renderer);
  return {
    ...renderer,
    async render(buffer, target, source, det, ctx, opts) {
      if (isSingleFileShpSource(source)) throw new Error(SINGLE_FILE_SHP_ERROR);
      return inner(buffer, target, source, det, ctx, opts);
    }
  };
}

/**
 * 构造 20 组桥接渲染器（第一波 10 组 + 第二波 10 组；viewer.ts 装配点：diagram 块后、
 * codeRenderer 前）。
 * nestedDispatch 必传（装配层单源：registry.byExtension → dispatcher.dispatch），
 * 深度限 3 由桥接层以显式 depth 形参强制。资产基座不经此处透传——权威机制为
 * core 全局 setDefaultFileViewerAssetBaseUrl（pluginMount 内装配级一次 + 组包
 * 切换，见 pluginMount 注）；ForeignMountArgs.assetBaseUrl 透传缝保留不填。
 * foreign-geo 组附加裸单文件 .shp 前置拦截（withSingleFileShpGuard，spec §6.4）。
 */
export function createForeignFileRenderers(opts: { nestedDispatch: NestedDispatch }): Renderer[] {
  return FOREIGN_GROUPS.map((g) => {
    const bridged = wrapFileViewerRenderer({
      id: g.id,
      label: g.label,
      extensions: g.extensions,
      mount: pluginMount(g.load, g.id),
      nestedDispatch: opts.nestedDispatch
    });
    // 候选声明在装配层附加（桥接契约零改动）：组内路由按扩展名取 handler，候选扩展名
    // 与自有扩展名同一路径（pluginMount d.get(ext)），无需桥接层感知
    const renderer: Renderer = g.altExtensions ? { ...bridged, altExtensions: [...g.altExtensions] } : bridged;
    return g.id === 'foreign-geo' ? withSingleFileShpGuard(renderer) : renderer;
  });
}

/** 嵌套分派的合成 FileSource store 形：buffer 直传路径不触 store 面（dispatcher 仅读
 * rangeCapable 布尔），空对象即满足；sibling 解析由桥接层 store.read 探测兜 null。 */
export const NESTED_ATTACHMENT_STORE: TreeStore = {} as TreeStore;
