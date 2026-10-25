/**
 * mountsSync.ts — 挂载记录的前端持久化与代理连接对账（目录挂载 spec 2026-10-19
 * §3+§4，plan Task 2+阶段三 Task 1）。服务端运行时挂载是内存态（重启失效）；
 * 本前端把注册过的代理挂载（kind 'proxy'，§3）与浏览器直连挂载（kind 'direct'，
 * §4 阶段三）存 IndexedDB v4 `mounts` store（session.ts DB_VERSION 顺延，fonts
 * 已占 v3），connectServer 成功后对账：按配置指纹比对 `GET /api/mounts` 清单，
 * 缺失幂等 POST 重注册；注册失败静默标记待重试（不抛错、不打扰连接主链）。
 * 直连记录不经服务器（无注册面），只持久化供 openFlow/管理页消费。
 * 要点：
 * - 指纹与 server `mount_fingerprint` 同算法镜像（kind+endpoint+bucket/prefix+
 *   label trim 后 U+001F 拼接，**不含凭据**）——「同一挂载目标」而非「同一份
 *   凭据」；凭据轮换不产生新指纹，探测失败走 DELETE+POST 重注册换凭据（S-3）。
 * - 清单条目 endpoint 是展示面（server 构造期剥 userinfo，评审 M1）；本端比对
 *   前先以 displayEndpoint 镜像剥除，userinfo 形态保存的记录不错发重复 POST。
 * - 记录作用域 serverBase：代理挂载注册在某台服务器上，对账只对同 base 记录，
 *   换服务器连接不误注册他机目标。
 * - 对账全链不抛错（fire-and-forget 契约，openFlow connectServer 后链挂载）；
 *   每步失败转 pendingRetry/lastError 落库，下次连接自然重试。
 * 测试形态：fake-indexeddb + fetch 路由桩（mountsSync.test.ts）。
 */
import { db, MOUNTS } from './stores/session';
import { parseRemoteStoreId, type DavDirectConfig, type S3DirectConfig } from '@vviewer/core';
import type { WorkspaceSource } from './workspaceStore';

/**
 * 代理挂载记录（brief 接口 schema + 实施扩展，扩展面记录任务报告）：
 * - backend：后端类别（'s3' | 'webdav'）——brief 的 `kind: 'proxy'` 标识记录
 *   类型（阶段四 direct 记录为另一 kind），POST body 的 kind 取 backend；
 * - serverBase：注册目标服务器（对账作用域，见模块注）；
 * - registeredRootIndex/pendingRetry/lastError：对账状态（健康时 lastError 键删除；
 *   失败时 registeredRootIndex 一并清除，不残留失效索引）。
 */
export interface ProxyMountRecord {
  id: string;
  kind: 'proxy';
  backend: 's3' | 'webdav';
  label: string;
  endpoint: string;
  /** S3 挂载的桶名；WebDAV 挂载缺省。 */
  bucket?: string;
  prefix: string;
  /** S3 = access_key_id；WebDAV = username。 */
  username?: string;
  /** S3 = secret_access_key；WebDAV = password。明文存储（spec §4 拍板：管理页警示面）。 */
  secret?: string;
  /** 配置指纹（mountFingerprintOf 产出；不含凭据）。 */
  fingerprint: string;
  serverBase: string;
  createdAt: number;
  /** 对账状态：注册/重注册失败置位（静默待重试），成功清除。 */
  pendingRetry?: boolean;
  lastError?: string;
  /** 最近一次已知的服务端 rootIndex（清单命中/POST 成功登记）。 */
  registeredRootIndex?: number;
}

/**
 * 直连挂载记录（目录挂载 spec §4 阶段四，plan Task 1）：浏览器直连 S3/WebDAV
 * 的前端持久化。要点：
 * - 凭据（username/secret）IndexedDB **明文**存储（spec §4 拍板；管理页在新增
 *   表单与列表详情双处固定警示面）；
 * - id = core 直连 store 的 storeId（`s3direct:`/`davdirect:` + hash8(挂载目标
 *   身份)，@vviewer/core s3DirectStoreId/davDirectStoreId 产出）——同配置天然
 *   去重，凭据轮换/改名不换 id（hash 不含凭据与 label，与 proxy 指纹同口径）；
 * - 与 proxy 记录同住 v4 `mounts` store，kind 判别（'proxy' | 'direct'）；
 *   直连记录不参与服务端对账（不经服务器，无注册面）。
 */
export interface DirectMountRecord {
  id: string;
  kind: 'direct';
  backend: 's3' | 'webdav';
  label: string;
  endpoint: string;
  /** S3 挂载的桶名；WebDAV 挂载缺省。 */
  bucket?: string;
  prefix: string;
  /** S3 = access_key_id；WebDAV = username。 */
  username?: string;
  /** S3 = secret_access_key；WebDAV = password。明文存储（spec §4 拍板：管理页警示面）。 */
  secret?: string;
  /** S3 path-style（缺省 true）；WebDAV 缺省。 */
  pathStyle?: boolean;
  createdAt: number;
}

/** mounts store 记录全体（kind 判别联合）。 */
export type MountRecord = ProxyMountRecord | DirectMountRecord;

/** `GET /api/mounts` 清单条目（server MountEntry HTTP 形态，凭据不在结构面）。 */
export interface MountManifestEntry {
  rootIndex: number;
  kind: string;
  label?: string;
  endpoint: string;
  bucket?: string;
  prefix: string;
  capabilities: { watch: boolean; search: boolean };
}

/** `GET /api/mounts` 清单（server MountsManifest 形态）。 */
export interface MountsManifest {
  fsRoots: number;
  staticMounts: MountManifestEntry[];
  runtimeMounts: MountManifestEntry[];
  mounts: MountManifestEntry[];
}

// ---------- 指纹与展示面（server 端同算法镜像，纯函数） ----------

/**
 * 配置指纹：[kind, endpoint, bucket, prefix, label] 各 trim 后 U+001F 拼接——
 * server `mount_fingerprint`（server/src/state.rs）的 TS 镜像。凭据不入参
 * （指纹语义 = 同一挂载目标）；POST 幂等由服务端按同指纹判定。
 */
export function mountFingerprintOf(cfg: {
  backend: string;
  endpoint: string;
  bucket?: string;
  prefix?: string;
  label?: string;
}): string {
  return [
    cfg.backend,
    cfg.endpoint.trim(),
    (cfg.bucket ?? '').trim(),
    (cfg.prefix ?? '').trim(),
    (cfg.label ?? '').trim()
  ].join('\u{1f}');
}

/**
 * 展示面 endpoint（server `vviewer_storage::display_endpoint` 的 TS 镜像）：
 * authority 段 userinfo 剥除（最后一个 '@'，RFC 3986；path 段 '@' 不误剥）；
 * 空 userinfo（`https://@host`）与无 scheme 形态原样。仅比对用——POST body
 * 仍带原值（userinfo 凭据是连接所需）。
 */
export function displayEndpoint(endpoint: string): string {
  const idx = endpoint.indexOf('://');
  const prefix = idx >= 0 ? endpoint.slice(0, idx + 3) : '';
  const rest = idx >= 0 ? endpoint.slice(idx + 3) : endpoint;
  const authority = rest.split('/')[0] ?? rest;
  const at = authority.lastIndexOf('@');
  if (at <= 0) return endpoint; // 无 '@' 或 userinfo 为空：无可剥
  return `${prefix}${authority.slice(at + 1)}${rest.slice(authority.length)}`;
}

/** 清单条目 → 指纹（条目 endpoint 已是展示面，直接参与）。 */
function entryFingerprint(e: MountManifestEntry): string {
  return mountFingerprintOf({
    backend: e.kind,
    endpoint: e.endpoint,
    bucket: e.bucket,
    prefix: e.prefix,
    label: e.label
  });
}

/** 记录 → 比对指纹：endpoint 先过展示面剥除（与清单条目同形态）。 */
function compareFingerprint(rec: ProxyMountRecord): string {
  return mountFingerprintOf({
    backend: rec.backend,
    endpoint: displayEndpoint(rec.endpoint),
    bucket: rec.bucket,
    prefix: rec.prefix,
    label: rec.label
  });
}

// ---------- mounts store CRUD（fontsStore 同模式：无 keyPath 自管 id 键） ----------

/**
 * 记录的会话内镜像（displayLabelForStore 的同步查询面，台账 3-20）：IndexedDB
 * 是异步面，展示层（tab 命名/来源列表渲染）需要同步映射——在 list/save/delete
 * 三个漏斗维护镜像（挂载记录量级为个位数，成本可忽略）。
 */
const recordCache = new Map<string, MountRecord>();

/** 全量列表（createdAt 升序 = 入库序；proxy/direct 两 kind 混存）。 */
export async function listMounts(): Promise<MountRecord[]> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(MOUNTS, 'readonly').objectStore(MOUNTS).getAll();
    req.onsuccess = () => {
      const all = ((req.result as MountRecord[] | undefined) ?? []).sort((a, b) => a.createdAt - b.createdAt);
      // 镜像全量重建：IndexedDB 是唯一事实源，list 是最全的读取面——清空重建
      // 兜住任何漏斗外的增删（防御性，生产写路径全部经 save/delete）
      recordCache.clear();
      for (const r of all) recordCache.set(r.id, r);
      resolve(all);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 入库/更新（对账状态落库与 direct 记录同走此漏斗）。 */
export async function saveMount(rec: MountRecord): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(MOUNTS, 'readwrite');
    tx.objectStore(MOUNTS).put(rec, rec.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
  recordCache.set(rec.id, rec); // 镜像跟随（label 改名/索引更新即时可见）
}

/** 删除（阶段四管理页删除动作挂点；proxy/direct 通用）。 */
export async function deleteMount(id: string): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction(MOUNTS, 'readwrite');
    tx.objectStore(MOUNTS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
  recordCache.delete(id); // 镜像跟随
}

/** 代理挂载记录分段列表（对账消费；direct 记录不入对账面，kind 过滤隔离）。 */
export async function listProxyMounts(): Promise<ProxyMountRecord[]> {
  return (await listMounts()).filter((r): r is ProxyMountRecord => r.kind === 'proxy');
}

/** 直连挂载记录分段列表（阶段四管理页消费）。 */
export async function listDirectMounts(): Promise<DirectMountRecord[]> {
  return (await listMounts()).filter((r): r is DirectMountRecord => r.kind === 'direct');
}

/** 直连记录入库/更新（saveMount 直连侧具名漏斗）。 */
export function saveDirectMount(rec: DirectMountRecord): Promise<void> {
  return saveMount(rec);
}

/** 直连记录删除（deleteMount 直连侧具名漏斗）。 */
export function deleteDirectMount(id: string): Promise<void> {
  return deleteMount(id);
}

// ---------- 挂载显示名映射（台账 3-20：storeId → mount label，纯展示面） ----------

/**
 * storeId → 挂载显示名（proxy/direct 记录的 label；未命中 undefined，调用方回落
 * 既有形态）。**hash 输入面零改动**：storeLabel 仍为 remoteSourceLabel 冻结值、
 * 参与 storeId hash，本映射只服务展示名（目录 tab 标题/来源列表行），显示名与
 * hash 输入解耦。匹配规则：
 * - direct：storeId 即记录 id（s3direct:/davdirect: + hash8），精确命中；
 * - proxy：storeId 反解 r 段（core parseRemoteStoreId 同源）对记录
 *   registeredRootIndex；opts.storeBase 提供时一并限定 serverBase（多服务器同
 *   索引去歧义——storeId 不携带 base，缺 base 且多候选时宁可未命中不猜）。
 *   3-1 迁移后的冻结 hash 形态（hash 段属旧 label）天然兼容：匹配按
 *   (serverBase, index) 身份而非 hash 重算，r 段已随 3-1 同步改写为新索引。
 * 查询走 recordCache 镜像（list/save/delete 漏斗维护）——记录未被列出过/库不可
 * 用时未命中回落，即既有展示形态（降级安全）。
 */
export function displayLabelForStore(storeId: string, opts?: { storeBase?: string }): string | undefined {
  const direct = recordCache.get(storeId);
  if (direct?.kind === 'direct') return direct.label;
  const parts = parseRemoteStoreId(storeId);
  if (parts === null) return undefined;
  const candidates = [...recordCache.values()].filter(
    (r) =>
      r.kind === 'proxy' &&
      r.registeredRootIndex === parts.rootIndex &&
      (opts?.storeBase === undefined || r.serverBase === opts.storeBase)
  );
  return candidates.length === 1 ? candidates[0]!.label : undefined;
}

/** 测试专用：清空会话内记录镜像（用例间隔离；镜像为模块级状态，生产无调用方）。 */
export function resetMountRecordCacheForTests(): void {
  recordCache.clear();
}

/**
 * 直连记录 → core 直连 store 配置（评审带入①：openFlow 创建分派与管理页测试
 * 连接共用的单一映射面）。字段按 backend 展开为 S3DirectConfig/DavDirectConfig
 * （username→accessKeyId/secret→secretAccessKey 或 username/password；prefix 与
 * pathStyle 直传——归一在工厂内）。缺失字段回退空串（记录损坏防御：工厂/探测
 * 面报错而非崩溃）；backend 不识别抛错。
 */
export function directConfigOf(rec: DirectMountRecord): S3DirectConfig | DavDirectConfig {
  if (rec.backend === 's3') {
    const cfg: S3DirectConfig = {
      endpoint: rec.endpoint,
      bucket: rec.bucket ?? '',
      prefix: rec.prefix,
      accessKeyId: rec.username ?? '',
      secretAccessKey: rec.secret ?? '',
      label: rec.label
    };
    if (rec.pathStyle !== undefined) cfg.pathStyle = rec.pathStyle;
    return cfg;
  }
  if (rec.backend === 'webdav') {
    return {
      endpoint: rec.endpoint,
      prefix: rec.prefix,
      username: rec.username ?? '',
      password: rec.secret ?? '',
      label: rec.label
    };
  }
  throw new Error(`未知直连后端: ${String((rec as { backend?: unknown }).backend)}`);
}

/** 兼容别名（既有调用面沿用 proxy 具名形态）。 */
export const saveProxyMount = saveMount;
export const deleteProxyMount = deleteMount;

// ---------- 对账与重注册 ----------

/** 请求超时（RemoteStore.request 30s 同款对齐）。 */
function reqTimeout(): AbortSignal | undefined {
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(30_000) : undefined;
}

/** mounts API 统一通道：Bearer 注入 + 超时。 */
async function mountsApi(
  base: string,
  token: string | null | undefined,
  apiPath: string,
  init?: RequestInit
): Promise<Response> {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${apiPath}`, { ...init, headers, signal: reqTimeout() });
}

/** 记录 → POST /api/mounts 请求体（server MountConfig 形态；brief 记录的
 * username/secret 按 backend 展开为 s3 access_key_id/secret_access_key 或
 * webdav username/password；path_style 缺省交服务端默认 true——spec path-style）。 */
function postBodyOf(rec: ProxyMountRecord): Record<string, unknown> {
  const body: Record<string, unknown> = {
    kind: rec.backend,
    label: rec.label,
    endpoint: rec.endpoint,
    prefix: rec.prefix
  };
  if (rec.backend === 's3') {
    body.bucket = rec.bucket;
    body.access_key_id = rec.username;
    body.secret_access_key = rec.secret;
  } else {
    body.username = rec.username;
    body.password = rec.secret;
  }
  return body;
}

/** 对账成功态记录（清待重试与错误；delete 展开键——JSON 化不留 undefined 键）。 */
function healthyRecord(rec: ProxyMountRecord, rootIndex: number): ProxyMountRecord {
  const copy: ProxyMountRecord = { ...rec, pendingRetry: false, registeredRootIndex: rootIndex };
  delete copy.lastError;
  return copy;
}

/** 失败态记录（静默标记待重试 + 原因；spec §3「注册失败静默标记待重试」）。
 * registeredRootIndex 一并清除（台账 3-11）：探测/重注册失败意味着服务端项可能
 * 已在对账间隙消失或轮换未遂，旧索引只指向他物——不清理会被展示机当 registered
 * 呈现、并供打开与 unregister 消费失效索引。置 undefined（:52 declared type 形态，
 * 消费点均 typeof 判定）。 */
function failedRecord(rec: ProxyMountRecord, message: string): ProxyMountRecord {
  return { ...rec, pendingRetry: true, lastError: message, registeredRootIndex: undefined };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 挂载根健康探测：`GET /api/tree?path=&root=<idx>`（轻量 list_dir）。
 * 判定按「非 200」即失败（Q-1：无状态码特判——上游不可达的 5xx/参数 4xx/
 * 引擎无关的超时一视同仁）；网络异常同失败。
 */
export async function probeMountRoot(
  serverBase: string,
  token: string | null | undefined,
  rootIndex: number
): Promise<boolean> {
  try {
    const res = await mountsApi(serverBase, token, `/api/tree?path=&root=${rootIndex}`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 重注册（S-3：凭据轮换）：DELETE /api/mounts/:index + POST 重放保存的配置
 * （含当前保存的凭据）。DELETE 404 = 服务端项已在对账间隙消失（竞态）——
 * 继续 POST 视作缺失注册；其余非 2xx 抛错（静态项 405 亦然——静态项无可
 * 轮换面，不该进本函数，防御性拒绝）。成功返回 old→new 索引对（台账 3-1：
 * new ≠ old 时调用方收集迁移对，供 openFlow 改写已开 tab/sources 的 rootIndex）。
 */
export async function reregisterMount(
  rec: ProxyMountRecord,
  token: string | null | undefined,
  rootIndex: number
): Promise<{ oldIndex: number; newIndex: number }> {
  const del = await mountsApi(rec.serverBase, token, `/api/mounts/${rootIndex}`, { method: 'DELETE' });
  if (!del.ok && del.status !== 404) {
    throw new Error(`重注册 DELETE 失败：HTTP ${del.status}`);
  }
  const post = await mountsApi(rec.serverBase, token, '/api/mounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(postBodyOf(rec))
  });
  if (!post.ok) {
    throw new Error(`重注册 POST 失败：HTTP ${post.status}`);
  }
  const body = (await post.json()) as { rootIndex?: unknown };
  if (typeof body.rootIndex !== 'number') {
    throw new Error('重注册响应缺少 rootIndex');
  }
  return { oldIndex: rootIndex, newIndex: body.rootIndex };
}

/**
 * 管理页新增代理挂载（spec §5 阶段四：proxy 增即时 POST /api/mounts；失败抛错
 * 且不落 IndexedDB——一致态由调用方保持）。返回服务端分配的 rootIndex。
 * 与对账链 postRegister 的分工：对账是静默自愈（失败落 pendingRetry），本面是
 * 用户动作（失败必须可见）。
 */
export async function registerProxyMount(
  rec: ProxyMountRecord,
  token: string | null | undefined
): Promise<number> {
  const res = await mountsApi(rec.serverBase, token, '/api/mounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(postBodyOf(rec))
  });
  if (!res.ok) throw new Error(`注册失败：HTTP ${res.status}`);
  const body = (await res.json()) as { rootIndex?: unknown };
  if (typeof body.rootIndex !== 'number') throw new Error('注册响应缺少 rootIndex');
  return body.rootIndex;
}

/**
 * 管理页删除代理挂载（spec §5 阶段四：proxy 删即时 DELETE /api/mounts/:index）。
 * 404 视为已不存在（幂等——服务端重启即清空运行时项）；其余非 2xx 抛错（静态
 * 项 405 亦然——静态挂载由服务端配置承载，管理页组②不该出现其记录）。IndexedDB
 * 记录删除由调用方处理（服务端先撤、本地后删，两步可观测）。
 */
export async function unregisterProxyMount(
  rec: ProxyMountRecord,
  token: string | null | undefined,
  rootIndex: number
): Promise<void> {
  const del = await mountsApi(rec.serverBase, token, `/api/mounts/${rootIndex}`, { method: 'DELETE' });
  if (!del.ok && del.status !== 404) throw new Error(`注销失败：HTTP ${del.status}`);
}

async function postRegister(rec: ProxyMountRecord, base: string, token: string | null): Promise<ProxyMountRecord> {
  const res = await mountsApi(base, token, '/api/mounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(postBodyOf(rec))
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { rootIndex?: unknown };
  if (typeof body.rootIndex !== 'number') throw new Error('响应缺少 rootIndex');
  return healthyRecord(rec, body.rootIndex);
}

// ---------- rootIndex 迁移（台账 3-1：重注册换索引的三面改写数学，纯函数直测） ----------

/** 单条 rootIndex 迁移对：serverBase 作用域内，服务端把该挂载从 oldIndex 挪到 newIndex。 */
export interface RootIndexMove {
  serverBase: string;
  oldIndex: number;
  newIndex: number;
}

/**
 * storeId 的 `:r<old>` 段改写（台账 3-1，core parseRemoteStoreId 同源正则）：
 * `remote:<hash8>:r<old>[:<hash8>]` → `remote:<hash8>:r<new>[:<hash8>]`。hash 段
 * （base:label 冻结值）与 basePath 指纹段保持原样——与快照恢复「storeLabel 原值
 * 回环」（serverConnect.reconnectRemoteStore，FE-2 自 AppShell 迁入）一致：恢复链以冻结 label + 快照 rootIndex
 * 重建，label 含「根N」会随索引变，重算反而断裂回环；正则只动 r 段恰与该回环
 * 形态互锁。非 remote 形态 / r 段 ≠ oldIndex / 相同索引 → null（调用方原样保留）。
 */
export function rewriteStoreIdRootIndex(storeId: string, oldIndex: number, newIndex: number): string | null {
  if (!Number.isInteger(oldIndex) || !Number.isInteger(newIndex) || oldIndex === newIndex) return null;
  const m = new RegExp(`^remote:([0-9a-f]{8}):r${oldIndex}(?::([0-9a-f]{8}))?$`).exec(storeId);
  if (m === null) return null;
  return `remote:${m[1]!}:r${newIndex}${m[2] !== undefined ? `:${m[2]}` : ''}`;
}

/**
 * 来源快照的迁移改写（台账 3-1 纯函数）：kind remote 且 storeBase+rootIndex 命中
 * 迁移对、且 storeId 的 r 段与 rootIndex 一致（形状漂移防御：不一致不改写——半改
 * 写会让 storeId 与 rootIndex 脱节）→ 返回新对象（rootIndex 换新 + storeId r 段
 * 改写；storeLabel/basePath 原样冻结——storeLabel 是 hash 输入与恢复回环依据）。
 * 未命中返回 null（调用方原样保留，不复制）。
 */
export function rewriteSourceForMigration(
  source: WorkspaceSource,
  moves: ReadonlyArray<RootIndexMove>
): WorkspaceSource | null {
  if (source.kind !== 'remote') return null;
  for (const move of moves) {
    if (source.storeBase !== move.serverBase) continue;
    if ((source.rootIndex ?? 0) !== move.oldIndex) continue;
    const storeId = rewriteStoreIdRootIndex(source.storeId, move.oldIndex, move.newIndex);
    if (storeId === null) return null; // 漂移/旧格式 id：整条放弃（不半改写）
    return { ...source, storeId, rootIndex: move.newIndex };
  }
  return null;
}

/**
 * 连接对账（spec §3 前端对账重注册）：连接成功后由 connectServer 挂
 * fire-and-forget。对同 serverBase 的每条保存记录：
 * - 指纹缺失 → POST 幂等注册（201 新建 / 200 服务端已有同指纹——均登记 rootIndex）；
 * - 命中运行时项（rootIndex ≥ 运行时段起点）→ 健康探测，失败走 reregisterMount
 *   （DELETE+POST 凭据轮换，S-3）；
 * - 命中静态项 → 只登记 rootIndex（服务端 TOML 承载，无可轮换面）。
 * 分流边界：运行时段起点 = `fsRoots + staticMounts.length`（server 清单形态，
 * staticMounts 段条目的 rootIndex 自 fsRoots 起算——单以 fsRoots 为界会把静态
 * 挂载误判成运行时项：探测 500 → DELETE 405 → 永久待重试误态）。
 * 全链不抛错：清单不可达 → 全部记录静默标记待重试；单项失败只标记该项。
 * 台账 3-1：登记/重注册使某记录的服务端索引变化（known registeredRootIndex ≠
 * 新索引）时收集 RootIndexMove，循环结束后回调 onMigrated 一次（openFlow 据此
 * 三面改写已开 tab/sources；回调异常吞掉——记录已落库，不影响对账契约）。
 * 台账 3-18：失败记录（pendingRetry）**不被短路**——下次对账照常按指纹比对
 * 并重发 probe，成功即 healthyRecord 恢复（spec §4-1：重探只由「下次对账」
 * 驱动，无定时器/后台轮询）；行为锚见 mountsSync.test.ts「降级重探」用例。
 */
export async function syncMountsOnConnect(
  serverBase: string,
  token?: string | null,
  onMigrated?: (moves: RootIndexMove[]) => void
): Promise<void> {
  try {
    const tok = token ?? null;
    const records = (await listProxyMounts()).filter((r) => r.serverBase === serverBase);
    if (records.length === 0) return; // 无保存记录：不发任何请求

    let manifest: MountsManifest;
    try {
      const res = await mountsApi(serverBase, tok, '/api/mounts');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Partial<MountsManifest>;
      if (!Array.isArray(body.mounts) || typeof body.fsRoots !== 'number') {
        throw new Error('清单形态不识别');
      }
      manifest = body as MountsManifest;
    } catch (err) {
      // 清单不可达（网络/鉴权/旧服务端无此 API）：全部记录静默标记待重试，
      // 下次连接自然重试（spec §3 Pages+无后端场景的降级同口径）
      const reason = errText(err);
      console.warn(`[vviewer] mountsSync：/api/mounts 不可达（${reason}），代理挂载标记待重试`);
      for (const rec of records) await saveProxyMount(failedRecord(rec, `清单获取失败：${reason}`));
      return;
    }

    const byFingerprint = new Map<string, MountManifestEntry>();
    for (const e of manifest.mounts) byFingerprint.set(entryFingerprint(e), e);
    const runtimeSegmentStart = manifest.fsRoots + (manifest.staticMounts?.length ?? 0);
    const moves: RootIndexMove[] = [];

    for (const rec of records) {
      let updated: ProxyMountRecord;
      const entry = byFingerprint.get(compareFingerprint(rec));
      if (entry === undefined) {
        try {
          updated = await postRegister(rec, serverBase, tok);
        } catch (err) {
          updated = failedRecord(rec, `注册失败：${errText(err)}`);
          console.warn(`[vviewer] mountsSync：「${rec.label}」${updated.lastError}`);
        }
      } else if (entry.rootIndex >= runtimeSegmentStart) {
        // 运行时项：探测健康（S-3）——失败 = 服务端可能持过期凭据，走
        // DELETE+POST 轮换为本端保存的凭据
        if (await probeMountRoot(serverBase, tok, entry.rootIndex)) {
          updated = healthyRecord(rec, entry.rootIndex);
        } else {
          try {
            updated = healthyRecord(rec, (await reregisterMount(rec, tok, entry.rootIndex)).newIndex);
          } catch (err) {
            updated = failedRecord(rec, `重注册失败：${errText(err)}`);
            console.warn(`[vviewer] mountsSync：「${rec.label}」${updated.lastError}`);
          }
        }
      } else {
        // 静态挂载同指纹（含 rootIndex ≥ fsRoots 的 staticMounts 段条目）：
        // 目标已由服务端配置承载（DELETE 恒 405），只登记
        updated = healthyRecord(rec, entry.rootIndex);
      }
      // 台账 3-1：登记/重注册换索引 → 收集迁移对（prev 为更新前的 registeredRootIndex，
      // 覆盖清单命中/幂等注册/重注册三条分配新索引的路径）
      const prevIndex = rec.registeredRootIndex;
      const nextIndex = updated.registeredRootIndex;
      if (typeof prevIndex === 'number' && typeof nextIndex === 'number' && prevIndex !== nextIndex) {
        moves.push({ serverBase: rec.serverBase, oldIndex: prevIndex, newIndex: nextIndex });
      }
      await saveProxyMount(updated);
    }

    if (moves.length > 0 && onMigrated !== undefined) {
      try {
        onMigrated(moves);
      } catch (err) {
        console.warn('[vviewer] mountsSync：迁移回调失败（记录已落库，不影响对账）', err);
      }
    }
  } catch (err) {
    // 防御性兜底（IndexedDB 自身不可用等）：对账不抛错，不影响连接主链
    console.warn('[vviewer] mountsSync：对账未完成（不影响连接）', err);
  }
}
