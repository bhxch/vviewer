/**
 * M6 计算后端抽象：策略（policy）、能力与统一结果形状。
 *
 * 计算分两类执行位置：local（前端 tree-sitter worker / 本地库）与
 * remote（vviewer 文件服务器的 /api/compute/* 端点）。ComputeResult.where
 * 标注实际执行位置；router 按 policy × 能力 × 来源路径裁决并定义回退语义。
 *
 * P2 裁剪（M6 计划级裁决）：服务端解包（ArchiveBackend）、服务端高亮
 * injection、comrak 数学掩码均不做；本批 ComputeBackend 仅 Highlight /
 * Markdown / Search 三类（Search 远程 T4 实现，此处类型与路由占位）。
 */

import type { SearchMatch } from '../types';

/** 计算策略：auto = 有能力且来源是远程文件时用远程（失败回退本地）；local / remote = 用户显式指定。 */
export type ComputePolicy = 'auto' | 'local' | 'remote';

/** 能力发现结果（连接时 health capabilities 的最小投影）。 */
export interface ComputeCaps {
  compute: boolean;
}

/** 执行位置：local = 前端 worker / 本地库；remote = 服务器 /api/compute/*。 */
export type ComputeWhere = 'local' | 'remote';

/** 统一计算结果：where 标注执行位置；失败时 ok:false + error（data 缺省）。 */
export interface ComputeResult<T = unknown> {
  where: ComputeWhere;
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * 高亮区间：UTF-16 偏移，左闭右开。
 * 与 @vviewer/highlight 的 HighlightInterval 同构（core 不依赖该包，独立定义，
 * 结构类型互相兼容，可无缝互换）。
 */
export interface HighlightInterval {
  start: number;
  end: number;
  capture: string;
}

/**
 * 计算来源描述。path 为服务端相对路径——只有来自远程 store 的文件才有
 * 服务端 path 语义；本地文件只填 text（auto 策略据此恒走本地）。
 */
export interface ComputeSource {
  path?: string;
  text?: string;
  storeId?: string;
  pathInStore?: string;
}

/** markdown 渲染选项（与服务端 POST /api/compute/markdown 的 options 同形）。 */
export interface MarkdownComputeOptions {
  wikilinks?: boolean;
}

/** 高亮后端：本地实现 = tree-sitter worker；远程实现 = POST /api/compute/highlight。 */
export interface HighlightBackend {
  highlight(src: ComputeSource, lang: string): Promise<ComputeResult<HighlightInterval[]>>;
}

/** markdown 后端：远程实现 = POST /api/compute/markdown（输出必经前端净化管线）。 */
export interface MarkdownBackend {
  render(
    src: ComputeSource | undefined,
    text: string,
    options?: MarkdownComputeOptions
  ): Promise<ComputeResult<string>>;
}

/** 文件内搜索后端（T4 实现；本批仅类型与路由占位）。 */
export interface SearchBackend {
  search(src: ComputeSource, query: string): Promise<ComputeResult<SearchMatch[]>>;
}
