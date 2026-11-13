// highlightDefault.test.ts — 包内默认 tree-sitter 高亮器：纯函数契约（grammar base
// 归一/布局契约校验、多基解析、queries base 推导）、失败降级链（HighlightFence 永不
// 抛错）、拆包子包多基合并与 queries 路由（spec C Task 2——TreeSitterEngine.create
// 参数面断言）与真实 wasm 端到端（离线资产直传形态，fresh clone 缺 grammar 资产时整组
// 跳过——highlight 包 runtime.test.ts 同款护栏）。真实 CDN 加载与 queries fetch 链路属
// @bhxch/vviewer-highlight TreeSitterEngine 职责（该包 queries-remote.test.ts 以真实
// http 伺服覆盖 resolver 分支），本文件不发起真实 wasm 加载。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDefaultHighlightFence,
  deriveQueriesBase,
  normalizeGrammarsBase,
  parseMultiGrammarsBases,
  DEFAULT_GRAMMARS_BASE_URL,
  DEFAULT_RUNTIME_DIR
} from '../src/highlightDefault';
import { TreeSitterEngine, type EngineOptions } from '@bhxch/vviewer-highlight';

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
  it('默认 CDN base 为拆分子包多基（| 分隔）：逐基以 /grammars/ 结尾（发布布局契约），末基结尾成立', () => {
    const bases = parseMultiGrammarsBases(DEFAULT_GRAMMARS_BASE_URL);
    expect(bases.length).toBeGreaterThanOrEqual(2);
    for (const base of bases) expect(base.endsWith('/grammars/')).toBe(true);
    // 子包命名形态（p1..pN 连续自 1）：首基 -p1、次基 -p2
    expect(bases[0]).toMatch(/vviewer-grammars-full-p1@[^/]+\/grammars\/$/);
    expect(bases[1]).toMatch(/vviewer-grammars-full-p2@[^/]+\/grammars\/$/);
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

  it('parseMultiGrammarsBases：| 分隔 + trim + 逐基校验；无分隔符单值=单元素数组（单基兼容锚）；空串抛错', () => {
    expect(parseMultiGrammarsBases('https://a.test/x/grammars/|https://b.test/y/grammars/')).toEqual([
      'https://a.test/x/grammars/',
      'https://b.test/y/grammars/'
    ]);
    // 单值兼容：无分隔符 = 单层（build:e2e/ci.yml 既有单基注入契约零回归）
    expect(parseMultiGrammarsBases('https://cdn.grammars.test/grammars/')).toEqual(['https://cdn.grammars.test/grammars/']);
    // trim 与空段容错；尾斜杠归一
    expect(parseMultiGrammarsBases('  https://a.test/x/grammars | | https://b.test/y/grammars/  ')).toEqual([
      'https://a.test/x/grammars/',
      'https://b.test/y/grammars/'
    ]);
    // 逐基校验：任一基非 /grammars/ 结尾即抛错（多基形态不放松单基契约）
    expect(() => parseMultiGrammarsBases('https://a.test/x/grammars/|https://b.test/y/wasm/')).toThrow(/\/grammars\/ 结尾/);
    expect(() => parseMultiGrammarsBases('')).toThrow(/多基解析为空/);
  });

  it('deriveQueriesBase：/grammars/ → /queries/（发布包根下兄弟目录，同版本同源；单基语义——多基 per-子包推导在 createEngine 经 resolver 完成）', () => {
    expect(deriveQueriesBase('https://cdn.jsdelivr.net/npm/@bhxch/vviewer-grammars-full@0.1.0/grammars/')).toBe(
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

describe('createEngine 拆包子包多基（spec C Task 2：合并/跳层/单基兼容/queries 路由）', () => {
  // createEngine 私有——经 createDefaultHighlightFence 驱动（首次 fence 调用触发引擎创建），
  // TreeSitterEngine.create 参数面用 vi.spyOn 捕获（stub 引擎防真实 wasm 加载）；真实
  // queries fetch 链路由 highlight 包 queries-remote.test.ts 的 resolver 分支覆盖。
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const P1 = 'https://cdn.jsdelivr.net/npm/@scope/pkg-p1@1.0.0/grammars/';
  const P2 = 'https://cdn.jsdelivr.net/npm/@scope/pkg-p2@1.0.0/grammars/';
  const manifestRes = (grammars: Record<string, unknown>) =>
    new Response(JSON.stringify({ grammars }), { status: 200, headers: { 'content-type': 'application/json' } });
  const fakeEngine = () =>
    ({ hasLanguage: () => false, highlight: async () => ({ ok: false, error: 'stub' }) }) as unknown as TreeSitterEngine;

  it('多基两子包 manifest 合并：A 语言落 p1 base、B 语言落 p2 base（first-wins + 每条目 base 记所在子包）', async () => {
    const createSpy = vi.spyOn(TreeSitterEngine, 'create').mockResolvedValue(fakeEngine());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${P1}manifest.json`) return manifestRes({ langA: { file: 'a.wasm', aliases: [] } });
        if (url === `${P2}manifest.json`) return manifestRes({ langB: { file: 'b.wasm', aliases: [] } });
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const fence = createDefaultHighlightFence({ baseUrl: `${P1}|${P2}`, runtimeDir: staticDir });
    await fence('x', 'langA');
    expect(createSpy).toHaveBeenCalledTimes(1);
    const opts = createSpy.mock.calls[0]![0] as EngineOptions;
    expect(opts.grammars).toEqual({
      langA: { file: 'a.wasm', aliases: [], base: P1 },
      langB: { file: 'b.wasm', aliases: [], base: P2 }
    });
    expect(opts.grammarsBase).toBe(P1);
    // queries 路由（非首子包语言落正确子包）：resolver 按 lang 返回其所在子包的 queries base
    expect(opts.queriesBase).toBe(deriveQueriesBase(P1));
    expect(typeof opts.queriesBaseResolver).toBe('function');
    expect(opts.queriesBaseResolver!('langA', { file: 'a.wasm', base: P1 })).toBe(deriveQueriesBase(P1));
    expect(opts.queriesBaseResolver!('langB', { file: 'b.wasm', base: P2 })).toBe(deriveQueriesBase(P2));
    // resolver 未覆盖语言（防御路径）降级首基 queries
    expect(opts.queriesBaseResolver!('__no_such__', { file: '' })).toBe(deriveQueriesBase(P1));
  });

  it('同名语言 first-wins：后续子包同语言条目不覆盖先命中层（合并语义与 grammarLayers 一致）', async () => {
    const createSpy = vi.spyOn(TreeSitterEngine, 'create').mockResolvedValue(fakeEngine());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `${P1}manifest.json`) return manifestRes({ langA: { file: 'a1.wasm', aliases: ['a-old'] } });
        if (url === `${P2}manifest.json`) return manifestRes({ langA: { file: 'a2.wasm', aliases: ['a-new'] } });
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const fence = createDefaultHighlightFence({ baseUrl: `${P1}|${P2}`, runtimeDir: staticDir });
    await fence('x', 'langA');
    const opts = createSpy.mock.calls[0]![0] as EngineOptions;
    expect(opts.grammars).toEqual({ langA: { file: 'a1.wasm', aliases: ['a-old'], base: P1 } });
  });

  it('某层 403 跳层：仅 warn 一条、其余层照常合并（可用性优先于完整性）', async () => {
    const createSpy = vi.spyOn(TreeSitterEngine, 'create').mockResolvedValue(fakeEngine());
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === `${P1}manifest.json`) return manifestRes({ langA: { file: 'a.wasm', aliases: [] } });
        return new Response('forbidden', { status: 403 });
      })
    );
    const fence = createDefaultHighlightFence({ baseUrl: `${P1}|${P2}`, runtimeDir: staticDir });
    await fence('x', 'langA');
    const opts = createSpy.mock.calls[0]![0] as EngineOptions;
    expect(opts.grammars).toEqual({ langA: { file: 'a.wasm', aliases: [], base: P1 } });
    const layerWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('跳过该子包层'));
    expect(layerWarns).toHaveLength(1);
    expect(String(layerWarns[0]![0])).toContain(`${P2}manifest.json`);
  });

  it('全部层不可用 → 引擎初始化失败（fence 降级 null，hljs 兜底契约；create 零调用）', async () => {
    vi.spyOn(TreeSitterEngine, 'create');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const fence = createDefaultHighlightFence({ baseUrl: `${P1}|${P2}`, runtimeDir: staticDir });
    await expect(fence('x', 'langA')).resolves.toBeNull();
    expect(TreeSitterEngine.create).not.toHaveBeenCalled();
  });

  it('单基兼容：无 | 单值 → 单层直入（原语义）——无 resolver、queriesBase 单值推导', async () => {
    const createSpy = vi.spyOn(TreeSitterEngine, 'create').mockResolvedValue(fakeEngine());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe(`${P1}manifest.json`);
        return manifestRes({ langA: { file: 'a.wasm', aliases: [] } });
      })
    );
    const fence = createDefaultHighlightFence({ baseUrl: P1, runtimeDir: staticDir });
    await fence('x', 'langA');
    const opts = createSpy.mock.calls[0]![0] as EngineOptions;
    expect(opts.grammars).toEqual({ langA: { file: 'a.wasm', aliases: [], base: P1 } });
    expect(opts.queriesBase).toBe(deriveQueriesBase(P1));
    expect(opts.queriesBaseResolver).toBeUndefined();
  });

  it('显式 queriesUrl 单值优先于 resolver；queries 直传时 queriesBase 为 undefined（离线形态不变）', async () => {
    const createSpy = vi.spyOn(TreeSitterEngine, 'create').mockResolvedValue(fakeEngine());
    vi.stubGlobal('fetch', vi.fn(async () => manifestRes({ langA: { file: 'a.wasm', aliases: [] } })));
    const fenceUrl = createDefaultHighlightFence({
      baseUrl: `${P1}|${P2}`,
      queriesUrl: 'https://q.test/queries/',
      runtimeDir: staticDir
    });
    await fenceUrl('x', 'langA');
    const optsUrl = createSpy.mock.calls[0]![0] as EngineOptions;
    expect(optsUrl.queriesBase).toBe('https://q.test/queries/');
    expect(optsUrl.queriesBaseResolver).toBeUndefined();

    const fenceTable = createDefaultHighlightFence({
      baseUrl: `${P1}|${P2}`,
      table: { langA: { file: 'a.wasm' } },
      queries: { langA: { highlights: '()' } },
      runtimeDir: staticDir
    });
    await fenceTable('x', 'langA');
    const optsTable = createSpy.mock.calls[1]![0] as EngineOptions;
    expect(optsTable.queriesBase).toBeUndefined();
    expect(optsTable.queriesBaseResolver).toBeUndefined();
    expect(optsTable.queriesDir).toEqual({ langA: { highlights: '()' } });
  });
});
