// settings.test.ts — 设置读取与归一契约（spec H T2）。
//
// 覆盖面（计划 T2 Step 1 明列）：`getConfiguration('vviewer', {languageId })` 桩 →
// 语言级覆盖 > 窗口级 > 缺省（RF 9）；脏值归一。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEBVIEW_SETTINGS,
  type WebviewSettings
} from '../src/host/protocol';
import {
  DIAGRAM_MODES,
  EXTERNAL_IMAGE_POLICIES,
  HIGHLIGHT_ENGINES,
  SETTING_KEYS,
  TOC_SIDES,
  normalizeAllowlist,
  normalizeBoolean,
  normalizeDiagramMode,
  normalizeExternalImages,
  normalizeHighlightEngine,
  normalizeSettings,
  normalizeTocSide,
  readWebviewSettings,
  type ConfigurationLike,
  type WorkspaceLike
} from '../src/host/settings';

/** 构造一层配置面：语言级 > 窗口级 > 缺省（模拟 VSCode 原生 per-language 解析） */
function makeWorkspace(options: {
  window?: Record<string, unknown>;
  byLanguage?: Record<string, Record<string, unknown>>;
  scopes: unknown[];
}): WorkspaceLike {
  return {
    getConfiguration(
      section?: string,
      scope?: { languageId: string } | null
    ): ConfigurationLike {
      options.scopes.push({ section, scope });
      const languageId = scope?.languageId;
      const languageValues = languageId ? options.byLanguage?.[languageId] : undefined;
      return {
        get<T>(key: string): T | undefined {
          const fromLanguage = languageValues?.[key];
          if (fromLanguage !== undefined) return fromLanguage as T;
          const fromWindow = options.window?.[key];
          return fromWindow as T | undefined;
        }
      };
    }
  };
}

describe('设置 · per-language 覆盖（RF 9）', () => {
  it('语言级覆盖 > 窗口级 > 缺省', () => {
    const scopes: unknown[] = [];
    const workspace = makeWorkspace({
      scopes,
      window: { [SETTING_KEYS.highlightEngine]: 'hljs', [SETTING_KEYS.tocSide]: 'left' },
      byLanguage: { markdown: { [SETTING_KEYS.highlightEngine]: 'plain' } }
    });
    const settings = readWebviewSettings(workspace, 'markdown');
    expect(settings.highlightEngine).toBe('plain');
    expect(settings.tocSide).toBe('left');
  });

  it('无语言级覆盖时回落窗口级', () => {
    const workspace = makeWorkspace({
      scopes: [],
      window: { [SETTING_KEYS.highlightEngine]: 'hljs' },
      byLanguage: { markdown: { [SETTING_KEYS.highlightEngine]: 'plain' } }
    });
    expect(readWebviewSettings(workspace, 'python').highlightEngine).toBe('hljs');
  });

  it('全缺省时回落缺省值', () => {
    const workspace = makeWorkspace({ scopes: [], window: {}, byLanguage: {} });
    expect(readWebviewSettings(workspace, 'python')).toEqual(DEFAULT_WEBVIEW_SETTINGS);
  });

  it('**把 languageId 传进 scope**——per-language 覆盖的生效前提', () => {
    const scopes: unknown[] = [];
    const workspace = makeWorkspace({ scopes, window: {}, byLanguage: {} });
    readWebviewSettings(workspace, 'markdown');
    expect(scopes).toEqual([{ section: 'vviewer', scope: { languageId: 'markdown' } }]);
  });

  it('无 languageId 时不传 scope（窗口级读取）', () => {
    const scopes: unknown[] = [];
    const workspace = makeWorkspace({ scopes, window: {}, byLanguage: {} });
    readWebviewSettings(workspace);
    expect(scopes).toEqual([{ section: 'vviewer', scope: undefined }]);
  });
});

describe('设置 · 脏值归一', () => {
  it('枚举脏值回落缺省', () => {
    expect(normalizeTocSide('middle')).toBe('right');
    expect(normalizeTocSide(undefined)).toBe('right');
    expect(normalizeTocSide('left')).toBe('left');
    expect(normalizeHighlightEngine('vim')).toBe('tree-sitter');
    expect(normalizeHighlightEngine('hljs')).toBe('hljs');
    expect(normalizeDiagramMode('server')).toBe('local');
    expect(normalizeDiagramMode('kroki')).toBe('kroki');
    expect(normalizeExternalImages('allow')).toBe('blocked');
    expect(normalizeExternalImages('auto')).toBe('auto');
  });

  it('布尔脏值回落缺省（非布尔不当作 false）', () => {
    expect(normalizeBoolean(undefined, true)).toBe(true);
    expect(normalizeBoolean('false', true)).toBe(true);
    expect(normalizeBoolean(false, true)).toBe(false);
  });

  it('白名单：trim + 去空 + 小写 + 去重（保序）', () => {
    expect(normalizeAllowlist(['  HTTPS://A.com ', '', 'b.com', 'https://a.com'])).toEqual([
      'https://a.com',
      'b.com'
    ]);
    expect(normalizeAllowlist('not-an-array')).toEqual([]);
    expect(normalizeAllowlist([42, null, 'ok.com'])).toEqual(['ok.com']);
  });

  it('整体归一：脏值面全部回落', () => {
    const settings: WebviewSettings = normalizeSettings({
      [SETTING_KEYS.tocSide]: 'nope',
      [SETTING_KEYS.tocDefaultCollapsed]: 'yes',
      [SETTING_KEYS.highlightEngine]: 42,
      [SETTING_KEYS.diagramMode]: 'official',
      [SETTING_KEYS.allowRemoteServices]: 'true',
      [SETTING_KEYS.externalImages]: 'permissive',
      [SETTING_KEYS.externalImageAllowlist]: [' A.com ']
    });
    expect(settings).toEqual({
      tocSide: 'right',
      tocDefaultCollapsed: true,
      highlightEngine: 'tree-sitter',
      diagramMode: 'local',
      allowRemoteServices: false,
      externalImages: 'blocked',
      externalImageAllowlist: ['a.com']
    });
  });
});

describe('设置 · 枚举面（与声明面一致）', () => {
  it('枚举集合与计划一致', () => {
    expect([...TOC_SIDES]).toEqual(['left', 'right']);
    expect([...HIGHLIGHT_ENGINES]).toEqual(['tree-sitter', 'hljs', 'plain']);
    expect([...DIAGRAM_MODES]).toEqual(['local', 'kroki', 'off']);
    // 对齐 packages/vviewer-sanitize 的 EXTERNAL_IMAGE_POLICIES
    expect([...EXTERNAL_IMAGE_POLICIES]).toEqual(['blocked', 'manual', 'auto']);
  });

  it('设置键与 contributes.configuration 的键一致（T6 声明面）', () => {
    expect(Object.values(SETTING_KEYS)).toEqual([
      'toc.side',
      'toc.defaultCollapsed',
      'code.highlightEngine',
      'markdown.diagramMode',
      'diagrams.allowRemoteServices',
      'markdown.externalImages',
      'markdown.externalImageAllowlist'
    ]);
  });
});
