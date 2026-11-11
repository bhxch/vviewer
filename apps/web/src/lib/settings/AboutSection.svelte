<script lang="ts">
  // AboutSection.svelte — 设置中心「关于」节（settings center spec §2.1，Task 4）：
  // 项目信息（应用名/前端构建版本与服务端 health 版本并列+不一致注记/health 摘要/
  // 仓库/许可/第三方致谢）+ 存储用量与配额（estimate 聚合+usageDetails 细分+本地
  // 估算+IndexedDB 分 store 计数，进入分节加载+手动刷新）+ 持久化存储（persist
  // 状态行+用户手势申请按钮）。只读健康视图——操作面在「存储与数据」节，互链跳转；
  // 两节共享 storageHealth 用量计算模块（spec §2.1/§2.2 关系）。
  import { onMount } from 'svelte';
  import { appVersion } from '../buildInfo';
  import { loadServerHealth } from '../serverHealthCache';
  import {
    collectStorageInfo,
    formatBytes,
    requestPersistent,
    type StorageInfo
  } from '../storageHealth';
  import { useSettingsNav } from './nav';
  import { t } from '../i18n/index.svelte';
  import type { Settings } from '../stores/settings';

  // 契约占位（注册表统一 { draft, touch } 形态；本节为只读视图，不编辑草稿，
  // 形参以 _ 前缀落位占位，props 面 { draft, touch } 契约不变）
  let { draft: _draft, touch: _touch }: { draft: Settings; touch(): void } = $props();

  const navTo = useSettingsNav();

  // 三条外链均写完整字面量：svelte/no-navigation-without-resolve 靠字面量识别绝对 URL，
  // 不解析模板串里的标识符——`${REPO_URL}/...` 会被当成内部链接要求 resolve()
  const REPO_URL = 'https://github.com/bhxch/vviewer';
  const LICENSE_URL = 'https://github.com/bhxch/vviewer/blob/main/LICENSE';
  const NOTICES_URL = 'https://github.com/bhxch/vviewer/blob/main/THIRD_PARTY_NOTICES.md';

  const frontendVersion = appVersion(); // 构建期定型；vitest 降级 null →「开发构建」
  const health = loadServerHealth(); // 会话缓存；无记录 = 未连接（降级显示）
  const versionMismatch = $derived(
    frontendVersion !== null && health !== null && frontendVersion !== health.version
  );

  let info = $state<StorageInfo | null>(null);
  let persisted = $state<boolean | null>(null);
  let loading = $state(true);
  let persistNote = $state('');
  let requesting = $state(false);

  async function refresh(): Promise<void> {
    loading = true;
    try {
      info = await collectStorageInfo();
      persisted = info.persisted;
    } catch {
      info = null;
      persisted = null;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void refresh(); // 进入分节加载，手动「刷新」重算（不实时轮询）
  });

  /** 申请持久化存储（用户手势内调用）：false 时解释常见原因（spec §2.1） */
  async function onRequestPersist(): Promise<void> {
    requesting = true;
    persistNote = '';
    try {
      const granted = await requestPersistent();
      persistNote = granted
        ? t('settings.about.persistGranted')
        : t('settings.about.persistDenied');
      void refresh(); // 状态行反映最新结果
    } finally {
      requesting = false;
    }
  }

  const detailEntries = $derived(
    info?.estimate?.details === null || info?.estimate?.details === undefined
      ? []
      : Object.entries(info.estimate.details)
  );
</script>

<section class="vv-sc-section">
  <div class="vv-settings-label">{t('settings.about.projectLabel')}</div>
  <div class="vv-about-row"><span class="vv-about-key">{t('settings.about.appKey')}</span><span>vviewer</span></div>
  <div class="vv-about-row">
    <span class="vv-about-key">{t('settings.about.frontendKey')}</span>
    <span>{frontendVersion ?? t('settings.about.devBuild')}</span>
  </div>
  <div class="vv-about-row">
    <span class="vv-about-key">{t('settings.about.serverKey')}</span>
    <span>{health?.version ?? t('settings.about.notConnected')}</span>
  </div>
  {#if versionMismatch}
    <div class="vv-settings-warn" role="status">{t('settings.about.mismatch', { front: frontendVersion ?? '', server: health?.version ?? '' })}</div>
  {/if}
  {#if health !== null}
    <div class="vv-about-row">
      <span class="vv-about-key">{t('settings.about.capsKey')}</span>
      <span>{health.capabilities.join(t('settings.common.listSep')) || '—'}</span>
    </div>
    <div class="vv-about-row">
      <span class="vv-about-key">{t('settings.about.engineKey')}</span>
      <span>{health.searchEngine ?? t('settings.about.notDeclared')}</span>
    </div>
    <div class="vv-about-row">
      <span class="vv-about-key">{t('settings.about.rootsKey')}</span>
      <span>{t('settings.about.rootsCount', { count: health.roots ?? 1 })}</span>
    </div>
  {/if}
  <div class="vv-about-row">
    <span class="vv-about-key">{t('settings.about.repoKey')}</span>
    <a href={REPO_URL} target="_blank" rel="noreferrer">github.com/bhxch/vviewer</a>
  </div>
  <div class="vv-about-row">
    <span class="vv-about-key">{t('settings.about.licenseKey')}</span>
    <a href={LICENSE_URL} target="_blank" rel="noreferrer">Apache-2.0</a>
  </div>
  <div class="vv-about-row">
    <span class="vv-about-key">{t('settings.about.noticesKey')}</span>
    <a href={NOTICES_URL} target="_blank" rel="noreferrer">THIRD_PARTY_NOTICES.md</a>
  </div>

  <div class="vv-settings-label">{t('settings.about.usageLabel')}</div>
  <div class="vv-settings-hint">
    {t('settings.about.quotaHint')}
    <button type="button" class="vv-sc-linklike" onclick={() => navTo('storage')}>{t('settings.about.storageLink')}</button>
  </div>
  {#if info !== null && info.estimate !== null}
    <div class="vv-about-row">
      <span class="vv-about-key">{t('settings.about.usedQuotaKey')}</span>
      <span>{formatBytes(info.estimate.usage)} / {formatBytes(info.estimate.quota)}</span>
    </div>
    {#each detailEntries as [k, v] (k)}
      <div class="vv-about-row vv-about-detail">
        <span class="vv-about-key">{k}</span>
        <span>{formatBytes(v)}</span>
      </div>
    {/each}
  {:else}
    <div class="vv-settings-hint">{t('settings.about.noQuotaHint')}</div>
  {/if}
  <div class="vv-about-row">
    <span class="vv-about-key">{t('settings.about.lsKey')}</span>
    <span>{info === null ? '…' : formatBytes(info.localStorageBytes)}</span>
  </div>
  <div class="vv-about-row">
    <span class="vv-about-key">{t('settings.about.kvKey')}</span>
    <span>{info === null ? '…' : t('settings.about.recordsBytes', { records: info.kv.records, bytes: formatBytes(info.kv.bytes) })}</span>
  </div>
  <div class="vv-about-row">
    <span class="vv-about-key">{t('settings.about.themesKey')}</span>
    <span>{info === null ? '…' : t('settings.about.recordsBytes', { records: info.themes.records, bytes: formatBytes(info.themes.bytes) })}</span>
  </div>
  <div class="vv-about-row">
    <span class="vv-about-key">{t('settings.about.iconThemesKey')}</span>
    <span>{info === null ? '…' : t('settings.about.recordsBytes', { records: info.iconThemes.records, bytes: formatBytes(info.iconThemes.bytes) })}</span>
  </div>
  <div class="vv-about-row">
    <span class="vv-about-key">{t('settings.about.fontsKey')}</span>
    <span>{info === null ? '…' : t('settings.about.recordsBytes', { records: info.fonts.records, bytes: formatBytes(info.fonts.bytes) })}</span>
  </div>
  <div class="vv-about-row vv-about-detail">
    <span class="vv-about-key">{t('settings.about.mountsKey')}</span>
    <span>{t('settings.about.mountsDisabled')}</span>
  </div>
  <div class="vv-settings-import">
    <button type="button" disabled={loading} onclick={() => void refresh()}>{t('settings.about.refresh')}</button>
  </div>

  <div class="vv-settings-label">{t('settings.about.persistLabel')}</div>
  {#if persisted !== null}
    <div class="vv-about-row" role="status">
      <span class="vv-about-key">{t('settings.about.statusKey')}</span>
      <span>{persisted ? t('settings.about.persisted') : t('settings.about.notPersisted')}</span>
    </div>
  {:else}
    <div class="vv-settings-hint">{t('settings.about.noPersistHint')}</div>
  {/if}
  <div class="vv-settings-hint">
    {t('settings.about.persistHint')}
  </div>
  <div class="vv-settings-import">
    <button type="button" disabled={requesting} onclick={() => void onRequestPersist()}>
      {t('settings.about.requestPersist')}
    </button>
  </div>
  {#if persistNote}
    <div class="vv-settings-note" role="status">{persistNote}</div>
  {/if}
</section>

<style>
  .vv-about-row {
    display: flex;
    align-items: baseline;
    gap: var(--vv-sp-10);
    font-size: var(--vv-fs-xs);
  }
  .vv-about-key {
    flex: none;
    width: 11em;
    color: var(--ui-fg-muted);
  }
  .vv-about-row a {
    color: var(--ui-accent);
    overflow-wrap: anywhere;
  }
  .vv-about-detail {
    padding-left: var(--vv-sp-10);
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
