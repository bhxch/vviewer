// bridge.ts — @bhxch/vviewer-render-foreign 桥接契约层（spec §6.1）。
// 外部（foreign）渲染器宿主接线的单源类型面 + 装配函数：计划 3（foreign mount
// 接线）与计划 4（数据源泵）消费。本任务只锚定契约与 sibling 解析行为；render
// 主体为占位桩，计划 3 以 spec.mount 装配实装。
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
 * foreign mount 的返回面。本任务仅契约占位，字段随计划 3 接线实装扩展
 * （如外部渲染实例句柄/销毁委托）。
 */
export interface ForeignMountResult {
  // 计划 3 接线时扩展。
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
 * 把 foreign mount 包装为 vviewer 渲染管线可注册的 Renderer：
 * id/label/extensions 逐字透传；streaming:false（foreign 库吃全量字节/ File 形，
 * 不接 StreamCtx）。render 主体为占位桩——参数校验后抛错占位，计划 3 替换为
 * spec.mount(...) 装配实装。
 */
export function wrapFileViewerRenderer(spec: {
  id: string;
  label: string;
  extensions: readonly string[];
  mount: ForeignMount;
}): Renderer {
  return {
    id: spec.id,
    label: spec.label,
    extensions: [...spec.extensions],
    streaming: false,
    async render(buffer, target, source, det): Promise<RenderedInstance> {
      if (!(buffer instanceof Uint8Array) || !target || !source || !det) {
        throw new TypeError('foreign render 参数不完整（buffer/target/source/det 必填）');
      }
      throw new Error('foreign mount 由计划 3 接线');
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
