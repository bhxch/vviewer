/**
 * 主题导入管线（spec B §2.3 + 图标主题 spec §2.3）：.json 单文件直读校验 +
 * .vsix 扩展包解包，颜色主题（importThemeFiles）与图标主题（importIconThemeFiles）
 * 双通道并列。解包复用 render-archive 的 createZipStore（jszip 全内存，200MB 包级
 * 上限沿用）；限额与容错取 Markpad commands.rs L14-19/L568-635 精神：单主题 JSON
 * 1MB 上限（brief 定值；Markpad 为 2MB，此处从 brief）、清单缺主题/坏 JSON/超限
 * 均报错跳过该条，不中断同批其余文件。图标主题通道（Task 2）：json 直导要求字体
 * 同批选中——fonts[].src 按基名在同批字体文件/包内条目中关联，缺任一 → 该主题
 * 整条拒绝（不部分入库）；单字体 30MB 上限复用 fontsStore 的 MAX_FONT_BYTES。
 */
import { validateVscodeIconTheme, validateVscodeTheme } from '@bhxch/vviewer-highlight';
import { translate as t } from './i18n/core';
import { createZipStore } from '@bhxch/vviewer-render-archive/zipStore';
import { MAX_FONT_BYTES } from './stores/fontsStore';
import {
  putIconTheme,
  putTheme,
  type ImportedIconTheme,
  type ImportedIconThemeFont,
  type ImportedTheme,
  type ThemeOrigin
} from './stores/session';

/** 单主题 JSON 字节上限（brief 定值 1MB）。 */
export const MAX_THEME_JSON_BYTES = 1024 * 1024;

/**
 * 导入附加元数据（T5 Open VSX 通道）：origin 写入本批每条记录（多主题包全部并列
 * 同 origin，spec §6.2）；本地手动导入不传（无 origin = 天然无更新通道，§6.3）。
 */
export interface ImportOpts {
  origin?: ThemeOrigin;
}

/** VSIX contributes 清单条目（themes/iconThemes 通用；预览列举与导入共用；path 已归一化）。 */
export interface VsixThemeEntry {
  label: string;
  path: string;
}

type ZipReader = {
  read(path: string): Promise<Uint8Array>;
  listChildren(path: string): Promise<{ path: string; kind: string }[]>;
};

function randomId(): string {
  // brief：id = imported:<随机8>（base36；toString 末尾 0 会被吞，padEnd 保 8 位）
  return `imported:${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`;
}

/** zip 条目路径归一（Markpad commands.rs L614-623 同款）：反斜杠转正斜杠、剥前导 './'。 */
function normalizeEntryPath(p: string): string {
  let s = p.replaceAll('\\', '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// 「未找到」文案 Task 10 迁 errors.vsix.*（原模块级常量装配时刻锁 locale，改事件时刻取值）

/** contributes 类别键：'themes'（颜色主题）| 'iconThemes'（图标主题）。 */
type ContributionKey = 'themes' | 'iconThemes';

/**
 * 读取 VSIX 清单 contributes[key] → { label, path } 列表（readVsixManifest 泛化）。
 * 清单缺失/不可解析/无有效条目均报「未找到对应主题」（Markpad "No themes found"
 * 同语义）；label 取 entry.label、entry.id 兜底（Markpad label.or(id) 同款），再退
 * 路径基名。颜色主题路径行为与泛化前逐字不变（既有单测为回归闸）。
 */
async function readVsixContributions(store: ZipReader, key: ContributionKey): Promise<VsixThemeEntry[]> {
  const notFound = key === 'iconThemes' ? t('errors.vsix.iconNotFound') : t('errors.vsix.notFound');
  let bytes: Uint8Array;
  try {
    bytes = await store.read('extension/package.json');
  } catch {
    throw new Error(notFound);
  }
  const parsed = parseJson(new TextDecoder().decode(bytes));
  const entries =
    parsed.ok && typeof parsed.value === 'object' && parsed.value !== null
      ? (parsed.value as { contributes?: Record<string, unknown> }).contributes?.[key]
      : undefined;
  if (!Array.isArray(entries)) throw new Error(notFound);
  const out: VsixThemeEntry[] = [];
  for (const e of entries) {
    if (typeof e !== 'object' || e === null) continue;
    const entry = e as { label?: unknown; id?: unknown; path?: unknown };
    if (typeof entry.path !== 'string' || entry.path.trim() === '') continue;
    const label =
      [entry.label, entry.id].find((v): v is string => typeof v === 'string' && v !== '') ??
      basename(entry.path);
    out.push({ label, path: normalizeEntryPath(entry.path) });
  }
  if (out.length === 0) throw new Error(notFound);
  return out;
}

/**
 * 解析并校验单主题 JSON 文本 → 入库。
 * name 缺省兜底：真实 VSIX 主题 JSON 常无 name，用清单 label（Markpad 以 label 为
 * 身份），直读 .json 用文件名基名；作者已命名时不改写，validateVscodeTheme 的
 * name 非空契约保持不变。
 */
async function importThemeText(
  text: string,
  displayName: string,
  nameFallback: string,
  source: ImportedTheme['source'],
  imported: ImportedTheme[],
  errors: string[],
  origin?: ThemeOrigin
): Promise<void> {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    errors.push(t('errors.vsix.jsonParse', { name: displayName }));
    return;
  }
  const rawObj = (typeof parsed.value === 'object' && parsed.value !== null ? parsed.value : {}) as Record<string, unknown>;
  const hasName = typeof rawObj.name === 'string' && rawObj.name.trim() !== '';
  const candidate = hasName ? parsed.value : { ...rawObj, name: nameFallback };
  const v = validateVscodeTheme(candidate);
  if (!v.ok) {
    errors.push(`${displayName}: ${v.reason}`);
    return;
  }
  const themeRec: ImportedTheme = {
    id: randomId(),
    name: v.theme.name,
    kind: v.theme.kind,
    colors: v.theme.colors ?? {},
    tokenColors: v.theme.tokenColors,
    source,
    addedAt: Date.now()
  };
  if (origin !== undefined) themeRec.origin = origin; // fontsStore rec.url 同款：缺省不落键
  await putTheme(themeRec);
  imported.push(themeRec);
}

async function importVsixFile(file: File, imported: ImportedTheme[], errors: string[], origin?: ThemeOrigin): Promise<void> {
  const store = await createZipStore(new Uint8Array(await file.arrayBuffer()));
  const entries = await readVsixContributions(store, 'themes'); // 「未找到主题」→ 外层 catch 记 errors
  for (const { label, path } of entries) {
    try {
      const bytes = await store.read(`extension/${path}`);
      if (bytes.byteLength > MAX_THEME_JSON_BYTES) {
        errors.push(t('errors.vsix.jsonTooLarge', { name: label }));
        continue;
      }
      await importThemeText(new TextDecoder().decode(bytes), label, label, 'vsix', imported, errors, origin);
    } catch (err) {
      errors.push(`${label}: ${errText(err)}`); // 单条损坏跳过，其余主题继续
    }
  }
}

async function importJsonFile(file: File, imported: ImportedTheme[], errors: string[], origin?: ThemeOrigin): Promise<void> {
  if (file.size > MAX_THEME_JSON_BYTES) {
    errors.push(t('errors.vsix.jsonTooLarge', { name: file.name }));
    return;
  }
  await importThemeText(await file.text(), file.name, basename(file.name).replace(/\.json$/i, ''), 'json', imported, errors, origin);
}

/**
 * 批量导入主题文件：.json 直读校验入库、.vsix 解包逐主题导入。
 * 返回成功入库列表与逐条错误（含文件名/主题名前缀）；单文件级失败（解包失败、
 * 包超限、清单缺失）只记 errors，不中断同批。opts.origin（T5 Open VSX 通道）写入
 * 本批每条记录；本地手动导入不传。
 */
export async function importThemeFiles(files: File[], opts: ImportOpts = {}): Promise<{ imported: ImportedTheme[]; errors: string[] }> {
  const imported: ImportedTheme[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      if (/\.json$/i.test(file.name)) await importJsonFile(file, imported, errors, opts.origin);
      else if (/\.vsix$/i.test(file.name)) await importVsixFile(file, imported, errors, opts.origin);
      else errors.push(t('errors.vsix.badType', { name: file.name }));
    } catch (err) {
      errors.push(`${file.name}: ${errText(err)}`);
    }
  }
  return { imported, errors };
}

/** 多主题 VSIX 的预览列举（UI 勾选用）：只读清单不入库；缺清单抛「未找到主题」。 */
export async function listVsixThemes(file: File): Promise<VsixThemeEntry[]> {
  const store = await createZipStore(new Uint8Array(await file.arrayBuffer()));
  return readVsixContributions(store, 'themes');
}

// ---------- 图标主题通道（图标主题 spec §2.3，Task 2） ----------

/** 字体解析器：按主题 fonts[].src 的基名取同批/包内字体字节；null = 缺失（该主题整条拒绝）。 */
type FontResolver = (base: string) => Promise<Uint8Array | null>;

/** Uint8Array → 独立 ArrayBuffer（记录端存储形态，不与读取视图共享底层缓冲）。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** 字体 format 推断：扩展名在 woff/woff2/ttf/otf 白名单内取小写，形态外省略。 */
function fontFormatOf(base: string): string | undefined {
  const ext = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : '';
  return ext === 'woff' || ext === 'woff2' || ext === 'ttf' || ext === 'otf' ? ext : undefined;
}

/** 递归枚举 zip 全部文件条目路径（虚拟目录树展开；包内字体按基名关联用）。 */
async function listZipFilePaths(store: ZipReader): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const child of await store.listChildren(dir)) {
      if (child.kind === 'dir') await walk(child.path);
      else out.push(child.path);
    }
  };
  await walk('');
  return out;
}

/**
 * 解析并校验单图标主题 JSON → 字体同批关联 → 入库。name 缺省兜底同 importThemeText
 * （官方图标主题 JSON 无 name 键：vsix 用清单 label、直读 .json 用文件名基名）；
 * manifest 存 validateVscodeIconTheme 的归一化查表产物（IndexedDB 端直接可消费）。
 * 字体关联（brief 定口径）：fonts[].src 取基名（防 './' 前缀差异）经解析器查找，
 * 缺任一或超 30MB 闸 → 该主题整条拒绝（不部分入库）记 errors，单条错误不中断同批。
 */
async function importIconThemeText(
  text: string,
  displayName: string,
  nameFallback: string,
  source: ImportedIconTheme['source'],
  resolveFont: FontResolver,
  imported: ImportedIconTheme[],
  errors: string[],
  origin?: ThemeOrigin
): Promise<void> {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    errors.push(t('errors.vsix.jsonParse', { name: displayName }));
    return;
  }
  const rawObj = (typeof parsed.value === 'object' && parsed.value !== null ? parsed.value : {}) as Record<string, unknown>;
  const hasName = typeof rawObj.name === 'string' && rawObj.name.trim() !== '';
  const candidate = hasName ? parsed.value : { ...rawObj, name: nameFallback };
  const v = validateVscodeIconTheme(candidate);
  if (!v.ok) {
    errors.push(`${displayName}: ${v.reason}`);
    return;
  }
  const fonts: ImportedIconThemeFont[] = [];
  for (const font of v.theme.fonts) {
    for (const src of font.src) {
      const base = basename(src);
      const bytes = await resolveFont(base);
      if (bytes === null) {
        errors.push(t('errors.vsix.fontMissing', { name: displayName, base }));
        return;
      }
      if (bytes.byteLength > MAX_FONT_BYTES) {
        errors.push(t('errors.vsix.fontTooLarge', { name: displayName, base }));
        return;
      }
      const rec: ImportedIconThemeFont = { path: base, data: toArrayBuffer(bytes) };
      const format = fontFormatOf(base);
      if (format !== undefined) rec.format = format;
      fonts.push(rec);
    }
  }
  const iconRec: ImportedIconTheme = {
    id: randomId(),
    name: v.theme.name,
    manifest: v.theme,
    fonts,
    source,
    addedAt: Date.now()
  };
  if (origin !== undefined) iconRec.origin = origin;
  await putIconTheme(iconRec);
  imported.push(iconRec);
}

async function importIconJsonFile(
  file: File,
  batchFonts: ReadonlyMap<string, File>,
  imported: ImportedIconTheme[],
  errors: string[],
  origin?: ThemeOrigin
): Promise<void> {
  if (file.size > MAX_THEME_JSON_BYTES) {
    errors.push(t('errors.vsix.jsonTooLarge', { name: file.name }));
    return;
  }
  const resolveFont: FontResolver = async (base) => {
    const f = batchFonts.get(base);
    return f === undefined ? null : new Uint8Array(await f.arrayBuffer());
  };
  await importIconThemeText(
    await file.text(),
    file.name,
    basename(file.name).replace(/\.json$/i, ''),
    'json',
    resolveFont,
    imported,
    errors,
    origin
  );
}

async function importIconVsixFile(
  file: File,
  imported: ImportedIconTheme[],
  errors: string[],
  origin?: ThemeOrigin
): Promise<void> {
  const store = await createZipStore(new Uint8Array(await file.arrayBuffer()));
  const entries = await readVsixContributions(store, 'iconThemes'); // 「未找到图标主题」→ 外层 catch 记 errors
  // 包内字体索引（基名 → 条目路径，先到先得）：主题 fonts[].src 相对路径按基名
  // 关联；条目过字体扩展名白名单（与 json 通道 batchFonts 收集口径对称）——防
  // src 点名包内非字体条目（如 package.json）把任意字节入库，失败推迟到 FontFace
  // 解析期才暴露
  const byBase = new Map<string, string>();
  for (const p of await listZipFilePaths(store)) {
    if (!/\.(woff2?|ttf|otf)$/i.test(p)) continue;
    const base = basename(p);
    if (!byBase.has(base)) byBase.set(base, p);
  }
  const resolveFont: FontResolver = async (base) => {
    const p = byBase.get(base);
    return p === undefined ? null : await store.read(p);
  };
  for (const { label, path } of entries) {
    try {
      const bytes = await store.read(`extension/${path}`);
      if (bytes.byteLength > MAX_THEME_JSON_BYTES) {
        errors.push(t('errors.vsix.jsonTooLarge', { name: label }));
        continue;
      }
      await importIconThemeText(new TextDecoder().decode(bytes), label, label, 'vsix', resolveFont, imported, errors, origin);
    } catch (err) {
      errors.push(`${label}: ${errText(err)}`); // 单条损坏跳过，其余主题继续
    }
  }
}

/**
 * 批量导入图标主题文件（与 importThemeFiles 并列，图标主题 spec §2.3）：.json
 * 直读校验入库（字体须同批选中——fonts[].src 按基名在同批字体文件中关联，缺任一
 * → 该主题整条拒绝）、.vsix 解包逐主题导入（contributes.iconThemes，字体在包内
 * 按基名关联）；字体文件（woff/woff2/ttf/otf）本身不入库，只作同批 .json 的关联
 * 资源（未被引用则静默忽略）。返回成功入库列表与逐条错误（含文件名/主题名前缀）；
 * 单文件级失败（解包失败、清单缺失）只记 errors，不中断同批。opts.origin（T5
 * Open VSX 通道）写入本批每条记录；本地手动导入不传。
 */
export async function importIconThemeFiles(
  files: File[],
  opts: ImportOpts = {}
): Promise<{ imported: ImportedIconTheme[]; errors: string[] }> {
  const imported: ImportedIconTheme[] = [];
  const errors: string[] = [];
  // 字体资源预收集（基名 → File，先到先得）：.json 可能先于字体文件出现在同批，
  // 先集齐再逐主题关联
  const batchFonts = new Map<string, File>();
  for (const file of files) {
    if (/\.(woff2?|ttf|otf)$/i.test(file.name)) {
      const base = basename(file.name);
      if (!batchFonts.has(base)) batchFonts.set(base, file);
    }
  }
  for (const file of files) {
    try {
      if (/\.json$/i.test(file.name)) await importIconJsonFile(file, batchFonts, imported, errors, opts.origin);
      else if (/\.vsix$/i.test(file.name)) await importIconVsixFile(file, imported, errors, opts.origin);
      else if (!batchFonts.has(basename(file.name)))
        errors.push(t('errors.vsix.badTypeWithFonts', { name: file.name }));
    } catch (err) {
      errors.push(`${file.name}: ${errText(err)}`);
    }
  }
  return { imported, errors };
}
