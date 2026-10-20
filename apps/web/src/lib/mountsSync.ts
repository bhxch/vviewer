/**
 * mountsSync.ts — 代理挂载的前端持久化与连接对账（目录挂载 spec 2026-10-19 §3，
 * plan Task 2）。服务端运行时挂载是内存态（重启失效）；本前端把自己注册过的
 * 代理挂载存 IndexedDB v4 `mounts` store（session.ts DB_VERSION 顺延，fonts 已占
 * v3），connectServer 成功后对账：按配置指纹比对 `GET /api/mounts` 清单，缺失
 * 幂等 POST 重注册；注册失败静默标记待重试（不抛错、不打扰连接主链）。
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

/**
 * 代理挂载记录（brief 接口 schema + 实施扩展，扩展面记录任务报告）：
 * - backend：后端类别（'s3' | 'webdav'）——brief 的 `kind: 'proxy'` 标识记录
 *   类型（阶段四 direct 记录为另一 kind），POST body 的 kind 取 backend；
 * - serverBase：注册目标服务器（对账作用域，见模块注）；
 * - registeredRootIndex/pendingRetry/lastError：对账状态（健康时 lastError 键删除）。
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

/** 全量列表（createdAt 升序 = 入库序）。 */
export async function listProxyMounts(): Promise<ProxyMountRecord[]> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction(MOUNTS, 'readonly').objectStore(MOUNTS).getAll();
    req.onsuccess = () =>
      resolve(((req.result as ProxyMountRecord[] | undefined) ?? []).sort((a, b) => a.createdAt - b.createdAt));
    req.onerror = () => reject(req.error);
  });
}

/** 入库/更新（对账状态落库同走此漏斗）。 */
export async function saveProxyMount(rec: ProxyMountRecord): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(MOUNTS, 'readwrite');
    tx.objectStore(MOUNTS).put(rec, rec.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

/** 删除（阶段四管理页删除动作挂点）。 */
export async function deleteProxyMount(id: string): Promise<void> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(MOUNTS, 'readwrite');
    tx.objectStore(MOUNTS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

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

/** 失败态记录（静默标记待重试 + 原因；spec §3「注册失败静默标记待重试」）。 */
function failedRecord(rec: ProxyMountRecord, message: string): ProxyMountRecord {
  return { ...rec, pendingRetry: true, lastError: message };
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
    const res = await mountsApi(serverBase, token, `/api/tree?path=${encodeURIComponent('')}&root=${rootIndex}`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 重注册（S-3：凭据轮换）：DELETE /api/mounts/:index + POST 重放保存的配置
 * （含当前保存的凭据）。DELETE 404 = 服务端项已在对账间隙消失（竞态）——
 * 继续 POST 视作缺失注册；其余非 2xx 抛错（静态项 405 亦然——静态项无可
 * 轮换面，不该进本函数，防御性拒绝）。成功返回新分配的 rootIndex。
 */
export async function reregisterMount(
  rec: ProxyMountRecord,
  token: string | null | undefined,
  rootIndex: number
): Promise<number> {
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
  return body.rootIndex;
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
 */
export async function syncMountsOnConnect(serverBase: string, token?: string | null): Promise<void> {
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
            updated = healthyRecord(rec, await reregisterMount(rec, tok, entry.rootIndex));
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
      await saveProxyMount(updated);
    }
  } catch (err) {
    // 防御性兜底（IndexedDB 自身不可用等）：对账不抛错，不影响连接主链
    console.warn('[vviewer] mountsSync：对账未完成（不影响连接）', err);
  }
}
