// cdnProfiles.test.ts — settings.cdn 三作用面档位解析纯函数（spec C §3.2，Task 3）。
// 纯 .ts vitest 直测（根 vitest 无 svelte 插件）：多基解析/四档 grammars URL 构造/
// 两档 engines·foreign/custom 校验失败不静默吞/子包数解析/版本解析（mock fetch +
// localStorage 缓存）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CDN_VERSIONS_CACHE_KEY,
  GRAMMAR_PACK_NAME,
  enginesHostOk,
  foreignBaseOk,
  grammarPackCount,
  grammarsMultiBaseOk,
  npmmirrorGrammarsBases,
  parseMultiBase,
  resolveCdnPackVersions,
  resolveEnginesHost,
  resolveForeignBase,
  resolveGrammarCdnBases,
  unpkgGrammarsBases
} from './cdnProfiles';
import { DEFAULTS, type Settings } from './stores/settings';
import { FOREIGN_ASSETS_CDN_DEFAULT } from './foreignAssets';

/** DEFAULTS 深拷贝 + cdn 节覆写（DEFAULTS 含嵌套对象，逐用例独立副本） */
function withCdn(cdn: Partial<Settings['cdn']>): Settings {
  const s = JSON.parse(JSON.stringify(DEFAULTS)) as Settings;
  s.cdn = { ...DEFAULTS.cdn, ...cdn };
  return s;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.removeItem(CDN_VERSIONS_CACHE_KEY);
});

describe('parseMultiBase（多基解析：| 分隔 + trim + 尾斜杠归一；单值=单元素兼容锚）', () => {
  it('多基 | 分隔：trim、空段剔除、逐基补尾斜杠', () => {
    expect(parseMultiBase('https://a.test/grammars/|https://b.test/grammars/')).toEqual([
      'https://a.test/grammars/',
      'https://b.test/grammars/'
    ]);
    expect(parseMultiBase('  https://a.test/g | | https://b.test/g  ')).toEqual([
      'https://a.test/g/',
      'https://b.test/g/'
    ]);
  });
  it('无分隔符单值 = 单元素数组（Global Constraints 单基兼容锚）；空串 = 空数组（层缺席语义）', () => {
    expect(parseMultiBase('https://cdn.grammars.test/grammars/')).toEqual(['https://cdn.grammars.test/grammars/']);
    expect(parseMultiBase('')).toEqual([]);
  });
});

describe('custom 值校验（settingsDraft 白名单与 UI 错误态同口径）', () => {
  it('grammarsMultiBaseOk：逐基以 /grammars/ 结尾且非空才合法（多基与单基同口径）', () => {
    expect(grammarsMultiBaseOk('https://a.test/grammars/|https://b.test/grammars/')).toBe(true);
    expect(grammarsMultiBaseOk('https://a.test/grammars')).toBe(true); // 尾斜杠归一后合法
    expect(grammarsMultiBaseOk('https://a.test/wasm/')).toBe(false);
    expect(grammarsMultiBaseOk('https://a.test/grammars/|https://b.test/wasm/')).toBe(false);
    expect(grammarsMultiBaseOk('')).toBe(false);
  });
  it('enginesHostOk / foreignBaseOk：以 / 结尾的 https URL（http 与无尾斜杠非法；空串非法=未启用）', () => {
    expect(enginesHostOk('https://cdn.example.com/npm/')).toBe(true);
    expect(foreignBaseOk('https://assets.example.com/fv/')).toBe(true);
    expect(enginesHostOk('http://cdn.example.com/npm/')).toBe(false);
    expect(enginesHostOk('https://cdn.example.com/npm')).toBe(false);
    expect(foreignBaseOk('https://assets.example.com/fv')).toBe(false);
    expect(foreignBaseOk('')).toBe(false);
    expect(enginesHostOk('not a url')).toBe(false);
  });
});

describe('grammarPackCount（VV_GRAMMAR_PACK_COUNT 解析：缺省 1 单基兼容锚）', () => {
  it('env 显式值取整生效；缺省/未注入 = 1；非法与小数防御', () => {
    expect(grammarPackCount('6')).toBe(6);
    expect(grammarPackCount(undefined)).toBe(1);
    expect(grammarPackCount('abc')).toBe(1);
    expect(grammarPackCount('0')).toBe(1);
    expect(grammarPackCount('-2')).toBe(1);
    expect(grammarPackCount('2.7')).toBe(2);
  });
});

describe('resolveGrammarCdnBases（grammars 四档：default/unpkg/cn/custom）', () => {
  it("default 档 = 构建期 env 解析（单基注入=单元素零回归；多基=多元素；空 env=空数组层缺席）", () => {
    expect(resolveGrammarCdnBases(withCdn({ grammars: 'default' }), 'https://cdn.grammars.test/grammars/')).toEqual([
      'https://cdn.grammars.test/grammars/'
    ]);
    expect(
      resolveGrammarCdnBases(withCdn({ grammars: 'default' }), 'https://a.test/grammars/|https://b.test/grammars/')
    ).toEqual(['https://a.test/grammars/', 'https://b.test/grammars/']);
    expect(resolveGrammarCdnBases(withCdn({ grammars: 'default' }), '')).toEqual([]);
  });
  it('unpkg 档 = 不带版本缺省重定向形态 ×N（N=1 单基兼容；N=3 多基 p1..pN 序）', () => {
    expect(resolveGrammarCdnBases(withCdn({ grammars: 'unpkg' }), '')).toEqual([
      `https://unpkg.com/${GRAMMAR_PACK_NAME}-p1/grammars/`
    ]);
    // N>1 形态经 count 参数化导出直测（resolveGrammarCdnBases 以 grammarPackCount()
    // 注入 count——注入面生产走 vite define，组合正确性由两半各自覆盖）
    expect(unpkgGrammarsBases(3)).toEqual([
      `https://unpkg.com/${GRAMMAR_PACK_NAME}-p1/grammars/`,
      `https://unpkg.com/${GRAMMAR_PACK_NAME}-p2/grammars/`,
      `https://unpkg.com/${GRAMMAR_PACK_NAME}-p3/grammars/`
    ]);
  });
  it('cn 档 = npmmirror files 通道 latest tag 形态 ×N（N=1 单基；N=2 多基）', () => {
    expect(resolveGrammarCdnBases(withCdn({ grammars: 'cn' }), '')).toEqual([
      `https://registry.npmmirror.com/${GRAMMAR_PACK_NAME}-p1/latest/files/grammars/`
    ]);
    expect(npmmirrorGrammarsBases(2)).toEqual([
      `https://registry.npmmirror.com/${GRAMMAR_PACK_NAME}-p1/latest/files/grammars/`,
      `https://registry.npmmirror.com/${GRAMMAR_PACK_NAME}-p2/latest/files/grammars/`
    ]);
  });
  it('custom 档：合法多基逐基解析；空串 = 未启用走 default 档行为；非空非法 = null（UI 错误态，不静默吞）', () => {
    expect(
      resolveGrammarCdnBases(withCdn({ grammars: 'custom', grammarsCustom: 'https://a.test/grammars/|https://b.test/grammars/' }), '')
    ).toEqual(['https://a.test/grammars/', 'https://b.test/grammars/']);
    // 空串 = 未启用：回 default 档（env 注入值）
    expect(resolveGrammarCdnBases(withCdn({ grammars: 'custom', grammarsCustom: '' }), 'https://env.test/grammars/')).toEqual([
      'https://env.test/grammars/'
    ]);
    expect(resolveGrammarCdnBases(withCdn({ grammars: 'custom', grammarsCustom: 'https://a.test/wasm/' }), '')).toBeNull();
  });
});

describe('resolveEnginesHost（engines 两档：default=undefined 缺省 jsdelivr / custom=注入 host）', () => {
  it('default 档 undefined（缺省链尾=jsdelivr 缺省形态）；custom 合法值透传；空串与非法值 undefined', () => {
    expect(resolveEnginesHost(withCdn({ engines: 'default' }))).toBeUndefined();
    expect(resolveEnginesHost(withCdn({ engines: 'custom', enginesCustom: 'https://cdn.example.com/npm/' }))).toBe(
      'https://cdn.example.com/npm/'
    );
    expect(resolveEnginesHost(withCdn({ engines: 'custom', enginesCustom: '' }))).toBeUndefined();
    expect(resolveEnginesHost(withCdn({ engines: 'custom', enginesCustom: 'http://x.test/' }))).toBeUndefined();
  });
});

describe('resolveForeignBase（foreign 两档：default=缺省链 / custom=覆写插在缺省 CDN 前）', () => {
  it('default 档 = resolveForeignAssetBase 缺省链（env → 同源 → 缺省 CDN）', () => {
    expect(resolveForeignBase(withCdn({ foreign: 'default' }), undefined)).toBe(FOREIGN_ASSETS_CDN_DEFAULT);
    expect(resolveForeignBase(withCdn({ foreign: 'default' }), 'https://assets.example.com/fv')).toBe(
      'https://assets.example.com/fv/'
    );
  });
  it('custom 合法值覆写（插在缺省 CDN 前，env 显式层仍最优先）；空串 = 未启用走缺省链；非法值走缺省链（UI 错误态承接）', () => {
    expect(resolveForeignBase(withCdn({ foreign: 'custom', foreignCustom: 'https://mirror.test/fv/' }), undefined)).toBe(
      'https://mirror.test/fv/'
    );
    // env 显式层优先于运行时覆写（链序：env → 同源 → 运行时覆写 → 缺省 CDN）
    expect(
      resolveForeignBase(withCdn({ foreign: 'custom', foreignCustom: 'https://mirror.test/fv/' }), 'https://env.test/fv')
    ).toBe('https://env.test/fv/');
    expect(resolveForeignBase(withCdn({ foreign: 'custom', foreignCustom: '' }), undefined)).toBe(FOREIGN_ASSETS_CDN_DEFAULT);
    expect(resolveForeignBase(withCdn({ foreign: 'custom', foreignCustom: 'http://x.test/' }), undefined)).toBe(
      FOREIGN_ASSETS_CDN_DEFAULT
    );
  });
});

describe('resolveCdnPackVersions（unpkg/npmmirror 子包版本解析：缓存 + 失败回退）', () => {
  it('unpkg 逐包 package.json 解析版本数组并写缓存；二次调用缓存命中零 fetch', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const m = /-p(\d+)\/package\.json$/.exec(url);
      if (!m) throw new Error(`unexpected: ${url}`);
      return new Response(JSON.stringify({ version: `1.0.${m[1]}` }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const versions = await resolveCdnPackVersions('unpkg', 2);
    expect(versions).toEqual(['1.0.1', '1.0.2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 缓存命中：二次调用零 fetch
    const cached = await resolveCdnPackVersions('unpkg', 2);
    expect(cached).toEqual(['1.0.1', '1.0.2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem(CDN_VERSIONS_CACHE_KEY)!).unpkg).toEqual({ count: 2, versions: ['1.0.1', '1.0.2'] });
  });
  it('npmmirror registry latest 解析（dist-tags/version 形态）；解析失败返回 null（UI 回退重定向形态提示）', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith(`/${GRAMMAR_PACK_NAME}-p1/latest`)) {
        return new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await resolveCdnPackVersions('cn', 1)).toEqual(['9.9.9']);
    // 失败（404）且无缓存 → null
    expect(await resolveCdnPackVersions('cn', 2)).toBeNull();
  });
});
