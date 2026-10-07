<script lang="ts">
  import type { RenderedInstance, TocEntry, ComputeWhere } from '@vviewer/core';
  import { showErrorCard } from '@vviewer/core';
  import type { CodeEngine } from '@vviewer/render-text';
  import type { MarkdownEngineState } from '@vviewer/render-text/markdown/markdownRenderer';
  import type { Tab } from './openFlow.svelte';
  import { persistScroll } from './openFlow.svelte';
import { dispatcher } from './viewer';
import { cancelHighlight } from './highlightClient';
import { watchHealth } from './openFlow.svelte';
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

  /** markdown 正文引擎文案（M7：local/remote 即执行位置，同一状态栏复用） */
  const MARKDOWN_ENGINE_LABELS: Record<MarkdownEngineState, string> = {
    pending: '渲染: 解析中…',
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
  /** code 渲染器的内部滚动容器（.vv-code-pre）；其余渲染器为 null（滚动在外层 .vv-viewer-scroll） */
  let scrollHost: HTMLElement | null = null;
  /** 引擎轮询句柄：高亮结果异步到达（pending→tree-sitter/hljs），轻量轮询反映最新值 */
  let engineTimer: ReturnType<typeof setInterval> | null = null;
  /** 文件内搜索面板开关（Task 6）：'/' 打开，Esc 关闭，tab 切换随之关闭 */
  let searchOpen = $state(false);

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
  }

  $effect(() => {
    if (!host || !tab || tab.source.path === '') return;
    const current = tab;
    void current.rev; // SSE 变更刷新：读入 rev 使 effect 依赖它，自增即重跑（重读+重渲染）
    let cancelled = false;
    void (async () => {
      live?.destroy();
      live = null;
      instance = null;
      try {
        const buffer = await current.source.store.read(current.source.path);
        if (cancelled || !host) return;
        const res = await dispatcher.dispatch(current.source, buffer, host);
        if (cancelled) {
          res.instance.destroy();
          return;
        }
        live = res.instance;
        instance = res.instance;
        // TOC 数据上行（Task 5）：markdown 实例提供 getToc，其余渲染器清空右栏目录
        const readToc = 'getToc' in res.instance ? res.instance.getToc : null;
        ontoc?.(readToc?.() ?? []);
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
        // store.read 失败（如会话占位 tab、句柄失效）也走错误卡片
        if (cancelled || !host) return;
        const message = err instanceof Error ? err.message : String(err);
        live = showErrorCard(host, message, current.source);
        instance = live;
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      stopWatchEngine();
      ontoc?.([]); // tab 切换/销毁：右栏目录随之清空
      scrollHost?.removeEventListener('scroll', onScroll);
      scrollHost = null;
      cancelHighlight(); // 取消未完成的 tree-sitter 高亮请求（Worker 不做无用功）
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
  {#if engineLabel || watchHealth.degraded}
    <div class="vv-statusbar" role="status">
      {#if engineLabel}{engineLabel}{#if computeWhereLabel}&nbsp;· 执行: {computeWhereLabel}{/if}{/if}{#if watchHealth.degraded}{#if engineLabel}&nbsp;·{/if} 自动刷新不可用{/if}
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
