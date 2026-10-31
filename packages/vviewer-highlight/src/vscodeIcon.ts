/**
 * VSCode 图标主题（icon theme）校验、归一化与字形匹配纯函数
 * （spec「图标主题+Open VSX」Task 1，为 Task 2 应用层 / Task 3 导入管线供数据面）。
 *
 * 职责：validateVscodeIconTheme（导入校验，容错优先口径仿 validateVscodeTheme——
 * 坏定义/坏 src/悬空引用逐条剔除，定义全空才拒）、normalizeIconTheme（原始 JSON →
 * 预编译查表 NormalizedIconTheme；IndexedDB 记录端直接存归一化形态，put/get 免重建
 * ——Map 经 structured clone 原生保形）、matchIconTheme（fileNames > fileExtensions
 * > languageIds 反向表 > _file 回退的优先级匹配）。纯函数、无 IO、零依赖。
 */

/**
 * 合法色值白名单——整份复制自 vscode.ts 的 COLOR_VALUE_RE（其刻意保持模块私有，
 * 不为共享而改既有导出面；正则为冻结形态白名单无漂移空间，改动时两处须同步，
 * test ③ 以同口径用例锚定）。fontColor 会原样拼进注入文本：白名单从根上杜绝
 * `;}`、`/*` 等 CSS 注入。
 */
const COLOR_VALUE_RE = /^#[0-9a-fA-F]{3,8}$|^rgba?\([0-9.,%\s/]+\)$/;

/** fontSize 白名单：数字+单位（px/em/rem/%），原样拼进 font-size 注入文本前的形状闸。 */
const FONT_SIZE_RE = /^[0-9.]+(px|em|rem|%)$/;

/**
 * fontCharacter 注入兜底闸：content:"…" 串内拒绝控制符与引号/反斜杠（可截断
 * CSS 字符串外逃）。真实字形（私用区/字母/符号）不受影响；注入层（Task 2）仍
 * 应十六进制转义（content:"\e001" 形态）双保险。
 */
const FONT_CHARACTER_FORBIDDEN_RE = /[\u0000-\u001F\u007F-\u009F"'\\]/;

/**
 * CSS 转义形态（官方图标主题惯例：JSON 里 "\u005CE003" 解析为 5 字符串 `\E003`）：
 * 解码为真实码点字符，尾随单个空白按 CSS 规范作终结符吃掉（`\E003 ` 同法）；
 * 码点非法（> U+10FFFF 或落代理区，fromCodePoint 会抛）返回 undefined 由调用方
 * 剔定义。JSON 转义（\uE003）经 JSON.parse 天然是单字符，不进本分支原样放行。
 */
const CSS_ESCAPE_RE = /^\\([0-9a-fA-F]{1,6})\s?$/;

function decodeFontCharacter(raw: string): string | undefined {
  const m = CSS_ESCAPE_RE.exec(raw);
  if (m === null) return raw;
  const hex = m[1];
  if (hex === undefined) return undefined;
  const cp = parseInt(hex, 16);
  if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return undefined;
  return String.fromCodePoint(cp);
}

/** fonts[].id 会拼进 @font-face font-family 注入文本：限安全字符集（真实主题 id 均为此形态）。 */
const FONT_ID_RE = /^[A-Za-z0-9_.-]+$/;

/** format 进 format("…")、weight/style 进 font-weight/style：限无引号字符集，形态异常宁缺。 */
const FONT_FORMAT_RE = /^[A-Za-z0-9]+$/;
const FONT_WEIGHT_STYLE_RE = /^[A-Za-z0-9 .-]+$/;

/** 归一化后的字形条目：由 iconDefinitions 定义解析而来（fontId 引用已在归一化时验毕）。 */
export interface IconGlyph {
  char: string;
  color?: string;
  fontSize?: string;
  /** 命中定义的 fontId（多字体主题渲染须 per-definition font-family，查 fontsById）。 */
  fontId?: string;
}

/** fonts 元数据：src 归一化为相对路径数组（VSCode 主题允许单字符串形态）。 */
export interface IconThemeFont {
  id: string;
  src: string[];
  format?: string;
  weight?: string;
  style?: string;
}

/**
 * 预编译查表形态（spec Interfaces 固化，T2/T3/T4 消费面）：五 Map 值为已解析
 * 字形（坏定义剔除、悬空引用连带剔除后仅剩可解析条目）；`_file`/`_folder`/
 * `_folder_open` 为 VSCode 主题惯例的回退定义键。Map 键按主题原文存储，查表
 * 侧 lowercase（对齐 VSCode 查前小写语义）。
 */
export interface NormalizedIconTheme {
  name: string;
  fileNames: Map<string, IconGlyph>;
  fileExtensions: Map<string, IconGlyph>;
  languageIds: Map<string, IconGlyph>;
  folderNames: Map<string, IconGlyph>;
  folderNamesExpanded: Map<string, IconGlyph>;
  _file?: IconGlyph;
  _folder?: IconGlyph;
  _folder_open?: IconGlyph;
  hidesExplorerArrows: boolean;
  fonts: IconThemeFont[];
  /** 按字体 id 索引的元数据（与 fonts 同源冗余，供 glyph.fontId 直查，渲染免线性扫描）。 */
  fontsById: Map<string, Omit<IconThemeFont, 'id'>>;
}

/**
 * VSCode 官方 language identifier → extensions 反向表（vendored，供 languageIds
 * 查图标用）。逐 id 按 VSCode 内置语言注册（各语言扩展 package.json 的
 * contributes.languages）填写；非内置语言（kotlin/scala/dart/vue/graphql 等）
 * 按生态标准扩展名填。宁缺勿错：拿不准的扩展名一律不收（错映射会静默给错图标）
 * ——表外扩展在 matchIconTheme 静默跳过，回落 fileExtensions/_file。
 */
export const VSCODE_LANG_EXT: Readonly<Record<string, readonly string[]>> = {
  'plaintext': ['.txt'],
  'typescript': ['.ts', '.mts', '.cts'],
  'typescriptreact': ['.tsx'],
  'javascript': ['.js', '.es6', '.jsx', '.mjs', '.cjs'],
  'javascriptreact': ['.jsx'],
  'json': ['.json', '.bowerrc', '.jshintrc', '.jscsrc', '.eslintrc', '.babelrc', '.har', '.jsmap', '.webmanifest'],
  'jsonc': ['.jsonc', '.code-workspace'],
  'json5': ['.json5'],
  'markdown': ['.md', '.mkd', '.mdwn', '.mdown', '.markdown', '.markdn', '.mdtxt', '.mdtext', '.workbook'],
  'html': ['.html', '.htm', '.shtml', '.xhtml', '.mdoc', '.jsp', '.asp', '.aspx', '.jshtm'],
  'css': ['.css'],
  'scss': ['.scss'],
  'less': ['.less'],
  'yaml': ['.yaml', '.yml'],
  'xml': ['.xml', '.xsd', '.xslt', '.xsl', '.dtd', '.ent'],
  'ini': ['.ini', '.properties', '.gitconfig', '.cfg', '.conf', '.directory'],
  'python': ['.py', '.rpy', '.pyw', '.cpy', '.gyp', '.gypi', '.pyi', '.ipy', '.pyt'],
  'rust': ['.rs'],
  'go': ['.go'],
  'java': ['.java', '.jav'],
  'c': ['.c', '.i'],
  'cpp': ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h', '.ino', '.inl', '.ipp'],
  'csharp': ['.cs', '.csx', '.cake'],
  'fsharp': ['.fs', '.fsi', '.fsx', '.fsscript'],
  'shellscript': [
    '.sh', '.bash', '.bashrc', '.bash_aliases', '.bash_profile', '.bash_login', '.bash_logout',
    '.zsh', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout', '.ksh', '.command',
    '.ebuild', '.install', '.profile',
  ],
  'bat': ['.bat', '.cmd'],
  'powershell': ['.ps1', '.psm1', '.psd1', '.pssc', '.psrc'],
  'ruby': ['.rb', '.rbenv', '.rjs', '.rake', '.rabl', '.jbuilder', '.ruby', '.podspec', '.gemspec'],
  'php': ['.php', '.php3', '.php4', '.php5', '.php7', '.phps', '.phtml'],
  'sql': ['.sql', '.dsql'],
  'lua': ['.lua'],
  'perl': ['.pl', '.pm'],
  'r': ['.r', '.rhistory', '.rprofile', '.rt'],
  'swift': ['.swift'],
  'kotlin': ['.kt', '.kts'],
  'scala': ['.scala'],
  'dart': ['.dart'],
  'vue': ['.vue'],
  'clojure': ['.clj', '.cljs', '.cljc', '.edn'],
  'coffeescript': ['.coffee'],
  'diff': ['.diff', '.patch'],
  'toml': ['.toml'],
  'handlebars': ['.handlebars', '.hbs'],
  'dockerfile': ['.dockerfile'],
  'makefile': ['.mak', '.mk'],
  'objective-c': ['.m'],
  'objective-cpp': ['.mm'],
  'graphql': ['.graphql', '.gql'],
  'elixir': ['.ex', '.exs'],
  'haskell': ['.hs'],
  'latex': ['.tex'],
  'pug': ['.jade', '.pug'],
  'erlang': ['.erl', '.hrl'],
};

/**
 * 反向索引：extension（去点小写）→ 语言 id 列表。同名扩展按表声明序排列
 * （'.jsx' → javascript 先于 javascriptreact，普通 JS 变体优先）。
 */
const EXT_TO_LANGS: ReadonlyMap<string, readonly string[]> = (() => {
  const index = new Map<string, string[]>();
  for (const [langId, extensions] of Object.entries(VSCODE_LANG_EXT)) {
    for (const ext of extensions) {
      const bare = (ext.startsWith('.') ? ext.slice(1) : ext).toLowerCase();
      if (bare === '') continue;
      const ids = index.get(bare);
      if (ids === undefined) index.set(bare, [langId]);
      else if (!ids.includes(langId)) ids.push(langId);
    }
  }
  return index;
})();

/**
 * 文件名后缀枚举（最长优先）：'foo.d.ts' → ['d.ts', 'ts']；点文件名首点
 * （'.gitignore' 的位置 0）与空后缀不计——点文件本就该走 fileNames 精确匹配。
 */
function* fileSuffixes(lowerName: string): Generator<string> {
  let dot = lowerName.indexOf('.', 1);
  while (dot !== -1 && dot < lowerName.length - 1) {
    yield lowerName.slice(dot + 1);
    dot = lowerName.indexOf('.', dot + 1);
  }
}

/** src 注入面负向闸：url() 文本内可截断/逃逸的字符（空白、引号、反斜杠、括号、分号、花括号、尖括号、控制符）一律拒——真实字体路径不含这些字符。 */
const FONT_SRC_FORBIDDEN_RE = /[\s'"\\;(){}<>\u0000-\u001F\u007F-\u009F]/;

/**
 * 字体 src 相对路径白名单：src 会被拼进 @font-face url() 注入文本。绝对路径
 * （/、\\、盘符）、任意协议前缀（http:/https:/data:/file:/blob: 等 scheme 形态）
 * 与协议相对（//）一律拒——主题字体应随包分发，指外 src 既有注入面又有外联
 * 泄露面；再过注入面负向字符集闸（与 fontColor/fontSize 的白名单口径对齐）。
 * './x'、'../x'、'fonts/x.woff' 合法。
 */
function isRelativeFontSrc(src: string): boolean {
  if (src === '') return false;
  if (src.startsWith('/') || src.startsWith('\\') || src.startsWith('//')) return false;
  if (/^[A-Za-z]:/.test(src)) return false; // Windows 盘符（C:\ 与 C:/ 皆覆盖）
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(src)) return false; // scheme
  if (FONT_SRC_FORBIDDEN_RE.test(src)) return false; // url() 注入面字符
  return true;
}

/** fonts 逐条过滤：id 安全字符集且不重复（keep-first）、src 逐项滤相对路径（全坏剔字体）；format/weight/style 形态异常宁缺字段。 */
function sanitizeFonts(fonts: unknown): IconThemeFont[] {
  if (!Array.isArray(fonts)) return [];
  const out: IconThemeFont[] = [];
  const seen = new Set<string>();
  for (const font of fonts) {
    if (typeof font !== 'object' || font === null || Array.isArray(font)) continue;
    const f = font as Record<string, unknown>;
    const id = f.id;
    if (typeof id !== 'string' || !FONT_ID_RE.test(id) || seen.has(id)) continue;
    const rawSrc: unknown = f.src;
    const srcList = (Array.isArray(rawSrc) ? rawSrc : [rawSrc]).filter(
      (s): s is string => typeof s === 'string' && isRelativeFontSrc(s),
    );
    if (srcList.length === 0) continue;
    const entry: IconThemeFont = { id, src: srcList };
    if (typeof f.format === 'string' && FONT_FORMAT_RE.test(f.format)) entry.format = f.format;
    if (typeof f.weight === 'string' && FONT_WEIGHT_STYLE_RE.test(f.weight)) entry.weight = f.weight;
    if (typeof f.style === 'string' && FONT_WEIGHT_STYLE_RE.test(f.style)) entry.style = f.style;
    seen.add(id);
    out.push(entry);
  }
  return out;
}

/**
 * iconDefinitions 逐条过滤（容错优先，坏条目剔除不炸整体）：
 * - fontCharacter 先解 CSS 转义形态（`\E003` → U+E003，官方主题惯例；非法码点剔），
 *   再验单字符（[...str].length === 1，码点安全：emoji 代理对算一），再过注入
 *   兜底闸（控制符/引号/反斜杠）——glyph.char 存解码后的真实字符。
 * - fontColor/fontSize 存在但不合法 → 整条剔（同 validateVscodeTheme 规则级口径：
 *   值会原样拼进注入文本，半残定义不如整条剔除）。
 * - fontId 引用完整性：存在则必须命中 fonts[].id，悬空剔该定义；合法则随 glyph
 *   透出（matchIconTheme 返回值带 fontId，配合 fontsById 得 per-definition 字体）。
 */
function sanitizeIconDefinitions(defs: unknown, fontIds: ReadonlySet<string>): Map<string, IconGlyph> {
  const out = new Map<string, IconGlyph>();
  if (typeof defs !== 'object' || defs === null || Array.isArray(defs)) return out;
  for (const [id, def] of Object.entries(defs as Record<string, unknown>)) {
    if (typeof def !== 'object' || def === null || Array.isArray(def)) continue;
    const d = def as Record<string, unknown>;
    const raw = d.fontCharacter;
    if (typeof raw !== 'string') continue;
    const char = decodeFontCharacter(raw);
    if (char === undefined || [...char].length !== 1 || FONT_CHARACTER_FORBIDDEN_RE.test(char)) continue;
    const color = d.fontColor;
    if (color !== undefined && !(typeof color === 'string' && COLOR_VALUE_RE.test(color))) continue;
    const fontSize = d.fontSize;
    if (fontSize !== undefined && !(typeof fontSize === 'string' && FONT_SIZE_RE.test(fontSize))) continue;
    const fontId = d.fontId;
    if (fontId !== undefined && !(typeof fontId === 'string' && fontIds.has(fontId))) continue;
    const glyph: IconGlyph = { char };
    if (typeof color === 'string') glyph.color = color;
    if (typeof fontSize === 'string') glyph.fontSize = fontSize;
    if (typeof fontId === 'string') glyph.fontId = fontId;
    out.set(id, glyph);
  }
  return out;
}

/**
 * 五张映射表逐条归一：键须非空 string、值须 string 且命中合法定义（被剔定义或
 * 拼错的引用 → 条目不落表）。键主题侧即 lowercase（对齐 VSCode 查前小写语义，
 * 与查询侧双侧归一；大小写变体键碰撞时后写覆盖先写）。
 */
function sanitizeGlyphTable(table: unknown, defs: ReadonlyMap<string, IconGlyph>): Map<string, IconGlyph> {
  const out = new Map<string, IconGlyph>();
  if (typeof table !== 'object' || table === null || Array.isArray(table)) return out;
  for (const [key, ref] of Object.entries(table as Record<string, unknown>)) {
    if (key === '' || typeof ref !== 'string') continue;
    const glyph = defs.get(ref);
    if (glyph !== undefined) out.set(key.toLowerCase(), glyph);
  }
  return out;
}

function sanitizeIconTheme(raw: unknown): { theme: NormalizedIconTheme; definitionCount: number } {
  const source =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const fonts = sanitizeFonts(source.fonts);
  const defs = sanitizeIconDefinitions(source.iconDefinitions, new Set(fonts.map((f) => f.id)));
  const name = typeof source.name === 'string' && source.name.trim() !== '' ? source.name : '';
  const fontsById = new Map<string, Omit<IconThemeFont, 'id'>>();
  for (const font of fonts) {
    const { id, ...meta } = font;
    fontsById.set(id, meta);
  }
  const theme: NormalizedIconTheme = {
    name,
    fileNames: sanitizeGlyphTable(source.fileNames, defs),
    fileExtensions: sanitizeGlyphTable(source.fileExtensions, defs),
    languageIds: sanitizeGlyphTable(source.languageIds, defs),
    folderNames: sanitizeGlyphTable(source.folderNames, defs),
    folderNamesExpanded: sanitizeGlyphTable(source.folderNamesExpanded, defs),
    hidesExplorerArrows: source.hidesExplorerArrows === true,
    fonts,
    fontsById,
  };
  const file = defs.get('_file');
  if (file !== undefined) theme._file = file;
  const folder = defs.get('_folder');
  if (folder !== undefined) theme._folder = folder;
  const folderOpen = defs.get('_folder_open');
  if (folderOpen !== undefined) theme._folder_open = folderOpen;
  return { theme, definitionCount: defs.size };
}

/**
 * 导入校验：非对象拒；iconDefinitions 过滤后全空才拒（容错优先口径仿
 * validateVscodeTheme——坏定义/坏 src/悬空引用逐条剔除）。name 缺省不拒：官方
 * 图标主题 JSON 无 name 键（显示名在包元数据，Task 3 侧并入）。1MB 体积闸与
 * 解包在导入层（Task 3），此处只管形状。
 */
export function validateVscodeIconTheme(
  raw: unknown,
): { ok: true; theme: NormalizedIconTheme } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: '图标主题 JSON 须为对象' };
  }
  const { theme, definitionCount } = sanitizeIconTheme(raw);
  if (definitionCount === 0) {
    return { ok: false, reason: 'iconDefinitions 过滤后为空（须至少一个 fontCharacter 单字符且引用完整的定义）' };
  }
  return { ok: true, theme };
}

/**
 * 原始 JSON → 预编译查表（不经 ok 闸，垃圾输入归空主题不抛）。IndexedDB 记录端
 * 存本函数产出的归一化形态（Map 经 structured clone 原生保形，put/get 免重建）。
 */
export function normalizeIconTheme(raw: unknown): NormalizedIconTheme {
  return sanitizeIconTheme(raw).theme;
}

/**
 * 字形匹配。优先级（spec 固化）：fileNames 精确名 > fileExtensions 多级后缀
 * （最长优先，'foo.d.ts' 先试 'd.ts' 再 'ts'）> languageIds 反向表（EXT_TO_
 * LANGS 未收录的扩展静默跳过，不给猜测图标）> _file 回退；folder 查 folderNames
 * 回退 _folder，folderExpanded 查 folderNamesExpanded 后跨向回落
 * folderNames/_folder_open/_folder（对齐 VSCode：展开态缺省回落未展开图标）。
 * 查表键大小写不敏感（对齐 VSCode：查前
 * lowercase）。任何一层未命中且无回退键 → null。命中字形含 fontId（定义声明了
 * fontId 时），配合 fontsById 取该字体的 src/format 元数据渲染 font-family。
 */
export function matchIconTheme(
  theme: NormalizedIconTheme,
  target: { kind: 'file' | 'folder' | 'folderExpanded'; name: string },
): IconGlyph | null {
  if (typeof target.name !== 'string') return null;
  const name = target.name.toLowerCase();
  if (target.kind === 'folder') return theme.folderNames.get(name) ?? theme._folder ?? null;
  if (target.kind === 'folderExpanded') {
    // 跨向回退对齐 VSCode：展开态专属映射/图标缺省时回落未展开图标（简装主题
    // 仅配 folderNames 也能给展开文件夹图标）
    return (
      theme.folderNamesExpanded.get(name) ?? theme.folderNames.get(name) ?? theme._folder_open ?? theme._folder ?? null
    );
  }
  const byName = theme.fileNames.get(name);
  if (byName !== undefined) return byName;
  for (const suffix of fileSuffixes(name)) {
    const byExt = theme.fileExtensions.get(suffix);
    if (byExt !== undefined) return byExt;
  }
  for (const suffix of fileSuffixes(name)) {
    const langIds = EXT_TO_LANGS.get(suffix);
    if (langIds === undefined) continue;
    for (const langId of langIds) {
      const byLang = theme.languageIds.get(langId);
      if (byLang !== undefined) return byLang;
    }
  }
  return theme._file ?? null;
}
