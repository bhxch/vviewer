/**
 * 主题导入管线（spec B §2.3）：.json 单文件直读校验 + .vsix 扩展包解包。
 * 解包复用 render-archive 的 createZipStore（jszip 全内存，200MB 包级上限沿用）；
 * 限额与容错取 Markpad commands.rs L14-19/L568-635 精神：单主题 JSON 1MB 上限
 * （brief 定值；Markpad 为 2MB，此处从 brief）、清单缺主题/坏 JSON/超限均报错
 * 跳过该条，不中断同批其余文件。
 */
import { validateVscodeTheme } from '@bhxch/vviewer-highlight';
import { createZipStore } from '@bhxch/vviewer-render-archive/zipStore';
import { putTheme, type ImportedTheme } from './stores/session';

/** 单主题 JSON 字节上限（brief 定值 1MB）。 */
export const MAX_THEME_JSON_BYTES = 1024 * 1024;

/** VSIX contributes.themes 清单条目（预览列举与导入共用；path 已归一化）。 */
export interface VsixThemeEntry {
  label: string;
  path: string;
}

type ZipReader = { read(path: string): Promise<Uint8Array> };

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

const NOT_FOUND = '扩展包内未找到主题';

/**
 * 读取 VSIX 清单 contributes.themes → { label, path } 列表。
 * 清单缺失/不可解析/无有效条目均报「未找到主题」（Markpad "No themes found" 同语义）；
 * label 取 entry.label、entry.id 兜底（Markpad label.or(id) 同款），再退路径基名。
 */
async function readVsixManifest(store: ZipReader): Promise<VsixThemeEntry[]> {
  let bytes: Uint8Array;
  try {
    bytes = await store.read('extension/package.json');
  } catch {
    throw new Error(NOT_FOUND);
  }
  const parsed = parseJson(new TextDecoder().decode(bytes));
  const themes =
    parsed.ok && typeof parsed.value === 'object' && parsed.value !== null
      ? (parsed.value as { contributes?: { themes?: unknown } }).contributes?.themes
      : undefined;
  if (!Array.isArray(themes)) throw new Error(NOT_FOUND);
  const out: VsixThemeEntry[] = [];
  for (const e of themes) {
    if (typeof e !== 'object' || e === null) continue;
    const entry = e as { label?: unknown; id?: unknown; path?: unknown };
    if (typeof entry.path !== 'string' || entry.path.trim() === '') continue;
    const label =
      [entry.label, entry.id].find((v): v is string => typeof v === 'string' && v !== '') ??
      basename(entry.path);
    out.push({ label, path: normalizeEntryPath(entry.path) });
  }
  if (out.length === 0) throw new Error(NOT_FOUND);
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
  errors: string[]
): Promise<void> {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    errors.push(`${displayName}: 主题 JSON 解析失败`);
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
  const t: ImportedTheme = {
    id: randomId(),
    name: v.theme.name,
    kind: v.theme.kind,
    colors: v.theme.colors ?? {},
    tokenColors: v.theme.tokenColors,
    source,
    addedAt: Date.now()
  };
  await putTheme(t);
  imported.push(t);
}

async function importVsixFile(file: File, imported: ImportedTheme[], errors: string[]): Promise<void> {
  const store = await createZipStore(new Uint8Array(await file.arrayBuffer()));
  const entries = await readVsixManifest(store); // 「未找到主题」→ 外层 catch 记 errors
  for (const { label, path } of entries) {
    try {
      const bytes = await store.read(`extension/${path}`);
      if (bytes.byteLength > MAX_THEME_JSON_BYTES) {
        errors.push(`${label}: 主题 JSON 超过 1MB 上限，已跳过`);
        continue;
      }
      await importThemeText(new TextDecoder().decode(bytes), label, label, 'vsix', imported, errors);
    } catch (err) {
      errors.push(`${label}: ${errText(err)}`); // 单条损坏跳过，其余主题继续
    }
  }
}

async function importJsonFile(file: File, imported: ImportedTheme[], errors: string[]): Promise<void> {
  if (file.size > MAX_THEME_JSON_BYTES) {
    errors.push(`${file.name}: 主题 JSON 超过 1MB 上限，已跳过`);
    return;
  }
  await importThemeText(await file.text(), file.name, basename(file.name).replace(/\.json$/i, ''), 'json', imported, errors);
}

/**
 * 批量导入主题文件：.json 直读校验入库、.vsix 解包逐主题导入。
 * 返回成功入库列表与逐条错误（含文件名/主题名前缀）；单文件级失败（解包失败、
 * 包超限、清单缺失）只记 errors，不中断同批。
 */
export async function importThemeFiles(files: File[]): Promise<{ imported: ImportedTheme[]; errors: string[] }> {
  const imported: ImportedTheme[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      if (/\.json$/i.test(file.name)) await importJsonFile(file, imported, errors);
      else if (/\.vsix$/i.test(file.name)) await importVsixFile(file, imported, errors);
      else errors.push(`${file.name}: 不支持的文件类型（仅 .json / .vsix）`);
    } catch (err) {
      errors.push(`${file.name}: ${errText(err)}`);
    }
  }
  return { imported, errors };
}

/** 多主题 VSIX 的预览列举（UI 勾选用）：只读清单不入库；缺清单抛「未找到主题」。 */
export async function listVsixThemes(file: File): Promise<VsixThemeEntry[]> {
  const store = await createZipStore(new Uint8Array(await file.arrayBuffer()));
  return readVsixManifest(store);
}
