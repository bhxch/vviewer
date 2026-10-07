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
  /** 订阅服务器变更推送（`changed` 事件的相对路径列表）；返回解绑函数。 */
  watch(listener: (paths: string[]) => void): () => void;
  /** 关闭 SSE 连接并停止重连；之后 store 仍可正常 read/listChildren。 */
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
 */
export function normalizeServerBase(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
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

  /** 带 Bearer 头的 GET；非 2xx 抛含状态码的 Error（server 错误体若为 JSON 则附 detail）。 */
  async function request(apiPath: string, path: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}${apiPath}?path=${encodeURIComponent(path)}`, { headers });
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === 'string') detail = `: ${body.error}`;
      } catch {
        // 非 JSON 错误体：只用状态码
      }
      throw new Error(`服务器请求失败: HTTP ${res.status}${detail}`);
    }
    return res;
  }

  // ---------- SSE 变更推送订阅 ----------
  type ChangeListener = (paths: string[]) => void;
  const changeListeners = new Set<ChangeListener>();
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
      // 服务端 watcher 建立失败（降级后不再有数据帧）：断开且不重连
      eventSource?.close();
      eventSource = null;
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

  function watch(listener: (paths: string[]) => void): () => void {
    changeListeners.add(listener);
    void openEvents();
    return () => {
      changeListeners.delete(listener);
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
