import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrammarTable } from '@vviewer/highlight';
import {
  assembleGrammarLayers,
  fetchGrammarManifest,
  grammarWarmUrl,
  mergeGrammarLayers
} from './grammarLayers';

/**
 * 三层 grammar manifest 合并链（同源 → 服务端 → CDN）的单元测试：
 * 纯函数 mergeGrammarLayers 的 first-wins 与逐条 base 注记契约；
 * fetchGrammarManifest 的失败折叠（非 2xx / 200 text/html SPA fallback / 网络错 →
 * null + warn，不阻塞后续层）；
 * assembleGrammarLayers 的候选层编排（null 层跳过、失败层跳过、layers 如实回报）；
 * grammarWarmUrl 的 wasm URL 拼接（base 已含目录段，防 grammars/ 双拼回归）。
 * fetch 经 vi.stubGlobal 逐 URL 编排，无真实网络。
 */

/** 构造单层最小表：lang → file（按需补 aliases）。 */
function table(entries: Record<string, { file: string; aliases?: string[] }>): GrammarTable {
  return entries;
}

/** fetch 响应桩：ok/status/headers/json 四元组（contentType 缺省无该头）。 */
function res(status: number, body?: unknown, contentType?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(contentType ? { 'content-type': contentType } : {}),
    json: async () => body
  } as Response;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mergeGrammarLayers（first-wins 合并）', () => {
  it('命题 1：两层同键取第 1 层条目，base 也为第 1 层', () => {
    const merged = mergeGrammarLayers([
      { base: '/grammars/', table: table({ rust: { file: 'tree-sitter-rust.wasm' } }) },
      { base: 'https://cdn.example.com/g/', table: table({ rust: { file: 'cdn-rust.wasm' } }) }
    ]);
    expect(merged.rust).toEqual({ file: 'tree-sitter-rust.wasm', base: '/grammars/' });
  });

  it('命题 2：第 2 层独有键 base 注记为第 2 层；每条恒有 base（无缺省泄漏）', () => {
    const merged = mergeGrammarLayers([
      { base: '/grammars/', table: table({ rust: { file: 'tree-sitter-rust.wasm' } }) },
      {
        base: 'https://cdn.example.com/g/',
        table: table({
          rust: { file: 'cdn-rust.wasm' },
          zig: { file: 'tree-sitter-zig.wasm', aliases: ['ziglang'] }
        })
      }
    ]);
    expect(merged.zig).toEqual({
      file: 'tree-sitter-zig.wasm',
      aliases: ['ziglang'],
      base: 'https://cdn.example.com/g/'
    });
    // 每个条目都带 base：合并结果不含任何缺 base 的条目
    expect(Object.values(merged).every((e) => typeof e.base === 'string')).toBe(true);
  });

  it('空层列表 → 空表', () => {
    expect(mergeGrammarLayers([])).toEqual({});
  });
});

describe('fetchGrammarManifest（失败折叠为 null + warn）', () => {
  it('命题 3a：HTTP 404 → null + console.warn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(404)));
    await expect(fetchGrammarManifest('/grammars/manifest.json')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('404');
  });

  it('命题 3b：网络 reject → null + console.warn（不抛）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await expect(fetchGrammarManifest('https://cdn.example.com/g/manifest.json')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('命题 3c：200 + { grammars } → 返回表', async () => {
    const manifest = { grammars: table({ go: { file: 'tree-sitter-go.wasm' } }) };
    vi.stubGlobal('fetch', vi.fn(async () => res(200, manifest)));
    await expect(fetchGrammarManifest('/grammars/manifest.json')).resolves.toEqual(manifest.grammars);
    expect(warn).not.toHaveBeenCalled();
  });

  it('200 但无 grammars 字段 → null（视为该层不可用）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, {})));
    await expect(fetchGrammarManifest('/grammars/manifest.json')).resolves.toBeNull();
  });

  it('命题 3d：200 + text/html（SPA fallback 兜底 index.html）→ null + warn，不阻塞', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, '<!doctype html>', 'text/html; charset=utf-8')));
    await expect(fetchGrammarManifest('/grammars/manifest.json')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('非 JSON 资产应答（SPA fallback？）');
  });
});

describe('assembleGrammarLayers（三层编排）', () => {
  it('命题 4a：serverBase/cdnBase 均 null → 仅取同源层', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === '/grammars/manifest.json'
        ? res(200, { grammars: table({ rust: { file: 'tree-sitter-rust.wasm' } }) })
        : res(404)
    );
    vi.stubGlobal('fetch', fetchMock);
    const { grammars, layers } = await assembleGrammarLayers({
      sameOriginBase: '/grammars/',
      serverBase: null,
      cdnBase: null
    });
    expect(layers).toEqual(['same-origin']);
    expect(grammars.rust).toEqual({ file: 'tree-sitter-rust.wasm', base: '/grammars/' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('命题 4b：server 层 fetch 失败 → 跳层继续 cdn 层，互不阻塞', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/grammars/manifest.json') {
        return res(200, { grammars: table({ rust: { file: 'tree-sitter-rust.wasm' } }) });
      }
      if (url === 'http://srv:8321/grammars/manifest.json') {
        throw new TypeError('Failed to fetch'); // 服务端不可达
      }
      if (url === 'https://cdn.example.com/g/manifest.json') {
        return res(200, { grammars: table({ zig: { file: 'tree-sitter-zig.wasm' } }) });
      }
      return res(404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { grammars, layers } = await assembleGrammarLayers({
      sameOriginBase: '/grammars/',
      serverBase: 'http://srv:8321/',
      cdnBase: 'https://cdn.example.com/g/'
    });
    // server 层失败被跳过：layers 只含实际命中的层名
    expect(layers).toEqual(['same-origin', 'cdn']);
    // cdn 层独有键正常并入且 base 注记为 cdn
    expect(grammars.zig).toEqual({ file: 'tree-sitter-zig.wasm', base: 'https://cdn.example.com/g/' });
    // 同源键不受失败层影响
    expect(grammars.rust?.base).toBe('/grammars/');
  });

  it('命题 4c：serverBase 去尾斜杠拼接 /grammars/，三候选 URL 逐一请求', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return res(404);
      })
    );
    const { layers } = await assembleGrammarLayers({
      sameOriginBase: '/grammars/',
      serverBase: 'http://srv:8321', // 无尾斜杠
      cdnBase: 'https://cdn.example.com/g/'
    });
    expect(urls).toEqual([
      '/grammars/manifest.json',
      'http://srv:8321/grammars/manifest.json',
      'https://cdn.example.com/g/manifest.json'
    ]);
    expect(layers).toEqual([]); // 全部 404 → 无命中层
  });
});

describe('grammarWarmUrl（wasm 预热 URL 拼接，防 grammars/ 双拼回归）', () => {
  it('同源层条目：<base><file> 直拼，不出现 grammars/grammars 双拼', () => {
    const url = grammarWarmUrl({ base: '/grammars/', file: 'tree-sitter-rust.wasm' });
    expect(url).toBe('/grammars/tree-sitter-rust.wasm');
    expect(url).not.toContain('grammars/grammars');
  });

  it('server/cdn 层条目同理：base 已含目录段，仅拼文件名', () => {
    expect(grammarWarmUrl({ base: 'http://srv:8321/grammars/', file: 'tree-sitter-go.wasm' })).toBe(
      'http://srv:8321/grammars/tree-sitter-go.wasm'
    );
    expect(
      grammarWarmUrl({ base: 'https://cdn.example.com/g/grammars/', file: 'tree-sitter-zig.wasm' })
    ).toBe('https://cdn.example.com/g/grammars/tree-sitter-zig.wasm');
  });

  it('端到端：mergeGrammarLayers 产出的条目直接喂 grammarWarmUrl 得 <层base><file>', () => {
    const merged = mergeGrammarLayers([
      { base: '/grammars/', table: table({ rust: { file: 'tree-sitter-rust.wasm' } }) },
      { base: 'https://cdn.example.com/g/grammars/', table: table({ zig: { file: 'tree-sitter-zig.wasm' } }) }
    ]);
    expect(grammarWarmUrl(merged.rust!)).toBe('/grammars/tree-sitter-rust.wasm');
    expect(grammarWarmUrl(merged.zig!)).toBe('https://cdn.example.com/g/grammars/tree-sitter-zig.wasm');
  });
});
