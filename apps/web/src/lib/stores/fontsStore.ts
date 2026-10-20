/**
 * 网络字体库（字体系统 spec 2026-10-19 §5，Task 4）：IndexedDB v3 `fonts` store 上的
 * CRUD + FontFace 生命周期（document.fonts 装卸）。要点：
 * - 仅 https（mixed content 防线）；名称门禁（含逗号/与库内同名拒收——槽位与
 *   下拉均以 name 为键，台账 Low）；单文件 >30MB 拒收（MAX_FONT_BYTES，IndexedDB
 *   配额保护）；fetch 失败/非字体内容抛错误态（信息面向 UI 列表错误态 + 重试钮）；
 * - 添加管线「先装载验证后入库」：FontFace.load reject（非字体内容）不落库，列表
 *   不留死记录；错误态记录由消费方（Task 5）暂存待重试；
 * - FontFace family 参数引号包裹原文（内嵌引号/反斜杠转义）——与 theme.ts 注入侧
 *   fontFamilyValue 的单段引号语义同源，槽位引用按 name 经 fontFamilyValue 解析；
 * - 解析失败负缓存不固化（faceCache 不写入，重试可重建——mermaid 失败缓存先例）；
 * - deleteFont 返回被删记录作为引用回落信号：uiFamily/codeFamily 槽位是否回落默认
 *   由消费方（Task 5）比对处理，本模块不写 settings。
 * 测试形态：fake-indexeddb + mock FontFace/document.fonts 桩（jsdom 均缺失，
 * fontsStore.test.ts 同文件说明）。
 */
import { db, FONTS } from './session';
import { tryRequestPersistentSilent } from '../storageHealth';

/** 字体记录（spec §5.1 schema，键 id 无 keyPath 自管）：family = FontFace 族名
 * （创建时 = name；引号在装卸时加，不入库）。 */
export interface FontRecord {
  id: string;
  name: string;
  family: string;
  kind: 'url' | 'file';
  data: ArrayBuffer;
  url?: string;
  size: number;
  enabled: boolean;
  addedAt: number;
}

/** 单文件体积上限（spec §5.2：>30MB 拒收） */
export const MAX_FONT_BYTES = 30 * 1024 * 1024;

/** id（`font:<随机8>`，vsixImport 的 imported:<随机8> 同形态） */
function newFontId(): string {
  return `font:${Math.random().toString(36).slice(2, 10).padEnd(8, '0')}`;
}

// ---------- store 基元 ----------

/** 全量列表（addedAt 升序 = 入库序，管理列表展示序）。 */
export async function listFontRecords(): Promise<FontRecord[]> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(FONTS, 'readonly').objectStore(FONTS).getAll();
    req.onsuccess = () =>
      resolve(((req.result as FontRecord[] | undefined) ?? []).sort((a, b) => a.addedAt - b.addedAt));
    req.onerror = () => reject(req.error);
  });
}

async function getFontRecord(id: string): Promise<FontRecord | null> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(FONTS, 'readonly').objectStore(FONTS).get(id);
    req.onsuccess = () => resolve((req.result as FontRecord | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function putFontRecord(rec: FontRecord): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(FONTS, 'readwrite');
    tx.objectStore(FONTS).put(rec, rec.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

// ---------- FontFace 生命周期 ----------

/** 已装载 FontFace 缓存（键 id）：启停/恢复免重新解析；解析失败不写入（负缓存不固化）。 */
const faceCache = new Map<string, FontFace>();

/** FontFace family 参数：引号包裹原文 + 内嵌引号/反斜杠转义（theme.ts escapeFamilyName 同语义）。 */
function quotedFamily(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 从记录 buffer 取 FontFace：命中缓存直接返回；否则新建并 load——load reject
 * （非字体内容/损坏文件）抛错误态且不写缓存（允许重试）。
 */
async function ensureFontFace(rec: FontRecord): Promise<FontFace> {
  const hit = faceCache.get(rec.id);
  if (hit) return hit;
  const face = new FontFace(quotedFamily(rec.name), rec.data);
  try {
    await face.load();
  } catch (err) {
    throw new Error(`字体解析失败（内容不是有效字体？）：${err instanceof Error ? err.message : String(err)}`);
  }
  faceCache.set(rec.id, face);
  return face;
}

/** 名字推导（export：Task 5 面板错误态显示名同源推导，不复制实现）：URL 末段 /
 * 文件名去扩展名（URI 解码；无扩展名原样）。 */
export function stemOf(pathOrName: string): string {
  const last = pathOrName.split('/').filter(Boolean).pop() ?? 'font';
  const dot = last.lastIndexOf('.');
  const stem = dot > 0 ? last.slice(0, dot) : last;
  try {
    return decodeURIComponent(stem);
  } catch {
    return stem;
  }
}

/**
 * 添加共用尾段（台账 Low 顺序：名称门禁在前，不合法不发起装载）：名称门禁（逗号
 * 拒收——name 经槽位进 fontFamilyValue 会被拆成多级回退栈，语义漂移；同名拒收——
 * 下拉/管理列表/槽位回落全部按 name 比对，重名即引用错位）→ 30MB 门禁 → 先装载
 * 验证 → 入库 → 注册 document.fonts。
 */
async function addFromBuffer(
  buf: ArrayBuffer,
  meta: { kind: 'url' | 'file'; url?: string; name: string }
): Promise<FontRecord> {
  const name = meta.name || 'font';
  if (name.includes(',')) {
    throw new Error(`字体名称不能包含逗号：「${name}」（逗号是 family 多级回退分隔符）`);
  }
  if ((await listFontRecords()).some((r) => r.name === name)) {
    throw new Error(`已存在同名字体「${name}」，请改名或先删除原字体`);
  }
  if (buf.byteLength > MAX_FONT_BYTES) {
    throw new Error(`字体文件超过 30MB 上限（${(buf.byteLength / 1024 / 1024).toFixed(1)}MB）`);
  }
  const rec: FontRecord = {
    id: newFontId(),
    name,
    family: name,
    kind: meta.kind,
    data: buf,
    size: buf.byteLength,
    enabled: true,
    addedAt: Date.now()
  };
  if (meta.url !== undefined) rec.url = meta.url;
  const face = await ensureFontFace(rec); // 先验证后入库：非字体内容不落库（错误态可重试）
  await putFontRecord(rec);
  document.fonts.add(face);
  // 数据投入时刻申请持久化存储（settings center spec §2.1 预授权钩子）：保护字体
  // 不被磁盘压力驱逐；静默失败不打扰，仅持久化状态行反映
  tryRequestPersistentSilent();
  return rec;
}

/**
 * URL 添加（spec §5.2）：https 白名单 → fetch → 30MB 门禁 → 装载验证 → 入库启用。
 * 任何失败抛错误态（信息含 CORS 提示），不产生半截记录。
 */
export async function addFontFromUrl(url: string, name?: string): Promise<FontRecord> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`非法字体地址：${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error('仅支持 https 字体地址（混合内容防线）');
  let buf: ArrayBuffer;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = await res.arrayBuffer();
  } catch (err) {
    throw new Error(`字体下载失败（字体源需开启 CORS）：${err instanceof Error ? err.message : String(err)}`);
  }
  return addFromBuffer(buf, { kind: 'url', url, name: name?.trim() || stemOf(parsed.pathname) });
}

/** 本地上传添加（spec §5.2）：同 ArrayBuffer 路径；扩展名白名单由 UI input accept 把关。 */
export async function addFontFromFile(file: File): Promise<FontRecord> {
  return addFromBuffer(await file.arrayBuffer(), { kind: 'file', name: stemOf(file.name) });
}

/**
 * 启停（spec §5.2）：enabled 即时落库。停用注销 document.fonts（缓存保留——重启用
 * 免重解析）；启用从缓存或 store buffer 重建并注册，重建失败抛错（记录已置 enabled，
 * 负缓存不固化故可重试）。
 */
export async function setEnabledFont(id: string, enabled: boolean): Promise<void> {
  const rec = await getFontRecord(id);
  if (!rec) throw new Error(`字体记录不存在：${id}`);
  await putFontRecord({ ...rec, enabled });
  if (!enabled) {
    const face = faceCache.get(id);
    if (face) document.fonts.delete(face);
    return;
  }
  document.fonts.add(await ensureFontFace(rec));
}

/**
 * 删除：记录移除 + document.fonts 注销 + 缓存逐出。返回被删记录供消费方做槽位
 * 引用回落（比对 uiFamily/codeFamily 是否等于其 name），未命中返回 null。
 */
export async function deleteFont(id: string): Promise<FontRecord | null> {
  const rec = await getFontRecord(id);
  if (!rec) return null;
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(FONTS, 'readwrite');
    tx.objectStore(FONTS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
  const face = faceCache.get(id);
  if (face) {
    document.fonts.delete(face);
    faceCache.delete(id);
  }
  return rec;
}

/**
 * 启动恢复（Task 5 消费）：从 store 重建全部 enabled 项并注册 document.fonts。
 * 单项失败 console.warn 不阻断其余（损坏字体不拖垮启动）。
 */
export async function loadEnabledFontFaces(): Promise<void> {
  for (const rec of await listFontRecords()) {
    if (!rec.enabled) continue;
    try {
      document.fonts.add(await ensureFontFace(rec));
    } catch (err) {
      console.warn(`字体「${rec.name}」恢复失败`, err);
    }
  }
}
