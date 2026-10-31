/**
 * serverConnect.svelte.ts — 连接域（FE-1 自 openFlow.svelte.ts 拆出的 runes 域
 * 模块）：SSE 变更推送健康旗标/状态栏一次性提示/connectServer/挂载 rootIndex
 * 迁移，与 remote 创建链的 SSE watch 接线归一 helper wireStoreWatch。依赖单向
 * tabsModel ← serverConnect ← openFlow façade（无环）；能力/lastServer 的
 * sessionStorage 读写抽在 serverCapsCache.ts（纯模块）。
 * FE-2：AppShell 的 reconnectRemoteStore（restore 期恢复重连）迁入本模块并归
 * wireStoreWatch 家族——remote 创建链第四处调用点，复位/置位写点收敛单点。
 * direct 链（createDirectMountStore）的 watch 接线有意不经 wireStoreWatch——
 * 见 openFlow.svelte.ts 该函数注释（双锚测锁死的有意分叉）。
 */
import { createRemoteStore, getRemoteBase, normalizeServerBase, type TreeStore } from '@bhxch/vviewer-core';
import { loadSettings } from './stores/settings';
import { workspaceStore } from './workspaceStore';
import {
  syncMountsOnConnect,
  rewriteSourceForMigration,
  rewriteStoreIdRootIndex,
  type RootIndexMove
} from './mountsSync';
import {
  tabStore,
  workspacesView,
  storeById,
  addDirStoreTab,
  registerStore,
  unregisterStore,
  persist
} from './tabsModel.svelte';
import {
  saveCapabilities,
  saveComputeLanguages,
  saveDiagramCapabilities,
  saveLastServer,
  loadLastServer
} from './serverCapsCache';
import { saveSearchEngine } from './searchEngineCache';
import { saveServerHealth } from './serverHealthCache';

/**
 * SSE 变更推送健康状态（终审 B2）：服务端 watch-error（watcher 启动失败或运行期
 * 故障降级）到达即置位——状态栏一次性提示"自动刷新不可用"；下次连接成功复位。
 */
export const watchHealth = $state({ degraded: false });

/**
 * 状态栏一次性提示（遗留 U1）：空目录拖入等无法归属到单个 tab 的轻量异常。
 * 文本非空时 ViewerPane 状态栏显示，数秒后自动清除；与 watchHealth 同为模块级
 * runes 状态，openFlow 写入、UI 只读。
 */
export const statusNotice = $state({ text: '' });
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/** 显示一条临时状态栏提示（duration 后自动清除；连发时重置计时） */
export function showStatusNotice(text: string, duration = 4000): void {
  statusNotice.text = text;
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    statusNotice.text = '';
  }, duration);
}

/** 目录 tab 显示名：取地址 host（解析失败退回原串）。 */
export function serverLabel(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/**
 * remote 创建链的 SSE watch 接线归一（FE-1）：connectServer / applyMountRoot-
 * IndexMigrations（本模块）与 openRemoteSource（openFlow façade）三处逐字同款
 * 的接线收敛——autoRefresh 实时过滤（BUG-05：设置面板关闭时停用自动重读，手动
 * 刷新 ↻ 不受影响）+ 创建期复位降级指示（新连接不复用上一次连接的降级）+
 * onError 置位 + 同款 console.warn。存活实例复用路径不经本函数（不触旗标——
 * 多源打开不互相清写）。direct 链（createDirectMountStore）有意不经本通道：
 * 立即 onError 置位会污染健康 remote 来源 tab、创建期复位会抹掉 remote 的真实
 * 降级指示（watchHealth/directMountFlow 双锚测锁死的有意分叉）。
 */
export function wireStoreWatch(store: ReturnType<typeof createRemoteStore>): void {
  watchHealth.degraded = false;
  store.watch(
    (paths) => {
      if (!loadSettings().autoRefresh) return;
      tabStore.refreshPaths(store.id, paths);
    },
    () => {
      watchHealth.degraded = true;
      console.warn('[vviewer] 服务器变更推送不可用，自动刷新已停用');
    }
  );
}

/**
 * 连接 vviewer 文件服务器：GET /api/health 校验（capabilities 须含 file-server）
 * → POST /api/ticket 鉴权预检（health 免认证，需受保护端点实际验 token）
 * → createRemoteStore（watch 订阅 SSE 变更）→ addDirStoreTab（目录 tab 加入当前
 * workspace，同 storeId 去重激活）
 * → 记入 sessionStorage。失败抛错给 UI 展示；连接句柄不可持久化，重连本期需手动（M7 恢复）。
 */
export async function connectServer(baseUrl: string, token: string | null): Promise<void> {
  const base = normalizeServerBase(baseUrl); // 缺 scheme 补 http://、去尾部斜杠
  const tok = token?.trim() ? token.trim() : null;

  const headers: Record<string, string> = {};
  if (tok) headers.authorization = `Bearer ${tok}`;
  let res: Response;
  try {
    res = await fetch(`${base}/api/health`, { headers });
  } catch {
    throw new Error(`无法连接 ${base}：网络错误或地址不可达`);
  }
  if (!res.ok) throw new Error(`服务器响应异常: HTTP ${res.status}`);
  let caps: {
    version?: unknown;
    capabilities?: unknown;
    computeLanguages?: unknown;
    diagrams?: unknown;
    searchEngine?: unknown;
    roots?: unknown;
    fsRoots?: unknown;
  };
  try {
    caps = (await res.json()) as {
      version?: unknown;
      capabilities?: unknown;
      computeLanguages?: unknown;
      diagrams?: unknown;
      searchEngine?: unknown;
      roots?: unknown;
      fsRoots?: unknown;
    };
  } catch {
    throw new Error('health 响应不是有效 JSON');
  }
  if (!Array.isArray(caps.capabilities) || !caps.capabilities.includes('file-server')) {
    throw new Error('目标不是 vviewer 文件服务器（缺少 file-server 能力）');
  }
  // health 摘要缓存（settings center spec §2.1 关于分节）：version/capabilities/
  // searchEngine/roots 并列显示；旧服务端缺 version 时按无记录处理（显示「未连接」）
  saveServerHealth(caps);
  // 能力缓存（M6 compute 路由判定用）：compute 端点是否可用以连接时 health 为准
  saveCapabilities(caps.capabilities);
  // 服务端高亮语言集合缓存（BUG-06c）：compute 宣告则缓存，未宣告（旧服务端）
  // 清除旧缓存表示未知，路由保持既有先试远程行为
  saveComputeLanguages(caps.computeLanguages);
  // 服务端图表子集缓存（spec §8.3）：health 宣告则缓存，未宣告（旧服务端/非
  // compute 部署）清除旧缓存表示未知，server 模式按降级链回退 local/kroki
  saveDiagramCapabilities(caps.diagrams);
  // 搜索引擎宣告缓存（A 项）：旧服务端无字段 → 清缓存，徽标不显示
  saveSearchEngine(caps.searchEngine);

  // 鉴权预检：health 免认证，错误 token 也能过能力校验——用 Bearer 保护的
  // ticket 端点实际验证令牌，避免"假连接成功后所有数据请求 401、目录树全空"
  let authRes: Response;
  try {
    authRes = await fetch(`${base}/api/ticket`, { method: 'POST', headers });
  } catch {
    throw new Error(`无法连接 ${base}：网络错误或地址不可达`);
  }
  if (!authRes.ok) {
    throw new Error(
      authRes.status === 401 ? '鉴权失败：令牌缺失或错误（HTTP 401）' : `服务器响应异常: HTTP ${authRes.status}`
    );
  }

  // 代理挂载对账（目录挂载 spec §3）：连接成功后核对本前端保存的代理挂载并
  // 幂等重注册（指纹缺失才 POST；探测失败走 DELETE+POST 凭据轮换）。置于
  // ticket 预检之后：覆盖新鲜连接与存活实例复用两条成功路径。fire-and-forget
  // 不阻塞连接主链与首屏（plan 裁决）；syncMountsOnConnect 内部全量吞错（失败
  // 静默标记待重试），此 catch 仅防御性兜底。迁移回调（台账 3-1）：对账换索引
  // 时三面改写已开 tab/sources，token 闭包注入供重建实例复用同一凭据。
  void syncMountsOnConnect(base, tok, (ms) => applyMountRootIndexMigrations(ms, tok)).catch(() => {});

  // 存活实例复用（与 openRemoteSource 同一防线）：restore 重连通道重建的同源
  // store 实例仍在注册表存活时，重复连接直接复用之——不再走「关闭同 base 全部
  // tab → 重建」路径。该路径存在两重代价：①左栏树经 sources derived 的
  // 「源 × 注册表 × tab 持有」三条件在 close→addTab 窗口内瞬态为空（FileTree
  // 卸载重挂、树闪烁）；②restore 重连实例的 SSE 流未被关闭前，新实例构成双流
  // （openRemoteSource 的复用裁决即为此）。复用条件对齐 restore 重连的构造输入
  //（base + 会话 last-server 的 token——重连以它建 store），token 不一致（用户
  // 换令牌重连）回退既有关闭重建路径。connectServer 恒为根 0/整根形态。
  const last = loadLastServer();
  if (last !== null && last.baseUrl === base && (last.token ?? null) === tok) {
    for (const w of workspacesView.list) {
      const src = w.sources.find(
        (s) =>
          s.kind === 'remote' &&
          s.storeBase === base &&
          (s.rootIndex ?? 0) === 0 &&
          s.basePath === undefined
      );
      if (src === undefined) continue;
      const alive = storeById(src.storeId);
      if (alive === null) continue; // 实例不存活（tab 已全部关闭）：走关闭重建
      addDirStoreTab(alive);
      saveLastServer(base, tok);
      return;
    }
  }

  // 同 base 重连：先关闭同 base 的旧 remote tab（目录 + 文件）。旧 store 无 tab
  // 持有后经引用计数接线 close()（停 SSE + 清资源表），避免新旧两条事件流并行。
  // undoable:false（fix round 1 Concern 1）：系统替换动作非用户关闭——入栈会淹没
  // 容量 10 的撤销栈，且撤销会复活用户未关的 tab 制造重复 tab。
  // 匹配须在任一关闭发生前一次性完成（SUS-TAX-1）：逐个关闭时，关掉目录 tab 可
  // 能使旧 store 实例失去最后持有者而被终结（remote.ts close 删 remoteBaseById
  // 登记），后续文件 tab 的 getRemoteBase 已返回 undefined 匹配落空——文件 tab
  // 幸存失联（不在新连接 watch 内、快照 storeBase 登记被清）
  const staleTabIds = tabStore.list
    .filter((t) => getRemoteBase(t.source.storeId) === base)
    .map((t) => t.id);
  for (const id of staleTabIds) {
    tabStore.close(id, { undoable: false });
  }
  // 台账 3-21：重连清扫与挂载释放同口径（状态栏一次性提示）——旧 tab 被系统替换
  // 关闭（undoable:false 不入撤销栈）此前零反馈；0 = 首次连接/无存活实例，不提示。
  if (staleTabIds.length > 0) {
    showStatusNotice(`已关闭 ${staleTabIds.length} 个旧标签页（服务器已重新连接）`);
  }

  const store = createRemoteStore(base, tok, serverLabel(base));
  // SSE 变更订阅：服务端推送 changed → 命中 path 的 tab 重读重渲染 + 目录 tab 自增
  //（左栏树重建）；watch-error（watcher 降级）→ 状态栏一次性提示自动刷新不可用。
  // store 关闭（最后一个持有 tab 关闭 / 被新连接替换）由引用计数接线调 close() 停流
  wireStoreWatch(store); // 创建期复位降级指示（新连接不复用上一次连接的降级）
  addDirStoreTab(store);
  saveLastServer(base, tok);
}

/**
 * 挂载重注册的 rootIndex 迁移（台账 3-1）：syncMountsOnConnect 收集的迁移对在此
 * 消费——「记录（healthyRecord 已写新 registeredRootIndex）+ sources[] + 存活 tab」
 * 三面同步改写，快照恢复面自然跟随本次 persist 落盘。改写数学见
 * mountsSync.rewriteStoreIdRootIndex（r 段正则替换，hash/basePath 段与 storeLabel
 * 冻结）。存活 tab 面据此以「冻结 storeLabel + 新 rootIndex」重建 store 实例换挂：
 * 只改 storeId 字符串会让实例注册表/remoteBaseById 键脱节（storeById 落空 → 树行
 * 消失；快照 getRemoteBase 缺失 → 恢复链断裂），而 createRemoteStore 以冻结 label +
 * 新索引重建的 id 恰为正则改写结果——两形态互锁（派生不一致即放弃 tab 面，防御
 * 快照 label 与 storeId 脱节）；旧实例在持有者全部换挂后手动 close()（停 SSE +
 * 清旧 base 登记）。token 由调用方闭包注入（connectServer/restore 重连各持本次
 * 凭据），重建实例复用同一凭据。
 */
export function applyMountRootIndexMigrations(moves: RootIndexMove[], token: string | null): void {
  if (moves.length === 0) return;
  // 旧 storeId → 重建实例所需的冻结元数据（须在 sources[] 改写前捕获——改写后
  // sources 的 storeId 已是新值，rootIndex 字段同理不再指向旧索引）
  const metaByOldId = new Map<string, { storeBase: string; storeLabel: string; basePath?: string }>();
  for (const s of workspaceStore.list.flatMap((w) => w.sources)) {
    if (s.storeBase === undefined) continue;
    if (rewriteSourceForMigration(s, moves) !== null) {
      metaByOldId.set(s.storeId, {
        storeBase: s.storeBase,
        storeLabel: s.storeLabel,
        ...(s.basePath !== undefined ? { basePath: s.basePath } : {})
      });
    }
  }
  // ① sources[]（全部 workspace，rewriteSources 单次通知；快照 sources 落新值）
  workspaceStore.rewriteSources((s) => rewriteSourceForMigration(s, moves));
  // ② 存活 tab：按旧 storeId 分组重建实例换挂
  for (const [oldId, meta] of metaByOldId) {
    const holders = tabStore.list.filter((t) => t.source.storeId === oldId);
    if (holders.length === 0) continue; // 无存活持有者：实例已释放，无需重建
    const move = moves.find((m) => rewriteStoreIdRootIndex(oldId, m.oldIndex, m.newIndex) !== null);
    if (move === undefined) continue; // 防御：metaByOldId 捕获与 moves 同源，理论不可达
    const newId = rewriteStoreIdRootIndex(oldId, move.oldIndex, move.newIndex)!;
    const store = createRemoteStore(meta.storeBase, token, meta.storeLabel, {
      rootIndex: move.newIndex,
      ...(meta.basePath !== undefined ? { basePath: meta.basePath } : {})
    });
    if (store.id !== newId) continue; // 派生不一致：放弃 tab 面（记录/sources 面已改写）
    // SSE 接线与 connectServer 同款：autoRefresh 过滤 + watch-error 置降级指示
    //（FE-1 归一进 wireStoreWatch）
    wireStoreWatch(store);
    for (const t of holders) {
      t.source.store = store;
      t.source.storeId = store.id;
    }
    registerStore(store); // 新实例入册（activeStores 键 = 新 id，registryVersion 随之自增）
    const old = storeById(oldId);
    unregisterStore(oldId); // 旧 id 注册表项摘除（TabCollection.close 的注册表清理同款）
    old?.close?.(); // 旧实例持有者已清空：停 SSE + 清 remoteBaseById 旧登记
  }
  void persist(); // 三面改写后的快照落盘（恢复面跟随）
}

/**
 * BUG-08：restore 期自动重连（connectServer 的精简恢复路径）——health 探测
 * 3s 超时判可达，可达即 createRemoteStore + SSE watch 订阅接线（与 connectServer
 * 同模式：autoRefresh 关闭时回调过滤、watch-error 置降级指示）；不可达返回 null
 * 交由调用方落占位。不发目录 tab（不自动弹树），只服务快照 tab 的内容恢复。
 * 多根（T4）：rootIndex/basePath 由调用方从快照 sources[] 显式传入——storeId 的
 * basePath 段是 32 位 FNV 指纹不可反解（T3 评审约束），恢复链路绝不从 storeId 反解。
 * label 回环（T5 评审 I-1）：label 参与 storeId hash（hash8(`${base}:${label}`)），
 * 必须用快照 sources[].storeLabel 原值重建——与运行期 createRemoteStore 用同一
 * 字符串才能精确复现快照 storeId；重算 host 会使多根/basePath 来源（label 为
 * 尾段/文件名/「host · 根N/x」形态）得到不同 storeId，恢复链 storeId 回环断裂
 *（树行消失/tab 分叉/二次重启落占位/来源复用防线失效）。
 * FE-2 自 AppShell.svelte 迁入本模块（AppShell.restore 的 reconnectOf 消费），
 * SSE 接线同步归一 wireStoreWatch（复位/置位写点与 connectServer 家族收敛单点）。
 */
export async function reconnectRemoteStore(
  base: string,
  token: string | null,
  storeLabel: string,
  opts?: { rootIndex?: number; basePath?: string }
): Promise<TreeStore | null> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${base}/api/health`, {
      headers,
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(3000) : undefined
    });
    if (!res.ok) return null;
  } catch {
    return null; // 网络不可达/超时：恢复降级为占位，不阻塞启动
  }
  // 不重算 host：label 用快照原值（见函数 doc——label 参与 storeId hash）
  const store = createRemoteStore(base, token, storeLabel, opts);
  registerStore(store); // 重连即入册：不依赖其 tab 的 addTab 时序（registerStore doc）
  wireStoreWatch(store); // SSE 接线归一（FE-2）：创建期复位降级指示 + autoRefresh 过滤 + watch-error 置位
  // 代理挂载对账（目录挂载 spec §3）：restore 重连成功同样触发幂等重注册——
  // connectServer 已覆盖新鲜连接面，这里补「刷新恢复」面（服务端重启后前端
  // 存档的代理挂载在重连时自动回填）。fire-and-forget 不阻塞恢复主链；内部
  // 全量吞错（失败静默标记待重试）。同 base 多来源（多根快照）会重复触发，
  // 对账幂等（同指纹命中即登记、服务端不重复分配）无副作用。迁移回调
  //（台账 3-1）：对账换索引时三面改写已开 tab/sources，token 闭包注入。
  void syncMountsOnConnect(base, token, (ms) => applyMountRootIndexMigrations(ms, token)).catch(() => {});
  return store;
}
