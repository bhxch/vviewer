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
 * 远端 vviewer 文件服务器的 TreeStore（M5）：
 * listChildren → GET /api/tree?path=，read → GET /api/file?path=（全量读，
 * Range 由服务端支持但前端暂不使用）；每次 read 把 X-VV-* 检测头写入 remoteMeta。
 * id 由 base+label 哈希派生；base 登记在 remoteBaseById（会话快照 storeBase，M7 恢复）。
 * watch() 订阅 SSE 变更推送：POST /api/ticket（Bearer）换一次性票 →
 * GET /api/events?ticket=（EventSource 无法自带头）；断线手动重连接（ticket 一次性，
 * EventSource 原生自动重连会复用已消费的 ticket 永远 401，必须关掉重开）。
 */
export function createRemoteStore(baseUrl: string, token: string | null, dirLabel: string): RemoteStore {
  const base = normalizeServerBase(baseUrl);
  const id = `remote:${hash8(`${base}:${dirLabel}`)}`;
  remoteBaseById.set(id, base);
  // base 带非根 path（归一化后仍保留，可能是反向代理前缀）：请求失败时在错误信息提示
  let baseHasPath = false;
  try {
    baseHasPath = new URL(base).pathname !== '/';
  } catch {
    // base 非法（极端）：不提示，交由 fetch 报错
  }

  /**
   * 带 Bearer 头的 GET；非 2xx 抛含状态码的 Error（server 错误体若为 JSON 则附 detail；
   * base 带 path 时附误粘贴提示）。挂 30s 超时：服务器失联时请求有界失败而非永久悬挂。
   */
  async function request(apiPath: string, path: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(`${base}${apiPath}?path=${encodeURIComponent(path)}`, {
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

  /** SSE 数据帧：`{"type":"changed","paths":[..]}` 或降级帧 `{"type":"watch-error"}`。 */
  function onChangedFrame(data: string): void {
    let body: { type?: string; paths?: unknown };
    try {
      body = JSON.parse(data) as { type?: string; paths?: unknown };
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
    const paths = body.paths.filter((p): p is string => typeof p === 'string');
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
