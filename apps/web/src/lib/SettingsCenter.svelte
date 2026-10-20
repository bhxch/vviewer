<script lang="ts">
  // SettingsCenter.svelte — 统一设置中心（全屏 overlay，settings center spec
  // 2026-10-19 §2/§3）：左侧分组导航 + 右侧 UI/JSON 双视图。取代 SettingsPanel
  // 弹层（TopBar ⚙ 与 Ctrl+, 双入口均指向本页，AppShell 挂载）。分组由注册表
  // 数组驱动（{ id, label, content }，content 为节组件）——后续分组（布局/
  // 存储与数据/关于/导入导出）以注册项插入，零骨架改动。
  // 草稿语义（spec §3）：打开即 openDraft 深拷贝生效 settings；表单节组件只改
  // draft 并调 touch()（仅使 JSON 派生失效，不落盘）；「应用」统一经
  // commit()→saveSettings 走集中订阅链；JSON 视图与表单共享同一 draft——表单→
  // JSON 即格式化序列化，JSON→表单先 parse+校验（settingsDraft 白名单镜像），
  // 非法停留 JSON 视图标错不丢文本；脏态关闭走确认（requestClose，Ctrl+,/⚙ 的
  // 关闭路径同此裁决）。
  import { untrack, type Component } from 'svelte';
  import { loadSettings, type Settings } from './stores/settings';
  import {
    applyJson,
    commit,
    draftToJson,
    isDirty,
    openDraft,
    type SettingsIssue
  } from './settingsDraft';
  import AppearanceSection from './settings/AppearanceSection.svelte';
  import FontsSection from './settings/FontsSection.svelte';
  import DiagramsSection from './settings/DiagramsSection.svelte';
  import SearchSection from './settings/SearchSection.svelte';
  import AutoRefreshSection from './settings/AutoRefreshSection.svelte';
  import ComputeSection from './settings/ComputeSection.svelte';

  let { onclose }: { onclose(): void } = $props();

  /** 分组注册表项：Task 3/4 新分组以注册项插入本数组（spec §2 定稿序排列） */
  interface SettingsGroup {
    id: string;
    label: string;
    content: Component<{ draft: Settings; touch(): void }>;
  }

  // 组序（spec §2 定稿序的在 Task 1/2 在场组）：布局/存储与数据/关于由后续任务补入
  const groups: SettingsGroup[] = [
    { id: 'appearance', label: '外观', content: AppearanceSection },
    { id: 'fonts', label: '字体', content: FontsSection },
    { id: 'diagrams', label: '图表', content: DiagramsSection },
    { id: 'search', label: '搜索与排除', content: SearchSection },
    { id: 'autorefresh', label: '自动刷新', content: AutoRefreshSection },
    { id: 'compute', label: '计算', content: ComputeSection }
  ];

  let activeId = $state('appearance');
  const activeGroup = $derived(groups.find((g) => g.id === activeId) ?? groups[0]!);

  // ---------- 草稿（spec §3：打开深拷贝，两视图共享） ----------
  let applied = $state<Settings>(loadSettings()); // 最近一次应用的生效值（脏态基准）
  // untrack：draft 只取打开时刻的 applied 快照（此后 applied 只在应用/放弃时整体
  // 重建，无滚动依赖可建立）
  let draft = $state<Settings>(openDraft(untrack(() => applied)));
  const dirty = $derived(isDirty(draft, applied));

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

  /** 应用：JSON 视图先写回校验；统一 commit(draft)→saveSettings 集中订阅链。
   * 成功后自动清除脏态不清页（applied 刷新为持久值）。失败返回 false 停留。 */
  function doApply(): boolean {
    if (view === 'json') {
      const r = applyJson(draft, jsonDisplay);
      if (!r.ok) {
        jsonErrors = r.errors;
        return false;
      }
    }
    commit(draft);
    applied = loadSettings();
    // draft 以规范化 applied 重建（评审 L6）：normalize 截掉的脏值（如非法
    // krokiHost 落 ''）不再留在 draft——否则 applied≠draft 恒脏、确认条失实
    draft = openDraft(applied);
    jsonDirtyBuffer = null;
    jsonErrors = null;
    confirmClose = false; // 评审 L2：确认条开着时经头部「应用」成功，条随之复位
    return true;
  }

  /** 放弃：draft 还原为最近应用值（JSON 缓冲与标错一并丢弃） */
  function doDiscard(): void {
    draft = openDraft(applied);
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
    gap: 10px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--ui-border);
    flex: none;
  }
  .vv-sc-title {
    font-weight: 600;
    font-size: 15px;
  }
  .vv-sc-views {
    display: flex;
    gap: 2px;
    border: 1px solid var(--ui-border);
    border-radius: 6px;
    padding: 2px;
  }
  .vv-sc-viewbtn {
    background: none;
    border: 0;
    border-radius: 4px;
    padding: 2px 10px;
    font: inherit;
    font-size: 12px;
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
    font-size: 12px;
  }
  .vv-sc-apply {
    font-size: 12px;
  }
  .vv-sc-apply:disabled,
  .vv-sc-discard:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .vv-sc-discard {
    font-size: 12px;
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
    gap: 2px;
    padding: 10px 8px;
    border-right: 1px solid var(--ui-border);
    overflow: auto;
  }
  .vv-sc-navitem {
    text-align: left;
    background: none;
    border: 0;
    border-radius: 6px;
    padding: 6px 10px;
    font: inherit;
    font-size: 13px;
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
    border-radius: 6px;
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
    font-family: ui-monospace, monospace;
    font-size: 12px;
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
    font-family: ui-monospace, monospace;
    font-size: 12px;
    line-height: 1.5;
    padding: 6px 8px;
    white-space: pre;
    overflow: auto;
  }
  .vv-sc-jsonerrors {
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--ui-danger, #d33);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .vv-sc-jsonerror code {
    color: var(--ui-danger, #d33);
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
    gap: 10px;
    background: var(--ui-bg);
    border: 1px solid var(--ui-warning);
    border-radius: 8px;
    box-shadow: 0 8px 28px rgb(0 0 0 / 22%);
    padding: 10px 14px;
    font-size: 13px;
  }
  .vv-sc-confirm button {
    font-size: 12px;
  }
  @media (max-width: 600px) {
    .vv-sc-nav {
      width: 116px;
    }
  }
</style>
