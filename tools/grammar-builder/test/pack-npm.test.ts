import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packNpm, main, NPM_FILES_FIELD, MANIFEST_ENTRY_BASE } from '../pack-npm.mjs';

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
    expect(readdirSync(f.outDir).sort()).toEqual(['GRAMMAR_LICENSES.md', 'grammars', 'package.json', 'queries']);
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
    expect(r.files).toBe(walked.length); // package.json + GRAMMAR_LICENSES.md + manifest.json + 2 wasm + 3 scm = 8
    expect(r.files).toBe(8);
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
    })) as { files: number; bytes: number };
    expect(r.files).toBe(8); // license 文件走默认路径（仓库根 server/GRAMMAR_LICENSES.md，入库稳定存在）
    const pkg = JSON.parse(readFileSync(path.join(f.outDir, 'package.json'), 'utf8')) as PkgJson;
    expect(pkg.name).toBe('@scope/vviewer-grammars-full');
    expect(pkg.version).toBe('1.2.3');
    expect(existsSync(path.join(f.outDir, 'GRAMMAR_LICENSES.md'))).toBe(true);
    await expect(main({})).rejects.toThrow(/VV_NPM_PACKAGE_NAME/);
  });

  it('默认输入路径指向仓库现势资产（apps/web/static/grammars 与 packages/highlight/assets/queries）', async () => {
    const { resolvePathsFrom } = await import('../pack-npm.mjs');
    const p = resolvePathsFrom({}) as Record<string, string>;
    expect(p.grammarsDir).toBe(path.join(repoRoot, 'apps/web/static/grammars'));
    expect(p.queriesDir).toBe(path.join(repoRoot, 'packages/highlight/assets/queries'));
    expect(p.repoPkgJson).toBe(path.join(repoRoot, 'package.json'));
  });
});
