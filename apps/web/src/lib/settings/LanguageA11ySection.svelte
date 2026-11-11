<script lang="ts">
  // LanguageA11ySection.svelte — 设置中心「语言与辅助功能」节（i18n 基建 D3/D11，
  // Task 3）：界面语言（locale，默认 zh-CN 不设 auto）+ 减少动效（reduceMotion，
  // system/on/off 三态）两下拉。i18n 目录首批消费者——本节全部文案（含 aria-label）
  // 即用 t()（响应式，语言切换就地重渲）；生效时机由「应用」统一走 commit →
  // saveSettings 集中订阅链 → AppShell onSettingsChanged 接线（setLocale 写
  // html[lang] / data-reduce-motion 打标），本节只写 draft + touch()（与各节
  // 草稿语义同构：控件形态镜像 AppearanceSection 的 select 行、aria-label 与
  // 可见行内文本同值——Task 2 aria 基线口径，axe label-content-name 零面）。
  import { t } from '../i18n/index.svelte';
  import { type Settings } from '../stores/settings';

  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  /** 界面语言（D3）：写 draft + touch——生效由订阅链接线（设置中心统一落盘时机） */
  function onLocaleChange(e: Event): void {
    draft.locale = (e.currentTarget as HTMLSelectElement).value as Settings['locale'];
    touch();
  }

  /** 减少动效（D11）：写 draft + touch，同上 */
  function onReduceMotionChange(e: Event): void {
    draft.reduceMotion = (e.currentTarget as HTMLSelectElement).value as Settings['reduceMotion'];
    touch();
  }
</script>

<section class="vv-sc-section">
  <div class="vv-settings-label">{t('settings.language.label')}</div>
  <label class="vv-settings-theme-row">
    <span>{t('settings.language.label')}</span>
    <select value={draft.locale} onchange={onLocaleChange} aria-label={t('settings.language.label')}>
      <option value="zh-CN">{t('settings.language.zhCN')}</option>
      <option value="en">{t('settings.language.en')}</option>
    </select>
  </label>
  <div class="vv-settings-hint">{t('settings.language.hint')}</div>
  <div class="vv-settings-label">{t('a11y.reduceMotion.label')}</div>
  <label class="vv-settings-theme-row">
    <span>{t('a11y.reduceMotion.label')}</span>
    <select
      value={draft.reduceMotion}
      onchange={onReduceMotionChange}
      aria-label={t('a11y.reduceMotion.label')}
    >
      <option value="system">{t('a11y.reduceMotion.system')}</option>
      <option value="on">{t('a11y.reduceMotion.on')}</option>
      <option value="off">{t('a11y.reduceMotion.off')}</option>
    </select>
  </label>
  <div class="vv-settings-hint">{t('a11y.reduceMotion.hint')}</div>
</section>
