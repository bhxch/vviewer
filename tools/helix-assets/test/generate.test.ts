import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLanguages, parseTheme } from '../generate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const assetsDir = path.join(repoRoot, 'packages/highlight/assets');

/** 读取带生成头注释的 JSON 产物（首行为 `// ...` 注释，需剥离后解析）。 */
function readHeaderJson(file: string): Record<string, unknown> {
  const text = readFileSync(path.join(assetsDir, file), 'utf8');
  expect(text.split('\n')[0]).toContain('Generated from');
  return JSON.parse(text.slice(text.indexOf('\n') + 1)) as Record<string, unknown>;
}

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

describe('parseTheme（主题 TOML 解析，palette 内联）', () => {
  const sample = `
"comment" = { fg = "grey2", modifiers = ["italic"] }
"function" = "green"
"ui.background" = { bg = "bg0" }

[palette]
grey2 = "#646669"
green = "#bcd5a8"
bg0 = "#323437"
`;

  it('字符串色值解析为 { fg }，palette 引用内联为实际色值', () => {
    const theme = parseTheme(sample);
    expect(theme['function']).toEqual({ fg: '#bcd5a8' });
  });

  it('表值解析 fg/bg/modifiers 并内联 palette', () => {
    const theme = parseTheme(sample);
    expect(theme['comment']).toEqual({ fg: '#646669', modifiers: ['italic'] });
    expect(theme['ui.background']).toEqual({ bg: '#323437' });
  });
});

describe('生成产物（packages/highlight/assets）', () => {
  it('languages.json 含 rust，fileTypes 含 rs 且 grammar 字段存在', () => {
    const langs = readHeaderJson('languages.json');
    const rust = langs['rust'] as Record<string, unknown> | undefined;
    expect(rust).toBeDefined();
    expect(rust?.['scope']).toBe('source.rust');
    expect(rust?.['grammar']).toBeDefined();
    expect(rust?.['fileTypes']).toContain('rs');
  });

  it('themes.json 含 serika-dark，且含 comment 键（palette 已内联）', () => {
    const themes = readHeaderJson('themes.json');
    const serika = themes['serika-dark'] as Record<string, unknown> | undefined;
    expect(serika).toBeDefined();
    expect(serika?.['comment']).toBeDefined();
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
