<script lang="ts">
  // SettingsCenter.svelte — 统一设置中心（全屏 overlay，settings center spec
  // 2026-10-19 §2）：左侧分组导航 + 右侧表单。取代 SettingsPanel 弹层（TopBar ⚙
  // 与 Ctrl+, 双入口均指向本页，AppShell 挂载）。分组由注册表数组驱动
  // （{ id, label, content }，content 为节组件）——后续分组（布局/存储与数据/
  // 关于/导入导出）以注册项插入，零骨架改动。
  // 草稿契约：打开时深拷贝生效 settings 为 draft；各节组件只改 draft 并调
  // touch()，落盘与生效时机由本组件统一决定——Task 1 阶段 touch=即时持久化
  // （saveSettings，功能等价迁移）；Task 2 起改为草稿统一应用（spec §3）。
  import type { Component } from 'svelte';
  import { loadSettings, saveSettings, type Settings } from './stores/settings';
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

  // 组序（spec §2 定稿序的在 Task 1 在场组）：布局/存储与数据/关于由后续任务补入
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

  /** 节改动上收（draft 契约，见文件头）：Task 1 阶段即时持久化（与退役弹层
   * 「逐字段改动即时 saveSettings」功能等价），$state.snapshot 剥代理入存储。 */
  function touch(): void {
    saveSettings($state.snapshot(draft) as Settings);
  }

  let draft = $state<Settings>(loadSettings());
  let rootEl = $state<HTMLElement | null>(null);

  $effect(() => {
    // 全屏页挂载即聚焦（Esc 关闭键盘可达）；关闭时还原焦点（SettingsPanel 同模式）
    rootEl?.focus();
  });

  $effect(() => {
    // Esc 全局化兜底（与退役 SettingsPanel/GlobalSearchPanel 同模式）：焦点落到
    // 面板外时 Esc 也关闭（合成 Esc 的派发目标即根元素，容器通道为主路径）
    const onWinKey = (e: KeyboardEvent): void => {
      if (
        e.key === 'Escape' &&
        rootEl !== null &&
        (e.target instanceof Node ? !rootEl.contains(e.target) : true)
      ) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onWinKey);
    return () => window.removeEventListener('keydown', onWinKey);
  });

  /** 左导航键盘可达（spec §2 分组导航 ↑↓ 切组）：焦点在导航内时 ↑↓ 换组 */
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
      close();
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
    <button type="button" class="vv-sc-close" aria-label="关闭设置" title="关闭（Esc）" onclick={close}>✕</button>
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
      {#each groups as g (g.id)}
        {#if g.id === activeId}
          {@const Section = g.content}
          <Section draft={draft} touch={touch} />
        {/if}
      {/each}
    </div>
  </div>
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
    justify-content: space-between;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid var(--ui-border);
    flex: none;
  }
  .vv-sc-title {
    font-weight: 600;
    font-size: 15px;
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
  @media (max-width: 600px) {
    .vv-sc-nav {
      width: 116px;
    }
  }
</style>
