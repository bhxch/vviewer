<script lang="ts">
  // MountsManager.svelte — 目录管理页（全屏 overlay，目录挂载 spec §5 阶段四）。
  // 消费方为 AppShell（TopBar 📁 与 Ctrl+Alt+M 双入口，OVERLAY_SELECTOR 入册
  // .vv-mounts-manager——zen Esc 优先级判定，设置中心 .vv-settings-center 先例）。
  // 三组展示：
  //   ①服务端根与挂载——GET /api/mounts 清单（Bearer 取会话 last-server）+
  //     health rootPaths 宣告；fs 根/静态/运行时徽标 + 能力位 + 「在树中打开」
  //     （openRemoteSource 指定 rootIndex，tab 名统一 remoteSourceLabel 形态）。
  //   ②前端配置挂载——mounts store（IndexedDB v4）direct+proxy 记录混列：
  //     直连/代理徽标、kind、展示面 endpoint、凭据已存指示、proxy 对账状态
  //     （已注册 rootIndex=N / 待注册+原因 / 未注册）；操作新增（kind→字段集
  //     切换→测试连接→保存）/编辑/删除/测试/打开（直连 openDirectMount；代理
  //     已注册走 openRemoteSource）。proxy 增删即时调 POST/DELETE /api/mounts，
  //     失败不落 IndexedDB（spec §5 一致态）；直连保存纯本地。
  //   ③本机授权来源——localfs 句柄（kv 'dirHandle' 单槽：名称+授权态，打开/
  //     清除——清除后快照 localfs 恢复失效需确认提示）与 localfiles 会话来源。
  // 警示（spec §6）：直连凭据 IndexedDB 明文可被同源脚本与本机用户提取——
  // 新增表单与列表详情双处固定渲染 CREDENTIAL_WARNING（单一出处常量）。
  // 纯逻辑（校验/装配/探测/记录构造）在 mountsManager.ts，本组件只做交互编排。
  import { onMount } from 'svelte';
  import {
    deleteMount,
    listMounts,
    registerProxyMount,
    saveDirectMount,
    saveMount,
    unregisterProxyMount,
    type MountRecord,
    type MountsManifest
  } from './mountsSync';
  import {
    assembleLocalRows,
    assembleMountRows,
    assembleServerMountRows,
    CREDENTIAL_WARNING,
    draftFromRecord,
    draftToDirectRecord,
    draftToProxyRecord,
    emptyDraft,
    formatProbeResult,
    mountFormIssues,
    mountUsageOf,
    probeDraft,
    probeRecord,
    proxyOffsiteOf,
    WEBDAV_CORS_HINT,
    type MountFormDraft,
    type ProbeResult
  } from './mountsManager';
  import {
    loadLastServer,
    openDirectMount,
    openDirectoryViaPicker,
    openRemoteSource,
    openSavedDirectory,
    releaseDirectMountStore,
    showStatusNotice,
    workspacesView
  } from './openFlow.svelte';
  import { loadDirHandle, saveDirHandle } from './stores/session';

  let { onclose }: { onclose(): void } = $props();

  /** 会话内上次成功连接的服务器（组件生命周期内不变——RemoteSourceModal 同款）。 */
  const last = loadLastServer();

  // ---------- 骨架（焦点/Esc 双通道——SettingsCenter 同模式） ----------

  let rootEl = $state<HTMLElement | null>(null);

  $effect(() => {
    // 全屏页挂载即聚焦（Esc 关闭键盘可达）
    rootEl?.focus();
  });

  $effect(() => {
    // Esc 全局化兜底：焦点落到面板外时 Esc 也走 requestClose（合成 Esc 的派发
    // 目标即根元素，容器通道为主路径）
    const onWinKey = (e: KeyboardEvent): void => {
      if (
        e.key === 'Escape' &&
        rootEl !== null &&
        (e.target instanceof Node ? !rootEl.contains(e.target) : true)
      ) {
        e.preventDefault();
        requestClose();
      }
    };
    window.addEventListener('keydown', onWinKey);
    return () => window.removeEventListener('keydown', onWinKey);
  });

  function onRootKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      // 逐层退出：表单在场时 Esc 先关表单（设置中心导入弹层同语义）
      if (formOpen) {
        closeForm();
        return;
      }
      requestClose();
    }
  }

  /** 关闭请求（✕/Esc 统一入口）：表单在场先关表单，否则关整页。AppShell 经
   * bind:this 调用（设置中心 requestClose 先例）。 */
  export function requestClose(): void {
    if (formOpen) {
      closeForm();
      return;
    }
    close();
  }

  function close(): void {
    // 关闭前记录焦点：面板卸载后还原（与 SettingsCenter 同模式）
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onclose();
    setTimeout(() => {
      if (prev !== null && prev.isConnected) {
        prev.focus();
        return;
      }
      document.querySelector<HTMLElement>('.vv-viewer-host')?.focus();
    }, 0);
  }

  // ---------- 组①：服务端根与挂载 ----------

  let serverManifest = $state<MountsManifest | null>(null);
  let rootPaths = $state<string[]>([]);
  let serverError = $state('');
  let serverLoading = $state(false);
  const serverRows = $derived(assembleServerMountRows(serverManifest, rootPaths));

  async function initServer(): Promise<void> {
    if (last === null) return; // 未连接：组①显示引导降级
    serverLoading = true;
    serverError = '';
    const headers: Record<string, string> = {};
    if (last.token !== null) headers.authorization = `Bearer ${last.token}`;
    try {
      // health rootPaths（免鉴权多根部署才宣告；token 部署回落「根 N」序号——
      // RemoteSourceModal 同款形状不信任判定）
      const health = await fetch(`${last.baseUrl}/api/health`, {
        headers,
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(30_000) : undefined
      });
      if (health.ok) {
        try {
          const body = (await health.json()) as { rootPaths?: unknown };
          if (Array.isArray(body.rootPaths) && body.rootPaths.every((p) => typeof p === 'string' && p !== '')) {
            rootPaths = body.rootPaths as string[];
          }
        } catch {
          // health 非 JSON：rootPaths 缺省（「根 N」回落），不阻断清单
        }
      }
      const res = await fetch(`${last.baseUrl}/api/mounts`, {
        headers,
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(30_000) : undefined
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Partial<MountsManifest>;
      if (!Array.isArray(body.mounts) || typeof body.fsRoots !== 'number') {
        throw new Error('清单形态不识别（旧服务端？）');
      }
      serverManifest = body as MountsManifest;
    } catch (err) {
      serverError = err instanceof Error ? err.message : String(err);
    } finally {
      serverLoading = false;
    }
  }

  /** 组①「在树中打开」：openRemoteSource 指定 rootIndex（fs 根/挂载根同一通道）。
   * 不覆写 label（终审 I-2）：label 参与 storeId hash，openRemoteSource 内恒取
   * remoteSourceLabel 派生——与 RemoteSourceModal 打开同一 rootIndex 得到同一
   * storeId（覆写会为同根造出第二个 storeId，双 SSE 流/双树行）。 */
  function openServerRoot(row: { rootIndex: number; title: string }): void {
    if (last === null) return;
    openRemoteSource(last.baseUrl, last.token, row.rootIndex, '');
  }

  // ---------- 组②：前端配置挂载 ----------

  let records = $state<MountRecord[]>([]);
  // 装配传当前连接 base（评审 M1）：proxy 注册状态徽标按 serverBase 比对——
  // 不一致显示「注册于他机」而非误导性的「已注册 rootIndex=N」
  const mountRows = $derived(assembleMountRows(records, last?.baseUrl ?? null));

  async function reloadRecords(): Promise<void> {
    try {
      records = await listMounts();
    } catch (err) {
      console.warn('[vviewer] 挂载记录读取失败', err);
      records = [];
    }
  }

  // ----- 新增/编辑表单（kind→字段集切换→测试连接→保存） -----

  let formOpen = $state(false);
  let editing = $state<MountRecord | null>(null);
  let draft = $state<MountFormDraft>(emptyDraft());
  let formIssues = $state<Partial<Record<keyof MountFormDraft, string>> | null>(null);
  let formError = $state('');
  let saving = $state(false);
  /** 测试连接状态机：null=idle；'probing'=探测中；ProbeResult=落定（成功回显
   * 条目数+延迟，失败回显错误——CORS 特征化/WebCrypto 缺失文案原样）。 */
  let probe = $state<ProbeResult | null>(null);
  let probing = $state(false);

  function openCreate(): void {
    editing = null;
    draft = emptyDraft(last?.baseUrl ?? '');
    resetFormFeedback();
    formOpen = true;
  }

  function openEdit(rec: MountRecord): void {
    editing = rec;
    draft = draftFromRecord(rec);
    resetFormFeedback();
    formOpen = true;
  }

  function resetFormFeedback(): void {
    formIssues = null;
    formError = '';
    probe = null;
    probing = false;
  }

  function closeForm(): void {
    formOpen = false;
    resetFormFeedback();
  }

  /** 测试连接：实际发一次 list_dir 探测（spec §5），结果回显在表单。先过表单
   * 校验（评审 L3）——必填缺失/L1 userinfo 时标错返回，探测不被旁路（不发无效
   * 请求、不产误导性「成功」回显）。 */
  async function runProbe(): Promise<void> {
    const issues = mountFormIssues(draft);
    formIssues = Object.keys(issues).length > 0 ? issues : null;
    if (formIssues !== null) return;
    probing = true;
    probe = null;
    probe = await probeDraft(draft);
    probing = false;
  }

  async function submitForm(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const issues = mountFormIssues(draft);
    formIssues = Object.keys(issues).length > 0 ? issues : null;
    if (formIssues !== null) return;
    saving = true;
    formError = '';
    try {
      if (draft.mode === 'proxy') {
        // proxy：先注册后落库（spec §5——失败不落 IndexedDB）。编辑且旧注册在
        // 场时先注销旧 rootIndex（凭据轮换/指纹变更皆走 DELETE+POST，S-3 同款）。
        // 评审 M1：编辑他机注册的记录被阻断——注销/重注册以当前连接令牌打
        // rec.serverBase 只会 401（死锁面），须先连接该服务器。
        const old = editing !== null && editing.kind === 'proxy' ? editing : null;
        if (old !== null && proxyOffsiteOf(old, last?.baseUrl ?? null)) {
          formError = `该挂载注册于 ${hostOf(old.serverBase)}，与当前连接的服务器不一致——注销/重注册无法以当前令牌执行；请先连接该服务器再编辑注册。`;
          return;
        }
        const rec = draftToProxyRecord(draft, old ?? undefined);
        const token = last?.token ?? null;
        if (old !== null && typeof old.registeredRootIndex === 'number') {
          await unregisterProxyMount(old, token, old.registeredRootIndex);
        }
        rec.registeredRootIndex = await registerProxyMount(rec, token);
        if (old !== null && old.id !== rec.id) await deleteMount(old.id); // 指纹变更 → id 变：旧记录清理
        await saveMount(rec);
      } else {
        // direct：纯本地保存（不经服务器）。endpoint 变更 → storeId 变：旧记录清理
        const old = editing !== null && editing.kind === 'direct' ? editing : null;
        const rec = draftToDirectRecord(draft, old ?? undefined);
        if (old !== null && old.id !== rec.id) await deleteMount(old.id);
        await saveDirectMount(rec);
        // 凭据轮换生效（终审 I-3）：direct storeId 不含凭据，同 id 存活实例仍持
        // 旧凭据（行内「测试」新凭据成功与已开 tab 持续 403 矛盾）——保存成功即
        // 释放该实例（关闭持有 tab），下次「打开」新建即新凭据；无存活实例为 no-op。
        releaseDirectMountStore(rec.id);
      }
      closeForm();
      await reloadRecords();
    } catch (err) {
      formError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  // ----- 行动作（打开/测试/编辑/删除） -----

  /** 直连行「打开」：openDirectMount 存活实例复用 + 目录 tab 通道。模板不收窄
   * 联合（svelte-check 无 {#if} 传递收窄）——kind 守卫在函数内。 */
  function openDirectRow(rec: MountRecord): void {
    if (rec.kind !== 'direct') return;
    openDirectMount(rec);
  }

  /** serverBase → host 显示（解析失败退回原串，serverLabel 同款口径）。 */
  function hostOf(base: string): string {
    try {
      return new URL(base).host;
    } catch {
      return base;
    }
  }

  /** 代理行「打开」：仅已注册且注册在当前连接服务器上时可开（评审 M1：offsite
   * 的 rootIndex 是他机命名空间——以当前连接 B + A 的 rootIndex 会开出 B 上完全
   * 不同的根；offsite 行模板本就不渲染打开钮，此处为防御性二次守卫）。不覆写
   * label（终审 I-2，openServerRoot 同理——同 rootIndex 单 storeId）。 */
  function openProxyRow(rec: MountRecord): void {
    if (rec.kind !== 'proxy' || last === null || typeof rec.registeredRootIndex !== 'number') return;
    if (proxyOffsiteOf(rec, last.baseUrl)) return;
    openRemoteSource(last.baseUrl, last.token, rec.registeredRootIndex, '');
  }

  /** 行内「测试」状态（直通行：probeRecord 同一探测面；key = 记录 id）。 */
  let rowProbes = $state<Record<string, ProbeResult | 'probing'>>({});

  async function testRow(rec: MountRecord): Promise<void> {
    if (rec.kind !== 'direct') return;
    rowProbes = { ...rowProbes, [rec.id]: 'probing' };
    const r = await probeRecord(rec);
    rowProbes = { ...rowProbes, [rec.id]: r };
  }

  async function removeRecord(rec: MountRecord): Promise<void> {
    // 删除引用回落提示（mountUsageOf）：运行中 tab 不中断（store 随最后持有者
    // 释放），会话快照恢复将因记录缺失落占位——确认弹窗声明该后果。
    // 评审 M1：offsite proxy 走「强制本地删除」逃生口——注销请求以当前连接令牌
    // 打他机服务器只会 401；服务端注册保留（可连接该服务器后再删，或待其重启
    // 自然失效），确认文案显式声明该后果。
    const usage = mountUsageOf(rec.id, workspacesView.list);
    const offsite = rec.kind === 'proxy' && proxyOffsiteOf(rec, last?.baseUrl ?? null);
    const detail = usage.sources > 0 ? `当前 ${usage.sources} 个工作区正在使用此挂载；` : '';
    const scopeNote =
      rec.kind === 'proxy' && offsite
        ? `该挂载注册于服务器 ${hostOf(rec.serverBase)}，与当前连接不一致：将强制本地删除（仅删本机保存的配置，服务器上的注册保留，可连接该服务器后再删除或待其重启失效）。`
        : '';
    const forceLocal = rec.kind === 'proxy' && offsite;
    if (
      !window.confirm(
        `删除挂载「${rec.label}」？${detail}${scopeNote}删除后刷新页面，相关标签页将无法自动恢复。${forceLocal ? '（强制本地删除）' : ''}`
      )
    ) {
      return;
    }
    if (rec.kind === 'proxy' && !offsite && typeof rec.registeredRootIndex === 'number') {
      try {
        await unregisterProxyMount(rec, last?.token ?? null, rec.registeredRootIndex);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showStatusNotice(`服务端注销失败：${msg}（本地记录未删除）`);
        return;
      }
    }
    await deleteMount(rec.id);
    await reloadRecords();
  }

  // ---------- 组③：本机授权来源 ----------

  let dirHandle = $state<FileSystemDirectoryHandle | null>(null);
  let dirPermission = $state<'granted' | 'prompt' | 'denied' | null>(null);
  const localRows = $derived(
    assembleLocalRows(
      dirHandle,
      dirPermission,
      workspacesView.list.flatMap((w) => w.sources)
    )
  );

  async function reloadLocal(): Promise<void> {
    try {
      const h = await loadDirHandle();
      dirHandle = h;
      // queryPermission 是 FS Access API 运行时面、TS lib 未收录——结构化收窄
      const query = (h as FileSystemDirectoryHandle & {
        queryPermission?: (d: { mode: 'read' }) => Promise<'granted' | 'prompt' | 'denied'>;
      }).queryPermission;
      if (h !== null && typeof query === 'function') {
        dirPermission = await query.call(h, { mode: 'read' });
      } else {
        dirPermission = null;
      }
    } catch (err) {
      console.warn('[vviewer] 本机授权状态读取失败', err);
      dirHandle = null;
      dirPermission = null;
    }
  }

  async function clearHandle(): Promise<void> {
    if (
      !window.confirm(
        '清除已保存的文件夹授权？会话快照中的 localfs 来源将无法自动恢复（下次需重新选择文件夹）。'
      )
    ) {
      return;
    }
    await saveDirHandle(null);
    await reloadLocal();
    showStatusNotice('已清除文件夹授权');
  }

  onMount(() => {
    void initServer();
    void reloadRecords();
    void reloadLocal();
  });
</script>

<div
  class="vv-mounts-manager"
  role="dialog"
  aria-label="目录管理"
  tabindex="-1"
  bind:this={rootEl}
  onkeydown={onRootKeydown}
>
  <header class="vv-mm-head">
    <span class="vv-mm-title">目录管理</span>
    <span class="vv-mm-sub">服务端挂载 / 前端直连与代理 / 本机授权</span>
    <button type="button" class="vv-mm-close" aria-label="关闭目录管理" title="关闭（Esc）" onclick={requestClose}>✕</button>
  </header>
  <div class="vv-mm-body">
    <!-- 组①：服务端根与挂载 -->
    <section class="vv-mm-group" aria-label="服务端根与挂载">
      <h2>服务端根与挂载</h2>
      {#if last === null}
        <p class="vv-mm-empty">未连接服务器——通过「连接服务器」连接后，此处显示 fs 根与静态/运行时挂载。</p>
      {:else if serverError !== ''}
        <p class="vv-mm-error" role="alert">清单获取失败：{serverError}</p>
      {:else if serverLoading}
        <p class="vv-mm-empty">清单加载中…</p>
      {:else if serverRows.length === 0}
        <p class="vv-mm-empty">清单为空。</p>
      {:else}
        <ul class="vv-mm-list">
          {#each serverRows as row (row.rootIndex)}
            <li class="vv-mm-item">
              <span class="vv-mm-badge" data-seg={row.segment}>{row.segmentLabel}</span>
              <span class="vv-mm-name" title={row.endpoint ?? row.title}>{row.title}</span>
              <span class="vv-mm-meta">
                {#if row.endpoint !== undefined}
                  {row.kind === 's3' ? 'S3' : 'WebDAV'} · {row.endpoint}{row.bucket !== undefined ? ` · ${row.bucket}` : ''}{row.prefix !== '' ? ` · ${row.prefix}` : ''}
                {:else}
                  rootIndex={row.rootIndex}
                {/if}
              </span>
              <span class="vv-mm-caps">{row.watch ? '' : '无推送'}{row.search ? '' : '·无搜索'}</span>
              <span class="vv-mm-actions">
                <button type="button" onclick={() => openServerRoot(row)}>在树中打开</button>
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- 组②：前端配置挂载 -->
    <section class="vv-mm-group" aria-label="前端配置挂载">
      <h2>
        前端配置挂载
        <button type="button" class="vv-mm-add" onclick={openCreate}>＋ 新增挂载</button>
      </h2>
      <!-- 列表详情警示（spec §6 双处之一；新增表单内为另一处） -->
      <p class="vv-mm-warning" role="note">⚠ {CREDENTIAL_WARNING}</p>
      {#if mountRows.length === 0}
        <p class="vv-mm-empty">暂无前端配置挂载。</p>
      {:else}
        <ul class="vv-mm-list">
          {#each mountRows as row (row.record.id)}
            <li class="vv-mm-item">
              <span class="vv-mm-badge" data-mode={row.modeLabel === '直连' ? 'direct' : 'proxy'}>{row.modeLabel}</span>
              <span class="vv-mm-badge" data-kind>{row.backendLabel}</span>
              <span class="vv-mm-name" title={row.record.label}>{row.record.label}</span>
              <span class="vv-mm-meta">
                {row.displayEndpointText}{row.record.kind === 'direct' && row.record.bucket !== undefined ? ` · ${row.record.bucket}` : ''}{row.record.prefix !== '' ? ` · ${row.record.prefix}` : ''}
                {row.hasCredential ? '· 凭据已存' : ''}
              </span>
              <span class="vv-mm-state" data-state={row.state.code}>
                {#if row.state.code === 'registered'}
                  已注册 rootIndex={row.state.rootIndex}
                {:else if row.state.code === 'offsite'}
                  注册于他机
                {:else if row.state.code === 'pending'}
                  待注册{row.state.error !== undefined ? `（${row.state.error}）` : ''}
                {:else if row.state.code === 'unregistered'}
                  未注册
                {/if}
              </span>
              <span class="vv-mm-actions">
                {#if row.record.kind === 'direct'}
                  <button type="button" onclick={() => openDirectRow(row.record)}>打开</button>
                  <button
                    type="button"
                    disabled={rowProbes[row.record.id] === 'probing'}
                    onclick={() => testRow(row.record)}
                  >测试</button>
                {:else if row.state.code === 'registered'}
                  <button type="button" onclick={() => openProxyRow(row.record)}>打开</button>
                {/if}
                <button type="button" onclick={() => openEdit(row.record)}>编辑</button>
                <button type="button" onclick={() => removeRecord(row.record)}>删除</button>
              </span>
              {#if row.record.kind === 'direct' && rowProbes[row.record.id] !== undefined}
                {@const rp = rowProbes[row.record.id] as ProbeResult | 'probing'}
                <p class="vv-mm-probe" class:vv-mm-probe-err={rp !== 'probing' && !rp.ok} role="status">
                  {rp === 'probing' ? '探测中…' : formatProbeResult(rp)}
                </p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if formOpen}
        <!-- 新增/编辑表单：kind→字段集切换→测试连接→保存 -->
        <form class="vv-mm-form" onsubmit={submitForm}>
          <h3>{editing === null ? '新增挂载' : `编辑挂载：${editing.label}`}</h3>
          <div class="vv-mm-field">
            <label for="vv-mm-mode">访问方式</label>
            <select id="vv-mm-mode" bind:value={draft.mode} disabled={last === null}>
              <option value="direct">直连（浏览器直接访问）</option>
              <option value="proxy">代理（经服务器访问）</option>
            </select>
            {#if draft.mode === 'proxy' && last === null}
              <span class="vv-mm-issue">代理挂载需先连接服务器</span>
            {/if}
          </div>
          <div class="vv-mm-field">
            <label for="vv-mm-backend">类型</label>
            <select id="vv-mm-backend" bind:value={draft.backend}>
              <option value="s3">S3</option>
              <option value="webdav">WebDAV</option>
            </select>
          </div>
          <div class="vv-mm-field">
            <label for="vv-mm-label">显示名</label>
            <input id="vv-mm-label" bind:value={draft.label} spellcheck="false" />
            {#if formIssues?.label}<span class="vv-mm-issue">{formIssues.label}</span>{/if}
          </div>
          <div class="vv-mm-field">
            <label for="vv-mm-endpoint">endpoint</label>
            <input id="vv-mm-endpoint" bind:value={draft.endpoint} placeholder="https://s3.example.com" spellcheck="false" />
            {#if formIssues?.endpoint}<span class="vv-mm-issue" role="alert">{formIssues.endpoint}</span>{/if}
          </div>
          {#if draft.backend === 's3'}
            <div class="vv-mm-field">
              <label for="vv-mm-bucket">存储桶（bucket）</label>
              <input id="vv-mm-bucket" bind:value={draft.bucket} spellcheck="false" />
              {#if formIssues?.bucket}<span class="vv-mm-issue">{formIssues.bucket}</span>{/if}
            </div>
            <div class="vv-mm-field">
              <label for="vv-mm-pathstyle">path-style 寻址</label>
              <input id="vv-mm-pathstyle" type="checkbox" bind:checked={draft.pathStyle} />
              <span class="vv-mm-hint">关闭则使用 virtual-host 形态（bucket.{''}host）</span>
            </div>
          {/if}
          <div class="vv-mm-field">
            <label for="vv-mm-prefix">子路径（prefix，可空）</label>
            <input id="vv-mm-prefix" bind:value={draft.prefix} spellcheck="false" />
          </div>
          <div class="vv-mm-field">
            <label for="vv-mm-username">{draft.backend === 's3' ? 'Access Key ID' : '用户名'}</label>
            <input id="vv-mm-username" bind:value={draft.username} autocomplete="off" spellcheck="false" />
            {#if formIssues?.username}<span class="vv-mm-issue">{formIssues.username}</span>{/if}
          </div>
          <div class="vv-mm-field">
            <label for="vv-mm-secret">{draft.backend === 's3' ? 'Secret Access Key' : '密码'}</label>
            <input id="vv-mm-secret" type="password" bind:value={draft.secret} autocomplete="off" />
            {#if formIssues?.secret}<span class="vv-mm-issue">{formIssues.secret}</span>{/if}
          </div>
          {#if draft.backend === 'webdav'}
            <p class="vv-mm-hint" role="note">⚠ {WEBDAV_CORS_HINT}</p>
          {/if}
          {#if draft.mode === 'proxy'}
            <!-- 终审 I-4 勘误：proxy 的「测试连接」同为浏览器侧探测（直打目标
              endpoint），语义错签风险——目标无需 CORS 也会因浏览器拦截被误报不可
              用；代理链路的真实可用性以服务器出口为准（保存注册后由对账健康探测
              覆盖，spec §3）。 -->
            <p class="vv-mm-hint" role="note">
              「测试连接」为浏览器侧探测（直连目标端点）：被 CORS 拦截不代表代理链路不可用——代理访问以服务器出口为准，保存注册后由对账健康探测验证。
            </p>
          {/if}
          <!-- 新增表单警示（spec §6 双处之二） -->
          <p class="vv-mm-warning" role="note">⚠ {CREDENTIAL_WARNING}</p>
          <div class="vv-mm-form-actions">
            <button type="button" disabled={probing || saving} onclick={runProbe}>
              {probing ? '探测中…' : '测试连接'}
            </button>
            {#if probe !== null}
              <span
                class="vv-mm-probe"
                class:vv-mm-probe-err={!probe.ok}
                role="status">{formatProbeResult(probe)}</span
              >
            {/if}
          </div>
          {#if formError !== ''}
            <p class="vv-mm-error" role="alert">{formError}</p>
          {/if}
          <div class="vv-mm-form-actions">
            <button type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
            <button type="button" onclick={closeForm}>取消</button>
          </div>
        </form>
      {/if}
    </section>

    <!-- 组③：本机授权来源 -->
    <section class="vv-mm-group" aria-label="本机授权来源">
      <h2>
        本机授权来源
        <button type="button" class="vv-mm-add" onclick={() => void openDirectoryViaPicker()}>选择文件夹授权</button>
      </h2>
      {#if localRows.length === 0}
        <p class="vv-mm-empty">暂无本机授权来源。</p>
      {:else}
        <ul class="vv-mm-list">
          {#each localRows as row (row.key)}
            <li class="vv-mm-item">
              <span class="vv-mm-badge" data-seg={row.kind === 'localfs' ? 'fs' : 'session'}>{row.kind === 'localfs' ? 'localfs' : '会话'}</span>
              <span class="vv-mm-name">{row.title}</span>
              <span class="vv-mm-meta">{row.detail}</span>
              <span class="vv-mm-actions">
                {#if row.kind === 'localfs'}
                  <button type="button" onclick={() => void openSavedDirectory()}>打开</button>
                  <button type="button" onclick={() => void clearHandle()}>清除授权</button>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</div>

<style>
  .vv-mounts-manager {
    position: fixed;
    inset: 0;
    z-index: 30; /* 面板层（设置中心同层） */
    display: flex;
    flex-direction: column;
    background: var(--ui-bg, #fff);
    color: var(--ui-text, #1a1a1a);
    outline: none;
    overflow: auto;
  }
  .vv-mm-head {
    display: flex;
    align-items: baseline;
    gap: 0.75em;
    padding: 0.9em 1.2em;
    border-bottom: 1px solid var(--ui-border, #ddd);
    position: sticky;
    top: 0;
    background: inherit;
  }
  .vv-mm-title {
    font-size: 1.15em;
    font-weight: 600;
  }
  .vv-mm-sub {
    flex: 1;
    font-size: 0.85em;
    opacity: 0.65;
  }
  .vv-mm-body {
    display: flex;
    flex-direction: column;
    gap: 1.4em;
    padding: 1.2em;
    max-width: 960px;
    width: 100%;
    margin: 0 auto;
    box-sizing: border-box;
  }
  .vv-mm-group h2 {
    font-size: 1em;
    margin: 0 0 0.5em;
    display: flex;
    align-items: center;
    gap: 0.75em;
  }
  .vv-mm-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4em;
  }
  .vv-mm-item {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5em;
    padding: 0.45em 0.6em;
    border: 1px solid var(--ui-border, #ddd);
    border-radius: 6px;
  }
  .vv-mm-badge {
    font-size: 0.72em;
    padding: 0.1em 0.5em;
    border-radius: 999px;
    border: 1px solid var(--ui-border, #ccc);
    white-space: nowrap;
  }
  .vv-mm-badge[data-seg='runtime'],
  .vv-mm-badge[data-mode='proxy'] {
    background: color-mix(in srgb, var(--ui-border, #ccc) 40%, transparent);
  }
  .vv-mm-name {
    font-weight: 600;
    max-width: 16em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vv-mm-meta {
    flex: 1;
    min-width: 8em;
    font-size: 0.8em;
    opacity: 0.7;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vv-mm-state {
    font-size: 0.75em;
    white-space: nowrap;
  }
  .vv-mm-state[data-state='pending'] {
    color: #b45309;
  }
  .vv-mm-state[data-state='offsite'] {
    color: #6b7280; /* 注册于他机（评审 M1）：中性灰——事实提示非错误面 */
  }
  .vv-mm-state[data-state='unregistered'] {
    opacity: 0.6;
  }
  .vv-mm-caps {
    font-size: 0.72em;
    opacity: 0.55;
    white-space: nowrap;
  }
  .vv-mm-actions {
    display: flex;
    gap: 0.4em;
    margin-left: auto;
  }
  .vv-mm-actions button,
  .vv-mm-add,
  .vv-mm-form-actions button {
    font: inherit;
    font-size: 0.8em;
    padding: 0.2em 0.7em;
    border: 1px solid var(--ui-border, #ccc);
    border-radius: 5px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .vv-mm-actions button:hover,
  .vv-mm-add:hover,
  .vv-mm-form-actions button:hover {
    background: color-mix(in srgb, var(--ui-border, #ccc) 35%, transparent);
  }
  .vv-mm-warning {
    margin: 0 0 0.5em;
    font-size: 0.8em;
    color: #b45309;
  }
  .vv-mm-hint {
    margin: 0;
    font-size: 0.78em;
    opacity: 0.75;
  }
  .vv-mm-empty {
    font-size: 0.85em;
    opacity: 0.6;
    margin: 0;
  }
  .vv-mm-error {
    font-size: 0.85em;
    color: #b91c1c;
    margin: 0;
  }
  .vv-mm-probe {
    flex-basis: 100%;
    margin: 0;
    font-size: 0.78em;
  }
  .vv-mm-probe-err {
    color: #b91c1c;
  }
  .vv-mm-form {
    display: flex;
    flex-direction: column;
    gap: 0.6em;
    border: 1px solid var(--ui-border, #ddd);
    border-radius: 8px;
    padding: 0.9em;
    margin-top: 0.6em;
  }
  .vv-mm-form h3 {
    font-size: 0.95em;
    margin: 0;
  }
  .vv-mm-field {
    display: flex;
    align-items: center;
    gap: 0.6em;
  }
  .vv-mm-field label {
    width: 11em;
    flex-shrink: 0;
    font-size: 0.82em;
  }
  .vv-mm-field input:not([type='checkbox']),
  .vv-mm-field select {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: 0.85em;
    padding: 0.25em 0.5em;
    border: 1px solid var(--ui-border, #ccc);
    border-radius: 5px;
    background: transparent;
    color: inherit;
  }
  .vv-mm-issue {
    font-size: 0.75em;
    color: #b91c1c;
    flex-basis: 100%;
    margin-left: 11em;
  }
  .vv-mm-form-actions {
    display: flex;
    align-items: center;
    gap: 0.6em;
  }
  @media (max-width: 600px) {
    .vv-mm-field {
      flex-direction: column;
      align-items: stretch;
    }
    .vv-mm-field label {
      width: auto;
    }
    .vv-mm-issue {
      margin-left: 0;
    }
  }
</style>
