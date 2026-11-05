// bridge.ts — @bhxch/vviewer-render-foreign 桥接契约层（spec §6.1）。
// 外部（foreign）渲染器宿主接线的单源类型面 + 装配函数：计划 3（foreign mount
// 接线）与计划 4（数据源泵）消费。render 实装（计划 3 Task 2）：Uint8Array→File
// 物化、signal 贯穿、mount 调用、RenderedInstance destroy 对接、renderNested→
// 装配注入回调（depth 限 3，超限落下载）。foreign 库本体依赖留在装配层
// （apps/web），本包零 file-viewer 依赖。
import type { FileSource, RenderedInstance, Renderer, TreeStore } from '@bhxch/vviewer-core';

/**
 * 嵌套渲染回调（计划 3 由宿主侧装配注入 mount args）：foreign 渲染器把内部子文件
 * （如嵌入图片/子文档）转交 vviewer 既有渲染管线，在指定 target 内渲染，不返回实例
 * （生命周期由宿主随外层实例统一销毁）。
 */
export interface NestedRender {
  (data: Uint8Array, name: string, target: HTMLElement): Promise<void>;
}

/**
 * sibling 解析回调（createSiblingResolver 产出，注入 mount args）：按名读取与
 * 当前文件同目录的兄弟文件字节；目录外/不可读/缺失一律 null（不抛，foreign 渲染器
 * 侧自行决定回退策略）。
 */
export interface SiblingResolver {
  (name: string): Promise<Uint8Array | null>;
}

/**
 * foreign mount 的返回面：销毁委托单字段（计划 3 Task 2 实装）。装配层把 foreign
 * 渲染实例的 unmount/$destroy/destroy（@file-viewer/core FileViewerRenderedInstance
 * 三形态，见 disposeForeignRendered）归一为 destroy；bridge render 再映射为
 * RenderedInstance.destroy——vviewer 宿主随 tab 生命周期统一释放。
 */
export interface ForeignMountResult {
  destroy?: () => void | Promise<void>;
}

/**
 * 注入 foreign 渲染器的挂载参数（计划 3 构造）：
 * - data/file/name：当前文件字节与 File 形（foreign 库普遍吃 File 对象）；
 * - target：挂载 DOM 容器；signal：外层渲染实例销毁联动的取消信号；
 * - renderNested/resolveSibling：嵌套渲染与兄弟文件读取的唯一通道；
 * - assetBaseUrl：可选，foreign 库静态资产（wasm/css 等）的基址。
 */
export interface ForeignMountArgs {
  data: Uint8Array;
  file: File;
  name: string;
  target: HTMLElement;
  signal: AbortSignal;
  renderNested: NestedRender;
  resolveSibling: SiblingResolver;
  assetBaseUrl?: string;
}

/** foreign 渲染器挂载函数（wrapFileViewerRenderer 的 spec.mount 消费面）。 */
export interface ForeignMount {
  (args: ForeignMountArgs): Promise<ForeignMountResult>;
}

/**
 * 嵌套渲染分派回调（装配层注入，viewer.ts 提供）：bridge 的 renderNested 经它把
 * 嵌套子文件转交 vviewer dispatcher byExtension 渲染。
 *
 * depth 形参（计划 3 T2 评审 M1 精化，计划 2 预留缝的契约扩展）：调用方所在渲染
 * 链的显式深度贯穿——renderNested 以「自身深度 +1」显式传参（顶层渲染深度 0，首个
 * 嵌套层 1），替代计划 2 的 signal 键深度表快照/复位簿记（并发兄弟附件在复位窗口
 * 互相覆盖深度、嵌套链可越限）。装配层实现收到 depth 后须经 markForeignNestedDepth
 * 把深度登记到 target（嵌套渲染实例与 target 一一对应：兄弟并发各持独立 target、
 * 错误重试同 target——读写无竞争），再经 dispatcher 分派；桥接 render 以 target
 * 取回自身深度，链式传递闭环。
 */
export interface NestedDispatch {
  (data: Uint8Array, name: string, target: HTMLElement, signal: AbortSignal, depth: number): Promise<void>;
}

/** 嵌套渲染深度上限（Review Focus 5：eml-in-eml 递归死循环防线）：外层记 depth 0，
 * 每层嵌套 +1；请求超出即落下载兜底（不再重入 dispatcher）。 */
export const FOREIGN_NESTED_DEPTH_LIMIT = 3;

/** 嵌套链深度表（key=嵌套渲染 target）：装配层经 markForeignNestedDepth 在分派前
 * 登记、桥接 render 启动时读回自身深度。target 键竞争免疫（兄弟并发各持独立
 * target、重试同 target 复读同值），替代 T2 的 signal 键快照/复位簿记（M1）。 */
const nestedDepthByTarget = new WeakMap<HTMLElement, number>();

function foreignNestedDepth(target: HTMLElement): number {
  return nestedDepthByTarget.get(target) ?? 0;
}

/**
 * 装配层分派嵌套渲染前登记该 target 的渲染深度（NestedDispatch.depth 的承接缝，
 * 见该契约注记）。顶层渲染不经此登记（读回 0）；重复登记以最后一次为准。
 */
export function markForeignNestedDepth(target: HTMLElement, depth: number): void {
  nestedDepthByTarget.set(target, depth);
}

/** BlobPart 窄型收窄：vviewer 管线的字节恒为 ArrayBuffer backed（store.read/物化泵
 * 产出，无 SharedArrayBuffer 面），运行时不变量在此显式化。 */
function asBlobPart(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return data as Uint8Array<ArrayBuffer>;
}

/**
 * 嵌套附件下载兜底（超深度限 / 装配未注入 nestedDispatch）：blob URL +
 * `<a download>` 点击（saveAsBlob 兜底同款原语，revoke 延迟覆盖下载启动窗）。
 * 渲染器嵌套预览的"不可用"降级由此统一承接，不向 foreign 渲染器抛错。
 */
export function downloadNestedAttachment(data: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([asBlobPart(data)]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'attachment';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * foreign 渲染实例销毁归一：@file-viewer/core 的 FileViewerRenderedInstance 三形态
 * `{unmount}|{$destroy}|{destroy}`（core disposeFileViewerRendered 同序探测）。
 * 装配层 mount 返回前经此把 foreign 实例映射为 ForeignMountResult.destroy。
 */
export function disposeForeignRendered(rendered: unknown): void | Promise<void> {
  if (!rendered || typeof rendered !== 'object') return;
  const d = rendered as { unmount?: unknown; $destroy?: unknown; destroy?: unknown };
  if (typeof d.unmount === 'function') return (d.unmount as () => void | Promise<void>).call(rendered);
  if (typeof d.$destroy === 'function') return (d.$destroy as () => void | Promise<void>).call(rendered);
  if (typeof d.destroy === 'function') return (d.destroy as () => void | Promise<void>).call(rendered);
}

/**
 * 把 foreign mount 包装为 vviewer 渲染管线可注册的 Renderer：
 * id/label/extensions 逐字透传；streaming:false（foreign 库吃全量字节/ File 形，
 * 不接 StreamCtx）。render 实装（计划 3 Task 2）：signal 取 render 第 6 参 opts.signal
 * （缺省每次独立新 signal），File 物化后交 spec.mount；renderNested 以显式深度
 * 贯穿强制 FOREIGN_NESTED_DEPTH_LIMIT（自身深度经 target 深度表读回——装配层
 * markForeignNestedDepth 登记；超限/未注入 nestedDispatch 一律 downloadNestedAttachment）；
 * mount 返回的销毁委托映射为 RenderedInstance.destroy。
 */
export function wrapFileViewerRenderer(spec: {
  id: string;
  label: string;
  extensions: readonly string[];
  mount: ForeignMount;
  /** 装配注入的嵌套分派（viewer.ts：registry.byExtension → dispatcher.dispatch）；
   * 缺省时嵌套请求一律落下载兜底。 */
  nestedDispatch?: NestedDispatch;
  /** foreign 静态资产基座（计划 3 Task 3 接 VV_FOREIGN_ASSETS 三层链），透传 mount args。 */
  assetBaseUrl?: string;
}): Renderer {
  return {
    id: spec.id,
    label: spec.label,
    extensions: [...spec.extensions],
    streaming: false,
    async render(buffer, target, source, det, _ctx, opts): Promise<RenderedInstance> {
      if (!(buffer instanceof Uint8Array) || !target || !source || !det) {
        throw new TypeError('foreign render 参数不完整（buffer/target/source/det 必填）');
      }
      // signal 贯穿（审计 R1 I-1 同参异构面）：dispatch 第 6 参透传；缺省独立新
      // signal（直调/测试形态）。深度读回以 target 为键（装配层
      // markForeignNestedDepth 登记，见 NestedDispatch 契约注记）：顶层未登记 → 0。
      const signal = opts?.signal ?? new AbortController().signal;
      const depth = foreignNestedDepth(target);
      const renderNested: NestedRender = async (data, name, nestedTarget) => {
        if (signal.aborted) return; // 外层已取消：嵌套请求静默丢弃（DOM 随外层销毁）
        if (!spec.nestedDispatch || depth + 1 > FOREIGN_NESTED_DEPTH_LIMIT) {
          downloadNestedAttachment(data, name);
          return;
        }
        // 显式深度贯穿（M1）：无共享簿记、无复位——并发兄弟各携 depth+1，互不干扰
        await spec.nestedDispatch(data, name, nestedTarget, signal, depth + 1);
      };
      const result = await spec.mount({
        data: buffer,
        file: new File([asBlobPart(buffer)], source.name),
        name: source.name,
        target,
        signal,
        renderNested,
        resolveSibling: createSiblingResolver(source),
        assetBaseUrl: spec.assetBaseUrl,
      });
      return {
        destroy: () => {
          void result.destroy?.();
        },
      };
    },
  };
}

// core 未导出 POSIX path 工具（rg 'dirname|joinPath' packages/vviewer-core/src 无
// 命中）。foreign sibling 解析只需两则纯字符串操作，本地实现 POSIX 语义（'/' 分隔，
// 与 FileSource.path"相对 store 根的路径，'/' 分隔"注释一致）；不引 node:path，
// 保持零运行时依赖与浏览器直跑。
function posixDirname(p: string): string {
  const i = p.lastIndexOf('/');
  if (i < 0) return '';
  return p.slice(0, i);
}

function posixJoin(...segs: readonly string[]): string {
  return segs.filter((s) => s !== '').join('/');
}

/**
 * 由 FileSource 构造 sibling 解析器：`store.read(join(dirname(source.path), name))`。
 * 防御语义（不抛）：foreign 泵装配期传入的 FileSource 形不保证完整——store 缺失
 * （纯 File 形）、store 无 read、目录型来源（path 以 '/' 结尾）一律返回 null；
 * read 抛错（含取消）亦兜 null，回退策略由 foreign 渲染器侧决定。
 */
export function createSiblingResolver(source: FileSource): SiblingResolver {
  return async (name: string): Promise<Uint8Array | null> => {
    const store = source.store as TreeStore | undefined;
    if (!store || typeof store.read !== 'function') return null;
    if (source.path === '' || source.path.endsWith('/')) return null;
    try {
      return await store.read(posixJoin(posixDirname(source.path), name));
    } catch {
      return null;
    }
  };
}
