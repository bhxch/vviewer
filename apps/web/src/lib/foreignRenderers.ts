// foreignRenderers.ts — file-viewer 第一波桥接装配（spec §6.3，计划 3 Task 2）。
// 10 组渲染器经 @bhxch/vviewer-render-foreign 的 wrapFileViewerRenderer 桥接为
// vviewer Renderer：扩展名绑定逐字取 spec §6.3 表（全局约束增补 pot 归 presentation，
// §6.3 序 7 注记），挂载面按探针结论接线——各 @file-viewer/renderer-* 包导出
// `xxxRenderer: FileViewerRendererPlugin`（definitions 来自 core 的
// DEFAULT_RENDERER_DEFINITIONS 按 id 拾取 + handlers 按 rendererId 注册），handler
// 签名 `(buffer: ArrayBuffer, target, type?, context?) => Promise<FileViewerRenderedInstance>`，
// type 为小写扩展名。扩展名→handler 的组内路由用 core 的
// createFileViewerRendererDispatcher（definitions 注册面同源）。
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
 */
function pluginMount(load: () => Promise<ForeignPlugin>): ForeignMount {
  let dispatcher: Promise<ForeignDispatcher> | null = null;
  const loadDispatcher = (): Promise<ForeignDispatcher> =>
    (dispatcher ??= (async () => {
      const [core, plugin] = await Promise.all([import('@file-viewer/core'), load()]);
      const registry = core.createRendererRegistry((plugin.definitions ?? []) as readonly RendererDefinition[]);
      return core.createFileViewerRendererDispatcher<ForeignHandler>({ registry, handlers: plugin.handlers ?? [] });
    })());
  return async (args: ForeignMountArgs): Promise<ForeignMountResult> => {
    const d = await loadDispatcher();
    const ext = extOf(args.name);
    const handler = d.get(ext);
    if (!handler) throw new Error(`file-viewer 渲染器无 ".${ext}" 处理器（${args.name}）`);
    const context: FileRenderContext = {
      filename: args.name,
      sourceFile: args.file,
      signal: args.signal,
      renderNestedBuffer: async (nestedBuffer, nestedType, nestedTarget) => {
        await args.renderNested(new Uint8Array(nestedBuffer), nestedName(nestedType), nestedTarget);
        return undefined;
      }
    };
    const rendered = await handler(toArrayBuffer(args.data), args.target as HTMLDivElement, ext, context);
    return { destroy: () => disposeForeignRendered(rendered) };
  };
}

interface ForeignGroupSpec {
  id: string;
  label: string;
  extensions: readonly string[];
  load: () => Promise<ForeignPlugin>;
}

/** 10 组绑定（spec §6.3 表逐字 + pot 增补 presentation；xlsx/xlsm/xls/csv/docx/pptx/
 * dot 维持 vviewer 既有渲染器，不在绑定面）。 */
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
  }
];

/**
 * 构造第一波 10 组桥接渲染器（viewer.ts 装配点：diagram 块后、codeRenderer 前）。
 * nestedDispatch 必传（装配层单源：registry.byExtension → dispatcher.dispatch），
 * 深度限 3 由桥接层强制；assetBaseUrl 计划 3 Task 3 接 resolveForeignAssetBase。
 */
export function createForeignFileRenderers(opts: { nestedDispatch: NestedDispatch }): Renderer[] {
  return FOREIGN_GROUPS.map((g) =>
    wrapFileViewerRenderer({
      id: g.id,
      label: g.label,
      extensions: g.extensions,
      mount: pluginMount(g.load),
      nestedDispatch: opts.nestedDispatch
    })
  );
}

/** 嵌套分派的合成 FileSource store 形：buffer 直传路径不触 store 面（dispatcher 仅读
 * rangeCapable 布尔），空对象即满足；sibling 解析由桥接层 store.read 探测兜 null。 */
export const NESTED_ATTACHMENT_STORE: TreeStore = {} as TreeStore;
