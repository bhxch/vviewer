<script lang="ts">
  import { untrack } from 'svelte';
  import type { RenderedInstance, TocEntry, ComputeWhere } from '@bhxch/vviewer-core';
  import { getRemoteBase, showErrorCard, extractExtension, type ReadProgressEvent } from '@bhxch/vviewer-core';
  import { isAbortError, TREE_SITTER_MAX_BYTES } from '@bhxch/vviewer-render-text';
  import type { CodeEngine, CodeFileMeta } from '@bhxch/vviewer-render-text';
  import type { OutlineEntry } from '@bhxch/vviewer-highlight';
  import type { MarkdownEngineState } from '@bhxch/vviewer-render-text/markdown/markdownRenderer';
  import type { MermaidTheme } from '@bhxch/vviewer-render-diagram';
  import type { Tab } from './openFlow.svelte';
  import { persistScroll, tabStore } from './openFlow.svelte';
  import { setFileMeta, setInspector, inspectorBus, setExportHandle, setOutlineLineHandle, fileMeta, type FileOpenWith, type InspectorSnapshot } from './metaStore.svelte';
  import { requestMetaLangFocus } from './metaLangFocus';
  import { openWithOf } from './openWith';
  import { candidatesOf, MORE_RENDERER_ID, LESS_RENDERER_ID, type RendererCandidate } from './RendererPickerMenu';
  import { mergeAbortSignals } from './mergeAbortSignals';
  import { dispatcher, registry, cancelMarkdownRemote } from './viewer';
  import { cancelHighlight } from './highlightClient';
  import { probeGitAvailability } from './git/gitProbe';
  import { ensureGitClient, type GitBlameLine } from './git/gitClient';
  import { BLAME_MAX_COMMITS, UNCOMMITTED_SHA } from './git/gitDiff';
  import { relativeDate, repoRelPath, subjectOf } from './git/gitUi';
  import { codeLineMetrics } from './theme';
  import { loadSettings, onSettingsChanged, saveSettings } from './stores/settings';
  import { showStatusNotice, watchHealth, statusNotice } from './openFlow.svelte';
  import { isMountRootStoreId } from './serverHealthCache';
  import { createProgressTracker, dlAddressText, formatBytes, isRemoteDownload, type ProgressSnapshot } from './downloadProgress';
  import { mbToBytes, shouldConfirm } from './downloadConfirm';
  import { saveAsFailedNotice, saveDeniedNotice, isPickerDenied, pumpToWritable, saveAsTab } from './saveAs';
  import { t } from './i18n/index.svelte';
  import type { MessageKey } from './i18n/index.svelte';
  import { displayEndpointForStore } from './mountsSync';
import SearchPanel from './SearchPanel.svelte';
import DownloadProgressCard from './DownloadProgressCard.svelte';
import DownloadConfirmCard from './DownloadConfirmCard.svelte';

  let {
    tab,
    ontoc,
    onoutline,
    ongitAvailable,
    gitRepoDir
  }: {
    tab: Tab | null;
    ontoc?: (entries: TocEntry[]) => void;
    onoutline?: (entries: OutlineEntry[]) => void;
    ongitAvailable?: (a: { repoDir: string } | null) => void;
    /** 非 null = Git 段激活且探测可用（blame hover 委托挂载条件，git-panel Task 3
     *  裁决：ViewerPane 侧委托，不动 render-text 包）；null = 解绑 + 浮层即收 */
    gitRepoDir?: string | null;
  } = $props();

  /**
   * 变更推送状态段（目录挂载 spec §3）：活跃 tab 属挂载来源（remote 挂载根
   * rootIndex ≥ fsRoots、或直连 s3direct:/davdirect:——能力位 watch=false 常量，
   * isMountRootStoreId 单点判定）显示「此源不支持变更推送」；否则沿用服务端
   * watch-error 降级指示（自动刷新不可用）。两者按 tab 互斥——挂载来源本无
   * 推送面，服务端 fs watcher 降级与它无关。
   */
  const watchLabel = $derived(
    tab !== null && isMountRootStoreId(tab.source.storeId)
      ? t('viewer.statusbar.watchMountUnsupported')
      : watchHealth.degraded
        ? t('viewer.statusbar.watchDegraded')
        : ''
  );

  /** 引擎指示器目录键（F4 状态栏；值经 t() 在读取时现取——locale 切换后 ≤250ms
   * 轮询拍即取新值） */
  const ENGINE_LABEL_KEYS = {
    pending: 'viewer.engine.pending',
    'tree-sitter': 'viewer.engine.treeSitter',
    hljs: 'viewer.engine.hljs',
    'hljs-block': 'viewer.engine.hljsBlock',
    plain: 'viewer.engine.plain'
  } as const satisfies Record<CodeEngine, MessageKey>;

  /** markdown 正文引擎目录键（M7：local/remote 即执行位置，同一状态栏复用）。
   * 无 pending：markdown 实例仅在渲染完成后创建，getEngine 无观察窗口（遗留 T1） */
  const MARKDOWN_ENGINE_LABEL_KEYS = {
    local: 'viewer.engine.mdLocal',
    remote: 'viewer.engine.mdRemote'
  } as const satisfies Record<MarkdownEngineState, MessageKey>;

  let host = $state<HTMLElement | null>(null);
  /** UI 镜像（SearchPanel 模板读取）。注意：渲染 effect 体内不得读它——
   * effect 依赖自身写入的 state 会无限重渲染，生命周期一律走非响应式的 live。 */
  let instance = $state<RenderedInstance | null>(null);
  /** 当前实例的生命周期持有者（非响应式）：destroy/方法调用都经它 */
  let live: RenderedInstance | null = null;
  /** 代码视图自动换行（settings.codeWordWrap 镜像；状态栏「换行」开关文案/aria-pressed） */
  let codeWordWrap = $state(loadSettings().codeWordWrap);
  /** 当前实例支持换行切换（code 渲染器实例具 setWordWrap——状态栏开关显隐门） */
  let wrapCapable = $state(false);
  let rafId = 0;
  /** 当前 tab 的高亮引擎文案（仅 code 渲染器非空；其余渲染器不显示状态条） */
  let engineLabel = $state('');
  /** 高亮计算执行位置（M6）：'远程'/'本地'/''（'' = 未发生计算路由或非 code 实例） */
  let computeWhereLabel = $state('');
  /** 状态栏元数据段（BUG-04）：「编码: … · 语言: … · 大小: … · 行: …」（带 getMeta
   * 的实例经 startWatchMeta 首读 + 250ms 周期重读——窗口流式实例的行数/大小随加载
   * 动态增长，终审 M-3 同族；错误卡片/无 meta 实例为空段） */
  let metaLabel = $state('');
  /** code 渲染器的内部滚动容器（.vv-code-pre）；其余渲染器为 null（滚动在外层 .vv-viewer-scroll） */
  let scrollHost: HTMLElement | null = null;
  /** 引擎轮询句柄：高亮结果异步到达（pending→tree-sitter/hljs），轻量轮询反映最新值 */
  let engineTimer: ReturnType<typeof setInterval> | null = null;
  /** meta 轮询句柄：窗口流式实例的行数/大小随加载增长（watchEngine 的 250ms 同款
   * 先例；metaStore 同一上行通道），快照未变不写 */
  let metaTimer: ReturnType<typeof setInterval> | null = null;
  /** 文件内搜索面板开关（Task 6）：'/' 打开，Esc 关闭，tab 切换随之关闭 */
  let searchOpen = $state(false);
  /** 状态栏渲染器指示器（Task 3 壳 A）：生效渲染器 label + 检出扩展名。错误卡片
   * dispatch（rendererId 'error' 未注册）/store.read 失败为空 = 指示器隐藏（错误
   * 卡片自带 open-as 动作，MetaPanel 下拉仍可达）；候选与 MetaPanel 下拉同源
   * （openWithOf 一次算出双路复用），点击弹候选浮层，选择经 setRendererOverride
   * 落持久 override（MetaPanel onOpenWith 同语义）。 */
  let rendererLabel = $state('');
  let detLabel = $state('');
  let openWithCandidates = $state<RendererCandidate[]>([]);
  // 候选浮层数据（议题一）：受限候选照旧，另持 openWithOf 全量结果供展开面
  let openWithFull = $state<FileOpenWith | null>(null);
  let pickerExpanded = $state(false);
  let pickerOpen = $state(false);
  let pickerEl = $state<HTMLElement | null>(null);
  let pickerBtn = $state<HTMLElement | null>(null);

  // ---------- 下载进度卡（计划 2 Task 4，spec §6.4 加载态 loading-progress 形态） ----------
  /** 进度快照（卡片唯一数据源）：onTick 写入（节流 200ms 在 tracker 层）；null = 无
   * 在飞下载（卡不渲染）。完成/失败/取消/tab 切换随渲染 effect 生命周期清空（卸卡
   * 让位渲染/错误卡）；tracker 每 dispatch 独立建实例（per-tab/per-轮 独立进度）。 */
  let dlProgress = $state<ProgressSnapshot | null>(null);
  /** 卡片「地址」行（脱敏 display endpoint + path，dlAddressText 产出）：随 tracker
   * 装配一次（下载中不变）。 */
  let dlAddress = $state('');
  /** 当前在飞下载的取消柄（非响应式）：effect 体装配 = effectAbort（与 dispatch
   * signal 同源同柄），cancelDownload 消费，cleanup 清偿。 */
  let dlAbort: AbortController | null = null;

  /** 进度卡「取消」（spec §6.4）：abort 在飞 dispatch 的 effectAbort——泵读随 signal
   * reject，经 dispatcher 既有 abort 分类静默收场（no-op 实例/abort reject 双路都不
   * 落错误卡，取消不是读失败）+ 同步卸卡。 */
  function cancelDownload(): void {
    dlProgress = null;
    dlAddress = '';
    dlAbort?.abort();
    dlAbort = null;
  }

  // ---------- 下载确认卡（计划 2 Task 6，spec §6.4 确认门：泵前置拦截） ----------
  /** 确认卡数据（加载态区浮层，进度卡同域）：null = 无待确认下载（卡不渲染）。
   * 泵前置拦截面——渲染 effect 在 dispatch 前发现超阈值远端来源时装配（size 已知
   * 且 > settings 阈值），本组件其余路径不写。key 为确认作用域键（确认登记用）。 */
  let dlConfirm = $state<{ key: string; name: string; sizeBytes: number; rendererLabel: string } | null>(null);
  /** 已确认作用域键（effect 同步读——「开始下载」写入触发 effect 重跑过门进 dispatch；
   * 「取消」不写键不触发重跑 = 静默中止）。'' = 无确认。 */
  let dlApprovedKey = $state('');

  /** 确认作用域键：storeId/path/size 三元组——同文件重渲染（rev++/override 切换）
   * 不重复打扰；tab 切换换文件换源、文件变更（size 变）自然换键重问。 */
  function dlGateKeyOf(storeId: string, path: string, size: number | null): string {
    return `${storeId}::${path}::${size ?? ''}`;
  }

  /** 确认卡「开始下载」（spec §6.4：确认后泵才启动）：登记确认作用域键 → 渲染
   * effect 重跑过门进 dispatch（泵启动、进度卡接力）；卸卡随门通过路径
   * （gate 通过即 dlConfirm = null）。 */
  function confirmDownload(): void {
    if (dlConfirm === null) return;
    dlApprovedKey = dlConfirm.key;
    dlConfirm = null;
  }

  /** 确认卡「取消」（spec §6.4）：静默中止——不 dispatch、无在飞泵、无错误卡（与
   * 进度卡取消同域的静默面），卸卡即可；确认键不登记，同文件下次渲染重问。 */
  function cancelConfirm(): void {
    dlConfirm = null;
  }

  // ---------- 另存为（计划 2 Task 7，spec §6.4 另存为双形态 + tab 级泛化） ----------
  /** 完成态卡数据（进度卡 done 形态唯一数据源）：远端 dispatch 成功后装配；「另存为」
   * /「关闭」点击卸卡，TTL 自动卸载（DL-PROG-01「完成后卡自动卸载」锚）。本地来源
   * 无进度卡（tracker null）故无完成态。 */
  let dlDone = $state<{ name: string; totalText: string | null } | null>(null);
  /** 完成态自动卸载定时（非响应式）：手动卸卡与 effect cleanup 双路清偿 */
  let dlDoneTimer: ReturnType<typeof setTimeout> | null = null;
  /** 完成态保留时长（ms）：完成反馈窗，超时自动让位（浮层不占布局，内容并行渲染） */
  const DL_DONE_TTL_MS = 4000;

  function clearDlDone(): void {
    if (dlDoneTimer !== null) {
      clearTimeout(dlDoneTimer);
      dlDoneTimer = null;
    }
    dlDone = null;
  }

  /** 完成态「另存为」（spec §6.4）：saveAsTab 统一管线（TabContextMenu 第七动作同
   * 管道）——本地/归档面 store.read 单次在手字节；远端面 picker-first（残余 A2，
   * 见 saveAs.ts 头注：本动作由点击处理器同步进入，saveAsTab 首个 await 即
   * showSaveFilePicker，重下耗时不再受瞬态激活窗约束——泵分块直写盘）。
   * 字节在渲染实例内无取回缝，core dispatch 只交付实例——二次传输备案取舍不变；
   * 零重传形态=确认卡「下载并另存为」tee 直写。确认门自动放行：文件刚下载过（知情
   * 面已过一次）。进度反馈（评审 I-3）：远端重下复用进度卡通道——dlProgress/
   * dlAddress 直写。终审修复波 I-1 竞态守卫：自持 AbortController（pumpAbort）作
   * hooks.signal——卡上「取消」只断本重下泵不动 effectAbort（同 tab abort 不再打断
   * 渲染 streaming 实例的按需读）；onTick 捕获时 tab 引用守卫——切 tab/重渲染后迟到
   * tick 丢弃（cleanup 只清一次，旧文件进度卡不复活在新 tab）；finally 卸卡同 tab
 * 引用守卫（tab 已切换时不动新 tab 的进度面）。泵取消落 abort 身份：静默收场不落
 * 状态条（与渲染泵取消同裁决）。picker 关闭双语义（saveAs.ts isPickerDenied 注）：
 * 'denied'（浏览器拒绝）→ 状态条固定文案；'cancelled'（用户主动取消）静默维持。 */
  async function saveAsCompleted(): Promise<void> {
    const t = tab;
    if (t === null) return;
    clearDlDone();
    const pumpAbort = new AbortController(); // 自持取消柄：重下泵专用（不与 effectAbort 同源）
    const tracker = isRemoteDownload(t.source.storeId)
      ? createProgressTracker((s) => {
          if (tab !== t) return; // I-1：捕获时 tab 引用守卫——tab 已切换的迟到 tick 丢弃
          dlProgress = s;
        })
      : null;
    if (tracker !== null) {
      dlAddress = dlAddressText(
        getRemoteBase(t.source.storeId) ?? displayEndpointForStore(t.source.storeId),
        t.source.path
      );
      dlAbort = pumpAbort; // 卡上「取消」断本重下泵（cancelDownload，不动 effectAbort）
    }
    try {
      const r = await saveAsTab(t, {
        confirm: () => true,
        signal: pumpAbort.signal,
        ...(tracker !== null
          ? { onProgress: (p: ReadProgressEvent) => tracker.update(p.loaded, p.total) }
          : {})
      });
      if (r === 'denied') showStatusNotice(saveDeniedNotice()); // 浏览器拒绝：非用户取消，提示
    } catch (err) {
      if (!isAbortError(err))
        showStatusNotice(saveAsFailedNotice(err instanceof Error ? err.message : String(err)));
    } finally {
      if (tab === t) {
        dlProgress = null;
        dlAddress = '';
      }
    }
  }

  /** 「下载并另存为」选定的句柄（非响应式）：确认卡次动作在 user gesture 内 picker
   * 选定后携带确认作用域键暂存，渲染 effect 重跑（dlApprovedKey 写入触发）过门时
   * 消费（读取即清）；键比对防陈旧句柄跨 tab 误写（picker 等待期切 tab 的选择作废）。 */
  let dlSaveHandle: { key: string; handle: FileSystemFileHandle } | null = null;

  /** FS Access 可用性（「下载并另存为」按钮装配门）：showSaveFilePicker 探测，缺席
   * 环境确认卡只渲染普通下载路径（spec「无 FS Access 环境降级为普通下载路径」）。 */
  const canFsSave =
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';

  /** 确认卡「下载并另存为」（spec §6.4 双形态二）：picker 先选句柄（右键/点击的
   * user gesture 内弹出）→ 登记确认作用域键（与「开始下载」同通道触发 effect 重跑
   * 过门）→ dispatch read 闭包 tee 直写（装配见渲染 effect）。picker 关闭双语义
   * （saveAs.ts isPickerDenied 注）：AbortError（用户主动关对话框）静默留守确认卡
   * （可改选「开始下载」或「取消」）；NotAllowedError（浏览器拒绝）→ 状态条固定
   * 文案提示——用户没关任何对话框却回到原状，静默即困惑面。 */
  async function confirmSaveAsDownload(): Promise<void> {
    if (dlConfirm === null) return;
    const key = dlConfirm.key;
    const w = window as unknown as {
      showSaveFilePicker?: (opts?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
    };
    if (typeof w.showSaveFilePicker !== 'function') return; // 探测装配：按钮在场即支持
    let handle: FileSystemFileHandle;
    try {
      handle = await w.showSaveFilePicker({ suggestedName: dlConfirm.name });
    } catch (err) {
      if (isPickerDenied(err)) showStatusNotice(saveDeniedNotice()); // 浏览器拒绝：提示
      return; // AbortError（用户主动取消）：静默留守确认卡（取消不是错误）
    }
    dlSaveHandle = { key, handle };
    dlApprovedKey = key;
    dlConfirm = null;
  }

  // 浮层展开态随激活 tab 切换复位（终审 M-5，MetaPanel openWithExpanded 同款）：
  // 依赖=激活 tab id（tabStore 深代理读自动追踪），复位写非依赖的展开态——无自读
  // 自写环。展开视图经 pickerItems 随 tab 派生重建，复位仅消除跨 tab 残留语义。
  $effect(() => {
    void tabStore.list.find((x) => x.active)?.id;
    pickerExpanded = false;
  });

  // 候选浮层关闭路径收敛（Task 3 壳 A；TabContextMenu 同款思路）：Esc / 外点 /
  // 菜单项点击（pickRenderer）。指示器钮豁免外点：pointerdown 先于 click，不豁免
  // 会先关后开闪层——toggle 由 click 承担。
  $effect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') pickerOpen = false;
    };
    const onDown = (e: PointerEvent): void => {
      const t = e.target;
      if (
        t instanceof Node &&
        (pickerEl?.contains(t) === true || pickerBtn?.contains(t) === true)
      )
        return;
      pickerOpen = false;
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  });

  function togglePicker(): void {
    pickerOpen = !pickerOpen;
  }

  /** 浮层项列表（议题一 §2.2）：收起态 = 受限候选 +「更多渲染器…」哨兵；展开态 =
   * 「自动」头项 + 全量候选 +「收起附加候选」哨兵，就地切换（头项与 MetaPanel
   * openWithOptions 展开分支对称，current 为 '' 时 ✓ 落在自动项）。哨兵仅 UI
   * 语义（不进数据面），选择处 pickRenderer 拦截，项形态与受限候选同构
   * （✓/aria-current 标记复用）。 */
  const pickerItems = $derived.by(() => {
    const ow = openWithFull;
    if (!ow) return [];
    const mark = (o: { id: string; label: string }) => ({
      id: o.id, label: o.label, current: o.id === ow.current
    });
    return pickerExpanded
      ? [
          { id: '', label: t('viewer.openwith.auto'), current: ow.current === '' },
          ...ow.all.map(mark),
          { id: LESS_RENDERER_ID, label: t('viewer.openwith.less'), current: false }
        ]
      : [...openWithCandidates, { id: MORE_RENDERER_ID, label: t('viewer.openwith.more'), current: false }];
  });

  /** 双入口共用选择语义（MetaPanel onOpenWith 同款）：'' = 清除 override 回自动，
   * 其余写持久 override——rev++ 复用渲染 effect 重跑通道即时生效。 */
  function pickRenderer(id: string): void {
    if (id === MORE_RENDERER_ID) { pickerExpanded = true; return; }
    if (id === LESS_RENDERER_ID) { pickerExpanded = false; return; }
    pickerOpen = false;
    const t = tab;
    if (!t) return;
    tabStore.setRendererOverride(t.id, id === '' ? null : id);
  }

  // ---------- 语言轻入口（renderer-lang-override spec §4.2，Task 6） ----------
  // 状态栏浮层尾部的「语言」项：文案只读（激活 tab overrideLang 优先，否则自动
  // 检测回显），点击走 requestMetaLangFocus 单一跳转通道（metaLangFocus.ts）——
  // 展开右栏/开移动端抽屉/聚焦语言行由 AppShell 侧裁决，本组件不复制聚焦逻辑；
  // 语言候选计算不在此发生（本项非候选菜单，openWithOf 单机制不变量不受影响）。

  /** 浮层「语言」项文案（Task 6）：激活 tab 有 overrideLang → 「rust（手动）」；
   * 否则「自动（检测 …）」——检测语言从 fileMeta.lang 读（readInstanceMeta 上行，
   * 嗅探不回写面），缺省「自动」。 */
  const langOverrideText = $derived.by(() => {
    const tab = tabStore.list.find((x) => x.active);
    if (tab?.overrideLang) return t('viewer.lang.manual', { lang: tab.overrideLang });
    return fileMeta.lang ? t('viewer.lang.autoDetect', { lang: fileMeta.lang }) : t('viewer.lang.auto');
  });

  /** 浮层「语言」项点击：轻入口只派发跳转事件（AppShell 监听，metaLangFocus 单通道） */
  function focusMetaLang(): void {
    pickerOpen = false;
    requestMetaLangFocus();
  }

  // '/' 快捷键聚焦搜索（非输入焦点时）；Esc 在面板内部处理（SearchPanel）
  $effect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const inField =
        t !== null &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (inField) return;
      e.preventDefault();
      searchOpen = true;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 数据检查器持续上行（Task 3）：hex 实例光标移动/字节序切换无事件通道，以 250ms
  // 轮询 getInspector 快照（引擎指示器 watchEngine 的 setInterval 同款先例）；快照
  // 未变（offset/little 同值）不写，避免无效触发 MetaPanel 重渲染。非 hex 实例
  // （无 getInspector）不启动轮询、保持 null；实例销毁随 cleanup 清空区块。
  $effect(() => {
    const inst = instance;
    const read = (inst as { getInspector?: () => InspectorSnapshot | null } | null)?.getInspector;
    if (typeof read !== 'function') return;
    let lastKey = '';
    const tick = (): void => {
      const snap = read.call(inst);
      const key = snap === null ? '' : `${snap.offset}:${snap.little}`;
      if (key !== lastKey) {
        lastKey = key;
        setInspector(snap);
      }
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => {
      clearInterval(timer);
      setInspector(null);
    };
  });

  // 代码大纲异步到货上行（code-outline Task 3）：outline 请求在 renderCode 全量
  // parse 完成后才 fire-and-forget 填充（Task 2 契约），渲染返回时点的一次性读取
  // （下方渲染 effect 内 getToc 同位读）恒 []——数据检查器持续上行同款（getInspector
  // 轮询 effect 先例）：250ms 轮询 getOutline，条目数变化才上行（大纲单文件只经历
  // [] → 全量一次跳变，length 比对即足够；rev++ 重渲染换新实例由 effect 依赖重启）。
  // 无 getOutline 实例（markdown/降级/错误卡片）不启动轮询；清空职责收敛到渲染
  // effect 的跨 tab 门（见下），本 effect 与其 cleanup 均不再上行 []。
  // 空 [] 不上行（fixwave 终审 Important 的必要面）：rev++ 重渲染换新实例时 outline
  // 请求重投在飞（getOutline 暂 []），初读 [] 上行即自清空旧 entries——右栏大纲面板
  // 闪空重建（点击大纲项滚动位归零的根因之一）。旧 entries 存活到新实例 outline 到货
  // （length 跳变整体替换，AppShell pushOutlineEntries 幂等）。代价备案：同 tab 窗口
  // 内 outline 真消亡（tree-sitter 中途降级 hljs/plain、提取失败恒 []）无 length 跳变
  // 信号、旧 entries 残留至下一次跨 tab 清空（cosmetic，instance API 无「已定空」信号
  // 可辨，spec §3 行为备案）。
  // 注意（SHELL-06 e2e 实证，禁读 prop）：本 effect 的重跑发生在渲染 effect 写
  // instance 的同一 flush 内——此刻读 tab prop 会经 props getter 拉取 AppShell 侧
  // user_derived（activeTabs.find 派生），中断 flush 信号传播、吞掉渲染 effect 的
  // 重跑（tab 切换后渲染 effect 永不再执行）。effect 全程只读 instance。
  $effect(() => {
    const inst = instance;
    const read = (inst as { getOutline?: () => OutlineEntry[] } | null)?.getOutline;
    if (typeof read !== 'function') return;
    let lastLen = -1;
    const tick = (): void => {
      const entries = read.call(inst) ?? [];
      if (entries.length === lastLen) return;
      lastLen = entries.length;
      if (entries.length === 0) return; // 空 [] 不经轮询上行：跨 tab 清空由渲染 body 门承担
      onoutline?.(entries);
    };
    untrack(tick); // 初读只依赖 instance：onoutline props 引用不进依赖（AppShell 侧换引用不重启轮询）
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  });

  // 字节序下行（Task 3 裁决）：MetaPanel select 写 inspectorBus（模块级 $state），
  // 此处探测 hex 实例 setLittle 透传——MetaPanel 无 props 是 C 项约束，不经组件链。
  // 读 instance 使 effect 依赖实例：切换回 hex tab 的新实例默认小端，由总线当前值重同步。
  $effect(() => {
    const little = inspectorBus.little;
    const inst = instance;
    if (!inst) return;
    const setLittle = (inst as { setLittle?: (v: boolean) => void }).setLittle;
    if (typeof setLittle === 'function') setLittle.call(inst, little);
  });

  // ---------- blame hover 浮层（git-panel Task 3，spec §3.2） ----------
  // 挂载裁决：ViewerPane 侧事件委托，不动 render-text 包——行 DOM 每次滚动整批
  // 重建（renderCode fillRows 的 viewport.replaceChildren），行级监听必死；委托
  // 在 getScrollHost() 容器（.vv-code-pre）上 pointerover → closest('[data-line]')
  // → dataset.line（归一域 0 起）→ blame 缓存按行查询 → fixed 浮层。
  // 仅全量 code 实例：firstVisibleLine 契约面（render-text client.ts——窗口实例
  // 缺席，与大纲滚动跟随同款「仅全量」先例；markdown/hex/错误卡无此 API 同门排除）
  // 且 ≤2MB（tree-sitter 整文件域上限——spec §3.2「仅全量 parse 路径（≤2MB）」，>2MB
  // lazy 路径无 hover；常量单源 render-text strategy.ts 的 TREE_SITTER_MAX_BYTES——经
  // 包入口 façade 的 export * 链已在 "." 导出面上，fixwave 终审 Minor 收敛 import，
  // 就地复制常量作废）。
  // 懒查：首次 hover 触发全文件 blame（worker 计算 + busy 态 + 实例级缓存）；缓存
  // 生命周期 = 渲染实例（rev 重渲染换实例即失效，内容代一致性免 HEAD 比对）。
  // 收层：scrollHost scroll 捕获即收 / 指针离场 / Git 段退出与 tab 切换随本 effect
  // 清理解绑。
  type BlameTip =
    | { s: 'loading'; x: number; y: number; below: boolean; line: number }
    | {
        s: 'ready';
        x: number;
        y: number;
        below: boolean;
        author: string;
        date: string;
        subject: string;
        sha: string;
        note: string | null;
      };
  let blameTip = $state<BlameTip | null>(null);

  $effect(() => {
    const repoDir = gitRepoDir ?? null;
    const inst = instance;
    if (repoDir === null || inst === null) return;
    const firstLine = (inst as { firstVisibleLine?: unknown }).firstVisibleLine;
    if (typeof firstLine !== 'function') return;
    const readMeta = (inst as { getMeta?: () => { size?: number } }).getMeta;
    const size = typeof readMeta === 'function' ? readMeta.call(inst)?.size : undefined;
    if (typeof size !== 'number' || size > TREE_SITTER_MAX_BYTES) return;
    const pre = (inst as RenderedInstance & { getScrollHost(): HTMLElement }).getScrollHost();
    if (!pre) return;
    const t0 = tab;
    if (t0 === null) return;
    const srcPath = t0.source.path;
    const srcStore = t0.source.store;

    let cache: Map<number, GitBlameLine> | null = null;
    let cachePromise: Promise<Map<number, GitBlameLine>> | null = null;
    let truncatedNote: string | null = null;
    const ac = new AbortController();
    let hoverTimer: ReturnType<typeof setTimeout> | null = null;

    /** 全文件 blame 单飞（首 hover 触发，后续 hover 读缓存）；失败缓存空表——本
     *  实例内不重试，错误面收敛为「无浮层」（取消亦然）。 */
    const fetchBlame = (): Promise<Map<number, GitBlameLine>> => {
      if (cachePromise !== null) return cachePromise;
      cachePromise = (async () => {
        try {
          const ensure = ensureGitClient();
          if (ensure === null) return new Map<number, GitBlameLine>();
          const client = await ensure;
          // 工作区字节走 store.read 原始通道（store 寻址，与 GitSection 同轨）；
          // 读失败（文件已删）→ undefined，blame 落 HEAD 域
          const bytes = await srcStore.read(srcPath).catch(() => undefined);
          const res = await client.blame(repoDir, repoRelPath(repoDir, srcPath), bytes, srcStore, ac.signal);
          // eslint-disable-next-line svelte/prefer-svelte-reactivity -- blame 行号→归属的一次性构建缓存：存入 cache 供命令式 hover 浮层查表，不进模板/$derived
          const map = new Map<number, GitBlameLine>();
          for (const g of res.lines) {
            for (let k = 0; k < g.numLines; k++) map.set(g.line + k, g);
          }
          cache = map;
          truncatedNote = res.truncated
            ? t('viewer.blame.truncated', { limit: BLAME_MAX_COMMITS })
            : null;
          return map;
        } catch {
          cache = cache ?? new Map<number, GitBlameLine>();
          return cache;
        }
      })();
      return cachePromise;
    };

    // pointerover 去重基线（评审 Minor③）：hideTip 时重置——收层后光标原位再入
    // （同坐标）视为新 hover，不被去重丢弃
    let lastPointerX = -1;
    let lastPointerY = -1;
    const hideTip = (): void => {
      lastPointerX = -1;
      lastPointerY = -1;
      if (hoverTimer !== null) {
        clearTimeout(hoverTimer);
        hoverTimer = null;
      }
      blameTip = null;
    };

    /** 视口定位：默认悬于行上方（translateY(-100%)），上方空间不足翻行下方。 */
    const tipPos = (rect: DOMRect): { x: number; y: number; below: boolean } => {
      const below = rect.top < 120;
      return { x: rect.left, y: below ? rect.bottom + 6 : rect.top - 6, below };
    };

    const readyTip = (g: GitBlameLine, pos: { x: number; y: number; below: boolean }): BlameTip => ({
      s: 'ready',
      x: pos.x,
      y: pos.y,
      below: pos.below,
      author: g.author,
      date: g.sha === UNCOMMITTED_SHA ? t('viewer.blame.uncommitted') : relativeDate(g.timestamp),
      subject: subjectOf(g.message),
      sha: g.sha === UNCOMMITTED_SHA ? '' : g.sha.slice(0, 7),
      note: truncatedNote
    });

    const showTip = async (line: number, rect: DOMRect): Promise<void> => {
      const pos = tipPos(rect);
      if (cache === null) {
        blameTip = { s: 'loading', x: pos.x, y: pos.y, below: pos.below, line };
        const map = await fetchBlame();
        if (ac.signal.aborted) return;
        // 计算期间滚走/换行/已收层（scroll 即收）→ 不再弹出
        if (blameTip === null || blameTip.s !== 'loading' || blameTip.line !== line) return;
        const g = map.get(line);
        blameTip = g === undefined ? null : readyTip(g, pos);
        return;
      }
      const g = cache.get(line);
      blameTip = g === undefined ? null : readyTip(g, pos);
    };

    // pointerover 去重：滚动/行 DOM 整批重建（fillRows replaceChildren）后 Chrome 会
    // 对静止光标重放 pointerover（同坐标）——重放不得重臂定时器，否则「滚动即收」
    // 被重放吞掉（真实移动物理坐标必变；同行内 gutter→body 的同坐标切换重臂同内容
    // 浮层，无害）。
    const onOver = (e: PointerEvent): void => {
      if (e.clientX === lastPointerX && e.clientY === lastPointerY) return;
      const target = e.target as Element | null;
      const row = target !== null ? target.closest('[data-line]') : null;
      if (row === null || !pre.contains(row)) return;
      const line = Number((row as HTMLElement).dataset.line);
      if (!Number.isInteger(line) || line < 0) return;
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      const rect = (row as HTMLElement).getBoundingClientRect();
      if (hoverTimer !== null) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        void showTip(line, rect);
      }, 300); // spec §3.2「~300ms 延迟」
    };

    // 命名句柄：add/removeEventListener 必须同引用（effect 重绑时旧监听才真正摘除）
    const onLeave = (): void => hideTip();
    const onScroll = (): void => hideTip(); // 滚动即收（capture：内部滚动也收）
    pre.addEventListener('pointerover', onOver);
    pre.addEventListener('pointerleave', onLeave);
    pre.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      ac.abort();
      if (hoverTimer !== null) clearTimeout(hoverTimer);
      pre.removeEventListener('pointerover', onOver);
      pre.removeEventListener('pointerleave', onLeave);
      pre.removeEventListener('scroll', onScroll, { capture: true });
      blameTip = null;
    };
  });

  function watchEngine(inst: RenderedInstance): void {
    if (!('getEngine' in inst)) return;
    // code 实例带 getComputeWhere（高亮引擎 + 计算执行位置，M6）；
    // markdown 实例（M7）只有 getEngine，local/remote 即正文引擎与执行位置。
    if ('getComputeWhere' in inst) {
      const engine = (inst as { getEngine(): CodeEngine }).getEngine;
      const where = (inst as { getComputeWhere(): ComputeWhere | null }).getComputeWhere;
      const read = (): void => {
        engineLabel = t(ENGINE_LABEL_KEYS[engine()]);
        const w = where();
        computeWhereLabel = w === 'remote' ? t('viewer.compute.remote') : w === 'local' ? t('viewer.compute.local') : '';
      };
      read();
      engineTimer = setInterval(read, 250);
      return;
    }
    const engine = (inst as { getEngine(): MarkdownEngineState }).getEngine;
    const read = (): void => {
      engineLabel = t(MARKDOWN_ENGINE_LABEL_KEYS[engine()]);
    };
    read();
    engineTimer = setInterval(read, 250);
  }

  function stopWatchEngine(): void {
    if (engineTimer !== null) {
      clearInterval(engineTimer);
      engineTimer = null;
    }
    engineLabel = '';
    computeWhereLabel = '';
    metaLabel = '';
  }

  function stopWatchMeta(): void {
    if (metaTimer !== null) {
      clearInterval(metaTimer);
      metaTimer = null;
    }
  }

  /** 实例元数据 → 状态栏段 + 属性面板（BUG-04；'getMeta' in inst 探测，不动 core 类型）。
   * openWith（C 项入口 B）：dispatch 返回实例时上行候选与当前项（含渲染失败的错误
   * 卡片，候选经 openWithOf 守卫过滤），两分支共用（无 meta 实例也有打开方式下拉）；
   * null = 不显示（store.read 失败卡片/tab 清理） */
  function readInstanceMeta(
    inst: RenderedInstance,
    tabName: string,
    sourceLabel: string,
    openWith: FileOpenWith | null
  ): void {
    // 数据检查器（Task 3）不经此函数上行：此处写 setInspector 会被下方 setFileMeta
    // 的整表清空语义（?? null）立即覆盖成 no-op——初始读与持续上行统一由轮询
    // effect 的 tick() 承担（实例挂载即读一次，cursor 未定位 → null，区块隐藏）。
    const readMeta = (inst as { getMeta?: () => CodeFileMeta }).getMeta;
    if (typeof readMeta !== 'function') {
      metaLabel = '';
      setFileMeta({ name: tabName, sourceLabel, openWith });
      return;
    }
    const m = readMeta.call(inst);
    // 段序对齐 spec SHELL-12 验收文本：「语言 · 编码 · 大小 · 行」
    const parts: string[] = [];
    if (m.lang) parts.push(t('viewer.statusMeta.lang', { lang: m.lang }));
    if (m.encoding) parts.push(t('viewer.statusMeta.encoding', { encoding: m.encoding }));
    if (m.size !== undefined) parts.push(t('viewer.statusMeta.size', { size: m.size }));
    // 行段仅 code 实例提供（markdown/html 渲染视图无行概念）
    if (m.lines !== undefined) parts.push(t('viewer.statusMeta.lines', { lines: m.lines }));
    metaLabel = parts.join(' · ');
    setFileMeta({
      name: tabName,
      sourceLabel,
      encoding: m.encoding,
      lang: m.lang ?? '',
      size: m.size,
      lines: m.lines,
      openWith
    });
  }

  /**
   * 实例元数据观察（项 4，终审 M-3 同族）：首读 + 250ms 周期重读上行（数据检查器
   * 轮询 effect / watchEngine 的 setInterval 同款先例；metaStore 同一上行通道）。
   * 窗口流式实例（code/jsonl）行数/大小随加载动态增长，一次性读取使状态栏/属性
   * 面板停在首帧值——周期重读修正。快照未变不写（避免无效触发 MetaPanel 重渲染，
   * 检查器 lastKey 同款）；无 getMeta 实例只做单次读取（现状语义不变）。
   */
  function startWatchMeta(
    inst: RenderedInstance,
    tabName: string,
    sourceLabel: string,
    openWith: FileOpenWith | null
  ): void {
    stopWatchMeta();
    readInstanceMeta(inst, tabName, sourceLabel, openWith);
    const readMeta = (inst as { getMeta?: () => CodeFileMeta }).getMeta;
    if (typeof readMeta !== 'function') return;
    const keyOf = (m: CodeFileMeta): string =>
      `${m.encoding ?? ''}:${m.lang ?? ''}:${m.size}:${m.lines}`;
    let lastKey = keyOf(readMeta.call(inst));
    metaTimer = setInterval(() => {
      const key = keyOf(readMeta.call(inst));
      if (key === lastKey) return;
      lastKey = key;
      readInstanceMeta(inst, tabName, sourceLabel, openWith);
    }, 250);
  }

  /** 渲染 effect 上次见到的 tab（plain 非响应式，仅 body 内读写）：跨 tab 清空门的
   * 比对基准，语义见渲染 effect 首注释（fixwave） */
  let lastSeenTab: Tab | null = null;

  $effect(() => {
    // 跨 tab 清空门（fixwave 终审 Important）：tab 身份变化（跨 tab 切换/关闭回落/
    // 恢复首渲染）即上一 tab 的大纲不再属于当前视图，在 body 开头清空——effect 上下文
    // 内读 prop 安全；同 tab rev 重渲染（rev++/渲染器与语言 override 换实例）tab 引用
    // 不变，旧 entries 存活到新实例 outline 到货（轮询 length 跳变整体替换，
    // pushOutlineEntries 幂等），右栏大纲面板不自清空重建。清空不放 cleanup：Svelte 5
    // teardown 内读 tab prop 经 props getter 拉取 AppShell 侧 user_derived（activeTabs
    // .find 派生），中断 flush 信号传播、吞掉渲染 effect 自身的重跑（SHELL-06 e2e 实证
    // ——切换后 effect 链死亡、内容不跟随）；组件卸载仅发生在 AppShell 整体销毁，无
    // 残留面。错误卡路径在 catch 独立清空（不受豁免）。
    if (tab !== lastSeenTab) onoutline?.([]);
    lastSeenTab = tab;
    // 确认卡孤儿清偿（评审 I-1）：守卫分支（host 未挂/占位/目录 tab）return 前清
    // dlConfirm——确认等待期关 tab/切目录 tab 不留孤儿卡；门分支在守卫后装配、门
    // 通过路径另有清偿，不受影响（写非依赖 state 无自读自写环，pickerExpanded 同款）。
    // 完成态卡同域清偿（Task 7：上一轮 cleanup 已清，此处对齐防御）
    if (!host || !tab || tab.source.path === '') {
      dlConfirm = null;
      clearDlDone();
      return;
    }
    const current = tab;
    void current.rev; // SSE 变更刷新：读入 rev 使 effect 依赖它，自增即重跑（重读+重渲染）
    // 确认门（计划 2 Task 6，spec §6.4）：远端来源（R1/R2，isRemoteDownload 单源判定）
    // + size 已知 + size > 阈值 → 泵启动前显示确认卡，本轮不进渲染/泵。阈值读 settings
    // 现值（loadSettings 每轮现算，lineMetrics 同款不持副本——设置页「应用」后下一次
    // 门评估即时生效）；size 取 FileSource.size（tree 条目/File 透传——directDav
    // getcontentlength / directS3 Size / /api/tree 列表条目，非 Content-Length 头，
    // 与 dispatcher ≤1MB 直读/泵收口同源），未知归 null → 门放行（不定态下载不适用）。
    // 确认作用域键读入本 effect（dlApprovedKey 依赖）：「开始下载」写入即重跑过门，
    // 「取消」不写键不重跑 = 静默中止。确认分支 return 早于 tracker/dispatch 装配
    // ——等待期加载态区只有确认卡；早于 cleanup 注册（本轮无在飞资源可清偿），
    // 上一轮 cleanup 已清偿旧实例与 UI 态。
    const dlSize =
      typeof current.source.size === 'number' && Number.isFinite(current.source.size)
        ? current.source.size
        : null;
    const dlKey = dlGateKeyOf(current.source.storeId, current.source.path, dlSize);
    if (
      isRemoteDownload(current.source.storeId) &&
      shouldConfirm(dlSize, mbToBytes(loadSettings().storage.remoteDownloadConfirmMb)) &&
      dlApprovedKey !== dlKey
    ) {
      dlConfirm = {
        key: dlKey,
        name: current.source.name,
        sizeBytes: dlSize!,
        // 目标渲染器名（残余 A3 中性文案）：override 有效 = 显式选择定案（dispatch
        // 「命中即用」同语义，显示其 label，无偏差面）；override 缺省/无效（dispatch
        // 对未命中 id 静默走正常探测链，同无 override）时泵前置零字节读、探测链
        // （签名改派/sniff 改派/BUG-13 magic 预检）可改派——不显示可能偏差的估计
        // 渲染器名：扩展名路由命中（探测链主路）给中性限定「自动识别（按扩展名）」，
        // extless/未命中给「自动识别」。真实目标渲染器在 dispatch 内 head 探测后定案
        rendererLabel:
          (current.overrideRenderer !== undefined
            ? registry.byId(current.overrideRenderer)?.label
            : undefined) ??
          (registry.byExtension(extractExtension(current.source.name)) !== undefined
            ? t('viewer.confirm.autodetectExt')
            : t('viewer.confirm.autodetect'))
      };
      return;
    }
    dlConfirm = null;
    // 「下载并另存为」句柄消费（Task 7；评审 M-1 修后 = 自持泵 tee + buffer 直传）：
    // 确认卡次动作选定的本轮在场则自持泵 tee 直写；读取即清 + 键比对（陈旧句柄/
    // 跨 tab 误配丢弃——普通「开始下载」路径恒 null）。
    const savePick = dlSaveHandle;
    dlSaveHandle = null;
    const saveHandle = savePick !== null && savePick.key === dlKey ? savePick.handle : null;
    let cancelled = false;
    // markdown 图表主题桥的解绑句柄（异步装配成功才有值；cleanup 同步清偿）
    let offThemeBridge: (() => void) | null = null;
    // effect 级取消（deferred 清偿 Task 5）：覆盖「rev++ 早于实例 resolve」的
    // pre-instance 窗口——旧 render 在飞读无实例可 destroy，此前只能等读超时（30s）；
    // cleanup 时 abort 使在飞读即刻 reject。实例级 signal（dispatcher 渲染链透传，
    // pre-instance 面为 undefined）与之合并传入 store.read；实例建成后的在飞取消仍
    // 由实例级 controller 兜底（流式硬化 Task 3 面），两级信号互不替代
    const effectAbort = new AbortController();
    void (async () => {
      live?.destroy();
      live = null;
      instance = null;
      try {
        // 读下放 dispatch（io-streaming §3，Task 4）：buffer 直传改 null + read 闭包，
        // 全量字节不再由视图层预取——读策略（head 探测/≤1MB 直读/按需区间）由
        // dispatcher 接管。读失败经 dispatch 向上 reject（渲染前读错误不落错误卡片
        // 重试通道，消除「8KB head 截断渲染」活面），由下方 catch 走读取失败卡片。
        // 行尺度（字体系统 Task 2）：codeSize 变化经 fonts 订阅 rev++ 到达本轮渲染，
        // 每轮直读 loadSettings 现算（viewer.ts getDiagramOptions 同款模式，不持副本）
        const lineMetrics = codeLineMetrics(loadSettings().fonts.codeSize);
        // 进度卡装配（spec §6.4，计划 2 Task 4）：仅远端来源（R1 remote:/R2
        // s3direct:/davdirect:，isRemoteDownload 单源判定）建 tracker 并传
        // onReadProgress——dispatcher 的泵门即 onReadProgress 在场（Task 2 裁决），
        // 本地来源（L1–L3）不传维持既有单次 read 形态、不显示进度卡。tracker 每轮
        // dispatch 独立实例（per-tab 独立进度）；onTick 守卫两竞态：cancelled（tab
        // 切换/重渲染后的迟到 tick）与 live 非 null（错误卡 open-as/redisplay 重入
        // 泵的进度不上屏——重入完成无从在本 effect 收尾，进度卡只服务主装载流）。
        const tracker = isRemoteDownload(current.source.storeId)
          ? createProgressTracker((s) => {
              if (cancelled || live !== null) return;
              dlProgress = s;
            })
          : null;
        if (tracker !== null) {
          // 地址行（spec §6.4：脱敏 display endpoint + path）：R1 走 getRemoteBase
          //（store 建实例即登记，无记录依赖）；R2 直连回落挂载记录镜像
          // displayEndpointForStore（记录未列出过 → undefined → path-only 降级）。
          dlAddress = dlAddressText(
            getRemoteBase(current.source.storeId) ?? displayEndpointForStore(current.source.storeId),
            current.source.path
          );
          dlAbort = effectAbort; // 取消柄 = effect 级 controller（取消钮与 cleanup 同源）
        }
        // 「下载并另存为」装配（Task 7，spec §6.4 双形态二；评审 M-1 修后形态）：
        // 句柄在场 → writable 开启（失败降级普通下载路径）→ **自持泵 tee**——
        // pumpToWritable 把全量分块读逐块直写 writable 并累计 buffer。tee 严格限定
        // 自持泵通道：dispatch 内部读（headOnly 的 8KB 探测窗、streaming 按需窗）不进
        // tee——旧形态（read 闭包内 tee）会把探测块+全量双写盘产生 8KB 前缀重复的
        // 坏文件、streaming 渲染器的乱序按需窗也会污染落盘面。泵完即收口落盘，
        // dispatch 转 buffer 直传（full = buffer 零重读，进度经同款 tracker 逐块上报
        // 与 dispatch 泵同节奏）。deviation 备案：渲染仍走内存 buffer（盘 backed
        // File 交渲染需 core dispatch 接受流源，本批不动 core）——内存峰值与普通
        // 路径同；getFile 回填在 deviation 下无消费面不取，真·盘 backed 形态留 core
        // 流源接缝跟进（task-7 报告备案）。
        let pumpBuffer: Uint8Array<ArrayBuffer> | null = null;
        if (saveHandle !== null) {
          const writable = await saveHandle.createWritable().catch(() => null);
          if (writable !== null) {
            try {
              const pumped = await pumpToWritable(
                (range, signal) => {
                  const merged = mergeAbortSignals(signal, effectAbort.signal);
                  return current.source.store.read(
                    current.source.path,
                    range !== undefined || merged !== undefined
                      ? { range, signal: merged }
                      : undefined
                  );
                },
                dlSize,
                writable,
                (p) => tracker?.update(p.loaded, p.total)
              );
              pumpBuffer = pumped.buffer;
              if (pumped.writeFailed) void writable.abort().catch(() => {});
              else void writable.close().catch(() => {}); // 泵完即落盘收口（不等渲染）
            } catch (err) {
              void writable.abort().catch(() => {}); // 半成品丢弃（含取消路径）
              throw err; // 走既有 catch 分类：abort 静默 / 读失败卡片
            }
          } else {
            // 终审修复波 M-3：picker 已选定目标但 writable 开启失败（磁盘满/权限回收
            // 等）——静默降级会让「另存为」无产出无提示；状态条降级告知（既有通道）
            showStatusNotice(t('viewer.dl.directWriteFailed'));
          }
        }
        // buffer 直传（评审 M-1）：tee 自泵路径 pumpBuffer 在手（pumpFull 通道字节
        // 已全部读出+落盘），dispatch 走兼容路径 full = buffer 零重读——dispatch 内部
        // 读（探测窗/按需窗）与 tee 隔离；普通路径恒 null 维持 read 闭包流式形态
        const res = await dispatcher.dispatch(current.source, pumpBuffer, host, {
          rendererOverride: current.overrideRenderer,
          // 手动高亮语言（spec §4.1）：Task 3 setHighlightLang 写入 Tab.overrideLang，
          // 仅 code 渲染器消费（opts.lang 注入口），其余渲染器不读即零感知
          langOverride: current.overrideLang,
          // 渲染级取消（审计 R1）：透传给异步渲染器的迟到落定校验（image 解码窗）；
          // read 内的合并 signal 为读通道取消，两者同源不同路
          signal: effectAbort.signal,
          // 行高联动（字体系统 spec §3）：code/hex 以此重建虚拟滚动器
          lineMetrics,
          // 自动换行初值（settings.codeWordWrap 现读，lineMetrics 同款不持副本）；运行期
          // 变更经下方设置订阅在存活实例上 setWordWrap，仅 code 渲染器消费
          wordWrap: loadSettings().codeWordWrap,
          // signal 透传（流式硬化 + Task 5 effect 级取消）：实例级 signal 与
          // effectAbort.signal 合并（缺省直通，双侧缺省维持无 opts 调用形态）
          read: (range, signal) => {
            const merged = mergeAbortSignals(signal, effectAbort.signal);
            return current.source.store.read(
              current.source.path,
              range !== undefined || merged !== undefined ? { range, signal: merged } : undefined
            );
          },
          // 进度卡（spec §6.4）：仅远端来源 tracker 在场时传入（条件展开维持本地来源
          // 的无 onReadProgress 调用形态——Task 2「缺省零行为变化」的调用面锚；
          // buffer 直传路径泵已在 tee 段完成，onReadProgress 不再触发，传面维持）
          ...(tracker !== null
            ? { onReadProgress: (p: ReadProgressEvent) => tracker.update(p.loaded, p.total) }
            : {})
        });
        // 取消/重渲染竞态面：cancelled（cleanup 先于 resolve）与 effectAbort.signal
        // .aborted（进度卡「取消」钮先于 resolve——dispatch 对 abort 分类 resolve
        // no-op 实例，不得当作正常渲染接管）双路一致丢弃实例静默收场
        if (cancelled || effectAbort.signal.aborted) {
          // 残卡防御（评审 M-3）：abort 收场与完成态同生命周期——卸卡 + 清地址行，
          // 取消/重渲染竞态后加载态区不留最后一次快照的孤儿卡（dlAbort 引用交 cleanup 清偿）
          res.instance.destroy();
          dlProgress = null;
          dlAddress = '';
          return;
        }
        // 进度卡卸载（spec §6.4 完成态自动让位渲染）：渲染实例接管 host 前清快照
        //（tee 路径 writable 已在自持泵段收口，见上）
        dlProgress = null;
        dlAddress = '';
        // 完成态卡（Task 7，spec §6.4「完成后另存为」）：远端下载路径装配（tracker
        // 非 null），TTL 自动卸载（DL-PROG-01 完成后卡自动卸载锚）；浮层不占布局，
        // 内容渲染并行接管。「另存为」走 saveAsTab 统一管线（saveAsCompleted）。
        // 泵参与门（终审修复波 I-3）：tracker.pumped = 泵收到过 update——code/jsonl/
        // hex streaming 渲染在 range-capable 远端源只做 head 探测 + 按需窗，零全量
        // 下载零 update，此前仅以 tracker 在场门控会误闪「下载完成」卡 4 秒；tee 直写
        // 路径 pumpToWritable 经 tracker.update 置位（真实落盘下载），门照常装配。
        if (tracker !== null && tracker.pumped) {
          dlDone = {
            name: current.source.name,
            totalText: dlSize !== null ? formatBytes(dlSize) : null
          };
          dlDoneTimer = setTimeout(() => {
            dlDoneTimer = null;
            dlDone = null;
          }, DL_DONE_TTL_MS);
        }
        live = res.instance;
        instance = res.instance;
        wrapCapable = 'setWordWrap' in res.instance;
        // markdown 图表主题桥接（@bhxch/vviewer-markdown 切换）：包内不再监听 vv:* 事件，
        // 联动改为实例 API applyTheme——此处把 theme.ts（vv:appearance-applied，外观
        // 亮暗联动）与 AppShell（vv:diagram-settings-applied，mermaid 主题设置保存）
        // 派发的两事件桥接到本存活实例，就地重画 [data-mermaid]（detail 缺省时
        // applyTheme 回落渲染时快照，与原 per-instance 监听语义等价）。鸭子探测：
        // 非 markdown/降级/错误卡实例无 applyTheme 不挂监听；监听随本 effect 清理
        // 摘除（offThemeBridge），实例销毁另有 applyTheme 内部 destroyed 守卫双保险。
        const applyTheme = (
          res.instance as { applyTheme?: (opts?: { mermaidTheme?: MermaidTheme }) => void }
        ).applyTheme;
        if (typeof applyTheme === 'function') {
          const onThemeEvent = (ev: Event): void => {
            applyTheme.call(res.instance, {
              mermaidTheme: (ev as CustomEvent<{ mermaidTheme?: MermaidTheme }>).detail?.mermaidTheme
            });
          };
          document.addEventListener('vv:appearance-applied', onThemeEvent);
          document.addEventListener('vv:diagram-settings-applied', onThemeEvent);
          offThemeBridge = () => {
            document.removeEventListener('vv:appearance-applied', onThemeEvent);
            document.removeEventListener('vv:diagram-settings-applied', onThemeEvent);
          };
        }
        // BUG-04：实例元数据 → 状态栏「编码/语言/大小/行」段 + 右栏属性面板。
        // 项 4（M-3 同族）：首读 + 250ms 周期重读（窗口流式实例的行数/大小随加载
        // 动态增长，一次性读取停在首帧值）。
        // C 项入口 B：openWith 候选与当前项随 dispatch 返回上行——渲染失败的错误卡片
        // 也走本分支（rendererId 'error' 未注册，被 openWithOf 存在性守卫滤出候选，
        // current 维持 ''/自动，label 不回退英文 id）。错误卡片上的「以纯文本/以 hex
        // 打开」在卡片内部以 rendererOverride 重派 dispatch、不经 setRendererOverride，
        // 故 open-as 成功后本下拉维持「自动」不跟随（临时查看不落 override）。
        // Task 3 双入口：候选一次算出双路复用——MetaPanel 下拉（store 上行）与
        // 状态栏指示器（本地 $state）；Tab 运行时字段（lastRendererId/lastDetExt）
        // 供右键子菜单（壳 B）经 rendererCandidatesOfTab 离线组装。
        const ow = openWithOf(registry, current.overrideRenderer, res.rendererId, res.det.ext);
        openWithCandidates = candidatesOf(ow);
        openWithFull = ow;
        rendererLabel = registry.byId(res.rendererId)?.label ?? ''; // 'error' 等未注册 id → 指示器隐藏
        detLabel = res.det.ext;
        current.lastRendererId = res.rendererId;
        current.lastDetExt = res.det.ext;
        startWatchMeta(res.instance, current.source.name, current.source.storeLabel, ow);
        // BUG-09：全局搜索跳转——渲染完成后定位到命中行（消费即清，tab 切换不误触发；
        // revealLine 仅 code 实例实现，markdown/HTML 等静默跳过不阻塞打开）。
        // GrepMatch.line 为 1 起，code 行号 0 起。
        const pending = (current as { pendingLine?: unknown }).pendingLine;
        (current as { pendingLine?: unknown }).pendingLine = undefined;
        if (typeof pending === 'number' && Number.isFinite(pending)) {
          const reveal = (res.instance as { revealLine?: (line: number) => void }).revealLine;
          if (typeof reveal === 'function') reveal.call(res.instance, Math.max(0, pending - 1));
        }
        // TOC 数据上行（Task 5）：markdown 实例提供 getToc，其余渲染器清空右栏目录
        const readToc = 'getToc' in res.instance ? res.instance.getToc : null;
        ontoc?.(readToc?.() ?? []);
        // 大纲数据上行（code-outline Task 3）：getToc 同款鸭子探测并列扩展。code
        // 全量实例恒有 getOutline（请求在飞/hljs 兜底/plain 为 []，Task 2 契约），
        // 窗口/降级/错误卡实例缺席 → []；异步到货面（parse 完成后填充）由上方
        // outline 轮询 effect 承担。同 tab rev 重渲染豁免（fixwave 终审 Important）：
        // getOutline 在场 = 数据链路延续，此处不再推初读 []——旧 entries 存活到新
        // 实例 outline 到货（轮询 length 跳变整体替换，pushOutlineEntries 幂等），
        // 否则大纲点击（rev++ 通道）即自清空重建右栏面板；「实例同步可给数」形态由
        // 轮询初读（untrack tick，length -1 → N 必上行）覆盖。鸭子缺席（markdown/
        // hex/窗口降级）照旧上行 [] 显式清空一轮——同 tab 内换渲染器（code→md 等）
        // 的陈旧大纲清除主路；错误卡路径在下方 catch 独立清空（不受豁免）。
        const readOutline = 'getOutline' in res.instance ? res.instance.getOutline : null;
        if (readOutline === null) onoutline?.([]);
        // 导出句柄上行（md-export Task 2）：markdown 实例提供 getExportDocument
        // （getToc 同款鸭子探测，不动 core 类型）；其余渲染器/降级实例清空——
        // MetaPanel「导出」动作区以句柄可得性显隐（overrideRenderer 指向 markdown
        // 时句柄可得，同样显示）
        const readExport = (res.instance as { getExportDocument?: () => Document | null }).getExportDocument;
        setExportHandle(typeof readExport === 'function' ? readExport.bind(res.instance) : null);
        // 大纲滚动跟随句柄上行（code-outline Task 3）：getExportDocument 同款鸭子
        // 探测——仅全量实例有 firstVisibleLine（存在性透传，窗口 inst 缺席，Task 2
        // 契约），缺席/非函数即清空（窗口/降级路径跟随静默不启用）。AppShell 节流
        // 循环经 metaStore 总线消费（导出句柄同款命令式快照形态）。
        const readFirstLine = (res.instance as { firstVisibleLine?: () => number }).firstVisibleLine;
        setOutlineLineHandle(
          typeof readFirstLine === 'function' ? () => readFirstLine.call(res.instance) : null
        );
        // git 可用性探测上行（git-panel Task 2）：渲染完成后 fire-and-forget——
        // probe 自带目录级缓存/负缓存（同目录重复打开零 store 请求，gitProbe.ts），
        // 一切读取失败按探测口径收敛 null（Git 段不出现且负缓存不重试，头注释既定
        // 取舍）；url/zip/single 来源的 store.read 对 .git/HEAD 自然 throw → null。
        // 同 tab rev 重渲染随本 effect 重跑：probe 缓存命中零 store 成本，结果幂等
        // 上行。迟至上行由 cancelled 守卫（tab 切换/卸载后的迟到探测不误导右栏）。
        void probeGitAvailability(current.source.store, current.source.path).then(
          (hit) => {
            if (cancelled) return;
            ongitAvailable?.(hit === null ? null : { repoDir: hit.repoDir });
          },
          () => {
            if (cancelled) return;
            ongitAvailable?.(null);
          }
        );
        // 滚动恢复：目录树切换回该 tab 时回到上次位置。
        // code 渲染器滚动在内部 .vv-code-pre（外层不滚动），接 getScrollHost()；其余维持外层容器。
        const inner =
          'getScrollHost' in res.instance
            ? (res.instance as RenderedInstance & { getScrollHost(): HTMLElement }).getScrollHost()
            : null;
        if (inner) {
          scrollHost = inner;
          inner.addEventListener('scroll', onScroll);
        }
        watchEngine(res.instance); // 引擎状态条（仅 code 实例有 getEngine）
        const target: HTMLElement | null = inner ?? (host.closest('.vv-viewer-scroll') as HTMLElement | null);
        if (target && current.scrollTop > 0) {
          rafId = requestAnimationFrame(() => {
            if (cancelled) return;
            target.scrollTop = current.scrollTop;
          });
        }
      } catch (err) {
        // 进度卡随失败先卸（失败落下方错误卡片；取消/清理走 abort 静默面——两条路
        // 都不得残留进度卡）
        dlProgress = null;
        dlAddress = '';
        // store.read 失败（如会话占位 tab、句柄失效）也走错误卡片；abort 不上屏
        //（deferred 清偿 Task 5 裁决）：effect 级/实例级取消的 AbortError 不落读取
        // 失败卡片——取消不是读失败，静默 return 交新一轮渲染接管（dispatch 侧
        // no-op 实例分支同裁决；cancelled 面已覆盖 cleanup 先于 reject 的形态，
        // 此处补「abort 错误 + 未 cancelled」的显式静默面）
        if (cancelled || !host || isAbortError(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        live = showErrorCard(host, message, current.source);
        instance = live;
        // 失败态标记（评审 I-1）：lastRendererId 'error' = 错误卡片 tab 的既有标记
        //（dispatch 落错误卡片同值——成功路径 res.rendererId 同源），本 catch 路径
        // 此前不写 → saveAsDisabledOf 放行、右键「另存为」对必败重下可达。写入后
        // 打开方式子菜单按未注册 id 守卫滤除（candidatesOf 'error' 同语义），成功
        // 重渲染覆写回真实 id（字段语义不变）。
        current.lastRendererId = 'error';
        // 错误卡片实例无导出句柄：导出动作区随句柄清空不显示
        setExportHandle(null);
        // 错误卡片实例无大纲/首行句柄（code-outline Task 3）：右栏大纲清空（无
        // 切换器纯属性）+ 跟随句柄撤除——鸭子缺席路径上行 []，不抛错
        onoutline?.([]);
        setOutlineLineHandle(null);
        // 错误卡片实例无 meta：状态栏元数据段清空，属性面板保留名称/来源占位
        metaLabel = '';
        // 读取失败卡片：指示器/候选随实例清空（浮层一并关）
        rendererLabel = '';
        detLabel = '';
        openWithCandidates = [];
        openWithFull = null;
        pickerOpen = false;
        setFileMeta({ name: current.source.name, sourceLabel: current.source.storeLabel });
      }
    })();
    return () => {
      cancelled = true;
      effectAbort.abort(); // effect 级取消：pre-instance 在飞读即刻 reject（见上注）
      dlProgress = null; // 进度卡随 effect 清偿卸载（计划 2 Task 4：tab 切换/重渲染不留孤儿卡）
      dlAddress = '';
      dlAbort = null; // 取消柄引用清偿（effectAbort 已在上方 abort，取消钮此后无在飞下载可断）
      clearDlDone(); // 完成态卡随 effect 清偿卸载（Task 7：TTL 定时一并清偿）
      dlSaveHandle = null; // 未消费的句柄选择作废（陈旧键防误写消费面在本轮 body，此为兜底清偿）
      offThemeBridge?.(); // 图表主题桥随实例销毁摘除（applyTheme 通道，不跨实例泄漏）
      offThemeBridge = null;
      cancelAnimationFrame(rafId);
      stopWatchEngine();
      stopWatchMeta(); // meta 轮询随实例销毁停止（readInstanceMeta 通道上行面）
      rendererLabel = ''; // Task 3 指示器随实例销毁清空（候选/浮层一并复位）
      detLabel = '';
      openWithCandidates = [];
      openWithFull = null;
      pickerOpen = false;
      setFileMeta(null); // tab 切换/销毁：属性面板随之清空
      setExportHandle(null); // tab 切换/销毁：导出动作区随句柄清空（md-export Task 2）
      ontoc?.([]); // tab 切换/销毁：右栏目录随之清空
      // 大纲清空不在此处（fixwave）：跨 tab 清空由 body 开头的 lastSeenTab 门承担，
      // cleanup 内读 tab prop 有 flush 中断危害（见 body 首注释）；同 tab rev 重渲
      // 豁免不清空，组件卸载仅随 AppShell 整体销毁。
      setOutlineLineHandle(null); // tab 切换/销毁：滚动跟随句柄撤除（轮询 effect cleanup 双路幂等）
      scrollHost?.removeEventListener('scroll', onScroll);
      scrollHost = null;
      cancelHighlight(); // 取消未完成的 tree-sitter 高亮请求（Worker 不做无用功）
      cancelMarkdownRemote(); // 取消在途远程 markdown 渲染（auto 已回退本地/remote 走错误路径，不留无主连接）
      searchOpen = false; // 实例随 tab 销毁：面板状态一并复位（markdown 的 mark 在 destroy 内还原）
      live?.destroy();
      live = null;
      instance = null;
      wrapCapable = false;
    };
  });

  // 自动换行即时生效：设置中心「应用」/状态栏开关/Alt+Z 均落 settings.codeWordWrap，
  // 订阅回调在存活实例上原地切换（不重渲染：保持滚动位置/搜索状态/高亮缓存）
  $effect(() =>
    onSettingsChanged((s) => {
      codeWordWrap = s.codeWordWrap;
      (live as { setWordWrap?(on: boolean): void } | null)?.setWordWrap?.(s.codeWordWrap);
    })
  );

  /** 状态栏「换行」开关：读最新持久值只翻该字段（其余字段不被旧副本覆盖） */
  function toggleWordWrap(): void {
    const fresh = loadSettings();
    fresh.codeWordWrap = !fresh.codeWordWrap;
    saveSettings(fresh);
  }

  function onScroll(e: Event): void {
    const t = tab;
    if (!t) return;
    void persistScroll(t.id, (e.currentTarget as HTMLElement).scrollTop);
  }
</script>

<div class="vv-viewer-pane">
  <div class="vv-viewer-scroll" onscroll={onScroll}>
    {#if !tab}
      <div class="vv-empty">{t('viewer.empty.drop')}</div>
    {:else if tab.unrestorable && tab.source.path === ''}
      <div class="vv-empty">{t('viewer.empty.unrestorable')}</div>
    {:else if tab.source.path === ''}
      <div class="vv-empty">{t('viewer.empty.directory')}</div>
    {:else}
      <div
        class="vv-viewer-host"
        bind:this={host}
        tabindex="-1"
      ></div>
    {/if}
  </div>
  {#if dlProgress}
    <!-- 下载进度卡（计划 2 Task 4，spec §6.4）：加载态区（错误卡片同域的
         loading-progress 形态）。pane 级 absolute 浮层（SearchPanel 同锚先例）：
         host 子内容由 dispatch/showErrorCard replaceChildren 接管，Svelte 管理的
         卡不放 host 内；浮层不占流式布局——下载中不出滚动条、卸卡零位移。挂载条件
         仅 dlProgress 非空（只有渲染 effect 的远端 dispatch 装配它会写——tab 有效
         且 path 非空，目录/占位分支天然不出现）；完成/失败/取消/tab 切换 →
         dlProgress 清空即卸卡让位 -->
    <DownloadProgressCard snapshot={dlProgress} address={dlAddress} oncancel={cancelDownload} />
  {:else if dlDone}
    <!-- 完成态卡（计划 2 Task 7，spec §6.4「完成后另存为」）：下载完成反馈 + 「另存为」
         （saveAsTab 统一管线，TabContextMenu 第七动作同管道）与「关闭」，TTL 自动卸载
         （DL-PROG-01 完成后卡自动卸载锚）。浮层不占布局——内容渲染并行接管，卡只是
         反馈窗 -->
    <DownloadProgressCard
      snapshot={null}
      done={dlDone}
      oncancel={cancelDownload}
      onsaveas={() => void saveAsCompleted()}
      onclose={clearDlDone}
    />
  {/if}
  {#if dlConfirm}
    <!-- 下载确认卡（计划 2 Task 6，spec §6.4 确认门）：进度卡同域 pane 级浮层。
         泵前置拦截——渲染 effect 在 dispatch 前装配（远端来源 size 已知且超阈值），
         「开始下载」登记确认作用域键后 effect 重跑过门进 dispatch（进度卡接力），
         「下载并另存为」（Task 7 双形态二）同通道 + 句柄 tee 直写（confirmSaveAsDownload），
         「取消」静默中止（不 dispatch 无错误卡）。onsaveas 仅 FS Access 可用环境装配
         （canFsSave 探测，缺席环境降级普通下载路径）。挂载条件仅 dlConfirm 非空（门
         分支装配，门通过/取消/清理即卸） -->
    <DownloadConfirmCard
      name={dlConfirm.name}
      sizeBytes={dlConfirm.sizeBytes}
      rendererLabel={dlConfirm.rendererLabel}
      onconfirm={confirmDownload}
      oncancel={cancelConfirm}
      onsaveas={canFsSave ? () => void confirmSaveAsDownload() : undefined}
    />
  {/if}
  {#if searchOpen && instance}
    <SearchPanel
      instance={instance}
      onclose={() => {
        searchOpen = false;
      }}
    />
  {/if}
  {#if blameTip !== null}
    <!-- blame hover 浮层（git-panel Task 3）：fixed 定位随 hovered 行视口坐标
         （行 DOM 重建由委托层消化，浮层在行外自持）；pointer-events:none 不挡
         代码区 hover；上方空间不足时翻行下方（-below 修饰类去 translateY） -->
    <div
      class="vv-git-blame-pop"
      class:vv-git-blame-pop-below={blameTip.below}
      role="tooltip"
      style:left="{blameTip.x}px"
      style:top="{blameTip.y}px"
    >
      {#if blameTip.s === 'loading'}
        <span class="vv-git-blame-pop-meta">{t('viewer.blame.loading')}</span>
      {:else}
        <span class="vv-git-blame-pop-meta">{blameTip.author} · {blameTip.date}{blameTip.sha !== '' ? ` · ${blameTip.sha}` : ''}</span>
        <span class="vv-git-blame-pop-subject">{blameTip.subject}</span>
        {#if blameTip.note !== null}<span class="vv-git-blame-pop-note">{blameTip.note}</span>{/if}
      {/if}
    </div>
  {/if}
  {#if engineLabel || metaLabel || rendererLabel || watchLabel || statusNotice.text}
    <div class="vv-statusbar" role="status">
      <!-- openwith 指示器 aria-label 随可见文本动态拼接（原静态「打开方式」，a11y
           Task 2 真修）：axe label-content-name-mismatch（wcag2a）要求可见文本
           「打开方式: {渲染器}（{检出扩展名}）」含于 accessible name——label 与
           可见值逐 token 等值（&nbsp; 归一空白）；候选浮层 role=menu 的
           aria-label=「打开方式」不受影响（menu 无可见文本） -->
      {#if rendererLabel}<button type="button" class="vv-status-openwith" bind:this={pickerBtn} aria-haspopup="menu" aria-expanded={pickerOpen} aria-label={detLabel === '' ? t('viewer.statusbar.openwithAria', { label: rendererLabel }) : t('viewer.statusbar.openwithAriaExt', { label: rendererLabel, ext: detLabel })} title={t('viewer.statusbar.openwithTitle')} onclick={togglePicker}>{t('viewer.statusbar.openwithLabel')}: {rendererLabel}{#if detLabel}&nbsp;（{detLabel}）{/if}</button>{/if}{#if engineLabel}{#if rendererLabel}&nbsp;·&nbsp;{/if}{engineLabel}{#if computeWhereLabel}&nbsp;· {t('viewer.statusbar.exec', { where: computeWhereLabel })}{/if}{/if}{#if metaLabel}{#if engineLabel || rendererLabel}&nbsp;·&nbsp;{/if}{metaLabel}{/if}{#if wrapCapable}&nbsp;·&nbsp;<button type="button" class="vv-status-wrap" aria-pressed={codeWordWrap} title={t('viewer.statusbar.wrapTitle')} onclick={toggleWordWrap}>{codeWordWrap ? t('viewer.statusbar.wrapOn') : t('viewer.statusbar.wrapOff')}</button>{/if}{#if watchLabel}{#if engineLabel || metaLabel || rendererLabel}&nbsp;·{/if} {watchLabel}{/if}{#if statusNotice.text}{#if engineLabel || metaLabel || rendererLabel || watchLabel}&nbsp;·{/if} {statusNotice.text}{/if}
    </div>
  {/if}
  {#if pickerOpen}
    <!-- 渲染器候选浮层（Task 3 壳 A）：absolute 于 .vv-viewer-pane（position:relative
         已有，SearchPanel 同锚），状态栏上方左对齐；项形态对齐 .vv-tabctx-item，
         当前项以 ✓ 前缀 + aria-current 标记（右键子菜单同款） -->
    <div class="vv-status-picker" role="menu" aria-label={t('viewer.openwith.menuAria')} bind:this={pickerEl}>
      {#each pickerItems as c (c.id)}
        <button
          type="button"
          class="vv-status-picker-item"
          role="menuitem"
          aria-current={c.current ? 'true' : undefined}
          onclick={() => pickRenderer(c.id)}>{c.current ? '✓ ' : ''}{c.label}</button
        >
      {/each}
      <!-- 语言轻入口（Task 6）：浮层尾部固定项（非候选菜单项，pickerItems 之外），
           点击跳转属性面板聚焦语言行（requestMetaLangFocus 单通道，metaLangFocus.ts） -->
      <button type="button" class="vv-status-picker-lang" role="menuitem" onclick={focusMetaLang}>
        {t('viewer.lang.entry', { text: langOverrideText })}
      </button>
    </div>
  {/if}
</div>

<style>
  .vv-viewer-pane {
    /* 占满 .vv-main 的定高列：滚动区在上，引擎状态条固定底部 */
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    /* 搜索面板的定位锚（面板为右上浮层，样式在 app.css 单一来源） */
    position: relative;
  }
  .vv-viewer-scroll {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }
  .vv-empty {
    padding: 2rem;
    color: var(--ui-fg-muted);
  }
  .vv-viewer-host {
    /* 必须定高：父级 .vv-viewer-scroll 是 flex 定高滚动容器，
       min-height:100% 会让 .vv-code-pre 的 height:100% 解析为 0（overflow 裁剪成视觉空白） */
    height: 100%;
  }
</style>
