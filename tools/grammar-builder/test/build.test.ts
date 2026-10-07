import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildList, detectParserC, SOURCES } from '../build-list.mjs';
import { buildFromWasms, selfBuild, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '../build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const grammarsDir = path.join(repoRoot, 'apps/web/static/grammars');
const wasmsDir = path.join(repoRoot, 'node_modules/tree-sitter-wasms/out');

type AliasEntry = { wasm: string; aliases: string[] };
type Aliases = Record<string, AliasEntry>;
interface Manifest {
  generatedAt: string;
  source: string;
  grammars: Record<string, { file: string; abi: number | null; sha256: string; aliases: string[] }>;
}
interface BuildListEntry {
  name: string;
  subpath: string;
  parserCExists: boolean;
  helixLang: string | null;
}

const aliases = JSON.parse(readFileSync(path.join(repoRoot, 'tools/grammar-builder/aliases.json'), 'utf8')) as Aliases;
const manifest = JSON.parse(readFileSync(path.join(grammarsDir, 'manifest.json'), 'utf8')) as Manifest;
const languages = JSON.parse(
  readFileSync(path.join(repoRoot, 'packages/highlight/assets/languages.json'), 'utf8'),
) as Record<string, unknown>;

describe('aliases.json（helix 语言名 → tree-sitter-wasms 文件名映射）', () => {
  it('覆盖全部 36 个 tree-sitter-wasms 预编译 wasm（8MB 上限下全量纳入）', () => {
    expect(Object.keys(aliases).length).toBe(36);
  });

  it('helix 键对 languages.json 对齐；其余 4 键（objc/ql/systemrdl/embedded-template）为 wasm 语言标识', () => {
    for (const [lang, entry] of Object.entries(aliases)) {
      expect(existsSync(path.join(wasmsDir, `${entry.wasm}.wasm`)), `${entry.wasm}.wasm 应存在`).toBe(true);
      if (!languages[lang]) {
        expect(['objc', 'ql', 'systemrdl', 'embedded-template']).toContain(lang);
      }
    }
  });

  it('别名表可查：别名总数 ≥30（js/ts/py/rs/sh/c++/golang 等常见缩写）', () => {
    const all = Object.values(aliases).flatMap((e) => e.aliases);
    expect(all.length).toBeGreaterThanOrEqual(30);
    const flat = new Set(all);
    for (const a of ['js', 'ts', 'py', 'rs', 'sh', 'c++', 'golang', 'yml', 'rb']) {
      expect(flat.has(a), `常见别名 ${a} 应收录`).toBe(true);
    }
  });

  it('键序 = 高频优先（截断依据）：javascript 居首', () => {
    expect(Object.keys(aliases)[0]).toBe('javascript');
  });
});

describe('build-list（markpad grammar 源判据 src/parser.c）', () => {
  it('入选（parserCExists）≥ 250（markpad 278 个语法源实测 278 可建）', () => {
    const entries = buildList(SOURCES) as BuildListEntry[];
    const buildable = entries.filter((e) => e.parserCExists);
    expect(buildable.length).toBeGreaterThanOrEqual(250);
  });

  it('入库的 build-list.json 与重新计算一致（幂等、按 name 排序）', () => {
    const onDisk = JSON.parse(
      readFileSync(path.join(repoRoot, 'tools/grammar-builder/build-list.json'), 'utf8'),
    ) as BuildListEntry[];
    const fresh = buildList(SOURCES) as BuildListEntry[];
    expect(onDisk).toEqual(fresh);
    const names = onDisk.map((e) => e.name);
    expect(names).toEqual([...names].sort());
  });

  it('subpath 条目按子目录判定 parser.c（tsx → grammars/tsx/tsx；顶层无 src 时仅 subpath 命中）', () => {
    const entries = buildList(SOURCES) as BuildListEntry[];
    const tsx = entries.find((e) => e.name === 'tsx');
    expect(tsx?.subpath).toBe('tsx');
    expect(tsx?.parserCExists).toBe(true);
    // 抽样：subpath 非空的条目全部以子目录判据通过
    const withSub = entries.filter((e) => e.subpath !== '');
    expect(withSub.length).toBeGreaterThan(0);
    for (const e of withSub) {
      expect(detectParserC(SOURCES.grammarsDir, e.name, e.subpath)).toBe(true);
    }
  });
});

describe('manifest.json（--from-wasms 产物，入库）', () => {
  it('结构：generatedAt 为 ISO 时间、source 为 tree-sitter-wasms', () => {
    expect(manifest.source).toBe('tree-sitter-wasms');
    expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt);
  });

  it('覆盖全部 36 语言；32 个 helix 键与 languages.json 对齐', () => {
    const langs = Object.keys(manifest.grammars);
    expect(langs.length).toBe(36);
    for (const lang of langs) {
      if (!languages[lang]) expect(['objc', 'ql', 'systemrdl', 'embedded-template']).toContain(lang);
    }
  });

  it('每条目：abi 为 null（tree-sitter-wasms 未声明，运行时 web-tree-sitter 校验兜底）、sha256 为 64 位 hex、aliases 为数组', () => {
    for (const [lang, g] of Object.entries(manifest.grammars)) {
      expect(g.abi).toBeNull();
      expect(g.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Array.isArray(g.aliases)).toBe(true);
      expect(g.file).toBe(`${lang}.wasm`);
    }
  });

  it('每个 wasm 实际入库且 sha256 与文件一致', () => {
    for (const g of Object.values(manifest.grammars)) {
      const file = path.join(grammarsDir, g.file);
      expect(existsSync(file), `${g.file} 应入库`).toBe(true);
      expect(statSync(file).size).toBeLessThanOrEqual(MAX_FILE_BYTES);
      const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
      expect(digest).toBe(g.sha256);
    }
  });

  it('wasm 总体积 ≤ 80MB 入库上限', () => {
    let total = 0;
    for (const g of Object.values(manifest.grammars)) {
      total += statSync(path.join(grammarsDir, g.file)).size;
    }
    expect(total).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
  });
});

describe('buildFromWasms（隔离验证跳过与截断逻辑）', () => {
  it('单文件超限跳过并记录 skipped 清单（不产出该语言）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-gb-'));
    const wasms = path.join(dir, 'wasms');
    const out = path.join(dir, 'out');
    mkdirSync(wasms);
    writeFileSync(path.join(wasms, 'tree-sitter-big.wasm'), Buffer.alloc(4));
    writeFileSync(path.join(wasms, 'tree-sitter-huge.wasm'), Buffer.alloc(10));
    const result = buildFromWasms({
      aliases: {
        small: { wasm: 'tree-sitter-big', aliases: [] },
        huge: { wasm: 'tree-sitter-huge', aliases: [] },
        missing: { wasm: 'tree-sitter-nope', aliases: [] },
      },
      wasmsDir: wasms,
      outDir: out,
      manifestOut: path.join(out, 'manifest.json'),
      skippedOut: path.join(dir, 'skipped.json'),
      maxFileBytes: 5,
      maxTotalBytes: MAX_TOTAL_BYTES,
    });
    expect(Object.keys(result.manifest.grammars)).toEqual(['small']);
    const reasons = result.skipped.map((s) => `${s.lang}:${s.reason}`);
    expect(reasons.some((r) => r.startsWith('huge:file'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('missing:wasm not found'))).toBe(true);
  });

  it('总量超限时按 aliases 键序（高频优先）截断并记录 truncated', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-gb-'));
    const wasms = path.join(dir, 'wasms');
    const out = path.join(dir, 'out');
    mkdirSync(wasms);
    writeFileSync(path.join(wasms, 'tree-sitter-a.wasm'), Buffer.alloc(6));
    writeFileSync(path.join(wasms, 'tree-sitter-b.wasm'), Buffer.alloc(6));
    const result = buildFromWasms({
      aliases: {
        first: { wasm: 'tree-sitter-a', aliases: [] },
        second: { wasm: 'tree-sitter-b', aliases: [] },
      },
      wasmsDir: wasms,
      outDir: out,
      manifestOut: path.join(out, 'manifest.json'),
      skippedOut: path.join(dir, 'skipped.json'),
      maxFileBytes: MAX_FILE_BYTES,
      maxTotalBytes: 10,
    });
    expect(Object.keys(result.manifest.grammars)).toEqual(['first']);
    expect(result.truncated?.lang).toBe('second');
    expect(result.skipped).toHaveLength(1);
  });
});

describe('selfBuild（--self-build 备用路径）', () => {
  it('emcc 缺失时整批不执行：写 failure-list.json（reason: emcc not available）且不抛错', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-gb-'));
    const failureOut = path.join(dir, 'failure-list.json');
    const result = selfBuild({ emcc: null, failureOut });
    expect(result.mode).toBe('failure');
    const failures = JSON.parse(readFileSync(failureOut, 'utf8')) as { name: string; reason: string }[];
    expect(failures.length).toBeGreaterThanOrEqual(250);
    expect(failures.every((f) => f.reason === 'emcc not available')).toBe(true);
  });

  it('detectEmcc 返回字符串或 null（不抛错）', async () => {
    const { detectEmcc } = await import('../build.mjs');
    const emcc = detectEmcc();
    expect(emcc === null || typeof emcc === 'string').toBe(true);
  });
});
