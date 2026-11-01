#!/usr/bin/env node
// helix 资产生成器：从本机 helix-editor/helix 与 markpad-aio 源资产生成
// packages/vviewer-highlight/assets/{languages.json,themes.json,queries/}（溯源见 tools/helix-assets/README.md）。
// 用法：node tools/helix-assets/generate.mjs（可重复执行，产物幂等）
import { parse } from 'smol-toml';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  outDir: process.env.VV_ASSETS_OUT ?? path.join(repoRoot, 'packages/vviewer-highlight/assets'),
};

// helix 内置 palette（helix-view/src/theme.rs ThemePalette::default）的兜底色名。
// helix 中为 ANSI Color 枚举（由终端解释），此处落为经典 xterm 默认调色板 hex；
// "default"（Color::Reset，继承终端前景/背景）无固定 hex，未收录。
export const BUILTIN_PALETTE = Object.freeze({
  black: '#000000',
  red: '#cd0000',
  green: '#00cd00',
  yellow: '#cdcd00',
  blue: '#0000ee',
  magenta: '#cd00cd',
  cyan: '#00cdcd',
  gray: '#e5e5e5',
  'light-red': '#ff0000',
  'light-green': '#00ff00',
  'light-yellow': '#ffff00',
  'light-blue': '#5c5cff',
  'light-magenta': '#ff00ff',
  'light-cyan': '#00ffff',
  'light-gray': '#7f7f7f',
  white: '#ffffff',
});

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

/** '#RGB'/'#RRGGBB' → 统一 6 位小写 '#rrggbb'（对应 Color::from_hex 的两种格式）。 */
function normalizeHex(value) {
  if (typeof value !== 'string' || !value.startsWith('#')) return value;
  const hex = value.slice(1);
  return hex.length === 3 ? `#${[...hex].map((c) => c + c).join('')}` : `#${hex.toLowerCase()}`;
}

/** palette 表值统一归一化。 */
function normalizePalette(palette) {
  const out = {};
  for (const [name, value] of Object.entries(palette)) out[name] = normalizeHex(value);
  return out;
}

/**
 * 按有效 palette 解析单个主题 doc 为 Record<capture, { fg?, bg?, modifiers? }>。
 * 色值查找顺序遵循 helix 语义（ThemePalette::new + merge_themes）：
 * 内置表 → 父主题 palette（递归）→ 本主题 palette。
 * 未命中的 fg/bg 字段按 helix 行为丢弃，色名记入 misses（由调用方按主题聚合告警）。
 */
function stylesFromDoc(doc, palette) {
  const misses = new Set();
  const resolveColor = (value) => {
    if (typeof value !== 'string') return undefined;
    if (value.startsWith('#')) return normalizeHex(value);
    const hit = palette[value];
    if (typeof hit === 'string') return hit;
    misses.add(value);
    return undefined;
  };

  const styles = {};
  for (const [capture, value] of Object.entries(doc)) {
    if (capture === 'palette' || capture === 'inherits') continue;
    if (typeof value === 'string') {
      const fg = resolveColor(value);
      if (fg !== undefined) styles[capture] = { fg };
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const style = {};
      const fg = resolveColor(value.fg);
      const bg = resolveColor(value.bg);
      if (fg !== undefined) style.fg = fg;
      if (bg !== undefined) style.bg = bg;
      if (Array.isArray(value.modifiers))
        style.modifiers = value.modifiers.filter((m) => typeof m === 'string');
      if (Object.keys(style).length > 0) styles[capture] = style;
    }
  }
  return { styles, misses: [...misses] };
}

/**
 * 解析单个主题 TOML 为 { styles, misses }。
 * palette 按 helix 语义组合：内置表 → extraPalette（父主题 palette，调用方负责递归合并）→ 本主题 palette。
 */
export function parseTheme(tomlText, extraPalette = {}) {
  const doc = parse(tomlText);
  const palette = normalizePalette({ ...BUILTIN_PALETTE, ...extraPalette, ...(doc.palette ?? {}) });
  return stylesFromDoc(doc, palette);
}

/**
 * 读取主题目录（跳过 theme.toml 与 base16_*.toml，枚举已排序保证跨机幂等），
 * 按 inherits 链解析：父主题样式与 palette 先合并（多父按声明顺序），子按捕获覆盖。
 */
export function collectThemes(themesDir) {
  const raw = new Map(); // name -> { inherits, palette, doc }
  for (const file of fs.readdirSync(themesDir).sort()) {
    if (!file.endsWith('.toml')) continue;
    if (file === 'theme.toml' || file.startsWith('base16_')) continue;
    const name = file.slice(0, -'.toml'.length);
    const doc = parse(fs.readFileSync(path.join(themesDir, file), 'utf8'));
    raw.set(name, {
      inherits: typeof doc.inherits === 'string' ? doc.inherits : '',
      palette: doc.palette ?? {},
      doc,
    });
  }

  const resolved = new Map();
  // 返回 { styles, palette }：palette 为有效 palette（builtin + 父链 + 自身）
  const resolveTheme = (name, onPath) => {
    const cached = resolved.get(name);
    if (cached) return cached;
    const entry = raw.get(name);
    if (!entry) return { styles: {}, palette: { ...BUILTIN_PALETTE } };
    if (onPath.has(name)) {
      console.warn(`[helix-assets] 主题 inherits 环: ${[...onPath, name].join(' -> ')}`);
      return { styles: {}, palette: { ...BUILTIN_PALETTE, ...entry.palette } };
    }
    onPath.add(name);
    let parentStyles = {};
    let parentPalette = { ...BUILTIN_PALETTE };
    if (entry.inherits) {
      for (const parent of entry.inherits.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!raw.has(parent)) {
          console.warn(`[helix-assets] 主题 ${name} inherits 的父主题缺失: ${parent}`);
          continue;
        }
        const ancestor = resolveTheme(parent, onPath);
        parentStyles = { ...parentStyles, ...ancestor.styles };
        parentPalette = { ...parentPalette, ...ancestor.palette };
      }
    }
    onPath.delete(name);

    const palette = normalizePalette({ ...parentPalette, ...entry.palette });
    const { styles, misses } = stylesFromDoc(entry.doc, palette);
    if (misses.length > 0)
      console.warn(`[helix-assets] 主题 ${name} palette 未命中(对应字段已丢弃): ${misses.join(', ')}`);
    const result = { styles: { ...parentStyles, ...styles }, palette };
    resolved.set(name, result);
    return result;
  };

  const themes = {};
  for (const name of raw.keys()) themes[name] = resolveTheme(name, new Set()).styles;
  return themes;
}

/**
 * tags 补源表（代码大纲查询，2026-10-31 code-outline Task 1）：与 themesDir 同源的 helix
 * 检出为上游（本机直接拷贝，零网络零缓存——commit 仅记录源时点供溯源）。
 * nvim-treesitter 不可作为 tags 上游：master（cf12346a，2026-11-01 实测）已整体移除
 * tags.scm 且 git 历史不可及（commits?path=... 返回空，疑 force-push 重写）。
 * langs 为大纲首版目标语言（typescript/tsx/bash/zig/lua/c）+ 其继承父共享目录
 * （_typescript/_javascript/_jsx——typescript 声明 `; inherits: _typescript,ecma`、
 * tsx 声明 `; inherits: _jsx,_typescript,ecma`，父目录无 tags.scm 时链断）；
 * 上游缺 json/shell（helix runtime/queries 实测无此二语言 tags.scm，shell 由 bash 覆盖），如实缺补。
 * _javascript 如实备案：helix 的 javascript/tags.scm 是自含实体查询（非 inherits 声明，
 * 不经 _javascript），现资产树无任何语言继承它——该目录当前零消费者，纯冗余留源
 * （资产树若引入 inherits: _javascript 形态即生效），拷贝成本一条文件忽略不计。
 */
export const TAGS_SOURCES = {
  queriesDir: process.env.VV_TAGS_QUERIES_DIR ?? '/share/rw/repo/github/helix-editor/helix/runtime/queries',
  commit: 'ba40e547426b0f9896c8bdc699a4ab11f2b37dbc',
  langs: ['typescript', 'tsx', '_typescript', '_javascript', '_jsx', 'bash', 'zig', 'lua', 'c'],
};

/**
 * 拷贝 tags.scm 到产物 queries/{lang}/（存在即拷覆盖、缺目录静默跳过）。
 * 必须在 copyQueries 之后调用（其 rmSync 全量重建会清掉已拷文件）。
 * 返回实拷语言清单（守门测试与日志用）。
 */
export function copyTags(srcQueriesDir = TAGS_SOURCES.queriesDir, outDir = SOURCES.outDir, langs = TAGS_SOURCES.langs) {
  const copied = [];
  for (const lang of langs) {
    const src = path.join(srcQueriesDir, lang, 'tags.scm');
    if (!fs.existsSync(src)) continue; // 上游缺该语言：静默跳过（如实缺补，不阻塞生成）
    const destDir = path.join(outDir, 'queries', lang);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, path.join(destDir, 'tags.scm'));
    copied.push(lang);
  }
  return copied;
}

/**
 * 查询补丁：markpad queries 原样拷贝后的针对性修正（源更新导致 find 失配时 copyQueries
 * 报错退出、提醒人工复核，不静默跳过）。每项 { file, reason, find, replace }，find 须唯一命中。
 *
 * 历史条目（已移除）：ecma/injections.scm graphql 注入的 `.` 锚点——web-tree-sitter 0.25 对
 * 「根级双兄弟、无锚点」pattern（comment 与 [string|template_string] 并列）做 O(n²) 兄弟配对
 * 扫描，19KB 文件注入匹配 40s+ 挂起。Markpad 2026-10-07 pin 点上游已内置等价锚点
 * `((comment) @_ecma_comment) . [`（形态差异仅在锚点位于右括号外，语义相同），条目随之移除；
 * O(n²) 防护改由守门测试直接锁定入库资产的锚点形态。若未来上游回退为无锚形态，在此重新
 * 添加条目（find `  ((comment) @_ecma_comment [\n` → replace `  ((comment) @_ecma_comment . [\n`）。
 */
export const QUERY_PATCHES = [
  {
    file: 'solidity/highlights.scm',
    // 上游 struct_expression 的 type 捕获带组尾 `.`；单子元素组内的尾随锚点无兄弟可依
    // （0.25 语义空转），tree-sitter 0.27 起为硬语法错误（TSQueryErrorSyntax）。删去组尾
    // 锚点——服务端 301 门禁（full_registry_count_is_301）依赖 solidity 可编译，勿回灌。
    reason: '单子元素组内尾随锚点为 tree-sitter 0.27 硬语法错误，且 0.25 语义空转',
    find: '(struct_expression type: ((expression (identifier)) @type .))',
    replace: '(struct_expression type: ((expression (identifier)) @type))',
  },
];

/** 应用查询补丁到已拷贝的 queries 目录（导出供测试）。 */
export function applyQueryPatches(destDir, patches) {
  for (const { file, reason, find, replace } of patches) {
    const p = path.join(destDir, file);
    const text = fs.readFileSync(p, 'utf8');
    const hits = text.split(find).length - 1;
    if (hits !== 1) {
      throw new Error(`查询补丁失配（命中 ${hits} 次，期望 1 次）: ${file} — ${reason}，请人工复核 QUERY_PATCHES`);
    }
    fs.writeFileSync(p, text.replace(find, replace));
  }
}

/** 复制 markpad queries/ 全量目录（原样拷贝 + QUERY_PATCHES 针对性修正）。 */
function copyQueries(srcDir, outDir) {
  const dest = path.join(outDir, 'queries');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(srcDir, dest, { recursive: true });
  applyQueryPatches(dest, QUERY_PATCHES);
  return fs.readdirSync(dest).filter((d) => fs.statSync(path.join(dest, d)).isDirectory()).length;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function generateAll({
  languagesToml = SOURCES.languagesToml,
  queriesDir = SOURCES.queriesDir,
  themesDir = SOURCES.themesDir,
  outDir = SOURCES.outDir,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });

  const languages = parseLanguages(fs.readFileSync(languagesToml, 'utf8'));
  writeJson(path.join(outDir, 'languages.json'), languages);

  const themes = collectThemes(themesDir);
  writeJson(path.join(outDir, 'themes.json'), themes);

  const queryDirCount = copyQueries(queriesDir, outDir);
  // tags 补源须在 copyQueries 之后（全量重建会清掉已拷文件）
  const copiedTags = copyTags(TAGS_SOURCES.queriesDir, outDir);

  console.log(
    `[helix-assets] 生成完成: languages=${Object.keys(languages).length} themes=${Object.keys(themes).length} queryDirs=${queryDirCount} tags=${copiedTags.length} -> ${outDir}`,
  );
  return { languages: Object.keys(languages).length, themes: Object.keys(themes).length, queryDirCount, copiedTags };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateAll();
}
