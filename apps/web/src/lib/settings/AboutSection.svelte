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
  import type { Settings } from '../stores/settings';

  // 契约占位（注册表统一 { draft, touch } 形态；本节为只读视图，不编辑草稿）
  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  const navTo = useSettingsNav();

  const REPO_URL = 'https://github.com/bhxch/vviewer';
  const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
  const NOTICES_URL = `${REPO_URL}/blob/main/THIRD_PARTY_NOTICES.md`;

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
        ? '已授予持久化存储：字体/主题/会话快照/离线缓存不再被磁盘压力驱逐'
        : '未获授予：浏览器按启发式判定（站点互动/通知/装为 PWA 可提高授予率）——安装为 PWA 通常自动持久化';
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
  <div class="vv-settings-label">项目信息</div>
  <div class="vv-about-row"><span class="vv-about-key">应用</span><span>vviewer</span></div>
  <div class="vv-about-row">
    <span class="vv-about-key">前端版本</span>
    <span>{frontendVersion ?? '开发构建'}</span>
  </div>
  <div class="vv-about-row">
    <span class="vv-about-key">服务端版本</span>
    <span>{health?.version ?? '未连接'}</span>
  </div>
  {#if versionMismatch}
    <div class="vv-settings-warn" role="status">前端（{frontendVersion}）与服务端（{health?.version}）版本不一致</div>
  {/if}
  {#if health !== null}
    <div class="vv-about-row">
      <span class="vv-about-key">能力</span>
      <span>{health.capabilities.join('、') || '—'}</span>
    </div>
    <div class="vv-about-row">
      <span class="vv-about-key">搜索引擎</span>
      <span>{health.searchEngine ?? '未宣告'}</span>
    </div>
    <div class="vv-about-row">
      <span class="vv-about-key">数据根</span>
      <span>{health.roots ?? 1} 个</span>
    </div>
  {/if}
  <div class="vv-about-row">
    <span class="vv-about-key">仓库</span>
    <a href={REPO_URL} target="_blank" rel="noreferrer">github.com/bhxch/vviewer</a>
  </div>
  <div class="vv-about-row">
    <span class="vv-about-key">许可</span>
    <a href={LICENSE_URL} target="_blank" rel="noreferrer">Apache-2.0</a>
  </div>
  <div class="vv-about-row">
    <span class="vv-about-key">第三方致谢</span>
    <a href={NOTICES_URL} target="_blank" rel="noreferrer">THIRD_PARTY_NOTICES.md</a>
  </div>

  <div class="vv-settings-label">存储用量与配额</div>
  <div class="vv-settings-hint">
    配额为浏览器估算值（Chrome 粒度较粗、Firefox 按磁盘约 10% 报告）；清理空间在
    <button type="button" class="vv-sc-linklike" onclick={() => navTo('storage')}>存储与数据 →</button>
  </div>
  {#if info !== null && info.estimate !== null}
    <div class="vv-about-row">
      <span class="vv-about-key">已用 / 配额</span>
      <span>{formatBytes(info.estimate.usage)} / {formatBytes(info.estimate.quota)}</span>
    </div>
    {#each detailEntries as [k, v] (k)}
      <div class="vv-about-row vv-about-detail">
        <span class="vv-about-key">{k}</span>
        <span>{formatBytes(v)}</span>
      </div>
    {/each}
  {:else}
    <div class="vv-settings-hint">当前浏览器不支持配额估算（仅显示本地估算行）。</div>
  {/if}
  <div class="vv-about-row">
    <span class="vv-about-key">localStorage 估算</span>
    <span>{info === null ? '…' : formatBytes(info.localStorageBytes)}</span>
  </div>
  <div class="vv-about-row">
    <span class="vv-about-key">IndexedDB · kv（会话/句柄）</span>
    <span>{info === null ? '…' : `${info.kv.records} 条 · ${formatBytes(info.kv.bytes)}`}</span>
  </div>
  <div class="vv-about-row">
    <span class="vv-about-key">IndexedDB · themes（导入主题）</span>
    <span>{info === null ? '…' : `${info.themes.records} 条 · ${formatBytes(info.themes.bytes)}`}</span>
  </div>
  <div class="vv-about-row">
    <span class="vv-about-key">IndexedDB · fonts（网络字体）</span>
    <span>{info === null ? '…' : `${info.fonts.records} 条 · ${formatBytes(info.fonts.bytes)}`}</span>
  </div>
  <div class="vv-about-row vv-about-detail">
    <span class="vv-about-key">IndexedDB · mounts（挂载配置）</span>
    <span>未启用</span>
  </div>
  <div class="vv-settings-import">
    <button type="button" disabled={loading} onclick={() => void refresh()}>刷新</button>
  </div>

  <div class="vv-settings-label">持久化存储</div>
  {#if persisted !== null}
    <div class="vv-about-row" role="status">
      <span class="vv-about-key">状态</span>
      <span>{persisted ? '已持久化' : '未持久化（best-effort，磁盘紧张时可能被清除）'}</span>
    </div>
  {:else}
    <div class="vv-settings-hint">当前浏览器不支持持久化存储查询。</div>
  {/if}
  <div class="vv-settings-import">
    <button type="button" disabled={requesting} onclick={() => void onRequestPersist()}>
      申请持久化存储
    </button>
  </div>
  <div class="vv-settings-hint">
    持久化为 origin 级：一次申请保护全源（字体/主题/会话快照/离线缓存）；字体新增成功时也会静默尝试一次。
  </div>
  {#if persistNote}
    <div class="vv-settings-note" role="status">{persistNote}</div>
  {/if}
</section>

<style>
  .vv-about-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 12px;
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
    padding-left: 10px;
  }
  .vv-sc-linklike {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    font-size: 12px;
    color: var(--ui-accent);
    cursor: pointer;
    text-decoration: underline;
  }
</style>
