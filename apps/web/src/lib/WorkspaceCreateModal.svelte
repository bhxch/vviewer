<script lang="ts">
  // WorkspaceCreateModal.svelte — 新建工作区模态（workspace T5）。TopBar 切换器
  // 「新建工作区…」入口挂载（SettingsPanel 的 {#if} 浮层模式）：
  //   命名（默认「工作区 N」= nextId 序号）+ 来源三选（可跳过）：本地文件夹
  //   （FS Access picker，webkitdirectory input 回退——openDirectoryViaPicker 等价
  //   逻辑但归新组）/ 本地文件（input 多选）/ 后端路径（内嵌 RemoteSourceModal）。
  // 组创建时机：来源落组依赖「新组已激活」（addDirStoreTab/openFiles/openRemoteSource
  // 均归当前活动组），故在来源实际选定（picker 成功/onchange/打开远端浏览）时才
  // ensureCreated——取消选择不留下空组。任何退出路径（创建并激活/✕/Esc）都完成
  // 创建：组已建则 rename 为最终名（无取消语义，「可跳过」= 不加来源直接完成）。
  // Esc 双 handler 仿 GlobalSearchPanel（容器 keydown + window 兜底）；焦点在浏览
  // 层时由内层 handler 先关浏览层（target 互斥不双触发）。
  import { createLocalFsStore, isAbortError } from '@vviewer/core';
  import {
    addDirStoreTab,
    openDirectoryViaInput,
    openFiles,
    showStatusNotice
  } from './openFlow.svelte';
  import RemoteSourceModal from './RemoteSourceModal.svelte';
  import { workspaceSeqOf, workspaceStore } from './workspaceStore';
  import { saveDirHandle } from './stores/session';

  let { onclose }: { onclose(): void } = $props();

  const defaultName = `工作区 ${workspaceSeqOf(workspaceStore.nextId())}`;
  let name = $state(defaultName);
  /** 本次已创建的 workspace id（null = 尚未创建：来源选定前不建组） */
  let createdId = $state<string | null>(null);
  let note = $state('');
  let remoteBrowse = $state(false);
  let nameInputEl = $state<HTMLInputElement | null>(null);
  let fileInputEl = $state<HTMLInputElement | null>(null);
  let dirInputEl = $state<HTMLInputElement | null>(null);
  let panelEl = $state<HTMLElement | null>(null);

  $effect(() => {
    nameInputEl?.focus();
    // webkitdirectory 非标准属性不进 Svelte 模板（svelte-check 报未知属性）：
    // 挂载后以属性赋值开启回退通道的目录选择
    if (dirInputEl !== null) dirInputEl.webkitdirectory = true;
  });

  function finalName(): string {
    const v = name.trim();
    return v === '' ? defaultName : v;
  }

  /** 新建并激活（workspaceStore.add 新建即激活）；幂等 */
  function ensureCreated(): void {
    if (createdId !== null) return;
    createdId = workspaceStore.add(finalName()).id;
  }

  /** 完成：未建则按名创建；已建则同步最终名（rename 同名 no-op）。任何退出路径
   * 都走这里——「创建并激活」「可跳过」与 ✕/Esc 等价。 */
  function finish(): void {
    if (createdId === null) workspaceStore.add(finalName());
    else workspaceStore.rename(createdId, finalName());
    close();
  }

  // ---------- 来源一：本地文件夹（openDirectoryViaPicker 等价，归新组） ----------

  async function pickFolder(): Promise<void> {
    note = '';
    const w = window as unknown as {
      showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
    };
    if (typeof w.showDirectoryPicker !== 'function') {
      dirInputEl?.click(); // webkitdirectory 回退通道，onchange 内 ensureCreated
      return;
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await w.showDirectoryPicker({ mode: 'read' });
    } catch (err) {
      // 用户取消（BUG-19 同款文案走状态栏提示）：不建组，模态保持
      if (isAbortError(err)) {
        showStatusNotice('已取消选择文件夹');
        return;
      }
      note = err instanceof Error ? err.message : String(err);
      return;
    }
    ensureCreated(); // 选定后才建组：addDirStoreTab 归当前活动组 = 新组
    await saveDirHandle(handle);
    addDirStoreTab(createLocalFsStore(handle));
    note = `已添加文件夹来源「${handle.name}」，可继续添加或完成创建`;
  }

  /** webkitdirectory 回退通道（Firefox 等）：同 openDirectoryViaPicker 的回退语义 */
  function onDirPick(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files !== null && input.files.length > 0) {
      ensureCreated();
      openDirectoryViaInput(input.files); // 空目录自行 showStatusNotice 且不建 tab
    }
    input.value = '';
  }

  // ---------- 来源二：本地文件（input 多选，仅建 tab 不登记目录来源） ----------

  function pickFiles(): void {
    note = '';
    fileInputEl?.click(); // onchange 内 ensureCreated：取消不建组
  }

  function onFilesPick(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files !== null && input.files.length > 0) {
      ensureCreated();
      openFiles([...input.files]);
      note = `已添加 ${input.files.length} 个文件，可继续添加或完成创建`;
    }
    input.value = '';
  }

  // ---------- 来源三：后端路径（内嵌 RemoteSourceModal，openRemoteSource 归新组） ----------

  function openRemote(): void {
    note = '';
    ensureCreated(); // 浏览选中来源即落新组；取消浏览保留空新组（✕/Esc 完成创建）
    remoteBrowse = true;
  }

  function onRemotePicked(): void {
    note = '已添加后端路径来源，可继续添加或完成创建';
  }

  // ---------- Esc（双 handler，GlobalSearchPanel 模式） ----------

  $effect(() => {
    const onWinKey = (e: KeyboardEvent): void => {
      if (
        e.key === 'Escape' &&
        panelEl !== null &&
        (e.target instanceof Node ? !panelEl.contains(e.target) : true)
      ) {
        e.preventDefault();
        finish();
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
      finish();
    }
  }
</script>

<div class="vv-wscreate-panel vv-wscreate" role="dialog" aria-label="新建工作区" tabindex="-1" bind:this={panelEl} onkeydown={onpanelkeydown}>
  {#if remoteBrowse}
    <RemoteSourceModal onclose={() => (remoteBrowse = false)} onpicked={onRemotePicked} />
  {:else}
    <div class="vv-wscreate-head">
      <span class="vv-wscreate-title">新建工作区</span>
      <button type="button" class="vv-wscreate-close" aria-label="关闭新建工作区" title="完成创建（Esc）" onclick={finish}>✕</button>
    </div>
    <label class="vv-wscreate-name">
      <span>名称</span>
      <input bind:this={nameInputEl} bind:value={name} placeholder={defaultName} aria-label="工作区名称" spellcheck="false" />
    </label>
    <div class="vv-wscreate-label">添加来源（可跳过）</div>
    <div class="vv-wscreate-sources">
      <button type="button" onclick={() => void pickFolder()}>本地文件夹…</button>
      <button type="button" onclick={pickFiles}>本地文件…</button>
      <button type="button" onclick={openRemote}>后端路径…</button>
    </div>
    <div class="vv-wscreate-hint">来源将加入本工作区；创建后也可用顶栏「打开文件夹 / 连接服务器」继续添加。</div>
    {#if note}
      <div class="vv-wscreate-note" role="status">{note}</div>
    {/if}
    <div class="vv-wscreate-actions">
      <button type="button" class="vv-wscreate-primary" onclick={finish}>创建并激活</button>
    </div>
    <input type="file" multiple hidden bind:this={fileInputEl} onchange={onFilesPick} />
    <input type="file" hidden bind:this={dirInputEl} onchange={onDirPick} />
  {/if}
</div>

<style>
  .vv-wscreate {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .vv-wscreate-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .vv-wscreate-title {
    font-weight: 600;
  }
  .vv-wscreate-close {
    border: 0;
    background: none;
    color: var(--ui-fg-muted);
    cursor: pointer;
    padding: 0 4px;
  }
  .vv-wscreate-close:hover {
    color: var(--ui-fg);
  }
  .vv-wscreate-name {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .vv-wscreate-name input {
    flex: 1;
    min-width: 0;
  }
  .vv-wscreate-label {
    font-weight: 600;
    font-size: 13px;
  }
  .vv-wscreate-sources {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .vv-wscreate-hint {
    color: var(--ui-fg-muted);
    font-size: 12px;
  }
  .vv-wscreate-note {
    color: var(--ui-accent);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .vv-wscreate-actions {
    display: flex;
    justify-content: flex-end;
  }
  .vv-wscreate-primary {
    color: var(--ui-accent);
    border-color: var(--ui-accent);
  }
</style>
