// metaStore.svelte.ts — 文件元数据的模块级 runes 状态（BUG-04）。
// ViewerPane 渲染实例的 getMeta() 写入，MetaPanel 只读展示；与 openFlow 的
// watchHealth/statusNotice 同模式（openFlow/ViewerPane 写入、UI 只读）。
// $state 须位于 .svelte.ts（Svelte 5 runes 编译约定）。

/** 「打开方式」下拉状态（C 项入口 B）：MetaPanel 据此渲染手选渲染器 */
export interface FileOpenWith {
  /** 生效渲染器 id（纯 id 供下拉选中态）；options 头部的 '' = 自动（按扩展名） */
  current: string;
  /** override 手选生效中（MetaPanel 据此附「（手动）」标记） */
  manual: boolean;
  /** 候选项（去重后；头部恒有 { id: '', label: '自动（按扩展名）' }） */
  options: { id: string; label: string }[];
}

/** 数据检查器单行（render-binary decodeAt 输出的结构镜像——web 侧不依赖包内部
 * 导出路径，形状以 metaStore 为单一来源；available=false 的行 value='—' 灰显） */
export interface InspectorRowState {
  label: string;
  value: string;
  available: boolean;
}

/** 数据检查器快照（hex 实例 getInspector 鸭子接口返回；光标定位时存在） */
export interface InspectorSnapshot {
  offset: number;
  little: boolean;
  rows: InspectorRowState[];
}

/** 属性面板展示的元数据（字符串字段空串 = 该项无数据不展示） */
export interface FileMetaState {
  name: string;
  /** 来源显示名（目录名/服务器 host） */
  sourceLabel: string;
  encoding: string;
  lang: string;
  /** 字节数；null = 实例未提供 */
  size: number | null;
  /** 内容行数（仅 code 渲染器有；markdown/html 渲染视图无行概念） */
  lines: number | null;
  /** 打开方式候选与生效项（C 项）；null = 不显示（tab 空/清理/store.read 失败卡片）。
   * dispatch 返回的错误卡片仍带候选（'error' id 经 openWithOf 守卫滤除） */
  openWith: FileOpenWith | null;
  /** 数据检查器（Task 3，hex 增强 §2.3）：hex 实例 + 光标定位时非 null */
  inspector: InspectorSnapshot | null;
}

export const fileMeta = $state<FileMetaState>({
  name: '',
  sourceLabel: '',
  encoding: '',
  lang: '',
  size: null,
  lines: null,
  openWith: null,
  inspector: null
});

/** 写入当前活动文件的元数据（null = 无实例/错误卡片：清空展示） */
export function setFileMeta(
  meta: {
    name: string;
    sourceLabel: string;
    encoding?: string;
    lang?: string | null;
    size?: number | null;
    lines?: number | null;
    openWith?: FileOpenWith | null;
    inspector?: InspectorSnapshot | null;
  } | null
): void {
  fileMeta.name = meta?.name ?? '';
  fileMeta.sourceLabel = meta?.sourceLabel ?? '';
  fileMeta.encoding = meta?.encoding ?? '';
  fileMeta.lang = meta?.lang ?? '';
  fileMeta.size = meta?.size ?? null;
  fileMeta.lines = meta?.lines ?? null;
  // 未带 openWith 的调用（无 meta 实例/store.read 失败卡片/清理）一并清空：下拉只随
  // dispatch 返回的实例出现——渲染失败的错误卡片也带（'error' id 已被 openWithOf
  // 守卫滤出候选），仅 store.read 失败与 tab 清理不带上行、下拉消失。
  // inspector 同语义（Task 3）：只随 hex 实例的光标快照出现，实例切换即清空。
  fileMeta.openWith = meta?.openWith ?? null;
  fileMeta.inspector = meta?.inspector ?? null;
}

/** 数据检查器快照上行（Task 3）：ViewerPane 轮询 hex 实例 getInspector 写入，
 * 只动 inspector 字段（不整表覆盖 fileMeta，避免与 readInstanceMeta 通道互踩） */
export function setInspector(snap: InspectorSnapshot | null): void {
  fileMeta.inspector = snap;
}

/** 数据检查器字节序下行总线（Task 3 裁决）：MetaPanel 无 props 约束（C 项确立），
 * 字节序 select onchange 经本模块级 $state 总线写入，ViewerPane $effect 探测
 * hex 实例 setLittle 透传——与 fileMeta 上行方向相反的同模式单例 */
export const inspectorBus = $state<{ little: boolean }>({ little: true });

export function setInspectorLittle(little: boolean): void {
  inspectorBus.little = little;
}

// ---------- 导出动作区上行（md-export Task 2） ----------

/**
 * 导出能力状态（MetaPanel 据此显隐「导出」动作区）：ViewerPane 探测 markdown
 * 实例 getExportDocument 写入（getToc/getInspector 同款鸭子探测，不动 core 类型）。
 * 仅完整 markdown 实例有句柄——非 markdown 渲染器、超大文件降级视图、错误卡片
 * 皆无 → 钮不显示；Tab.overrideRenderer 指向 markdown 时因句柄可得同样显示
 * （计划 Global Constraints「以实例句柄可得性为准」）。
 */
export const exportState = $state<{ available: boolean }>({ available: false });

/** 导出快照 getter（非响应式模块槽）：Document 克隆是点击时即取的命令式快照，
 * 不进 $state 响应面（响应化只会让每次克隆触发无意义的面板重渲染）。 */
let exportDocGetter: (() => Document | null) | null = null;

/** 上行/清空导出句柄（实例切换由 ViewerPane 渲染 effect 的成功与清理两路调用）。 */
export function setExportHandle(getter: (() => Document | null) | null): void {
  exportDocGetter = getter;
  exportState.available = getter !== null;
}

/** 取当前 markdown 实例的导出快照（无句柄/实例已销毁返回 null，调用方走降级提示）。 */
export function getExportDoc(): Document | null {
  return exportDocGetter?.() ?? null;
}
