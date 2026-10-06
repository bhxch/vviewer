#!/usr/bin/env node
// helix 资产生成器：从本机 helix-editor/helix 与 markpad-aio 源资产生成
// packages/highlight/assets/{languages.json,themes.json,queries/}。
// 用法：node tools/helix-assets/generate.mjs（可重复执行，产物幂等）
import { parse } from 'smol-toml';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEADER_COMMENT =
  '// Generated from helix-editor/helix (MPL-2.0) & markpad-aio queries — do not edit';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export const SOURCES = {
  // markpad 的 languages.toml 与 helix 同源，且 grammar 清单带验证过的 rev/subpath，优先使用
  languagesToml:
    process.env.VV_LANGUAGES_TOML ??
    '/share/rw/repo/markpad-aio/Markpad/src-tauri/languages.toml',
  queriesDir:
    process.env.VV_QUERIES_DIR ?? '/share/rw/repo/markpad-aio/Markpad/src-tauri/queries',
  themesDir:
    process.env.VV_THEMES_DIR ??
    '/share/rw/repo/github/helix-editor/helix/runtime/themes',
  outDir: process.env.VV_ASSETS_OUT ?? path.join(repoRoot, 'packages/highlight/assets'),
};

/**
 * 解析 languages.toml（[[language]] + [[grammar]]）为：
 * Record<langName, { scope, injections?, fileTypes, globFileTypes?, shebangs, grammar, aliases? }>
 * - file-types 中字符串为后缀；{ glob = "..." } 归入 globFileTypes
 * - grammar 取 language.grammar，缺省等于 name
 */
export function parseLanguages(tomlText) {
  const doc = parse(tomlText);
  const result = {};
  for (const lang of doc.language ?? []) {
    if (!lang || typeof lang.name !== 'string' || lang.name === '') continue;
    const fileTypes = [];
    const globFileTypes = [];
    for (const ft of lang['file-types'] ?? []) {
      if (typeof ft === 'string') fileTypes.push(ft);
      else if (ft && typeof ft === 'object' && typeof ft.glob === 'string')
        globFileTypes.push(ft.glob);
    }
    const entry = {
      scope: typeof lang.scope === 'string' ? lang.scope : '',
      ...(typeof lang['injection-regex'] === 'string'
        ? { injections: lang['injection-regex'] }
        : {}),
      fileTypes,
      ...(globFileTypes.length > 0 ? { globFileTypes } : {}),
      shebangs: Array.isArray(lang.shebangs) ? lang.shebangs.filter((s) => typeof s === 'string') : [],
      grammar: typeof lang.grammar === 'string' ? lang.grammar : lang.name,
      ...(Array.isArray(lang.aliases) ? { aliases: lang.aliases.filter((a) => typeof a === 'string') } : {}),
    };
    result[lang.name] = entry;
  }
  return result;
}

/** 解析主题内单一色值：'#hex' 直取；palette 命名引用内联为实际色值；缺失原样保留。 */
function resolveColor(value, palette) {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('#')) return value;
  const hit = palette[value];
  if (typeof hit === 'string') return hit;
  console.warn(`[helix-assets] palette 引用未命中: ${value}`);
  return value;
}

/** 解析单个主题 TOML 为 Record<capture, { fg?, bg?, modifiers? }>（palette 内联）。 */
export function parseTheme(tomlText) {
  const doc = parse(tomlText);
  const palette = doc.palette ?? {};
  const theme = {};
  for (const [capture, value] of Object.entries(doc)) {
    if (capture === 'palette' || capture === 'inherits') continue;
    if (typeof value === 'string') {
      const fg = resolveColor(value, palette);
      if (fg !== undefined) theme[capture] = { fg };
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const style = {};
      const fg = resolveColor(value.fg, palette);
      const bg = resolveColor(value.bg, palette);
      if (fg !== undefined) style.fg = fg;
      if (bg !== undefined) style.bg = bg;
      if (Array.isArray(value.modifiers))
        style.modifiers = value.modifiers.filter((m) => typeof m === 'string');
      if (Object.keys(style).length > 0) theme[capture] = style;
    }
  }
  return theme;
}

/** 读取主题目录（跳过 theme.toml 与 base16_*.toml），解析 inherits 链（父样式在前，子按捕获覆盖）。 */
export function collectThemes(themesDir) {
  const raw = new Map(); // name -> { inherits, theme }
  for (const file of fs.readdirSync(themesDir)) {
    if (!file.endsWith('.toml')) continue;
    if (file === 'theme.toml' || file.startsWith('base16_')) continue;
    const name = file.slice(0, -'.toml'.length);
    const text = fs.readFileSync(path.join(themesDir, file), 'utf8');
    const doc = parse(text);
    raw.set(name, {
      inherits: typeof doc.inherits === 'string' ? doc.inherits : '',
      theme: parseTheme(text),
    });
  }

  const merged = new Map();
  const resolveTheme = (name, onPath) => {
    const cached = merged.get(name);
    if (cached) return cached;
    const entry = raw.get(name);
    if (!entry) return {};
    if (onPath.has(name)) {
      console.warn(`[helix-assets] 主题 inherits 环: ${[...onPath, name].join(' -> ')}`);
      return entry.theme;
    }
    onPath.add(name);
    let base = {};
    if (entry.inherits) {
      for (const parent of entry.inherits.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!raw.has(parent)) {
          console.warn(`[helix-assets] 主题 ${name} inherits 的父主题缺失: ${parent}`);
          continue;
        }
        base = { ...base, ...resolveTheme(parent, onPath) };
      }
    }
    onPath.delete(name);
    const result = { ...base, ...entry.theme };
    merged.set(name, result);
    return result;
  };

  const themes = {};
  for (const name of raw.keys()) themes[name] = resolveTheme(name, new Set());
  return themes;
}

/** 复制 markpad queries/ 全量目录（原样拷贝，不改内容）。 */
function copyQueries(srcDir, outDir) {
  const dest = path.join(outDir, 'queries');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(srcDir, dest, { recursive: true });
  return fs.readdirSync(dest).filter((d) => fs.statSync(path.join(dest, d)).isDirectory()).length;
}

function writeHeaderJson(file, value) {
  fs.writeFileSync(file, `${HEADER_COMMENT}\n${JSON.stringify(value, null, 2)}\n`);
}

export function generateAll({
  languagesToml = SOURCES.languagesToml,
  queriesDir = SOURCES.queriesDir,
  themesDir = SOURCES.themesDir,
  outDir = SOURCES.outDir,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });

  const languages = parseLanguages(fs.readFileSync(languagesToml, 'utf8'));
  writeHeaderJson(path.join(outDir, 'languages.json'), languages);

  const themes = collectThemes(themesDir);
  writeHeaderJson(path.join(outDir, 'themes.json'), themes);

  const queryDirCount = copyQueries(queriesDir, outDir);

  console.log(
    `[helix-assets] 生成完成: languages=${Object.keys(languages).length} themes=${Object.keys(themes).length} queryDirs=${queryDirCount} -> ${outDir}`,
  );
  return { languages: Object.keys(languages).length, themes: Object.keys(themes).length, queryDirCount };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateAll();
}
