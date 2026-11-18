#!/usr/bin/env node
// gen-sources.mjs — grammar 生态源清单单源生成器（spec F 构建源头化）。
// 唯一上游事实源 = helix pin（tools/grammar-builder/helix-pin.json，master commit 锚）：
//   ① languages.toml@pin 拉取解析 → 派生四产物 + languages.toml 本体落盘：
//      tools/grammar-builder/languages.toml（build.mjs --fetch 的 [[grammar]] 源清单输入）
//      tools/grammar-builder/build-list.json（--self-build 目标清单：[[grammar]] 全集 −
//        use-grammars.except，parserCExists 恒 true——信任 helix 清单不预探测，实探由
//        --fetch/self-build 失败清单机制承接）
//      packages/vviewer-highlight/assets/languages.json（[[language]] 派生，零增补）
//      server/grammars-manifest.json（服务端验收集合，期望条目数=grammars 数组长度——
//        动态门禁真相源；含 vue：server 从源码编译 vue，wasm 通道 fixtures 短路另行处理）
//      packages/vviewer-core/src/registry/generated-extensions.ts（fileTypes 全集模块）
//   ② queries@pin 整树拉取 → assets/queries/（**整树不过滤语言清单**——_typescript/
//      _javascript/ecma/php-only 等继承父目录与变体目录必须入盘，逐语言过滤断 inherits 链；
//      tags.scm 随整树同 pin 收编，TAGS_SOURCES 独立 pin 机制退役）；QUERY_PATCHES 应用
//      （唯一命中替换，命中≠1 抛错）。
//   ③ themes@pin 拉取 → assets/themes.json（collectThemes 规则内跳 theme.toml/base16_）。
// 生成物全部不入库（.gitignore 出库）；消费端缺失报错指向 pnpm gen:sources。
// 纯函数面自旧脚本签名不变整迁（helix-assets/generate.mjs:29-202/:253-276、
// gen-code-extensions.mjs、build.mjs parseGrammarSources），零语义漂移（含 console.warn
// 前缀原样保留）；网络失败显式报错不静默（pin 解析失败/trees truncated/raw 单文件失败
// 重试 1 次后仍败即抛错带失败清单）。api.github.com 匿名 60/h（gen 恒 1-2 次调用，
// refresh 1 次；可选 GITHUB_TOKEN），raw.githubusercontent.com 走 CDN 无 API 限速。
// 用法：
//   node tools/grammar-builder/gen-sources.mjs             # 按 pin 全量生成（变更摘要）
//   node tools/grammar-builder/gen-sources.mjs --refresh   # resolve master HEAD → 更新 pin →
//                                                            # 全量重生成 + 差异报告（pin 缺失自动初始化）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/** 产物路径常量（languages.toml 与 build.mjs PATHS.languagesToml 同路径——出库后由 gen 写）。 */
export const PATHS = {
  pinPath: path.join(here, 'helix-pin.json'),
  languagesToml: path.join(here, 'languages.toml'),
  buildListJson: path.join(here, 'build-list.json'),
  aliasesJson: path.join(here, 'aliases.json'),
  assetsDir: path.join(repoRoot, 'packages/vviewer-highlight/assets'),
  languagesJson: path.join(repoRoot, 'packages/vviewer-highlight/assets/languages.json'),
  themesJson: path.join(repoRoot, 'packages/vviewer-highlight/assets/themes.json'),
  queriesDir: path.join(repoRoot, 'packages/vviewer-highlight/assets/queries'),
  serverManifest: path.join(repoRoot, 'server/grammars-manifest.json'),
  generatedExtensions: path.join(repoRoot, 'packages/vviewer-core/src/registry/generated-extensions.ts'),
};

export const HELIX_REPO = 'helix-editor/helix';
export const API_BASE = 'https://api.github.com';
export const RAW_BASE = 'https://raw.githubusercontent.com';
const RAW_CONCURRENCY = 8;
const RAW_ATTEMPTS = 2; // 首次 + 重试 1 次（线性退避）
const RAW_RETRY_DELAY_MS = 300;

// ---------- 纯函数面（自 helix-assets/generate.mjs 原样迁，签名不变零语义漂移） ----------

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
  const doc = parseToml(tomlText);
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
  const doc = parseToml(tomlText);
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
    const doc = parseToml(fs.readFileSync(path.join(themesDir, file), 'utf8'));
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
 * 查询补丁：helix queries@pin 原样落盘后的针对性修正（上游查询失配时抛错退出、提醒
 * 人工复核，不静默跳过）。每项 { file, reason, find, replace }，find 须唯一命中。
 * 溯源：机制自 tools/helix-assets/generate.mjs 原样迁入（QUERY_PATCHES 历史沿革见
 * helix-assets 退役前的 generate.mjs 注释与 T5 的 grammar-builder README）。
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
    // 锚点——服务端门禁依赖 solidity 可编译，勿回灌。
    reason: '单子元素组内尾随锚点为 tree-sitter 0.27 硬语法错误，且 0.25 语义空转',
    find: '(struct_expression type: ((expression (identifier)) @type .))',
    replace: '(struct_expression type: ((expression (identifier)) @type))',
  },
];

/** 应用查询补丁到已落盘的 queries 目录（导出供测试）。 */
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

/**
 * grammar 源覆盖（[[grammar]] source 段文本级覆盖）。
 *
 * **yaml**：helix master 的 yaml 源为 ikatyang/tree-sitter-yaml（归档仓，C++ 外置
 * scanner `scanner.cc`）——cli ≥0.26 的 wasm 工具链 `get_scanner_path` 只认
 * `scanner.c`，C++ scanner 不可编译 → **yaml.wasm 不产出** → 2026-10-16 落地的
 * BUG-37 修复（yaml 本地 wasm 高亮）被静默回退，yaml 恒降级 hljs（且无任何日志：
 * wasm 缺失即「该语言无产物」，问题面藏在构建产物里）。
 * 覆盖为 tree-sitter-grammars 维护 fork v0.7.2（**C 外置 scanner.c**，cli 0.27 自建
 * 成功）——即 BUG-37 清偿所用的同一源（docs/spec-deviations.md §10 回补条件部分达成）。
 *
 * 纪律：命中数必须为 1（否则抛错要求人工复核——上游改源即须复核覆盖是否仍适用）；
 * 已覆盖形态幂等跳过（重复跑 gen-sources 不报错）。
 */
export const GRAMMAR_SOURCE_OVERRIDES = [
  {
    grammar: 'yaml',
    reason:
      'ikatyang 源的 C++ 外置 scanner（scanner.cc）不可被 cli wasm 工具链编译 → yaml.wasm 不产出（BUG-37 回退，yaml 恒降级 hljs）',
    find: 'source = { git = "https://github.com/ikatyang/tree-sitter-yaml", rev = "0e36bed171768908f331ff7dff9d956bae016efb" }',
    replace:
      'source = { git = "https://github.com/tree-sitter-grammars/tree-sitter-yaml", rev = "7708026449bed86239b1cd5bce6e3c34dbca6415" }',
  },
];

/**
 * 应用 grammar 源覆盖到 languages.toml 文本（导出供测试）。
 *
 * 判定口径：① 已是覆盖形态 → 幂等跳过；② 命中 find 恰 1 次 → 覆盖；③ 清单里**没有**
 * 该 grammar 块（如测试夹具/精简清单）→ 跳过（无覆盖需求）；④ 有该 grammar 块但
 * 源文本与已知形态不符（上游改源）→ **抛错**要求人工复核，不静默放过（否则 yaml
 * 悄悄回到不可编译的源，wasm 不产出且无日志）。
 *
 * @param {string} tomlText 上游 languages.toml 原文
 * @param {Array<{grammar: string, reason: string, find: string, replace: string}>} overrides 覆盖表
 * @returns {string} 覆盖后的文本
 */
export function applyGrammarSourceOverrides(tomlText, overrides = GRAMMAR_SOURCE_OVERRIDES) {
  let out = tomlText;
  for (const { grammar, reason, find, replace } of overrides) {
    if (out.includes(replace)) continue; // 已覆盖（幂等）
    const hits = out.split(find).length - 1;
    if (hits === 1) {
      out = out.replace(find, replace);
      continue;
    }
    if (hits > 1) {
      throw new Error(
        `grammar 源覆盖失配（命中 ${hits} 次，期望 1 次）: ${grammar} — ${reason}，请人工复核 GRAMMAR_SOURCE_OVERRIDES`,
      );
    }
    // 未命中：清单里没有该 grammar 块 → 无需覆盖；有块但源形态变了 → 抛错复核
    const hasBlock = new RegExp(`\\[\\[grammar\\]\\]\\s*name\\s*=\\s*"${grammar}"`).test(out);
    if (hasBlock) {
      throw new Error(
        `grammar 源覆盖失配（源文本与已知形态不符）: ${grammar} — ${reason}，请人工复核 GRAMMAR_SOURCE_OVERRIDES`,
      );
    }
  }
  return out;
}

// ---------- 纯函数面（自 gen-code-extensions.mjs 迁，toModule 头注释按出库语义改） ----------

/** normalize→过滤→去重→升序。可作扩展名的 token 才收（glob 形排除）。 */
export function collectExtensions(languages) {
  const out = new Set();
  for (const entry of Object.values(languages)) {
    for (const ft of entry.fileTypes ?? []) {
      const norm = String(ft).trim().toLowerCase().replace(/^\./, '');
      if (/^[a-z0-9][a-z0-9+.-]*$/.test(norm)) out.add(norm);
    }
  }
  return [...out].sort();
}

export function toModule(exts) {
  return `// 由 tools/grammar-builder/gen-sources.mjs 生成；勿手改。\n` +
    `// 生成物不入库（构建源头化），消费端缺失时报错指向 pnpm gen:sources。\n` +
    `// 来源：packages/vviewer-highlight/assets/languages.json 的 fileTypes 全集。\n` +
    `export const GENERATED_EXTENSIONS: readonly string[] = ${JSON.stringify(exts)};\n`;
}

export function verify(languages, onDisk) {
  const expected = toModule(collectExtensions(languages));
  return expected === onDisk;
}

// ---------- 纯函数面（自 build.mjs parseGrammarSources 原样迁，输入参数化为 toml 文本） ----------

/**
 * 解析 languages.toml 的 [[grammar]] 段：
 * Map<name, { git, rev, subpath }>（subpath 缺省 ''）。缺 git/rev 的条目跳过（无源可取）。
 */
export function parseGrammarSources(tomlText) {
  const doc = parseToml(tomlText);
  const out = new Map();
  for (const g of doc.grammar ?? []) {
    if (!g || typeof g.name !== 'string') continue;
    const src = g.source ?? {};
    if (typeof src.git !== 'string' || typeof src.rev !== 'string') continue;
    out.set(g.name, { git: src.git, rev: src.rev, subpath: typeof src.subpath === 'string' ? src.subpath : '' });
  }
  return out;
}

// ---------- 新增派生面（TDD 主体）------------------------------------------------

/** use-grammars.except 读取（helix 语义照抄——被剔除的 grammar 不进任何清单）。 */
export function exceptGrammars(grammarDoc) {
  const except = grammarDoc['use-grammars']?.except;
  return Array.isArray(except) ? except.filter((s) => typeof s === 'string') : [];
}

/** cSymbol 派生规约（spec F §8）：tree_sitter_<name，-→_>；fetch 后由 build.mjs 从
 *  parser.c 交叉验证（不符进 fetch-failures 失败清单，无例外表）。 */
export function cSymbolOf(name) {
  return `tree_sitter_${name.replace(/-/g, '_')}`;
}

/**
 * [[grammar]] 派生 build-list（全集 − use-grammars.except；形态与旧 build-list.json 逐字段一致）。
 * parserCExists 恒 true：语义=信任 helix 清单不预探测（spec §3.2.1 裁量落定）——实探在
 * --fetch/self-build 的失败清单机制（fetchOneGrammar 的 parser.c 判据）承接；
 * helixLang=name（条目本身即 helix [[grammar]] 名）。零 build.mjs resolveTargets 改动。
 */
export function deriveBuildList(grammarDoc, exceptList = []) {
  const except = new Set(exceptList);
  const entries = [];
  for (const g of grammarDoc.grammar ?? []) {
    if (!g || typeof g.name !== 'string' || g.name === '') continue;
    if (except.has(g.name)) continue;
    entries.push({
      name: g.name,
      subpath: typeof g.source?.subpath === 'string' ? g.source.subpath : '',
      parserCExists: true,
      helixLang: g.name,
    });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

/**
 * server manifest 派生：{ note, generatedAt, grammars: [{name, dir: name, subpath, cSymbol}] }。
 * 形态与旧 gen-server-manifest 产物零变化（build.rs serde 不动）；cSymbol 单源=cSymbolOf；
 * note 更新为动态门禁真相源表述（spec F §5）。
 */
export function deriveServerManifest(grammarDoc, exceptList = []) {
  const grammars = deriveBuildList(grammarDoc, exceptList).map((e) => ({
    name: e.name,
    dir: e.name,
    subpath: e.subpath,
    cSymbol: cSymbolOf(e.name),
  }));
  return {
    note: '由 gen-sources.mjs 从 helix pin 派生（node tools/grammar-builder/gen-sources.mjs）；server/core/build.rs 的编译与 FFI 输入，期望条目数=grammars 数组长度（动态门禁真相源，spec F §5）',
    generatedAt: new Date().toISOString(),
    grammars,
  };
}


/**
 * 新旧产物差异报告：
 * products 形态 { manifestNames: string[], grammarRevs: Map<name, rev>, queries: Map<relPath, text> }。
 * - added/removed：manifest 名集差（新−旧 / 旧−新，按新/旧侧序）
 * - revChanged：同名双侧 rev 不同条目数（单侧增删不计）
 * - queriesChanged：相对路径并集上内容不一致（含单侧存在）的文件数
 */
export function diffReport(oldProducts, newProducts) {
  const oldNames = new Set(oldProducts.manifestNames);
  const newNames = new Set(newProducts.manifestNames);
  const added = newProducts.manifestNames.filter((n) => !oldNames.has(n));
  const removed = oldProducts.manifestNames.filter((n) => !newNames.has(n));
  let revChanged = 0;
  for (const [name, rev] of newProducts.grammarRevs) {
    const prev = oldProducts.grammarRevs.get(name);
    if (prev !== undefined && prev !== rev) revChanged++;
  }
  let queriesChanged = 0;
  const allPaths = new Set([...oldProducts.queries.keys(), ...newProducts.queries.keys()]);
  for (const p of allPaths) {
    if (oldProducts.queries.get(p) !== newProducts.queries.get(p)) queriesChanged++;
  }
  return { added, removed, revChanged, queriesChanged };
}

// ---------- aliases 一致性门禁（Review Focus 5 / Errata ③）---------------------------

/** 已知合法差异白名单：objc/systemrdl 不在 helix 清单（aliases.json 自有资产与上游清单的
 *  既有差异，硬 fail 会翻转既有 README 记录的行为）。 */
export const ALIASES_KNOWN_MISSING = Object.freeze(['objc', 'systemrdl']);

/**
 * aliases.json 每键须命中 manifest 名集（含 -/_ 变体）；未命中即报错，
 * 白名单键告警放行。返回 { missing, warned }（单测锁白名单内外两态）。
 */
export function validateAliases(aliases, manifestNames) {
  const names = new Set(manifestNames);
  const variants = (k) => [k, k.replace(/-/g, '_'), k.replace(/_/g, '-')];
  const missing = Object.keys(aliases).filter((k) => !variants(k).some((v) => names.has(v)));
  const warned = missing.filter((k) => ALIASES_KNOWN_MISSING.includes(k));
  const hard = missing.filter((k) => !ALIASES_KNOWN_MISSING.includes(k));
  if (hard.length > 0) {
    throw new Error(
      `aliases.json 键未命中 manifest 名集（含 -/_ 变体）: ${hard.join(', ')}` +
        `——gen-sources 从 helix pin 派生的清单中不存在；若为新增合法差异，更新 ALIASES_KNOWN_MISSING 或核对 pin`,
    );
  }
  if (warned.length > 0) {
    console.warn(`[gen-sources] aliases 已知差异（白名单放行）: ${warned.join(', ')}`);
  }
  return { missing, warned };
}

// ---------- pin 读写与校验---------------------------------------------------------

function pinError(message) {
  return new Error(
    `${message}——修复 tools/grammar-builder/helix-pin.json，或执行 ` +
      `node tools/grammar-builder/gen-sources.mjs --refresh（首跑自动初始化 pin）`,
  );
}

/** pin 形态 { ref: master, commit 40hex, release（恒空——master 锚定后 release 不再作为锚）,
 *  refreshedAt ISO8601 }；缺字段/commit 非 40hex 显式报错指向 --refresh。 */
export function validatePin(pin) {
  const shape = (msg) => pinError(`helix-pin.json 校验失败: ${msg}`);
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) throw shape('非对象');
  if (typeof pin.ref !== 'string' || pin.ref === '') throw shape('ref 缺失或非字符串');
  if (typeof pin.commit !== 'string' || !/^[0-9a-f]{40}$/.test(pin.commit))
    throw shape(`commit 非 40hex: ${JSON.stringify(pin.commit)}`);
  if (typeof pin.release !== 'string') throw shape('release 缺失或非字符串');
  if (typeof pin.refreshedAt !== 'string' || Number.isNaN(Date.parse(pin.refreshedAt)))
    throw shape('refreshedAt 非 ISO8601 时间');
  return pin;
}

/** 读 pin：缺文件/JSON 损坏/校验不过均显式报错指向 --refresh。 */
export function readPin(pinPath = PATHS.pinPath) {
  if (!fs.existsSync(pinPath)) {
    throw pinError(`helix-pin.json 缺失: ${pinPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
  } catch (err) {
    throw pinError(`helix-pin.json JSON 解析失败: ${pinPath}（${err instanceof Error ? err.message : String(err)}）`);
  }
  return validatePin(parsed);
}

/** 写 pin（原子落盘）：master commit 锚 + refreshedAt。返回写入的 pin 对象。 */
export function writePin(pinPath = PATHS.pinPath, commit) {
  const pin = { ref: 'master', commit, release: '', refreshedAt: new Date().toISOString() };
  atomicWrite(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
  return pin;
}

// ---------- 网络面（fetch 参数可注入供单测 mock）------------------------------------

function ghHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'vviewer-gen-sources' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 有限并发池（沿用 fetch-e2e-corpus 的 runPool 形态）。 */
async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
}

/** resolve master HEAD commit（GITHUB_TOKEN 可选 Bearer；非 200 显式报错）。 */
export async function resolveMasterHead({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${API_BASE}/repos/${HELIX_REPO}/commits/master`, { headers: ghHeaders() });
  if (!res.ok) {
    throw new Error(`解析 helix master HEAD 失败: HTTP ${res.status}（${API_BASE}）——检查网络，或设 GITHUB_TOKEN 提升限流`);
  }
  const body = await res.json();
  const sha = body?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`helix master HEAD 响应无 40hex sha: ${JSON.stringify(sha).slice(0, 120)}`);
  }
  return sha;
}

/** languages.toml@pin 拉取（raw CDN；非 200 或 HTML 拦截页显式报错）。 */
export async function fetchPinLanguagesToml(commit, { fetchImpl = fetch } = {}) {
  const url = `${RAW_BASE}/${HELIX_REPO}/${commit}/languages.toml`;
  const res = await fetchImpl(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`languages.toml@${commit.slice(0, 7)} 拉取失败: HTTP ${res.status}（${url}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 200).toString('latin1').toLowerCase().startsWith('<!doctype html')) {
    throw new Error(`languages.toml@${commit.slice(0, 7)} 返回 HTML 错误页（疑似拦截/限流页）: ${url}`);
  }
  return buf.toString('utf8');
}

/** helix 整仓树列举（trees API recursive 一次列全；truncated 即抛错——显式不静默，
 *  spec §3.2.2 corpus 算法同源，fetch-e2e-corpus.mjs 先例）。返回 blob 清单。 */
export async function fetchHelixTree(commit, { fetchImpl = fetch } = {}) {
  const url = `${API_BASE}/repos/${HELIX_REPO}/git/trees/${commit}?recursive=1`;
  const res = await fetchImpl(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`helix 树列举失败: HTTP ${res.status}（${url}）`);
  const body = await res.json();
  if (body?.truncated) {
    throw new Error(`helix 树列举返回 truncated（清单不完整，递归列举被截断）: ${url}——显式失败不静默`);
  }
  if (!Array.isArray(body?.tree)) throw new Error(`helix 树列举响应无 tree 数组: ${url}`);
  return body.tree.filter((e) => e?.type === 'blob');
}

/** raw 单文件下载：非 2xx 或 HTML 错误页按失败，重试 1 次（线性退避）后仍败抛出末次错误。 */
async function fetchRaw(url, { fetchImpl = fetch } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= RAW_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(RAW_RETRY_DELAY_MS);
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': 'vviewer-gen-sources' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.subarray(0, 200).toString('latin1').toLowerCase().startsWith('<!doctype html')) {
        throw new Error('返回 HTML 错误页（疑似拦截/限流页）');
      }
      return buf;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function failWithList(kind, failures, total) {
  const detail = failures.map((f) => `- ${f.file}: ${f.reason}`).join('\n');
  throw new Error(`${kind}拉取失败 ${failures.length}/${total} 个（重试 1 次后仍败，显式不静默）：\n${detail}`);
}

/**
 * queries@pin 整树拉取（Review Focus 2：**不过滤语言清单**——inherits 父目录与变体目录
 * 保形入盘）→ 临时目录 → applyQueryPatches → 原子换入 outDir。tags.scm 随整树天然覆盖。
 * 单文件失败重试 1 次，仍败抛错带失败清单（临时目录清理，既有 outDir 不受影响）。
 * 返回落盘 .scm 文件数。
 */
export async function pullQueries(treeFiles, commit, outDir, { fetchImpl = fetch, patches = QUERY_PATCHES } = {}) {
  const files = treeFiles
    .map((f) => (typeof f?.path === 'string' ? f.path : ''))
    .filter((p) => p.startsWith('runtime/queries/') && p.endsWith('.scm'))
    .map((p) => p.slice('runtime/queries/'.length));
  if (files.length === 0) {
    throw new Error(`queries 清单为空（tree 无 runtime/queries/**/*.scm）@${commit.slice(0, 7)}——树清单异常，显式失败`);
  }
  const tmp = path.join(path.dirname(outDir), `.queries.tmp-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const failures = [];
  try {
    await runPool(files, RAW_CONCURRENCY, async (rel) => {
      try {
        const buf = await fetchRaw(`${RAW_BASE}/${HELIX_REPO}/${commit}/runtime/queries/${rel.split('/').map(encodeURIComponent).join('/')}`, { fetchImpl });
        const destDir = path.join(tmp, path.dirname(rel));
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(path.join(tmp, rel), buf);
      } catch (err) {
        failures.push({ file: `runtime/queries/${rel}`, reason: err instanceof Error ? err.message : String(err) });
      }
    });
    if (failures.length > 0) failWithList('queries', failures, files.length);
    applyQueryPatches(tmp, patches);
    fs.rmSync(outDir, { recursive: true, force: true });
    swapDirIntoPlace(tmp, outDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return files.length;
}

/**
 * themes@pin 拉取（runtime/themes/*.toml，flat）→ 临时目录 → collectThemes（跳
 * theme.toml/base16_ 规则内含）→ themes.json 原子写入 assetsDir。失败清单语义同 pullQueries。
 * 返回主题数。
 */
export async function pullThemes(treeFiles, commit, assetsDir, { fetchImpl = fetch } = {}) {
  const files = treeFiles
    .map((f) => (typeof f?.path === 'string' ? f.path : ''))
    .filter((p) => /^runtime\/themes\/[^/]+\.toml$/.test(p));
  if (files.length === 0) {
    throw new Error(`themes 清单为空（tree 无 runtime/themes/*.toml）@${commit.slice(0, 7)}——树清单异常，显式失败`);
  }
  const tmp = path.join(assetsDir, `.themes.tmp-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const failures = [];
  try {
    await runPool(files, RAW_CONCURRENCY, async (p) => {
      try {
        const buf = await fetchRaw(`${RAW_BASE}/${HELIX_REPO}/${commit}/${p.split('/').map(encodeURIComponent).join('/')}`, { fetchImpl });
        fs.writeFileSync(path.join(tmp, path.basename(p)), buf);
      } catch (err) {
        failures.push({ file: p, reason: err instanceof Error ? err.message : String(err) });
      }
    });
    if (failures.length > 0) failWithList('themes', failures, files.length);
    const themes = collectThemes(tmp);
    atomicWrite(path.join(assetsDir, 'themes.json'), `${JSON.stringify(themes, null, 2)}\n`);
    return Object.keys(themes).length;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- 原子落盘---------------------------------------------------------------

/** 单文件原子写：同目录 tmp + rename（同盘必然成立）。 */
function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** 整目录原子换入：同盘 rename 优先；跨盘（EXDEV）退化 copy+rm。调用方负责先移除目标。 */
function swapDirIntoPlace(tmpDir, targetDir) {
  try {
    fs.renameSync(tmpDir, targetDir);
    return;
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
  }
  fs.cpSync(tmpDir, targetDir, { recursive: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------- 盘面快照（差异报告输入）------------------------------------------------

function collectScmMap(dir, prefix, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) collectScmMap(path.join(dir, e.name), rel, out);
    else if (e.name.endsWith('.scm')) out.set(rel, fs.readFileSync(path.join(dir, e.name), 'utf8'));
  }
}

function readQueriesMap(queriesDir) {
  const map = new Map();
  if (fs.existsSync(queriesDir)) collectScmMap(queriesDir, '', map);
  return map;
}

/**
 * 读盘上旧产物为差异报告输入；manifest 与 queries 均缺席（首跑/fresh clone）返回 null。
 * manifest 缺席但 queries 在（半态）：以空名集参与 diff（如实放大为全量 added）。
 */
function snapshotProducts(P) {
  const hasManifest = fs.existsSync(P.serverManifest);
  const hasQueries = fs.existsSync(P.queriesDir);
  if (!hasManifest && !hasQueries) return null;
  let manifestNames = [];
  if (hasManifest) {
    const m = JSON.parse(fs.readFileSync(P.serverManifest, 'utf8'));
    manifestNames = Array.isArray(m?.grammars)
      ? m.grammars.map((g) => g?.name).filter((n) => typeof n === 'string')
      : [];
  }
  const grammarRevs = new Map();
  if (fs.existsSync(P.languagesToml)) {
    for (const [name, src] of parseGrammarSources(fs.readFileSync(P.languagesToml, 'utf8'))) {
      grammarRevs.set(name, src.rev);
    }
  }
  return { manifestNames, grammarRevs, queries: readQueriesMap(P.queriesDir) };
}

// ---------- 主流程-----------------------------------------------------------------

/**
 * 主流程。
 * @param argv CLI 参数（--refresh）
 * @param opts.fetchImpl 网络注入（单测 mock）；opts.paths 产物路径覆盖（单测临时目录）；
 *        opts.sanity 真资产契约锚开关（扩展名 ≥100 / 含 jsonl——缺省开，fixture 主流程单测关）
 */
export async function main(argv = process.argv.slice(2), opts = {}) {
  const P = { ...PATHS, ...(opts.paths ?? {}) };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const refresh = argv.includes('--refresh');

  let commit;
  if (refresh) {
    commit = await resolveMasterHead({ fetchImpl });
    const oldPin = fs.existsSync(P.pinPath) ? readPin(P.pinPath) : null;
    writePin(P.pinPath, commit);
    if (oldPin && oldPin.commit !== commit) {
      console.log(`[gen-sources] pin 更新: ${oldPin.commit.slice(0, 7)} -> ${commit.slice(0, 7)}`);
    } else if (!oldPin) {
      console.log(`[gen-sources] pin 初始化: master@${commit.slice(0, 7)}（首跑自动初始化）`);
    } else {
      console.log(`[gen-sources] pin 未变: master@${commit.slice(0, 7)}（refreshedAt 已更新）`);
    }
  } else {
    commit = readPin(P.pinPath).commit;
  }
  console.log(`[gen-sources] 源锚: helix master@${commit}（${P.pinPath}）`);

  // ① languages.toml@pin → 四产物派生
  const tomlText = applyGrammarSourceOverrides(
    await fetchPinLanguagesToml(commit, { fetchImpl })
  );
  const grammarDoc = parseToml(tomlText);
  const exceptList = exceptGrammars(grammarDoc);
  const languages = parseLanguages(tomlText);
  const buildList = deriveBuildList(grammarDoc, exceptList);
  const manifest = deriveServerManifest(grammarDoc, exceptList);
  const extensions = collectExtensions(languages);
  const generatedExtensions = toModule(extensions);

  // 旧产物快照（先于任何落盘——差异报告的对比基线）
  const oldProducts = snapshotProducts(P);

  // ②③ queries/themes@pin
  const treeFiles = await fetchHelixTree(commit, { fetchImpl });
  const queryFiles = await pullQueries(treeFiles, commit, P.queriesDir, { fetchImpl });
  const themeCount = await pullThemes(treeFiles, commit, P.assetsDir, { fetchImpl });

  // 单文件产物原子落盘
  atomicWrite(P.languagesToml, tomlText);
  atomicWrite(P.buildListJson, `${JSON.stringify(buildList, null, 2)}\n`);
  atomicWrite(P.languagesJson, `${JSON.stringify(languages, null, 2)}\n`);
  atomicWrite(P.serverManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  atomicWrite(P.generatedExtensions, generatedExtensions);

  // aliases 一致性校验（Review Focus 5）：入库资产，缺席即显式报错
  if (!fs.existsSync(P.aliasesJson)) {
    throw new Error(`aliases.json 缺失: ${P.aliasesJson}（入库资产不应缺席）`);
  }
  const aliases = JSON.parse(fs.readFileSync(P.aliasesJson, 'utf8'));
  validateAliases(aliases, manifest.grammars.map((g) => g.name));

  // 真资产契约锚（自 gen-code-extensions main 迁入；fixture 单测经 opts.sanity=false 关断）
  if (opts.sanity !== false) {
    if (extensions.length < 100) throw new Error(`生成扩展名过少（${extensions.length}），语言源异常`);
    if (!extensions.includes('jsonl')) throw new Error('生成物必须含 jsonl（C/D 项契约锚点）');
  }

  // 差异报告/变更摘要（对盘上旧产物对比）
  const grammarRevs = new Map();
  for (const [name, src] of parseGrammarSources(tomlText)) grammarRevs.set(name, src.rev);
  const newProducts = {
    manifestNames: manifest.grammars.map((g) => g.name),
    grammarRevs,
    queries: readQueriesMap(P.queriesDir),
  };
  const diff = oldProducts ? diffReport(oldProducts, newProducts) : null;
  if (diff) {
    const names = (list) => (list.length > 0 ? `（${list.join(', ')}）` : '');
    console.log(
      `[gen-sources] 差异报告: 语言集 +${diff.added.length}${names(diff.added)} ` +
        `-${diff.removed.length}${names(diff.removed)}；rev 变更 ${diff.revChanged}；queries 差异 ${diff.queriesChanged} 文件`,
    );
  } else {
    console.log('[gen-sources] 首跑（盘上无旧产物）：差异报告以本次产物为准，下次运行起对比');
  }
  console.log(
    `[gen-sources] 生成完成: languages=${Object.keys(languages).length} ` +
      `build-list=${buildList.length} manifest=${manifest.grammars.length} ` +
      `themes=${themeCount} queries=${queryFiles} -> commit ${commit.slice(0, 7)}`,
  );
  return {
    commit,
    languages: Object.keys(languages).length,
    buildListCount: buildList.length,
    manifestCount: manifest.grammars.length,
    themeCount,
    queryFiles,
    diff,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
