<script lang="ts">
  // SettingsCenter.svelte — 统一设置中心（全屏 overlay，settings center spec
  // 2026-10-19 §2/§3/§4）：左侧分组导航 + 右侧 UI/JSON 双视图 + 导入导出。取代
  // SettingsPanel 弹层（TopBar ⚙ 与 Ctrl+, 双入口均指向本页，AppShell 挂载）。
  // 分组由注册表数组驱动（{ id, label, content }，content 为节组件）——九组定稿
  // 序（外观/字体/图表/布局/搜索与排除/自动刷新/计算/存储与数据/关于）+ 左导航
  // 底部导入/导出动作区；后续分组以注册项插入，零骨架改动。
  // 草稿语义（spec §3）：打开即 openDraft 深拷贝生效 settings；表单节组件只改
  // draft 并调 touch()（仅使 JSON 派生失效，不落盘）；「应用」统一经
  // commit(mergeDraftOnto(最新值, 出发快照, draft))→saveSettings 走集中订阅链
  // （I-2：外部变更经 onSettingsChanged 重置脏态基准，应用按字段级 diff 合并——
  // purge 等外部回落不被陈旧草稿复活）；JSON 视图与表单共享同一 draft——表单→
  // JSON 即格式化序列化，JSON→表单先 parse+校验（settingsDraft 白名单镜像），
  // 非法停留 JSON 视图标错不丢文本；脏态关闭走确认（requestClose，Ctrl+,/⚙ 的
  // 关闭路径同此裁决）。
  import { setContext, untrack, type Component } from 'svelte';
  import { loadSettings, onSettingsChanged, type Settings } from './stores/settings';
  import {
    applyJson,
    buildExportFile,
    commit,
    draftToJson,
    exportFileName,
    importGroupDiffs,
    isDirty,
    mergeDraftOnto,
    mergeImported,
    openDraft,
    parseImportFile,
    replaceImported,
    type ImportGroupDiff,
    type SettingsIssue
  } from './settingsDraft';
  import AppearanceSection from './settings/AppearanceSection.svelte';
  import FontsSection from './settings/FontsSection.svelte';
  import DiagramsSection from './settings/DiagramsSection.svelte';
  import LayoutSection from './settings/LayoutSection.svelte';
  import SearchSection from './settings/SearchSection.svelte';
  import AutoRefreshSection from './settings/AutoRefreshSection.svelte';
  import ComputeSection from './settings/ComputeSection.svelte';
  import StorageSection from './settings/StorageSection.svelte';
  import AboutSection from './settings/AboutSection.svelte';
  import { SETTINGS_NAV_KEY } from './settings/nav';

  let { onclose }: { onclose(): void } = $props();

  /** 分组注册表项：Task 3/4 新分组以注册项插入本数组（spec §2 定稿序排列） */
  interface SettingsGroup {
    id: string;
    label: string;
    content: Component<{ draft: Settings; touch(): void }>;
  }

  // 组序（spec §2 定稿序：外观/字体/图表/布局/搜索与排除/自动刷新/计算/存储与数据/关于）
  const groups: SettingsGroup[] = [
    { id: 'appearance', label: '外观', content: AppearanceSection },
    { id: 'fonts', label: '字体', content: FontsSection },
    { id: 'diagrams', label: '图表', content: DiagramsSection },
    { id: 'layout', label: '布局', content: LayoutSection },
    { id: 'search', label: '搜索与排除', content: SearchSection },
    { id: 'autorefresh', label: '自动刷新', content: AutoRefreshSection },
    { id: 'compute', label: '计算', content: ComputeSection },
    { id: 'storage', label: '存储与数据', content: StorageSection },
    { id: 'about', label: '关于', content: AboutSection }
  ];

  let activeId = $state('appearance');
  const activeGroup = $derived(groups.find((g) => g.id === activeId) ?? groups[0]!);

  // 节间互链跳转通道（spec §2.1/§2.2：关于 ↔ 存储与数据互链）
  setContext(SETTINGS_NAV_KEY, (id: string) => {
    activeId = id;
  });

  // ---------- 草稿（spec §3：打开深拷贝，两视图共享） ----------
  let applied = $state<Settings>(loadSettings()); // 最近一次应用的生效值（脏态基准）
  // untrack：draft 只取打开时刻的 applied 快照。draftBase = draft 的出发快照
  // （I-2）：外部变更把 applied 重置为最新后，「应用」仍以 draftBase 为 diff
  // 基准（draft 相对它才算「用户的改动」）——见 doApply 的 mergeDraftOnto。
  let draftBase = $state<Settings>(openDraft(untrack(() => applied)));
  let draft = $state<Settings>(openDraft(untrack(() => applied)));
  const dirty = $derived(isDirty(draft, applied));

  // I-2：打开期间外部 saveSettings（如存储与数据节 purge 主题/字体的引用联动
  // 回落）把脏态基准重置为最新值——draft 不动（未应用改动不丢），脏态重算如实
  // 显形；陈旧草稿的整体写回复活路径由 doApply 的 mergeDraftOnto 消除（此前
  // 「不点应用即无复活路径」的披露失实：一旦应用即整体覆盖，外部回落值被复活）。
  $effect(() => {
    return onSettingsChanged((s: Settings) => {
      applied = s;
    });
  });

  /** 节改动上收（draft 契约）：本阶段只使 JSON 派生失效（表单改动反映到 JSON
   * 视图），落盘统一在「应用」。 */
  function touch(): void {
    jsonDirtyBuffer = null;
  }

  // ---------- 双视图（spec §3：表单 ↔ JSON，非法停留标错不丢文本） ----------
  type ViewMode = 'form' | 'json';
  let view = $state<ViewMode>('form');
  /** JSON 文本缓冲：null = 未手编（显示 draft 的格式化序列化）；非 null = 用户
   * 手编文本原样保留（非法 JSON 停留时文本不丢的承担者） */
  let jsonDirtyBuffer = $state<string | null>(null);
  let jsonErrors = $state<SettingsIssue[] | null>(null);
  let jsonAreaEl = $state<HTMLTextAreaElement | null>(null);
  let gutterEl = $state<HTMLElement | null>(null);

  const jsonDisplay = $derived(jsonDirtyBuffer ?? draftToJson(draft));
  const lineCount = $derived(jsonDisplay.split('\n').length);
  /** 可应用 = 草稿有改动，或 JSON 视图有手编文本（尚未写回 draft） */
  const canApply = $derived(dirty || (view === 'json' && jsonDirtyBuffer !== null));

  /** 表单 → JSON：即格式化序列化 draft（spec §3），丢弃手编缓冲 */
  function showJson(): void {
    jsonDirtyBuffer = null;
    jsonErrors = null;
    view = 'json';
  }

  /** JSON → 表单：先 parse+校验，非法停留 JSON 视图标错（文本保留在缓冲） */
  function leaveJson(): boolean {
    const r = applyJson(draft, jsonDisplay);
    if (!r.ok) {
      jsonErrors = r.errors;
      return false;
    }
    jsonDirtyBuffer = null;
    jsonErrors = null;
    view = 'form';
    return true;
  }

  function showForm(): void {
    if (view === 'form') return;
    leaveJson();
  }

  function onJsonInput(e: Event): void {
    jsonDirtyBuffer = (e.currentTarget as HTMLTextAreaElement).value;
    jsonErrors = null; // 编辑即清上次标错（下次应用/切换重算）
  }

  /** 行号栏与 textarea 滚动同步（无编辑器依赖，spec §3 等宽 textarea + 行号栏） */
  function syncGutter(): void {
    if (gutterEl !== null && jsonAreaEl !== null) gutterEl.scrollTop = jsonAreaEl.scrollTop;
  }

  // ---------- 应用 / 放弃 / 脏态关闭确认（spec §3） ----------

  /** 应用：JSON 视图先写回校验；统一 commit→saveSettings 集中订阅链。
   * 提交值 = mergeDraftOnto(loadSettings(), draftBase, draft)（I-2）：draft 相对
   * 出发快照的变更字段合并到提交时刻最新生效值上——打开期间外部落盘的变更
   * （purge 引用回落等）不被草稿中未改动的陈旧字段复活；无外部变更时
   * （base=baseline）结果恒等于 draft（原 commit(draft) 语义不变），同一字段
   * 撞车时 draft 值胜。成功后自动清除脏态不清页（applied 刷新为持久值）。
   * 失败返回 false 停留。 */
  function doApply(): boolean {
    if (view === 'json') {
      const r = applyJson(draft, jsonDisplay);
      if (!r.ok) {
        jsonErrors = r.errors;
        return false;
      }
    }
    commit(mergeDraftOnto(loadSettings(), draftBase, draft));
    applied = loadSettings();
    // draft 以规范化 applied 重建（评审 L6）：normalize 截掉的脏值（如非法
    // krokiHost 落 ''）不再留在 draft——否则 applied≠draft 恒脏、确认条失实
    draft = openDraft(applied);
    draftBase = openDraft(applied);
    jsonDirtyBuffer = null;
    jsonErrors = null;
    confirmClose = false; // 评审 L2：确认条开着时经头部「应用」成功，条随之复位
    return true;
  }

  /** 放弃：draft 还原为最近应用值（JSON 缓冲与标错一并丢弃；出发快照同步重置） */
  function doDiscard(): void {
    draft = openDraft(applied);
    draftBase = openDraft(applied);
    jsonDirtyBuffer = null;
    jsonErrors = null;
  }

  let confirmClose = $state(false);

  /** 关闭请求（✕/Esc/Ctrl+,/⚙ 全部关闭路径的统一入口）：脏态弹确认而非直关 */
  export function requestClose(): void {
    if (canApply) {
      confirmClose = true;
      return;
    }
    close();
  }

  // ---------- 导入/导出（spec §4，Task 3）：左导航底部动作区 ----------
  // 导出 = 当前生效值（loadSettings）构造 schemaVersion 文件经 Blob a[download] 下载；
  // 导入 = file input → parseImportFile（失败报错弹层不部分应用）→ 变更摘要对话框
  // （合并/替换二选一）→ 确认经 doApply 走统一应用链（commit→saveSettings 订阅链）。

  let importInputEl = $state<HTMLInputElement | null>(null);
  let importPreview = $state<{
    settings: Record<string, unknown>;
    warnings: string[];
    diffs: ImportGroupDiff[];
  } | null>(null);
  let importErrors = $state<SettingsIssue[] | null>(null);
  let importMode = $state<'merge' | 'replace'>('merge');

  function onExport(): void {
    const file = buildExportFile(loadSettings(), new Date().toISOString());
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName();
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onImportFile(e: Event): Promise<void> {
    const inp = e.currentTarget as HTMLInputElement;
    const file = inp.files?.[0];
    inp.value = ''; // 允许重复选同一文件
    if (!file) return;
    const r = parseImportFile(await file.text());
    if (!r.ok) {
      importErrors = r.errors; // 校验失败明确报错，不部分应用（spec §4）
      importPreview = null;
      return;
    }
    importErrors = null;
    importMode = 'merge';
    importPreview = {
      settings: r.settings,
      warnings: r.warnings,
      diffs: importGroupDiffs(loadSettings(), r.settings)
    };
  }

  /** 确认导入：合并/替换算出目标值写 draft，交 doApply 统一应用（同链同订阅广播） */
  function confirmImport(): void {
    if (importPreview === null) return;
    draft =
      importMode === 'merge'
        ? mergeImported(applied, importPreview.settings)
        : replaceImported(importPreview.settings);
    jsonDirtyBuffer = null;
    jsonErrors = null;
    importPreview = null;
    doApply();
  }

  // ---------- 骨架（导航/焦点/Esc 通道） ----------

  let rootEl = $state<HTMLElement | null>(null);

  $effect(() => {
    // 全屏页挂载即聚焦（Esc 关闭键盘可达）；关闭时还原焦点（退役弹层同模式）
    rootEl?.focus();
  });

  $effect(() => {
    // Esc 全局化兜底（与 GlobalSearchPanel 同模式）：焦点落到面板外时 Esc 也走
    // requestClose（合成 Esc 的派发目标即根元素，容器通道为主路径）
    const onWinKey = (e: KeyboardEvent): void => {
      if (
        e.key === 'Escape' &&
        rootEl !== null &&
        (e.target instanceof Node ? !rootEl.contains(e.target) : true)
      ) {
        e.preventDefault();
        // 导入弹层兜底（与容器通道同语义）：焦点落页外时 Esc 也先关弹层
        if (importPreview !== null) {
          importPreview = null;
          return;
        }
        if (importErrors !== null) {
          importErrors = null;
          return;
        }
        requestClose();
      }
    };
    window.addEventListener('keydown', onWinKey);
    return () => window.removeEventListener('keydown', onWinKey);
  });

  /** 左导航键盘可达（spec §2 分组导航 ↑↓ 切组）：焦点在导航内时 ↑↓ 换组
   * （视图不动——JSON 视图下仅移动高亮，不触发解析，文本零风险） */
  function onNavKeydown(e: KeyboardEvent): void {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const idx = groups.findIndex((g) => g.id === activeId);
    const next = e.key === 'ArrowDown' ? (idx + 1) % groups.length : (idx - 1 + groups.length) % groups.length;
    activeId = groups[next]!.id;
  }

  function onRootKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      // 导入弹层在场时 Esc 先关弹层（逐层退出），不直接波及整页
      if (importPreview !== null) {
        importPreview = null;
        return;
      }
      if (importErrors !== null) {
        importErrors = null;
        return;
      }
      requestClose();
    }
  }

  function close(): void {
    // 关闭前记录焦点：面板卸载后还原（与 GlobalSearchPanel 同模式）
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
</script>

<div
  class="vv-settings-center"
  role="dialog"
  aria-label="设置"
  tabindex="-1"
  bind:this={rootEl}
  onkeydown={onRootKeydown}
>
  <header class="vv-sc-head">
    <span class="vv-sc-title">设置</span>
    <div class="vv-sc-views">
      <button type="button" class="vv-sc-viewbtn" class:active={view === 'form'} aria-pressed={view === 'form'} onclick={showForm}>
        表单
      </button>
      <button type="button" class="vv-sc-viewbtn" class:active={view === 'json'} aria-pressed={view === 'json'} onclick={showJson}>
        JSON
      </button>
    </div>
    <span class="vv-sc-headspacer"></span>
    {#if canApply}
      <span class="vv-sc-dirty" role="status">未应用</span>
    {/if}
    <button type="button" class="vv-sc-apply" disabled={!canApply} onclick={() => doApply()} title="应用（写回并立即生效）">应用</button>
    <button type="button" class="vv-sc-discard" disabled={!canApply} onclick={doDiscard} title="放弃未应用修改">放弃</button>
    <button type="button" class="vv-sc-close" aria-label="关闭设置" title="关闭（Esc）" onclick={requestClose}>✕</button>
  </header>
  <div class="vv-sc-body">
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions --><!-- ↑↓ 切组
         是导航的键盘可达性通道（spec §2 分组导航键盘可达），纯增强、按钮本身
         原生可达 -->
    <nav class="vv-sc-nav" aria-label="设置分组" onkeydown={onNavKeydown}>
      {#each groups as g (g.id)}
        <button
          type="button"
          class="vv-sc-navitem"
          class:active={g.id === activeId}
          aria-current={g.id === activeId ? 'true' : undefined}
          onclick={() => (activeId = g.id)}
        >
          {g.label}
        </button>
      {/each}
      <!-- 导入/导出动作区（spec §4，Task 3）：非分组项，驻左导航底部 -->
      <div class="vv-sc-navactions">
        <button type="button" onclick={onExport} title="导出全部设置为 JSON 文件（vviewer-settings-日期.json）">
          导出…
        </button>
        <button type="button" onclick={() => importInputEl?.click()} title="从 JSON 文件导入设置">
          导入…
        </button>
        <input type="file" accept=".json,application/json" hidden bind:this={importInputEl} onchange={onImportFile} />
      </div>
    </nav>
    <div class="vv-sc-content">
      {#if view === 'json'}
        <section class="vv-sc-section">
          <div class="vv-settings-hint">
            完整 settings JSON（与表单共享草稿）：表单改动即时反映至此；应用前先 parse+校验，非法标红停留、文本不丢。
          </div>
          <div class="vv-sc-jsonwrap">
            <div class="vv-sc-gutter" aria-hidden="true" bind:this={gutterEl}>
              {#each Array.from({ length: lineCount }) as _, i (i)}
                <span>{i + 1}</span>
              {/each}
            </div>
            <textarea
              class="vv-sc-jsonarea"
              spellcheck="false"
              wrap="off"
              value={jsonDisplay}
              oninput={onJsonInput}
              onscroll={syncGutter}
              aria-label="设置 JSON"
              bind:this={jsonAreaEl}
            ></textarea>
          </div>
          {#if jsonErrors !== null}
            <div class="vv-sc-jsonerrors" role="alert">
              {#each jsonErrors as e (e.field + e.message)}
                <div class="vv-sc-jsonerror"><code>{e.field === '' ? '(JSON)' : e.field}</code> {e.message}</div>
              {/each}
            </div>
          {/if}
        </section>
      {:else if activeGroup !== null}
        {@const Section = activeGroup.content}
        <Section draft={draft} touch={touch} />
      {/if}
    </div>
  </div>
  {#if importPreview !== null}
    <!-- 导入确认对话框（spec §4：变更摘要 + 合并/替换二选一） -->
    <div class="vv-sc-modal" role="dialog" aria-label="导入设置">
      <div class="vv-sc-modalbox">
        <div class="vv-sc-modaltitle">导入设置</div>
        {#each importPreview.warnings as w (w)}
          <div class="vv-settings-warn" role="status">{w}</div>
        {/each}
        {#if importPreview.diffs.length === 0}
          <div class="vv-settings-note">导入文件与当前设置无差异</div>
        {:else}
          <ul class="vv-sc-importdiffs">
            {#each importPreview.diffs as d (d.key)}
              <li>
                <div class="vv-sc-importkey">{d.key}</div>
                {#each [...d.added, ...d.removed, ...d.changed] as line, i (i)}
                  <div class="vv-sc-importline">{line}</div>
                {/each}
              </li>
            {/each}
          </ul>
        {/if}
        <label class="vv-sc-importmode">
          <input type="radio" name="vv-import-mode" value="merge" bind:group={importMode} />
          合并（缺项保留现状）
        </label>
        <label class="vv-sc-importmode">
          <input type="radio" name="vv-import-mode" value="replace" bind:group={importMode} />
          替换（整体覆盖为导入值）
        </label>
        <div class="vv-settings-hint">导入不携带主题/字体等内容资产（各自已有导入通道）</div>
        <div class="vv-sc-modalactions">
          <button type="button" class="vv-sc-apply" onclick={confirmImport}>导入并应用</button>
          <button type="button" onclick={() => (importPreview = null)}>取消</button>
        </div>
      </div>
    </div>
  {/if}
  {#if importErrors !== null}
    <!-- 导入失败（spec §4：校验失败明确报错不部分应用） -->
    <div class="vv-sc-modal" role="alertdialog" aria-label="导入设置错误">
      <div class="vv-sc-modalbox">
        <div class="vv-sc-modaltitle">导入失败（未应用任何更改）</div>
        <div class="vv-sc-jsonerrors" role="alert">
          {#each importErrors as e (e.field + e.message)}
            <div class="vv-sc-jsonerror"><code>{e.field === '' ? '(JSON)' : e.field}</code> {e.message}</div>
          {/each}
        </div>
        <div class="vv-sc-modalactions">
          <button type="button" onclick={() => (importErrors = null)}>关闭</button>
        </div>
      </div>
    </div>
  {/if}
  {#if confirmClose}
    <!-- 脏态关闭确认（spec §3：应用/放弃二选一）——内联条而非原生 confirm
         （选择语义，非是非问） -->
    <div class="vv-sc-confirm" role="alertdialog" aria-label="未应用的修改">
      <span>有未应用的修改</span>
      <button
        type="button"
        onclick={() => {
          if (doApply()) {
            confirmClose = false;
            close();
          }
        }}>应用并关闭</button
      >
      <button
        type="button"
        onclick={() => {
          doDiscard();
          confirmClose = false;
          close();
        }}>放弃并关闭</button
      >
      <button type="button" onclick={() => (confirmClose = false)}>继续编辑</button>
    </div>
  {/if}
</div>

<style>
  /* 全屏 overlay（与工作区面板/全局搜索同交互模型）：不引入路由/深链（spec §2）。
     节内部件复用 app.css 全局 .vv-settings-* 类（退役弹层既有样式），本组件只
     管骨架布局。 */
  .vv-settings-center {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    background: var(--ui-bg);
    outline: none;
  }
  .vv-sc-head {
    display: flex;
    justify-content: flex-start;
    align-items: center;
    gap: var(--vv-sp-10);
    padding: 8px 16px;
    border-bottom: 1px solid var(--ui-border);
    flex: none;
  }
  /* 面板标题 fs-md（§3.2 孤值收敛：15px→--vv-fs-md，变更声明 §12.2-G4） */
  .vv-sc-title {
    font-weight: 600;
    font-size: var(--vv-fs-md);
  }
  .vv-sc-views {
    display: flex;
    gap: var(--vv-sp-2);
    border: 1px solid var(--ui-border);
    border-radius: var(--vv-radius-md);
    padding: 2px;
  }
  .vv-sc-viewbtn {
    background: none;
    border: 0;
    border-radius: var(--vv-radius-sm);
    padding: 2px 10px;
    font: inherit;
    font-size: var(--vv-fs-xs);
    cursor: pointer;
    color: var(--ui-fg-muted);
  }
  .vv-sc-viewbtn.active {
    background: var(--ui-tab-active-bg);
    color: var(--ui-fg);
  }
  .vv-sc-headspacer {
    flex: 1;
  }
  .vv-sc-dirty {
    color: var(--ui-warning);
    font-size: var(--vv-fs-xs);
  }
  /* 主钮 primary 形态（§8.1，变更：灰钮→accent 描边）：accent 文字+描边、hover
     提底；disabled 抑制 hover（§7），opacity .5 维持现值 */
  .vv-sc-apply {
    font-size: var(--vv-fs-xs);
    color: var(--ui-accent);
    border-color: var(--ui-accent);
  }
  .vv-sc-apply:hover:not(:disabled) {
    background: var(--ui-hover-bg);
  }
  .vv-sc-apply:disabled,
  .vv-sc-discard:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* 「放弃」保持既有形态（§12.2-G4 未列变更，零漂移不动） */
  .vv-sc-discard {
    font-size: var(--vv-fs-xs);
    background: none;
  }
  .vv-sc-close {
    border: 0;
    background: none;
    cursor: pointer;
    color: var(--ui-fg-muted);
    font-size: 16px;
    padding: 2px 6px;
  }
  .vv-sc-close:hover {
    color: var(--ui-fg);
  }
  .vv-sc-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .vv-sc-nav {
    width: 168px;
    flex: none;
    display: flex;
    flex-direction: column;
    gap: var(--vv-sp-2);
    padding: 10px 8px;
    border-right: 1px solid var(--ui-border);
    overflow: auto;
  }
  .vv-sc-navitem {
    text-align: left;
    background: none;
    border: 0;
    border-radius: var(--vv-radius-md);
    padding: 6px 10px;
    font: inherit;
    font-size: var(--vv-fs-sm);
    cursor: pointer;
    color: var(--ui-fg-muted);
    white-space: nowrap;
  }
  .vv-sc-navitem:hover {
    background: var(--ui-hover-bg);
    color: var(--ui-fg);
  }
  .vv-sc-navitem.active {
    background: var(--ui-tab-active-bg);
    color: var(--ui-fg);
  }
  /* 导入/导出动作区：驻导航底部（非分组项），滚动到分组清单之后 */
  .vv-sc-navactions {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: var(--vv-sp-2);
    padding-top: 8px;
    border-top: 1px solid var(--ui-border);
  }
  .vv-sc-navactions button {
    text-align: left;
    background: none;
    border: 0;
    border-radius: var(--vv-radius-md);
    padding: 6px 10px;
    font: inherit;
    font-size: var(--vv-fs-xs);
    cursor: pointer;
    color: var(--ui-fg-muted);
  }
  .vv-sc-navactions button:hover {
    background: var(--ui-hover-bg);
    color: var(--ui-fg);
  }
  .vv-sc-content {
    flex: 1;
    min-width: 0;
    overflow: auto;
    padding: 12px 16px 24px;
  }
  /* 节容器排布类 .vv-sc-section 在 app.css（节内容是子组件，scoped 样式够不到） */
  /* JSON 视图：等宽 textarea + 行号栏（spec §3，无编辑器依赖） */
  .vv-sc-jsonwrap {
    display: flex;
    border: 1px solid var(--ui-border);
    border-radius: var(--vv-radius-md);
    overflow: hidden;
    height: calc(100vh - 190px);
    min-height: 200px;
  }
  .vv-sc-gutter {
    flex: none;
    width: 3em;
    overflow: hidden;
    padding: 6px 4px;
    text-align: right;
    color: var(--ui-fg-muted);
    background: var(--ui-side-bg);
    border-right: 1px solid var(--ui-border);
    /* 等宽令牌（§3.1）：跟随用户代码字体设置（裸 ui-monospace 退役） */
    font-family: var(--vv-code-font);
    font-size: var(--vv-fs-xs);
    line-height: 1.5;
    user-select: none;
  }
  .vv-sc-gutter span {
    display: block;
  }
  .vv-sc-jsonarea {
    flex: 1;
    min-width: 0;
    border: 0;
    border-radius: 0;
    resize: none;
    font-family: var(--vv-code-font);
    font-size: var(--vv-fs-xs);
    line-height: 1.5;
    padding: 6px 8px;
    white-space: pre;
    overflow: auto;
  }
  .vv-sc-jsonerrors {
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--ui-danger);
    font-size: var(--vv-fs-xs);
    overflow-wrap: anywhere;
  }
  .vv-sc-jsonerror code {
    color: var(--ui-danger);
  }
  /* 脏态关闭确认条（底部悬浮） */
  .vv-sc-confirm {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    z-index: 31;
    display: flex;
    align-items: center;
    gap: var(--vv-sp-10);
    background: var(--ui-bg);
    border: 1px solid var(--ui-warning);
    border-radius: var(--vv-radius-lg);
    box-shadow: var(--vv-shadow-3);
    padding: 10px 14px;
    font-size: var(--vv-fs-sm);
  }
  .vv-sc-confirm button {
    font-size: var(--vv-fs-xs);
  }
  /* 导入/导出弹层（spec §4）：居中模态 + 半透明背板（--vv-scrim 令牌，§12.1 #10） */
  .vv-sc-modal {
    position: fixed;
    inset: 0;
    z-index: 32;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--vv-scrim);
    padding: 16px;
  }
  /* 阴影归档 --vv-shadow-3、圆角 10px 并入 --vv-radius-lg（§10-G4，变更声明） */
  .vv-sc-modalbox {
    display: flex;
    flex-direction: column;
    gap: var(--vv-sp-8);
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: var(--vv-radius-lg);
    box-shadow: var(--vv-shadow-3);
    padding: 16px 18px;
    width: min(520px, 92vw);
    max-height: 80vh;
    overflow: auto;
    font-size: var(--vv-fs-sm);
  }
  .vv-sc-modaltitle {
    font-weight: 600;
    font-size: var(--vv-fs-md);
  }
  .vv-sc-importdiffs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--vv-sp-6);
    max-height: 32vh;
    overflow: auto;
    border: 1px solid var(--ui-border);
    border-radius: var(--vv-radius-md);
    padding: 8px;
  }
  .vv-sc-importkey {
    font-weight: 600;
  }
  .vv-sc-importline {
    font-family: var(--vv-code-font);
    font-size: var(--vv-fs-xs);
    color: var(--ui-fg-muted);
    overflow-wrap: anywhere;
  }
  .vv-sc-importmode {
    display: flex;
    align-items: center;
    gap: var(--vv-sp-6);
  }
  .vv-sc-modalactions {
    display: flex;
    gap: var(--vv-sp-8);
    justify-content: flex-end;
  }
  .vv-sc-modalactions button {
    font-size: var(--vv-fs-xs);
  }
  @media (max-width: 600px) {
    .vv-sc-nav {
      width: 116px;
    }
  }
</style>
