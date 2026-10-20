import type { ByteRange, TreeNode } from '../types';
import { hash8 } from './singleFile';
import { naturalCompare } from './localFiles';
import {
  encodeKeyPath,
  normalizeMountPrefix,
  optInt,
  parseTimestamp,
  percentDecode,
  rawFetch,
  type DirectStore
} from './directS3';

/**
 * directDav.ts — WebDAV 直连 TreeStore（目录挂载 spec §4 阶段三，plan Task 1）。
 * PROPFIND Depth:1 列目录 + GET Range 读 + Basic auth，与
 * server/storage/src/webdav.rs 服务端语义同构（集合自身条目跳过、集合双信号
 *【resourcetype collection 或 href 尾斜杠】、目录优先自然序）；multistatus 解析
 * 走 DOMParser（命名空间感知——d:/D: 双前缀同解析，本地名兜底宽容未绑定形态）。
 * 分层与凭据、watch 恒不支持、Range 非 206 降级、CORS 特征化语义见 directS3.ts
 * 模块注（direct 家族共用口径）。浏览器直连大概率被服务器 CORS 拦截（PROPFIND
 * 自定义方法需预检放行）——UI 预检提示面在管理页（阶段四），知情使用。
 */

/** WebDAV 直连配置（spec §2 挂载字段集）。 */
export interface DavDirectConfig {
  /** 形如 `https://dav.example.com/dav`（尾 '/' 容忍；服务器路径段随 endpoint 携带）。 */
  endpoint: string;
  /** 挂载子路径：空 = endpoint 根；非空规范化为 `xxx/`。 */
  prefix?: string;
  username: string;
  password: string;
  /** 目录显示名。 */
  label: string;
}

/** PROPFIND 请求体：显式索取三属性（服务端 PROPFIND_BODY 同文——对空 body 走
 * allprop 的多数服务器上显式 prop 面更小、兼容面更稳）。 */
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';

/** 错误响应体采样上界（与 directS3/服务端同款）。 */
const ERROR_BODY_SNIPPET = 512;

/** 单个 `<response>` 的解析面（href 已 XML 反转义 + 百分号解码）。 */
export interface DavEntry {
  href: string;
  isCollection: boolean;
  size?: number;
  mtime?: number;
}

/** DAV 命名空间下按本地名取元素（任意前缀；无命中时按 localName 宽容兜底）。 */
function byDavName(el: Element | Document, local: string): Element[] {
  const ns = el.getElementsByTagNameNS('DAV:', local);
  if (ns.length > 0) return Array.from(ns);
  // 命名空间未绑定的宽容回退（部分服务器发 `<D:response>` 不带 xmlns 声明）
  return Array.from(el.getElementsByTagName('*')).filter((e) => e.localName === local);
}

/**
 * multistatus → 原始条目（DOMParser 版，服务端 parse_multistatus 同语义）：
 * 集合判定 = resourcetype 含 collection；href 缺失按空串（消费侧按空名跳过）；
 * 病态 XML（parsererror）返回空数组不抛错。
 */
export function parseMultistatus(xml: string): DavEntry[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return [];
  return byDavName(doc, 'response').map((r) => {
    const href = byDavName(r, 'href')[0]?.textContent ?? '';
    const rt = byDavName(r, 'resourcetype')[0];
    const isCollection = rt !== undefined && byDavName(rt, 'collection').length > 0;
    const size = optInt(byDavName(r, 'getcontentlength')[0]?.textContent ?? null);
    const mtime = parseTimestamp(byDavName(r, 'getlastmodified')[0]?.textContent ?? null);
    return {
      href: percentDecode(href),
      isCollection,
      ...(size !== undefined ? { size } : {}),
      ...(mtime !== undefined ? { mtime } : {})
    };
  });
}

// ---------- href/url 工具（服务端 webdav.rs 同款语义） ----------

/** 绝对 URI → path 部分（`http://h/p` → `/p`）；其余原样。 */
function normalizeHref(href: string): string {
  const i = href.indexOf('://');
  if (i < 0) return href;
  const rest = href.slice(i + 3);
  const s = rest.indexOf('/');
  return s >= 0 ? rest.slice(s) : '/';
}

/**
 * Depth:1 的首个 response 是集合自身——跳过判定：绝对 path/URI 形态与请求
 * path 全等（尾斜杠不敏感）；相对引用形态退化为与请求 path 末段全等。
 */
function isSelf(href: string, reqPath: string): boolean {
  const h = normalizeHref(href).replace(/\/+$/, '');
  const r = reqPath.replace(/\/+$/, '');
  if (h.startsWith('/')) return h.slice(1) === r.replace(/^\/+/, '');
  return r !== '' && h === (r.split('/').pop() ?? '');
}

/** 请求 URL 的 path 部分（自集合比较用）。 */
function urlPath(url: string): string {
  const i = url.indexOf('://');
  const rest = i >= 0 ? url.slice(i + 3) : url;
  const s = rest.indexOf('/');
  return s >= 0 ? rest.slice(s) : '/';
}

// ---------- store 工厂 ----------

/**
 * 直连 storeId：`davdirect:<hash8(config)>`（入参 = endpoint/prefix，不含凭据
 * 与 label——与 s3direct 同口径，见 directS3.s3DirectStoreId 注）。
 */
export function davDirectStoreId(cfg: Pick<DavDirectConfig, 'endpoint' | 'prefix'>): string {
  const identity = ['dav', cfg.endpoint.trim(), normalizeMountPrefix(cfg.prefix)].join('\u{1f}');
  return `davdirect:${hash8(identity)}`;
}

/** Basic auth 头值：`Basic base64(user:pass)`（UTF-8 安全编码，非 ASCII 用户名可用）。 */
export function basicAuthHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

/**
 * WebDAV 直连 TreeStore：PROPFIND Depth:1 列目录（207 预期，2xx 兼容）+ GET
 * （Range 防线降级同 directS3）读文件。凭据经参数传入（core 零持久化）。
 */
export function createDavDirectStore(cfg: DavDirectConfig): DirectStore {
  const endpoint = cfg.endpoint.trim().replace(/\/+$/, '');
  const mountPrefix = normalizeMountPrefix(cfg.prefix);
  const authorization = basicAuthHeader(cfg.username, cfg.password);
  const id = davDirectStoreId(cfg);
  let rangeOk = true; // Range 防线降级标记（directS3 同款语义）

  /** 集合 URL（恒尾 '/'）：`{endpoint}/{prefix}{rel}/`，path 逐段编码。 */
  function collectionUrl(rel: string): string {
    const p = `${mountPrefix}${rel}`.replace(/\/+$/, '');
    return p === '' ? `${endpoint}/` : `${endpoint}/${encodeKeyPath(p)}/`;
  }

  /** 资源 URL（文件目标，无尾斜杠）。 */
  function resourceUrl(rel: string): string {
    const p = `${mountPrefix}${rel}`.replace(/\/+$/, '');
    return p === '' ? `${endpoint}/` : `${endpoint}/${encodeKeyPath(p)}`;
  }

  /** 非 2xx → Error（401 附认证失败语义；服务端 ensure_status 同款口径）。 */
  async function ensureDavOk(res: Response): Promise<void> {
    if (res.status >= 200 && res.status < 300) return;
    let snippet = '';
    try {
      snippet = (await res.text()).slice(0, ERROR_BODY_SNIPPET);
    } catch {
      // 错误体不可读：只用状态码
    }
    const auth = res.status === 401 ? '（认证失败：检查用户名/密码）' : '';
    throw new Error(`WebDAV 请求失败: HTTP ${res.status}${auth}${snippet ? ` ${snippet}` : ''}`);
  }

  async function request(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal?: AbortSignal
  ): Promise<Response> {
    return rawFetch(url, { method, headers: { ...headers, authorization }, body, signal },
      'WebDAV 直连失败：服务器 CORS 未配置或网络不可达');
  }

  return {
    id,
    displayName: () => cfg.label,
    async listChildren(path: string): Promise<TreeNode[]> {
      const rel = path.replace(/^\/+|\/+$/g, '');
      const url = collectionUrl(rel);
      const res = await request(
        'PROPFIND',
        url,
        { depth: '1', 'content-type': 'application/xml' },
        PROPFIND_BODY
      );
      await ensureDavOk(res);
      const xml = await res.text();
      const reqPath = urlPath(url);
      const nodes: TreeNode[] = [];
      for (const raw of parseMultistatus(xml)) {
        if (isSelf(raw.href, reqPath)) continue; // Depth:1 的集合自身
        const isDir = raw.isCollection || raw.href.endsWith('/');
        // 名 = 解码后 path 末段（集合先剥尾 '/'；越层/空名防御性跳过）
        const name = normalizeHref(raw.href).replace(/\/+$/, '').split('/').pop() ?? '';
        if (name === '') continue;
        nodes.push({
          name,
          path: path ? `${path}/${name}` : name,
          kind: isDir ? 'dir' : 'file',
          ...(!isDir && raw.size !== undefined ? { size: raw.size } : {}),
          ...(raw.mtime !== undefined ? { mtime: raw.mtime } : {})
        });
      }
      // 呈现序统一：目录优先 + 自然序（directS3/服务端同款）
      return nodes.sort((a, b) =>
        a.kind === b.kind ? naturalCompare(a.name, b.name) : a.kind === 'dir' ? -1 : 1
      );
    },
    async read(path: string, readOpts?: { range?: ByteRange; signal?: AbortSignal }) {
      const rel = path.replace(/^\/+|\/+$/g, '');
      if (rel === '') throw new Error(`webdav: empty path（${path}）`);
      const r = readOpts?.range;
      const res = await request(
        'GET',
        resourceUrl(rel),
        r ? { range: `bytes=${r.start}-${r.end}` } : {},
        undefined,
        readOpts?.signal
      );
      await ensureDavOk(res);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (r !== undefined && res.status !== 206) {
        // Range 防线：200 = Range 被无视——从全量切出请求窗并标记降级
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
