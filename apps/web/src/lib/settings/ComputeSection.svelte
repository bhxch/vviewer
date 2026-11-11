<script lang="ts">
  // ComputeSection.svelte — 设置中心「计算」节（settings center spec §2）。
  // 自 TopBar 计算策略下拉迁入（2026-10-19 设置中心 Task 1，低频项收进设置页）：
  // 同 schema 字段同绑定语义（draft.computePolicy），三态 auto/local/remote。
  // 改动写 draft 后调 touch()——落盘与生效时机由 SettingsCenter 统一决定
  // （下次高亮/渲染调用即生效：router 每次实时读 settings）。
  import { t } from '../i18n/index.svelte';
  import type { Settings } from '../stores/settings';

  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  function onPolicyChange(e: Event): void {
    const v = (e.currentTarget as HTMLSelectElement).value;
    if (v === 'auto' || v === 'local' || v === 'remote') draft.computePolicy = v;
    touch();
  }
</script>

<section class="vv-sc-section">
  <label class="vv-settings-theme-row">
    <span>{t('settings.compute.row')}</span>
    <select value={draft.computePolicy} onchange={onPolicyChange} aria-label={t('settings.compute.selectAria')} title={t('settings.compute.selectTitle')}>
      <option value="auto">{t('settings.compute.auto')}</option>
      <option value="local">{t('settings.compute.local')}</option>
      <option value="remote">{t('settings.compute.remote')}</option>
    </select>
  </label>
  <div class="vv-settings-hint">
    {t('settings.compute.hint')}
  </div>
</section>
