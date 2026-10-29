<script lang="ts">
  // StorageSection.svelte — 设置中心「存储与数据」节（settings center spec §2.2，
  // Task 4）：七分类级精细化删除 + 恢复出厂。分类行 = 名称+说明+占用估算（复用
  // §2.1 collectStorageInfo 共享模块）+「清除」钮；全部删除带确认面板（红色危险
  // 调+列明后果）；删除即时生效项（主题/字体）经 saveSettings 订阅链实时回退；
  // 设置删除与恢复出厂后 location.reload()（回落 DEFAULTS/全新会话）。
  // 挂载配置分类（Spec 5 未落地）以禁用态渲染（前向兼容裁决）；单项细粒度删除
  // 不在本节重复（spec §2.2 纪律），行内链接指向各节。
  import { onMount } from 'svelte';
  import {
    collectStorageInfo,
    factoryReset,
    formatBytes,
    purgeCategory,
    type StorageCategoryId,
    type StorageInfo
  } from '../storageHealth';
  import { useSettingsNav } from './nav';
  import type { Settings } from '../stores/settings';

  // 契约占位（注册表统一 { draft, touch } 形态；本节为操作面，不编辑草稿）
  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  const navTo = useSettingsNav();

  let info = $state<StorageInfo | null>(null);
  let loading = $state(true);
  /** 待确认动作（分类 id 或恢复出厂）：null = 无——确认面板门（spec §2.2 纪律） */
  let pending = $state<StorageCategoryId | 'factory' | null>(null);
  let purging = $state(false);
  let note = $state('');

  async function refresh(): Promise<void> {
    loading = true;
    try {
      info = await collectStorageInfo();
    } catch {
      info = null; // 存储面不可用：显示为不支持形态，不阻塞本节
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void refresh(); // 进入分节时加载并缓存，手动「刷新」重算（不实时轮询）
  });

  /** 分类行占用显示（info 未载入时占位「…」） */
  function usageOf(cat: StorageCategoryId): string {
    if (info === null) return '…';
    switch (cat) {
      case 'settings':
        return formatBytes(info.settingsBytes);
      case 'sessions':
        return formatBytes(info.kvSnapshotBytes);
      case 'dirhandle':
        return formatBytes(info.kvDirHandleBytes);
      case 'themes':
        return formatBytes(info.themes.bytes);
      case 'fonts':
        return formatBytes(info.fonts.bytes);
      case 'mounts':
        return '—';
      case 'runtime-cache':
        return `${info.cacheNames.length} 个缓存`;
    }
  }

  /** 确认面板文案（spec §2.2：列明后果；恢复出厂措辞最强） */
  const CONSEQUENCES: Record<StorageCategoryId | 'factory', string> = {
    settings: '删除全部设置并重载页面：亮暗模式/外观/代码主题/字体/图表/布局/排除规则/自动刷新/计算策略全部回落默认值。',
    sessions: '删除标签页与工作区快照：当前内存会话不受影响，下次启动为空会话；目录授权句柄保留。',
    dirhandle: '删除目录授权句柄：localfs 来源下次启动不再自动恢复，需重新授权；快照恢复失败降级链照旧。',
    themes: '删除全部已导入主题：引用这些主题的外观槽位回落「默认」（实时生效，无需重载）；内置主题不受影响。单项删除在「外观」节。',
    fonts: '删除全部网络字体并注销加载：引用字体的槽位回落默认字体栈（实时生效）。单项删除在「字体」节。',
    mounts: '挂载配置管理尚未启用（目录挂载管理页后续提供）。',
    'runtime-cache': '清除运行时缓存（语法 wasm/媒体等）：precache 保留，离线能力不受影响。',
    factory:
      '恢复出厂：删除全部设置、会话快照、目录授权、导入主题、网络字体，清除全部缓存（含离线 precache），注销 Service Worker 并重载页面。此操作不可恢复。'
  };

  const PURGE_LABELS: Record<StorageCategoryId, string> = {
    settings: '清除设置',
    sessions: '清除会话快照',
    dirhandle: '清除目录授权',
    themes: '删除导入主题',
    fonts: '删除网络字体',
    mounts: '清除挂载配置',
    'runtime-cache': '清除运行时缓存'
  };

  const isFactory = $derived(pending === 'factory');
  const pendingLabel = $derived(
    pending === null ? '' : pending === 'factory' ? '恢复出厂' : PURGE_LABELS[pending]
  );

  function cancelPurge(): void {
    pending = null;
  }

  /** 确认执行：删除即时生效项后重算用量；设置删除与恢复出厂后重载页面 */
  async function confirmPurge(): Promise<void> {
    if (pending === null || purging) return;
    const action: StorageCategoryId | 'factory' = pending;
    purging = true;
    note = '';
    try {
      if (action === 'factory') {
        const r = await factoryReset();
        location.reload(); // 全新会话（最高危动作的收尾，spec §2.2）
        note = `已恢复出厂（清 ${r.cachesCleared} 个缓存、注销 ${r.swUnregistered} 个 Service Worker），正在重载…`;
        return;
      }
      const r = await purgeCategory(action);
      if (action === 'settings') {
        location.reload(); // 删除键并重载，回落 DEFAULTS（订阅链重初始化）
        return;
      }
      note =
        action === 'runtime-cache'
          ? `已清除 ${r.deleted} 个运行时缓存（precache 保留）`
          : `已清除 ${r.deleted} 项`;
      pending = null;
      void refresh();
    } catch (err) {
      note = `清除失败：${err instanceof Error ? err.message : String(err)}`;
      pending = null;
    } finally {
      purging = false;
    }
  }
</script>

<section class="vv-sc-section">
  <div class="vv-settings-label">存储与数据</div>
  <div class="vv-settings-hint">
    浏览器「清除站点数据」是整站一刀切；此处按分类精细删除，配合「关于」节的用量显示定位占用。
    <button type="button" class="vv-sc-linklike" onclick={() => navTo('about')}>查看存储用量 →</button>
  </div>

  <ul class="vv-storage-cats">
    <li class="vv-storage-cat">
      <div class="vv-storage-catinfo">
        <span class="vv-storage-catname">设置</span>
        <span class="vv-storage-catdesc">localStorage（外观/字体/图表/布局/排除规则等全部设置项）</span>
      </div>
      <span class="vv-storage-catsize">{usageOf('settings')}</span>
      <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => (pending = 'settings')}>
        清除
      </button>
    </li>
    <li class="vv-storage-cat">
      <div class="vv-storage-catinfo">
        <span class="vv-storage-catname">会话快照</span>
        <span class="vv-storage-catdesc">IndexedDB kv（标签页/工作区布局）</span>
      </div>
      <span class="vv-storage-catsize">{usageOf('sessions')}</span>
      <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => (pending = 'sessions')}>
        清除
      </button>
    </li>
    <li class="vv-storage-cat">
      <div class="vv-storage-catinfo">
        <span class="vv-storage-catname">目录授权句柄</span>
        <span class="vv-storage-catdesc">IndexedDB kv（localfs 来源的自动恢复凭据）</span>
      </div>
      <span class="vv-storage-catsize">{usageOf('dirhandle')}</span>
      <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => (pending = 'dirhandle')}>
        清除
      </button>
    </li>
    <li class="vv-storage-cat">
      <div class="vv-storage-catinfo">
        <span class="vv-storage-catname">导入主题</span>
        <span class="vv-storage-catdesc">IndexedDB themes（{info?.themes.records ?? 0} 条）</span>
      </div>
      <span class="vv-storage-catsize">{usageOf('themes')}</span>
      <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => (pending = 'themes')}>
        清除
      </button>
    </li>
    <li class="vv-storage-cat">
      <div class="vv-storage-catinfo">
        <span class="vv-storage-catname">网络字体</span>
        <span class="vv-storage-catdesc">IndexedDB fonts（{info?.fonts.records ?? 0} 条）</span>
      </div>
      <span class="vv-storage-catsize">{usageOf('fonts')}</span>
      <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => (pending = 'fonts')}>
        清除
      </button>
    </li>
    <li class="vv-storage-cat vv-storage-cat-disabled">
      <div class="vv-storage-catinfo">
        <span class="vv-storage-catname">挂载配置</span>
        <span class="vv-storage-catdesc">目录挂载管理页后续提供（即将推出）</span>
      </div>
      <span class="vv-storage-catsize">—</span>
      <button type="button" class="vv-storage-danger" disabled title="目录挂载管理（Spec 5）未落地，暂无挂载配置可清">
        清除
      </button>
    </li>
    <li class="vv-storage-cat">
      <div class="vv-storage-catinfo">
        <span class="vv-storage-catname">运行时缓存</span>
        <span class="vv-storage-catdesc">
          Cache Storage（语法 wasm/媒体等运行时缓存，precache 保留）
          {#if info !== null && info.cacheNames.length > 0}
            <span class="vv-storage-cachenames">{info.cacheNames.join('、')}</span>
          {/if}
        </span>
      </div>
      <span class="vv-storage-catsize">{usageOf('runtime-cache')}</span>
      <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => (pending = 'runtime-cache')}>
        清除
      </button>
    </li>
  </ul>

  {#if pending !== null}
    <!-- 确认面板（spec §2.2：红色危险调+列明后果；恢复出厂措辞最强） -->
    <div class="vv-storage-confirm" role="alertdialog" aria-label="{pendingLabel}确认">
      <div class="vv-storage-confirmlabel">{isFactory ? '⚠ 恢复出厂' : pendingLabel}</div>
      <div class="vv-storage-confirmtext">{CONSEQUENCES[pending]}</div>
      <div class="vv-storage-confirmrow">
        <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => void confirmPurge()}>
          {purging ? '执行中…' : isFactory ? '确认恢复出厂（不可恢复）' : '确认清除'}
        </button>
        <button type="button" onclick={cancelPurge} disabled={purging}>取消</button>
      </div>
    </div>
  {/if}

  {#if note}
    <div class="vv-settings-note" role="status">{note}</div>
  {/if}

  <div class="vv-settings-label">恢复出厂</div>
  <div class="vv-settings-hint">独立于分类清单的兜底动作：全部分类 + 注销 Service Worker + 清全部缓存 + 重载。</div>
  <div class="vv-settings-import">
    <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => (pending = 'factory')}>
      恢复出厂…
    </button>
    {#if loading}
      <span class="vv-storage-loading" role="status">统计中…</span>
    {:else}
      <button type="button" onclick={() => void refresh()}>刷新统计</button>
    {/if}
  </div>
</section>

<style>
  .vv-storage-cats {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--vv-sp-4);
  }
  .vv-storage-cat {
    display: flex;
    align-items: center;
    gap: var(--vv-sp-10);
    border: 1px solid var(--ui-border);
    border-radius: var(--vv-radius-md);
    padding: 6px 10px;
    font-size: var(--vv-fs-xs);
  }
  .vv-storage-cat-disabled {
    opacity: 0.55;
  }
  .vv-storage-catinfo {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--vv-sp-2);
  }
  .vv-storage-catname {
    font-weight: 600;
  }
  .vv-storage-catdesc {
    color: var(--ui-fg-muted);
    overflow-wrap: anywhere;
  }
  /* 等宽令牌（§3.1 四处点名之一）：跟随用户代码字体设置 */
  .vv-storage-cachenames {
    display: block;
    font-family: var(--vv-code-font);
    font-size: var(--vv-fs-2xs);
  }
  .vv-storage-catsize {
    flex: none;
    min-width: 5.5em;
    text-align: right;
    color: var(--ui-fg-muted);
    font-variant-numeric: tabular-nums;
  }
  /* danger 形态（§8.1 现法为基准）：死回退 #d33 清理（§2.3，--ui-danger 三块恒定义） */
  .vv-storage-danger {
    color: var(--ui-danger);
    border-color: var(--ui-danger);
  }
  .vv-storage-danger:disabled {
    opacity: 0.5;
    cursor: default;
  }
  /* 危险确认框（§5.2 强调边框语义）：死回退清理 + 阴影/圆角入档（零漂移） */
  .vv-storage-confirm {
    display: flex;
    flex-direction: column;
    gap: var(--vv-sp-6);
    border: 1px solid var(--ui-danger);
    border-radius: var(--vv-radius-lg);
    padding: 10px 12px;
    font-size: var(--vv-fs-xs);
  }
  .vv-storage-confirmlabel {
    font-weight: 600;
    color: var(--ui-danger);
  }
  .vv-storage-confirmtext {
    overflow-wrap: anywhere;
  }
  .vv-storage-confirmrow {
    display: flex;
    gap: var(--vv-sp-8);
  }
  .vv-storage-confirmrow button {
    font-size: var(--vv-fs-xs);
  }
  .vv-storage-loading {
    color: var(--ui-fg-muted);
    font-size: var(--vv-fs-xs);
    align-self: center;
  }
  /* linklike 形态（§8.1 基准现法）：仅字号挂 --vv-fs-xs，其余保持 */
  .vv-sc-linklike {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    font-size: var(--vv-fs-xs);
    color: var(--ui-accent);
    cursor: pointer;
    text-decoration: underline;
  }
</style>
