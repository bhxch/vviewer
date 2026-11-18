// gen-sources.test.ts — 单源生成器（spec F 构建源头化）测试。
// 迁移纪律：纯函数用例自 tools/helix-assets/test/generate.test.ts 与
// gen-code-extensions.test.ts 迁入（签名不变、断言等价）；盘态守门断言按计划
// Review Focus 6 / 验收锚 ⑧ 口径迁入——tags 基线 ≥56（一层 readdirSync 口径，F4）、
// javascript/_javascript tags 双形态一致性（F1：现盘旧形态=自含实体仅锁存在，regen 后
// 新形态=继承声明锁 _javascript/tags.scm 活资产）；TAGS_SOURCES.langs 相关断言随机制
// 整体退役不迁移（Errata ⑨/⑬）。
import { describe, expect, it, vi, afterEach } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALIASES_KNOWN_MISSING,
  BUILTIN_PALETTE,
  QUERY_PATCHES,
  applyQueryPatches,
  applyGrammarSourceOverrides,
  cSymbolOf,
  collectExtensions,
  collectThemes,
  deriveBuildList,
  deriveServerManifest,
  annotateManifestQueries,
  diffReport,
  exceptGrammars,
  fetchHelixTree,
  fetchPinLanguagesToml,
  main,
  parseGrammarSources,
  parseLanguages,
  parseTheme,
  pullQueries,
  pullThemes,
  readPin,
  resolveMasterHead,
  toModule,
  validateAliases,
  validatePin,
  verify,
  writePin,
} from '../gen-sources.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const assetsDir = path.join(repoRoot, 'packages/vviewer-highlight/assets');
const fixtureDir = path.join(here, 'fixtures/gen-sources');
const fixtureTomlText = readFileSync(path.join(fixtureDir, 'languages.toml'), 'utf8');
const fixtureDoc = parseToml(fixtureTomlText);
const fixtureLangs = parseLanguages(fixtureTomlText);
const fixtureExcept = exceptGrammars(fixtureDoc);

// ① pin 校验 ----------------------------------------------------------------

describe('pin（helix-pin.json 读写与校验）', () => {
  const VALID = { ref: 'master', commit: 'a'.repeat(40), release: '', refreshedAt: '2026-11-17T00:00:00.000Z' };

  it('validatePin：合法 pin 通过且字段齐全', () => {
    expect(() => validatePin(VALID)).not.toThrow();
    expect(validatePin(VALID)).toMatchObject({ ref: 'master', commit: 'a'.repeat(40) });
  });

  it('validatePin：缺字段（ref/commit/release/refreshedAt）显式报错并指向 --refresh', () => {
    for (const field of ['ref', 'commit', 'release', 'refreshedAt']) {
      const broken = { ...VALID } as Record<string, unknown>;
      delete broken[field];
      expect(() => validatePin(broken as never), `缺 ${field}`).toThrow(/--refresh/);
    }
  });

  it('validatePin：commit 非 40hex 报错（禁分支名/短 sha）', () => {
    for (const bad of ['master', 'a'.repeat(39), 'A'.repeat(40), '']) {
      expect(() => validatePin({ ...VALID, commit: bad }), `commit=${bad}`).toThrow(/--refresh/);
    }
  });

  it('readPin：缺文件报错指向 --refresh（首跑初始化语义）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-pin-'));
    expect(() => readPin(path.join(dir, 'helix-pin.json'))).toThrow(/--refresh/);
  });

  it('readPin：JSON 损坏报错指向 --refresh；合法文件读回结构一致', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-pin-'));
    const pinPath = path.join(dir, 'helix-pin.json');
    writeFileSync(pinPath, '{ not json');
    expect(() => readPin(pinPath)).toThrow(/--refresh/);
    writeFileSync(pinPath, `${JSON.stringify(VALID, null, 2)}\n`);
    expect(readPin(pinPath)).toEqual(VALID);
  });

  it('writePin：原子落盘，形态 = { ref: master, commit 40hex, release 空, refreshedAt ISO }', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-pin-'));
    const pinPath = path.join(dir, 'helix-pin.json');
    const pin = writePin(pinPath, 'b'.repeat(40));
    expect(pin.commit).toBe('b'.repeat(40));
    expect(pin.ref).toBe('master');
    expect(pin.release).toBe('');
    expect(new Date(pin.refreshedAt).toISOString()).toBe(pin.refreshedAt);
    expect(JSON.parse(readFileSync(pinPath, 'utf8'))).toEqual(pin);
  });
});

// ② [[grammar]] 多形态派生（fixture）------------------------------------------------

describe('deriveBuildList / deriveServerManifest（[[grammar]] 派生：全集 − use-grammars.except）', () => {
  it('exceptGrammars 读取 use-grammars.except（wren/gemini）', () => {
    expect(fixtureExcept).toEqual(['wren', 'gemini']);
  });

  it('build-list 形态逐字段锚（name/subpath/parserCExists/helixLang），except 剔除 wren/gemini', () => {
    expect(deriveBuildList(fixtureDoc, fixtureExcept)).toEqual([
      { name: 'c-sharp', subpath: '', parserCExists: true, helixLang: 'c-sharp' },
      { name: 'orphan-grammar', subpath: 'crates/tree-sitter-orphan', parserCExists: true, helixLang: 'orphan-grammar' },
      { name: 'rust', subpath: '', parserCExists: true, helixLang: 'rust' },
      { name: 'typescript', subpath: 'typescript', parserCExists: true, helixLang: 'typescript' },
      { name: 'vue', subpath: '', parserCExists: true, helixLang: 'vue' },
    ]);
  });

  it('manifest 含 vue（Review Focus 1：vue 入 manifest，wasm 走 fixtures 短路另一通道）、不含 wren/gemini', () => {
    const manifest = deriveServerManifest(fixtureDoc, fixtureExcept);
    const names = manifest.grammars.map((g: { name: string }) => g.name);
    expect(names).toContain('vue');
    expect(names).not.toContain('wren');
    expect(names).not.toContain('gemini');
  });

  it('manifest 形态：{ note, generatedAt, grammars: [{name, dir: name, subpath, cSymbol}] }（build.rs serde 零变化）', () => {
    const manifest = deriveServerManifest(fixtureDoc, fixtureExcept);
    expect(manifest.note).toContain('gen-sources.mjs');
    expect(manifest.note).toContain('动态门禁');
    expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt);
    expect(manifest.grammars).toEqual([
      { name: 'c-sharp', dir: 'c-sharp', subpath: '', cSymbol: 'tree_sitter_c_sharp' },
      { name: 'orphan-grammar', dir: 'orphan-grammar', subpath: 'crates/tree-sitter-orphan', cSymbol: 'tree_sitter_orphan_grammar' },
      { name: 'rust', dir: 'rust', subpath: '', cSymbol: 'tree_sitter_rust' },
      { name: 'typescript', dir: 'typescript', subpath: 'typescript', cSymbol: 'tree_sitter_typescript' },
      { name: 'vue', dir: 'vue', subpath: '', cSymbol: 'tree_sitter_vue' },
    ]);
  });
});

describe('annotateManifestQueries（server manifest 查询资产存在性标注）', () => {
  // 上游 helix master 删了 17 个语言的 runtime/queries 目录 → 这些语言「注册但无
  // highlights」→ 服务端返回 200 + 空区间（客户端判成功 → 完全无高亮且不降级 hljs）。
  // 标注后服务端注册表按此过滤，动态门禁的期望注册数亦按此计。
  it('有 highlights.scm 标 true；缺目录/空文件标 false（纯函数，入参不改）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-annotate-'));
    mkdirSync(path.join(dir, 'rust'), { recursive: true });
    writeFileSync(path.join(dir, 'rust', 'highlights.scm'), '(x) @k\n');
    mkdirSync(path.join(dir, 'blank'), { recursive: true });
    writeFileSync(path.join(dir, 'blank', 'highlights.scm'), '');
    const manifest = {
      note: 'n',
      generatedAt: '2026-01-01T00:00:00.000Z',
      grammars: [
        { name: 'rust', dir: 'rust', subpath: '', cSymbol: 'tree_sitter_rust' },
        { name: 'blank', dir: 'blank', subpath: '', cSymbol: 'tree_sitter_blank' },
        { name: 'missing', dir: 'missing', subpath: '', cSymbol: 'tree_sitter_missing' },
      ],
    };
    const out = annotateManifestQueries(manifest, dir);
    expect(out.grammars.map((g: { queries: boolean }) => g.queries)).toEqual([true, false, false]);
    // 其余字段逐字保留
    expect(out.grammars[0]).toEqual({
      name: 'rust',
      dir: 'rust',
      subpath: '',
      cSymbol: 'tree_sitter_rust',
      queries: true,
    });
    // 入参未被改写（纯函数）
    expect((manifest.grammars[0] as { queries?: boolean }).queries).toBeUndefined();
  });
});

describe('applyGrammarSourceOverrides（grammar 源覆盖：yaml → C 外置 scanner 源）', () => {
  // helix master 的 yaml 源是 ikatyang（C++ scanner.cc）→ cli wasm 工具链不可编译 →
  // yaml.wasm 不产出（BUG-37 回退，yaml 恒降级 hljs）。覆盖为 tree-sitter-grammars
  // fork v0.7.2（C scanner.c，cli 0.27 自建成功）。
  it('yaml 源被覆盖为 tree-sitter-grammars fork；已覆盖形态幂等；失配抛错要求人工复核', () => {
    const toml =
      '[[grammar]]\nname = "yaml"\n' +
      'source = { git = "https://github.com/ikatyang/tree-sitter-yaml", rev = "0e36bed171768908f331ff7dff9d956bae016efb" }\n';
    const out = applyGrammarSourceOverrides(toml);
    expect(out).toContain('https://github.com/tree-sitter-grammars/tree-sitter-yaml');
    expect(out).not.toContain('ikatyang');
    // 幂等：重复应用不报错、文本不变
    expect(applyGrammarSourceOverrides(out)).toBe(out);
    // 清单里无该 grammar 块（夹具/精简清单）→ 跳过，不抛错
    expect(applyGrammarSourceOverrides('[[grammar]]\nname = "rust"\nsource = { git = "x", rev = "y" }\n')).toBe(
      '[[grammar]]\nname = "rust"\nsource = { git = "x", rev = "y" }\n'
    );
    // 有 yaml 块但源形态变了（上游改源）→ 抛错要求人工复核，不静默放过
    expect(() =>
      applyGrammarSourceOverrides('[[grammar]]\nname = "yaml"\nsource = { git = "https://other/yaml", rev = "deadbeef" }\n')
    ).toThrow(/grammar 源覆盖失配/);
  });
});

// ③ cSymbol 派生规约（spec F §8）----------------------------------------------------
describe('cSymbolOf（tree_sitter_<name，-→_> 派生规约）', () => {
  it('-→_ 变换', () => {
    expect(cSymbolOf('c-sharp')).toBe('tree_sitter_c_sharp');
    expect(cSymbolOf('rust')).toBe('tree_sitter_rust');
    expect(cSymbolOf('markdown_inline')).toBe('tree_sitter_markdown_inline');
  });

  it('fixture manifest 全条目符合规约（fetch 后由 build.mjs 从 parser.c 交叉验证）', () => {
    for (const g of deriveServerManifest(fixtureDoc, fixtureExcept).grammars) {
      expect(g.cSymbol).toMatch(/^tree_sitter_[a-z0-9_]+$/);
      expect(g.cSymbol).toBe(cSymbolOf(g.name));
    }
  });
});

// ④/⑤ languages.json / generated-extensions / manifest 快照锚（fixture 派生输出）------

describe('parseLanguages（[[language]] 派生 languages.json——纯函数自 generate.mjs 原样迁）', () => {
  it('fixture 派生快照：值域字段、glob 归 globFileTypes、grammar 缺省=name、aliases 透传', () => {
    expect(fixtureLangs).toEqual({
      rust: {
        scope: 'source.rust',
        injections: 'rs|rust',
        fileTypes: ['rs'],
        globFileTypes: ['Cargo.lock'],
        shebangs: ['rust-script'],
        grammar: 'rust',
      },
      typescript: {
        scope: 'source.ts',
        injections: '^(ts|typescript)',
        fileTypes: ['ts', 'mts', 'cts'],
        shebangs: [],
        grammar: 'typescript',
      },
      vue: { scope: 'source.vue', injections: 'vue', fileTypes: ['vue'], shebangs: [], grammar: 'vue' },
      'no-grammar-lang': {
        scope: 'source.no-grammar',
        fileTypes: ['ngl'],
        shebangs: [],
        grammar: 'no-grammar-lang',
      },
      'alias-lang': {
        scope: 'source.alias',
        fileTypes: ['alng'],
        shebangs: [],
        grammar: 'alias-lang',
        aliases: ['alias-one', 'alias-two'],
      },
    });
  });
});

describe('collectExtensions / toModule / verify（generated-extensions 派生——自 gen-code-extensions.mjs 迁）', () => {
  it('normalize→过滤→去重→升序；glob 形不收', () => {
    expect(collectExtensions(fixtureLangs)).toEqual(['alng', 'cts', 'mts', 'ngl', 'rs', 'ts', 'vue']);
  });

  it('toModule 头注释指向 gen-sources（生成物不入库，消费端缺失报错指向 pnpm gen:sources）', () => {
    const mod = toModule(['rs']);
    expect(mod).toContain('// 由 tools/grammar-builder/gen-sources.mjs 生成');
    expect(mod).toContain('生成物不入库');
    expect(mod).toContain('pnpm gen:sources');
    expect(mod).toContain('export const GENERATED_EXTENSIONS: readonly string[] = ["rs"];');
  });

  it('verify：盘上内容与派生一致为 true，漂移为 false', () => {
    const mod = toModule(collectExtensions(fixtureLangs));
    expect(verify(fixtureLangs, mod)).toBe(true);
    expect(verify(fixtureLangs, `${mod}// drift\n`)).toBe(false);
  });
});

// ⑥ QUERY_PATCHES（自 generate.mjs 原样迁：唯一命中替换、命中≠1 抛错）-----------------

describe('QUERY_PATCHES（迁移用例）', () => {
  it('solidity 尾锚条目原样保留（find 唯一命中替换）', () => {
    expect(QUERY_PATCHES).toHaveLength(1);
    expect(QUERY_PATCHES[0]).toMatchObject({
      file: 'solidity/highlights.scm',
      find: '(struct_expression type: ((expression (identifier)) @type .))',
      replace: '(struct_expression type: ((expression (identifier)) @type))',
    });
  });

  it('applyQueryPatches：命中唯一时替换，失配（0 次或多次）抛错', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-qpatch-'));
    writeFileSync(path.join(dir, 'a.scm'), 'x = [\ny = [\nz = [\n');
    applyQueryPatches(dir, [{ file: 'a.scm', reason: '测试', find: 'x = [\n', replace: 'x . [\n' }]);
    expect(readFileSync(path.join(dir, 'a.scm'), 'utf8')).toBe('x . [\ny = [\nz = [\n');

    expect(() =>
      applyQueryPatches(dir, [{ file: 'a.scm', reason: '零命中', find: 'missing', replace: 'y' }]),
    ).toThrow(/命中 0 次/);
    expect(() =>
      applyQueryPatches(dir, [{ file: 'a.scm', reason: '多命中', find: '[\n', replace: ']' }]),
    ).toThrow(/命中 3 次/);
  });
});

// ⑦ parseTheme / collectThemes（自 generate.mjs 迁，inherits 链）----------------------

describe('parseTheme（主题解析，palette 按 helix 语义解析）', () => {
  const sample = readFileSync(path.join(fixtureDir, 'theme-sample.toml'), 'utf8');

  it('字符串色值解析为 { fg }，palette 引用内联为实际色值', () => {
    const { styles } = parseTheme(sample);
    expect(styles['function']).toEqual({ fg: '#bcd5a8' });
  });

  it('表值解析 fg/bg/modifiers 并内联 palette', () => {
    const { styles } = parseTheme(sample);
    expect(styles['comment']).toEqual({ fg: '#646669', modifiers: ['italic'] });
    expect(styles['ui.background']).toEqual({ bg: '#323437' });
  });

  it('本主题 palette 未命中时回退内置 palette（helix ThemePalette::default）', () => {
    const { styles } = parseTheme(sample);
    expect(styles['punctuation']).toEqual({ fg: BUILTIN_PALETTE['white'] });
  });

  it('palette 引用彻底未命中的字段按 helix 语义丢弃并记入 misses', () => {
    const { styles, misses } = parseTheme('"keyword" = "nope-missing"\n');
    expect(styles['keyword']).toBeUndefined();
    expect(misses).toEqual(['nope-missing']);
  });

  it('BUILTIN_PALETTE 覆盖 helix 内置 ANSI 色名且均为 #hex', () => {
    expect(Object.keys(BUILTIN_PALETTE).sort()).toEqual([
      'black', 'blue', 'cyan', 'gray', 'green', 'light-blue', 'light-cyan',
      'light-gray', 'light-green', 'light-magenta', 'light-red', 'light-yellow',
      'magenta', 'red', 'white', 'yellow',
    ]);
    for (const hex of Object.values(BUILTIN_PALETTE)) expect(hex).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe('collectThemes（主题目录解析，inherits 链上 palette 递归合并；theme.toml/base16_ 规则内跳过）', () => {
  const themesDir = path.join(fixtureDir, 'themes');

  it('子主题引用父主题 palette 定义的名字可解析；theme.toml/base16_* 不进产物', () => {
    const themes = collectThemes(themesDir);
    expect(Object.keys(themes)).toEqual(['child', 'parent']);
    expect(themes['parent']?.['keyword']).toEqual({ fg: '#abcdef' });
    expect(themes['child']?.['function']).toEqual({ fg: '#abcdef' });
  });

  it('主题目录枚举已排序（跨机幂等，确定性）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-themes-'));
    writeFileSync(path.join(dir, 'b.toml'), '"a" = "white"\n');
    writeFileSync(path.join(dir, 'a.toml'), '"b" = "black"\n');
    expect(Object.keys(collectThemes(dir))).toEqual(['a', 'b']);
  });
});

// ⑧ 盘态守门（迁移自 generate.test.ts，路径不改——对现入库资产跑；T2 regen 后对 gen 产物跑）--

describe('盘态守门：assets/queries（迁移自 helix-assets generate.test.ts）', () => {
  const queriesDir = path.join(assetsDir, 'queries');

  it('queries/ 目录数 ≥ 280，ecma/highlights.scm 存在，typescript 头部声明继承 ecma + 父目录 _typescript 实体', () => {
    expect(existsSync(queriesDir)).toBe(true);
    const dirs = readdirSync(queriesDir).filter((d) => statSync(path.join(queriesDir, d)).isDirectory());
    expect(dirs.length).toBeGreaterThanOrEqual(280);

    expect(existsSync(path.join(queriesDir, 'ecma/highlights.scm'))).toBe(true);

    // ecma 是继承根（首行为普通注释）；其子 typescript 在头部注释区声明 inherits
    const tsHead = readFileSync(path.join(queriesDir, 'typescript/highlights.scm'), 'utf8').split('\n', 5);
    expect(tsHead.some((l) => l.trim().startsWith(';') && l.includes('inherits:'))).toBe(true);
    // 变体父目录 _typescript 是活资产（typescript 经 `; inherits: _typescript,ecma` 继承）
    const parent = readFileSync(path.join(queriesDir, '_typescript/tags.scm'), 'utf8');
    expect(parent).toContain('@name');
    expect(parent).toContain('@definition.function');
  });

  it('防回归：ecma/injections.scm 含 graphql 注入的 `.` 锚点（防 O(n²) 挂起回归）', () => {
    const text = readFileSync(path.join(queriesDir, 'ecma/injections.scm'), 'utf8');
    expect(text).toContain('((comment) @_ecma_comment) . [');
    // 无锚形态（补丁前的上游病态 pattern）不得回归
    expect(text).not.toContain('((comment) @_ecma_comment [\n');
  });

  // 基线口径（F4 订正）：一层 readdirSync 口径 ≥56——现盘总 58 份含 2 嵌套目录
  // （glimmer-javascript/glimmer_javascript、matlab/neovim），一层恰 56；T2 regen 后
  // master 顶层 ~77 目录，两口径均绿不构成后续风险（Errata ⑯）。
  const tagsBaseline = 56;
  it('queries/ 下含 tags.scm 的目录数 ≥ 基线（一层 readdirSync 口径）', () => {
    const tagsDirs = readdirSync(queriesDir).filter((d) => existsSync(path.join(queriesDir, d, 'tags.scm')));
    expect(tagsDirs.length).toBeGreaterThanOrEqual(tagsBaseline);
  });

  it('javascript/_javascript tags 继承链双形态一致性（F1 订正：现盘旧形态绿 / T2 regen 后锁新形态）', () => {
    const jsTagsPath = path.join(queriesDir, 'javascript/tags.scm');
    const jsTags = readFileSync(jsTagsPath, 'utf8');
    const head = jsTags.split('\n', 6);
    const declaresJsInherit = head.some(
      (l) => l.trim().startsWith(';') && l.includes('inherits:') && l.includes('_javascript'),
    );
    if (declaresJsInherit) {
      // 新形态（上游把 javascript tags 实体迁入 _javascript/tags.scm，javascript 改纯继承
      // 声明）：_javascript/tags.scm 成为继承链必需活资产，必须在盘且含实体捕获
      const parentPath = path.join(queriesDir, '_javascript/tags.scm');
      expect(existsSync(parentPath)).toBe(true);
      expect(readFileSync(parentPath, 'utf8')).toContain('@name');
    } else {
      // 旧形态（现盘）：javascript/tags.scm 自含实体（99 行，零 inherits 命中）→ 仅锁其存在
      expect(existsSync(jsTagsPath)).toBe(true);
    }
    // _javascript 目录 highlights/locals 活资产存在性：javascript 的 highlights/locals 经
    // `; inherits: _javascript` 继承，两种形态下都不得缺席
    expect(existsSync(path.join(queriesDir, '_javascript/highlights.scm'))).toBe(true);
    expect(existsSync(path.join(queriesDir, '_javascript/locals.scm'))).toBe(true);
  });

  it('抽查 bash：@definition.function 捕获形态（上游自含无继承）', () => {
    const text = readFileSync(path.join(queriesDir, 'bash/tags.scm'), 'utf8');
    expect(text).toContain('@definition.function');
  });
});

// ⑨ diffReport（差异报告三/四计数）---------------------------------------------------

describe('diffReport（新旧产物差异：语言集 ±、rev 变更、queries 差异文件数）', () => {
  it('added/removed 按 manifest 名集差；revChanged 仅同名双侧 rev 不同；queriesChanged 含增/删/变', () => {
    const oldProducts = {
      manifestNames: ['a', 'b', 'c'],
      grammarRevs: new Map([
        ['a', '1'],
        ['b', '2'],
        ['d', '9'],
      ]),
      queries: new Map([
        ['x.scm', 'x'],
        ['y.scm', 'y'],
      ]),
    };
    const newProducts = {
      manifestNames: ['b', 'c', 'e'],
      grammarRevs: new Map([
        ['b', '2x'],
        ['c', '3'],
        ['e', '4'],
      ]),
      queries: new Map([
        ['x.scm', 'x!'],
        ['z.scm', 'z'],
      ]),
    };
    expect(diffReport(oldProducts as never, newProducts as never)).toEqual({
      added: ['e'],
      removed: ['a'],
      revChanged: 1,
      queriesChanged: 3, // x 变更 + y 移除 + z 新增
    });
  });

  it('零差异输入 → 全零报告（幂等再生的判据形态）', () => {
    const p = {
      manifestNames: ['a'],
      grammarRevs: new Map([['a', '1']]),
      queries: new Map([['a.scm', 't']]),
    };
    expect(diffReport(p as never, p as never)).toEqual({ added: [], removed: [], revChanged: 0, queriesChanged: 0 });
  });
});

// ⑩ aliases 一致性门禁（Review Focus 5：白名单内外两态）------------------------------

describe('validateAliases（aliases 每键 ∈ manifest 名集 ∪ -/_ 变体；白名单告警放行）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ALIASES_KNOWN_MISSING 白名单 = objc/systemrdl（现状合法差异，Errata ③）', () => {
    expect([...ALIASES_KNOWN_MISSING]).toEqual(['objc', 'systemrdl']);
  });

  it('白名单内未命中：告警放行（warned 返回，不抛错）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = validateAliases(
      { rust: { wasm: 'tree-sitter-rust', aliases: [] }, objc: { wasm: 'tree-sitter-objc', aliases: [] }, systemrdl: { wasm: 'tree-sitter-systemrdl', aliases: [] } } as never,
      ['rust'],
    );
    expect(r.warned).toEqual(['objc', 'systemrdl']);
    expect(r.missing).toEqual(['objc', 'systemrdl']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('白名单外未命中：显式报错（键名在案）', () => {
    expect(() => validateAliases({ nope: { wasm: 'x', aliases: [] } } as never, ['rust'])).toThrow(/nope/);
  });

  it('直接命中与 -/_ 变体命中均不告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = validateAliases(
      { rust: { wasm: 'x', aliases: [] }, 'c-sharp': { wasm: 'x', aliases: [] }, embedded_template: { wasm: 'x', aliases: [] } } as never,
      ['rust', 'c-sharp', 'embedded-template'],
    );
    expect(r.warned).toEqual([]);
    expect(r.missing).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

// ⑪ 网络面 mock（fetch 参数注入；trees truncated / raw 失败清单 / refresh 写 pin）------

const MOCK_COMMIT = 'c'.repeat(40);

interface MockRoute {
  match: RegExp;
  status?: number;
  json?: unknown;
  text?: string;
}
type MockFetch = (url: string | URL) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

function mockFetch(routes: MockRoute[], calls: string[] = []): MockFetch {
  return async (url) => {
    const u = String(url);
    calls.push(u);
    for (const r of routes) {
      if (r.match.test(u)) {
        const status = r.status ?? 200;
        const text = r.text ?? '';
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => r.json,
          text: async () => text,
          arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '', arrayBuffer: async () => new TextEncoder().encode('').buffer as ArrayBuffer };
  };
}

function tempMainEnv() {
  const dir = mkdtempSync(path.join(tmpdir(), 'vv-gen-src-'));
  const assets = path.join(dir, 'assets');
  mkdirSync(assets, { recursive: true });
  // 最小 aliases fixture：rust/typescript 命中 manifest；objc 白名单告警路径
  const aliases = {
    rust: { wasm: 'tree-sitter-rust', aliases: ['rs'] },
    typescript: { wasm: 'tree-sitter-typescript', aliases: ['ts'] },
    objc: { wasm: 'tree-sitter-objc', aliases: ['objective-c'] },
  };
  writeFileSync(path.join(dir, 'aliases.json'), `${JSON.stringify(aliases, null, 2)}\n`);
  const paths = {
    pinPath: path.join(dir, 'helix-pin.json'),
    languagesToml: path.join(dir, 'languages.toml'),
    buildListJson: path.join(dir, 'build-list.json'),
    aliasesJson: path.join(dir, 'aliases.json'),
    assetsDir: assets,
    languagesJson: path.join(assets, 'languages.json'),
    themesJson: path.join(assets, 'themes.json'),
    queriesDir: path.join(assets, 'queries'),
    serverManifest: path.join(dir, 'grammars-manifest.json'),
    generatedExtensions: path.join(dir, 'registry/generated-extensions.ts'),
  };
  return { dir, paths };
}

describe('网络面（mock fetch 注入）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolveMasterHead：commits/master → 40hex sha；非 200 显式报错', async () => {
    const sha = await resolveMasterHead({ fetchImpl: mockFetch([{ match: /commits\/master$/, json: { sha: MOCK_COMMIT } }]) });
    expect(sha).toBe(MOCK_COMMIT);

    await expect(
      resolveMasterHead({ fetchImpl: mockFetch([{ match: /commits\/master$/, status: 403 }]) }),
    ).rejects.toThrow(/403/);

    await expect(
      resolveMasterHead({ fetchImpl: mockFetch([{ match: /commits\/master$/, json: { sha: 'short' } }]) }),
    ).rejects.toThrow(/40/);
  });

  it('fetchPinLanguagesToml：200 → 文本；非 200 显式报错（不静默）', async () => {
    const text = await fetchPinLanguagesToml(MOCK_COMMIT, {
      fetchImpl: mockFetch([{ match: /languages\.toml$/, text: fixtureTomlText }]),
    });
    expect(text).toBe(fixtureTomlText);
    await expect(
      fetchPinLanguagesToml(MOCK_COMMIT, { fetchImpl: mockFetch([{ match: /languages\.toml$/, status: 404 }]) }),
    ).rejects.toThrow(/404/);
  });

  it('fetchHelixTree：recursive truncated 即抛错（显式不静默——spec §3.2.2）；正常返回仅 blob', async () => {
    await expect(
      fetchHelixTree(MOCK_COMMIT, {
        fetchImpl: mockFetch([{ match: /git\/trees\/[0-9a-f]{40}\?recursive=1/, json: { truncated: true, tree: [] } }]),
      }),
    ).rejects.toThrow(/truncated/);

    const blobs = await fetchHelixTree(MOCK_COMMIT, {
      fetchImpl: mockFetch([
        {
          match: /git\/trees\/[0-9a-f]{40}\?recursive=1/,
          json: {
            truncated: false,
            tree: [
              { type: 'blob', path: 'runtime/queries/rust/highlights.scm' },
              { type: 'tree', path: 'runtime/queries/rust' },
              { type: 'blob', path: 'README.md' },
            ],
          },
        },
      ]),
    });
    expect(blobs.map((b: { path: string }) => b.path)).toEqual(['runtime/queries/rust/highlights.scm', 'README.md']);
  });

  it('pullQueries：整树拉取（含 _javascript 变体父目录与清单外目录）、patch 应用、目录换入 outDir；单文件重试 1 次后仍败 → 抛错带失败清单', async () => {
    const SOLIDITY = `x\n${QUERY_PATCHES[0].find}\ny\n`;
    const RAW: Record<string, string> = {
      'rust/highlights.scm': '(rust)\n',
      '_javascript/highlights.scm': '(js-variant)\n',
      'future-lang/locals.scm': '(future)\n',
      'solidity/highlights.scm': SOLIDITY,
    };
    const treeFiles = [
      { path: 'runtime/queries/rust/highlights.scm' },
      { path: 'runtime/queries/_javascript/highlights.scm' },
      { path: 'runtime/queries/future-lang/locals.scm' },
      { path: 'runtime/queries/solidity/highlights.scm' },
    ];
    const calls: string[] = [];
    const fetchImpl: MockFetch = async (url) => {
      const u = String(url);
      calls.push(u);
      const m = /helix\/[0-9a-f]{40}\/runtime\/queries\/(.+)$/.exec(u);
      if (m && RAW[m[1]] !== undefined) {
        const text = RAW[m[1]];
        return { ok: true, status: 200, json: async () => ({}), text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '', arrayBuffer: async () => new TextEncoder().encode('').buffer as ArrayBuffer };
    };

    const assets = mkdtempSync(path.join(tmpdir(), 'vv-pull-q-'));
    const queriesDir = path.join(assets, 'queries');
    const n = await pullQueries(treeFiles, MOCK_COMMIT, queriesDir, { fetchImpl });
    expect(n).toBe(4);
    // 整树保形（Review Focus 2）：清单外/变体父目录均入盘
    expect(readFileSync(path.join(queriesDir, 'rust/highlights.scm'), 'utf8')).toBe('(rust)\n');
    expect(existsSync(path.join(queriesDir, '_javascript/highlights.scm'))).toBe(true);
    expect(existsSync(path.join(queriesDir, 'future-lang/locals.scm'))).toBe(true);
    // QUERY_PATCHES 应用：replace 在、find 不在
    const solidity = readFileSync(path.join(queriesDir, 'solidity/highlights.scm'), 'utf8');
    expect(solidity).toContain(QUERY_PATCHES[0].replace);
    expect(solidity).not.toContain(QUERY_PATCHES[0].find);
    // 临时目录已清理
    expect(readdirSync(assets)).toEqual(['queries']);

    // 单文件失败：重试 1 次（共 2 次尝试）后仍败 → 抛错带失败清单，既有 outDir 不被破坏
    const calls2: string[] = [];
    const failing: MockFetch = async (url) => {
      const u = String(url);
      calls2.push(u);
      if (u.includes('runtime/queries/broken/highlights.scm')) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => '', arrayBuffer: async () => new TextEncoder().encode('').buffer as ArrayBuffer };
      }
      const text = '(ok)\n';
      return { ok: true, status: 200, json: async () => ({}), text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer };
    };
    await expect(
      pullQueries(
        [
          { path: 'runtime/queries/ok/highlights.scm' },
          { path: 'runtime/queries/broken/highlights.scm' },
        ],
        MOCK_COMMIT,
        queriesDir,
        { fetchImpl: failing },
      ),
    ).rejects.toThrow(/broken\/highlights\.scm/);
    const brokenCalls = calls2.filter((u) => u.includes('broken/highlights.scm'));
    expect(brokenCalls).toHaveLength(2); // 重试 1 次
    // 失败即抛：既有 queries 目录原样保留（原目录在失败路径不受影响）
    expect(existsSync(path.join(queriesDir, 'rust/highlights.scm'))).toBe(true);
  });

  it('pullThemes：runtime/themes/*.toml 拉取 → collectThemes（theme.toml/base16_ 跳过）→ themes.json', async () => {
    const RAW: Record<string, string> = {
      'runtime/themes/parent.toml': '"keyword" = "fg"\n\n[palette]\nfg = "#abcdef"\n',
      'runtime/themes/child.toml': 'inherits = "parent"\n"function" = "fg"\n',
      'runtime/themes/theme.toml': '"t" = "fg"\n',
      'runtime/themes/base16_test.toml': '"b" = "fg"\n',
    };
    const fetchImpl: MockFetch = async (url) => {
      const u = String(url);
      const m = /helix\/[0-9a-f]{40}\/(runtime\/themes\/[^/]+\.toml)$/.exec(u);
      const text = m ? RAW[m[1]] : '';
      return {
        ok: Boolean(m),
        status: m ? 200 : 404,
        json: async () => ({}),
        text: async () => text,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
      };
    };
    const assets = mkdtempSync(path.join(tmpdir(), 'vv-pull-t-'));
    const n = await pullThemes(
      [
        { path: 'runtime/themes/parent.toml' },
        { path: 'runtime/themes/child.toml' },
        { path: 'runtime/themes/theme.toml' },
        { path: 'runtime/themes/base16_test.toml' },
        { path: 'runtime/themes/extra.md' }, // 非 toml 过滤
      ],
      MOCK_COMMIT,
      assets,
      { fetchImpl },
    );
    expect(n).toBe(2); // theme.toml/base16_test 规则内跳过
    const themes = JSON.parse(readFileSync(path.join(assets, 'themes.json'), 'utf8'));
    expect(Object.keys(themes)).toEqual(['child', 'parent']);
    expect(themes['child']['function']).toEqual({ fg: '#abcdef' });
    expect(readdirSync(assets)).toEqual(['themes.json']); // 临时目录已清理
  });
});

describe('main（主流程：--refresh 写 pin / 缺 pin 报错 / 幂等再生零差异）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const SOLIDITY = `x\n${QUERY_PATCHES[0].find}\ny\n`;
  const TREE_BLOBS = [
    { type: 'blob', path: 'runtime/queries/rust/highlights.scm' },
    { type: 'blob', path: 'runtime/queries/typescript/tags.scm' },
    { type: 'blob', path: 'runtime/queries/_javascript/highlights.scm' },
    { type: 'blob', path: 'runtime/queries/ecma/injections.scm' },
    { type: 'blob', path: 'runtime/queries/solidity/highlights.scm' },
    { type: 'blob', path: 'runtime/queries/wren/highlights.scm' },
    { type: 'blob', path: 'runtime/queries/future-lang/locals.scm' },
    { type: 'blob', path: 'runtime/queries/README.md' },
    { type: 'blob', path: 'runtime/themes/parent.toml' },
    { type: 'blob', path: 'runtime/themes/child.toml' },
    { type: 'blob', path: 'runtime/themes/theme.toml' },
    { type: 'tree', path: 'runtime/queries' },
    { type: 'blob', path: 'crates/x/src/parser.c' },
  ];
  const THEME_RAW: Record<string, string> = {
    'runtime/themes/parent.toml': '"keyword" = "fg"\n\n[palette]\nfg = "#abcdef"\n',
    'runtime/themes/child.toml': 'inherits = "parent"\n"function" = "fg"\n',
    'runtime/themes/theme.toml': '"t" = "fg"\n',
  };
  const QUERY_RAW: Record<string, string> = {
    'rust/highlights.scm': '(rust)\n',
    'typescript/tags.scm': '; inherits: _typescript,ecma\n(ts-tags)\n',
    '_javascript/highlights.scm': '(js-variant)\n',
    'ecma/injections.scm': '(ecma)\n',
    'solidity/highlights.scm': SOLIDITY,
    'wren/highlights.scm': '(wren)\n',
    'future-lang/locals.scm': '(future)\n',
  };

  function mainMockFetch(calls: string[] = []): MockFetch {
    return async (url) => {
      const u = String(url);
      calls.push(u);
      const qm = /helix\/[0-9a-f]{40}\/runtime\/queries\/(.+)$/.exec(u);
      if (qm && QUERY_RAW[qm[1]] !== undefined) {
        const text = QUERY_RAW[qm[1]];
        return { ok: true, status: 200, json: async () => ({}), text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer };
      }
      const tm = /helix\/[0-9a-f]{40}\/(runtime\/themes\/[^/]+\.toml)$/.exec(u);
      if (tm && THEME_RAW[tm[1]] !== undefined) {
        const text = THEME_RAW[tm[1]];
        return { ok: true, status: 200, json: async () => ({}), text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer };
      }
      if (/\/languages\.toml$/.test(u)) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => fixtureTomlText, arrayBuffer: async () => new TextEncoder().encode(fixtureTomlText).buffer as ArrayBuffer };
      }
      if (/git\/trees\/[0-9a-f]{40}\?recursive=1/.test(u)) {
        return { ok: true, status: 200, json: async () => ({ truncated: false, tree: TREE_BLOBS }), text: async () => '', arrayBuffer: async () => new TextEncoder().encode('').buffer as ArrayBuffer };
      }
      if (/commits\/master$/.test(u)) {
        return { ok: true, status: 200, json: async () => ({ sha: MOCK_COMMIT }), text: async () => '', arrayBuffer: async () => new TextEncoder().encode('').buffer as ArrayBuffer };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '', arrayBuffer: async () => new TextEncoder().encode('').buffer as ArrayBuffer };
    };
  }

  it('缺 pin：缺省模式显式报错指向 --refresh（首跑初始化语义）', async () => {
    const { paths } = tempMainEnv();
    await expect(main([], { fetchImpl: mainMockFetch(), paths, sanity: false })).rejects.toThrow(/--refresh/);
  });

  it('--refresh 首跑：pin 自动初始化 + 全产物落盘（queries 整树保形/patch/manifest 含 vue）', async () => {
    const { paths } = tempMainEnv();
    const r = await main(['--refresh'], { fetchImpl: mainMockFetch(), paths, sanity: false });

    // pin 写盘形态
    const pin = JSON.parse(readFileSync(paths.pinPath, 'utf8')) as Record<string, string>;
    expect(pin).toMatchObject({ ref: 'master', commit: MOCK_COMMIT, release: '' });
    expect(new Date(pin.refreshedAt).toISOString()).toBe(pin.refreshedAt);

    // 单文件产物
    expect(readFileSync(paths.languagesToml, 'utf8')).toBe(fixtureTomlText);
    const buildList = JSON.parse(readFileSync(paths.buildListJson, 'utf8')) as Array<Record<string, unknown>>;
    expect(buildList).toHaveLength(5);
    expect(buildList.every((e) => e.parserCExists === true && e.helixLang === e.name)).toBe(true);
    const manifest = JSON.parse(readFileSync(paths.serverManifest, 'utf8')) as { grammars: Array<{ name: string }> };
    expect(manifest.grammars.map((g) => g.name).sort()).toEqual(['c-sharp', 'orphan-grammar', 'rust', 'typescript', 'vue']);
    const langs = JSON.parse(readFileSync(paths.languagesJson, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(langs)).toEqual(['rust', 'typescript', 'vue', 'no-grammar-lang', 'alias-lang']);
    const extModule = readFileSync(paths.generatedExtensions, 'utf8');
    expect(extModule).toContain('gen-sources.mjs');
    expect(extModule).toContain('"vue"');

    // queries 整树保形：变体父目录（_javascript）与清单外目录（future-lang/wren）入树；
    // patch 应用；非 scm 过滤（README.md 不入）
    expect(existsSync(path.join(paths.queriesDir, '_javascript/highlights.scm'))).toBe(true);
    expect(existsSync(path.join(paths.queriesDir, 'future-lang/locals.scm'))).toBe(true);
    expect(existsSync(path.join(paths.queriesDir, 'wren/highlights.scm'))).toBe(true);
    expect(existsSync(path.join(paths.queriesDir, 'README.md'))).toBe(false);
    const solidity = readFileSync(path.join(paths.queriesDir, 'solidity/highlights.scm'), 'utf8');
    expect(solidity).toContain(QUERY_PATCHES[0].replace);
    expect(solidity).not.toContain(QUERY_PATCHES[0].find);

    // themes：theme.toml/base16_ 规则内跳过
    const themes = JSON.parse(readFileSync(paths.themesJson, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(themes)).toEqual(['child', 'parent']);

    // 首跑无旧产物：diff 为 null（差异报告以首跑摘要代替）
    expect(r.diff).toBeNull();
    expect(r.manifestCount).toBe(5);
    expect(r.queryFiles).toBe(7);
    expect(r.themeCount).toBe(2);
  });

  it('缺省模式（pin 在）：按 pin 全量再生，幂等二跑零差异', async () => {
    const { paths } = tempMainEnv();
    await main(['--refresh'], { fetchImpl: mainMockFetch(), paths, sanity: false });
    const pinBefore = readFileSync(paths.pinPath, 'utf8');

    // 二跑：盘上旧产物齐备 → diff 全零（确定性再生）
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r2 = await main([], { fetchImpl: mainMockFetch(), paths, sanity: false });
    expect(r2.diff).toEqual({ added: [], removed: [], revChanged: 0, queriesChanged: 0 });
    expect(readFileSync(paths.pinPath, 'utf8')).toBe(pinBefore); // 缺省模式不触 pin
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('objc')); // aliases 白名单告警放行
  });

  it('--refresh pin 更新：旧 pin commit ≠ master HEAD → 写新 pin（refreshedAt 更新）', async () => {
    const { paths } = tempMainEnv();
    writePin(paths.pinPath, 'a'.repeat(40));
    const r = await main(['--refresh'], { fetchImpl: mainMockFetch(), paths, sanity: false });
    expect(r.commit).toBe(MOCK_COMMIT);
    const pin = JSON.parse(readFileSync(paths.pinPath, 'utf8')) as Record<string, string>;
    expect(pin.commit).toBe(MOCK_COMMIT);
  });
});

// parseGrammarSources（自 build.mjs 原样迁：输入参数化为 toml 文本）--------------------

describe('parseGrammarSources（迁移用例：[[grammar]] → Map<name, {git, rev, subpath}>）', () => {
  it('git/rev/subpath 解析，缺 git/rev 条目跳过，subpath 缺省空串', () => {
    const sources = parseGrammarSources(fixtureTomlText);
    expect(sources.get('typescript')).toEqual({
      git: 'https://github.com/tree-sitter/tree-sitter-typescript',
      rev: '2'.repeat(40),
      subpath: 'typescript',
    });
    expect(sources.get('rust')?.subpath ?? '').toBe('');
    expect(sources.get('wren')).toBeDefined();
  });
});
