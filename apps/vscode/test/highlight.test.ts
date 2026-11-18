// highlight.test.ts — tree-sitter 离线高亮链路契约（spec H T4）。
//
// 覆盖面（计划 T4 Step 1 明列）：引擎档位裁决、缺件降级矩阵、grammar 表构造。
// 另含两条纪律锚：资产三段自洽（尾斜杠/绝对 URL）与「围栏桥只在 T3 注入一次」。
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decideEngineStartup,
  resolveHighlightEngine,
  resolveLanguageEngine
} from '../src/webview/highlight';
import {
  hasLocalGrammar,
  resolveAssetAvailability,
  resolveAssetBases,
  toGrammarTable
} from '../src/webview/assets';
import { DEFAULT_WEBVIEW_SETTINGS, type AssetUris } from '../src/host/protocol';

// vitest 下 new URL(rel, import.meta.url) 被 vite 改写成 dev-server URL（探针实测）——
// 按仓内先例单独求值 import.meta.url 取目录。
const here = path.dirname(fileURLToPath(import.meta.url));
const HIGHLIGHT_SRC = readFileSync(path.join(here, '..', 'src', 'webview', 'highlight.ts'), 'utf8');

const ASSETS: AssetUris = {
  grammarsBase: 'https://webview.internal/ext/dist/webview/assets/grammars/',
  queriesBase: 'https://webview.internal/ext/dist/webview/assets/queries/',
  runtimeDir: 'https://webview.internal/ext/dist/webview/assets/',
  grammars: { bash: { file: 'bash.wasm', aliases: ['sh', 'zsh'] } },
  binaryWorkerUrl: 'https://webview.internal/ext/dist/webview/binary-worker.js',
  pdfWorkerModernUrl: 'https://webview.internal/ext/dist/webview/pdf/pdf.worker.min.mjs',
  pdfWorkerLegacyUrl: 'https://webview.internal/ext/dist/webview/pdf/pdf.worker.legacy.min.mjs',
  fontsBase: 'https://webview.internal/ext/dist/webview/fonts/',
  katexCssUrl: 'https://webview.internal/ext/dist/webview/katex.min.css',
  katexExportCssUrl: 'https://webview/katex.export.css',
  themesUrl: 'https://webview.internal/ext/dist/webview/assets/themes.json',
  highlightWorkerSourceUrl: 'https://webview.internal/ext/dist/webview/highlight-worker.js'
};

describe('高亮 · 引擎档位裁决', () => {
  it('三档取值原样透传', () => {
    expect(resolveHighlightEngine({ ...DEFAULT_WEBVIEW_SETTINGS, highlightEngine: 'tree-sitter' })).toBe(
      'tree-sitter'
    );
    expect(resolveHighlightEngine({ ...DEFAULT_WEBVIEW_SETTINGS, highlightEngine: 'hljs' })).toBe('hljs');
    expect(resolveHighlightEngine({ ...DEFAULT_WEBVIEW_SETTINGS, highlightEngine: 'plain' })).toBe('plain');
  });

  it('脏值回落 tree-sitter（默认档）', () => {
    expect(
      resolveHighlightEngine({
        ...DEFAULT_WEBVIEW_SETTINGS,
        highlightEngine: 'vim' as unknown as 'tree-sitter'
      })
    ).toBe('tree-sitter');
  });
});

describe('高亮 · 起活决策与降级矩阵', () => {
  it("'plain' 档不起 worker（省内存与启动时间）", () => {
    const startup = decideEngineStartup('plain');
    expect(startup.startWorker).toBe(false);
    expect(startup.engine).toBe('plain');
    expect(startup.degraded).toBe(false);
  });

  it("'hljs' 档不起 worker（渲染器走内置 hljs 兜底）", () => {
    const startup = decideEngineStartup('hljs');
    expect(startup.startWorker).toBe(false);
    expect(startup.engine).toBe('hljs');
    expect(startup.degraded).toBe(false);
  });

  it("'tree-sitter' 档起 worker", () => {
    const startup = decideEngineStartup('tree-sitter');
    expect(startup.startWorker).toBe(true);
    expect(startup.engine).toBe('tree-sitter');
    expect(startup.degraded).toBe(false);
  });

  it('worker 起活失败 → 降级 hljs 且带降级码（可见，不静默）', () => {
    const startup = decideEngineStartup('tree-sitter', true);
    expect(startup.engine).toBe('hljs');
    expect(startup.degraded).toBe(true);
    expect(startup.code).toBe('worker-failed');
  });

  it('逐语言降级：清单外的语言落 hljs（清单感知门）', () => {
    const miss = resolveLanguageEngine('tree-sitter', 'nim', false);
    expect(miss.engine).toBe('hljs');
    expect(miss.degraded).toBe(true);
    expect(miss.code).toBe('no-grammar');
    expect(miss.detail).toBe('nim');

    const hit = resolveLanguageEngine('tree-sitter', 'bash', true);
    expect(hit.engine).toBe('tree-sitter');
    expect(hit.degraded).toBe(false);
  });

  it('逐语言降级：base 非 tree-sitter 时不二次降级', () => {
    expect(resolveLanguageEngine('hljs', 'nim', false)).toMatchObject({
      engine: 'hljs',
      degraded: false
    });
    expect(resolveLanguageEngine('plain', 'nim', false)).toMatchObject({
      engine: 'plain',
      degraded: false
    });
  });
});

describe('高亮 · grammar 表构造', () => {
  it('manifest 的 grammars 键集 → GrammarTable', () => {
    const table = toGrammarTable({
      grammars: {
        bash: { file: 'bash.wasm', aliases: ['sh', 'zsh'] },
        python: { file: 'python.wasm' }
      }
    });
    expect(Object.keys(table)).toEqual(['bash', 'python']);
    expect(table['bash']).toEqual({ file: 'bash.wasm', aliases: ['sh', 'zsh'] });
    expect(table['python']).toEqual({ file: 'python.wasm' });
  });

  it('**条目不得带 base**（带 base 会绕开 grammarsBase 打到错误源）', () => {
    const table = toGrammarTable({
      grammars: { bash: { file: 'bash.wasm', base: 'https://elsewhere/', aliases: ['sh'] } }
    });
    expect(table['bash']?.base).toBeUndefined();
    expect(Object.keys(table['bash']!)).toEqual(['file', 'aliases']);
  });

  it('丢弃 manifest 的校验字段（abi/sha256——渲染侧不消费）', () => {
    const table = toGrammarTable({
      grammars: { bash: { file: 'bash.wasm', abi: null, sha256: 'deadbeef' } }
    });
    expect(table['bash']).toEqual({ file: 'bash.wasm' });
  });

  it('非法条目跳过；非对象 manifest → 空表', () => {
    expect(toGrammarTable({ grammars: { a: { file: '' }, b: { file: 'b.wasm' }, c: 1 } })).toEqual({
      b: { file: 'b.wasm' }
    });
    expect(toGrammarTable(null)).toEqual({});
    expect(toGrammarTable({})).toEqual({});
    expect(toGrammarTable({ grammars: 'nope' })).toEqual({});
  });

  it('语言在清单内（canonical 或别名）', () => {
    const table = toGrammarTable({ grammars: { bash: { file: 'bash.wasm', aliases: ['sh', 'zsh'] } } });
    expect(hasLocalGrammar(table, 'bash')).toBe(true);
    expect(hasLocalGrammar(table, 'sh')).toBe(true);
    expect(hasLocalGrammar(table, 'nim')).toBe(false);
    expect(hasLocalGrammar(table, '')).toBe(false);
  });
});

describe('高亮 · 资产三段自洽（RF 5）', () => {
  it('三段基址取自 AssetUris（已是 asWebviewUri 绝对 URL）', () => {
    const bases = resolveAssetBases(ASSETS);
    expect(bases.grammarsBase).toBe(ASSETS.grammarsBase);
    expect(bases.queriesBase).toBe(ASSETS.queriesBase);
    expect(bases.runtimeDir).toBe(ASSETS.runtimeDir);
  });

  it('queries 与 runtime 基址带尾斜杠（joinPath / fetch(`${dir}/${name}`) 语义）', () => {
    const bases = resolveAssetBases(ASSETS);
    expect(bases.queriesBase.endsWith('/')).toBe(true);
    expect(bases.runtimeDir.endsWith('/')).toBe(true);
    expect(bases.grammarsBase.endsWith('/')).toBe(true);
  });

  it('grammar 清单为空 → 资产缺件（可见降级的判定依据）', () => {
    expect(resolveAssetAvailability({})).toEqual({ grammarsOk: false, missing: ['grammars'] });
    expect(resolveAssetAvailability({ bash: { file: 'bash.wasm' } })).toEqual({
      grammarsOk: true,
      missing: []
    });
  });
});

describe('高亮 · 缝纪律', () => {
  it('**不注入 setHighlightFence**（围栏桥由 T3 装配层统一注入，缝只注入一次）', () => {
    // 断言「无调用」而非「无字样」——文件注释里本就写明该缝由 T3 注入
    expect(HIGHLIGHT_SRC).not.toMatch(/setHighlightFence\s*\(/);
  });

  it('走 attachHighlightClient 注入（render-text 的 code 渲染器消费面）', () => {
    expect(HIGHLIGHT_SRC).toContain('attachHighlightClient');
  });
});
