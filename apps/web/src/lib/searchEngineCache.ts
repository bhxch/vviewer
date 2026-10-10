/** 会话级跨文件搜索引擎宣告缓存（A 项）：connectServer 时自 health 写入，
 * GlobalSearchPanel 徽标读取。旧服务端无字段 → 移除缓存视为未知。 */

const KEY = 'vv:search-engine';

export type SearchEngineKind = 'rg' | 'grep';

export function loadSearchEngine(): SearchEngineKind | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw === 'rg' || raw === 'grep' ? raw : null;
  } catch {
    return null;
  }
}

export function saveSearchEngine(engine: unknown): void {
  try {
    if (engine === 'rg' || engine === 'grep') {
      sessionStorage.setItem(KEY, engine);
    } else {
      sessionStorage.removeItem(KEY);
    }
  } catch {
    // 存储不可用：徽标缺失，连接不受影响
  }
}
