/**
 * openVsx.ts — Open VSX 安装与更新通道（图标主题+Open VSX spec §6，Task 5）。
 *
 * 颜色主题与图标主题共用一条管线：三形态输入解析（parseOpenVsxInput）→ GET
 * /api/{p}/{e}[/{v}] 元数据 → files.manifest 预检（contributes.themes/iconThemes
 * 至少一项才下整包，非主题扩展快速报错省多 MB 下载，§6.2）→ files.download 拉
 * vsix（30MB 上限，MAX_FONT_BYTES 同口径）→ 转 File 走 vsixImport 既有导入管线
 * 内核（解包/校验/限额不复制实现）→ 记录带 origin（ThemeOrigin，多主题包全部
 * 并列同 origin）。更新通道（§6.3）：重拉 → 校验 → 同 id 覆盖写入（设置引用
 * 零断链）。
 *
 * 运行时重应用不在本模块（iconTheme.svelte.ts 的 $state 家族不可入 vitest，静态
 * 依赖会污染单测面）：updateTheme 只负责落库，覆盖写后的 sig 归零 + 手动重应用由
 * UI 层（AppearanceSection）调用 invalidateIcons/invalidateAppearance 完成——
 * iconSig/appearanceSig 均不含记录内容，同 id 覆盖后 diff 必 no-op（T3 备案 →
 * T5 裁决），spec §6.3「fontsSig/iconSig 联动自然重渲染」以 invalidate + 重应用
 * 显式达成。
 *
 * 失败面文案仿 fontsStore「字体下载失败（字体源需开启 CORS）：…」句式；断网类
 * 引导「可改用手动导入 vsix」（§6.4）。base 收敛单点常量（自托管实例为非目标，
 * 留缝即此常量）；生产路径恒原生 fetch，open-vsx.org 恒 https（三形态解析对 URL
 * 形态强制 https，混合内容无冲突；全链 CORS 放行实测见 §6.1）。
 */
import { MAX_FONT_BYTES } from './stores/fontsStore';
import {
  deleteIconTheme,
  deleteTheme,
  putIconTheme,
  putTheme,
  type ImportedIconTheme,
  type ImportedTheme,
  type ThemeOrigin
} from './stores/session';
import { importIconThemeFiles, importThemeFiles } from './vsixImport';

/** Open VSX 公共实例 base（v1 固定，spec §6.4）。 */
export const OPEN_VSX_BASE = 'https://open-vsx.org';

/** vsix 整包下载上限：对齐字体单文件 30MB 先例口径（spec §6.2「复用字体导入
 * 30MB 先例」；MAX_FONT_BYTES 现值 30MB，rg 核对后沿用）。 */
export const MAX_VSIX_BYTES = MAX_FONT_BYTES;

// fetch 注入缝（cdnEngines __setCdnLoaderForTest 同形态）：生产路径恒原生 fetch
//（+ https 校验在 parseOpenVsxInput）；单测传 mock，传 null 还原生产实现。
type FetchImpl = typeof fetch;
let fetchImpl: FetchImpl = (input, init) => fetch(input, init);

/** 单测注入口（生产路径不调用）；传 null 还原原生 fetch。 */
export function __setFetchImplForTest(fn: FetchImpl | null): void {
  fetchImpl = fn ?? ((input, init) => fetch(input, init));
}

// ---------- 输入解析（spec §6.2 三形态） ----------

export type OpenVsxInput =
  | { publisher: string; extension: string; version?: string }
  | { error: string };

/** 名段字符集：Open VSX 命名空间/扩展名实用子集（字母数字与 -_）；版本段放宽到
 * semver 常见字符（点分数字 + 预发布 -.+ 后缀）。 */
const SEG = '[A-Za-z0-9_-]+';
const VER = '[A-Za-z0-9._+-]+';
const IDENT_RE = new RegExp(`^(${SEG})\\.(${SEG})(?:@(${VER}))?$`);
const PAGE_RE = new RegExp(`^/extension/(${SEG})/(${SEG})(?:/(${VER}))?/?$`);
const DOWNLOAD_RE = new RegExp(`^/api/(${SEG})/(${SEG})/(${VER})/file/.+\\.vsix$`);

/**
 * 解析 Open VSX 安装输入为 { publisher, extension, version? }；不可识别返回
 * { error }。三形态（spec §6.2）：页面 URL `https://open-vsx.org/extension/{p}/
 * {e}[/v]`、标识 `{p}.{e}[@{v}]`、vsix 直链（files.download 形态 URL）。URL 形态
 * 强制 https 且 host 恒 open-vsx.org（v1 固定公共实例，§6.4；混合内容防线）。
 */
export function parseOpenVsxInput(input: string): OpenVsxInput {
  const s = input.trim();
  if (s === '') return { error: '请输入 Open VSX 标识（publisher.extension）或链接' };
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return { error: `无法解析输入：${input}` };
    }
    if (u.protocol !== 'https:') return { error: `仅支持 https 链接（open-vsx.org 恒 https）：${input}` };
    if (u.hostname !== 'open-vsx.org') return { error: `仅支持 open-vsx.org 链接：${input}` };
    const page = PAGE_RE.exec(u.pathname);
    if (page !== null) {
      return page[3] !== undefined
        ? { publisher: page[1]!, extension: page[2]!, version: page[3] }
        : { publisher: page[1]!, extension: page[2]! };
    }
    const dl = DOWNLOAD_RE.exec(u.pathname);
    if (dl !== null) return { publisher: dl[1]!, extension: dl[2]!, version: dl[3]! };
    return {
      error: `无法识别的 open-vsx.org 链接（支持 /extension/{p}/{e}[/v] 或 vsix 直链）：${input}`
    };
  }
  const id = IDENT_RE.exec(s);
  if (id !== null) {
    return id[3] !== undefined
      ? { publisher: id[1]!, extension: id[2]!, version: id[3] }
      : { publisher: id[1]!, extension: id[2]! };
  }
  return { error: `无法识别的输入（支持 publisher.extension[@version] 或 open-vsx.org 链接）：${input}` };
}

// ---------- fetch 薄封装（错误文案统一仿 fontsStore 句式） ----------

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * GET URL → Response。网络层失败（含 CORS/断网/DNS）按 networkPrefix 报错并引导
 * 「可改用手动导入 vsix」（§6.4 断网类文案）；HTTP 非 2xx 按 httpPrefix 报错带状态码。
 */
async function fetchResponse(url: string, networkPrefix: string, httpPrefix: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new Error(`${networkPrefix}：${errText(err)}`);
  }
  if (!res.ok) throw new Error(`${httpPrefix}：HTTP ${res.status}（GET ${url}）`);
  return res;
}

/** GET 并解析 JSON（元数据端点；响应体非 JSON 同样归入失败面）。 */
async function fetchJson(url: string, networkPrefix: string, httpPrefix: string): Promise<unknown> {
  const res = await fetchResponse(url, networkPrefix, httpPrefix);
  try {
    return await res.json();
  } catch (err) {
    throw new Error(`${httpPrefix}：响应不是有效 JSON（${errText(err)}）`);
  }
}

/** GET 取字节（manifest 预检与 vsix 下载共用）。 */
async function fetchBytes(url: string, networkPrefix: string, httpPrefix: string): Promise<ArrayBuffer> {
  const res = await fetchResponse(url, networkPrefix, httpPrefix);
  return res.arrayBuffer();
}

/** /api 元数据形状（§6.1 实测：version / files.download / files.manifest）。 */
interface OpenVsxMeta {
  version?: unknown;
  files?: { download?: unknown; manifest?: unknown };
}

function metaOf(publisher: string, extension: string, version: string | undefined, networkPrefix: string, httpPrefix: string): Promise<OpenVsxMeta> {
  const url = `${OPEN_VSX_BASE}/api/${publisher}/${extension}${version !== undefined ? `/${version}` : ''}`;
  return fetchJson(url, networkPrefix, httpPrefix) as Promise<OpenVsxMeta>;
}

/** vsix 字节下载 + 30MB 闸（安装/更新共用；超限报错不部分入库，§6.2）。 */
async function downloadVsix(url: string, networkPrefix: string, failPrefix: string): Promise<ArrayBuffer> {
  const buf = await fetchBytes(url, networkPrefix, failPrefix);
  if (buf.byteLength > MAX_VSIX_BYTES) {
    throw new Error(`${failPrefix}：vsix 超过 30MB 上限（${(buf.byteLength / 1024 / 1024).toFixed(1)}MB）`);
  }
  return buf;
}

/** manifest 包体 contributes 预检结果（数组性宽松——逐条有效性由导入管线校验）。 */
function readContributes(bytes: ArrayBuffer): { themes?: unknown[]; iconThemes?: unknown[] } {
  try {
    const pkg = JSON.parse(new TextDecoder().decode(bytes)) as {
      contributes?: { themes?: unknown; iconThemes?: unknown };
    };
    return {
      themes: Array.isArray(pkg.contributes?.themes) ? pkg.contributes?.themes : undefined,
      iconThemes: Array.isArray(pkg.contributes?.iconThemes) ? pkg.contributes?.iconThemes : undefined
    };
  } catch {
    return {}; // manifest 不可解析 = 视为无主题（预检快速报错；手动导入 vsix 可作对照）
  }
}

// ---------- 安装（spec §6.2） ----------

/**
 * 从 Open VSX 安装：解析输入 → 元数据 → manifest 预检（至少一类主题才下整包，
 * 否则「该扩展不含主题」快速报错）→ 拉 vsix（30MB 闸）→ 按预检结果走颜色/图标
 * 导入管线（双通道包两类并行）→ 记录带 origin。
 * 管线前的任何失败抛错（由 UI 的 importNote/importErrors 通道承接）；管线内的
 * 逐条错误（坏 JSON/超 1MB 等）按既有语义记入 errors 不抛。
 */
export async function installFromOpenVsx(
  input: string
): Promise<{ imported: (ImportedTheme | ImportedIconTheme)[]; errors: string[] }> {
  const parsed = parseOpenVsxInput(input);
  if ('error' in parsed) throw new Error(parsed.error);
  const { publisher, extension } = parsed;
  const NET = 'Open VSX 安装失败（需网络与 CORS，或改用手动导入 vsix）';
  const FAIL = 'Open VSX 安装失败';
  const meta = await metaOf(publisher, extension, parsed.version, NET, FAIL);
  // manifest 预检（§6.2）：contributes.themes/iconThemes 至少一项存在才下整包
  if (typeof meta.files?.manifest !== 'string') {
    throw new Error(`${FAIL}：元数据缺少 manifest 文件（扩展未正确打包？）：${publisher}.${extension}`);
  }
  const contributes = readContributes(await fetchBytes(meta.files.manifest, NET, FAIL));
  const hasColor = (contributes.themes?.length ?? 0) > 0;
  const hasIcon = (contributes.iconThemes?.length ?? 0) > 0;
  if (!hasColor && !hasIcon) {
    throw new Error(`该扩展不含主题（contributes.themes/iconThemes 均缺失）：${publisher}.${extension}`);
  }
  if (typeof meta.files?.download !== 'string') {
    throw new Error(`${FAIL}：元数据缺少 vsix 下载地址：${publisher}.${extension}`);
  }
  const version = typeof meta.version === 'string' && meta.version !== '' ? meta.version : (parsed.version ?? '');
  const buf = await downloadVsix(meta.files.download, NET, FAIL);
  const file = new File([buf], `${publisher}.${extension}-${version || 'latest'}.vsix`); // .vsix 后缀 = 管线分发依据
  const origin: ThemeOrigin = { publisher, extension, version: version || 'latest', checkedAt: Date.now() };
  const imported: (ImportedTheme | ImportedIconTheme)[] = [];
  const errors: string[] = [];
  if (hasColor) {
    const r = await importThemeFiles([file], { origin });
    imported.push(...r.imported);
    errors.push(...r.errors);
  }
  if (hasIcon) {
    const r = await importIconThemeFiles([file], { origin });
    imported.push(...r.imported);
    errors.push(...r.errors);
  }
  return { imported, errors };
}

// ---------- 更新（spec §6.3） ----------

/**
 * 检查更新：GET /api/{p}/{e} 读 latest version，与 origin.version 不等即
 * hasUpdate（§6.3：不引 semver 库，相等性比较足够——显式 @version 装到比 latest
 * 更新的版本时会提示「降级」，属罕见路径，按 spec 字面口径处理）。
 */
export async function checkUpdate(origin: ThemeOrigin): Promise<{ latest: string; hasUpdate: boolean }> {
  const NET = 'Open VSX 检查更新失败（需网络与 CORS）';
  const FAIL = 'Open VSX 检查更新失败';
  const meta = await metaOf(origin.publisher, origin.extension, undefined, NET, FAIL);
  if (typeof meta.version !== 'string' || meta.version === '') {
    throw new Error(`${FAIL}：元数据缺少 version：${origin.publisher}.${origin.extension}`);
  }
  return { latest: meta.version, hasUpdate: meta.version !== origin.version };
}

/**
 * 更新主题（§6.3「重拉 → 校验 → 复用原记录 id 覆盖写入」）：重拉最新版 vsix →
 * 走原类型导入管线校验 → 内容写到原记录 id（设置引用零断链）、version/checkedAt
 * 刷新。不做 manifest 预检（更新对象是已知含主题的包；上游若裁掉主题，管线的
 * 「未找到主题」错误兜底）。
 * 多主题包更新语义：管线按包全量导入为临时记录，取与原记录同名条目（回落唯一
 * 条目；包内已无同名且非唯一时报错）写到原 id，其余临时记录清理——只就地更新被
 * 操作的一条，同包其余记录不受影响（回退 = 按 @version 重装旧版，§6.3）。
 */
export async function updateTheme(record: ImportedTheme | ImportedIconTheme): Promise<ImportedTheme | ImportedIconTheme> {
  if (!record.origin) {
    throw new Error(`主题「${record.name}」无 Open VSX 来源信息（本地导入不支持更新）`);
  }
  const { publisher, extension } = record.origin;
  const NET = 'Open VSX 更新失败（需网络与 CORS，或改用手动导入 vsix）';
  const FAIL = 'Open VSX 更新失败';
  const meta = await metaOf(publisher, extension, undefined, NET, FAIL);
  if (typeof meta.version !== 'string' || meta.version === '') {
    throw new Error(`${FAIL}：元数据缺少 version：${publisher}.${extension}`);
  }
  if (typeof meta.files?.download !== 'string') {
    throw new Error(`${FAIL}：元数据缺少 vsix 下载地址：${publisher}.${extension}`);
  }
  const buf = await downloadVsix(meta.files.download, NET, FAIL);
  const origin: ThemeOrigin = { publisher, extension, version: meta.version, checkedAt: Date.now() };
  const file = new File([buf], `${publisher}.${extension}-${meta.version}.vsix`);
  const isIcon = 'manifest' in record;
  const r = isIcon
    ? await importIconThemeFiles([file], { origin })
    : await importThemeFiles([file], { origin });
  const fresh =
    r.imported.find((t) => t.name === record.name) ?? (r.imported.length === 1 ? r.imported[0] : undefined);
  if (fresh === undefined) {
    // 清理本次管线已落库的临时记录，不留半截状态
    for (const t of r.imported) {
      if (isIcon) await deleteIconTheme(t.id);
      else await deleteTheme(t.id);
    }
    const detail =
      r.errors.length > 0
        ? `：${r.errors.join('；')}`
        : `：包内未找到同名主题「${record.name}」（上游可能已改名，可删除后重装）`;
    throw new Error(`Open VSX 更新失败${detail}`);
  }
  for (const t of r.imported) {
    if (isIcon) await deleteIconTheme(t.id);
    else await deleteTheme(t.id);
  }
  const updated: ImportedTheme | ImportedIconTheme = isIcon
    ? { ...(fresh as ImportedIconTheme), id: record.id }
    : { ...(fresh as ImportedTheme), id: record.id };
  if (isIcon) await putIconTheme(updated as ImportedIconTheme);
  else await putTheme(updated as ImportedTheme);
  return updated;
}
