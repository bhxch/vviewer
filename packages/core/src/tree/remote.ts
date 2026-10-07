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
 * 模块级 meta 表：key `${store.id}:${path}`，RemoteStore.read 时写入。
 * code renderer 渲染前查表（getRemoteMeta），用服务端检测纠偏本地启发式。
 */
const remoteMeta = new Map<string, RemoteMeta>();

/** 读取某 remote 文件的检测元数据；无记录（含 local store）返回 undefined。 */
export function getRemoteMeta(storeId: string, path: string): RemoteMeta | undefined {
  return remoteMeta.get(`${storeId}:${path}`);
}

const ENCODINGS: readonly string[] = ['utf-8', 'utf-16le', 'utf-16be', 'gb18030'];

function asEncoding(v: string | null): Encoding | undefined {
  return v !== null && ENCODINGS.includes(v) ? (v as Encoding) : undefined;
}

/**
 * 远端 vviewer 文件服务器的 TreeStore（M5）：
 * listChildren → GET /api/tree?path=，read → GET /api/file?path=（全量读，
 * Range 由服务端支持但前端暂不使用）；每次 read 把 X-VV-* 检测头写入 remoteMeta。
 * id 由 base+label 哈希派生，会话快照只记 storeLabel（重连恢复属 M7）。
 */
export function createRemoteStore(baseUrl: string, token: string | null, dirLabel: string): TreeStore {
  const base = baseUrl.replace(/\/+$/, ''); // 尾部斜杠归一，避免 //api/...
  const id = `remote:${hash8(`${base}:${dirLabel}`)}`;

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
    }
  };
}
