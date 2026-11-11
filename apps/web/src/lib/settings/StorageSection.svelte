<script lang="ts">
  // StorageSection.svelte — 设置中心「存储与数据」节（settings center spec §2.2，
  // Task 4）：八分类级精细化删除 + 恢复出厂（导入图标主题分类随 iconThemes store
  // 接入补列，图标主题 spec Task 4）。分类行 = 名称+说明+占用估算（复用
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
  import { t } from '../i18n/index.svelte';
  import { clampSize, STORAGE_MB_RANGE, type Settings } from '../stores/settings';

  // 契约（注册表统一 { draft, touch } 形态）：阈值行编辑草稿（计划 2 Task 5），
  // 其余仍为操作面不写 draft
  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  const navTo = useSettingsNav();

  /** 远端下载确认阈值提交（onchange，blur/回车触发）：输入框与 draft 同步为规范化
   * 值（字号渐进输入先例终审 I-1 承续：无 oninput 通道，输入途中不写 draft/DOM
   * ——渐进键入不被回写打断），非法/空输入回落当前 draft 值。 */
  function onConfirmMbChange(e: Event): void {
    const inp = e.currentTarget as HTMLInputElement;
    const clamped =
      inp.value.trim() === ''
        ? draft.storage.remoteDownloadConfirmMb
        : clampSize(Number(inp.value), STORAGE_MB_RANGE, draft.storage.remoteDownloadConfirmMb);
    inp.value = String(clamped);
    draft.storage.remoteDownloadConfirmMb = clamped;
    touch();
  }

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
      case 'icon-themes':
        return formatBytes(info.iconThemes.bytes);
      case 'fonts':
        return formatBytes(info.fonts.bytes);
      case 'mounts':
        return '—';
      case 'runtime-cache':
        return t('settings.storage.usageCaches', { count: info.cacheNames.length });
    }
  }

  /** 确认面板文案（spec §2.2：列明后果；恢复出厂措辞最强）——id → 取文案闭包
   * （分类 id 为稳定标识符；字面键调用保 TFunction 类型安全，模板内求值保 locale
   * 响应式，域 C 抽取 Task 6） */
  const CONSEQUENCES: Record<StorageCategoryId | 'factory', () => string> = {
    settings: () => t('settings.storage.consequenceSettings'),
    sessions: () => t('settings.storage.consequenceSessions'),
    dirhandle: () => t('settings.storage.consequenceDirhandle'),
    themes: () => t('settings.storage.consequenceThemes'),
    'icon-themes': () => t('settings.storage.consequenceIconThemes'),
    fonts: () => t('settings.storage.consequenceFonts'),
    mounts: () => t('settings.storage.consequenceMounts'),
    'runtime-cache': () => t('settings.storage.consequenceRuntime'),
    factory: () => t('settings.storage.consequenceFactory')
  };

  const PURGE_LABELS: Record<StorageCategoryId, () => string> = {
    settings: () => t('settings.storage.purgeSettings'),
    sessions: () => t('settings.storage.purgeSessions'),
    dirhandle: () => t('settings.storage.purgeDirhandle'),
    themes: () => t('settings.storage.purgeThemes'),
    'icon-themes': () => t('settings.storage.purgeIconThemes'),
    fonts: () => t('settings.storage.purgeFonts'),
    mounts: () => t('settings.storage.purgeMounts'),
    'runtime-cache': () => t('settings.storage.purgeRuntime')
  };

  const isFactory = $derived(pending === 'factory');
  const pendingLabel = $derived(
    pending === null ? '' : pending === 'factory' ? t('settings.storage.factory') : PURGE_LABELS[pending]()
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
        note = t('settings.storage.factoryDone', { caches: r.cachesCleared, sw: r.swUnregistered });
        return;
      }
      const r = await purgeCategory(action);
      if (action === 'settings') {
        location.reload(); // 删除键并重载，回落 DEFAULTS（订阅链重初始化）
        return;
      }
      note =
        action === 'runtime-cache'
          ? t('settings.storage.runtimePurged', { count: r.deleted })
          : t('settings.storage.itemsPurged', { count: r.deleted });
      pending = null;
      void refresh();
    } catch (err) {
      note = t('settings.storage.purgeFailed', { message: err instanceof Error ? err.message : String(err) });
      pending = null;
    } finally {
      purging = false;
    }
  }
</script>

<section class="vv-sc-section">
  <div class="vv-settings-label">{t('settings.storage.label')}</div>
  <div class="vv-settings-hint">
    {t('settings.storage.hint')}
    <button type="button" class="vv-sc-linklike" onclick={() => navTo('about')}>{t('settings.storage.usageLink')}</button>
  </div>

  <!-- 远端下载确认阈值（spec §6.4，计划 2 Task 5）：MB 计 clamp 1–4096，确认门
       在泵启动前拦截（ViewerPane 消费，读现值即时生效）；size 未知的不定态下载
       不适用（无前置数字，直接不定态进度卡）。 -->
  <label class="vv-settings-theme-row">
    <span>{t('settings.storage.thresholdRow')}</span>
    <input
      type="number"
      min={STORAGE_MB_RANGE[0]}
      max={STORAGE_MB_RANGE[1]}
      step="1"
      value={draft.storage.remoteDownloadConfirmMb}
      onchange={(e) => onConfirmMbChange(e)}
      aria-label={t('settings.storage.thresholdAria')}
    />
  </label>
  <div class="vv-settings-hint">
    {t('settings.storage.thresholdHint')}
  </div>

  <ul class="vv-storage-cats">
    <li class="vv-storage-cat">
      <div class="vv-storage-catinfo">
        <span class="vv-storage-catname">{t('settings.storage.catSettings')}</span>
        <span class="vv-storage-catdesc">{t('settings.storage.catSettingsDesc')}</span>
      </div>
      <span class="vv-storage-catsize">{usageOf('settings')}</span>
      <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => (pending = 'settings')}>
        {t('settings.storage.purge')}
      </button>
    </li>
    <li class="vv-storage-cat">
      <div class="vv-storage-catinfo">
        <span class="vv-storage-catname">{t('settings.storage.catSessions')}</span>
        <span class="vv-storage-catdesc">{t('settings.storage.catSessionsDesc')}</span>
      </div>
      <span class="vv-storage-catsize">{usageOf('sessions')}</span>
      <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => (pending = 'sessions')}>
        {t('settings.storage.purge')}
      </button>
    </li>
    <li class="vv-storage-cat">
      <div class="vv-storage-catinfo">
        <span class="vv-storage-catname">{t('settings.storage.catDirhandle')}</span>
        <span class="vv-storage-catdesc">{t('settings.storage.catDirhandleDesc')}</span>
      </div>
      <span class="vv-storage-catsize">{usageOf('dirhandle')}</span>
      <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => (pending = 'dirhandle')}>
        {t('settings.storage.purge')}
      </button>
    </li>
    <li class="vv-storage-cat">
      <div class="vv-storage-catinfo">
        <span class="vv-storage-catname">{t('settings.storage.catThemes')}</span>
        <span class="vv-storage-catdesc">{t('settings.storage.catThemesDesc', { count: info?.themes.records ?? 0 })}</span>
      </div>
      <span class="vv-storage-catsize">{usageOf('themes')}</span>
      <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => (pending = 'themes')}>
        {t('settings.storage.purge')}
      </button>
    </li>
    <li class="vv-storage-cat">
      <div class="vv-storage-catinfo">
        <span class="vv-storage-catname">{t('settings.storage.catIconThemes')}</span>
        <span class="vv-storage-catdesc">{t('settings.storage.catIconThemesDesc', { count: info?.iconThemes.records ?? 0 })}</span>
      </div>
      <span class="vv-storage-catsize">{usageOf('icon-themes')}</span>
      <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => (pending = 'icon-themes')}>
        {t('settings.storage.purge')}
      </button>
    </li>
    <li class="vv-storage-cat">
      <div class="vv-storage-catinfo">
        <span class="vv-storage-catname">{t('settings.storage.catFonts')}</span>
        <span class="vv-storage-catdesc">{t('settings.storage.catFontsDesc', { count: info?.fonts.records ?? 0 })}</span>
      </div>
      <span class="vv-storage-catsize">{usageOf('fonts')}</span>
      <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => (pending = 'fonts')}>
        {t('settings.storage.purge')}
      </button>
    </li>
    <li class="vv-storage-cat vv-storage-cat-disabled">
      <div class="vv-storage-catinfo">
        <span class="vv-storage-catname">{t('settings.storage.catMounts')}</span>
        <span class="vv-storage-catdesc">{t('settings.storage.catMountsDesc')}</span>
      </div>
      <span class="vv-storage-catsize">—</span>
      <button type="button" class="vv-storage-danger" disabled title={t('settings.storage.catMountsDisabledTitle')}>
        {t('settings.storage.purge')}
      </button>
    </li>
    <li class="vv-storage-cat">
      <div class="vv-storage-catinfo">
        <span class="vv-storage-catname">{t('settings.storage.catRuntime')}</span>
        <span class="vv-storage-catdesc">
          {t('settings.storage.catRuntimeDesc')}
          {#if info !== null && info.cacheNames.length > 0}
            <span class="vv-storage-cachenames">{info.cacheNames.join(t('settings.common.listSep'))}</span>
          {/if}
        </span>
      </div>
      <span class="vv-storage-catsize">{usageOf('runtime-cache')}</span>
      <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => (pending = 'runtime-cache')}>
        {t('settings.storage.purge')}
      </button>
    </li>
  </ul>

  {#if pending !== null}
    <!-- 确认面板（spec §2.2：红色危险调+列明后果；恢复出厂措辞最强） -->
    <div class="vv-storage-confirm" role="alertdialog" aria-label={t('settings.storage.confirmAria', { label: pendingLabel })}>
      <div class="vv-storage-confirmlabel">{isFactory ? t('settings.storage.factoryConfirmLabel') : pendingLabel}</div>
      <div class="vv-storage-confirmtext">{CONSEQUENCES[pending]()}</div>
      <div class="vv-storage-confirmrow">
        <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => void confirmPurge()}>
          {purging ? t('settings.storage.purging') : isFactory ? t('settings.storage.confirmFactory') : t('settings.storage.confirmPurge')}
        </button>
        <button type="button" onclick={cancelPurge} disabled={purging}>{t('settings.storage.cancel')}</button>
      </div>
    </div>
  {/if}

  {#if note}
    <div class="vv-settings-note" role="status">{note}</div>
  {/if}

  <div class="vv-settings-label">{t('settings.storage.factory')}</div>
  <div class="vv-settings-hint">{t('settings.storage.factoryHint')}</div>
  <div class="vv-settings-import">
    <button type="button" class="vv-storage-danger" disabled={purging} onclick={() => (pending = 'factory')}>
      {t('settings.storage.factoryButton')}
    </button>
    {#if loading}
      <span class="vv-storage-loading" role="status">{t('settings.storage.counting')}</span>
    {:else}
      <button type="button" onclick={() => void refresh()}>{t('settings.storage.refreshStats')}</button>
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
  /* disabled 归一（§7：五套口径统一 .5，复核意见从严执行）；行内 :disabled 钮
     自身 opacity .5 与行级叠加语义保持（双层叠加处置无变更声明，不擅自改） */
  .vv-storage-cat-disabled {
    opacity: 0.5;
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
