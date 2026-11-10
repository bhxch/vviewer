import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_PALETTE,
  collectThemes,
  copyTags,
  parseLanguages,
  parseTheme,
  QUERY_PATCHES,
  TAGS_SOURCES,
  applyQueryPatches,
} from '../generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const assetsDir = path.join(repoRoot, 'packages/vviewer-highlight/assets');

describe('parseLanguages（languages.toml 纯解析）', () => {
  const sample = `
[[language]]
name = "rust"
scope = "source.rust"
injection-regex = "rs|rust"
file-types = ["rs", { glob = "Cargo.lock" }]
shebangs = ["rust-script"]
grammar = "rust-custom"

[[language]]
name = "noft"
scope = "source.noft"

[[grammar]]
name = "rust"
source = { git = "https://github.com/tree-sitter/tree-sitter-rust", rev = "abc" }
`;

  it('字符串 file-types 进 fileTypes，glob 对象进 globFileTypes', () => {
    const langs = parseLanguages(sample);
    const rust = langs['rust'];
    expect(rust).toBeDefined();
    expect(rust?.fileTypes).toContain('rs');
    expect(rust?.globFileTypes).toContain('Cargo.lock');
  });

  it('grammar 字段优先取 language.grammar，缺省等于 name', () => {
    const langs = parseLanguages(sample);
    expect(langs['rust']?.grammar).toBe('rust-custom');
    expect(langs['noft']?.grammar).toBe('noft');
  });

  it('injections 来自 injection-regex，shebangs 缺省为空数组', () => {
    const langs = parseLanguages(sample);
    expect(langs['rust']?.injections).toBe('rs|rust');
    expect(langs['rust']?.shebangs).toEqual(['rust-script']);
    expect(langs['noft']?.shebangs).toEqual([]);
  });
});

describe('parseTheme（主题解析，palette 按 helix 语义解析）', () => {
  const sample = `
"comment" = { fg = "grey2", modifiers = ["italic"] }
"function" = "green"
"ui.background" = { bg = "bg0" }
"punctuation" = "white"

[palette]
grey2 = "#646669"
green = "#bcd5a8"
bg0 = "#323437"
`;

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
    expect(Object.keys(BUILTIN_PALETTE).sort()).toEqual(
      [
        'black', 'blue', 'cyan', 'gray', 'green', 'light-blue', 'light-cyan',
        'light-gray', 'light-green', 'light-magenta', 'light-red', 'light-yellow',
        'magenta', 'red', 'white', 'yellow',
      ],
    );
    for (const hex of Object.values(BUILTIN_PALETTE)) expect(hex).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe('collectThemes（主题目录解析，inherits 链上 palette 递归合并）', () => {
  it('子主题引用父主题 palette 定义的名字可解析', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-themes-'));
    writeFileSync(
      path.join(dir, 'parent.toml'),
      '"keyword" = "fg"\n\n[palette]\nfg = "#abcdef"\n',
    );
    writeFileSync(path.join(dir, 'child.toml'), 'inherits = "parent"\n"function" = "fg"\n');
    const themes = collectThemes(dir);
    expect(themes['parent']?.['keyword']).toEqual({ fg: '#abcdef' });
    expect(themes['child']?.['function']).toEqual({ fg: '#abcdef' });
  });
});

describe('生成产物（packages/vviewer-highlight/assets）', () => {
  it('languages.json 为纯 JSON（可直接 import），含 rust 契约', () => {
    const langs = JSON.parse(readFileSync(path.join(assetsDir, 'languages.json'), 'utf8'));
    const rust = langs['rust'] as Record<string, unknown> | undefined;
    expect(rust).toBeDefined();
    expect(rust?.['scope']).toBe('source.rust');
    expect(rust?.['grammar']).toBeDefined();
    expect(rust?.['fileTypes']).toContain('rs');
  });

  it('themes.json 为纯 JSON，含 serika-dark 且 comment 已内联', () => {
    const themes = JSON.parse(readFileSync(path.join(assetsDir, 'themes.json'), 'utf8'));
    const serika = themes['serika-dark'] as Record<string, Record<string, unknown>> | undefined;
    expect(serika).toBeDefined();
    expect(serika?.['comment']).toEqual({ fg: '#646669', modifiers: ['italic'] });
  });

  it('防回归：所有主题的 fg/bg 均为 #hex（palette 全解析）', () => {
    const themes = JSON.parse(readFileSync(path.join(assetsDir, 'themes.json'), 'utf8')) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const bad: string[] = [];
    for (const [name, theme] of Object.entries(themes)) {
      for (const [capture, style] of Object.entries(theme)) {
        for (const key of ['fg', 'bg'] as const) {
          const value = style[key];
          if (value !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(value)))
            bad.push(`${name}.${capture}.${key}=${String(value)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('queries/ 目录数 ≥ 280，ecma/highlights.scm 存在，typescript 头部声明继承 ecma', () => {
    const queriesDir = path.join(assetsDir, 'queries');
    expect(existsSync(queriesDir)).toBe(true);
    const dirs = readdirSync(queriesDir).filter((d) =>
      statSync(path.join(queriesDir, d)).isDirectory(),
    );
    expect(dirs.length).toBeGreaterThanOrEqual(280);

    const ecmaHighlights = path.join(queriesDir, 'ecma/highlights.scm');
    expect(existsSync(ecmaHighlights)).toBe(true);

    // ecma 是继承根（首行为普通注释）；其子 typescript 在头部注释区声明 inherits
    const tsHead = readFileSync(path.join(queriesDir, 'typescript/highlights.scm'), 'utf8').split('\n', 5);
    expect(tsHead.some((l) => l.trim().startsWith(';') && l.includes('inherits:'))).toBe(true);
  });
});

describe('copyTags（tags 补源，helix 检出上游）', () => {
  it('上游存在即拷覆盖，缺目录静默跳过（json/shell/_jsx 上游无 tags.scm）', () => {
    const srcDir = mkdtempSync(path.join(tmpdir(), 'vv-tags-src-'));
    const outDir = mkdtempSync(path.join(tmpdir(), 'vv-tags-out-'));
    for (const lang of ['typescript', 'bash']) {
      mkdirSync(path.join(srcDir, lang), { recursive: true });
      writeFileSync(path.join(srcDir, lang, 'tags.scm'), `// tags of ${lang}\n`);
    }
    // 目标目录不存在（typescript 首拷）与已存在（bash 覆盖）两态
    mkdirSync(path.join(outDir, 'queries', 'bash'), { recursive: true });
    writeFileSync(path.join(outDir, 'queries', 'bash', 'tags.scm'), 'old');

    const copied = copyTags(srcDir, outDir, ['typescript', 'bash', 'json', 'shell']);
    expect(copied).toEqual(['typescript', 'bash']);
    expect(readFileSync(path.join(outDir, 'queries', 'typescript', 'tags.scm'), 'utf8')).toBe('// tags of typescript\n');
    expect(readFileSync(path.join(outDir, 'queries', 'bash', 'tags.scm'), 'utf8')).toBe('// tags of bash\n');
  });
});

describe('tags 资产（代码大纲补源产物，helix pin ba40e547）', () => {
  // 基线（git 实测 d7cfa5c 全树）：53 份 tags.scm（一层目录 51 + 嵌套 2：
  // glimmer-javascript/glimmer_javascript、matlab/neovim）；Task 1 补源新增 6 份目录
  // （typescript/tsx/bash/zig/_typescript/_javascript，上游缺 _jsx/json/shell；lua/c
  // 为 helix 新版覆盖更新不计新增）→ 总 59 份 / 一层 57；其后 _javascript/tags.scm
  // 作死资产移除（无任何 tags.scm 继承 _javascript，见 generate.mjs TAGS_SOURCES 注释）
  // → 总 58 份 / 一层 56。本断言仅统计一层目录。
  const tagsBaseline = 56;

  it('queries/ 下含 tags.scm 的目录数 ≥ 基线', () => {
    const queriesDir = path.join(assetsDir, 'queries');
    const tagsDirs = readdirSync(queriesDir).filter((d) =>
      existsSync(path.join(queriesDir, d, 'tags.scm')),
    );
    expect(tagsDirs.length).toBeGreaterThanOrEqual(tagsBaseline);
  });

  it('移除守门：_javascript tags 死资产不复活且目录活资产保留（langs 回加/误删整目录均在此报红）', () => {
    // langs 回加 '_javascript' 并重跑生成会静默复活死资产（基线 ≥ 断言对此零感知，故显式锁定）
    expect(TAGS_SOURCES.langs).not.toContain('_javascript');
    expect(existsSync(path.join(assetsDir, 'queries/_javascript/tags.scm'))).toBe(false);
    // 目录本身是活资产（javascript 的 highlights/locals 经 `; inherits: _javascript` 继承），不得误删
    expect(existsSync(path.join(assetsDir, 'queries/_javascript/highlights.scm'))).toBe(true);
    expect(existsSync(path.join(assetsDir, 'queries/_javascript/locals.scm'))).toBe(true);
  });

  it('抽查 typescript：inherits 头（_typescript,ecma）+ 继承父 _typescript 的捕获形态', () => {
    const text = readFileSync(path.join(assetsDir, 'queries/typescript/tags.scm'), 'utf8');
    // typescript/tags.scm 本体是纯继承声明文件（body 空），实体查询在父目录 _typescript
    const head = text.split('\n', 6);
    expect(head.some((l) => l.trim().startsWith(';') && l.includes('inherits:'))).toBe(true);
    const parent = readFileSync(path.join(assetsDir, 'queries/_typescript/tags.scm'), 'utf8');
    expect(parent).toContain('@name');
    expect(parent).toContain('@definition.function');
  });

  it('抽查 bash：@definition.function 捕获形态（上游自含无继承）', () => {
    const text = readFileSync(path.join(assetsDir, 'queries/bash/tags.scm'), 'utf8');
    expect(text).toContain('@definition.function');
  });

  it('TAGS_SOURCES pin commit 固定（禁分支名，溯源用）', () => {
    expect(TAGS_SOURCES.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('QUERY_PATCHES（原样拷贝后的针对性查询修正）', () => {
  it('守门：入库资产 ecma/injections.scm 含 graphql 注入的 `.` 锚点（防 O(n²) 挂起回归；曾为 QUERY_PATCHES 条目，Markpad pin 点上游已内置等价锚点，见 generate.mjs QUERY_PATCHES 注释）', () => {
    const text = readFileSync(path.join(assetsDir, 'queries/ecma/injections.scm'), 'utf8');
    expect(text).toContain('((comment) @_ecma_comment) . [');
    // 无锚形态（补丁前的上游病态 pattern）不得回归
    expect(text).not.toContain('((comment) @_ecma_comment [\n');
  });

  it('补丁已应用：入库资产含每个 QUERY_PATCHES 条目的 replace 且不含 find', () => {
    for (const patch of QUERY_PATCHES) {
      const text = readFileSync(path.join(assetsDir, 'queries', patch.file), 'utf8');
      expect(text).toContain(patch.replace);
      expect(text).not.toContain(patch.find);
    }
  });

  it('applyQueryPatches：命中唯一时替换，失配（0 次或多次）报错', () => {
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

describe('确定性', () => {
  it('主题目录枚举已排序（跨机幂等）', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = mkdtempSync(path.join(tmpdir(), 'vv-themes-'));
    writeFileSync(path.join(dir, 'b.toml'), '"a" = "white"\n');
    writeFileSync(path.join(dir, 'a.toml'), '"b" = "black"\n');
    const names = Object.keys(collectThemes(dir));
    expect(names).toEqual(['a', 'b']);
  });
});
