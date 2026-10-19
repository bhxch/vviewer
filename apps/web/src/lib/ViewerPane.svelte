<script lang="ts">
  import type { RenderedInstance, TocEntry, ComputeWhere } from '@vviewer/core';
  import { showErrorCard } from '@vviewer/core';
  import { isAbortError } from '@vviewer/render-text';
  import type { CodeEngine, CodeFileMeta } from '@vviewer/render-text';
  import type { MarkdownEngineState } from '@vviewer/render-text/markdown/markdownRenderer';
  import type { Tab } from './openFlow.svelte';
  import { persistScroll, tabStore } from './openFlow.svelte';
  import { setFileMeta, setInspector, inspectorBus, setExportHandle, type FileOpenWith, type InspectorSnapshot } from './metaStore.svelte';
  import { openWithOf } from './openWith';
  import { candidatesOf, type RendererCandidate } from './RendererPickerMenu';
  import { mergeAbortSignals } from './mergeAbortSignals';
  import { dispatcher, registry, cancelMarkdownRemote } from './viewer';
  import { cancelHighlight } from './highlightClient';
  import { codeLineMetrics } from './theme';
  import { loadSettings } from './stores/settings';
  import { watchHealth, statusNotice } from './openFlow.svelte';
import SearchPanel from './SearchPanel.svelte';

  let { tab, ontoc }: { tab: Tab | null; ontoc?: (entries: TocEntry[]) => void } = $props();

  /** 引擎指示器文案（F4 状态栏） */
  const ENGINE_LABELS: Record<CodeEngine, string> = {
    pending: '高亮: 解析中…',
    'tree-sitter': '高亮: tree-sitter',
    hljs: '高亮: hljs 兜底',
    'hljs-block': '高亮: hljs 分块',
    plain: '纯文本'
  };

  /** markdown 正文引擎文案（M7：local/remote 即执行位置，同一状态栏复用）。
   * 无 pending：markdown 实例仅在渲染完成后创建，getEngine 无观察窗口（遗留 T1） */
  const MARKDOWN_ENGINE_LABELS: Record<MarkdownEngineState, string> = {
    local: '渲染: 本地',
    remote: '渲染: 远程'
  };

  let host = $state<HTMLElement | null>(null);
  /** UI 镜像（SearchPanel 模板读取）。注意：渲染 effect 体内不得读它——
   * effect 依赖自身写入的 state 会无限重渲染，生命周期一律走非响应式的 live。 */
  let instance = $state<RenderedInstance | null>(null);
  /** 当前实例的生命周期持有者（非响应式）：destroy/方法调用都经它 */
  let live: RenderedInstance | null = null;
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
  let pickerOpen = $state(false);
  let pickerEl = $state<HTMLElement | null>(null);
  let pickerBtn = $state<HTMLElement | null>(null);

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

  /** 双入口共用选择语义（MetaPanel onOpenWith 同款）：'' = 清除 override 回自动，
   * 其余写持久 override——rev++ 复用渲染 effect 重跑通道即时生效。 */
  function pickRenderer(id: string): void {
    pickerOpen = false;
    const t = tab;
    if (!t) return;
    tabStore.setRendererOverride(t.id, id === '' ? null : id);
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

  function watchEngine(inst: RenderedInstance): void {
    if (!('getEngine' in inst)) return;
    // code 实例带 getComputeWhere（高亮引擎 + 计算执行位置，M6）；
    // markdown 实例（M7）只有 getEngine，local/remote 即正文引擎与执行位置。
    if ('getComputeWhere' in inst) {
      const engine = (inst as { getEngine(): CodeEngine }).getEngine;
      const where = (inst as { getComputeWhere(): ComputeWhere | null }).getComputeWhere;
      const read = (): void => {
        engineLabel = ENGINE_LABELS[engine()];
        const w = where();
        computeWhereLabel = w === 'remote' ? '远程' : w === 'local' ? '本地' : '';
      };
      read();
      engineTimer = setInterval(read, 250);
      return;
    }
    const engine = (inst as { getEngine(): MarkdownEngineState }).getEngine;
    const read = (): void => {
      engineLabel = MARKDOWN_ENGINE_LABELS[engine()];
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
    if (m.lang) parts.push(`语言: ${m.lang}`);
    if (m.encoding) parts.push(`编码: ${m.encoding}`);
    if (m.size !== undefined) parts.push(`大小: ${m.size}`);
    // 行段仅 code 实例提供（markdown/html 渲染视图无行概念）
    if (m.lines !== undefined) parts.push(`行: ${m.lines}`);
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

  $effect(() => {
    if (!host || !tab || tab.source.path === '') return;
    const current = tab;
    void current.rev; // SSE 变更刷新：读入 rev 使 effect 依赖它，自增即重跑（重读+重渲染）
    let cancelled = false;
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
        const res = await dispatcher.dispatch(current.source, null, host, {
          rendererOverride: current.overrideRenderer,
          // 渲染级取消（审计 R1）：透传给异步渲染器的迟到落定校验（image 解码窗）；
          // read 内的合并 signal 为读通道取消，两者同源不同路
          signal: effectAbort.signal,
          // 行高联动（字体系统 spec §3）：code/hex 以此重建虚拟滚动器
          lineMetrics,
          // signal 透传（流式硬化 + Task 5 effect 级取消）：实例级 signal 与
          // effectAbort.signal 合并（缺省直通，双侧缺省维持无 opts 调用形态）
          read: (range, signal) => {
            const merged = mergeAbortSignals(signal, effectAbort.signal);
            return current.source.store.read(
              current.source.path,
              range !== undefined || merged !== undefined ? { range, signal: merged } : undefined
            );
          }
        });
        if (cancelled) {
          res.instance.destroy();
          return;
        }
        live = res.instance;
        instance = res.instance;
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
        // 导出句柄上行（md-export Task 2）：markdown 实例提供 getExportDocument
        // （getToc 同款鸭子探测，不动 core 类型）；其余渲染器/降级实例清空——
        // MetaPanel「导出」动作区以句柄可得性显隐（overrideRenderer 指向 markdown
        // 时句柄可得，同样显示）
        const readExport = (res.instance as { getExportDocument?: () => Document | null }).getExportDocument;
        setExportHandle(typeof readExport === 'function' ? readExport.bind(res.instance) : null);
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
        // store.read 失败（如会话占位 tab、句柄失效）也走错误卡片；abort 不上屏
        //（deferred 清偿 Task 5 裁决）：effect 级/实例级取消的 AbortError 不落读取
        // 失败卡片——取消不是读失败，静默 return 交新一轮渲染接管（dispatch 侧
        // no-op 实例分支同裁决；cancelled 面已覆盖 cleanup 先于 reject 的形态，
        // 此处补「abort 错误 + 未 cancelled」的显式静默面）
        if (cancelled || !host || isAbortError(err)) return;
        const message = err instanceof Error ? err.message : String(err);
        live = showErrorCard(host, message, current.source);
        instance = live;
        // 错误卡片实例无导出句柄：导出动作区随句柄清空不显示
        setExportHandle(null);
        // 错误卡片实例无 meta：状态栏元数据段清空，属性面板保留名称/来源占位
        metaLabel = '';
        // 读取失败卡片：指示器/候选随实例清空（浮层一并关）
        rendererLabel = '';
        detLabel = '';
        openWithCandidates = [];
        pickerOpen = false;
        setFileMeta({ name: current.source.name, sourceLabel: current.source.storeLabel });
      }
    })();
    return () => {
      cancelled = true;
      effectAbort.abort(); // effect 级取消：pre-instance 在飞读即刻 reject（见上注）
      cancelAnimationFrame(rafId);
      stopWatchEngine();
      stopWatchMeta(); // meta 轮询随实例销毁停止（readInstanceMeta 通道上行面）
      rendererLabel = ''; // Task 3 指示器随实例销毁清空（候选/浮层一并复位）
      detLabel = '';
      openWithCandidates = [];
      pickerOpen = false;
      setFileMeta(null); // tab 切换/销毁：属性面板随之清空
      setExportHandle(null); // tab 切换/销毁：导出动作区随句柄清空（md-export Task 2）
      ontoc?.([]); // tab 切换/销毁：右栏目录随之清空
      scrollHost?.removeEventListener('scroll', onScroll);
      scrollHost = null;
      cancelHighlight(); // 取消未完成的 tree-sitter 高亮请求（Worker 不做无用功）
      cancelMarkdownRemote(); // 取消在途远程 markdown 渲染（auto 已回退本地/remote 走错误路径，不留无主连接）
      searchOpen = false; // 实例随 tab 销毁：面板状态一并复位（markdown 的 mark 在 destroy 内还原）
      live?.destroy();
      live = null;
      instance = null;
    };
  });

  function onScroll(e: Event): void {
    const t = tab;
    if (!t) return;
    void persistScroll(t.id, (e.currentTarget as HTMLElement).scrollTop);
  }
</script>

<div class="vv-viewer-pane">
  <div class="vv-viewer-scroll" onscroll={onScroll}>
    {#if !tab}
      <div class="vv-empty">拖入文件/文件夹，或使用顶栏打开</div>
    {:else if tab.unrestorable && tab.source.path === ''}
      <div class="vv-empty">此来源无法自动恢复，请重新打开文件夹</div>
    {:else if tab.source.path === ''}
      <div class="vv-empty">目录来源：文件在左侧树中打开</div>
    {:else}
      <div
        class="vv-viewer-host"
        bind:this={host}
        tabindex="-1"
      ></div>
    {/if}
  </div>
  {#if searchOpen && instance}
    <SearchPanel
      instance={instance}
      onclose={() => {
        searchOpen = false;
      }}
    />
  {/if}
  {#if engineLabel || metaLabel || rendererLabel || watchHealth.degraded || statusNotice.text}
    <div class="vv-statusbar" role="status">
      {#if rendererLabel}<button type="button" class="vv-status-openwith" bind:this={pickerBtn} aria-haspopup="menu" aria-expanded={pickerOpen} aria-label="打开方式" title="打开方式（点击切换渲染器）" onclick={togglePicker}>打开方式: {rendererLabel}{#if detLabel}&nbsp;（{detLabel}）{/if}</button>{/if}{#if engineLabel}{#if rendererLabel}&nbsp;·&nbsp;{/if}{engineLabel}{#if computeWhereLabel}&nbsp;· 执行: {computeWhereLabel}{/if}{/if}{#if metaLabel}{#if engineLabel || rendererLabel}&nbsp;·&nbsp;{/if}{metaLabel}{/if}{#if watchHealth.degraded}{#if engineLabel || metaLabel || rendererLabel}&nbsp;·{/if} 自动刷新不可用{/if}{#if statusNotice.text}{#if engineLabel || metaLabel || rendererLabel || watchHealth.degraded}&nbsp;·{/if} {statusNotice.text}{/if}
    </div>
  {/if}
  {#if pickerOpen}
    <!-- 渲染器候选浮层（Task 3 壳 A）：absolute 于 .vv-viewer-pane（position:relative
         已有，SearchPanel 同锚），状态栏上方左对齐；项形态对齐 .vv-tabctx-item，
         当前项以 ✓ 前缀 + aria-current 标记（右键子菜单同款） -->
    <div class="vv-status-picker" role="menu" aria-label="打开方式" bind:this={pickerEl}>
      {#each openWithCandidates as c (c.id)}
        <button
          type="button"
          class="vv-status-picker-item"
          role="menuitem"
          aria-current={c.current ? 'true' : undefined}
          onclick={() => pickRenderer(c.id)}>{c.current ? '✓ ' : ''}{c.label}</button
        >
      {/each}
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
