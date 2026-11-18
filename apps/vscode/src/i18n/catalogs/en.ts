// en.ts — 扩展 i18n 目录（英文侧）。spec H T2。
//
// 键集与 zh-CN 逐键对齐（编译期由 `Record<keyof typeof zhCN, string>` 锁——键集不等即
// 编译报错；运行期另有 i18n.test.ts 的键集与占位符集合断言双锁）。
//
// 占位符纪律：与 zh-CN 侧同名同集合（{name} 双侧同名）。
import type { zhCN } from './zh-CN';

export type EnMessages = Record<keyof typeof zhCN, string>;

export const en: EnMessages = {
  // shell
  'shell.panel.tocTitle': 'Outline',
  'shell.panel.tocToggle': 'Outline panel',
  'shell.panel.tocEmpty': 'This document has no outline',
  'shell.panel.engineBadge': 'Highlight engine: {engine}',
  'shell.engine.workerFailed': 'Highlight engine unavailable, fell back to hljs ({reason})',
  'shell.engine.initTimeout': 'Highlight engine init timed out, fell back to hljs',
  'shell.engine.noGrammar': 'No local grammar for {lang}, fell back to hljs',

  // viewer
  'viewer.document.tooLarge': 'File exceeds {limit}; open it with the native VSCode editor instead',

  // notice
  'notice.export.saved': 'Exported to {path}',
  'notice.export.failed': 'Export failed: {reason}',
  'notice.export.cancelled': 'Export cancelled',
  'notice.settings.applied': 'Settings applied',
  'notice.settings.languageOverride': 'Language-specific settings for {lang} are in effect',
  'notice.file.missing': 'File not found: {path}',

  // errors
  'errors.render.failed': 'Rendering failed',
  'errors.link.openExternalFailed': 'Failed to open the external link',
  'errors.common.unknown': 'An unknown error occurred'
};
