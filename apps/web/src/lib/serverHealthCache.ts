/**
 * serverHealthCache.ts — 会话级服务端 health 摘要缓存（settings center spec §2.1
 * 关于分节消费）：connectServer 时自 health 写入 version/capabilities/searchEngine/
 * roots/fsRoots；关于分节读显示「服务端版本/能力/搜索引擎/数据根」。无记录/损坏
 * 返回 null——UI 显示「未连接」降级。形态同 searchEngineCache.ts（sessionStorage
 * 单键）。另承载挂载根判定（目录挂载 spec §3）：fsRoots 边界 + isMountRootStoreId，
 * 供 watch 能力态与搜索降级消费。
 */

import { parseRemoteStoreId } from '@vviewer/core';

const KEY = 'vv:server-health';

export interface ServerHealthSummary {
  version: string;
  capabilities: string[];
  searchEngine: string | null;
  /** 多根宣告数；单根（历史形状）为 null */
  roots: number | null;
  /** fs 根数边界（目录挂载 spec §2）：rootIndex < fsRoots 为 fs 根、≥ 为挂载根；
   * 无挂载部署/旧服务端缺省为 null。 */
  fsRoots: number | null;
}

export function loadServerHealth(): ServerHealthSummary | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ServerHealthSummary>;
    if (typeof v.version !== 'string' || v.version === '' || !Array.isArray(v.capabilities)) {
      return null;
    }
    return {
      version: v.version,
      capabilities: v.capabilities.filter((c): c is string => typeof c === 'string'),
      searchEngine: v.searchEngine === 'rg' || v.searchEngine === 'grep' ? v.searchEngine : null,
      roots: typeof v.roots === 'number' ? v.roots : null,
      fsRoots: typeof v.fsRoots === 'number' ? v.fsRoots : null
    };
  } catch {
    return null;
  }
}

/** 连接成功时写入（health JSON 原样入参）；version 缺失（旧服务端）视为无记录 */
export function saveServerHealth(health: unknown): void {
  try {
    const h = (health ?? {}) as Record<string, unknown>;
    if (typeof h.version !== 'string' || h.version === '') {
      sessionStorage.removeItem(KEY);
      return;
    }
    const summary: ServerHealthSummary = {
      version: h.version,
      capabilities: Array.isArray(h.capabilities) ? h.capabilities.filter((c): c is string => typeof c === 'string') : [],
      searchEngine: h.searchEngine === 'rg' || h.searchEngine === 'grep' ? h.searchEngine : null,
      roots: typeof h.roots === 'number' ? h.roots : null,
      fsRoots: typeof h.fsRoots === 'number' ? h.fsRoots : null
    };
    sessionStorage.setItem(KEY, JSON.stringify(summary));
  } catch {
    // 存储不可用：关于分节降级「未连接」，连接本身不受影响
  }
}

/**
 * 挂载根 storeId 判定（目录挂载 spec §3）：remote store 且 rootIndex ≥ fsRoots
 * （health 边界宣告——挂载根能力恒 watch/search=false，spec §2）。fsRoots 未宣告
 * （null = 旧服务端/无挂载部署）恒 false（全部根视为 fs 根，既有行为零变化）。
 */
export function isMountRootStoreId(storeId: string): boolean {
  const fsRoots = loadServerHealth()?.fsRoots ?? null;
  if (fsRoots === null) return false;
  const parts = parseRemoteStoreId(storeId);
  return parts !== null && parts.rootIndex >= fsRoots;
}
