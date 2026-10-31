// highlightDefault.test.ts — 包内默认 tree-sitter 高亮器：纯函数契约（grammar base
// 归一/布局契约校验、queries base 推导）、失败降级链（HighlightFence 永不抛错）与
// 真实 wasm 端到端（离线资产直传形态，fresh clone 缺 grammar 资产时整组跳过——
// highlight 包 runtime.test.ts 同款护栏）。真实 CDN 加载路径属
// @bhxch/vviewer-highlight TreeSitterEngine 职责（该包自测），本文件不发起真实网络请求。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDefaultHighlightFence,
  deriveQueriesBase,
  normalizeGrammarsBase,
  DEFAULT_GRAMMARS_BASE_URL
} from '../src/highlightDefault';

const here = path.dirname(fileURLToPath(import.meta.url));
// 离线资产：highlight 包查询资产 + web 静态 grammar 资产（gen:grammars 产物，不入库）
const queriesDir = path.join(here, '../../vviewer-highlight/assets/queries');
const staticDir = path.join(here, '../../../apps/web/static');
const grammarsDir = path.join(staticDir, 'grammars');
const grammarAssetsReady =
  existsSync(path.join(grammarsDir, 'manifest.json')) && existsSync(path.join(staticDir, 'tree-sitter.wasm'));

/** queries 目录 → VirtualQueries（离线直传形态；expandQuery 的 assets 同构）。 */
function loadVirtualQueries(dir: string): Record<string, { highlights?: string; injections?: string }> {
  const out: Record<string, { highlights?: string; injections?: string }> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const read = (name: string): string | undefined => {
      const p = path.join(dir, entry.name, name);
      return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
    };
    const highlights = read('highlights.scm');
    const injections = read('injections.scm');
    if (highlights !== undefined || injections !== undefined) out[entry.name] = { highlights, injections };
  }
  return out;
}

describe('grammar base 归一与布局契约', () => {
  it('默认 CDN base 以 /grammars/ 结尾（发布布局契约：manifest 与 wasm 同目录）', () => {
    expect(DEFAULT_GRAMMARS_BASE_URL.endsWith('/grammars/')).toBe(true);
  });

  it('normalizeGrammarsBase：补尾斜杠；非 /grammars/ 结尾抛错（防错插中间段）', () => {
    expect(normalizeGrammarsBase('https://cdn.example.com/pkg@1/grammars/')).toBe(
      'https://cdn.example.com/pkg@1/grammars/'
    );
    expect(normalizeGrammarsBase('https://cdn.example.com/pkg@1/grammars')).toBe(
      'https://cdn.example.com/pkg@1/grammars/'
    );
    expect(() => normalizeGrammarsBase('https://cdn.example.com/pkg@1/')).toThrow(/\/grammars\/ 结尾/);
    expect(() => normalizeGrammarsBase('https://cdn.example.com/pkg@1/wasm/')).toThrow(/\/grammars\/ 结尾/);
  });

  it('deriveQueriesBase：/grammars/ → /queries/（发布包根下兄弟目录，同版本同源）', () => {
    expect(deriveQueriesBase(DEFAULT_GRAMMARS_BASE_URL)).toBe(
      'https://cdn.jsdelivr.net/npm/@bhxch/vviewer-grammars-full@0.1.0/queries/'
    );
  });
});

describe('fence 降级契约（HighlightFence 永不抛错）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('语言白名单先行短路：白名单外语言直接降级 null，不触发引擎初始化（零 fetch）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const fence = createDefaultHighlightFence({ languages: ['python'] });
    await expect(fence('const x = 1;', 'typescript')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('引擎初始化失败路径永不抛错：恒 null 且重复调用稳定（失败点随环境：runtime wasm/manifest/网络）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('网络不可达');
      })
    );
    const fence = createDefaultHighlightFence();
    await expect(fence('x', 'js')).resolves.toBeNull();
    await expect(fence('x', 'js')).resolves.toBeNull();
    await expect(fence('x', 'js')).resolves.toBeNull();
  });

  it('manifest 非 JSON（SPA fallback 200 text/html）视为初始化失败降级', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    );
    const fence = createDefaultHighlightFence();
    await expect(fence('x', 'js')).resolves.toBeNull();
  });
});

describe.skipIf(!grammarAssetsReady)('createDefaultHighlightFence（真实 wasm，Parser.init 可离线就绪）', () => {
  // 本组需要 runtime wasm 在位（Node 侧 fs 加载）——否则 Parser.init 先于 manifest
  // 失败，manifest 层失败断言无从谈起。

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('manifest 加载失败缓存降级：请求一次、后续零新增（失败终态，不反复重试）', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const fence = createDefaultHighlightFence({
      baseUrl: 'https://cdn.example.com/pkg/grammars/',
      runtimeDir: staticDir // runtime wasm 走本地 fs，失败点收敛到 manifest fetch
    });
    await expect(fence('x', 'js')).resolves.toBeNull();
    const afterFirst = fetchMock.mock.calls.length;
    await expect(fence('x', 'js')).resolves.toBeNull();
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThanOrEqual(1);
  });

  it('未知语言直接降级 null（hasLanguage 前置短路，不发起 wasm 加载）', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ grammars: { python: { file: 'python.wasm', aliases: ['py'] } } }), {
        status: 200
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const fence = createDefaultHighlightFence({ baseUrl: 'https://cdn.example.com/pkg/grammars/', runtimeDir: staticDir });
    await expect(fence('x', 'cobol')).resolves.toBeNull();
    // 仅 manifest 一次请求（语言不在清单，wasm/查询零请求）
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(!grammarAssetsReady)('createDefaultHighlightFence（真实 wasm 离线直传端到端）', () => {
  // 离线形态配置：baseUrl 指本地 grammars 目录（同样过 /grammars/ 布局契约）、
  // table 直传 manifest、queries 直传虚拟映射、runtimeDir 指本地 tree-sitter.wasm
  // 所在目录——零网络请求走完整「parse→区间→行 HTML」链，锁定 fence 契约产物形态。
  const fence = createDefaultHighlightFence({
    baseUrl: grammarsDir + path.sep,
    table: (JSON.parse(readFileSync(path.join(grammarsDir, 'manifest.json'), 'utf8')) as { grammars: object })
      .grammars as Record<string, { file: string; aliases?: string[] }>,
    queries: loadVirtualQueries(queriesDir),
    runtimeDir: staticDir
  });

  it('ts 围栏出 span HTML：const 捕获归约为 ts-keyword（类名 ⊂ CODE_CAPTURES，css .ts-* 段承接）', async () => {
    const html = await fence('const x = 1;', 'ts'); // 别名 ts → typescript
    expect(html).not.toBeNull();
    expect(html).toContain('<span class="ts-keyword">const</span>');
    expect(html).toContain('ts-'); // 标识符/数字等捕获走同类映射（着色形态端到端）
  }, 60_000);

  it('未知语言直接降级 null（管线内 hljs 兜底）', async () => {
    await expect(fence('x', 'cobol')).resolves.toBeNull();
  }, 60_000);
});
