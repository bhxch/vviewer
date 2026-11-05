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
import type { Renderer, TreeStore } from '@bhxch/vviewer-core';
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
      renderNestedBuffer: async (nestedBuffer, nestedType, nestedTarget) => {
        // 嵌套 target 登记（见「mount 串行队列」注）：嵌套 foreign mount 据此豁免
        // 队列内联执行，防祖先任务占队死锁
        nestedForeignTargets.add(nestedTarget);
        await args.renderNested(new Uint8Array(nestedBuffer), nestedName(nestedType), nestedTarget);
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
  load: () => Promise<ForeignPlugin>;
}

/** 20 组绑定（spec §6.3 表逐字 + pot 增补 presentation；xlsx/xlsm/xls/csv/docx/pptx/
 * dot 维持 vviewer 既有渲染器，不在绑定面；第二波序 12-21——jxl 不绑定（探针裁决，
 * renderer-image dist 无 JS 解码器），renderer-media 的媒体扩展名不注册（av 占优），
 * drawing 仅 drawio/dio（mermaid/plantuml/excalidraw/bpmn 维持 vviewer 图表面，
 * bpmn-js 不装），design 组的 psd/ai/eps 上游插件经 data-asset definition 认领
 * （handlers 里 data-asset ← renderer-data 的 renderFileViewerData——增强缝
 * renderFileViewerDesignOrData 上游未接线，按插件原样桥接）。 */
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
    label: 'Word 文档',
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
    load: () => import('@file-viewer/renderer-design').then((m) => m.designRenderer)
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
    // .dbf/.prj/.shx 边车经桥接 resolveSibling 统一回调读兄弟文件（spec §6.4）。
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
 * 构造 20 组桥接渲染器（第一波 10 组 + 第二波 10 组；viewer.ts 装配点：diagram 块后、
 * codeRenderer 前）。
 * nestedDispatch 必传（装配层单源：registry.byExtension → dispatcher.dispatch），
 * 深度限 3 由桥接层以显式 depth 形参强制。资产基座不经此处透传——权威机制为
 * core 全局 setDefaultFileViewerAssetBaseUrl（pluginMount 内装配级一次 + 组包
 * 切换，见 pluginMount 注）；ForeignMountArgs.assetBaseUrl 透传缝保留不填。
 */
export function createForeignFileRenderers(opts: { nestedDispatch: NestedDispatch }): Renderer[] {
  return FOREIGN_GROUPS.map((g) =>
    wrapFileViewerRenderer({
      id: g.id,
      label: g.label,
      extensions: g.extensions,
      mount: pluginMount(g.load, g.id),
      nestedDispatch: opts.nestedDispatch
    })
  );
}

/** 嵌套分派的合成 FileSource store 形：buffer 直传路径不触 store 面（dispatcher 仅读
 * rangeCapable 布尔），空对象即满足；sibling 解析由桥接层 store.read 探测兜 null。 */
export const NESTED_ATTACHMENT_STORE: TreeStore = {} as TreeStore;
