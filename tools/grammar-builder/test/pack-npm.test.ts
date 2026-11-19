import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packNpm, packNpmSplit, main, NPM_FILES_FIELD, MANIFEST_ENTRY_BASE, DEFAULT_PACK_LIMIT_BYTES } from '../pack-npm.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

interface PkgJson {
  name: string;
  version: string;
  private: boolean;
  files: string[];
  license: string;
  description: string;
  repository?: string | { url: string };
}
interface PackedManifest {
  note: string;
  grammars: Record<string, { file: string; abi: number | null; sha256: string; aliases: string[]; base?: string }>;
}

/** fixture：临时目录造 2 个假 wasm（任意字节）+ 假 manifest + 2 个假 queries 目录 + 带 repository 的根 package.json 替身 */
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'vv-gb-pack-'));
  const grammars = path.join(dir, 'grammars-src');
  mkdirSync(grammars);
  writeFileSync(path.join(grammars, 'javascript.wasm'), Buffer.from([1, 2, 3, 4]));
  writeFileSync(path.join(grammars, 'swift.wasm'), Buffer.from([9, 8, 7, 6, 5]));
  writeFileSync(
    path.join(grammars, 'manifest.json'),
    JSON.stringify({
      note: 'fixture manifest',
      generatedAt: '2026-10-10T00:00:00.000Z',
      source: 'self-built',
      grammars: {
        javascript: { file: 'javascript.wasm', abi: null, sha256: 'a'.repeat(64), aliases: ['js'] },
        swift: { file: 'swift.wasm', abi: null, sha256: 'b'.repeat(64), aliases: [] },
      },
    }),
  );
  const queries = path.join(dir, 'queries-src');
  mkdirSync(path.join(queries, 'javascript'), { recursive: true });
  mkdirSync(path.join(queries, 'c'), { recursive: true });
  writeFileSync(path.join(queries, 'javascript', 'highlights.scm'), '; js highlights');
  writeFileSync(path.join(queries, 'javascript', 'injections.scm'), '; js injections');
  writeFileSync(path.join(queries, 'c', 'highlights.scm'), '; c highlights');
  const repoPkgJson = path.join(dir, 'repo-pkg.json');
  writeFileSync(repoPkgJson, JSON.stringify({ name: 'vviewer', repository: 'https://github.com/x/vviewer' }));
  const licenseFile = path.join(dir, 'GRAMMAR_LICENSES.md');
  writeFileSync(licenseFile, '# Grammar Licenses\n\nfixture license text\n');
  return { dir, grammars, queries, repoPkgJson, licenseFile, outDir: path.join(dir, 'dist-npm') };
}

/** 测试内独立重走 outDir（与实现各自的遍历互为对照） */
function walkOut(dir: string): { file: string; bytes: number }[] {
  const out: { file: string; bytes: number }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkOut(p));
    else out.push({ file: p, bytes: statSync(p).size });
  }
  return out;
}

const ARGS = (f: ReturnType<typeof fixture>) => ({
  grammarsDir: f.grammars,
  queriesDir: f.queries,
  outDir: f.outDir,
  name: '@scope/vviewer-grammars-full',
  version: '1.2.3',
  repoPkgJson: f.repoPkgJson,
  licenseFile: f.licenseFile,
});

describe('packNpm（npm 单包布局：manifest 与 wasm 同目录的统一 base 契约）', () => {
  it('布局：outDir/grammars/manifest.json（包根无 manifest.json）+ grammars/*.wasm + queries/<dir>/*.scm + 包根 license；wasm 字节原样拷贝', () => {
    const f = fixture();
    packNpm(ARGS(f));
    // manifest 在 grammars/ 内、不在包根（布局契约：客户端 manifest URL 与 wasm URL 同 base）
    expect(existsSync(path.join(f.outDir, 'grammars', 'manifest.json'))).toBe(true);
    expect(existsSync(path.join(f.outDir, 'manifest.json'))).toBe(false);
    expect(readdirSync(path.join(f.outDir, 'grammars')).sort()).toEqual(['javascript.wasm', 'manifest.json', 'swift.wasm']);
    expect(readdirSync(f.outDir).sort()).toEqual(['GRAMMAR_LICENSES.md', 'README.md', 'grammars', 'package.json', 'queries']);
    expect(existsSync(path.join(f.outDir, 'queries', 'javascript', 'highlights.scm'))).toBe(true);
    expect(existsSync(path.join(f.outDir, 'queries', 'javascript', 'injections.scm'))).toBe(true);
    expect(existsSync(path.join(f.outDir, 'queries', 'c', 'highlights.scm'))).toBe(true);
    // wasm 内容逐字节一致
    expect(readFileSync(path.join(f.outDir, 'grammars', 'javascript.wasm'))).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('返回值：files/bytes 覆盖包内全部文件（package.json + license + manifest + wasm + queries）', () => {
    const f = fixture();
    const r = packNpm(ARGS(f)) as { files: number; bytes: number };
    const walked = walkOut(f.outDir);
    expect(r.files).toBe(walked.length); // package.json + README + GRAMMAR_LICENSES.md + manifest.json + 2 wasm + 3 scm = 9
    expect(r.files).toBe(9);
    expect(r.bytes).toBe(walked.reduce((s, x) => s + x.bytes, 0));
  });

  it('package.json：name/version/files(["grammars","queries","GRAMMAR_LICENSES.md"])/private false/license/description/repository（从根 package.json 读出）', () => {
    const f = fixture();
    packNpm(ARGS(f));
    const pkg = JSON.parse(readFileSync(path.join(f.outDir, 'package.json'), 'utf8')) as PkgJson;
    expect(pkg.name).toBe('@scope/vviewer-grammars-full');
    expect(pkg.version).toBe('1.2.3');
    expect(pkg.files).toEqual(['grammars', 'queries', 'GRAMMAR_LICENSES.md']);
    expect(NPM_FILES_FIELD).toEqual(['grammars', 'queries', 'GRAMMAR_LICENSES.md']);
    expect(pkg.private).toBe(false);
    expect(pkg.license).toBe('SEE LICENSE IN GRAMMAR_LICENSES.md');
    expect(pkg.description).toContain('grammar wasm');
    expect(pkg.repository).toBe('https://github.com/x/vviewer');
  });

  it('license 文件随包：包根 GRAMMAR_LICENSES.md 内容与源逐字节一致（SEE LICENSE IN 指向必须在包内）', () => {
    const f = fixture();
    packNpm(ARGS(f));
    const dest = path.join(f.outDir, 'GRAMMAR_LICENSES.md');
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest)).toEqual(readFileSync(f.licenseFile));
  });

  it('manifest 每条 entry 注 base "./"（同目录相对；layer.base 消费时覆写，仅独立消费可读）且其余字段保留', () => {
    const f = fixture();
    packNpm(ARGS(f));
    expect(MANIFEST_ENTRY_BASE).toBe('./');
    const m = JSON.parse(readFileSync(path.join(f.outDir, 'grammars', 'manifest.json'), 'utf8')) as PackedManifest;
    expect(m.note).toBe('fixture manifest');
    for (const [lang, g] of Object.entries(m.grammars)) {
      expect(g.base, `${lang}.base`).toBe('./');
    }
    expect(m.grammars.javascript!.file).toBe('javascript.wasm');
    expect(m.grammars.javascript!.aliases).toEqual(['js']);
    expect(m.grammars.javascript!.sha256).toBe('a'.repeat(64));
    expect(m.grammars.swift!.base).toBe('./');
  });

  it('根 package.json 无 repository 字段时优雅省略（不写 undefined/null）', () => {
    const f = fixture();
    const noRepoPkg = path.join(f.dir, 'no-repo.json');
    writeFileSync(noRepoPkg, JSON.stringify({ name: 'vviewer' }));
    packNpm({ ...ARGS(f), repoPkgJson: noRepoPkg });
    const pkg = JSON.parse(readFileSync(path.join(f.outDir, 'package.json'), 'utf8')) as PkgJson;
    expect('repository' in pkg).toBe(false);
  });
});

describe('packNpm 异常路径（publish 前即失败，不产出残包）', () => {
  it('空 grammarsDir：目录不存在 / 目录存在但无 *.wasm / 有 wasm 无 manifest，均抛错', () => {
    const f = fixture();
    expect(() => packNpm({ ...ARGS(f), grammarsDir: path.join(f.dir, 'nope') })).toThrow(/grammarsDir/);
    const empty = path.join(f.dir, 'empty-grammars');
    mkdirSync(empty);
    expect(() => packNpm({ ...ARGS(f), grammarsDir: empty })).toThrow(/wasm/);
    const noManifest = path.join(f.dir, 'no-manifest');
    mkdirSync(noManifest);
    writeFileSync(path.join(noManifest, 'a.wasm'), Buffer.from([1]));
    expect(() => packNpm({ ...ARGS(f), grammarsDir: noManifest })).toThrow(/manifest/);
  });

  it('manifest 引用的 wasm 缺失抛错（条目与文件不一致 = 残包，打包期拦截）', async () => {
    const f = fixture();
    const broken = path.join(f.dir, 'broken-grammars');
    mkdirSync(broken);
    writeFileSync(path.join(broken, 'javascript.wasm'), Buffer.from([1]));
    writeFileSync(
      path.join(broken, 'manifest.json'),
      JSON.stringify({ grammars: { javascript: { file: 'javascript.wasm' }, swift: { file: 'swift.wasm' } } }),
    );
    expect(() => packNpm({ ...ARGS(f), grammarsDir: broken })).toThrow(/swift\.wasm/);
  });

  it('queriesDir 不存在 / license 文件缺失 / name 或 version 缺失，抛错', () => {
    const f = fixture();
    expect(() => packNpm({ ...ARGS(f), queriesDir: path.join(f.dir, 'nope') })).toThrow(/queriesDir/);
    expect(() => packNpm({ ...ARGS(f), licenseFile: path.join(f.dir, 'nope.md') })).toThrow(/GRAMMAR_LICENSES/);
    expect(() => packNpm({ ...ARGS(f), name: '' })).toThrow(/name/);
    expect(() => packNpm({ ...ARGS(f), version: '' })).toThrow(/version/);
    expect(() => packNpm({ ...ARGS(f), outDir: '' })).toThrow(/outDir/);
  });

  it('queries 拷贝过滤非 scm（ledger H8）：queries/ 混入的非 .scm 资产不进包、目录层级保持', () => {
    const f = fixture();
    writeFileSync(path.join(f.queries, 'javascript', 'README.md'), 'not a scm asset');
    packNpm(ARGS(f));
    expect(existsSync(path.join(f.outDir, 'queries', 'javascript', 'README.md'))).toBe(false);
    expect(existsSync(path.join(f.outDir, 'queries', 'javascript', 'highlights.scm'))).toBe(true);
    expect(existsSync(path.join(f.outDir, 'queries', 'c', 'highlights.scm'))).toBe(true);
  });

  it('outDir 已含打包产物 fail-fast（ledger H8）：package.json 在场即拒跑（脚本不清理，防陈旧混包）', () => {
    const f = fixture();
    mkdirSync(f.outDir, { recursive: true });
    writeFileSync(path.join(f.outDir, 'package.json'), '{"stale":true}');
    expect(() => packNpm(ARGS(f))).toThrow(/outDir 非空/);
  });
});

describe('main()（CLI 入口：Task 5 publish job 经 env 驱动）', () => {
  it('env 三件套（VV_NPM_PACKAGE_NAME/VERSION/OUT）+ 输入路径 env 覆盖 → 打包成功；缺 env 报错指名缺失项', async () => {
    const f = fixture();
    const r = (await main({
      VV_NPM_PACKAGE_NAME: '@scope/vviewer-grammars-full',
      VV_NPM_PACKAGE_VERSION: '1.2.3',
      VV_NPM_OUT: f.outDir,
      VV_GRAMMARS_OUT: f.grammars,
      VV_QUERIES_DIR: f.queries,
      // license 走 env 覆写（自足夹具）——**不依赖仓库根 server/GRAMMAR_LICENSES.md**：
      // 该文件是 gen-licenses 生成物（spec F 出库不入库），干净 clone 里不存在，
      // 依赖它会让本用例在「无生成物」环境（CI 冷缓存 / 本地 clean 后）抛错。
      VV_LICENSE_FILE: f.licenseFile,
    })) as { files: number; bytes: number };
    expect(r.files).toBe(9); // README 参与打包（GRAMMARS-NPM-README.md）+ license + package.json + manifest + 2 wasm + 3 scm
    const pkg = JSON.parse(readFileSync(path.join(f.outDir, 'package.json'), 'utf8')) as PkgJson;
    expect(pkg.name).toBe('@scope/vviewer-grammars-full');
    expect(pkg.version).toBe('1.2.3');
    expect(existsSync(path.join(f.outDir, 'GRAMMAR_LICENSES.md'))).toBe(true);
    await expect(main({})).rejects.toThrow(/VV_NPM_PACKAGE_NAME/);
  });

  it('默认输入路径指向仓库现势资产（apps/web/static/grammars 与 packages/vviewer-highlight/assets/queries）', async () => {
    const { resolvePathsFrom } = await import('../pack-npm.mjs');
    const p = resolvePathsFrom({}) as Record<string, string>;
    expect(p.grammarsDir).toBe(path.join(repoRoot, 'apps/web/static/grammars'));
    expect(p.queriesDir).toBe(path.join(repoRoot, 'packages/vviewer-highlight/assets/queries'));
    expect(p.repoPkgJson).toBe(path.join(repoRoot, 'package.json'));
    expect(p.licenseFile).toBe(path.join(repoRoot, 'server/GRAMMAR_LICENSES.md'));
  });

  it('env 注入覆写（publish-npm artifact 解包路径：VV_GRAMMARS_OUT/VV_QUERIES_DIR/VV_LICENSE_FILE，spec F §8）', async () => {
    const { resolvePathsFrom } = await import('../pack-npm.mjs');
    const p = resolvePathsFrom({
      VV_GRAMMARS_OUT: '/art/grammars',
      VV_QUERIES_DIR: '/art/queries',
      VV_LICENSE_FILE: '/art/GRAMMAR_LICENSES.md',
    }) as Record<string, string>;
    expect(p.grammarsDir).toBe('/art/grammars');
    expect(p.queriesDir).toBe('/art/queries');
    expect(p.licenseFile).toBe('/art/GRAMMAR_LICENSES.md');
  });
});

describe('packNpm contentHash（发布去重门的内容寻址哈希）', () => {
  it('contentHash：16 hex 入 package.json', () => {
    const f = fixture();
    packNpm(ARGS(f));
    const pkg = JSON.parse(readFileSync(path.join(f.outDir, 'package.json'), 'utf8')) as PkgJson & {
      contentHash: string;
    };
    expect(pkg.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('确定性：generatedAt 差异不影响哈希（manifest 唯一非稳定字段被归一）', () => {
    const f1 = fixture();
    const r1 = packNpm(ARGS(f1));
    const f2 = fixture();
    const m2 = path.join(f2.grammars, 'manifest.json');
    const parsed = JSON.parse(readFileSync(m2, 'utf8')) as { generatedAt: string };
    parsed.generatedAt = '2099-01-01T00:00:00.000Z';
    writeFileSync(m2, JSON.stringify(parsed));
    const r2 = packNpm(ARGS(f2));
    expect(r2.contentHash).toBe(r1.contentHash);
  });

  it('敏感性：wasm 字节变化 → 哈希变化', () => {
    const f1 = fixture();
    const r1 = packNpm(ARGS(f1));
    const f2 = fixture();
    writeFileSync(path.join(f2.grammars, 'javascript.wasm'), Buffer.from([1, 2, 3, 4, 255]));
    const r2 = packNpm(ARGS(f2));
    expect(r2.contentHash).not.toBe(r1.contentHash);
  });

  it('敏感性：manifest 侧变化（条目 sha256/aliases）→ 哈希变化（评审 minor：数组 replacer 逐层过滤致条目未进哈希，manifest-only 变更被误判为零变化）', () => {
    const f1 = fixture();
    const r1 = packNpm(ARGS(f1));
    const f2 = fixture();
    const m2 = path.join(f2.grammars, 'manifest.json');
    const parsed = JSON.parse(readFileSync(m2, 'utf8')) as {
      grammars: Record<string, { sha256?: string; aliases?: string[] }>;
    };
    // 条目级变更（wasm 字节不变，仅 manifest 侧的 sha256 变化）
    const first = Object.keys(parsed.grammars)[0]!;
    parsed.grammars[first]!.sha256 = 'f'.repeat(64);
    writeFileSync(m2, JSON.stringify(parsed));
    const r2 = packNpm(ARGS(f2));
    expect(r2.contentHash).not.toBe(r1.contentHash);
  });
});

/* ---------------------------------- 拆分模式 ---------------------------------- */

const MB = 1024 * 1024;

interface SplitResult {
  outDir: string;
  name: string;
  contentHash: string;
  bytes: number;
  langs: string[];
}

/**
 * 定长 wasm fixture（拆分用）：sizes lang→wasm 字节数（大件任意放大，单包 fixture() 先例），
 * 每语言 queries/<lang>/highlights.scm 一个小 .scm。同一临时目录，用例尾清理。
 */
function fixtureSized(sizes: Record<string, number>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vv-gb-split-'));
  const grammars = path.join(dir, 'grammars-src');
  mkdirSync(grammars);
  const entries: Record<string, { file: string; abi: null; sha256: string; aliases: string[] }> = {};
  for (const [lang, size] of Object.entries(sizes)) {
    writeFileSync(path.join(grammars, `${lang}.wasm`), Buffer.alloc(size, 1));
    entries[lang] = { file: `${lang}.wasm`, abi: null, sha256: 'a'.repeat(64), aliases: [] };
  }
  writeFileSync(
    path.join(grammars, 'manifest.json'),
    JSON.stringify({
      note: 'fixture manifest',
      generatedAt: '2026-10-10T00:00:00.000Z',
      source: 'self-built',
      grammars: entries,
    }),
  );
  const queries = path.join(dir, 'queries-src');
  for (const lang of Object.keys(sizes)) {
    mkdirSync(path.join(queries, lang), { recursive: true });
    writeFileSync(path.join(queries, lang, 'highlights.scm'), '; q; q; q; q');
  }
  const repoPkgJson = path.join(dir, 'repo-pkg.json');
  writeFileSync(repoPkgJson, JSON.stringify({ name: 'vviewer', repository: 'https://github.com/x/vviewer' }));
  const licenseFile = path.join(dir, 'GRAMMAR_LICENSES.md');
  writeFileSync(licenseFile, '# Grammar Licenses\n\nfixture license text\n');
  return { dir, grammars, queries, repoPkgJson, licenseFile, outDir: path.join(dir, 'dist-npm') };
}

const SPLIT_ARGS = (f: ReturnType<typeof fixtureSized>, packLimitBytes?: number) => ({
  grammarsDir: f.grammars,
  queriesDir: f.queries,
  outDir: f.outDir,
  name: '@scope/vviewer-grammars-full',
  version: '1.2.3',
  repoPkgJson: f.repoPkgJson,
  licenseFile: f.licenseFile,
  ...(packLimitBytes !== undefined ? { packLimitBytes } : {}),
});

describe('packNpmSplit（拆分模式：FFD 体积均衡装箱，门禁两段语义）', () => {
  it('门禁第 1 段——单件前提：单语言载荷（wasm+queries）> packLimitBytes 整体抛错，不产任何包（{60,30,0.1}MB @40MB）', () => {
    const f = fixtureSized({ langA: 60 * MB, langB: 30 * MB, langC: 100 * 1024 });
    try {
      expect(() => packNpmSplit(SPLIT_ARGS(f, 40 * MB) as never)).toThrow(/单语言载荷.*langA/);
      // fail-fast：装箱前预检，未触任何写盘
      expect(existsSync(f.outDir)).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('门禁第 2 段——装箱门禁 + FFD 均衡：{35,30,0.1}MB @40MB → N=2，每包总字节 ≤ 阈值，成员分布=FFD 真实产出', () => {
    const f = fixtureSized({ langA: 35 * MB, langB: 30 * MB, langC: 100 * 1024 });
    try {
      const results = packNpmSplit(SPLIT_ARGS(f, 40 * MB) as never) as SplitResult[];
      expect(results).toHaveLength(2);
      // 每包解包总字节 ≤ 阈值——门禁第 2 段全部包逐一断言，无例外（walkOut 实测含 package.json 的保守口径）
      for (const r of results) {
        const walked = walkOut(r.outDir);
        expect(walked.reduce((s, x) => s + x.bytes, 0)).toBeLessThanOrEqual(40 * MB);
      }
      // 成员分布按 FFD 确定性真实产出：35MB 开包 1，30MB 放不下开包 2，0.1MB 回填首个能容纳的包（35+0.1=35.1≤40）
      // ——勿写「大件独占」反期望（FFD 回填语义必然把后续小件塞进首个能容纳的包）
      expect(results[0].langs).toEqual(['langA', 'langC']);
      expect(results[1].langs).toEqual(['langB']);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('每包布局与单包契约同构：manifest 键集==包内 wasm 文件集 + 顶层元数据/base 同源 + 包根条目同单包 + queries 跟随语言所在子包', () => {
    const f = fixtureSized({ langA: 35 * MB, langB: 30 * MB, langC: 100 * 1024 });
    try {
      const results = packNpmSplit(SPLIT_ARGS(f, 40 * MB) as never) as SplitResult[];
      for (const r of results) {
        // manifest 在 grammars/ 内（与 wasm 同目录布局契约），键集与包内 wasm 文件集一致（dangling 断言，单包先例同源）
        expect(existsSync(path.join(r.outDir, 'grammars', 'manifest.json'))).toBe(true);
        expect(existsSync(path.join(r.outDir, 'manifest.json'))).toBe(false);
        const m = JSON.parse(readFileSync(path.join(r.outDir, 'grammars', 'manifest.json'), 'utf8')) as PackedManifest;
        const wasmFiles = readdirSync(path.join(r.outDir, 'grammars')).filter((x) => x.endsWith('.wasm')).sort();
        expect(Object.keys(m.grammars).sort()).toEqual(wasmFiles.map((x) => x.replace(/\.wasm$/, '')).sort());
        // 顶层元数据与单包同源同值；每条 entry 注 base "./"
        expect(m.note).toBe('fixture manifest');
        for (const g of Object.values(m.grammars)) expect(g.base, `${r.name} entry.base`).toBe('./');
        // 包根条目同单包布局
        expect(readdirSync(r.outDir).sort()).toEqual(['GRAMMAR_LICENSES.md', 'README.md', 'grammars', 'package.json', 'queries']);
      }
      // queries/<lang>/ 跟随语言所在子包（包1={langA,langC} 包2={langB}；跨包无该语言目录）
      expect(readdirSync(path.join(results[0].outDir, 'queries')).sort()).toEqual(['langA', 'langC']);
      expect(readdirSync(path.join(results[1].outDir, 'queries')).sort()).toEqual(['langB']);
      expect(existsSync(path.join(results[0].outDir, 'queries', 'langB'))).toBe(false);
      expect(existsSync(path.join(results[1].outDir, 'queries', 'langA'))).toBe(false);
      // queries 内容逐字节一致
      expect(readFileSync(path.join(results[1].outDir, 'queries', 'langB', 'highlights.scm'))).toEqual(Buffer.from('; q; q; q; q'));
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('聚合 hash 稳定：同输入两次运行全包 contentHash 序列逐字节相等；单语言内容变化仅影响其所在包 hash', () => {
    const f = fixtureSized({ langA: 35 * MB, langB: 30 * MB, langC: 100 * 1024 });
    try {
      const r1 = packNpmSplit(SPLIT_ARGS(f, 40 * MB) as never) as SplitResult[];
      rmSync(f.outDir, { recursive: true, force: true });
      const r2 = packNpmSplit(SPLIT_ARGS(f, 40 * MB) as never) as SplitResult[];
      expect(r2.map((x) => x.contentHash)).toEqual(r1.map((x) => x.contentHash));
      // 单语言内容变化（langA=35MB 件 → 包1）：仅其所在包 hash 变
      writeFileSync(path.join(f.grammars, 'langA.wasm'), Buffer.alloc(35 * MB, 2));
      rmSync(f.outDir, { recursive: true, force: true });
      const r3 = packNpmSplit(SPLIT_ARGS(f, 40 * MB) as never) as SplitResult[];
      expect(r3[0].contentHash).not.toBe(r1[0].contentHash);
      expect(r3[1].contentHash).toBe(r1[1].contentHash);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('包名 p1..pN 连续、版本同 tag；contentHash 落各包 package.json', () => {
    const f = fixtureSized({ langA: 35 * MB, langB: 30 * MB, langC: 100 * 1024 });
    try {
      const results = packNpmSplit(SPLIT_ARGS(f, 40 * MB) as never) as SplitResult[];
      expect(results.map((r) => r.name)).toEqual(['@scope/vviewer-grammars-full-p1', '@scope/vviewer-grammars-full-p2']);
      for (const r of results) {
        const pkg = JSON.parse(readFileSync(path.join(r.outDir, 'package.json'), 'utf8')) as PkgJson & { contentHash: string };
        expect(pkg.version).toBe('1.2.3');
        expect(pkg.private).toBe(false);
        expect(pkg.contentHash).toMatch(/^[0-9a-f]{16}$/);
        expect(pkg.contentHash).toBe(r.contentHash);
      }
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('outDir fail-fast（H8 拆分同口径）：根目录已含 p* 子目录或单包产物 package.json 时拒跑', () => {
    const f = fixtureSized({ langA: 1024, langB: 1024 });
    try {
      mkdirSync(path.join(f.outDir, 'p1'), { recursive: true });
      expect(() => packNpmSplit(SPLIT_ARGS(f, 40 * MB) as never)).toThrow(/outDir 非空/);
      const f2 = fixtureSized({ langA: 1024, langB: 1024 });
      mkdirSync(f2.outDir, { recursive: true });
      writeFileSync(path.join(f2.outDir, 'package.json'), '{"stale":true}');
      expect(() => packNpmSplit(SPLIT_ARGS(f2, 40 * MB) as never)).toThrow(/outDir 非空/);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('生产缺省 packLimitBytes=50MB（DEFAULT_PACK_LIMIT_BYTES）；main() 经 VV_NPM_SPLIT=1 + VV_NPM_SPLIT_LIMIT_MB env 驱动拆分', async () => {
    expect(DEFAULT_PACK_LIMIT_BYTES).toBe(50 * 1024 * 1024);
    const f = fixtureSized({ langA: 35 * MB, langB: 30 * MB, langC: 100 * 1024 });
    try {
      const results = (await main({
        VV_NPM_PACKAGE_NAME: '@scope/vviewer-grammars-full',
        VV_NPM_PACKAGE_VERSION: '1.2.3',
        VV_NPM_OUT: f.outDir,
        VV_GRAMMARS_OUT: f.grammars,
        VV_QUERIES_DIR: f.queries,
        VV_NPM_SPLIT: '1',
        VV_NPM_SPLIT_LIMIT_MB: '40',
        // license 走 env 覆写（同上：生成物不入库，默认路径在干净 clone 缺失）
        VV_LICENSE_FILE: f.licenseFile,
      })) as SplitResult[];
      expect(results).toHaveLength(2);
      expect(existsSync(path.join(f.outDir, 'p1', 'package.json'))).toBe(true);
      expect(existsSync(path.join(f.outDir, 'p2', 'package.json'))).toBe(true);
      expect(existsSync(path.join(f.outDir, 'package.json'))).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
