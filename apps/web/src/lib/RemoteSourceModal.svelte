<script lang="ts">
  // RemoteSourceModal.svelte — 后端路径来源浏览（workspace T5）。消费方为
  // WorkspaceCreateModal（内嵌视图切换）：
  //   loadLastServer() 判定「已连接」（connectServer 成功即写入 sessionStorage，
  //   restore 重连同源——未连接显示引导提示）→ health 取 roots 数量与 rootPaths
  //   路径（免鉴权多根部署才有路径，token 部署/旧服务端回落序号「根 N」）→
  //   roots>1 先选根 →
  //   /api/tree?path=&root=n 逐层浏览（目录行点击进入；面包屑返回）→ 每行「作为
  //   来源」/「将当前目录作为来源」→ openRemoteSource（base/token 取
  //   loadLastServer）→ onpicked + onclose。
  // fetch/Bearer/错误文案仿 connectServer（health 免鉴权但统一带 Bearer；30s 超时
  // 对齐 core RemoteStore.request）。Esc 关闭仿 GlobalSearchPanel 双 handler 模式
  // （容器 keydown + window 兜底，target 互斥天然不双触发；内嵌于创建模态时焦点
  // 在外层时仅关本层、焦点在 body 时两层同关，语义均为「退出浏览」）。
  import { loadLastServer, openRemoteSource } from './openFlow.svelte';

  let {
    onclose,
    onpicked
  }: {
    onclose(): void;
    /** 用户选定来源并成功加入工作区后回调（区别于 Esc/✕ 的单纯关闭） */
    onpicked?(): void;
  } = $props();

  /** 会话内上次成功连接的服务器（模块加载时读一次；模态生命周期内不变） */
  const last = loadLastServer();

  /** no-server=未连接；roots=多根待选；browse=逐层浏览（含错误展示与重试） */
  let phase = $state<'no-server' | 'roots' | 'browse'>(last === null ? 'no-server' : 'roots');
  let rootsCount = $state(0);
  /** 根路径宣告（health rootPaths，遗留项-UX）：免鉴权多根部署才有；与 roots
   * 数量不一致视为不可信丢弃，回落「根 N」序号显示。 */
  let rootPaths = $state<string[]>([]);
  let rootIndex = $state(0);
  /** 当前浏览目录（相对所选根的路径；'' = 根） */
  let path = $state('');
  let entries = $state<Array<{ name: string; kind: 'dir' | 'file' }>>([]);
  let loading = $state(false);
  let error = $state('');
  let panelEl = $state<HTMLElement | null>(null);

  /** 根序号清单（health roots 为数量；each 用数字数组保持类型安全） */
  const rootIndices = $derived(Array.from({ length: rootsCount }, (_, i) => i));

  /** 根显示名：有路径宣告显示路径，否则回落「根 N」序号（旧服务端/token 部署） */
  function rootLabel(i: number): string {
    return rootPaths[i] ?? `根 ${i}`;
  }

  /** Bearer 头构造（connectServer 同款：token 空串归一 null） */
  function headers(): Record<string, string> {
    return last !== null && last.token !== null ? { authorization: `Bearer ${last.token}` } : {};
  }

  /** 挂载聚焦面板（无输入框，焦点落到容器上 Esc 才走容器通道） */
  $effect(() => {
    panelEl?.focus();
  });

  /** 挂载即探测 health（无响应式依赖：仅首跑一次，health 拿 roots 数量） */
  $effect(() => {
    void init();
  });

  async function init(): Promise<void> {
    if (last === null) return; // phase 已固定 no-server
    error = '';
    let res: Response;
    try {
      res = await fetch(`${last.baseUrl}/api/health`, {
        headers: headers(),
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(30_000) : undefined
      });
    } catch {
      error = `无法连接 ${last.baseUrl}：网络错误或地址不可达`;
      phase = 'browse';
      return;
    }
    if (!res.ok) {
      error = `服务器响应异常: HTTP ${res.status}`;
      phase = 'browse';
      return;
    }
    let body: { roots?: unknown; rootPaths?: unknown };
    try {
      body = (await res.json()) as { roots?: unknown; rootPaths?: unknown };
    } catch {
      error = 'health 响应不是有效 JSON';
      phase = 'browse';
      return;
    }
    // 服务端多根宣告（health.rs）：roots 为根数量（>1 才出现）；rootPaths 为
    // canonical 路径（免鉴权多根部署才有，遗留项-UX）——形状不信任，长度与
    // roots 不符即整体丢弃，显示回落「根 N」
    rootsCount = typeof body.roots === 'number' && body.roots > 1 ? body.roots : 0;
    rootPaths =
      rootsCount > 1 &&
      Array.isArray(body.rootPaths) &&
      body.rootPaths.length === rootsCount &&
      body.rootPaths.every((p) => typeof p === 'string' && p !== '')
        ? (body.rootPaths as string[])
        : [];
    if (rootsCount > 1) {
      phase = 'roots';
      return;
    }
    rootIndex = 0;
    phase = 'browse';
    await load('');
  }

  /** 逐层浏览：/api/tree?path=&root=n（root 0 不拼——URL 形状与历史单根一致） */
  async function load(p: string): Promise<void> {
    if (last === null) return;
    loading = true;
    error = '';
    const query = `path=${encodeURIComponent(p)}${rootIndex !== 0 ? `&root=${rootIndex}` : ''}`;
    let res: Response;
    try {
      res = await fetch(`${last.baseUrl}/api/tree?${query}`, {
        headers: headers(),
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(30_000) : undefined
      });
    } catch (err) {
      error =
        err instanceof Error && err.name === 'TimeoutError'
          ? `服务器请求超时（30s）: ${last.baseUrl}/api/tree`
          : `无法连接 ${last.baseUrl}：网络错误或地址不可达`;
      loading = false;
      return;
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === 'string') detail = `: ${body.error}`;
      } catch {
        // 非 JSON 错误体：只用状态码
      }
      error = `服务器请求失败: HTTP ${res.status}${detail}`;
      loading = false;
      return;
    }
    let body: { entries?: Array<{ name?: unknown; kind?: unknown }> };
    try {
      body = (await res.json()) as { entries?: Array<{ name?: unknown; kind?: unknown }> };
    } catch {
      error = 'tree 响应不是有效 JSON';
      loading = false;
      return;
    }
    entries = (Array.isArray(body.entries) ? body.entries : [])
      .filter((e): e is { name: string; kind: 'dir' | 'file' } =>
        typeof e.name === 'string' && (e.kind === 'dir' || e.kind === 'file')
      )
      .map((e) => ({ name: e.name, kind: e.kind }));
    path = p;
    loading = false;
  }

  /** 行内相对路径拼合（服务端 path 相对所选根，'/' 分隔） */
  function join(base: string, name: string): string {
    return base === '' ? name : `${base}/${name}`;
  }

  /** 选定来源 → openRemoteSource（归当前活动 workspace——创建模态已先建组） */
  function pick(asBasePath: string, file?: string): void {
    if (last === null) return;
    openRemoteSource(last.baseUrl, last.token, rootIndex, asBasePath, file);
    onpicked?.();
    close();
  }

  /** Esc 双 handler（GlobalSearchPanel 模式）：容器内焦点走容器 keydown；焦点在
   * 面板外（外层创建模态输入框/body）走 window 兜底 */
  $effect(() => {
    const onWinKey = (e: KeyboardEvent): void => {
      if (
        e.key === 'Escape' &&
        panelEl !== null &&
        (e.target instanceof Node ? !panelEl.contains(e.target) : true)
      ) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onWinKey);
    return () => window.removeEventListener('keydown', onWinKey);
  });

  function close(): void {
    // 关闭前记录焦点：卸载后还原（与 GlobalSearchPanel 同模式）
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onclose();
    setTimeout(() => {
      if (prev !== null && prev.isConnected) prev.focus();
    }, 0);
  }

  function onpanelkeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      // 内嵌于 WorkspaceCreateModal 时本面板是其 DOM 子节点：不阻断冒泡会让
      // 外层面板的容器 keydown（finish()）连着触发——Esc 只关浏览层
      e.stopPropagation();
      close();
    }
  }
</script>

<div class="vv-remotesrc" role="dialog" aria-label="添加后端路径来源" tabindex="-1" bind:this={panelEl} onkeydown={onpanelkeydown}>
  <div class="vv-remotesrc-head">
    <span class="vv-remotesrc-title">后端路径来源</span>
    <button type="button" class="vv-remotesrc-close" aria-label="关闭后端路径浏览" title="关闭（Esc）" onclick={close}>✕</button>
  </div>

  {#if phase === 'no-server'}
    <div class="vv-remotesrc-empty">
      尚未连接服务器。请先在顶栏「连接服务器」建立连接，再添加后端路径来源。
    </div>
  {:else if phase === 'roots'}
    <div class="vv-remotesrc-hint">该服务器有多数据根，请先选择根：</div>
    <div class="vv-remotesrc-roots">
      {#each rootIndices as i (i)}
        <button
          type="button"
          title={rootPaths[i]}
          onclick={() => {
            rootIndex = i;
            phase = 'browse';
            void load('');
          }}>{rootLabel(i)}</button
        >
      {/each}
    </div>
    {#if rootPaths.length === 0}
      <div class="vv-remotesrc-hint">服务器仅宣告根数量（无根路径），以序号表示。</div>
    {/if}
  {:else}
    {#if rootsCount > 1}
      <button type="button" class="vv-remotesrc-rootback" onclick={() => (phase = 'roots')}>
        ← 重选根（当前：{rootLabel(rootIndex)}）
      </button>
    {/if}
    <div class="vv-remotesrc-crumbs" aria-label="路径面包屑">
      <button type="button" class="vv-remotesrc-crumb" disabled={path === ''} onclick={() => void load('')}>根</button>
      {#each path.split('/') as seg, i (i)}
        <span class="vv-remotesrc-sep">/</span>
        {@const prefix = path.split('/').slice(0, i + 1).join('/')}
        <button
          type="button"
          class="vv-remotesrc-crumb"
          disabled={prefix === path}
          onclick={() => void load(prefix)}>{seg}</button
        >
      {/each}
    </div>
    <button type="button" class="vv-remotesrc-pickcurrent" disabled={loading} onclick={() => pick(path)}>
      将当前目录作为来源（{path === '' ? rootLabel(rootIndex) : path}）
    </button>
    {#if error}
      <div class="vv-remotesrc-error" role="alert">
        {error}
        <button type="button" onclick={() => void load(path)}>重试</button>
      </div>
    {:else if loading}
      <div class="vv-remotesrc-empty">加载中…</div>
    {:else if entries.length === 0}
      <div class="vv-remotesrc-empty">（空目录）</div>
    {:else}
      <ul class="vv-remotesrc-list">
        {#each entries as e (e.name)}
          <li class="vv-remotesrc-row">
            {#if e.kind === 'dir'}
              <button
                type="button"
                class="vv-remotesrc-name"
                title={join(path, e.name)}
                onclick={() => void load(join(path, e.name))}>{e.name}/</button
              >
              <button
                type="button"
                class="vv-remotesrc-pick"
                title={`将此目录作为来源：${join(path, e.name)}`}
                onclick={() => pick(join(path, e.name))}>作为来源</button
              >
            {:else}
              <span class="vv-remotesrc-name vv-remotesrc-file" title={join(path, e.name)}>{e.name}</span>
              <button
                type="button"
                class="vv-remotesrc-pick"
                title={`将此文件作为来源：${join(path, e.name)}`}
                onclick={() => pick(path, join(path, e.name))}>将此文件作为来源</button
              >
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .vv-remotesrc {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }
  .vv-remotesrc-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .vv-remotesrc-title {
    font-weight: 600;
  }
  .vv-remotesrc-close {
    border: 0;
    background: none;
    color: var(--ui-fg-muted);
    cursor: pointer;
    padding: 0 4px;
  }
  .vv-remotesrc-close:hover {
    color: var(--ui-fg);
  }
  .vv-remotesrc-hint {
    color: var(--ui-fg-muted);
    font-size: 12px;
  }
  .vv-remotesrc-roots {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .vv-remotesrc-rootback {
    align-self: flex-start;
    font-size: 12px;
  }
  .vv-remotesrc-crumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    font-size: 13px;
  }
  .vv-remotesrc-crumb {
    border: 0;
    background: none;
    color: var(--ui-accent);
    cursor: pointer;
    padding: 1px 3px;
    font: inherit;
    font-size: 13px;
    max-width: 12em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vv-remotesrc-crumb:disabled {
    color: var(--ui-fg);
    cursor: default;
    font-weight: 600;
  }
  .vv-remotesrc-sep {
    color: var(--ui-fg-muted);
  }
  .vv-remotesrc-pickcurrent {
    align-self: flex-start;
    font-size: 12px;
  }
  .vv-remotesrc-list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow: auto;
    min-height: 0;
  }
  .vv-remotesrc-row {
    display: flex;
    align-items: center;
    gap: 4px;
    border-radius: 4px;
  }
  .vv-remotesrc-row:hover {
    background: var(--ui-hover-bg);
  }
  .vv-remotesrc-name {
    flex: 1;
    min-width: 0;
    text-align: left;
    border: 0;
    background: none;
    color: var(--ui-fg);
    font: inherit;
    cursor: pointer;
    padding: 3px 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vv-remotesrc-file {
    cursor: default;
    color: var(--ui-fg-muted);
  }
  .vv-remotesrc-pick {
    flex: none;
    border: 1px solid var(--ui-border);
    background: var(--ui-side-bg);
    color: var(--ui-fg);
    border-radius: 6px;
    font-size: 12px;
    padding: 1px 8px;
    cursor: pointer;
  }
  .vv-remotesrc-pick:hover {
    color: var(--ui-accent);
    border-color: var(--ui-accent);
  }
  .vv-remotesrc-empty {
    color: var(--ui-fg-muted);
    font-size: 13px;
    padding: 8px 2px;
  }
  .vv-remotesrc-error {
    color: var(--ui-danger, #d33);
    font-size: 12px;
    display: flex;
    gap: 8px;
    align-items: baseline;
    overflow-wrap: anywhere;
  }
</style>
