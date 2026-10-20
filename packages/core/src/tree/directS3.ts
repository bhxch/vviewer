import type { ByteRange, TreeStore, TreeNode } from '../types';
import { hash8 } from './singleFile';
import { naturalCompare } from './localFiles';

/**
 * directS3.ts — S3 直连 TreeStore（目录挂载 spec §4 阶段三，plan Task 1）。
 * 浏览器内 SigV4 签名 fetch（WebCrypto SubtleCrypto HMAC-SHA256，零依赖——
 * 异步性由 TreeStore 接口本异步吸收），ListObjectsV2 解析与 GET Range 读同
 * server/storage/src/s3.rs 服务端语义（canonical 化/解析/分页/呈现序逐条对齐，
 * AWS 官方向量双端同值交叉锚）。
 * 分层：store 实现居 core、凭据经参数传入、零 IndexedDB 依赖；持久化在
 * apps/web mountsSync（direct 记录，明文存储+管理页警示面，spec 拍板）。
 * 直连只读：listChildren/read；watch 恒不支持（立即 onError 降级通知）。
 * Range 防线降级（webdav 服务端同款语义）：Range 请求回 200（被无视）时从
 * 全量响应体切出请求窗交付并置 rangeCapable=false——此后 dispatcher 走既有
 * 全量切片通道（!rangeCapable 语义）。
 * CORS：浏览器直连要求 bucket 配 CORS；fetch 网络层失败（TypeError）特征化
 * 为「bucket CORS 未配置或网络不可达」。
 */

/** S3 直连配置（spec §2 挂载字段集；凭据明文传参，见模块注分层说明）。 */
export interface S3DirectConfig {
  /** 服务端点（如 https://s3.us-east-1.amazonaws.com 或 http://127.0.0.1:9000；尾 '/' 容忍）。 */
  endpoint: string;
  bucket: string;
  /** 挂载子路径：空 = 桶根；非空规范化为 `xxx/`（服务端 normalize_prefix 同款）。 */
  prefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** path-style（`{endpoint}/{bucket}`）缺省 true；false = virtual-host（`{bucket}.{host}`）。 */
  pathStyle?: boolean;
  /** 目录显示名。 */
  label: string;
}

/** createS3DirectStore 选项（region 参与 SigV4；缺省 us-east-1——服务端同款口径）。 */
export interface S3DirectOptions {
  region?: string;
}

/** SigV4 凭证（signS3Get 纯函数签名面；Rust S3Credentials 同形）。 */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** signS3Get 选项：amzDate 显式注入以锚定官方向量；缺省取当下。 */
export interface SignS3Options {
  method?: string;
  region?: string;
  service?: string;
  amzDate?: string;
  /** 业务头（Range 等）：名大小写不敏感，签名内统一小写（服务端同款）。 */
  extraHeaders?: Record<string, string>;
}

const DEFAULT_REGION = 'us-east-1';
const SERVICE = 's3';
/** 分页安全阀（服务端 MAX_LIST_PAGES 同款：防御 IsTruncated 恒 true 病态）。 */
const MAX_LIST_PAGES = 1000;
/** 错误响应体采样上界（排障片段；服务端 ERROR_BODY_SNIPPET 同款）。 */
const ERROR_BODY_SNIPPET = 512;
/** 请求超时（RemoteStore.request 30s 同款对齐）。 */
const REQUEST_TIMEOUT_MS = 30_000;

// ---------- WebCrypto 原语（懒取 globalThis.crypto：测试可注入，http 非
// 安全上下文浏览器无 subtle 时报错面收敛在签名入口） ----------

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) {
    throw new Error('WebCrypto 不可用：S3 直连签名需要 HTTPS 或 localhost 环境');
  }
  return s;
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', new TextEncoder().encode(data));
  return hex(new Uint8Array(digest));
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, data as BufferSource));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 当前时刻 x-amz-date（UTC，`YYYYMMDDThhmmssZ`；服务端 amz_date_now 同形）。 */
function amzDateNow(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// ---------- UriEncode（服务端 percent crate 字符集同构：unreserved
// A-Za-z0-9-._~ 之外全编码；key 段额外保留 '/'；大写十六进制） ----------

function encodeQueryValue(s: string): string {
  return uriEncode(s, false);
}

/** 对象 key 路径编码：逐段 UriEncode、'/' 保留为分隔（纯编码不做归一，服务端同口径）。 */
export function encodeKeyPath(key: string): string {
  return uriEncode(key, true);
}

function uriEncode(s: string, keepSlash: boolean): string {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    if (
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      (b >= 0x30 && b <= 0x39) || // 0-9
      b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e || // - . _ ~
      (keepSlash && b === 0x2f)
    ) {
      out += c;
    } else {
      out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** 百分号解码（canonical 化与 dav href 消费用；病态 % 序列原样保留）。 */
export function percentDecode(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------- SigV4 纯函数（服务端 sign_request 的 TS 镜像，官方向量锚定） ----------

/** AWS SigV4 canonical headers 值形态：trim + 内部连续空白折叠为单空格（服务端同款）。 */
function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * canonical URI：path 逐段 decode → UriEncode（'/' 保留为分隔）；空 path → "/"。
 * 对已编码输入幂等（wire URL 与签名走同一编码规则）。
 */
function canonicalUri(path: string): string {
  if (path === '') return '/';
  return path.split('/').map((seg) => uriEncode(percentDecode(seg), true)).join('/');
}

/**
 * canonical query：各对 decode → UriEncode 重编码后按编码名（再按值）排序；
 * 无 '=' 的裸名视为空值（canonical 形态 `name=`）。
 */
function canonicalQuery(query: string): string {
  if (query === '') return '';
  const pairs = query
    .split('&')
    .filter((p) => p !== '')
    .map((pair) => {
      const i = pair.indexOf('=');
      const k = i >= 0 ? pair.slice(0, i) : pair;
      const v = i >= 0 ? pair.slice(i + 1) : '';
      return [encodeQueryValue(percentDecode(k)), encodeQueryValue(percentDecode(v))] as const;
    });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * SigV4 签名（纯函数，AWS 官方向量锚定，与服务端 s3.rs sign_request 同规范）：
 * 返回含 authorization 的请求头表（名全小写，直接作 fetch headers）。
 * 签名头集 host + x-amz-content-sha256 + x-amz-date + 业务头小写化，按名排序
 *（Record 键天然唯一——服务端的同名合并步骤在此输入形态下不可达，略）。
 */
export async function signS3Get(
  url: string,
  creds: S3Credentials,
  opts?: SignS3Options
): Promise<Record<string, string>> {
  const method = opts?.method ?? 'GET';
  const region = opts?.region ?? DEFAULT_REGION;
  const service = opts?.service ?? SERVICE;
  const amzDate = opts?.amzDate ?? amzDateNow();

  // URL 拆解：scheme://authority/path?query（canonical host 含非默认端口）
  const [base, query = ''] = url.split('?') as [string, string?];
  const authorityFull = base.split('://')[1] ?? base;
  const slashAt = authorityFull.indexOf('/');
  const authority = slashAt >= 0 ? authorityFull.slice(0, slashAt) : authorityFull;
  const path = slashAt >= 0 ? authorityFull.slice(slashAt) : '';

  const payloadHash = await sha256Hex('');
  const headers: Array<[string, string]> = [
    ['host', authority],
    ['x-amz-content-sha256', payloadHash],
    ['x-amz-date', amzDate]
  ];
  for (const [name, value] of Object.entries(opts?.extraHeaders ?? {})) {
    const lower = name.toLowerCase();
    const at = headers.findIndex(([k]) => k === lower);
    if (at >= 0) headers.splice(at, 1);
    headers.push([lower, canonicalHeaderValue(value)]);
  }
  headers.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const signed = headers.map(([k]) => k).join(';');
  const canonicalHeaders = headers.map(([k, v]) => `${k}:${v}\n`).join('');
  const canonicalRequest = [
    method,
    canonicalUri(path),
    canonicalQuery(query),
    canonicalHeaders,
    signed,
    payloadHash
  ].join('\n');

  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256Hex(canonicalRequest)}`;

  const enc = new TextEncoder();
  const kDate = await hmacSha256(enc.encode(`AWS4${creds.secretAccessKey}`), enc.encode(date));
  const kRegion = await hmacSha256(kDate, enc.encode(region));
  const kService = await hmacSha256(kRegion, enc.encode(service));
  const kSigning = await hmacSha256(kService, enc.encode('aws4_request'));
  const signature = hex(await hmacSha256(kSigning, enc.encode(stringToSign)));

  const out: Record<string, string> = {};
  for (const [k, v] of headers) out[k] = v;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  return out;
}

// ---------- ListObjectsV2 字面结构解析（服务端 open_tag/blocks/inner 逐条移植；
// 版本耦合口径同服务端——只认 API 2006-03-01 字面标签名，任意命名空间前缀） ----------

/** 在 xml 中寻找开标签 `<[prefix:]local…>`（名后界须为 '>'/' '/'/'，防前缀碰撞）。 */
function openTag(xml: string, local: string): [number, number, string] | null {
  for (let i = 0; i < xml.length; i++) {
    if (xml[i] !== '<') continue;
    const nameStart = i + 1;
    let j = nameStart;
    while (j < xml.length) {
      const c = xml.charCodeAt(j);
      const isNameChar =
        (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
        c === 45 || c === 46 || c === 95 || c === 58; // - . _ :
      if (!isNameChar) break;
      j++;
    }
    if (j >= xml.length) continue;
    const boundary = xml[j];
    if (boundary !== '>' && boundary !== ' ' && boundary !== '/') continue;
    const name = xml.slice(nameStart, j);
    const colon = name.indexOf(':');
    const prefix = colon >= 0 ? name.slice(0, colon + 1) : '';
    if ((colon >= 0 ? name.slice(colon + 1) : name) !== local) continue;
    const gt = xml.indexOf('>', j);
    if (gt < 0) return null;
    return [i, gt + 1, prefix];
  }
  return null;
}

/** 顺序提取所有 `<[p:]local>…</[p:]local>` 块（每块前缀独立识别；截断块终止）。 */
function blocks(xml: string, local: string): string[] {
  const out: string[] = [];
  let rest = xml;
  for (;;) {
    const tag = openTag(rest, local);
    if (tag === null) break;
    const [, end, prefix] = tag;
    const close = `</${prefix}${local}>`;
    const e = rest.indexOf(close, end);
    if (e < 0) break;
    out.push(rest.slice(end, e));
    rest = rest.slice(e + close.length);
  }
  return out;
}

/** 文本内首个 `<[p:]tag>…</[p:]tag>` 内容；自闭合 `<[p:]tag/>` 返回空串。 */
function inner(xml: string, local: string): string | null {
  const tag = openTag(xml, local);
  if (tag === null) return null;
  const [start, end, prefix] = tag;
  if (xml.slice(start, end).endsWith('/>')) return '';
  const close = `</${prefix}${local}>`;
  const e = xml.indexOf(close, end);
  if (e < 0) return null;
  return xml.slice(end, e);
}

/** XML 实体反转义（S3 key 文本域：&amp; &lt; &gt; &quot; &apos; + 数字引用；孤立 '&' 原样）。 */
export function xmlUnescape(s: string): string {
  if (!s.includes('&')) return s;
  let out = '';
  let rest = s;
  for (;;) {
    const i = rest.indexOf('&');
    if (i < 0) break;
    out += rest.slice(0, i);
    const tail = rest.slice(i);
    const semi = tail.indexOf(';');
    let replacement: string | null = null;
    if (semi > 0) {
      const entity = tail.slice(1, semi);
      if (entity.startsWith('#')) {
        const code = /^#x[0-9a-fA-F]+$/i.test(entity)
          ? parseInt(entity.slice(2), 16)
          : /^\d+$/.test(entity.slice(1))
            ? parseInt(entity.slice(1), 10)
            : NaN;
        if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
          try {
            replacement = String.fromCodePoint(code);
          } catch {
            replacement = null;
          }
        }
      } else {
        replacement = ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity] ?? null;
      }
    }
    if (replacement === null) {
      out += '&';
      rest = tail.slice(1);
    } else {
      out += replacement;
      rest = tail.slice(semi + 1);
    }
  }
  return out + rest;
}

/** 整数文本 → number（getcontentlength/Size 消费共用；非有限数 → undefined）。 */
export function optInt(s: string | null): number | undefined {
  if (s === null) return undefined;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : undefined;
}

/** 时间文本 → epoch ms（ISO 8601 / HTTP-date 统一 Date.parse；NaN → undefined）。 */
export function parseTimestamp(s: string | null): number | undefined {
  if (s === null) return undefined;
  const t = Date.parse(s.trim());
  return Number.isNaN(t) ? undefined : t;
}

/** 一页 ListObjectsV2 响应的原始解析面（files/dirs 为挂载前缀未剥离形态）。 */
export interface S3ListPage {
  files: Array<{ key: string; size?: number; mtime?: number }>;
  dirs: string[];
  isTruncated: boolean;
  nextToken?: string;
}

/** ListObjectsV2 XML → 页（服务端 parse_list_v2 同语义：缺 Key 抛错等）。 */
export function parseListV2(xml: string): S3ListPage {
  const files = blocks(xml, 'Contents').map((block) => {
    const key = inner(block, 'Key');
    if (key === null) throw new Error('s3 list: <Contents> missing <Key>');
    const size = optInt(inner(block, 'Size'));
    const mtime = parseTimestamp(inner(block, 'LastModified'));
    return {
      key: xmlUnescape(key),
      ...(size !== undefined ? { size } : {}),
      ...(mtime !== undefined ? { mtime } : {})
    };
  });
  const dirs = blocks(xml, 'CommonPrefixes').map((block) => {
    const prefix = inner(block, 'Prefix');
    if (prefix === null) throw new Error('s3 list: <CommonPrefixes> missing <Prefix>');
    return xmlUnescape(prefix);
  });
  const isTruncated = (inner(xml, 'IsTruncated') ?? '').trim().toLowerCase() === 'true';
  const token = inner(xml, 'NextContinuationToken');
  return {
    files,
    dirs,
    isTruncated,
    ...(token !== null ? { nextToken: xmlUnescape(token) } : {})
  };
}

// ---------- store 工厂 ----------

/** 挂载子路径规范化：空串或 `xxx/`（服务端 normalize_prefix 同款；dav 复用）。 */
export function normalizeMountPrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? '').replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

/**
 * 直连 storeId：`s3direct:<hash8(config)>`（hash8 与既有 storeId hash 同函数）。
 * 入参 = 挂载目标身份（endpoint/bucket/prefix/pathStyle），**不含凭据与 label**
 *（凭据轮换/改名不换 id，与 proxy 指纹「同一挂载目标」口径一致）；mountsSync
 * 记录 id 复用此值作天然去重键。
 */
export function s3DirectStoreId(cfg: Pick<S3DirectConfig, 'endpoint' | 'bucket' | 'prefix' | 'pathStyle'>): string {
  const identity = ['s3', cfg.endpoint.trim(), cfg.bucket.trim(), normalizeMountPrefix(cfg.prefix), cfg.pathStyle === false ? 'vhost' : 'path'].join('\u{1f}');
  return `s3direct:${hash8(identity)}`;
}

/** 直连 TreeStore 扩展面：watch 恒不支持（立即 onError，listener 恒不触发）。 */
export interface DirectStore extends TreeStore {
  /**
   * 直连来源无变更推送：立即调用 onError（复用 remote watch-error 的降级通知
   * 语义——UI 提示自动刷新不可用），listener 恒不触发；返回解绑函数（no-op）。
   */
  watch(listener: (paths: string[]) => void, onError?: () => void): () => void;
}

function splitSchemeAuthority(endpoint: string): [string, string] {
  const i = endpoint.indexOf('://');
  if (i < 0) return ['', endpoint];
  const rest = endpoint.slice(i + 3);
  const end = rest.search(/[/?]/);
  return [endpoint.slice(0, i), end >= 0 ? rest.slice(0, end) : rest];
}

/** 统一请求通道：签名注入 + 30s 超时与调用方 signal 合并 + CORS/超时特征化。 */
async function signedFetch(
  url: string,
  creds: S3Credentials,
  opts: { region?: string; extraHeaders?: Record<string, string>; signal?: AbortSignal }
): Promise<Response> {
  const headers = await signS3Get(url, creds, {
    region: opts.region,
    extraHeaders: opts.extraHeaders
  });
  return rawFetch(
    url,
    { headers, signal: opts.signal },
    'S3 直连失败：bucket CORS 未配置或网络不可达'
  );
}

/**
 * raw fetch 包装：30s 超时与调用方 signal 合并（RemoteStore.request 同款形态）；
 * fetch 网络层 TypeError（CORS 拦截/不可达特征）特征化为直连错误；超时与
 * AbortError（取消）原样透传。
 */
export async function rawFetch(
  url: string,
  init: { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal },
  corsMessage: string
): Promise<Response> {
  const timeoutSignal =
    typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
  const merged =
    init.signal && timeoutSignal
      ? AbortSignal.any([timeoutSignal, init.signal])
      : (init.signal ?? timeoutSignal);
  try {
    return await fetch(url, { ...init, signal: merged });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`直连请求超时（30s）: ${url}`);
    }
    if (err instanceof TypeError) {
      throw new Error(corsMessage);
    }
    throw err;
  }
}

/** 非 2xx → Error（状态码 + 错误体采样 ≤512 字符入消息，服务端 ensure_status 同款）。 */
async function ensureOk(res: Response, label: string): Promise<void> {
  if (res.status >= 200 && res.status < 300) return;
  let snippet = '';
  try {
    snippet = (await res.text()).slice(0, ERROR_BODY_SNIPPET);
  } catch {
    // 错误体不可读：只用状态码
  }
  throw new Error(`${label}请求失败: HTTP ${res.status}${snippet ? ` ${snippet}` : ''}`);
}

/**
 * S3 直连 TreeStore：ListObjectsV2（delimiter=/，分页聚合全量 + 目录优先自然序）
 * 列目录 + Range GET 读文件。接口形态与 RemoteStore 同构（listChildren/read/
 * rangeCapable/watch）；凭据经参数传入（core 零持久化）。
 */
export function createS3DirectStore(cfg: S3DirectConfig, opts?: S3DirectOptions): DirectStore {
  const endpoint = cfg.endpoint.trim().replace(/\/+$/, '');
  const bucket = cfg.bucket.trim();
  const mountPrefix = normalizeMountPrefix(cfg.prefix);
  const creds: S3Credentials = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey };
  const pathStyle = cfg.pathStyle !== false;
  const region = opts?.region ?? DEFAULT_REGION;
  const id = s3DirectStoreId(cfg);
  // Range 防线降级标记（服务端 WebDavBackend.range_capable 同款语义）：一旦
  // 实测 200 即恒 false——dispatcher 后续走全量切片通道
  let rangeOk = true;

  /** 桶基 URL（不含 query）：path-style `{endpoint}/{bucket}`；virtual-host `{scheme}://{bucket}.{authority}`。 */
  function bucketBase(): string {
    if (pathStyle) return `${endpoint}/${bucket}`;
    const [scheme, authority] = splitSchemeAuthority(endpoint);
    return `${scheme}://${bucket}.${authority}`;
  }

  /** 挂载相对路径 → 对象 key（prefix 前置；空路径 = 挂载根 → 空 key）。 */
  function objectKey(path: string): string {
    const rel = path.replace(/^\/+|\/+$/g, '');
    return rel === '' ? '' : `${mountPrefix}${rel}`;
  }

  /** ListObjectsV2 prefix（恒尾 '/'；空路径 = 挂载前缀自身）。 */
  function listPrefixOf(path: string): string {
    const rel = path.replace(/^\/+|\/+$/g, '');
    return rel === '' ? mountPrefix : `${mountPrefix}${rel}/`;
  }

  /** 一次 ListObjectsV2 请求 → 解析页。 */
  async function listPage(prefix: string, token: string | undefined, signal?: AbortSignal): Promise<S3ListPage> {
    const pairs: Array<[string, string]> = [
      ['list-type', '2'],
      ['delimiter', '/'],
      ['prefix', prefix]
    ];
    if (token !== undefined) pairs.push(['continuation-token', token]);
    const query = pairs.map(([k, v]) => `${encodeQueryValue(k)}=${encodeQueryValue(v)}`).join('&');
    const url = `${bucketBase()}?${query}`;
    const res = await signedFetch(url, creds, { region, signal });
    await ensureOk(res, 'S3');
    return parseListV2(await res.text());
  }

  return {
    id,
    displayName: () => cfg.label,
    async listChildren(path: string): Promise<TreeNode[]> {
      const prefix = listPrefixOf(path);
      const entries: TreeNode[] = [];
      let token: string | undefined;
      for (let pages = 1; ; pages++) {
        if (pages > MAX_LIST_PAGES) {
          throw new Error(`s3 list: pagination exceeded ${MAX_LIST_PAGES} pages`);
        }
        const page = await listPage(prefix, token);
        for (const f of page.files) {
          if (f.key.endsWith('/')) continue; // 目录标记对象：目录语义由 CommonPrefixes 承载
          const rel = f.key.startsWith(mountPrefix) ? f.key.slice(mountPrefix.length) : f.key;
          // delimiter=/ 下 rel 无 '/'；防御非遵从服务端取末段
          const name = rel.split('/').pop() ?? rel;
          if (name === '') continue;
          entries.push({
            name,
            path: path ? `${path}/${name}` : name,
            kind: 'file',
            ...(f.size !== undefined ? { size: f.size } : {}),
            ...(f.mtime !== undefined ? { mtime: f.mtime } : {})
          });
        }
        for (const p of page.dirs) {
          const rel = p.startsWith(mountPrefix) ? p.slice(mountPrefix.length) : p;
          const name = rel.replace(/\/+$/, '');
          if (name === '' || name.includes('/')) continue; // 挂载前缀自身/越层前缀：防御
          entries.push({ name, path: path ? `${path}/${name}` : name, kind: 'dir' });
        }
        if (!page.isTruncated) break;
        if (page.nextToken !== undefined && page.nextToken !== '') {
          token = page.nextToken;
        } else {
          break; // 截断但无续传 token：防御性终止（病态服务端形态）
        }
      }
      // 呈现序与 RemoteStore（服务端排序）一致：目录优先 + 自然序
      return entries.sort((a, b) =>
        a.kind === b.kind ? naturalCompare(a.name, b.name) : a.kind === 'dir' ? -1 : 1
      );
    },
    async read(path: string, readOpts?: { range?: ByteRange; signal?: AbortSignal }) {
      const key = objectKey(path);
      if (key === '') throw new Error(`s3: empty key（${path}）`);
      const base = bucketBase();
      const encoded = encodeKeyPath(key);
      const url = encoded === '' ? base : `${base}/${encoded}`;
      const r = readOpts?.range;
      const res = await signedFetch(url, creds, {
        region,
        extraHeaders: r ? { range: `bytes=${r.start}-${r.end}` } : undefined,
        signal: readOpts?.signal
      });
      await ensureOk(res, 'S3');
      const buf = new Uint8Array(await res.arrayBuffer());
      if (r !== undefined && res.status !== 206) {
        // Range 防线（服务端同款判定）：200 = Range 被无视，body 是全量——
        // 切出请求窗交付并标记降级（此后走 !rangeCapable 全量切片通道）
        rangeOk = false;
        return buf.subarray(r.start, r.end + 1);
      }
      return buf;
    },
    get rangeCapable() {
      return rangeOk;
    },
    watch(listener: (paths: string[]) => void, onError?: () => void): () => void {
      void listener;
      onError?.();
      return () => {};
    }
  };
}
