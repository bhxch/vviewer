import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildList, detectParserC, SOURCES } from '../build-list.mjs';
import {
  resolveTargets,
  selfBuild,
  writeManifest,
  detectTreeSitter,
  resolveTreeSitterBin,
  parseGrammarSources,
  planFetch,
  fetchGrammarSources,
  PATHS,
  WARN_FILE_BYTES,
} from '../build.mjs';

const exec = promisify(execFileCb);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const grammarsDir = path.join(repoRoot, 'apps/web/static/grammars');
const manifestPath = path.join(grammarsDir, 'manifest.json');

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
const languages = JSON.parse(
  readFileSync(path.join(repoRoot, 'packages/highlight/assets/languages.json'), 'utf8'),
) as Record<string, unknown>;

describe('aliases.json（lite 集键表：helix 语言名 → grammar 名/别名）', () => {
  it('覆盖 36 个原 tree-sitter-wasms 预编译语言（键表保留完整映射语义）', () => {
    expect(Object.keys(aliases).length).toBe(36);
  });

  it('helix 键对 languages.json 对齐；其余 4 键（objc/ql/systemrdl/embedded-template）为 wasm 语言标识', () => {
    for (const lang of Object.keys(aliases)) {
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

  it('键序 = 高频优先：javascript 居首', () => {
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

describe('resolveTargets（选择面：lite / all / 显式点名，自建主路径的输入）', () => {
  // 真实 vendored 数据上的契约：objc/systemrdl 无查询资产且 helix 未收录（无源可取），
  // lite 集不产出；swift 不在 build-list 快照内，靠 languages.toml [[grammar]] 兜底解析。
  it('lite：真实 build-list + languages.toml 下解析出 ≥34 语言；仅 objc/systemrdl 未解析', () => {
    const buildListOnDisk = JSON.parse(
      readFileSync(PATHS.buildListJson, 'utf8'),
    ) as BuildListEntry[];
    const sources = parseGrammarSources(readFileSync(PATHS.languagesToml, 'utf8'));
    const { targets, unresolved } = resolveTargets(buildListOnDisk, 'lite', aliases, sources);
    const names = new Set(targets.map((t) => t.name));
    expect(unresolved.sort()).toEqual(['objc', 'systemrdl']);
    expect(targets.length).toBeGreaterThanOrEqual(34);
    expect(names.has('javascript')).toBe(true);
    expect(names.has('swift')).toBe(true); // build-list 快照缺失，toml 兜底
    const swift = targets.find((t) => t.name === 'swift');
    expect(swift?.subpath ?? '').toBe('');
  });

  it('_/- 命名变体归一：c-sharp 经 build-list 命中', () => {
    const buildList = [
      { name: 'c-sharp', subpath: '', parserCExists: true, helixLang: 'c-sharp' },
    ] as BuildListEntry[];
    const { targets, unresolved } = resolveTargets(buildList, ['c_sharp'], {}, new Map());
    expect(targets).toEqual([{ name: 'c-sharp', subpath: '' }]);
    expect(unresolved).toEqual([]);
  });

  it('aliases wasm 字段兜底：build-list 与 toml 均无同名列时按 tree-sitter-<repo> 推导', () => {
    const sources = new Map([['objc', { git: 'https://x/objc', rev: 'a', subpath: 'sub' }]]);
    const { targets, unresolved } = resolveTargets([], ['objc'], { objc: { wasm: 'tree-sitter-objc', aliases: [] } }, sources);
    expect(targets).toEqual([{ name: 'objc', subpath: 'sub' }]);
    expect(unresolved).toEqual([]);
  });

  it('all：build-list 全部可建项 + aliases 可解析补充；不可解析键进 unresolved 不致命', () => {
    const buildList = [
      { name: 'a', subpath: '', parserCExists: true, helixLang: 'a' },
      { name: 'b', subpath: 'x', parserCExists: true, helixLang: null },
      { name: 'dead', subpath: '', parserCExists: false, helixLang: null },
    ] as BuildListEntry[];
    const sources = new Map([['swift', { git: 'https://x/s', rev: 'a', subpath: '' }]]);
    const { targets, unresolved } = resolveTargets(
      buildList,
      'all',
      { swift: { wasm: 'tree-sitter-swift', aliases: [] } },
      sources,
    );
    expect(targets.map((t) => t.name).sort()).toEqual(['a', 'b', 'swift']); // dead 不可建不进；swift 补充
    expect(unresolved).toEqual([]);
  });
});

describe('selfBuild（--self-build 主路径：stub tree-sitter CLI 全链路）', () => {
  const FIX_ALIAS: Aliases = {
    javascript: { wasm: 'tree-sitter-javascript', aliases: ['js'] },
    swift: { wasm: 'tree-sitter-swift', aliases: [] },
    bad: { wasm: 'tree-sitter-bad', aliases: [] },
    objc: { wasm: 'tree-sitter-objc', aliases: ['objective-c'] },
  };
  const FIX_LIST: BuildListEntry[] = [
    { name: 'javascript', subpath: '', parserCExists: true, helixLang: 'javascript' },
    { name: 'bad', subpath: '', parserCExists: true, helixLang: null },
  ];
  const FIX_TOML = '[[grammar]]\nname = "swift"\nsource = { git = "https://x/swift", rev = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }\n';

  function fixture() {
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-gb-sb-'));
    const srcDir = path.join(dir, 'grammars');
    for (const name of ['javascript', 'swift', 'bad']) {
      mkdirSync(path.join(srcDir, name, 'src'), { recursive: true });
      writeFileSync(path.join(srcDir, name, 'src', 'parser.c'), 'int main(void){return 0;}');
    }
    const buildListJson = path.join(dir, 'build-list.json');
    writeFileSync(buildListJson, JSON.stringify(FIX_LIST));
    const languagesTomlPath = path.join(dir, 'languages.toml');
    writeFileSync(languagesTomlPath, FIX_TOML);
    // stub tree-sitter：写 4 字节产物；cwd 含 bad 段时失败（模拟单 grammar 编译失败）
    const binDir = path.join(dir, 'bin');
    mkdirSync(binDir);
    const stub = path.join(binDir, 'tree-sitter');
    writeFileSync(
      stub,
      [
        '#!/usr/bin/env node',
        "if (process.argv.includes('--version')) { console.log('tree-sitter 0.0.0-stub'); process.exit(0); }",
        'const i = process.argv.indexOf("--output");',
        'if (i === -1) process.exit(2);',
        'const out = process.argv[i + 1];',
        'if (process.cwd().split(require("path").sep).includes("bad")) { console.error("stub boom"); process.exit(1); }',
        'require("node:fs").writeFileSync(out, Buffer.from([1, 2, 3, 4]));',
        '',
      ].join('\n'),
    );
    chmodSync(stub, 0o755);
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
    const common = {
      buildListJson,
      grammarsDir: srcDir,
      languagesTomlPath,
      aliases: FIX_ALIAS,
      env,
      treeSitterBin: stub,
    };
    return { dir, common, outDir: path.join(dir, 'static') };
  }

  it('lite：build-list + toml 兜底解析并构建，manifest 整表重写（source self-built、aliases、sha256）', async () => {
    const { dir, common, outDir } = fixture();
    const r = await selfBuild({ ...common, selection: 'lite', failureOut: path.join(dir, 'f.json'), manifestOut: path.join(outDir, 'manifest.json'), outDir });
    expect(r.mode).toBe('built');
    expect(r.built).toBe(2); // javascript + swift；objc 无源未解析、bad stub 构建失败
    expect(r.failures.map((f) => f.name)).toEqual(['bad']);
    const manifest = JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8')) as Manifest;
    expect(manifest.source).toBe('self-built');
    expect(Object.keys(manifest.grammars).sort()).toEqual(['javascript', 'swift']);
    expect(manifest.grammars.javascript!.aliases).toEqual(['js']);
    expect(manifest.grammars.javascript!.file).toBe('javascript.wasm');
    expect(manifest.grammars.javascript!.abi).toBeNull();
    expect(manifest.grammars.javascript!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(path.join(outDir, 'swift.wasm'))).toBe(true);
  });

  it('vendored 命中短路：不可再生语言直接拷贝 fixtures 产物并标 source vendored', async () => {
    const { dir, common, outDir } = fixture();
    const vendoredDir = path.join(dir, 'vendored');
    mkdirSync(vendoredDir);
    writeFileSync(path.join(vendoredDir, 'swift.wasm'), Buffer.from([9, 9, 9, 9]));
    const r = await selfBuild({
      ...common,
      selection: ['javascript', 'swift'],
      vendoredDir,
      failureOut: path.join(dir, 'f.json'),
      manifestOut: path.join(outDir, 'manifest.json'),
      outDir,
    });
    expect(r.vendored).toBe(1); // swift 走 vendored
    expect(r.built).toBe(1); // javascript 走 stub 构建
    expect(readFileSync(path.join(outDir, 'swift.wasm')).toString()).toBe(Buffer.from([9, 9, 9, 9]).toString());
    const manifest = JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8')) as Manifest;
    expect(manifest.grammars.swift!.source).toBe('vendored');
    expect(manifest.grammars.javascript!.source).toBeUndefined();
  });

  it('幂等：已存在 wasm 跳过；--force 重建', async () => {
    const { dir, common, outDir } = fixture();
    const args = { selection: ['javascript'] as string[], failureOut: path.join(dir, 'f.json'), manifestOut: path.join(outDir, 'manifest.json'), outDir };
    const first = await selfBuild({ ...common, ...args });
    expect(first.built).toBe(1);
    const second = await selfBuild({ ...common, ...args });
    expect(second.built).toBe(0);
    expect(second.skipped).toBe(1);
    const forced = await selfBuild({ ...common, ...args, force: true });
    expect(forced.built).toBe(1);
  });

  it('CLI 缺失：整批不执行（failure 模式，清单 reason: tree-sitter CLI not available）且不抛错', async () => {
    const { dir, common, outDir } = fixture();
    const failureOut = path.join(dir, 'failure-list.json');
    const r = await selfBuild({
      ...common,
      treeSitterBin: path.join(dir, 'no-such-bin'),
      selection: 'lite',
      failureOut,
      manifestOut: path.join(outDir, 'manifest.json'),
      outDir,
    });
    expect(r.mode).toBe('failure');
    const failures = JSON.parse(readFileSync(failureOut, 'utf8')) as { name: string; reason: string }[];
    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(failures.every((f) => f.reason === 'tree-sitter CLI not available')).toBe(true);
  });

  it('detectTreeSitter 返回布尔（不抛错）；resolveTreeSitterBin 优先仓库内 .bin', () => {
    expect(typeof detectTreeSitter()).toBe('boolean');
    expect(resolveTreeSitterBin('/nonexistent-root')).toBe('tree-sitter');
    expect(resolveTreeSitterBin(repoRoot)).toContain('node_modules/.bin/tree-sitter');
  });
});

describe('writeManifest（目录即事实源：按现存 *.wasm 全量重写）', () => {
  it('排序稳定、aliases 从 aliases.json 兜底、sha256 与文件一致', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-gb-wm-'));
    writeFileSync(path.join(dir, 'b.wasm'), Buffer.from([1]));
    writeFileSync(path.join(dir, 'a.wasm'), Buffer.from([2]));
    writeFileSync(path.join(dir, 'ignore.txt'), Buffer.from([3]));
    const manifestPath2 = path.join(dir, 'manifest.json');
    const m = writeManifest(dir, manifestPath2, { a: { wasm: 'tree-sitter-a', aliases: ['aa'] } }) as Manifest;
    expect(Object.keys(m.grammars)).toEqual(['a', 'b']);
    expect(m.source).toBe('self-built');
    expect(m.grammars.a!.aliases).toEqual(['aa']);
    expect(m.grammars.b!.aliases).toEqual([]);
    expect(new Date(m.generatedAt).toISOString()).toBe(m.generatedAt);
    const onDisk = JSON.parse(readFileSync(manifestPath2, 'utf8')) as Manifest;
    expect(onDisk.grammars.a!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('manifest.json（--self-build 构建产物；本机生成后校验结构与一致性，fresh clone 跳过）', () => {
  it.skipIf(!existsSync(manifestPath))('结构：source self-built、generatedAt 为 ISO 时间', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    expect(manifest.source).toBe('self-built');
    expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt);
  });

  it.skipIf(!existsSync(manifestPath))('每个 wasm 实际存在且 sha256 一致、文件名与键对齐、覆盖 ≥34 语言', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    expect(Object.keys(manifest.grammars).length).toBeGreaterThanOrEqual(34);
    for (const [lang, g] of Object.entries(manifest.grammars)) {
      const file = path.join(grammarsDir, g.file);
      expect(existsSync(file), `${g.file} 应存在`).toBe(true);
      expect(g.file).toBe(`${lang}.wasm`);
      const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
      expect(digest).toBe(g.sha256);
    }
  });

  it.skipIf(!existsSync(manifestPath))('vendored 条目（yaml/vue）标 source vendored', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    for (const lang of ['yaml', 'vue']) {
      if (manifest.grammars[lang]) expect(manifest.grammars[lang]!.source).toBe('vendored');
    }
  });
});

// ---------- --fetch（CI 源获取：vendored languages.toml 与选择面的 join） ----------

describe('parseGrammarSources / planFetch（vendored languages.toml 与目标的 join）', () => {
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
    const onDisk = JSON.parse(
      readFileSync(path.join(repoRoot, 'tools/grammar-builder/build-list.json'), 'utf8'),
    ) as { name: string; subpath: string; parserCExists: boolean }[];
    const { plan, missing } = planFetch(onDisk.filter((e) => e.parserCExists), sources);
    expect(missing).toEqual([]);
    expect(plan.length).toBeGreaterThanOrEqual(250);
    for (const p of plan) {
      expect(p.git).toMatch(/^https:\/\//);
      expect(p.rev).toMatch(/^[0-9a-f]{40}$/);
      expect(typeof p.subpath).toBe('string');
    }
  });

  it('planFetch：缺源的条目记入 missing（fetch 前即知）', () => {
    const { plan, missing } = planFetch(
      [{ name: 'known', subpath: '' }],
      new Map([['known', { git: 'https://x/y', rev: 'a'.repeat(40), subpath: '' }]]),
    );
    expect(plan).toHaveLength(1);
    expect(missing).toEqual([]);
    const { missing: missing2 } = planFetch([{ name: 'unknown', subpath: '' }], new Map());
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
