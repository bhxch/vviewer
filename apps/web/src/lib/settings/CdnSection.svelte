<script lang="ts">
  // CdnSection.svelte — 设置中心「网络资源」节（spec C §3.2，Task 3）：三作用面 CDN
  // 档位（grammars 四档 / engines·foreign 两档）+ custom 输入（实时校验错误态，复用
  // 节内 role="status" 行通道——FontsSection.svelte:373/422 先例；表 1 新增点同步登记
  // semantic-components.md）+ 提示行三处（foreign 装配级快照刷新语义 / custom 域 SW
  // 在线直取 / cn 白名单申请中警示行）。版本解析为信息面（resolveCdnPackVersions +
  // 重解析钮，缓存独立 localStorage 键——不扩 settings.cdn 6 字段集，运行时 URL 恒
  // 重定向形态）。组件形态沿三层纪律（draft + touch 回调上行，无副作用——节先例）。
  // 本节无新浮层（.vv-settings-center 面板内，不触发 OVERLAY 入册）。
  import { t } from '../i18n/index.svelte';
  import { enginesHostOk, grammarsMultiBaseOk, grammarPackCount, resolveCdnPackVersions } from '../cdnProfiles';
  import type { EngineCdnProfile, GrammarCdnProfile, Settings } from '../stores/settings';

  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  // ---------- custom 输入实时校验（错误态 role="status" 行；空串=未启用不报错） ----------
  const grammarsInvalid = $derived(
    draft.cdn.grammars === 'custom' && draft.cdn.grammarsCustom !== '' && !grammarsMultiBaseOk(draft.cdn.grammarsCustom)
  );
  const enginesInvalid = $derived(
    draft.cdn.engines === 'custom' && draft.cdn.enginesCustom !== '' && !enginesHostOk(draft.cdn.enginesCustom)
  );
  const foreignInvalid = $derived(
    draft.cdn.foreign === 'custom' && draft.cdn.foreignCustom !== '' && !enginesHostOk(draft.cdn.foreignCustom)
  );

  function onGrammarsProfileChange(e: Event): void {
    draft.cdn.grammars = (e.currentTarget as HTMLSelectElement).value as GrammarCdnProfile;
    touch();
  }
  function onEnginesProfileChange(e: Event): void {
    draft.cdn.engines = (e.currentTarget as HTMLSelectElement).value as EngineCdnProfile;
    touch();
  }
  function onForeignProfileChange(e: Event): void {
    draft.cdn.foreign = (e.currentTarget as HTMLSelectElement).value as EngineCdnProfile;
    touch();
  }
  function onGrammarsCustomInput(e: Event): void {
    draft.cdn.grammarsCustom = (e.currentTarget as HTMLInputElement).value.trim();
    touch();
  }
  function onEnginesCustomInput(e: Event): void {
    draft.cdn.enginesCustom = (e.currentTarget as HTMLInputElement).value.trim();
    touch();
  }
  function onForeignCustomInput(e: Event): void {
    draft.cdn.foreignCustom = (e.currentTarget as HTMLInputElement).value.trim();
    touch();
  }

  // ---------- 版本解析信息面（unpkg/cn 档显示解析值 + 重解析；运行时 URL 恒重定向形态） ----------
  type VersionProfile = 'unpkg' | 'cn';
  let versionState = $state<{ profile: VersionProfile; value: string[] | null } | null>(null);
  let resolving = $state(false);

  async function resolveVersions(profile: VersionProfile): Promise<void> {
    resolving = true;
    try {
      versionState = { profile, value: await resolveCdnPackVersions(profile, grammarPackCount()) };
    } finally {
      resolving = false;
    }
  }

  // draft 档位变化（含未应用）即解析展示——帮助用户决策；custom 档清空展示
  $effect(() => {
    const profile = draft.cdn.grammars;
    if (profile === 'unpkg' || profile === 'cn') void resolveVersions(profile);
    else versionState = null;
  });
</script>

<!-- grammars：四档 + custom 多基输入 -->
<label class="vv-settings-theme-row">
  <span>{t('settings.cdn.grammarsLabel')}</span>
  <select value={draft.cdn.grammars} onchange={onGrammarsProfileChange} aria-label={t('settings.cdn.grammarsSelectLabel')}>
    <option value="default">{t('settings.cdn.profileDefault')}</option>
    <option value="unpkg">{t('settings.cdn.profileUnpkg')}</option>
    <option value="cn">{t('settings.cdn.profileCn')}</option>
    <option value="custom">{t('settings.cdn.profileCustom')}</option>
  </select>
</label>
{#if draft.cdn.grammars === 'custom'}
  <label class="vv-settings-theme-row">
    <span>{t('settings.cdn.customLabel')}</span>
    <input
      type="text"
      value={draft.cdn.grammarsCustom}
      placeholder={t('settings.cdn.grammarsPlaceholder')}
      oninput={onGrammarsCustomInput}
      aria-label={t('settings.cdn.grammarsInputLabel')}
      aria-invalid={grammarsInvalid}
    />
  </label>
  {#if grammarsInvalid}
    <div class="vv-settings-note" role="status">{t('settings.cdn.grammarsError')}</div>
  {/if}
{/if}
{#if draft.cdn.grammars === 'cn'}
  <div class="vv-settings-hint">{t('settings.cdn.cnWarn')}</div>
{/if}
{#if draft.cdn.grammars === 'unpkg' || draft.cdn.grammars === 'cn'}
  <div class="vv-settings-hint">
    {t('settings.cdn.versionLabel')}：
    {#if resolving || versionState === null || versionState.profile !== draft.cdn.grammars}
      {t('settings.cdn.versionUnknown')}
    {:else if versionState.value === null}
      {t('settings.cdn.versionFailed')}
    {:else}
      {versionState.value.join(' / ')}
    {/if}
    <button type="button" onclick={() => draft.cdn.grammars === 'unpkg' || draft.cdn.grammars === 'cn' ? resolveVersions(draft.cdn.grammars) : undefined} disabled={resolving}>
      {t('settings.cdn.versionRefresh')}
    </button>
  </div>
{/if}
<div class="vv-settings-hint">{t('settings.cdn.grammarsHint')}</div>

<!-- engines：两档 + custom host 输入 -->
<label class="vv-settings-theme-row">
  <span>{t('settings.cdn.enginesLabel')}</span>
  <select value={draft.cdn.engines} onchange={onEnginesProfileChange} aria-label={t('settings.cdn.enginesSelectLabel')}>
    <option value="default">{t('settings.cdn.profileDefault')}</option>
    <option value="custom">{t('settings.cdn.profileCustom')}</option>
  </select>
</label>
{#if draft.cdn.engines === 'custom'}
  <label class="vv-settings-theme-row">
    <span>{t('settings.cdn.customLabel')}</span>
    <input
      type="text"
      value={draft.cdn.enginesCustom}
      placeholder={t('settings.cdn.hostPlaceholder')}
      oninput={onEnginesCustomInput}
      aria-label={t('settings.cdn.enginesInputLabel')}
      aria-invalid={enginesInvalid}
    />
  </label>
  {#if enginesInvalid}
    <div class="vv-settings-note" role="status">{t('settings.cdn.hostError')}</div>
  {/if}
{/if}

<!-- foreign：两档 + custom base 输入 + 刷新语义 hint（拍板：切档保存后刷新生效） -->
<label class="vv-settings-theme-row">
  <span>{t('settings.cdn.foreignLabel')}</span>
  <select value={draft.cdn.foreign} onchange={onForeignProfileChange} aria-label={t('settings.cdn.foreignSelectLabel')}>
    <option value="default">{t('settings.cdn.profileDefault')}</option>
    <option value="custom">{t('settings.cdn.profileCustom')}</option>
  </select>
</label>
{#if draft.cdn.foreign === 'custom'}
  <label class="vv-settings-theme-row">
    <span>{t('settings.cdn.customLabel')}</span>
    <input
      type="text"
      value={draft.cdn.foreignCustom}
      placeholder={t('settings.cdn.hostPlaceholder')}
      oninput={onForeignCustomInput}
      aria-label={t('settings.cdn.foreignInputLabel')}
      aria-invalid={foreignInvalid}
    />
  </label>
  {#if foreignInvalid}
    <div class="vv-settings-note" role="status">{t('settings.cdn.hostError')}</div>
  {/if}
{/if}
<div class="vv-settings-hint">{t('settings.cdn.foreignHint')}</div>
<div class="vv-settings-hint">{t('settings.cdn.swHint')}</div>
