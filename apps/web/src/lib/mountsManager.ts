/**
 * mountsManager.ts — 目录管理页纯逻辑（目录挂载 spec §5 阶段四，plan Task 2）。
 * MountsManager.svelte 的可测面收编本文件：表单校验（必填镜像 server build_mount
 * per-kind 必填 + endpoint userinfo 拒绝——评审 L1）、草稿↔记录构造（direct id
 * 闭环 = core 直连 storeId；proxy id = 指纹派生幂等）、三组数据装配（服务端根与
 * 挂载 / 前端配置挂载 / 本机授权来源）、测试连接探测（S3 ListObjectsV2 / WebDAV
 * PROPFIND，条目数+延迟回显；CORS 特征化与 http 部署 WebCrypto 缺失错误原样
 * 回显——Task 1 疑虑①）。组件骨架/接线为源码契约断言（mountsManagerUi.test.ts），
 * 行为由 e2e b-mounts-manager 兜底。
 */
import {
  createS3DirectStore,
  createDavDirectStore,
  s3DirectStoreId,
  davDirectStoreId,
  type DavDirectConfig,
  type S3DirectConfig
} from '@vviewer/core';
import {
  directConfigOf,
  displayEndpoint,
  mountFingerprintOf,
  type DirectMountRecord,
  type MountManifestEntry,
  type MountRecord,
  type MountsManifest,
  type ProxyMountRecord
} from './mountsSync';
import type { WorkspaceSource } from './workspaceStore';

/**
 * 凭据警示（spec §6 固定文案）：直连凭据 IndexedDB 明文可被同源脚本与本机用户
 * 提取——组件在新增表单与列表详情双处固定渲染本常量（单一出处，双处出现在
 * mountsManagerUi.test.ts 源码契约锁定）。
 */
export const CREDENTIAL_WARNING =
  '直连凭据以明文保存在浏览器 IndexedDB，可被同源脚本与本机用户提取；请勿在共享设备保存高权限凭据。';

/** WebDAV 直连 CORS 预检提示（spec §4：大概率被拦，知情使用；表单 kind 切至 webdav 即示）。 */
export const WEBDAV_CORS_HINT =
  'WebDAV 服务器需配置 CORS（允许本站来源 + PROPFIND/GET 方法），否则浏览器直连会被拦截。';

/**
 * 新增/编辑表单草稿（kind→字段集切换；mode 切直连/代理）。username/secret 为
 * 双 kind 通用字段名（S3 = access_key_id/secret_access_key，WebDAV = username/
 * password——POST body 的展开在 mountsSync.postBodyOf / core 工厂配置映射）。
 */
export interface MountFormDraft {
  mode: 'direct' | 'proxy';
  backend: 's3' | 'webdav';
  label: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  /** S3 = access_key_id；WebDAV = username。 */
  username: string;
  /** S3 = secret_access_key；WebDAV = password。 */
  secret: string;
  /** S3 path-style（缺省 true）；WebDAV 忽略。 */
  pathStyle: boolean;
  /** proxy 模式的注册目标服务器（UI 以 loadLastServer().baseUrl 注入）。 */
  serverBase: string;
}

/** 新增表单初始草稿（path-style 缺省 true——spec path-style 语义）。 */
export function emptyDraft(serverBase = ''): MountFormDraft {
  return {
    mode: 'direct',
    backend: 's3',
    label: '',
    endpoint: '',
    bucket: '',
    prefix: '',
    username: '',
    secret: '',
    pathStyle: true,
    serverBase
  };
}

/**
 * endpoint userinfo 校验（评审 L1）：authority 段含 '@' 即拒绝——凭据不入
 * endpoint（服务端展示面剥 userinfo 的镜像口径，displayEndpoint 同位判断；
 * path 段 '@' 不误伤）。空 userinfo（`https://@host`）同拒（防御形态）。
 * 返回固定提示文案；合法返回 null。
 */
export function endpointIssue(endpoint: string): string | null {
  const idx = endpoint.indexOf('://');
  const rest = idx >= 0 ? endpoint.slice(idx + 3) : endpoint;
  const authority = rest.split('/')[0] ?? rest;
  if (authority.includes('@')) {
    return '请使用不含凭据的 endpoint，凭据在下方字段填写';
  }
  return null;
}

/**
 * 表单必填校验：镜像 server `build_mount` per-kind 必填（S3：endpoint/bucket/
 * access_key_id/secret_access_key；WebDAV：endpoint/username/password；label
 * 两侧均必填——显示名入 storeId/指纹），另加 endpoint userinfo（L1）与 proxy
 * 模式的 serverBase 要求。错误消息含字段定位、不含凭据值（spec §6 纪律）。
 */
export function mountFormIssues(d: MountFormDraft): Partial<Record<keyof MountFormDraft, string>> {
  const issues: Partial<Record<keyof MountFormDraft, string>> = {};
  if (d.label.trim() === '') issues.label = '必填';
  if (d.endpoint.trim() === '') issues.endpoint = '必填';
  else {
    const ui = endpointIssue(d.endpoint.trim());
    if (ui !== null) issues.endpoint = ui;
  }
  if (d.mode === 'proxy' && d.serverBase.trim() === '') {
    issues.serverBase = '代理挂载需先连接服务器';
  }
  if (d.backend === 's3' && d.bucket.trim() === '') issues.bucket = '必填';
  if (d.username.trim() === '') issues.username = '必填';
  if (d.secret === '') issues.secret = '必填';
  return issues;
}

// ---------- 草稿 ↔ 记录 ----------

/**
 * 草稿 → 直连记录：id = core 直连 storeId（s3DirectStoreId/davDirectStoreId——
 * 同配置天然去重，凭据轮换/改名不换 id）；trim 落盘（secret 原样——空格可能是
 * 凭据本体）；pathStyle 仅在 false 时写入（缺省 true）。createdAt 沿用既有记录
 * （编辑不改入库序）。
 */
export function draftToDirectRecord(d: MountFormDraft, existing?: DirectMountRecord): DirectMountRecord {
  // endpoint 尾斜杠归一（core 工厂 bucketBase 同款；storeId hash 入参是 trim 后
  // 原串——归一后存储使「同配置 → 同 id」在带尾斜杠输入下仍成立）
  const endpoint = d.endpoint.trim().replace(/\/+$/, '');
  const label = d.label.trim();
  const prefix = d.prefix.trim();
  const bucket = d.bucket.trim();
  const username = d.username.trim();
  const id =
    d.backend === 's3'
      ? s3DirectStoreId({ endpoint, bucket, prefix, pathStyle: d.pathStyle })
      : davDirectStoreId({ endpoint, prefix });
  return {
    id,
    kind: 'direct',
    backend: d.backend,
    label,
    endpoint,
    ...(d.backend === 's3' ? { bucket } : {}),
    prefix,
    ...(username !== '' ? { username } : {}),
    ...(d.secret !== '' ? { secret: d.secret } : {}),
    ...(d.backend === 's3' && d.pathStyle === false ? { pathStyle: false } : {}),
    createdAt: existing?.createdAt ?? Date.now()
  };
}

/**
 * 草稿 → 代理记录：id 与 fingerprint 均由配置指纹派生（`mount:<fingerprint>`——
 * 不含凭据，同目标重存幂等覆盖、凭据轮换不产生第二条）。serverBase 为注册目标
 * 服务器（对账作用域，见 mountsSync 注）。
 */
export function draftToProxyRecord(d: MountFormDraft, existing?: ProxyMountRecord): ProxyMountRecord {
  const endpoint = d.endpoint.trim();
  const label = d.label.trim();
  const prefix = d.prefix.trim();
  const bucket = d.backend === 's3' ? d.bucket.trim() : undefined;
  const fingerprint = mountFingerprintOf({ backend: d.backend, endpoint, bucket, prefix, label });
  return {
    id: `mount:${fingerprint}`,
    kind: 'proxy',
    backend: d.backend,
    label,
    endpoint,
    ...(bucket !== undefined ? { bucket } : {}),
    prefix,
    username: d.username.trim(),
    secret: d.secret,
    fingerprint,
    serverBase: d.serverBase.trim(),
    createdAt: existing?.createdAt ?? Date.now()
  };
}

/** 记录 → 表单草稿（编辑预填；凭据回填明文——管理页即凭据管理面）。 */
export function draftFromRecord(rec: MountRecord): MountFormDraft {
  const common = {
    label: rec.label,
    endpoint: rec.endpoint,
    prefix: rec.prefix,
    username: rec.username ?? '',
    secret: rec.secret ?? ''
  };
  if (rec.kind === 'direct') {
    return {
      mode: 'direct',
      backend: rec.backend,
      ...common,
      bucket: rec.bucket ?? '',
      pathStyle: rec.pathStyle !== false,
      serverBase: ''
    };
  }
  return {
    mode: 'proxy',
    backend: rec.backend,
    ...common,
    bucket: rec.bucket ?? '',
    pathStyle: true,
    serverBase: rec.serverBase
  };
}

// ---------- 组①②③装配 ----------

/** 服务端根与挂载行（组①视图模型）。 */
export interface ServerMountRow {
  rootIndex: number;
  /** 显示名：fs 根取 rootPaths 宣告（回落「根 N」），挂载取 label（回落 kind 挂载）。 */
  title: string;
  segment: 'fs' | 'static' | 'runtime';
  /** 段徽标文案。 */
  segmentLabel: string;
  /** 挂载条目 kind（'s3'|'webdav'）；fs 根缺省。 */
  kind?: string;
  /** 展示面 endpoint（服务端构造期已剥 userinfo）；fs 根缺省。 */
  endpoint?: string;
  bucket?: string;
  prefix: string;
  watch: boolean;
  search: boolean;
}

/**
 * 组①装配（GET /api/mounts 清单 + health rootPaths）：fs 根段（fsRoots 个）+
 * 静态挂载段 + 运行时段。manifest 缺失（未连接/旧服务端）返回空数组——UI 显示
 * 未连接降级。能力位按服务端宣告（挂载根恒 watch/search=false，fs 根按 true）。
 */
export function assembleServerMountRows(
  manifest: MountsManifest | null,
  rootPaths: readonly string[]
): ServerMountRow[] {
  if (manifest === null || typeof manifest.fsRoots !== 'number') return [];
  const rows: ServerMountRow[] = [];
  for (let i = 0; i < manifest.fsRoots; i++) {
    rows.push({
      rootIndex: i,
      title: rootPaths[i] ?? `根 ${i}`,
      segment: 'fs',
      segmentLabel: 'fs 根',
      prefix: '',
      watch: true,
      search: true
    });
  }
  const push = (e: MountManifestEntry, segment: 'static' | 'runtime'): void => {
    rows.push({
      rootIndex: e.rootIndex,
      title: e.label ?? `${e.kind} 挂载`,
      segment,
      segmentLabel: segment === 'static' ? '静态挂载' : '运行时',
      kind: e.kind,
      endpoint: e.endpoint,
      bucket: e.bucket,
      prefix: e.prefix,
      watch: e.capabilities.watch,
      search: e.capabilities.search
    });
  };
  for (const e of manifest.staticMounts ?? []) push(e, 'static');
  for (const e of manifest.runtimeMounts ?? []) push(e, 'runtime');
  return rows;
}

/** 组②行状态（proxy 对账状态徽标；direct 无服务端注册面）。 */
export type MountRowState =
  | { code: 'direct' }
  | { code: 'registered'; rootIndex: number }
  | { code: 'pending'; error?: string }
  | { code: 'unregistered' };

/** 组②行（前端配置挂载视图模型）。 */
export interface MountRow {
  record: MountRecord;
  modeLabel: '直连' | '代理';
  backendLabel: 'S3' | 'WebDAV';
  /** 凭据已存指示（spec §5 组②）。 */
  hasCredential: boolean;
  /** 展示面 endpoint（本端保存的记录可能含 userinfo 形态，剥除后展示）。 */
  displayEndpointText: string;
  state: MountRowState;
}

/**
 * 组②装配：direct + proxy 记录混列（listMounts 已按 createdAt 升序），proxy
 * 状态机按对账字段派生——pendingRetry=true 优先（待注册/重试失败态带原因），
 * 其次 registeredRootIndex（已注册），否则未注册。
 */
export function assembleMountRows(records: readonly MountRecord[]): MountRow[] {
  return records.map((record) => {
    const backendLabel = record.backend === 's3' ? ('S3' as const) : ('WebDAV' as const);
    const base = {
      record,
      backendLabel,
      hasCredential: record.secret !== undefined && record.secret !== '',
      displayEndpointText: displayEndpoint(record.endpoint)
    };
    if (record.kind === 'direct') {
      return { ...base, modeLabel: '直连' as const, state: { code: 'direct' } as const };
    }
    const state: MountRowState =
      record.pendingRetry === true
        ? { code: 'pending', ...(record.lastError !== undefined ? { error: record.lastError } : {}) }
        : typeof record.registeredRootIndex === 'number'
          ? { code: 'registered', rootIndex: record.registeredRootIndex }
          : { code: 'unregistered' };
    return { ...base, modeLabel: '代理' as const, state };
  });
}

/** 组③行（本机授权来源视图模型）。 */
export interface LocalSourceRow {
  key: string;
  kind: 'localfs' | 'localfiles';
  title: string;
  /** localfs 句柄授权态（queryPermission 结果）；localfiles 无句柄概念为 null。 */
  permission: 'granted' | 'prompt' | 'denied' | null;
  detail: string;
}

/**
 * 组③装配：localfs 句柄（kv 'dirHandle' 单槽，名称+授权态）+ 当前会话的
 * localfiles 来源（会话级，文件内容不持久）。句柄缺省仅列会话来源。
 */
export function assembleLocalRows(
  handle: { name: string } | null,
  permission: 'granted' | 'prompt' | 'denied' | null,
  sources: readonly WorkspaceSource[]
): LocalSourceRow[] {
  const rows: LocalSourceRow[] = [];
  if (handle !== null) {
    rows.push({
      key: `localfs:${handle.name}`,
      kind: 'localfs',
      title: handle.name,
      permission: permission ?? 'prompt',
      detail:
        permission === 'granted'
          ? '已授权（会话恢复可用）'
          : '需重新授权（刷新后恢复将弹出权限提示）'
    });
  }
  for (const s of sources) {
    if (s.kind !== 'localfiles') continue;
    rows.push({
      key: s.storeId,
      kind: 'localfiles',
      title: s.storeLabel,
      permission: null,
      detail: '会话来源（文件内容不持久，刷新后需重新打开）'
    });
  }
  return rows;
}

// ---------- 测试连接 ----------

/** 测试连接结果（表单/列表回显态）。 */
export type ProbeResult = { ok: true; entries: number; ms: number } | { ok: false; error: string };

/**
 * 测试连接（spec §5：实际发一次 list_dir 探测并回显根条目数与延迟）。S3 走
 * ListObjectsV2、WebDAV 走 PROPFIND——均经 core 直连工厂（与直连挂载打开后
 * 同一条链路；配置映射复用 directConfigOf 单一映射面）。代理挂载的测试连接同为
 * 浏览器侧探测：验证目标可达与凭据有效（服务器出口连通性在保存注册后由对账
 * 健康探测覆盖）。错误原样回显——含 CORS 特征化文案与 http 部署 WebCrypto
 * 缺失文案（core subtle() 入口，Task 1 疑虑①的覆盖面）。
 */
async function probeWith(cfg: S3DirectConfig | DavDirectConfig): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const store = 'bucket' in cfg ? createS3DirectStore(cfg) : createDavDirectStore(cfg);
    const entries = await store.listChildren('');
    return { ok: true, entries: entries.length, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 表单草稿探测（未落库——「测试连接」先于「保存」）。 */
export async function probeDraft(d: MountFormDraft): Promise<ProbeResult> {
  return probeWith(directConfigOf(draftToDirectRecord(d)));
}

/** 已存直连记录探测（列表行「测试」动作）。 */
export async function probeRecord(rec: DirectMountRecord): Promise<ProbeResult> {
  return probeWith(directConfigOf(rec));
}

/** 测试连接结果回显文案（spec §5：条目数 + 延迟）。 */
export function formatProbeResult(r: ProbeResult): string {
  return r.ok ? `连接成功：根目录 ${r.entries} 个条目，延迟 ${r.ms} ms` : `连接失败：${r.error}`;
}

// ---------- 删除联动 ----------

/**
 * 删除引用面（plan：删除引用回落联动）：统计引用该 storeId 的工作区数——删除
 * 后运行中 tab 不中断（store 随最后持有者释放，既有语义），会话快照恢复将因
 * 记录缺失落占位（带入①的降级链）；确认弹窗文案据此提示。
 */
export function mountUsageOf(
  storeId: string,
  workspaces: readonly { sources: readonly WorkspaceSource[] }[]
): { sources: number } {
  return {
    sources: workspaces.filter((w) => w.sources.some((s) => s.storeId === storeId)).length
  };
}
