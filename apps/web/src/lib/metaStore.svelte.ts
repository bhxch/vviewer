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
}

export const fileMeta = $state<FileMetaState>({
  name: '',
  sourceLabel: '',
  encoding: '',
  lang: '',
  size: null,
  lines: null,
  openWith: null
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
  // 守卫滤出候选），仅 store.read 失败与 tab 清理不带上行、下拉消失
  fileMeta.openWith = meta?.openWith ?? null;
}
