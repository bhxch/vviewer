// metaStore.svelte.ts — 文件元数据的模块级 runes 状态（BUG-04）。
// ViewerPane 渲染实例的 getMeta() 写入，MetaPanel 只读展示；与 openFlow 的
// watchHealth/statusNotice 同模式（openFlow/ViewerPane 写入、UI 只读）。
// $state 须位于 .svelte.ts（Svelte 5 runes 编译约定）。

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
}

export const fileMeta = $state<FileMetaState>({
  name: '',
  sourceLabel: '',
  encoding: '',
  lang: '',
  size: null,
  lines: null
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
  } | null
): void {
  fileMeta.name = meta?.name ?? '';
  fileMeta.sourceLabel = meta?.sourceLabel ?? '';
  fileMeta.encoding = meta?.encoding ?? '';
  fileMeta.lang = meta?.lang ?? '';
  fileMeta.size = meta?.size ?? null;
  fileMeta.lines = meta?.lines ?? null;
}
