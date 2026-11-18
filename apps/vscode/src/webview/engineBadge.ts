// engineBadge.ts — 当前高亮引擎态的可见指示（spec H T4）。
//
// 可见面 = **顶部提示条**（降级原因）+ **toc 面板头部徽标**（引擎态常驻）——
// **不设状态栏**（spec §4.2：不得引入状态栏）。
//
// 纪律：徽标上的引擎名（tree-sitter / hljs / plain）是**稳定标识符**而非展示文案
// （frontend-conventions §3.3：非显示串禁入目录）；降级**原因**的显示文案走 i18n
// 目录（`DEGRADATION_KEYS` 把稳定码映射到目录键），技术细节（原因原文/语言名）作为
// 运行时数据插值。
import { t, type MessageKey } from '../i18n/core';
import type { Shell } from './shell';
import type { DegradationCode, EngineState, HighlightEngineTier } from './highlight';

/** 降级码 → i18n 目录键 */
export const DEGRADATION_KEYS: Record<DegradationCode, MessageKey> = {
  'worker-failed': 'shell.engine.workerFailed',
  'init-timeout': 'shell.engine.initTimeout',
  'no-grammar': 'shell.engine.noGrammar'
};

/** 引擎徽标可见文本（稳定标识符） */
export function engineBadgeText(engine: HighlightEngineTier): string {
  return engine;
}

/** 降级提示条文案（未降级 → null＝不占提示条） */
export function engineNoticeText(state: EngineState): string | null {
  if (!state.degraded || !state.code) return null;
  const key = DEGRADATION_KEYS[state.code];
  if (state.code === 'no-grammar') {
    return t(key, { lang: state.detail ?? '' });
  }
  return t(key, { reason: state.detail ?? '' });
}

/**
 * 应用引擎态到壳：徽标常驻引擎名；降级时顶部提示条给出原因（RF 3：可见，不静默）。
 */
export function applyEngineState(shell: Shell, state: EngineState): void {
  shell.setEngineBadge(engineBadgeText(state.engine));
  const notice = engineNoticeText(state);
  if (notice) shell.setNotice(notice, 'warn');
}
