// highlightRecreate.ts — spec E 修 3：client 毒化重建的 neutral hook + 门控纯谓词。
// 纯 .ts、无任何 import：这是它与消费方的唯一契约边界（vitest 直测唯一入口，
// frontend-conventions §2 分工纪律）。
//
// 为什么是 neutral hook（导入环反转，计划 Review Focus 5）：切渲染器/切语言的触发面
// 在 tabsModel.svelte.ts，重建实现在 highlightClient.ts——直 import 成环
//（tabsModel→highlightClient→openFlow.svelte→tabsModel，实查成立）。hook 把「谁重建」
// 反转为「注册进来的单点」：tabsModel 只依赖本模块（无环），highlightClient.ts 模块
// 加载时注册实现，5 个显式动作调用点收口为 store 内 2 处接线。
//
// 门控形态（计划 Interfaces）：recreate({ force? })——force 无条件重建（CDN 档位
// 变更的 manifest 快照语义）；非 force 过 failed-态门控谓词，健康 client + 显式动作
// = no-op（门即限流器，单飞/代际竞态防线沿用 highlightClient 既有 generation 计数）。

/** 重建实现签名：与 highlightClient.ts 的 recreateHighlightClient({ force? }) 同形。 */
export type RecreateFn = (opts?: { force?: boolean }) => void;

/** failed-态门控状态快照（调用方就地取值——highlightClient 模块内私有状态的只读投影） */
export interface RecreateGateState {
  /** 创建期失败（ensureHighlightClient catch；attach null 终态） */
  creationFailed: boolean;
  /** 当前实例 failWorker 毒化（isInitFailed()） */
  clientInitFailed: boolean;
  /** worker 健康、三层 manifest 全失败（grammarManifest = {} 不 reject 形态，spec §6 第 2 条） */
  grammarTableEmpty: boolean;
  /** force 无条件真（CDN 档位变更快照重建） */
  force?: boolean;
}

/**
 * failed-态门控谓词（纯函数）：force 无条件真；否则三个 failed 态任一为真。
 * 全 false = 健康 client + 显式动作 → 假（重建 no-op）。字段显式 `=== true` 归一
 * （缺省字段防御为 false，不透传 undefined 真值）。
 */
export function shouldRecreateHighlightClient(state: RecreateGateState): boolean {
  if (state.force === true) return true;
  return (
    state.creationFailed === true ||
    state.clientInitFailed === true ||
    state.grammarTableEmpty === true
  );
}

let impl: RecreateFn | null = null;

/** 注册重建实现（highlightClient.ts 模块加载时注册；重复注册后签者生效——防御面） */
export function registerRecreateHighlightClient(fn: RecreateFn): void {
  impl = fn;
}

/**
 * 显式动作面（非 force）：切渲染器/切语言写入成功后调用。经 failed-态门控判定（门
 * 在实现侧——本函数只透传），健康 client 时实现 no-op，即限流器语义；未注册 no-op
 * 不抛（SSR/测试环境缺省安全）。
 */
export function requestHighlightRecreate(): void {
  impl?.();
}
