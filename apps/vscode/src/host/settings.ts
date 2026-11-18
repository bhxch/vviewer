// settings.ts — 设置读取与归一（spec H T2）。
//
// 纯 .ts 模块：**零 `vscode` import**——`vscode` API 以结构类型注入，便于单测直测
// （沿 apps/web 注入缝「消费方注入、实现零框架依赖」的同款纪律）。
//
// per-language 覆盖（RF 9）：`workspace.getConfiguration('vviewer', { languageId })` 读取即
// 天然支持 VSCode 原生 per-language 覆盖——**前提是设置项声明的 scope 为
// `language-overridable`**（T6 落 contributes.configuration 时必须满足；否则 VSCode
// 静默忽略 `"[markdown]": {…}` 覆盖）。本模块负责把取回的（可能脏的）值归一为
// `WebviewSettings`。
//
// 归一纪律（计划 T2）：枚举脏值回落缺省；白名单条目 trim + 去空 + 小写。
import { DEFAULT_WEBVIEW_SETTINGS, type WebviewSettings } from './protocol';

/** 设置项键（相对 `vviewer` 命名空间） */
export const SETTING_KEYS = {
  tocSide: 'toc.side',
  tocDefaultCollapsed: 'toc.defaultCollapsed',
  highlightEngine: 'code.highlightEngine',
  diagramMode: 'markdown.diagramMode',
  allowRemoteServices: 'diagrams.allowRemoteServices',
  externalImages: 'markdown.externalImages',
  externalImageAllowlist: 'markdown.externalImageAllowlist'
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/** toc 停靠侧枚举 */
export const TOC_SIDES = ['left', 'right'] as const;
/** 高亮引擎枚举 */
export const HIGHLIGHT_ENGINES = ['tree-sitter', 'hljs', 'plain'] as const;
/** 图表模式枚举（'off' = 落源码块——`DiagramMode` 包内无 'off'，映射在 T5 的 diagramGate） */
export const DIAGRAM_MODES = ['local', 'kroki', 'off'] as const;
/** 外链图片策略枚举（对齐 packages/vviewer-sanitize 的 EXTERNAL_IMAGE_POLICIES） */
export const EXTERNAL_IMAGE_POLICIES = ['blocked', 'manual', 'auto'] as const;

/** vscode.Configuration 的最小结构面（注入用） */
export interface ConfigurationLike {
  get<T>(section: string): T | undefined;
  /** 语言维度取值（inspect）——语言级覆盖检测用；缺省 = 不可判定（按「无覆盖」处理） */
  inspect?(
    section: string
  ):
    | {
        languageIds?: string[];
        defaultLanguageValue?: unknown;
        globalLanguageValue?: unknown;
        workspaceLanguageValue?: unknown;
        workspaceFolderLanguageValue?: unknown;
      }
    | undefined;
}

/** vscode.ConfigurationScope 的最小结构面（`languageId` 必填——对齐 vscode 真实签名） */
export interface ConfigurationScopeLike {
  languageId: string;
}

/** vscode.workspace 的最小结构面（注入用） */
export interface WorkspaceLike {
  getConfiguration(section?: string, scope?: ConfigurationScopeLike | null): ConfigurationLike;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** toc 停靠侧归一（非 left/right → 'right'） */
export function normalizeTocSide(value: unknown): WebviewSettings['tocSide'] {
  return oneOf(value, TOC_SIDES, DEFAULT_WEBVIEW_SETTINGS.tocSide);
}

/** 高亮引擎归一（非三值 → 'tree-sitter'） */
export function normalizeHighlightEngine(value: unknown): WebviewSettings['highlightEngine'] {
  return oneOf(value, HIGHLIGHT_ENGINES, DEFAULT_WEBVIEW_SETTINGS.highlightEngine);
}

/** 图表模式归一（非三值 → 'local'） */
export function normalizeDiagramMode(value: unknown): WebviewSettings['diagramMode'] {
  return oneOf(value, DIAGRAM_MODES, DEFAULT_WEBVIEW_SETTINGS.diagramMode);
}

/** 外链图片策略归一（非三值 → 'blocked'） */
export function normalizeExternalImages(value: unknown): WebviewSettings['externalImages'] {
  return oneOf(value, EXTERNAL_IMAGE_POLICIES, DEFAULT_WEBVIEW_SETTINGS.externalImages);
}

/** 布尔归一（非布尔 → 缺省） */
export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 白名单归一：trim + 去空 + 小写（去重后保序） */
export function normalizeAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_WEBVIEW_SETTINGS.externalImageAllowlist];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim().toLowerCase();
    if (trimmed === '' || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

/** 原始设置值形态（键 → 未知值） */
export type RawSettings = Partial<Record<SettingKey, unknown>>;

/** 归一为 `WebviewSettings`（脏值回落缺省） */
export function normalizeSettings(raw: RawSettings): WebviewSettings {
  return {
    tocSide: normalizeTocSide(raw[SETTING_KEYS.tocSide]),
    tocDefaultCollapsed: normalizeBoolean(
      raw[SETTING_KEYS.tocDefaultCollapsed],
      DEFAULT_WEBVIEW_SETTINGS.tocDefaultCollapsed
    ),
    highlightEngine: normalizeHighlightEngine(raw[SETTING_KEYS.highlightEngine]),
    diagramMode: normalizeDiagramMode(raw[SETTING_KEYS.diagramMode]),
    allowRemoteServices: normalizeBoolean(
      raw[SETTING_KEYS.allowRemoteServices],
      DEFAULT_WEBVIEW_SETTINGS.allowRemoteServices
    ),
    externalImages: normalizeExternalImages(raw[SETTING_KEYS.externalImages]),
    externalImageAllowlist: normalizeAllowlist(raw[SETTING_KEYS.externalImageAllowlist])
  };
}

/**
 * 该语言的**语言级覆盖**是否在生效。
 *
 * VSCode 原生机制：`"[markdown]": { "vviewer.code.highlightEngine": … }` 这类语言级
 * 覆盖**仅在设置项 scope 声明为 `language-overridable`（或 resource）时生效**——否则
 * VSCode 静默忽略（RF 9 的真前提）。本函数读 `inspect()` 的语言维度字段
 * （`languageIds` 与 `*LanguageValue`）判定覆盖是否在生效，供可见面提示。
 *
 * `inspect` 缺席或形态未知 → 按「无覆盖」处理（退化不崩）。
 */
export function hasLanguageOverride(
  configuration: ConfigurationLike,
  key: string,
  languageId: string | undefined
): boolean {
  if (!languageId || typeof configuration.inspect !== 'function') return false;
  const inspected = configuration.inspect(key);
  if (!inspected) return false;
  if (inspected.languageIds?.includes(languageId)) return true;
  return (
    inspected.defaultLanguageValue !== undefined ||
    inspected.globalLanguageValue !== undefined ||
    inspected.workspaceLanguageValue !== undefined ||
    inspected.workspaceFolderLanguageValue !== undefined
  );
}

/**
 * 读取设置（per-language）。
 *
 * @param workspace vscode.workspace 的结构面（注入）
 * @param languageId 当前文档的 languageId（undefined = 无语言级覆盖）
 */
export function readWebviewSettings(
  workspace: WorkspaceLike,
  languageId?: string
): WebviewSettings {
  // languageId 传入 scope → VSCode 原生 per-language 覆盖生效（RF 9 的前提是设置项
  // 声明 scope=language-overridable，T6 落 contributes.configuration 时保证）
  const scope: ConfigurationScopeLike | undefined = languageId ? { languageId } : undefined;
  const configuration = workspace.getConfiguration('vviewer', scope);
  return normalizeSettings({
    [SETTING_KEYS.tocSide]: configuration.get(SETTING_KEYS.tocSide),
    [SETTING_KEYS.tocDefaultCollapsed]: configuration.get(SETTING_KEYS.tocDefaultCollapsed),
    [SETTING_KEYS.highlightEngine]: configuration.get(SETTING_KEYS.highlightEngine),
    [SETTING_KEYS.diagramMode]: configuration.get(SETTING_KEYS.diagramMode),
    [SETTING_KEYS.allowRemoteServices]: configuration.get(SETTING_KEYS.allowRemoteServices),
    [SETTING_KEYS.externalImages]: configuration.get(SETTING_KEYS.externalImages),
    [SETTING_KEYS.externalImageAllowlist]: configuration.get(SETTING_KEYS.externalImageAllowlist)
  });
}
