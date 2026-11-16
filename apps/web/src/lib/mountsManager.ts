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
  probeGithubDirect,
  probeGitlabDirect,
  s3DirectStoreId,
  davDirectStoreId,
  type DavDirectConfig,
  type GitlabDirectConfig,
  type GithubDirectConfig,
  type S3DirectConfig
} from '@bhxch/vviewer-core';
import { translate as t } from './i18n/core';
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
 * 提取——组件在新增表单与列表详情双处固定渲染本函数（单一出处，双处出现在
 * mountsManagerUi.test.ts 源码契约锁定）。i18n Task 8：文案迁目录 mounts.warn.*
 * ——原模块常量改函数（Task 7 saveDeniedNotice 先例：常量在模块装载时刻取值会
 * 钉死启动 locale，函数在渲染时刻现取当下 locale）。
 */
export function credentialWarning(): string {
  return t('mounts.warn.credential');
}

/** WebDAV 直连 CORS 预检提示（spec §4：大概率被拦，知情使用；表单 kind 切至 webdav 即示）。 */
export function webdavCorsHint(): string {
  return t('mounts.warn.webdavCors');
}

/**
 * 新增/编辑表单草稿（kind→字段集切换；mode 切直连/代理）。username/secret 为
 * 双 kind 通用字段名（S3 = access_key_id/secret_access_key，WebDAV = username/
 * password——POST body 的展开在 mountsSync.postBodyOf / core 工厂配置映射）。
 * backend 类型四联合（spec I Task 2 类型连带：DirectMountRecord.backend 扩四后
 * draftFromRecord git 回环赋值闭合——git 表单必填校验/字段组/落记录逻辑 Task 3 落）。
 */
export interface MountFormDraft {
  mode: 'direct' | 'proxy';
  backend: 's3' | 'webdav' | 'github' | 'gitlab';
  label: string;
  endpoint: string;
  bucket: string;
  prefix: string;
  /** S3 = access_key_id；WebDAV = username。 */
  username: string;
  /** S3 = secret_access_key；WebDAV = password；git = 显式 PAT（可空——凭据库匹配）。 */
  secret: string;
  /** S3 path-style（缺省 true）；WebDAV/git 忽略。 */
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
    return t('mounts.form.endpointUserinfo');
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
  if (d.label.trim() === '') issues.label = t('mounts.form.required');
  if (d.endpoint.trim() === '') issues.endpoint = t('mounts.form.required');
  else {
    const ui = endpointIssue(d.endpoint.trim());
    if (ui !== null) issues.endpoint = ui;
  }
  if (d.mode === 'proxy' && d.serverBase.trim() === '') {
    issues.serverBase = t('mounts.form.serverBaseRequired');
  }
  if (d.backend === 's3' && d.bucket.trim() === '') issues.bucket = t('mounts.form.required');
  if (d.username.trim() === '') issues.username = t('mounts.form.required');
  if (d.secret === '') issues.secret = t('mounts.form.required');
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
 * 服务器（对账作用域，见 mountsSync 注）。git backend 拒绝（spec I：git 挂载仅
 * 支持浏览器直连、无代理面——mountFormIssues 的 mode issue 分派 Task 3 落，本
 * throw 为类型收窄与损坏防御双保险；防御错误为内部身份面不上屏，英文化同日志串
 * 口径——directConfigOf Unknown backend 同款）。
 */
export function draftToProxyRecord(d: MountFormDraft, existing?: ProxyMountRecord): ProxyMountRecord {
  if (d.backend === 'github' || d.backend === 'gitlab') {
    throw new Error(`proxy mode does not support git backend: ${d.backend}`);
  }
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
  // gitcred 不是挂载表单对象（组④凭据区块专管——Task 3 落地）：MountRecord 联合
  // 扩列（Task 2）的类型连带防御早退——凭据条目不进挂载表单（编辑面=重提同键覆盖）
  if (rec.kind === 'gitcred') return emptyDraft();
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
      title: rootPaths[i] ?? t('mounts.title.fsRoot', { n: i }),
      segment: 'fs',
      segmentLabel: t('mounts.segment.fs'),
      prefix: '',
      watch: true,
      search: true
    });
  }
  const push = (e: MountManifestEntry, segment: 'static' | 'runtime'): void => {
    rows.push({
      rootIndex: e.rootIndex,
      title: e.label ?? t('mounts.title.mount', { kind: e.kind }),
      segment,
      segmentLabel: segment === 'static' ? t('mounts.segment.static') : t('mounts.segment.runtime'),
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

/** 组②行状态（proxy 对账状态徽标；direct 无服务端注册面）。offsite = 注册于
 * 他机（serverBase 与当前连接不一致——评审 M1 跨连接作用域防线）。 */
export type MountRowState =
  | { code: 'direct' }
  | { code: 'registered'; rootIndex: number }
  | { code: 'offsite'; rootIndex: number }
  | { code: 'pending'; error?: string }
  | { code: 'unregistered' };

/** 组②行（前端配置挂载视图模型）。modeLabel 为纯显示徽标（i18n 目录值）——
 * 判别面一律走 record.kind / state.code 稳定标识符（i18n Task 8 D8：原模板
 * `modeLabel === '直连'` 的显示串比较已改 record.kind，locale 切换不再影响判别）。 */
export interface MountRow {
  /** 挂载记录（gitcred 已在装配入口过滤——恒 proxy/direct 两 kind，spec I Review Focus 2）。 */
  record: ProxyMountRecord | DirectMountRecord;
  modeLabel: string;
  backendLabel: 'S3' | 'WebDAV';
  /** 凭据已存指示（spec §5 组②）。 */
  hasCredential: boolean;
  /** 展示面 endpoint（本端保存的记录可能含 userinfo 形态，剥除后展示）。 */
  displayEndpointText: string;
  state: MountRowState;
}

/**
 * proxy 记录是否「注册于他机」（相对当前连接；评审 M1 修复）：记录操作（打开/
 * 徽标/删除/重注册）前的作用域比对依据——不一致时打开禁用（rootIndex 是他机
 * 命名空间，以当前连接 B + A 的 rootIndex 会开出 B 上完全不同的根）、徽标改
 * 「注册于他机」、删除走强制本地删除逃生口（服务端注销留待连接该服务器）、
 * 编辑注册被阻断（当前 token 打他机服务器只会 401）。currentBase null（未
 * 连接）恒视为 offsite——无连接即无安全服务端操作面。
 */
export function proxyOffsiteOf(rec: MountRecord, currentBase: string | null): boolean {
  return rec.kind === 'proxy' && rec.serverBase !== currentBase;
}

/**
 * 组②装配：direct + proxy 记录混列（listMounts 已按 createdAt 升序），proxy
 * 状态机按对账字段派生——pendingRetry=true 优先（待注册/重试失败态带原因），
 * 其次 registeredRootIndex（已注册；与 currentBase 不一致时为 offsite「注册于
 * 他机」），否则未注册。currentBase = 当前连接 serverBase（last?.baseUrl ?? null）。
 * **gitcred 过滤**（spec I Review Focus 2——MountRecord 联合扩列 Task 2 的类型
 * 连带闭合面，Task 3 该点零改动）：凭据条目不是挂载行（backendLabel 判空/endpoint
 * 缺失会当挂载渲染）——`gitcred:` id 与组④凭据区块（Task 3）衔接。
 */
export function assembleMountRows(
  records: readonly MountRecord[],
  currentBase: string | null
): MountRow[] {
  return records
    .filter((record): record is Exclude<MountRecord, { kind: 'gitcred' }> => record.kind !== 'gitcred')
    .map((record) => {
    const backendLabel = record.backend === 's3' ? ('S3' as const) : ('WebDAV' as const);
    const base = {
      record,
      backendLabel,
      hasCredential: record.secret !== undefined && record.secret !== '',
      displayEndpointText: displayEndpoint(record.endpoint)
    };
    if (record.kind === 'direct') {
      return { ...base, modeLabel: t('mounts.mode.direct'), state: { code: 'direct' } as const };
    }
    const state: MountRowState =
      record.pendingRetry === true
        ? { code: 'pending', ...(record.lastError !== undefined ? { error: record.lastError } : {}) }
        : typeof record.registeredRootIndex === 'number'
          ? proxyOffsiteOf(record, currentBase)
            ? { code: 'offsite', rootIndex: record.registeredRootIndex }
            : { code: 'registered', rootIndex: record.registeredRootIndex }
          : { code: 'unregistered' };
    return { ...base, modeLabel: t('mounts.mode.proxy'), state };
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
          ? t('mounts.local.granted')
          : t('mounts.local.needsReauth')
    });
  }
  for (const s of sources) {
    if (s.kind !== 'localfiles') continue;
    rows.push({
      key: s.storeId,
      kind: 'localfiles',
      title: s.storeLabel,
      permission: null,
      detail: t('mounts.local.sessionDetail')
    });
  }
  return rows;
}

// ---------- 测试连接 ----------

/**
 * 测试连接结果（表单/列表回显态；git 扩支 spec I Task 2 评审 ① 前移收编）：
 * git 支路经 core probe 函数回显 ref 解析 sha（8 位展示）与 truncated 注记
 *（GitHub 大仓首响应采样——Errata ⑩；GitLab 无上游截断标记恒缺省）。
 */
export type ProbeResult =
  | { ok: true; entries: number; ms: number; sha?: string; truncated?: boolean }
  | { ok: false; error: string };

/**
 * 测试连接（spec §5：实际发一次 list_dir 探测并回显根条目数与延迟）。S3 走
 * ListObjectsV2、WebDAV 走 PROPFIND——均经 core 直连工厂（与直连挂载打开后
 * 同一条链路；配置映射复用 directConfigOf 单一映射面）。代理挂载的测试连接同为
 * 浏览器侧探测：验证目标可达与凭据有效（服务器出口连通性在保存注册后由对账
 * 健康探测覆盖）。错误原样回显——含 CORS 特征化文案与 http 部署 WebCrypto
 * 缺失文案（core subtle() 入口，Task 1 疑虑①的覆盖面）。
 * git 分派（spec I Task 2 评审 ①：directConfigOf 注解扩四联合的本文件类型连带——
 * probeWith 同 commit 收宽）：`'owner' in cfg` 收窄出 GithubDirectConfig 转 core
 * probeGithubDirect（独立函数不建 store 实例——免缓存副作用）；`'project' in cfg`
 * 收窄出 GitlabDirectConfig 转 probeGitlabDirect；两平台均只取首页采样（spec §3.3
 * 拍板：GitHub recursive=1 单响应、GitLab per_page=100 不翻页）。四联合 `in` 收窄
 * 下字面传参类型成立（无 as 断言）。S3/DAV 分支零改动（既有探测文案逐字节兼容锚）。
 */
async function probeWith(
  cfg: S3DirectConfig | DavDirectConfig | GithubDirectConfig | GitlabDirectConfig
): Promise<ProbeResult> {
  const started = Date.now();
  try {
    if ('owner' in cfg) {
      const r = await probeGithubDirect(cfg);
      return {
        ok: true,
        entries: r.files,
        sha: r.sha,
        ...(r.truncated ? { truncated: true } : {}),
        ms: Date.now() - started
      };
    }
    if ('project' in cfg) {
      const r = await probeGitlabDirect(cfg);
      return { ok: true, entries: r.files, sha: r.sha, ms: Date.now() - started };
    }
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

/**
 * 测试连接结果回显文案（spec §5：条目数 + 延迟）。git 分支（spec I Task 2）：
 * `sha` 在场 = git 支路产物——`mounts.probe.okGit`（sha 8 位展示）+ truncated
 * 置位时拼接 `mounts.probe.truncated`（GitHub 大仓首响应采样注记——Errata ⑩）；
 * 非 git 分支（sha 缺省）既有 ok 文案**逐字节不变**（s3/dav 兼容锚）。
 */
export function formatProbeResult(r: ProbeResult): string {
  if (!r.ok) return t('mounts.probe.fail', { error: r.error });
  if (r.sha !== undefined) {
    const base = t('mounts.probe.okGit', { entries: r.entries, sha: r.sha.slice(0, 8), ms: r.ms });
    return r.truncated === true ? `${base}${t('mounts.probe.truncated')}` : base;
  }
  return t('mounts.probe.ok', { entries: r.entries, ms: r.ms });
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
