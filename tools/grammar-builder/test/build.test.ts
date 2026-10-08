import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildList, detectParserC, SOURCES } from '../build-list.mjs';
import { buildFromWasms, selfBuild, MAX_FILE_BYTES, MAX_TOTAL_BYTES } from '../build.mjs';

const exec = promisify(execFileCb);

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
  // 数据源在仓库外（markpad grammars，随上游漂移且 fresh clone 必然缺失）：
  // 断言只依赖稳定部分——入库快照断结构、live 计算断幂等与 wiring、判据逻辑用合成
  // fixture 验证。快照与 live 源的严格一致不属测试契约（再生成由 build-list.mjs 手动跑）。
  const markpadAvailable = existsSync(SOURCES.grammarInfoJson) && existsSync(SOURCES.grammarsDir);

  it('入库 build-list.json 结构稳定：按 name 排序、条目形状正确、可建数 ≥250（生成时点快照）', () => {
    const onDisk = JSON.parse(
      readFileSync(path.join(repoRoot, 'tools/grammar-builder/build-list.json'), 'utf8'),
    ) as BuildListEntry[];
    expect(onDisk.length).toBeGreaterThanOrEqual(250);
    const names = onDisk.map((e) => e.name);
    expect(names).toEqual([...names].sort());
    for (const e of onDisk) {
      expect(typeof e.name).toBe('string');
      expect(typeof e.subpath).toBe('string');
      expect(typeof e.parserCExists).toBe('boolean');
      expect(e.helixLang === null || typeof e.helixLang === 'string').toBe(true);
    }
    expect(onDisk.filter((e) => e.parserCExists).length).toBeGreaterThanOrEqual(250);
  });

  it.skipIf(!markpadAvailable)(
    'buildList 对当前源幂等且结构正确（与入库快照解耦，上游漂移不致失败）',
    () => {
      const first = buildList(SOURCES) as BuildListEntry[];
      const second = buildList(SOURCES) as BuildListEntry[];
      expect(second).toEqual(first); // 幂等：同源两次计算一致
      const names = first.map((e) => e.name);
      expect(names).toEqual([...names].sort());
      // 条目覆盖 grammar_info 全部键；flag 与判据函数一致（wiring 正确，不预设源文件存在与否）
      const grammarInfo = JSON.parse(readFileSync(SOURCES.grammarInfoJson, 'utf8')) as Record<
        string,
        unknown
      >;
      expect(first.length).toBe(Object.keys(grammarInfo).length);
      for (const e of first) {
        expect(e.helixLang === null || typeof e.helixLang === 'string').toBe(true);
        expect(e.parserCExists).toBe(detectParserC(SOURCES.grammarsDir, e.name, e.subpath));
      }
    },
  );

  it('subpath 判据用合成 fixture 验证：顶层 src 命中、subpath 指向子目录命中、无 src 不命中', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-gb-bl-'));
    const grammars = path.join(dir, 'grammars');
    // tsx：markpad 形态——顶层目录无 src，仅子目录 grammars/tsx/tsx/src 有 parser.c
    mkdirSync(path.join(grammars, 'tsx', 'tsx', 'src'), { recursive: true });
    writeFileSync(path.join(grammars, 'tsx', 'tsx', 'src', 'parser.c'), 'int main(void){return 0;}');
    mkdirSync(path.join(grammars, 'top', 'src'), { recursive: true });
    writeFileSync(path.join(grammars, 'top', 'src', 'parser.c'), 'int main(void){return 0;}');
    mkdirSync(path.join(grammars, 'bare')); // 无 src → 不命中
    const grammarInfoJson = path.join(dir, 'grammar_info.json');
    writeFileSync(grammarInfoJson, JSON.stringify({ tsx: { subpath: 'tsx' }, top: {}, bare: {} }));
    const entries = buildList({
      languagesJson: SOURCES.languagesJson,
      grammarInfoJson,
      grammarsDir: grammars,
    }) as BuildListEntry[];
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get('tsx')).toMatchObject({ subpath: 'tsx', parserCExists: true });
    expect(byName.get('top')).toMatchObject({ subpath: '', parserCExists: true });
    expect(byName.get('bare')).toMatchObject({ subpath: '', parserCExists: false });
    for (const e of entries) {
      expect(e.parserCExists).toBe(detectParserC(grammars, e.name, e.subpath));
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

// ---------- --fetch / --merge-manifest（L1：CI self-build 门禁的输入与产物合并） ----------
import {
  parseGrammarSources,
  planFetch,
  fetchGrammarSources,
  mergeManifest,
  PATHS
} from '../build.mjs';

describe('parseGrammarSources / planFetch（vendored languages.toml 与 build-list 的 join）', () => {
  it('vendored languages.toml：[[grammar]] 解析出 git/rev/subpath', () => {
    const sources = parseGrammarSources(readFileSync(PATHS.languagesToml, 'utf8'));
    const ts = sources.get('typescript');
    expect(ts?.git).toBe('https://github.com/tree-sitter/tree-sitter-typescript');
    expect(ts?.rev).toMatch(/^[0-9a-f]{40}$/);
    expect(ts?.subpath).toBe('typescript');
    const rust = sources.get('rust');
    expect(rust?.subpath ?? '').toBe('');
  });

  it('planFetch：build-list 全部可建条目都能在 vendored toml 找到源（CI fetch 输入完整性契约）', () => {
    const sources = parseGrammarSources(readFileSync(PATHS.languagesToml, 'utf8'));
    const buildList = JSON.parse(
      readFileSync(path.join(repoRoot, 'tools/grammar-builder/build-list.json'), 'utf8'),
    ) as { name: string; subpath: string; parserCExists: boolean }[];
    const { plan, missing } = planFetch(buildList.filter((e) => e.parserCExists), sources);
    expect(missing).toEqual([]);
    expect(plan.length).toBeGreaterThanOrEqual(250);
    for (const p of plan) {
      expect(p.git).toMatch(/^https:\/\//);
      expect(p.rev).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof p.subpath).toBe('string');
    }
  });

  it('planFetch：toml 缺源的条目记入 missing（fetch 前即知）', () => {
    const { plan, missing } = planFetch(
      [{ name: 'known', subpath: '', parserCExists: true, helixLang: null }],
      new Map([['known', { git: 'https://x/y', rev: 'a'.repeat(40), subpath: '' }]]),
    );
    expect(plan).toHaveLength(1);
    expect(missing).toEqual([]);
    const { missing: missing2 } = planFetch(
      [{ name: 'unknown', subpath: '', parserCExists: true, helixLang: null }],
      new Map(),
    );
    expect(missing2[0]?.name).toBe('unknown');
  });
});

describe('fetchGrammarSources（本地 git fixture 验证 clone/copy 逻辑，不依赖网络）', () => {
  it('浅取源仓并按 subpath 同构落盘：顶层与子目录两形态 + parser.c 判据 + 失败清单继续', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-gb-fetch-'));
    // fixture 仓库：顶层 src/parser.c 的 top 与子目录 tsx/src/parser.c 的 tsx 同仓两形态
    const repoA = path.join(dir, 'repoA');
    const repoB = path.join(dir, 'repoB');
    for (const [repo, layout] of [
      [repoA, 'top'],
      [repoB, 'tsx'],
    ] as const) {
      const base = layout === 'top' ? path.join(repo, 'src') : path.join(repo, 'tsx', 'src');
      mkdirSync(base, { recursive: true });
      writeFileSync(path.join(base, 'parser.c'), 'int main(void){return 0;}');
      writeFileSync(path.join(repo, '.gitignore'), '');
      await exec('git', ['init', '-q', repo]);
      await exec('git', ['-C', repo, 'add', '-A']);
      await exec('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    }
    const revA = (await exec('git', ['-C', repoA, 'rev-parse', 'HEAD'])).stdout.trim();
    const plan = [
      { name: 'top', subpath: '', git: repoA, rev: revA },
      { name: 'tsx', subpath: 'tsx', git: repoB, rev: (await exec('git', ['-C', repoB, 'rev-parse', 'HEAD'])).stdout.trim() },
      { name: 'nope', subpath: '', git: repoA, rev: 'f'.repeat(40) }, // 仓库无此 rev → 失败继续
    ];
    const outDir = path.join(dir, 'grammars');
    const { fetched, failures } = await fetchGrammarSources({
      plan,
      outDir,
      failuresOut: path.join(dir, 'fetch-failures.json'),
      concurrency: 2,
    });
    expect(fetched).toBe(2);
    expect(failures.map((f) => f.name)).toEqual(['nope']);
    // 同构源树：outDir/<name>/<subpath>/src/parser.c（--self-build 的探测路径）
    expect(existsSync(path.join(outDir, 'top', 'src', 'parser.c'))).toBe(true);
    expect(existsSync(path.join(outDir, 'tsx', 'tsx', 'src', 'parser.c'))).toBe(true);
    // .git 不随拷贝
    expect(existsSync(path.join(outDir, 'top', '.git'))).toBe(false);
    // 失败清单落盘
    const recorded = JSON.parse(readFileSync(path.join(dir, 'fetch-failures.json'), 'utf8')) as { name: string }[];
    expect(recorded.map((f) => f.name)).toEqual(['nope']);
    // 幂等重跑：已就位的源树跳过
    const second = await fetchGrammarSources({
      plan,
      outDir,
      failuresOut: path.join(dir, 'fetch-failures.json'),
      concurrency: 2,
    });
    expect(second.fetched).toBe(0);
    expect(second.skipped).toBe(2);
  }, 30_000);
});

describe('mergeManifest（self-build 产物与预编译集合并）', () => {
  it('同名键覆盖 + source 标 self-built + sha256 重算；超 8MB 上限跳过', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-gb-mm-'));
    const selfDir = path.join(dir, 'self');
    const outDir = path.join(dir, 'out');
    mkdirSync(selfDir);
    mkdirSync(outDir);
    // 既有预编译集合：javascript（将被 self-build 覆盖）与 python（保留）
    writeFileSync(path.join(outDir, 'javascript.wasm'), Buffer.alloc(8, 1));
    writeFileSync(path.join(outDir, 'python.wasm'), Buffer.alloc(4, 2));
    const manifestOut = path.join(outDir, 'manifest.json');
    writeFileSync(
      manifestOut,
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        source: 'tree-sitter-wasms',
        grammars: {
          javascript: { file: 'javascript.wasm', abi: null, sha256: '0'.repeat(64), aliases: ['js'] },
          python: { file: 'python.wasm', abi: null, sha256: '1'.repeat(64), aliases: ['py'] }
        }
      }),
    );
    // self-build 产物：javascript（覆盖，10B < 12B 上限）+ racket（新键，aliases 从 aliases.json 兜底）+ huge（超限跳过）
    writeFileSync(path.join(selfDir, 'javascript.wasm'), Buffer.alloc(10, 3));
    writeFileSync(path.join(selfDir, 'racket.wasm'), Buffer.alloc(8, 4));
    writeFileSync(path.join(selfDir, 'huge.wasm'), Buffer.alloc(16, 5));

    const { manifest, merged, skipped } = mergeManifest({
      selfDir,
      outDir,
      manifestOut,
      aliases: { racket: { wasm: 'tree-sitter-racket', aliases: ['rkt'] } },
      maxFileBytes: 12,
    });
    expect(manifest.source).toBe('tree-sitter-wasms+self-built');
    expect(merged.sort()).toEqual(['javascript', 'racket']);
    expect(skipped.map((s) => s.lang)).toEqual(['huge']);
    // 覆盖键：内容与 sha256 刷新为 self-build 产物，aliases 沿用既有登记
    expect(manifest.grammars.javascript!.aliases).toEqual(['js']);
    expect(manifest.grammars.javascript!.source).toBe('self-built');
    expect(manifest.grammars.javascript!.sha256).not.toBe('0'.repeat(64));
    // 保留键不动（source 字段缺省 = 预编译集）
    expect(manifest.grammars.python!.sha256).toBe('1'.repeat(64));
    expect(manifest.grammars.python!.source).toBeUndefined();
    // 新键：aliases 从 aliases.json 兜底
    expect(manifest.grammars.racket!.aliases).toEqual(['rkt']);
    // 覆盖拷贝真实发生
    expect(readFileSync(path.join(outDir, 'javascript.wasm')).length).toBe(10);
    expect(existsSync(path.join(outDir, 'huge.wasm'))).toBe(false);
  });
});
