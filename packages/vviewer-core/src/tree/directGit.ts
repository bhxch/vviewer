import type { ByteRange, TreeNode } from '../types';
import { hash8 } from './singleFile';
import { naturalCompare } from './localFiles';
import { normalizeMountPrefix, rawFetch, type DirectStore } from './directS3';

/**
 * directGit.ts — GitHub/GitLab 浏览器直连只读 TreeStore 双工厂（spec I，plan Task 1）。
 * GitHub：trees API recursive 清单 + truncated 逐目录 BFS 分层（corpus
 * fetch-e2e-corpus.mjs listTree/listSource 算法同构；绝不静默截断——目录级
 * truncated 与 BFS 1000 请求上限均 throw 特征化文案）；raw.githubusercontent.com
 * 内容通道（ref 槽取解析后 commit sha——清单/内容同代际，Errata ④）+ 401/403
 * 自动降级 git/blobs API 兜底（Errata ①：contents API 对 >1MB 文件默认 media type
 * 返回 content:''+encoding:'none' 不成立，git/blobs 无该缺陷且 blob sha 清单在手
 * 零额外寻址）。
 * GitLab：repository/tree 递归分页（per_page=100 顺序拉——Link rel=next follow、
 * Link 不可读退化 page 参数顺序走页，禁 offset 深分页并发；2 万条目上限 throw
 * 截断文案）+ repository/files/:path/raw API 端点内容通道（网页版 /-/raw/ 无
 * CORS——反目标，恒走 API 端点）。
 * storeId：`githubdirect:<hash8>` / `gitlabdirect:<hash8>`——hash 输入=挂载目标
 * 身份，不含 token/credentialKey/label（轮换不换 id——快照恢复红线，单测硬断言；
 * s3DirectStoreId 同口径 directS3.ts:506-509）。gitlab host 归一（trim→无 scheme
 * 补 https→剥尾 /）单源钉在 gitlabHostNormalize（Errata ⑨）：storeId 与工厂/probe
 * 同函数消费——「draftToDirectRecord 存原文 host」与「store.id 按归一后 host」恒
 * 同 id（storeId 即记录 id 机制 → AppShell 恢复链 directById 查表不 miss）。
 * 分层：store 实现居 core、凭据经参数传入、零 IndexedDB/i18n 依赖（错误文案注入缝
 * setter 模式镜像 directS3.ts:74-166——apps/web 装配注入，缺省英文供包内独立消费）；
 * 持久化在 apps/web mountsSync（DirectMountRecord + GitCredentialRecord）。
 * 直连只读：listChildren/read；watch 恒不支持（立即 onError 降级通知，directS3
 * 同款）；rangeCapable 恒 false（raw 域 Range 上游契约不保证——spec §6 裁量落定
 * 不开启，v1 全量切片通道）。
 * CORS：GitHub api.github.com + raw.githubusercontent.com 恒 ACAO*；GitLab.com
 * API 端点 ACAO*；自建实例失败走 TypeError 特征化文案（不提示代理通道）。
 * 限速预算注记：GitHub token 缺省 60 req/h（测试连接/清单/内容请求全计）；token
 * 在场 5000 req/h——raw 域命中不计 API 限速，401/403 兜底 blobs 命中比例不放大
 * 预算（见 read 内注）。GitLab 匿名限速按实例配置，429/403 特征化提示。
 */

/** GitHub 直连配置（spec §3.1；凭据明文传参——分层口径见模块注）。 */
export interface GithubDirectConfig {
  /** 仓库所有者（owner/org）。 */
  owner: string;
  repo: string;
  /** 任意 ref 文本（branch/tag/40 位 commit sha）。 */
  ref: string;
  /** 挂载子目录：空 = 仓根；非空归一 `xxx/`（normalizeMountPrefix 同款）。 */
  prefix?: string;
  /** PAT（Bearer 头）；缺省匿名（GitHub 匿名 60 req/h 限速）。 */
  token?: string;
  /** 目录显示名。 */
  label: string;
}

/** GitLab 直连配置（spec §3.1）。 */
export interface GitlabDirectConfig {
  /** 实例基址（缺省 `https://gitlab.com`；自建域如 `https://gitlab.example.com`；
   *  尾 '/' 容忍、无 scheme 补 https——gitlabHostNormalize 单源归一，Errata ⑨）。 */
  host: string;
  /** 数字 id 或 `group/sub/repo` 全路径（构建期 URI 编码进 /projects/{id} 定位）。 */
  project: string;
  /** 任意 ref 文本（branch/tag/commit）。 */
  ref: string;
  /** 挂载子目录：空 = 项目根；非空归一 `xxx/`。 */
  prefix?: string;
  /** PAT（PRIVATE-TOKEN 头）；缺省匿名。 */
  token?: string;
  /** 目录显示名。 */
  label: string;
}

/** 测试连接探测结果（mountsManager probeWith 消费；files=blob 计数，sha=commit）。 */
export interface GitProbeResult {
  files: number;
  sha: string;
  /** GitHub：recursive 响应 truncated:true 时置位（probe 不 BFS——Errata ⑩ 采样
   *  语义，返回首响应部分计数；截断注记由 UI 文案承接）。GitLab 无上游标记。 */
  truncated?: boolean;
}

// ---------- 常量 ----------

const GITHUB_API = 'https://api.github.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';
/** 错误响应体采样上界（directS3 ERROR_BODY_SNIPPET 同款）。 */
const ERROR_BODY_SNIPPET = 512;
/** GitLab 树清单分页页大小（spec §7-4 顺序拉）。 */
const GITLAB_PER_PAGE = 100;
/** GitLab 树清单条目上限（spec §7-4 数值裁量落定；超出 throw 截断文案——不静默）。 */
const GITLAB_MAX_ENTRIES = 20_000;
/** GitHub truncated BFS 分层的目录请求上限（plan Review Focus 6 数值裁量落定）。 */
const GITHUB_MAX_BFS_REQUESTS = 1000;

// ---------- 错误特征化文案注入缝（12 setter——directS3.ts:74-166 模式逐条镜像：
// 9 缝=评审基线 + 3 缝=截断/超限文案常量升缝（评审 ⑥ minor，装配面 mountsSync
// 12 行 t() 注入——apps/web 恒注入故直连错误面恒走目录 zh 值）：
// 本包保持零 i18n 依赖（依赖方向 apps/web → core 不反转），apps/web 装配时
//（mountsSync.ts）注入目录 getter——错误抛出时刻现取当下 locale。缺省英文供包内
// 独立消费。可变态私有、经稳定访问函数导出，避免可变导出面。 ----------

let githubHttpFailedTextImpl: (status: number, detail: string) => string = (status, detail) =>
  `GitHub request failed: HTTP ${status}${detail}`;

/** GitHub HTTP 非 2xx 错误文案（detail 为调用方拼好的附加段——认证提示/notFound
 *  提示/采样体；注入缝消费面同上）。 */
export function githubHttpFailedText(status: number, detail: string): string {
  return githubHttpFailedTextImpl(status, detail);
}

/** 注入 GitHub HTTP 非 2xx 错误文案 getter（apps/web 装配点消费；传 null 恢复缺省）。 */
export function setGithubHttpFailedText(
  getter: ((status: number, detail: string) => string) | null
): void {
  githubHttpFailedTextImpl =
    getter ?? ((status, detail) => `GitHub request failed: HTTP ${status}${detail}`);
}

let gitlabHttpFailedTextImpl: (status: number, detail: string) => string = (status, detail) =>
  `GitLab request failed: HTTP ${status}${detail}`;

/** GitLab HTTP 非 2xx 错误文案（独立缝——davHttpFailedText 同理由：与 GitHub 拆
 *  键避免 zh 串词间空格进 label 拼合；detail 为调用方拼好的附加段）。 */
export function gitlabHttpFailedText(status: number, detail: string): string {
  return gitlabHttpFailedTextImpl(status, detail);
}

/** 注入 GitLab HTTP 非 2xx 错误文案 getter（apps/web 装配点消费；传 null 恢复缺省）。 */
export function setGitlabHttpFailedText(
  getter: ((status: number, detail: string) => string) | null
): void {
  gitlabHttpFailedTextImpl =
    getter ?? ((status, detail) => `GitLab request failed: HTTP ${status}${detail}`);
}

let githubAuthHintTextImpl: () => string = () =>
  ' (authentication failed: check token validity and access scope)';

/** GitHub 401 认证提示文案（注入缝消费面同上）。 */
export function githubAuthHintText(): string {
  return githubAuthHintTextImpl();
}

/** 注入 GitHub 401 认证提示文案 getter（apps/web 装配点消费；传 null 恢复缺省）。 */
export function setGithubAuthHintText(getter: (() => string) | null): void {
  githubAuthHintTextImpl =
    getter ?? (() => ' (authentication failed: check token validity and access scope)');
}

let gitlabAuthHintTextImpl: () => string = () =>
  ' (authentication failed: check token validity and access scope)';

/** GitLab 401 认证提示文案（注入缝消费面同上）。 */
export function gitlabAuthHintText(): string {
  return gitlabAuthHintTextImpl();
}

/** 注入 GitLab 401 认证提示文案 getter（apps/web 装配点消费；传 null 恢复缺省）。 */
export function setGitlabAuthHintText(getter: (() => string) | null): void {
  gitlabAuthHintTextImpl =
    getter ?? (() => ' (authentication failed: check token validity and access scope)');
}

let gitNotFoundHintTextImpl: () => string = () =>
  ' (repo, ref or path not found: check owner/repo/ref/prefix)';

/** 404 共用提示文案（双平台共用单缝——mounts.err.gitNotFound 单键注入）。 */
export function gitNotFoundHintText(): string {
  return gitNotFoundHintTextImpl();
}

/** 注入 404 共用提示文案 getter（apps/web 装配点消费；传 null 恢复缺省）。 */
export function setGitNotFoundHintText(getter: (() => string) | null): void {
  gitNotFoundHintTextImpl =
    getter ?? (() => ' (repo, ref or path not found: check owner/repo/ref/prefix)');
}

let githubRateLimitTextImpl: () => string = () =>
  'GitHub API rate limit exceeded: quota used up (anonymous 60 req/h; 5000 req/h with a PAT), configure a token and retry';

/** GitHub 限速特征化文案（429 / 403+x-ratelimit-remaining:0；匿名限速不提供
 *  无限速保护——spec 反目标，提示即可）。 */
export function githubRateLimitText(): string {
  return githubRateLimitTextImpl();
}

/** 注入 GitHub 限速文案 getter（apps/web 装配点消费；传 null 恢复缺省）。 */
export function setGithubRateLimitText(getter: (() => string) | null): void {
  githubRateLimitTextImpl =
    getter ??
    (() =>
      'GitHub API rate limit exceeded: quota used up (anonymous 60 req/h; 5000 req/h with a PAT), configure a token and retry');
}

let gitlabRateLimitTextImpl: () => string = () =>
  'GitLab request rate limited: retry later or configure a token';

/** GitLab 限速特征化文案（429 / 403 限速形态；多 token 轮询反目标——提示换 token）。 */
export function gitlabRateLimitText(): string {
  return gitlabRateLimitTextImpl();
}

/** 注入 GitLab 限速文案 getter（apps/web 装配点消费；传 null 恢复缺省）。 */
export function setGitlabRateLimitText(getter: (() => string) | null): void {
  gitlabRateLimitTextImpl =
    getter ?? (() => 'GitLab request rate limited: retry later or configure a token');
}

let githubCorsFailureTextImpl: () => string = () =>
  'GitHub direct mount failed: network unreachable (api.github.com always supports CORS)';

/** GitHub CORS/网络层失败特征化文案（rawFetch TypeError 注入面）。 */
export function githubCorsFailureText(): string {
  return githubCorsFailureTextImpl();
}

/** 注入 GitHub CORS 文案 getter（apps/web 装配点消费；传 null 恢复缺省）。 */
export function setGithubCorsFailureText(getter: (() => string) | null): void {
  githubCorsFailureTextImpl =
    getter ??
    (() => 'GitHub direct mount failed: network unreachable (api.github.com always supports CORS)');
}

let gitlabCorsFailureTextImpl: () => string = () =>
  'GitLab direct mount failed: instance CORS not configured or network unreachable (self-hosted instance requires the admin to allow this origin and the GET method)';

/** GitLab CORS/网络层失败特征化文案（自建实例需管理员放行——不提示代理通道）。 */
export function gitlabCorsFailureText(): string {
  return gitlabCorsFailureTextImpl();
}

/** 注入 GitLab CORS 文案 getter（apps/web 装配点消费；传 null 恢复缺省）。 */
export function setGitlabCorsFailureText(getter: (() => string) | null): void {
  gitlabCorsFailureTextImpl =
    getter ??
    (() =>
      'GitLab direct mount failed: instance CORS not configured or network unreachable (self-hosted instance requires the admin to allow this origin and the GET method)');
}

let githubDirTruncatedTextImpl: () => string = () =>
  'GitHub tree listing incomplete: directory-level truncated (listing cut off, cannot continue)';

/** GitHub 目录级 truncated 特征化文案（评审 minor ⑥ 修复：常量升注入缝——双语面
 *  与同模块 9 缝对齐；FileTree SUSP-07 状态栏呈现；corpus「绝不静默截断」纪律——
 *  下钻中间树与 BFS 目录级同语义，目录名动态段剥离统一双调用点形态）。 */
export function githubDirTruncatedText(): string {
  return githubDirTruncatedTextImpl();
}

/** 注入 GitHub 目录级 truncated 文案 getter（apps/web 装配点消费；传 null 恢复缺省）。 */
export function setGithubDirTruncatedText(getter: (() => string) | null): void {
  githubDirTruncatedTextImpl =
    getter ??
    (() =>
      'GitHub tree listing incomplete: directory-level truncated (listing cut off, cannot continue)');
}

let githubBfsLimitTextImpl: () => string = () =>
  `GitHub tree listing incomplete: BFS directory requests exceeded ${GITHUB_MAX_BFS_REQUESTS} (listing cut off, cannot continue)`;

/** GitHub BFS 请求超限特征化文案（评审 minor ⑥ 修复：常量升注入缝）。 */
export function githubBfsLimitText(): string {
  return githubBfsLimitTextImpl();
}

/** 注入 GitHub BFS 超限文案 getter（apps/web 装配点消费；传 null 恢复缺省）。 */
export function setGithubBfsLimitText(getter: (() => string) | null): void {
  githubBfsLimitTextImpl =
    getter ??
    (() =>
      `GitHub tree listing incomplete: BFS directory requests exceeded ${GITHUB_MAX_BFS_REQUESTS} (listing cut off, cannot continue)`);
}

let gitlabTruncatedTextImpl: () => string = () =>
  `GitLab tree listing exceeds ${GITLAB_MAX_ENTRIES} entries (listing cut off, cannot continue)`;

/** GitLab 树清单条目超限特征化文案（评审 minor ⑥ 修复：常量升注入缝）。 */
export function gitlabTruncatedText(): string {
  return gitlabTruncatedTextImpl();
}

/** 注入 GitLab 超限文案 getter（apps/web 装配点消费；传 null 恢复缺省）。 */
export function setGitlabTruncatedText(getter: (() => string) | null): void {
  gitlabTruncatedTextImpl =
    getter ??
    (() =>
      `GitLab tree listing exceeds ${GITLAB_MAX_ENTRIES} entries (listing cut off, cannot continue)`);
}

// ---------- 归一与 storeId ----------

/**
 * gitlab host 归一（Errata ⑨ 单源，模块内私有）：trim → 无 scheme 补 `https://`
 * → 剥尾 '/'。gitlab host 属「无 scheme 补 https、尾 / 容忍」的宽容输入（与 s3
 * endpoint 必填 scheme 不同权）；gitlabDirectStoreId 与 createGitlabDirectStore/
 * probeGitlabDirect 同函数消费——三形态输入（`gitlab.example.com` /
 * `https://gitlab.example.com` / `https://gitlab.example.com/`）恒同 id、恒同
 * 请求基址（「storeId 即记录 id」恢复链查表不 miss）。
 */
function gitlabHostNormalize(host: string): string {
  const trimmed = host.trim();
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

/**
 * 直连 storeId：`githubdirect:<hash8(config)>`（hash8 与既有 storeId hash 同函数）。
 * 入参 = 挂载目标身份（owner/repo/ref/prefix），**不含 token/credentialKey/label**
 * （凭据轮换/改名不换 id——快照恢复红线；Pick 类型约束使凭据类型上进不了 hash
 * 输入，Review Focus 1；s3DirectStoreId 同口径 directS3.ts:506-509）。
 */
export function githubDirectStoreId(
  cfg: Pick<GithubDirectConfig, 'owner' | 'repo' | 'ref' | 'prefix'>
): string {
  const identity = [
    'github',
    cfg.owner.trim(),
    cfg.repo.trim(),
    cfg.ref.trim(),
    normalizeMountPrefix(cfg.prefix)
  ].join('\u{1f}');
  return `githubdirect:${hash8(identity)}`;
}

/**
 * 直连 storeId：`gitlabdirect:<hash8(config)>`——身份 = host（**归一后**，
 * gitlabHostNormalize 在 hash 输入内单源完成——Errata ⑨）/project/ref/prefix，
 * 不含 token/credentialKey/label（红线同上）。
 */
export function gitlabDirectStoreId(
  cfg: Pick<GitlabDirectConfig, 'host' | 'project' | 'ref' | 'prefix'>
): string {
  const identity = [
    'gitlab',
    gitlabHostNormalize(cfg.host),
    cfg.project.trim(),
    cfg.ref.trim(),
    normalizeMountPrefix(cfg.prefix)
  ].join('\u{1f}');
  return `gitlabdirect:${hash8(identity)}`;
}

// ---------- 共享判定与请求通道（双工厂 + probe 共用；Task 1 Step 3 起） ----------

/** 40 位 hex commit sha（ref 直用形态——零解析请求，验收锚 ②）。 */
function isHex40(s: string): boolean {
  return /^[0-9a-f]{40}$/i.test(s);
}

/** 错误响应体采样（≤512 字符——directS3 ensureOk 同款；体不可读只用状态码）。 */
async function errorSnippet(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, ERROR_BODY_SNIPPET);
  } catch {
    return '';
  }
}

/**
 * git API 非 2xx 特征化判定（directS3 ensureOk 语义 + git 错误族）：限速优先
 *（429，或 403 且 x-ratelimit-remaining===0——GitHub 匿名 60/h 形态）→ 401 →
 * authHint → 404 → 共用 notFoundHint → 其余 httpFailed + 采样体 ≤512 字符。
 */
async function ensureGitOk(res: Response, platform: 'github' | 'gitlab'): Promise<void> {
  if (res.status >= 200 && res.status < 300) return;
  const rateLimited =
    res.status === 429 ||
    (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
  if (rateLimited) {
    throw new Error(platform === 'github' ? githubRateLimitText() : gitlabRateLimitText());
  }
  const failed = platform === 'github' ? githubHttpFailedText : gitlabHttpFailedText;
  if (res.status === 401) {
    throw new Error(
      failed(res.status, platform === 'github' ? githubAuthHintText() : gitlabAuthHintText())
    );
  }
  if (res.status === 404) {
    throw new Error(failed(res.status, gitNotFoundHintText()));
  }
  const snippet = await errorSnippet(res);
  throw new Error(failed(res.status, snippet !== '' ? ` ${snippet}` : ''));
}

/** GitHub 请求头：PAT 走 Bearer（raw 域同样接受）/ 匿名空（spec §3.1）。 */
function githubHeaders(token: string): Record<string, string> {
  return token === '' ? {} : { authorization: `Bearer ${token}` };
}

/** GitLab 请求头：PAT 走 PRIVATE-TOKEN（spec §3.1）/ 匿名空。 */
function gitlabHeaders(token: string): Record<string, string> {
  return token === '' ? {} : { 'PRIVATE-TOKEN': token };
}

/** GitHub trees API 条目（raw 形态子集；path/type/sha 供清单消费）。 */
interface GithubTreeItem {
  path?: string;
  type?: string;
  sha?: string;
  size?: number;
}

interface GithubTreeResponse {
  sha?: string;
  truncated?: boolean;
  tree?: GithubTreeItem[];
}

/** GitHub commits API 响应（ref 解析消费 .sha）。 */
interface GithubCommitResponse {
  sha?: string;
}

// ---------- GitLab 共享通道 ----------

/** GitLab tree API 条目（raw 形态子集；'blob'/'tree'/'commit'）。 */
interface GitlabTreeItem {
  id?: string;
  name?: string;
  type?: string;
  path?: string;
}

/** GitLab projects API 响应（定位消费数字 id）。 */
interface GitlabProjectResponse {
  id?: number;
}

/** GitLab commits API 响应（probe 消费 commit id）。 */
interface GitlabCommitResponse {
  id?: string;
}

/**
 * GitLab tree API URL 构建：`/repository/tree?ref=..&recursive=true&per_page=100`
 *（prefix 非空加 path=prefix 去尾/——§6-4 清单层下钻；page 参数仅退化路径用——
 * Link rel=next 在场时直接 follow 完整 URL）。
 */
function gitlabTreeUrl(
  host: string,
  pid: number,
  ref: string,
  mountPrefix: string,
  page?: number
): string {
  const pairs: Array<[string, string]> = [
    ['ref', ref],
    ['recursive', 'true'],
    ['per_page', String(GITLAB_PER_PAGE)]
  ];
  if (mountPrefix !== '') pairs.push(['path', mountPrefix.replace(/\/+$/, '')]);
  if (page !== undefined) pairs.push(['page', String(page)]);
  return `${host}/api/v4/projects/${pid}/repository/tree?${pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')}`;
}

/**
 * GitLab 项目定位：`GET /api/v4/projects/{encodeURIComponent(project)}`——路径
 * 形态 %2F 编码、数字 id 原样（encodeURIComponent 对数字串恒等）。取数字 id。
 */
async function gitlabResolveProjectId(
  host: string,
  project: string,
  token: string,
  signal?: AbortSignal
): Promise<number> {
  const res = await rawFetch(
    `${host}/api/v4/projects/${encodeURIComponent(project)}`,
    { headers: gitlabHeaders(token), signal },
    gitlabCorsFailureText()
  );
  await ensureGitOk(res, 'gitlab');
  const data = (await res.json()) as GitlabProjectResponse;
  if (typeof data.id !== 'number') {
    throw new Error(`GitLab 项目响应缺少数字 id（project=${project}）`);
  }
  return data.id;
}

/**
 * Link 头 rel=next 解析：`<url>; rel="next"` 形态（引号容忍）；多段逗号分隔串内
 * 滑动定位 next 段（GitLab 恒发绝对 URL——顺序 follow 用）。头不可读（CORS 未
 * Expose）返回 null——调用方退化 page 参数顺序走页（§7-4）。
 */
function parseLinkNext(header: string | null): string | null {
  if (header === null || header === '') return null;
  const m = /<([^>]*)>\s*;\s*rel="?next"?(?=[,;\s]|$)/i.exec(header);
  return m !== null ? (m[1] ?? null) : null;
}

/**
 * 清单条目（内部形态）：path 恒仓库相对（下钻回补/归一保证，切片统一剥
 * mountPrefix）；sha 供 read 兜底 blobs 消费（Errata ①——blob sha 清单在手）。
 */
interface GitManifestEntry {
  path: string;
  sha: string;
  size?: number;
}

/**
 * GitHub commits API ref 解析：40 位 sha 直用（零请求）；否则 `GET /repos/{o}/{r}/
 * commits/{ref}` 取 .sha（branch/tag → commit sha）。
 */
async function githubResolveRef(
  owner: string,
  repo: string,
  ref: string,
  token: string,
  signal?: AbortSignal
): Promise<string> {
  if (isHex40(ref)) return ref;
  const res = await rawFetch(
    `${GITHUB_API}/repos/${owner}/${repo}/commits/${ref}`,
    { headers: githubHeaders(token), signal },
    githubCorsFailureText()
  );
  await ensureGitOk(res, 'github');
  const data = (await res.json()) as GithubCommitResponse;
  const sha = typeof data.sha === 'string' ? data.sha : '';
  if (sha === '') {
    throw new Error(`GitHub commits API 响应缺少 sha（ref=${ref}）`);
  }
  return sha;
}

/** GitHub git/trees 请求（recursive 可选；cors 特征化走 githubCorsFailureText）。 */
async function githubFetchTree(
  owner: string,
  repo: string,
  treeSha: string,
  recursive: boolean,
  token: string,
  signal?: AbortSignal
): Promise<GithubTreeResponse> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${treeSha}${
    recursive ? '?recursive=1' : ''
  }`;
  const res = await rawFetch(
    url,
    { headers: githubHeaders(token), signal },
    githubCorsFailureText()
  );
  await ensureGitOk(res, 'github');
  return (await res.json()) as GithubTreeResponse;
}

/** GitHub 404 合成文案（下钻段缺失/非 tree/清单无该 path——语义 404 与真实
 *  HTTP 404 同串，单缝注入）。 */
function githubNotFoundText(): string {
  return githubHttpFailedText(404, gitNotFoundHintText());
}

/**
 * prefix 下钻（清单层，§6-4 落定；corpus listSource :246-273 算法同构）：prefix
 * 非空逐段取子树 sha（`GET /git/trees/{sha}` 非递归找 entry）；段缺失/非 tree →
 * throw notFound 文案；中间树 truncated → throw 截断文案（corpus fatal 同语义
 * ——前缀解析不可靠即停）。返回子树 sha（prefix 空时原样）。
 */
async function githubDrillSubtree(
  owner: string,
  repo: string,
  commitSha: string,
  mountPrefix: string,
  token: string,
  signal?: AbortSignal
): Promise<string> {
  if (mountPrefix === '') return commitSha;
  let sha = commitSha;
  for (const seg of mountPrefix.replace(/\/+$/, '').split('/')) {
    const t = await githubFetchTree(owner, repo, sha, false, token, signal);
    if (t.truncated === true) {
      throw new Error(githubDirTruncatedText());
    }
    const entry = (t.tree ?? []).find((e) => e.path === seg);
    if (entry === undefined || entry.type !== 'tree' || typeof entry.sha !== 'string') {
      throw new Error(githubNotFoundText());
    }
    sha = entry.sha;
  }
  return sha;
}

/**
 * truncated recursive → BFS 逐目录展开（corpus listTree :216-239 算法同构）：
 * queue[{sha,dir}] 非递归请求、目录级 truncated throw（绝不静默截断——Review
 * Focus 6）、blob 收集并回补 mountPrefix（子树相对 → 仓库相对）；BFS 目录请求
 * 超 1000 上限 throw 超限文案。'commit'（submodule）条目跳过——反目标：无递归面。
 */
async function githubBfsCollect(
  owner: string,
  repo: string,
  subtreeSha: string,
  mountPrefix: string,
  token: string,
  signal?: AbortSignal
): Promise<GitManifestEntry[]> {
  const blobs: GitManifestEntry[] = [];
  const queue: Array<{ sha: string; dir: string }> = [{ sha: subtreeSha, dir: '' }];
  let requests = 0;
  while (queue.length > 0) {
    const { sha, dir } = queue.shift() as { sha: string; dir: string };
    requests += 1;
    if (requests > GITHUB_MAX_BFS_REQUESTS) {
      throw new Error(githubBfsLimitText());
    }
    const t = await githubFetchTree(owner, repo, sha, false, token, signal);
    if (t.truncated === true) {
      throw new Error(
        githubDirTruncatedText()
      );
    }
    for (const e of t.tree ?? []) {
      if (typeof e.path !== 'string') continue;
      const p = dir === '' ? e.path : `${dir}/${e.path}`;
      if (e.type === 'blob') {
        if (typeof e.sha !== 'string') continue;
        blobs.push({
          path: `${mountPrefix}${p}`,
          sha: e.sha,
          ...(typeof e.size === 'number' ? { size: e.size } : {})
        });
      } else if (e.type === 'tree' && typeof e.sha === 'string') {
        queue.push({ sha: e.sha, dir: p });
      }
    }
  }
  return blobs;
}

/**
 * GitHub recursive 清单归一：blob 条目收集、path 回补 mountPrefix（prefix 空时
 * 原样=仓库相对）、'commit'（submodule）跳过、size 来自 tree 条目。
 */
function githubNormalizeRecursive(
  items: GithubTreeItem[],
  mountPrefix: string
): GitManifestEntry[] {
  const out: GitManifestEntry[] = [];
  for (const e of items) {
    if (e.type !== 'blob' || typeof e.path !== 'string' || typeof e.sha !== 'string') continue;
    out.push({
      path: `${mountPrefix}${e.path}`,
      sha: e.sha,
      ...(typeof e.size === 'number' ? { size: e.size } : {})
    });
  }
  return out;
}

/**
 * 清单切片（双平台共用）：清单条目（仓库相对 path）按挂载相对 path 切片——直接
 * 子目录=去重下一段、文件=直接命中；目录优先 + naturalCompare 排序（directS3.ts:
 * 690-692 呈现序同款）。子目录 listChildren 恒纯内存零请求。
 */
function sliceManifestChildren(
  entries: GitManifestEntry[],
  mountPrefix: string,
  path: string
): TreeNode[] {
  const rel = path.replace(/^\/+|\/+$/g, '');
  const pre = rel === '' ? '' : `${rel}/`;
  const dirs = new Map<string, string>();
  const files: TreeNode[] = [];
  for (const e of entries) {
    // 仓库相对 → 挂载相对（清单条目恒以 mountPrefix 开头——下钻回补/归一保证）
    const mrel = e.path.startsWith(mountPrefix) ? e.path.slice(mountPrefix.length) : e.path;
    if (mrel === '' || !mrel.startsWith(pre)) continue;
    const rest = mrel.slice(pre.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.slice(0, slash);
    const nodePath = rel === '' ? name : `${rel}/${name}`;
    if (slash < 0) {
      files.push({
        name,
        path: nodePath,
        kind: 'file',
        ...(e.size !== undefined ? { size: e.size } : {})
      });
    } else if (!dirs.has(name)) {
      dirs.set(name, nodePath);
    }
  }
  const nodes: TreeNode[] = files;
  for (const [name, childPath] of dirs) {
    nodes.push({ name, path: childPath, kind: 'dir' });
  }
  return nodes.sort((a, b) =>
    a.kind === b.kind ? naturalCompare(a.name, b.name) : a.kind === 'dir' ? -1 : 1
  );
}

// ---------- store 工厂与 probe ----------

export function createGithubDirectStore(cfg: GithubDirectConfig): DirectStore {
  const owner = cfg.owner.trim();
  const repo = cfg.repo.trim();
  const ref = cfg.ref.trim();
  const mountPrefix = normalizeMountPrefix(cfg.prefix);
  const token = cfg.token ?? '';
  const id = githubDirectStoreId(cfg);

  /** ref → commit sha 缓存（同一次清单周期内不重复解析；branch 型 ref 由根
   *  listChildren 强制重解析覆盖，read/兜底路径走缓存命中）。 */
  const refShaCache = new Map<string, string>();
  /** 清单缓存：键 `${ref}\u001f${sha}`（branch 移动 → 新 sha → 新代际；sha 命中
   *  零请求复用——Architecture 拍板）。 */
  const manifestCache = new Map<string, GitManifestEntry[]>();
  /** 当前代际清单（子目录切片/read 兜底消费；根 listChildren 刷新）。 */
  let currentManifest: GitManifestEntry[] | null = null;

  /**
   * 清单获取：prefix 下钻 → recursive=1；truncated → BFS 全量分层（绝不静默
   * 截断——目录级 truncated/BFS 上限均 throw，Review Focus 6）。
   */
  async function fetchManifest(commitSha: string, signal?: AbortSignal): Promise<GitManifestEntry[]> {
    const subtreeSha = await githubDrillSubtree(owner, repo, commitSha, mountPrefix, token, signal);
    const data = await githubFetchTree(owner, repo, subtreeSha, true, token, signal);
    if (data.truncated === true) {
      return githubBfsCollect(owner, repo, subtreeSha, mountPrefix, token, signal);
    }
    return githubNormalizeRecursive(data.tree ?? [], mountPrefix);
  }

  /** ref 解析（缓存命中面）：read/兜底 blobs 消费——不强制重解析。 */
  async function resolveRefCached(signal?: AbortSignal): Promise<string> {
    const hit = refShaCache.get(ref);
    if (hit !== undefined) return hit;
    const sha = await githubResolveRef(owner, repo, ref, token, signal);
    refShaCache.set(ref, sha);
    return sha;
  }

  /** ref 解析（强制重解析面）：根 listChildren 消费——branch 跟踪（重解析语义，
   *  解析后写缓存供 read 复用；40 位 sha ref 零请求）。 */
  async function resolveRefFresh(): Promise<string> {
    const sha = await githubResolveRef(owner, repo, ref, token);
    refShaCache.set(ref, sha);
    return sha;
  }

  return {
    id,
    displayName: () => cfg.label,
    async listChildren(path: string): Promise<TreeNode[]> {
      const rel = path.replace(/^\/+|\/+$/g, '');
      if (rel === '') {
        // 根 listChildren 恒重解析（branch 跟踪——commits API 现取；40 位 sha
        // ref 零请求）；清单缓存键 `${ref}\u001f${sha}` 命中零请求复用
        const sha = await resolveRefFresh();
        const key = `${ref}\u001f${sha}`;
        let manifest = manifestCache.get(key);
        if (manifest === undefined) {
          manifest = await fetchManifest(sha);
          manifestCache.set(key, manifest);
        }
        currentManifest = manifest;
        return sliceManifestChildren(manifest, mountPrefix, '');
      }
      // 子目录：纯内存切片（防御路径——未过根调用直接取子目录时现拉一次）
      if (currentManifest === null) {
        const sha = await resolveRefCached();
        const key = `${ref}\u001f${sha}`;
        const cached = manifestCache.get(key);
        currentManifest = cached ?? (await fetchManifest(sha));
        if (cached === undefined) manifestCache.set(key, currentManifest);
      }
      return sliceManifestChildren(currentManifest, mountPrefix, rel);
    },
    async read(path: string, readOpts?: { range?: ByteRange; signal?: AbortSignal }) {
      const rel = path.replace(/^\/+|\/+$/g, '');
      if (rel === '') throw new Error(`github: empty path（${path}）`);
      const sha = await resolveRefCached(readOpts?.signal);
      // 内容通道只服务清单代际（快照一致性）：blob sha 取自清单，清单未拉则现拉
      //（signal 透传——read 契约「destroy 时取消在飞读」覆盖惰性清单面，评审
      // minor ② 修复：truncated 大仓 BFS 至多 1000 请求可取消）
      if (currentManifest === null) {
        const key = `${ref}\u001f${sha}`;
        const cached = manifestCache.get(key);
        currentManifest = cached ?? (await fetchManifest(sha, readOpts?.signal));
        if (cached === undefined) manifestCache.set(key, currentManifest);
      }
      const repoPath = `${mountPrefix}${rel}`;
      const entry = currentManifest.find((e) => e.path === repoPath);
      if (entry === undefined) {
        throw new Error(githubNotFoundText());
      }
      // raw 优先：ref 槽取解析后 sha（清单/内容同代际，Errata ④）；path 逐段
      // encodeURIComponent（corpus fetchRaw :177 同款——'#'/空格不改 URL 语义）
      const rawUrl = `${GITHUB_RAW}/${owner}/${repo}/${sha}/${repoPath
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`;
      const res = await rawFetch(
        rawUrl,
        { headers: githubHeaders(token), signal: readOpts?.signal },
        githubCorsFailureText()
      );
      // raw 响应判定：限速优先（429 / 403+remaining:0——限速下兜底无意义）→
      // 401/403/404 全走 blobs 兜底 → 其余 ensureGitOk。404 进兜底（评审 important
      // 修复）：path 存在性已由清单保证（read 前置 find）——raw 404 = 权限伪装/
      // 异常面（fine-grained PAT 缺 raw 权限时私有仓 raw 回 404 与匿名同形态，
      // spec §7-1 真网实测实锤）而非「真不存在」，notFound 直抛会使私有仓每读必
      // 误导且兜底永不触发；blobs（api.github.com Bearer 标准契约）探测失败
      //（含 404）由 ensureGitOk 落 notFound 收敛。
      if (
        res.status === 429 ||
        (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')
      ) {
        throw new Error(githubRateLimitText());
      }
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        // 兜底 git/blobs（Bearer 标准契约；blob sha 清单在手零额外寻址）：
        // raw 命中不计 API 限速，兜底为认证异常少数面——命中比例不放大预算。
        const bres = await rawFetch(
          `${GITHUB_API}/repos/${owner}/${repo}/git/blobs/${entry.sha}`,
          { headers: githubHeaders(token), signal: readOpts?.signal },
          githubCorsFailureText()
        );
        await ensureGitOk(bres, 'github');
        const data = (await bres.json()) as { content?: unknown };
        const b64 = typeof data.content === 'string' ? data.content.replace(/\s+/g, '') : '';
        return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      }
      await ensureGitOk(res, 'github');
      return new Uint8Array(await res.arrayBuffer());
    },
    get rangeCapable() {
      return false; // spec §6 裁量落定：v1 全量切片通道（raw 域 Range 契约不保证）
    },
    watch(listener: (paths: string[]) => void, onError?: () => void): () => void {
      void listener;
      onError?.();
      return () => {};
    }
  };
}

export function createGitlabDirectStore(cfg: GitlabDirectConfig): DirectStore {
  const host = gitlabHostNormalize(cfg.host);
  const project = cfg.project.trim();
  const ref = cfg.ref.trim();
  const mountPrefix = normalizeMountPrefix(cfg.prefix);
  const token = cfg.token ?? '';
  const id = gitlabDirectStoreId(cfg);

  /** 项目数字 id（一次解析缓存——两次根 listChildren 恰 1 次 /projects 请求）。 */
  let projectId: number | null = null;
  /** 清单缓存：键=ref 文本（上游无树 sha 可锚——branch 移动探测不做，Errata ⑤；
   *  重拉覆盖同键）。 */
  const manifestByRef = new Map<string, GitManifestEntry[]>();
  /** 当前代际清单（子目录切片消费）。 */
  let currentManifest: GitManifestEntry[] | null = null;

  function resolveProjectId(signal?: AbortSignal): Promise<number> {
    if (projectId !== null) return Promise.resolve(projectId);
    return gitlabResolveProjectId(host, project, token, signal).then((pid) => {
      projectId = pid;
      return pid;
    });
  }

  /**
   * 树清单全量分页（§7-4：per_page=100 顺序拉 + 2 万条目上限）：Link rel=next
   * 顺序 follow（禁 offset 深分页并发）；Link 头不可读退化 page 参数顺序走页
   * 直到短页（同顺序语义）；上限 throw 截断文案（绝不静默截断——corpus 纪律）。
   * 条目 'blob' 收集（'tree' 供切片推导——目录由 blob path 推导、'commit' 跳过
   * =submodule 非目标）。
   */
  async function loadManifest(signal?: AbortSignal): Promise<GitManifestEntry[]> {
    const pid = await resolveProjectId(signal);
    const entries: GitManifestEntry[] = [];
    /** 已处理条目总数（blob + tree）——上限判定口径（2 万条目上限按条目数计）。 */
    let seenEntries = 0;
    let url = gitlabTreeUrl(host, pid, ref, mountPrefix);
    for (let page = 1; ; page += 1) {
      const res = await rawFetch(
        url,
        { headers: gitlabHeaders(token), signal },
        gitlabCorsFailureText()
      );
      await ensureGitOk(res, 'gitlab');
      const batch = (await res.json()) as GitlabTreeItem[];
      if (!Array.isArray(batch)) {
        throw new Error('GitLab tree API 响应非数组');
      }
      for (const e of batch) {
        // 上限按**条目总数**计（blob + tree）——评审 minor：此前只计 blob，tree 条目
        // 被 skip 不计 → 实际拉取条目数可远超 2 万（保护意图偏差）。计数在类型过滤
        // 之前（tree 条目亦计入）。
        seenEntries += 1;
        if (e.type !== 'blob' || typeof e.path !== 'string') continue;
        // 归一为仓库相对：GitLab 带 path 参数的条目 path 两实现形态并存（相对
        // prefix / 仓库相对全路径）——startsWith 剥前缀 / 原样回补两形态兼容
        const p = e.path.startsWith(mountPrefix) ? e.path.slice(mountPrefix.length) : e.path;
        entries.push({
          path: `${mountPrefix}${p}`,
          sha: typeof e.id === 'string' ? e.id : ''
        });
      }
      const next = parseLinkNext(res.headers.get('link'));
      const hasMore = next !== null || batch.length === GITLAB_PER_PAGE;
      if (!hasMore) break;
      if (seenEntries >= GITLAB_MAX_ENTRIES) {
        throw new Error(gitlabTruncatedText());
      }
      url = next ?? gitlabTreeUrl(host, pid, ref, mountPrefix, page + 1);
    }
    return entries;
  }

  return {
    id,
    displayName: () => cfg.label,
    async listChildren(path: string): Promise<TreeNode[]> {
      const rel = path.replace(/^\/+|\/+$/g, '');
      if (rel === '') {
        // 根 listChildren 直接重拉（Architecture：GitLab 无 commits 解析廉价探测
        // 面——重拉即刷新，branch 移动可见；Errata ④ 一致性注记见模块注释）
        const entries = await loadManifest();
        manifestByRef.set(ref, entries);
        currentManifest = entries;
        return sliceManifestChildren(entries, mountPrefix, '');
      }
      // 子目录：纯内存切片（防御路径——未过根调用直接取子目录时现拉一次）
      if (currentManifest === null) {
        const cached = manifestByRef.get(ref);
        currentManifest = cached ?? (await loadManifest());
        manifestByRef.set(ref, currentManifest);
      }
      return sliceManifestChildren(currentManifest, mountPrefix, rel);
    },
    async read(path: string, readOpts?: { range?: ByteRange; signal?: AbortSignal }) {
      const rel = path.replace(/^\/+|\/+$/g, '');
      if (rel === '') throw new Error(`gitlab: empty path（${path}）`);
      const pid = await resolveProjectId(readOpts?.signal);
      // API files/raw 端点（网页版 /-/raw/ 无 CORS——反目标，恒走 API 端点）；
      // path 全路径 encodeURIComponent（'/'→%2F——spec §5 路径编码锚）
      const repoPath = `${mountPrefix}${rel}`;
      const url = `${host}/api/v4/projects/${pid}/repository/files/${encodeURIComponent(
        repoPath
      )}/raw?ref=${encodeURIComponent(ref)}`;
      const res = await rawFetch(
        url,
        { headers: gitlabHeaders(token), signal: readOpts?.signal },
        gitlabCorsFailureText()
      );
      await ensureGitOk(res, 'gitlab');
      return new Uint8Array(await res.arrayBuffer());
    },
    get rangeCapable() {
      return false; // spec §6 裁量落定：v1 全量切片通道
    },
    watch(listener: (paths: string[]) => void, onError?: () => void): () => void {
      void listener;
      onError?.();
      return () => {};
    }
  };
}

/**
 * 测试连接探测（mountsManager probeWith 消费——独立函数不建 store 实例，免缓存
 * 副作用；spec §3.3 拍板首页采样）。GitHub：ref 解析 + recursive=1 单响应 blob
 * 计数；**truncated:true 不做 BFS 分层**（Errata ⑩——大仓 BFS 上限 1000 请求对
 * 匿名 60 req/h 是单次探测即爆的面；返回 truncated:true + 首响应部分计数，截断
 * 注记由 UI 文案承接。store 打开路径 listChildren 不受此约束——仍走全量分层，
 * 两路径行为分离为有意设计）。
 */
export async function probeGithubDirect(cfg: GithubDirectConfig): Promise<GitProbeResult> {
  const owner = cfg.owner.trim();
  const repo = cfg.repo.trim();
  const ref = cfg.ref.trim();
  const mountPrefix = normalizeMountPrefix(cfg.prefix);
  const token = cfg.token ?? '';
  const sha = await githubResolveRef(owner, repo, ref, token);
  const subtreeSha = await githubDrillSubtree(owner, repo, sha, mountPrefix, token);
  const data = await githubFetchTree(owner, repo, subtreeSha, true, token);
  const files = (data.tree ?? []).filter((e) => e.type === 'blob').length;
  return data.truncated === true ? { files, sha, truncated: true } : { files, sha };
}

/**
 * 测试连接探测（spec §3.3）：项目解析 + commits/{ref} 取 commit id + tree 首页
 *（per_page=100 不翻页）→ 首页 blob 计数。
 */
export async function probeGitlabDirect(cfg: GitlabDirectConfig): Promise<GitProbeResult> {
  const host = gitlabHostNormalize(cfg.host);
  const project = cfg.project.trim();
  const ref = cfg.ref.trim();
  const mountPrefix = normalizeMountPrefix(cfg.prefix);
  const token = cfg.token ?? '';
  const pid = await gitlabResolveProjectId(host, project, token);
  const commitRes = await rawFetch(
    `${host}/api/v4/projects/${pid}/repository/commits/${encodeURIComponent(ref)}`,
    { headers: gitlabHeaders(token) },
    gitlabCorsFailureText()
  );
  await ensureGitOk(commitRes, 'gitlab');
  const commitData = (await commitRes.json()) as GitlabCommitResponse;
  const sha = typeof commitData.id === 'string' ? commitData.id : '';
  if (sha === '') {
    throw new Error(`GitLab commits API 响应缺少 id（ref=${ref}）`);
  }
  const treeRes = await rawFetch(
    gitlabTreeUrl(host, pid, ref, mountPrefix),
    { headers: gitlabHeaders(token) },
    gitlabCorsFailureText()
  );
  await ensureGitOk(treeRes, 'gitlab');
  const items = (await treeRes.json()) as GitlabTreeItem[];
  const files = Array.isArray(items) ? items.filter((e) => e.type === 'blob').length : 0;
  return { files, sha };
}
