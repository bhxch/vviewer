/**
 * openFlow.svelte.ts — 打开通道 + façade（FE-1 分层后的角色）。历史巨石已按域
 * 拆出（消费方经本文件再导出零改动，20+ 导入面不变）：
 * - tabsModel.svelte.ts（runes 域）：Tab 模型/TabCollection/注册表/来源登记与
 *   目录 tab 通道/撤销关闭栈/会话落盘；
 * - serverConnect.svelte.ts（runes 域）：连接/SSE 健康/挂载 rootIndex 迁移，
 *   remote 创建链的 SSE 接线归一 helper wireStoreWatch；
 * - serverCapsCache.ts（纯）：能力/lastServer 的 sessionStorage 读写；
 * - tabNeighbors.ts（纯）：关闭邻位/批量激活对齐算法。
 * 依赖单向 tabsModel ← serverConnect ← openFlow façade（无环）。本文件保留打开
 * 通道（文件/目录 picker·input·fallback/URL/远端来源/direct 挂载群/restore 句柄/
 * 归档事件桥/e2e 钩子）；direct 挂载群的 watch 接线为有意分叉（不经 wireStoreWatch，
 * 见 createDirectMountStore 注释与 watchHealth/directMountFlow 双锚测）。
 */
import type { TreeStore, DirectStore } from '@bhxch/vviewer-core';
import {
  createSingleFileStore,
  createUrlStore,
  createLocalFsStore,
  createLocalFilesStore,
  createRemoteStore,
  createS3DirectStore,
  createDavDirectStore,
  ensurePermission,
  isAbortError,
  normalizeServerBase
} from '@bhxch/vviewer-core';
import { ARCHIVE_OPEN_EVENT } from '@bhxch/vviewer-render-archive';
import { saveDirHandle, loadDirHandle } from './stores/session';
import type { WorkspaceSource } from './workspaceStore';
import { workspaceStore } from './workspaceStore';
import { loadSettings } from './stores/settings';
import { directConfigOf, type DirectMountRecord } from './mountsSync';
import {
  addTab,
  addDirStoreTab,
  addDirTabForRestore,
  storeById,
  tabStore,
  workspacesView
} from './tabsModel.svelte';
import { showStatusNotice, serverLabel, wireStoreWatch } from './serverConnect.svelte';

export * from './tabsModel.svelte';
export * from './serverConnect.svelte';
export * from './serverCapsCache';

export function openFiles(files: File[]): void {
  // File.size 随链路透传（拖拽打开即可知大小，io-streaming Task 4）
  for (const f of files) addTab(createSingleFileStore(f), f.name, f.name, f.size);
}

/**
 * boot 后是否已有用户操作（restore 快点击竞态防线，T7）：__vvOpenDirImpl 注入钩子
 * 与 TopBar 的打开入口在模块初始化即可用，早于 AppShell.restore 的异步 IndexedDB
 * 读取完成——并行加载/慢盘下，用户（或 e2e 注入）的打开会先于快照进入模型。
 * 启动基线是「单个默认组、无来源、无 tab」，故三者任一成立即发生过用户操作：
 * restore 据此分流——无活动照旧 replaceAll 整体恢复，有活动改 mergeSnapshot 合并
 * （replaceAll 会抹掉已登记的来源而 tab 留存，左栏树与 tab 集合脱节）。
 * 在决策点（await 之后、落模型之前）调用，天然覆盖等待期间到达的操作。
 */
export function hasUserActivity(): boolean {
  return (
    tabStore.list.length > 0 ||
    workspaceStore.list.length > 1 ||
    workspaceStore.list.some((w) => w.sources.length > 0)
  );
}

export async function openDirectoryViaPicker(): Promise<void> {
  const w = window as unknown as {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof w.showDirectoryPicker !== 'function') {
    openDirectoryViaInputFallback();
    return;
  }
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await w.showDirectoryPicker({ mode: 'read' });
  } catch (err) {
    // BUG-19：用户取消（headless/自动化下立即取消）此前零反馈——接入状态栏一次性提示
    // （审计 R1 I-3：第四份内联 AbortError 判定迁移 core 单源 isAbortError；Error+name
    // 形态改判为取消对 picker 取消语义更正确，单支判定迁移属行为微扩，审计已定性）
    if (isAbortError(err)) {
      showStatusNotice('已取消选择文件夹');
      return;
    }
    throw err;
  }
  await saveDirHandle(handle);
  addDirStoreTab(createLocalFsStore(handle));
}

/**
 * 已保存文件夹授权重开（目录管理页组③「打开」动作，spec §5 阶段四）：kv
 * 'dirHandle' 单槽句柄经 ensurePermission 重授权后走 addDirStoreTab 目录 tab
 * 通道（与 openDirectoryViaPicker 同一落点，免重新弹 picker）。无句柄/授权被拒
 * 以状态栏一次性提示反馈（BUG-19 通道），不静默。
 */
export async function openSavedDirectory(): Promise<void> {
  const handle = await loadDirHandle();
  if (handle === null) {
    showStatusNotice('没有已保存的文件夹授权');
    return;
  }
  if (!(await ensurePermission(handle))) {
    showStatusNotice('文件夹授权已失效，请重新选择');
    return;
  }
  addDirStoreTab(createLocalFsStore(handle));
}

export function openDirectoryViaInput(files: FileList | File[]): void {
  const all = Array.from(files);
  if (all.length === 0) {
    // 空目录（input webkitdirectory 选空文件夹 / 拖入空目录）：此前静默无反馈，
    // 状态栏一次性提示说明原因（遗留 U1）
    showStatusNotice('所选文件夹为空');
    return;
  }
  const firstPath = all.find((f) => f.webkitRelativePath !== '')?.webkitRelativePath;
  const label = (firstPath ? firstPath.split('/', 1)[0] : undefined) ?? 'folder';
  // webkitdirectory 真实 input 的 File 必带 webkitRelativePath；
  // 其他通道缺失时用 `<label>/文件名` 兜底，避免空路径文件在 store 里变成僵尸条目
  const normalized = all.map((f) => {
    if (f.webkitRelativePath !== '') return f;
    const copy = new File([f], f.name, { type: f.type, lastModified: f.lastModified });
    Object.defineProperty(copy, 'webkitRelativePath', { value: `${label}/${f.name}`, configurable: true });
    return copy;
  });
  addDirStoreTab(createLocalFilesStore(normalized, label));
}

function openDirectoryViaInputFallback(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.webkitdirectory = true;
  input.onchange = () => {
    if (input.files) openDirectoryViaInput(input.files);
  };
  // BUG-19：webkitdirectory 回退通道的用户取消此前零反馈——cancel 事件接同一文案
  input.oncancel = () => showStatusNotice('已取消选择文件夹');
  input.click();
}

/**
 * 后端路径来源（T5）：多根服务器的指定根/根内子目录（或根内单文件）作为来源——
 * createRemoteStore 显式携带 rootIndex/basePath（storeId 的 basePath 段是 32 位
 * FNV 指纹，恢复链路从快照 sources[] 读取，绝不反解）+ addSource + 目录 tab
 * （path=''，basePath 为源根）；opts.file 提供时为单文件来源（spec：远端来源仅
 * 目录或单文件）——底层模型仍以 basePath 目录为源（RemoteStore 以目录为粒度），
 * 额外打开该文件的 tab；同目录多个单文件来源共享同一 storeId（addSource 去重）。
 * WS-07：opts.size 为树条目宣告的文件字节数（/api/tree 对 file 条目返回 size）——
 * 随 addTab 写入 Tab.source.size（io-streaming 读策略消费，免二次探测），服务端
 * 未宣告/旧形状缺省 null（走 head 探测，与 url 打开同口径）。
 * 重复打开防线：先按 storeBase+rootIndex+basePath 查各 workspace 已登记来源，
 * 命中且实例存活（storeById）直接复用——再 createRemoteStore 会得到同 id 新实例
 * 而旧实例 SSE 流未关（双流）；实例已随最后一个 tab 关闭释放时才走新建
 * （close() 已清资源表，新实例重新登记）。
 */
export function openRemoteSource(
  base: string,
  token: string | null,
  rootIndex: number,
  basePath: string,
  opts?: { file?: string; size?: number | null }
): void {
  const file = opts?.file;
  const fileSize = opts?.size ?? null;
  const normBase = normalizeServerBase(base);
  const normPath = basePath.replace(/^\/+|\/+$/g, ''); // 与 RemoteStore 内部归一同款
  // 单文件来源 tab 路径为源相对（与树行/读路径同基准）：file 是根相对（RemoteSourceModal
  // 以「当前目录 + 文件名」拼合传入），有 basePath 时剥前缀换算——否则 read 经
  // toServerPath 再拼前缀成双重前缀（sub/sub/x），首开即 404
  const fileRel =
    file !== undefined && normPath !== '' && file.startsWith(`${normPath}/`)
      ? file.slice(normPath.length + 1)
      : file;
  for (const w of workspacesView.list) {
    const src = w.sources.find(
      (s) =>
        s.kind === 'remote' &&
        s.storeBase === normBase &&
        (s.rootIndex ?? 0) === rootIndex &&
        (s.basePath ?? '') === normPath
    );
    if (src === undefined) continue;
    const store = storeById(src.storeId);
    if (store === null) continue; // 该来源的 tab 已全部关闭：走新建
    const source: WorkspaceSource = {
      kind: 'remote',
      storeId: store.id,
      storeLabel: store.displayName(),
      storeBase: normBase,
      ...(rootIndex !== 0 ? { rootIndex } : {}),
      ...(normPath !== '' ? { basePath: normPath } : {})
    };
    if (file === undefined) addDirStoreTab(store, source);
    else {
      workspaceStore.addSource(workspaceStore.activeId, source);
      addTab(store, fileRel!, fileRel!.split('/').pop() ?? fileRel!, fileSize);
    }
    return;
  }
  // label 单一出处（终审 I-2）：label 参与 storeId hash（remote:${hash8(
  // `${base}:${label}`)})，恒取 remoteSourceLabel 派生值——管理页「在树中打开」
  // 与 RemoteSourceModal 打开同一 rootIndex/basePath 得到同一 storeId（覆写口
  // 已删：异 label 会为同根造出第二个 storeId，双 SSE 流/双树行）。快照恢复链
  // 以 sources[].storeLabel 原值回环，storeLabel 即创建时本函数的派生值，天然
  // 一致（reconnectRemoteStore I-1）。
  const label = remoteSourceLabel(normBase, rootIndex, normPath, file);
  const store = createRemoteStore(normBase, token, label, {
    rootIndex,
    ...(normPath !== '' ? { basePath: normPath } : {})
  });
  // SSE 接线与 connectServer 同款（FE-1 归一进 serverConnect.wireStoreWatch）：
  // autoRefresh 关闭时回调过滤（手动刷新 ↻ 不受影响）、watch-error 置状态栏降级指示
  wireStoreWatch(store);
  // 登记显式携带 rootIndex/basePath（sourceOf 派生不出多根字段——T3 指纹约束）；
  // 根 0 无 basePath 时省略两字段：与 connectServer 登记形状一致，快照迁移/恢复兼容
  const source: WorkspaceSource = {
    kind: 'remote',
    storeId: store.id,
    storeLabel: label,
    storeBase: normBase,
    ...(rootIndex !== 0 ? { rootIndex } : {}),
    ...(normPath !== '' ? { basePath: normPath } : {})
  };
  if (file === undefined) addDirStoreTab(store, source);
  else {
    workspaceStore.addSource(workspaceStore.activeId, source);
    addTab(store, fileRel!, fileRel!.split('/').pop() ?? fileRel!, fileSize);
  }
}

/**
 * 直连挂载 store 创建（目录挂载 spec §4 阶段三，评审带入①创建分派点——remote/
 * localfs 等既有工厂分派处扩 direct 两类）：DirectMountRecord → core 工厂
 * （配置经 mountsSync.directConfigOf 单一映射面；storeId = 记录 id）。
 * watch 接线（终审 I-1）：DirectStore.watch 契约为立即 onError（watch 恒不支持）
 * ——回调只走 console 诊断，不写 watchHealth 全局标志：direct 的 per-source
 * 「此源不支持变更推送」由 ViewerPane 按 isMountRootStoreId 派生（本不依赖该
 * 标志），而立即 onError 无条件置位会把健康 remote fs 根等非挂载来源 tab 一并
 * 污染成「自动刷新不可用」（创建期 degraded=false 复位同理会抹掉 remote 的真实
 * 降级指示）。listener 按 remote 同款 autoRefresh 过滤接线（行为面统一，未来
 * 推送面扩展零调用方改动）。
 */
export function createDirectMountStore(rec: DirectMountRecord): DirectStore {
  const cfg = directConfigOf(rec);
  const store = 'bucket' in cfg ? createS3DirectStore(cfg) : createDavDirectStore(cfg);
  store.watch(
    (paths) => {
      if (!loadSettings().autoRefresh) return;
      tabStore.refreshPaths(store.id, paths);
    },
    () => {
      console.warn('[vviewer] 直连挂载不支持变更推送，自动刷新对该来源不可用');
    }
  );
  return store;
}

/**
 * 直连挂载在树中打开（目录管理页组②「打开」动作，spec §5 阶段四）：存活实例
 * 复用（同 id 判定——直连 storeId = 记录 id，与 openRemoteSource 复用防线同
 * 语义：再建会得到同 id 新实例）+ addDirStoreTab 目录 tab 通道（跨 workspace
 * 去重激活、来源登记 sourceOf 派生 kind='direct'）。
 */
export function openDirectMount(rec: DirectMountRecord): void {
  const alive = storeById(rec.id);
  addDirStoreTab(alive ?? createDirectMountStore(rec));
}

/**
 * 直连凭据轮换生效（终审 I-3）：保存 direct 记录后调用。direct storeId 不含凭据
 * （轮换不换 id，设计如此），同 id 存活实例仍持旧凭据——行内「测试」以新凭据
 * 探测成功与已开 tab 持续 403 矛盾。关闭全部持有 tab（undoable:false——系统
 * 替换动作豁免撤销，connectServer 同 base 重连清扫同款；direct store 无 close()，
 * 随最后持有者自然失去引用）→ 注册表摘除后 storeById 返回 null，下次「打开」
 * 新建实例即持新凭据。返回关闭的 tab 数（0 = 无存活实例，幂等）。
 */
export function releaseDirectMountStore(storeId: string): number {
  const ids = tabStore.list.filter((t) => t.source.storeId === storeId).map((t) => t.id);
  for (const id of ids) tabStore.close(id, { undoable: false });
  // 台账 3-21：批量关闭（undoable:false 豁免撤销）此前静默——用户视角 tab 凭空消失。
  // 状态栏一次性提示说明去向；0 = 无存活实例（幂等调用），无动作不提示。
  if (ids.length > 0) showStatusNotice(`已关闭 ${ids.length} 个标签页（挂载已释放）`);
  return ids.length;
}

/**
 * 远端来源显示名：单文件来源取文件名；目录来源取 basePath 尾段（根整体为源时
 * 取 host）。根 0 且无 basePath 必须与 connectServer 同 label（host）——storeId
 * hash 含 label，异 label 会为同一来源造出第二个 storeId（双 SSE 流/双树行）。
 */
function remoteSourceLabel(base: string, rootIndex: number, basePath: string, file?: string): string {
  if (file !== undefined) return file.split('/').pop() ?? file;
  const host = serverLabel(base);
  if (rootIndex === 0 && basePath === '') return host;
  const tail = basePath.split('/').pop() ?? basePath;
  return rootIndex === 0 ? `${host}/${tail}` : `${host} · 根${rootIndex}/${tail}`;
}

/**
 * localfs 会话恢复（AppShell.restore 专用）：重授权成功经 addDirTabForRestore 建
 * 目录 tab 并返回 store 实例，供同源文件 tab 挂靠与来源-实例配对；权限被拒返回
 * null（调用方清除失效句柄，其余来源 tab 落占位）。wsId 为目标 workspace（恢复
 * 循环逐组调用）。非 restore 场景的目录打开走 openDirectoryViaPicker 等运行时通道。
 */
export async function tryRestoreDirectory(
  handle: FileSystemDirectoryHandle,
  wsId: string,
  opts?: { pinned?: boolean }
): Promise<TreeStore | null> {
  if (!(await ensurePermission(handle))) return null;
  const store = createLocalFsStore(handle);
  addDirTabForRestore(wsId, store, opts);
  return store;
}

export function openUrl(url: string): void {
  let name = url.split('/').pop() ?? url;
  name = name.split(/[?#]/, 1)[0] ?? name;
  try {
    name = decodeURIComponent(name);
  } catch {
    // 非法百分号编码：保留原样作为显示名
  }
  // BUG-30：尾斜杠（目录形态）URL 的 split('/').pop() 得空串——此前继续 addTab(store,'','')
  // 产出空名伪目录 tab，path==='' 与目录 tab 语义双向冲突（ViewerPane 显示「目录来源」
  // 引导而非内容/报错、纯前端档 dirStore 误解析空名 URL store、addDirStoreTab 的
  // path==='' 替换扫描把它当目录 tab 静默误关）。目录形态 URL 明确拒绝：状态栏一次性
  // 提示说明，不建 tab（真实目录请走「连接服务器」/打开文件夹通道）。
  if (name === '') {
    showStatusNotice('URL 以 / 结尾：指向目录而非文件，未打开');
    return;
  }
  // url 打开时大小未知：显式 null（读策略走 head 探测）
  addTab(createUrlStore(url), name, name, null);
}

/**
 * 监听 render-archive 的包内文件点击事件（ARCHIVE_OPEN_EVENT）→ addTab 派发器自然路由。
 * AppShell onMount 调用一次；返回解绑函数（HMR/卸载用）。
 */
export function bindArchiveOpenEvents(): () => void {
  const handler = (ev: Event): void => {
    const detail = (ev as CustomEvent<{ store: TreeStore; path: string; name: string; size?: number | null }>).detail;
    if (!detail || typeof detail.path !== 'string') return;
    // size 随事件透传（io-streaming Task 4，ArchiveOpenDetail.size 源自条目 TreeNode.size）；无来源传 null
    addTab(detail.store, detail.path, detail.name, detail.size ?? null);
  };
  window.addEventListener(ARCHIVE_OPEN_EVENT, handler);
  return () => window.removeEventListener(ARCHIVE_OPEN_EVENT, handler);
}

// E2E 调试钩子：webkitdirectory input 与 FS Access 均无法被 Playwright 自动化，
// 测试在 page.evaluate 内构造带 webkitRelativePath 的 File 数组后经此注入，
// 走与真实 input change 完全相同的 openDirectoryViaInput 通道。生产环境无调用方，无害。
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__vvOpenDirImpl = (files: FileList | File[]) =>
    openDirectoryViaInput(files);
}
