import type { Encoding, TreeStore, TreeNode } from '../types';
import { hash8 } from './singleFile';

/**
 * 服务端检测元数据（/api/file 响应的 X-VV-Lang / X-VV-Encoding 头）。
 * lang 为 helix 语言名，与 @vviewer/highlight 的 detectLanguage 同源同形。
 */
export interface RemoteMeta {
  lang?: string;
  encoding?: Encoding;
}

/**
 * RemoteStore 扩展面：SSE 变更订阅与资源释放。
 * watch 由 openFlow 在连接成功后调用；close 由引用计数接线（最后一个持有 tab 关闭时）触发。
 */
export interface RemoteStore extends TreeStore {
  /**
   * 订阅服务器变更推送（`changed` 事件的相对路径列表；onError 为降级通知：
   * 服务端 watcher 故障收到 `watch-error` 帧后不再有数据帧）；返回解绑函数。
   */
  watch(listener: (paths: string[]) => void, onError?: () => void): () => void;
  /**
   * 关闭 SSE 连接并停止重连，同时清理该 store 登记的资源表
   * （remoteMeta 按 id 前缀、remoteBaseById 单条）；之后 store 仍可正常
   * read/listChildren（检测元数据按需重建）。
   */
  close(): void;
}

/**
 * 模块级 meta 表：key `${store.id}:${path}`，RemoteStore.read 时写入。
 * code renderer 渲染前查表（getRemoteMeta），用服务端检测纠偏本地启发式。
 */
const remoteMeta = new Map<string, RemoteMeta>();

/** 读取某 remote 文件的检测元数据；无记录（含 local store）返回 undefined。 */
export function getRemoteMeta(storeId: string, path: string): RemoteMeta | undefined {
  return remoteMeta.get(`${storeId}:${path}`);
}

/** storeId → 服务端 base（scheme+host+port）：会话快照 storeBase 的来源，M7 重连恢复用。 */
const remoteBaseById = new Map<string, string>();

/** 读取某 remote store 的服务端 base；非 remote store 返回 undefined。 */
export function getRemoteBase(storeId: string): string | undefined {
  return remoteBaseById.get(storeId);
}

// ---------- 会话内上次连接的服务器（跨包存储契约） ----------

/**
 * sessionStorage 键「会话内上次成功连接的服务器」的唯一权威定义。写入侧
 * apps/web openFlow.svelte.ts（connectServer），读取侧 render-media av.ts
 * （hls.js 分片 XHR 无法走统一请求通道注入头，token 只能读会话存储）——
 * 此前键名/值形状仅靠注释约定同源，任一侧单改即静默丢 Bearer，故收敛单点导出。
 */
export const SESSION_LAST_SERVER_KEY = 'vviewer-last-server';

/** SESSION_LAST_SERVER_KEY 的值形状（JSON 序列化存储）。 */
export interface LastServerRecord {
  baseUrl: string;
  token: string | null;
}

/**
 * 连接地址归一：trim、去尾部斜杠；缺 scheme 补 `http://`
 * （"127.0.0.1:8321" → "http://127.0.0.1:8321"，避免落成同源相对路径误导排障）。
 * 常见误粘贴把 API 端点当服务器地址（"http://host:8321/api"）：剥掉唯一已知的
 * API 前缀 `/api`；其他 path（如反向代理前缀）保留原样——由请求失败时的错误
 * 信息提示排查（见 request 的 baseHasPath 提示）。
 */
export function normalizeServerBase(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  // 仅剥「authority 后紧跟的 /api」：host 恰为 "api"（http://api）不受影响
  return withScheme.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/]+)\/api$/i, '$1');
}

const ENCODINGS: readonly string[] = ['utf-8', 'utf-16le', 'utf-16be', 'gb18030'];

function asEncoding(v: string | null): Encoding | undefined {
  return v !== null && ENCODINGS.includes(v) ? (v as Encoding) : undefined;
}

/**
 * storeId 编码分量。新格式 `remote:<hash8(base:label)>:r<n>[:<hash8(basePath)>]`；
 * 旧格式 `remote:<hash8>`（无 :r 段）= 根 0 且无 basePath——解析端兼容两种。
 */
export interface RemoteStoreIdParts {
  hash: string;
  rootIndex: number;
  basePathHash?: string;
}

/**
 * storeId → 编码分量（非 remote id，含 placeholder:/localfs: 等前缀，返回 null）。
 * workspace 多根恢复（T4）由此从快照 storeId 反解根索引/basePath 指纹。
 */
export function parseRemoteStoreId(storeId: string): RemoteStoreIdParts | null {
  const m = /^remote:([0-9a-f]{8})(?::r(\d+))?(?::([0-9a-f]{8}))?$/.exec(storeId);
  if (m === null) return null;
  return {
    hash: m[1]!,
    rootIndex: m[2] !== undefined ? Number(m[2]) : 0,
    ...(m[3] !== undefined ? { basePathHash: m[3] } : {})
  };
}

/** createRemoteStore 的多根选项（缺省 = 根 0、无 basePath，与历史行为一致）。 */
export interface RemoteStoreOptions {
  /** 服务器多根下的根索引（server /api/* 的 root 参数）；缺省 0。 */
  rootIndex?: number;
  /** 根内子目录前缀：源内路径相对该前缀（请求前拼合、watch 回调前剥离）；首尾斜杠归一。 */
  basePath?: string;
}

/**
 * 远端 vviewer 文件服务器的 TreeStore（M5）：
 * listChildren → GET /api/tree?path=，read → GET /api/file?path=（全量读，
 * Range 由服务端支持但前端暂不使用）；每次 read 把 X-VV-* 检测头写入 remoteMeta。
 * id 由 base+label 哈希派生；base 登记在 remoteBaseById（会话快照 storeBase，M7 恢复）。
 * 多根（workspace T3）：opts.rootIndex/basePath 时 id 追加 :rN[:basePathHash] 段
 * （默认形态保持旧 id 不变，既有会话快照/资源表键零迁移）；请求按源相对路径
 * 拼合 basePath 前缀与 &root=；watch 帧带 root 时按 rootIndex 过滤（单根服务器
 * 省略 root = 全部接受）、按 basePath 剥离换算回源相对路径。
 * watch() 订阅 SSE 变更推送：POST /api/ticket（Bearer）换一次性票 →
 * GET /api/events?ticket=（EventSource 无法自带头）；断线手动重连接（ticket 一次性，
 * EventSource 原生自动重连会复用已消费的 ticket 永远 401，必须关掉重开）。
 */
export function createRemoteStore(
  baseUrl: string,
  token: string | null,
  dirLabel: string,
  opts?: RemoteStoreOptions
): RemoteStore {
  const base = normalizeServerBase(baseUrl);
  const rootIndex = opts?.rootIndex ?? 0;
  const basePathOpt = opts?.basePath?.replace(/^\/+|\/+$/g, '');
  const basePath = basePathOpt !== undefined && basePathOpt !== '' ? basePathOpt : undefined;
  const hash = hash8(`${base}:${dirLabel}`);
  // 默认形态（根 0、无 basePath）沿用旧编码：恢复路径/占位 id/资源表键零迁移；
  // 其余形态追加段保证互异（同 base+label 的 hash 段不变，编码只追加后缀）
  const id =
    rootIndex === 0 && basePath === undefined
      ? `remote:${hash}`
      : `remote:${hash}:r${rootIndex}${basePath !== undefined ? `:${hash8(basePath)}` : ''}`;
  remoteBaseById.set(id, base);
  // base 带非根 path（归一化后仍保留，可能是反向代理前缀）：请求失败时在错误信息提示
  let baseHasPath = false;
  try {
    baseHasPath = new URL(base).pathname !== '/';
  } catch {
    // base 非法（极端）：不提示，交由 fetch 报错
  }

  /**
   * 源相对路径 → 服务器根相对路径：basePath 前缀拼合（空路径 = 前缀自身——
   * server 树/文件路径相对根而非相对 basePath，listChildren('') 即查前缀目录）。
   */
  function toServerPath(path: string): string {
    if (basePath === undefined) return path;
    return path === '' ? basePath : `${basePath}/${path}`;
  }

  /**
   * 带 Bearer 头的 GET；非 2xx 抛含状态码的 Error（server 错误体若为 JSON 则附 detail；
   * base 带 path 时附误粘贴提示）。挂 30s 超时：服务器失联时请求有界失败而非永久悬挂。
   * 多根：路径经 toServerPath 换算，rootIndex!=0 追加 &root=<n>（根 0 不拼，URL 形状不变）。
   */
  async function request(apiPath: string, path: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const query =
      `path=${encodeURIComponent(toServerPath(path))}` +
      (rootIndex !== 0 ? `&root=${rootIndex}` : '');
    let res: Response;
    try {
      res = await fetch(`${base}${apiPath}?${query}`, {
        headers,
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(30_000) : undefined
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`服务器请求超时（30s）: ${base}${apiPath}`);
      }
      throw err;
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === 'string') detail = `: ${body.error}`;
      } catch {
        // 非 JSON 错误体：只用状态码
      }
      const pathHint = baseHasPath ? '（服务地址带有路径后缀，请确认未把 API 端点误粘贴为地址）' : '';
      throw new Error(`服务器请求失败: HTTP ${res.status}${detail}${pathHint}`);
    }
    return res;
  }

  // ---------- SSE 变更推送订阅 ----------
  type ChangeListener = (paths: string[]) => void;
  const changeListeners = new Set<ChangeListener>();
  const errorListeners = new Set<() => void>();
  let eventSource: EventSource | null = null;
  let opening = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 1000;
  let watchClosed = false;

  /** SSE 数据帧：`{"type":"changed","paths":[..]}`（多根服务器附加 `"root":n`）或降级帧 `{"type":"watch-error"}`。 */
  function onChangedFrame(data: string): void {
    let body: { type?: string; paths?: unknown; root?: unknown };
    try {
      body = JSON.parse(data) as { type?: string; paths?: unknown; root?: unknown };
    } catch {
      return; // 非 JSON 帧：忽略
    }
    if (body.type === 'watch-error') {
      // 服务端 watcher 故障（启动失败或运行期出错，降级后不再有数据帧）：
      // 断开且不重连；onError 透传给 UI（状态栏一次性提示自动刷新不可用）
      eventSource?.close();
      eventSource = null;
      for (const listener of errorListeners) listener();
      return;
    }
    if (body.type !== 'changed' || !Array.isArray(body.paths)) return;
    reconnectDelay = 1000; // 有正常帧说明链路健康，重置退避
    // 多根服务器帧带 root（按 rootIndex 过滤异根帧）；单根服务器省略 root
    // （历史形状）——缺省不过滤（preflight 契约「单根省略=全部接受」），
    // 仅「带 root 参数的 SSE 帧」参与 rootIndex 过滤
    if (body.root !== undefined && body.root !== rootIndex) return;
    let paths = body.paths.filter((p): p is string => typeof p === 'string');
    if (basePath !== undefined) {
      // server 推送的路径相对根：剥离 basePath 前缀换算回源相对；
      // 前缀不匹配（其他源的变更）丢弃；恰为前缀自身（目录本身变更）剥离为 ''
      paths = paths.flatMap((p) => {
        if (p === basePath) return [''];
        if (p.startsWith(`${basePath}/`)) return [p.slice(basePath.length + 1)];
        return [];
      });
      if (paths.length === 0) return;
    }
    for (const listener of changeListeners) listener(paths);
  }

  async function openEvents(): Promise<void> {
    if (watchClosed || eventSource !== null || opening) return;
    opening = true;
    try {
      // 换一次性 ticket（EventSource 无法自带 Authorization 头）
      let ticket: string | null = null;
      try {
        const res = await fetch(`${base}/api/ticket`, {
          method: 'POST',
          headers: token ? { authorization: `Bearer ${token}` } : {}
        });
        if (res.ok) {
          const body = (await res.json()) as { ticket?: unknown };
          if (typeof body.ticket === 'string') ticket = body.ticket;
        }
      } catch {
        // 网络错误或非 JSON：走下方退避重连
      }
      if (watchClosed) return;
      if (ticket === null) {
        scheduleReconnect();
        return;
      }
      const es = new EventSource(`${base}/api/events?ticket=${encodeURIComponent(ticket)}`);
      eventSource = es;
      es.onmessage = (ev) => onChangedFrame(ev.data);
      es.onerror = () => {
        // 手动关闭重开：ticket 一次性，原生自动重连复用同一 URL 会永远 401
        es.close();
        if (eventSource === es) eventSource = null;
        scheduleReconnect();
      };
    } finally {
      opening = false;
    }
  }

  function scheduleReconnect(): void {
    if (watchClosed || reconnectTimer !== null) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void openEvents();
    }, delay);
  }

  function watch(listener: (paths: string[]) => void, onError?: () => void): () => void {
    changeListeners.add(listener);
    if (onError) errorListeners.add(onError);
    void openEvents();
    return () => {
      changeListeners.delete(listener);
      if (onError) errorListeners.delete(onError);
    };
  }

  function close(): void {
    watchClosed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    eventSource?.close();
    eventSource = null;
    changeListeners.clear();
    errorListeners.clear();
    // 资源表清理：该 store 的检测元数据（按 id 前缀）与服务端 base 登记。
    // 同 base 重连时新旧 store 同 id：openFlow 先关旧 tab（触发本 close）再建
    // 新 store，新 store 重新登记，顺序保证无悬挂。
    for (const key of [...remoteMeta.keys()]) {
      if (key.startsWith(`${id}:`)) remoteMeta.delete(key);
    }
    remoteBaseById.delete(id);
  }

  return {
    id,
    displayName: () => dirLabel,
    async listChildren(path): Promise<TreeNode[]> {
      const res = await request('/api/tree', path);
      const body = (await res.json()) as {
        entries?: Array<{ name: string; kind: string; size?: number; mtime?: number }>;
      };
      const entries = Array.isArray(body.entries) ? body.entries : [];
      return entries.map((e) => ({
        name: e.name,
        path: path ? `${path}/${e.name}` : e.name,
        kind: e.kind === 'dir' ? 'dir' : 'file',
        ...(e.size !== undefined ? { size: e.size } : {}),
        ...(e.mtime !== undefined ? { mtime: e.mtime } : {})
      }));
      // 排序信任服务端（目录优先 + 自然序已由 /api/tree 保证）
    },
    async read(path) {
      // opts.range 暂不使用：renderer 全量 read（hex 1MB 场景可接受，M6 优化）
      const res = await request('/api/file', path);
      const lang = res.headers.get('x-vv-lang');
      const encoding = asEncoding(res.headers.get('x-vv-encoding'));
      const key = `${id}:${path}`;
      if (lang !== null || encoding !== undefined) {
        remoteMeta.set(key, { ...(lang !== null ? { lang } : {}), ...(encoding !== undefined ? { encoding } : {}) });
      } else {
        remoteMeta.delete(key); // 文件变更后检测头可能消失：清掉旧记录
      }
      return new Uint8Array(await res.arrayBuffer());
    },
    watch,
    close
  };
}
