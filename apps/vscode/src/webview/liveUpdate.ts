// liveUpdate.ts — 设置 / 主题变更的**实时生效**消费面（spec H T6）。
//
// 目标：**不要求重开文件**——宿主侧订阅 `workspace.onDidChangeConfiguration`（vviewer 作用域）
// 与 `window.onDidChangeActiveColorTheme`，重算后经消息面推给已开 webview；webview 侧
// 收到即重算影响面并**全量重渲当前文档**（重渲成本 > 增量，MVP 取全量重渲）。
//
// 影响面：
// - 设置变更 → 引擎档位（变了才重启 worker）+ 图表档位 + 外链图片档位（十一处缝捕获
//   装配期的设置 → 须重新装配）+ 重渲 + 可见反馈（提示条）。
// - 主题变更 → 动态令牌整体替换（`<style id="vv-tokens">`）+ mermaid 图就地重画
//   （markdown 实例面 applyTheme）+ 重渲。
import type { MessageKey, MessageParams } from '../i18n/core';
import type { HighlightEngineTier } from './highlight';
import type { NoticeLevel } from './shell';
import type { AssetUris, HostToWebview, ThemePayload, WebviewSettings } from '../host/protocol';

/** 实时生效的动作面（宿主/webview 侧注入，便于单测） */
export interface LiveUpdateDeps {
  /** 当前资产 URI（null = 未初始化） */
  assets: AssetUris | null;
  /** 当前主题（null = 未初始化） */
  theme: ThemePayload | null;
  /** 当前文档的 languageId（语言级覆盖提示用） */
  currentLanguageId?: string;
  /** 当前设置（主题变更路径重装装配层用——重装须带当前设置，非上次变更值） */
  currentSettings: () => WebviewSettings | null;
  /** 应用动态令牌（主题面：整体替换 `<style id="vv-tokens">`） */
  applyTheme: () => Promise<void>;
  /** mermaid 就地重画（markdown 实例面 applyTheme——鸭子探测，缺席即无动作） */
  applyMermaidTheme: () => void;
  /** 重新装配（十一处缝捕获装配期的设置 → 设置变更须重装缝） */
  reAssemble: (settings: WebviewSettings) => void;
  /** 引擎档位裁决 */
  engineTier: (settings: WebviewSettings) => HighlightEngineTier;
  /** 重启高亮运行时（引擎档位变化时） */
  restartHighlight: (settings: WebviewSettings) => Promise<void>;
  /** 全量重渲当前文档 */
  reRender: () => Promise<void>;
  /** 顶部提示条（可见反馈） */
  notice: (text: string, level: NoticeLevel) => void;
  /** 文案取值 */
  text: (key: MessageKey, params?: MessageParams) => string;
}

/**
 * 设置变更的实时生效消费面。
 *
 * @param deps 动作面
 * @param previous 变更前的设置（null = 未初始化）
 * @param message 宿主推送的设置消息
 * @returns 变更后的设置（调用方回填）
 */
export async function applySettingsChange(
  deps: LiveUpdateDeps,
  previous: WebviewSettings | null,
  message: Extract<HostToWebview, { kind: 'settings' }>
): Promise<WebviewSettings> {
  const next = message.settings;
  const previousTier = previous ? deps.engineTier(previous) : null;
  if (deps.assets && deps.theme) {
    // 引擎档位变了才重启 worker（否则每次设置变更都重拉 worker 源，浪费）
    if (deps.engineTier(next) !== previousTier) await deps.restartHighlight(next);
    deps.reAssemble(next);
  }
  await deps.reRender();
  // 可见反馈：设置已生效；语言级覆盖在生效时给出更具体的提示（RF 9 的可见面）
  deps.notice(
    message.languageOverride === true && deps.currentLanguageId
      ? deps.text('notice.settings.languageOverride', { lang: deps.currentLanguageId })
      : deps.text('notice.settings.applied'),
    'info'
  );
  return next;
}

/**
 * 主题变更的实时生效消费面：动态令牌整体替换 + **重装装配层** + mermaid 重画 + 重渲。
 *
 * 重装是必需环节（评审 important ⑥）：图表选项的 `mermaidTheme` 取**装配期**的
 * themeKind（assemble.ts 的 `cachedDiagramOptions` 冻结）——只做「applyMermaidTheme（旧
 * 实例）+ 全量重渲」的话，重渲用的是旧主题的 diagramOptions，净效果是把刚设成新主题
 * 的 mermaid 覆盖回旧主题（主题切换后图不跟随）。
 */
export async function applyThemeChange(deps: LiveUpdateDeps): Promise<void> {
  await deps.applyTheme();
  // 重装须带**当前**设置（主题变更不改设置，但重装面要完整设置才不丢其他缝的取值）
  const current = deps.currentSettings();
  if (current && deps.assets && deps.theme) deps.reAssemble(current);
  deps.applyMermaidTheme();
  await deps.reRender();
}
