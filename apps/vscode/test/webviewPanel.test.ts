// webviewPanel.test.ts — panel 选项与资产 URI 映射契约（spec H T2）。
//
// 覆盖面（计划 T2 验收锚）：**`enableScripts: true` + `localResourceRoots` 含 dist**
// （评审订正④的回归锚）+ 资产 URI 三段自洽（RF 5）+ 主题令牌缺省。
//
// 本模块 vscode 只做 type-only import（运行时零 vscode 依赖）→ 可直测。
import { describe, expect, it } from 'vitest';
import {
  buildAssetUris,
  buildProviderWebviewOptions,
  buildWebviewOptions,
  createNonce,
  documentName,
  resolveAssetRoot,
  themeCssVars
} from '../src/host/webviewPanel';

/** 假 URI（结构面够用即可） */
interface FakeUri {
  path: string;
  fsPath: string;
  toString(): string;
}

function fakeUri(path: string): FakeUri {
  return { path, fsPath: path, toString: () => `file://${path}` };
}

/** 假 `vscode.Uri.joinPath` */
function fakeJoinPath(base: FakeUri, ...segments: string[]): FakeUri {
  const parts = [base.path.replace(/\/+$/, ''), ...segments.map((s) => s.replace(/^\/+/, ''))];
  return fakeUri(parts.join('/'));
}

/** 假 webview（asWebviewUri → 绝对 URL） */
const fakeWebview = {
  asWebviewUri(uri: FakeUri) {
    return { toString: () => `https://webview.internal${uri.path}` };
  }
} as never;

const EXTENSION_URI = fakeUri('/ext');

describe('panel 选项 · webview 必需选项（评审订正④）', () => {
  it('enableScripts 为 true（不开则 webview 内脚本不执行 → 白屏）', () => {
    const options = buildWebviewOptions(EXTENSION_URI as never);
    expect(options.enableScripts).toBe(true);
  });

  it('localResourceRoots 覆盖资产根（asWebviewUri 资源不在 roots 内即 404）', () => {
    const options = buildWebviewOptions(fakeUri('/ext/dist') as never);
    expect(options.localResourceRoots).toHaveLength(1);
    expect((options.localResourceRoots![0] as FakeUri).path).toBe('/ext/dist');
  });

  it('provider 注册选项带 enableFindWidget 与 retainContextWhenHidden', () => {
    expect(buildProviderWebviewOptions()).toEqual({
      enableFindWidget: true,
      retainContextWhenHidden: true
    });
  });
});

describe('资产根解析（评审 critical ①：安装态全 404 → 白屏）', () => {
  it('安装态（VSIX 打包根 = dist/ 本身，产物在扩展根下）→ 资产根 = 扩展根', async () => {
    const root = await resolveAssetRoot(
      EXTENSION_URI as never,
      fakeJoinPath as never,
      async () => false
    );
    expect((root as FakeUri).path).toBe('/ext');
  });

  it('开发态（产物在 <ext>/dist 下）→ 资产根 = <ext>/dist', async () => {
    const root = await resolveAssetRoot(
      EXTENSION_URI as never,
      fakeJoinPath as never,
      async (uri) => (uri as FakeUri).path === '/ext/dist/webview/main.js'
    );
    expect((root as FakeUri).path).toBe('/ext/dist');
  });
});

describe('资产 URI 映射（RF 5）', () => {
  const assets = buildAssetUris({
    webview: fakeWebview,
    assetRoot: fakeUri('/ext/dist') as never,
    joinPath: fakeJoinPath as never,
    grammars: { bash: { file: 'bash.wasm', aliases: ['sh'] } }
  });

  it('全为 asWebviewUri 绝对 URL（不得混用相对路径）', () => {
    for (const value of Object.values(assets)) {
      if (typeof value === 'string') expect(value.startsWith('https://')).toBe(true);
    }
  });

  it('三段基址带尾斜杠（joinPath / fetch(`${dir}/${name}`) 语义）', () => {
    expect(assets.grammarsBase).toBe('https://webview.internal/ext/dist/webview/assets/grammars/');
    expect(assets.queriesBase).toBe('https://webview.internal/ext/dist/webview/assets/queries/');
    expect(assets.runtimeDir).toBe('https://webview.internal/ext/dist/webview/assets/');
    expect(assets.fontsBase).toBe('https://webview.internal/ext/dist/webview/fonts/');
  });

  it('runtimeDir 与 grammarsBase/queriesBase 同族（assets/ 与其子目录）', () => {
    expect(assets.grammarsBase.startsWith(assets.runtimeDir)).toBe(true);
    expect(assets.queriesBase.startsWith(assets.runtimeDir)).toBe(true);
  });

  it('三个 worker 各有专名，无悬空 workerUrl 字段', () => {
    expect(assets.binaryWorkerUrl).toBe('https://webview.internal/ext/dist/webview/binary-worker.js');
    expect(assets.highlightWorkerSourceUrl).toBe(
      'https://webview.internal/ext/dist/webview/highlight-worker.js'
    );
    expect(assets.pdfWorkerModernUrl).toBe(
      'https://webview.internal/ext/dist/webview/pdf/pdf.worker.min.mjs'
    );
    expect(assets.pdfWorkerLegacyUrl).toBe(
      'https://webview.internal/ext/dist/webview/pdf/pdf.worker.legacy.min.mjs'
    );
    expect(Object.keys(assets)).not.toContain('workerUrl');
  });

  it('pdfjs worker 双支不同（按能力选支的消费面）', () => {
    expect(assets.pdfWorkerModernUrl).not.toBe(assets.pdfWorkerLegacyUrl);
  });

  it('打包主题表 URL 在场（动态令牌面按 kind 取两条主题）', () => {
    expect(assets.themesUrl).toBe('https://webview.internal/ext/dist/webview/assets/themes.json');
  });

  it('katex 导出样式 URL 在场（自包含产物——字体 data URI 内联）', () => {
    expect(assets.katexExportCssUrl).toBe('https://webview.internal/ext/dist/webview/katex.export.css');
  });

  it('katex 样式与字体族齐备', () => {
    expect(assets.katexCssUrl).toBe('https://webview.internal/ext/dist/webview/katex.min.css');
    expect(assets.fontsBase.endsWith('/fonts/')).toBe(true);
  });

  it('grammar 清单原样透传', () => {
    expect(assets.grammars).toEqual({ bash: { file: 'bash.wasm', aliases: ['sh'] } });
  });
});

describe('主题令牌缺省（裁量 4：按 activeColorTheme.kind 注入）', () => {
  it('亮暗两套 `--ui-*` 缺省值齐备且不同', () => {
    const light = themeCssVars('light');
    const dark = themeCssVars('dark');
    for (const key of ['--ui-bg', '--ui-fg', '--ui-fg-muted', '--ui-border', '--ui-accent']) {
      expect(light[key], `亮色缺 ${key}`).toBeTruthy();
      expect(dark[key], `暗色缺 ${key}`).toBeTruthy();
      expect(light[key]).not.toBe(dark[key]);
    }
  });

  it('返回副本（消费方改不改都不影响源）', () => {
    const first = themeCssVars('light');
    first['--ui-bg'] = 'mutated';
    expect(themeCssVars('light')['--ui-bg']).not.toBe('mutated');
  });
});

describe('辅助面', () => {
  it('nonce 为 32 位十六进制且互不相同', () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('文档名取文件名', () => {
    expect(documentName(fakeUri('/a/b/c.md') as never)).toBe('c.md');
  });
});
