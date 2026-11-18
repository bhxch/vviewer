// liveUpdate.test.ts — 设置 / 主题变更的实时生效契约（spec H T6）。
//
// 覆盖面（计划 T6 Step 1/2）：
// - 宿主侧订阅 → 推送路径（配置变更推 settings、主题变更推 theme；非 vviewer 作用域的配置
//   变更不推）
// - webview 侧消费面（设置变更 → 重装缝 + 重渲 + 可见反馈；主题变更 → 动态令牌替换 +
//   mermaid 重画 + 重渲）
// - 语言级覆盖检测（`inspect()` 的语言维度；RF 9 的可见面前提）
import { describe, expect, it, vi } from 'vitest';
import {
  applySettingsChange,
  applyThemeChange,
  type LiveUpdateDeps
} from '../src/webview/liveUpdate';
import { hasLanguageOverride, type ConfigurationLike } from '../src/host/settings';
import { DEFAULT_WEBVIEW_SETTINGS, type AssetUris, type WebviewSettings } from '../src/host/protocol';

const ASSETS: AssetUris = {
  grammarsBase: 'https://webview/assets/grammars/',
  queriesBase: 'https://webview/assets/queries/',
  runtimeDir: 'https://webview/assets/',
  grammars: {},
  binaryWorkerUrl: 'https://webview/binary-worker.js',
  pdfWorkerModernUrl: 'https://webview/pdf/pdf.worker.min.mjs',
  pdfWorkerLegacyUrl: 'https://webview/pdf/pdf.worker.legacy.min.mjs',
  fontsBase: 'https://webview/fonts/',
  katexCssUrl: 'https://webview/katex.min.css',
  katexExportCssUrl: 'https://webview/katex.export.css',
  themesUrl: 'https://webview/assets/themes.json',
  highlightWorkerSourceUrl: 'https://webview/highlight-worker.js'
};

function makeDeps(overrides: Partial<LiveUpdateDeps> = {}): LiveUpdateDeps & {
  applyTheme: ReturnType<typeof vi.fn>;
  applyMermaidTheme: ReturnType<typeof vi.fn>;
  reAssemble: ReturnType<typeof vi.fn>;
  restartHighlight: ReturnType<typeof vi.fn>;
  reRender: ReturnType<typeof vi.fn>;
  notice: ReturnType<typeof vi.fn>;
} {
  return {
    assets: ASSETS,
    theme: { kind: 'light', cssVars: {} },
    currentLanguageId: 'markdown',
    applyTheme: vi.fn(async () => undefined),
    applyMermaidTheme: vi.fn(),
    reAssemble: vi.fn(),
    engineTier: (settings: WebviewSettings) => settings.highlightEngine,
    restartHighlight: vi.fn(async () => undefined),
    reRender: vi.fn(async () => undefined),
    notice: vi.fn(),
    text: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
    ...overrides
  } as LiveUpdateDeps & {
    applyTheme: ReturnType<typeof vi.fn>;
    applyMermaidTheme: ReturnType<typeof vi.fn>;
    reAssemble: ReturnType<typeof vi.fn>;
    restartHighlight: ReturnType<typeof vi.fn>;
    reRender: ReturnType<typeof vi.fn>;
    notice: ReturnType<typeof vi.fn>;
  };
}

describe('实时生效 · webview 消费面（设置变更）', () => {
  it('重装缝 + 全量重渲 + 可见反馈（不要求重开文件）', async () => {
    const deps = makeDeps();
    const next: WebviewSettings = { ...DEFAULT_WEBVIEW_SETTINGS, highlightEngine: 'hljs' };
    const returned = await applySettingsChange(deps, DEFAULT_WEBVIEW_SETTINGS, {
      kind: 'settings',
      settings: next
    });
    expect(returned).toBe(next);
    expect(deps.reAssemble).toHaveBeenCalledWith(next);
    expect(deps.reRender).toHaveBeenCalledTimes(1);
    expect(deps.notice).toHaveBeenCalledTimes(1);
  });

  it('引擎档位变化 → 重启高亮运行时（否则档位不生效）', async () => {
    const deps = makeDeps();
    await applySettingsChange(deps, DEFAULT_WEBVIEW_SETTINGS, {
      kind: 'settings',
      settings: { ...DEFAULT_WEBVIEW_SETTINGS, highlightEngine: 'plain' }
    });
    expect(deps.restartHighlight).toHaveBeenCalledTimes(1);
  });

  it('引擎档位未变 → 不重启 worker（避免每次设置变更都重拉 worker 源）', async () => {
    const deps = makeDeps();
    await applySettingsChange(deps, DEFAULT_WEBVIEW_SETTINGS, {
      kind: 'settings',
      settings: { ...DEFAULT_WEBVIEW_SETTINGS, tocSide: 'left' }
    });
    expect(deps.restartHighlight).not.toHaveBeenCalled();
    expect(deps.reAssemble).toHaveBeenCalled();
  });

  it('语言级覆盖在生效 → 提示条给出语言专属提示（RF 9 的可见面）', async () => {
    const deps = makeDeps();
    await applySettingsChange(deps, DEFAULT_WEBVIEW_SETTINGS, {
      kind: 'settings',
      settings: DEFAULT_WEBVIEW_SETTINGS,
      languageOverride: true
    });
    const [text] = deps.notice.mock.calls[0] as [string, string];
    expect(text).toContain('markdown');
    expect(text).toContain('notice.settings.languageOverride');
  });

  it('无语言级覆盖 → 通用「设置已应用」提示', async () => {
    const deps = makeDeps();
    await applySettingsChange(deps, DEFAULT_WEBVIEW_SETTINGS, {
      kind: 'settings',
      settings: DEFAULT_WEBVIEW_SETTINGS,
      languageOverride: false
    });
    const [text] = deps.notice.mock.calls[0] as [string, string];
    expect(text).toContain('notice.settings.applied');
  });
});

describe('实时生效 · webview 消费面（主题变更）', () => {
  it('动态令牌替换 + mermaid 重画 + 重渲', async () => {
    const deps = makeDeps();
    await applyThemeChange(deps);
    expect(deps.applyTheme).toHaveBeenCalledTimes(1);
    expect(deps.applyMermaidTheme).toHaveBeenCalledTimes(1);
    expect(deps.reRender).toHaveBeenCalledTimes(1);
  });
});

describe('实时生效 · 语言级覆盖检测（inspect 的语言维度）', () => {
  const withLanguageIds: ConfigurationLike = {
    get: () => undefined,
    inspect: () => ({ languageIds: ['markdown', 'python'] })
  };
  const withLanguageValue: ConfigurationLike = {
    get: () => undefined,
    inspect: () => ({ globalLanguageValue: 'hljs' })
  };
  const withoutLanguage: ConfigurationLike = {
    get: () => undefined,
    inspect: () => ({ languageIds: ['rust'] })
  };
  const noInspect: ConfigurationLike = { get: () => undefined };

  it('languageIds 命中该语言 → 覆盖在生效', () => {
    expect(hasLanguageOverride(withLanguageIds, 'code.highlightEngine', 'markdown')).toBe(true);
  });

  it('语言维度取值在场 → 覆盖在生效', () => {
    expect(hasLanguageOverride(withLanguageValue, 'code.highlightEngine', 'markdown')).toBe(true);
  });

  it('该语言无覆盖 → false', () => {
    expect(hasLanguageOverride(withoutLanguage, 'code.highlightEngine', 'markdown')).toBe(false);
  });

  it('inspect 缺席 / 无 languageId → false（退化不崩）', () => {
    expect(hasLanguageOverride(noInspect, 'code.highlightEngine', 'markdown')).toBe(false);
    expect(hasLanguageOverride(withLanguageIds, 'code.highlightEngine', undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 宿主侧推送路径（PanelHost：订阅 → 推送 → webview 收到）
// ---------------------------------------------------------------------------

interface FakeUri {
  path: string;
  fsPath: string;
  toString(): string;
}

function fakeUri(path: string): FakeUri {
  return { path, fsPath: path, toString: () => `file://${path}` };
}

interface FakeRuntime {
  vscode: unknown;
  posted: unknown[];
  commands: Array<{ command: string; args: unknown[] }>;
  fireConfigChange(section: string): void;
  fireThemeChange(): void;
  setConfigValue(key: string, value: unknown): void;
}

/** 假 workspaceState（折叠态持久化面——spec §4.2「折叠态记忆 workspaceState」） */
function makeFakeWorkspaceState(): {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
  store: Record<string, unknown>;
} {
  const store: Record<string, unknown> = {};
  return {
    store,
    get<T>(key: string): T | undefined {
      return store[key] as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      store[key] = value;
    }
  };
}

/** 假 panel（捕获 dispose / 消息回调，供面板生命周期用例驱动） */
interface FakePanel {
  title: string;
  active: boolean;
  revealCount: number;
  disposed: boolean;
  webview: {
    options: unknown;
    html: string;
    cspSource: string;
    asWebviewUri(uri: { path: string }): { toString(): string };
    onDidReceiveMessage(cb: (message: unknown) => void): { dispose(): void };
    postMessage(message: unknown): Promise<void>;
  };
  onDidDispose(cb: () => void): { dispose(): void };
  onDidChangeViewState(cb: () => void): { dispose(): void };
  reveal(): void;
  dispose(): void;
  /** 触发 dispose 回调（模拟用户关闭面板） */
  fireDispose(): void;
  /** 触发宿主消息回调（模拟 webview → host 消息） */
  fireMessage(message: unknown): void;
}

function makeFakePanel(posted: unknown[]): FakePanel {
  let disposeCb: (() => void) | null = null;
  let messageCb: ((message: unknown) => void) | null = null;
  const panel: FakePanel = {
    title: 'a.md',
    active: true,
    revealCount: 0,
    disposed: false,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview://x',
      asWebviewUri: (uri) => ({ toString: () => `https://webview${uri.path}` }),
      onDidReceiveMessage(cb) {
        messageCb = cb;
        return { dispose: () => undefined };
      },
      async postMessage(message: unknown) {
        posted.push(message);
      }
    },
    onDidDispose(cb) {
      disposeCb = cb;
      return { dispose: () => undefined };
    },
    onDidChangeViewState() {
      return { dispose: () => undefined };
    },
    reveal() {
      panel.revealCount++;
    },
    dispose() {
      panel.disposed = true;
    },
    fireDispose() {
      panel.disposed = true;
      disposeCb?.();
    },
    fireMessage(message: unknown) {
      messageCb?.(message);
    }
  };
  return panel;
}

/** 构造注入假 vscode 运行时的 PanelHost（订阅与推送路径可实跑） */
function makeFakeHost(): FakeRuntime {
  const posted: unknown[] = [];
  const configListeners: Array<(event: { affectsConfiguration(section: string): boolean }) => void> = [];
  const themeListeners: Array<() => void> = [];
  const configValues: Record<string, unknown> = {};
  const commands: Array<{ command: string; args: unknown[] }> = [];

  const configuration = (): ConfigurationLike => ({
    get: (key: string) => configValues[key] as never,
    inspect: () => undefined
  });

  const vscode = {
    workspace: {
      getConfiguration: () => configuration(),
      textDocuments: [],
      openTextDocument: async () => ({ languageId: 'markdown' }),
      fs: {
        stat: async () => ({ size: 12 }),
        readFile: async () => new TextEncoder().encode(JSON.stringify({ grammars: {} }))
      },
      onDidChangeConfiguration: (cb: (event: { affectsConfiguration(section: string): boolean }) => void) => {
        configListeners.push(cb);
        return { dispose: () => undefined };
      }
    },
    window: {
      activeColorTheme: { kind: 1 },
      onDidChangeActiveColorTheme: (cb: () => void) => {
        themeListeners.push(cb);
        return { dispose: () => undefined };
      },
      showErrorMessage: async () => undefined,
      showInformationMessage: async () => undefined
    },
    ColorThemeKind: { Light: 1, Dark: 2 },
    Uri: {
      joinPath: (base: FakeUri, ...segments: string[]) =>
        fakeUri([base.path.replace(/\/+$/, ''), ...segments].join('/')),
      parse: (value: string) => fakeUri(value.replace(/^file:\/\//, ''))
    },
    commands: {
      executeCommand: async (command: string, ...args: unknown[]) => {
        commands.push({ command, args });
        return undefined;
      }
    },
    env: { language: 'en' }
  };

  return {
    vscode,
    posted,
    commands,
    fireConfigChange: (changed: string) => {
      // VSCode 语义：变更 'vviewer.toc.defaultCollapsed' 时，
      // affectsConfiguration('vviewer') 亦为真（变更节是查询节的前缀）
      for (const cb of configListeners) {
        cb({
          affectsConfiguration: (queried: string) =>
            changed === queried || changed.startsWith(`${queried}.`)
        });
      }
    },
    fireThemeChange: () => {
      for (const cb of themeListeners) cb();
    },
    setConfigValue: (key: string, value: unknown) => {
      configValues[key] = value;
    }
  };
}

describe('实时生效 · 宿主侧推送路径', () => {
  it('配置变更 → 推 settings 给已开 webview（非 vviewer 作用域不推）', async () => {
    const fake = makeFakeHost();
    const { PanelHost } = await import('../src/host/webviewPanel');
    const host = new PanelHost(
      fake.vscode as never,
      {
        extensionUri: fakeUri('/ext'),
        workspaceState: makeFakeWorkspaceState()
      } as never
    );
    host.watchChanges();

    const panel = makeFakePanel(fake.posted);
    await host.attach({ uri: fakeUri('/x/a.md') } as never, panel as never);

    const before = fake.posted.length;
    fake.fireConfigChange('editor.fontSize');
    await Promise.resolve();
    expect(fake.posted.length).toBe(before); // 非 vviewer 作用域 → 不推

    fake.fireConfigChange('vviewer');
    await new Promise((r) => setTimeout(r, 0));
    const settings = fake.posted.filter(
      (m): m is { kind: string; settings: WebviewSettings } =>
        typeof m === 'object' && m !== null && (m as { kind?: string }).kind === 'settings'
    );
    expect(settings).toHaveLength(1);
    expect(settings[0]!.settings.tocSide).toBe('right');
  });

  it('主题变更 → 推 theme 给已开 webview', async () => {
    const fake = makeFakeHost();
    const { PanelHost } = await import('../src/host/webviewPanel');
    const host = new PanelHost(
      fake.vscode as never,
      { extensionUri: fakeUri('/ext'), workspaceState: makeFakeWorkspaceState() } as never
    );
    host.watchChanges();

    const panel = makeFakePanel(fake.posted);
    await host.attach({ uri: fakeUri('/x/a.md') } as never, panel as never);

    fake.fireThemeChange();
    await new Promise((r) => setTimeout(r, 0));
    const themes = fake.posted.filter(
      (m): m is { kind: string; theme: { kind: string } } =>
        typeof m === 'object' && m !== null && (m as { kind?: string }).kind === 'theme'
    );
    expect(themes).toHaveLength(1);
    expect(themes[0]!.theme.kind).toBe('light');
  });
});

describe('实时生效 · 面板生命周期（评审 critical ③ / minor ⑥ / important ②）', () => {
  it('面板关闭后再打开同文档 → 用新面板（旧的已 dispose，不得 reveal 它）', async () => {
    const fake = makeFakeHost();
    const { PanelHost } = await import('../src/host/webviewPanel');
    const host = new PanelHost(
      fake.vscode as never,
      { extensionUri: fakeUri('/ext'), workspaceState: makeFakeWorkspaceState() } as never
    );
    const old = makeFakePanel(fake.posted);
    await host.attach({ uri: fakeUri('/x/a.md') } as never, old as never);
    old.fireDispose();
    const fresh = makeFakePanel(fake.posted);
    await host.attach({ uri: fakeUri('/x/a.md') } as never, fresh as never);
    expect(old.revealCount).toBe(0);
    expect(fresh.webview.html).not.toBe('');
  });

  it('相对链接导航 → 宿主发 vscode.open 打开目标（不就地改写当前面板 → 无文档绑定漂移）', async () => {
    const fake = makeFakeHost();
    const { PanelHost } = await import('../src/host/webviewPanel');
    const host = new PanelHost(
      fake.vscode as never,
      { extensionUri: fakeUri('/ext'), workspaceState: makeFakeWorkspaceState() } as never
    );
    const panel = makeFakePanel(fake.posted);
    await host.attach({ uri: fakeUri('/x/a.md') } as never, panel as never);
    panel.fireMessage({ kind: 'navigate', path: 'b.md' });
    await new Promise((r) => setTimeout(r, 0));
    const open = fake.commands.find((c) => c.command === 'vscode.open');
    expect(open, '未发出 vscode.open').toBeTruthy();
    expect((open!.args[0] as { path: string }).path).toContain('b.md');
  });

  it('评审场景链：导航到 b.md 后再从资源管理器打开 b.md → 新面板拿到 HTML（无白屏）', async () => {
    const fake = makeFakeHost();
    const { PanelHost } = await import('../src/host/webviewPanel');
    const host = new PanelHost(
      fake.vscode as never,
      { extensionUri: fakeUri('/ext'), workspaceState: makeFakeWorkspaceState() } as never
    );
    const first = makeFakePanel(fake.posted);
    await host.attach({ uri: fakeUri('/x/a.md') } as never, first as never);
    // 导航（相对链接）→ 宿主发 vscode.open 打开 b.md
    first.fireMessage({ kind: 'navigate', path: 'b.md' });
    await new Promise((r) => setTimeout(r, 0));
    // VSCode 随后为 b.md 新建 editor → attach(b.md, 新面板)
    const second = makeFakePanel(fake.posted);
    await host.attach({ uri: fakeUri('/x/b.md') } as never, second as never);
    expect(second.webview.html).not.toBe('');
    expect(second.webview.options).toBeTruthy();
  });

  it('面板仍存活时 attach 新面板 → 新面板必须拿到 HTML（不得白屏且无提示）', async () => {
    const fake = makeFakeHost();
    const { PanelHost } = await import('../src/host/webviewPanel');
    const host = new PanelHost(
      fake.vscode as never,
      { extensionUri: fakeUri('/ext'), workspaceState: makeFakeWorkspaceState() } as never
    );
    const first = makeFakePanel(fake.posted);
    await host.attach({ uri: fakeUri('/x/a.md') } as never, first as never);
    // 同一文档的**新**面板（VSCode 新建 editor）→ 既有面板仍活着
    const second = makeFakePanel(fake.posted);
    await host.attach({ uri: fakeUri('/x/a.md') } as never, second as never);
    expect(second.webview.html).not.toBe('');
    expect(second.webview.options).toBeTruthy();
  });

  it('init 消息带 toc 折叠态（workspaceState 持久值优先，缺省回落设置缺省）', async () => {
    const fake = makeFakeHost();
    const { PanelHost } = await import('../src/host/webviewPanel');
    const state = makeFakeWorkspaceState();
    const host = new PanelHost(
      fake.vscode as never,
      { extensionUri: fakeUri('/ext'), workspaceState: state } as never
    );
    const panel = makeFakePanel(fake.posted);
    host.watchChanges();
    await host.attach({ uri: fakeUri('/x/a.md') } as never, panel as never);
    const init = fake.posted.find(
      (m): m is { kind: string; toc: { collapsed: boolean } } =>
        typeof m === 'object' && m !== null && (m as { kind?: string }).kind === 'init'
    );
    expect(init?.toc.collapsed).toBe(true); // 设置缺省（defaultCollapsed=true）

    // webview 上报折叠态 → 宿主持久化 → 下次 init 用持久值
    panel.fireMessage({ kind: 'toc-collapsed', collapsed: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(state.store['vviewer.toc.collapsed']).toBe(false);

    // 「默认折叠态」设置变更 → 清持久化覆盖（否则该设置永久失效——评审 minor ②）
    fake.fireConfigChange('vviewer.toc.defaultCollapsed');
    await new Promise((r) => setTimeout(r, 0));
    expect(state.store['vviewer.toc.collapsed']).toBeUndefined();
  });
});
