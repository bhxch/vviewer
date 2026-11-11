<script lang="ts">
  // CodeSection.svelte — 设置中心「代码视图」节：代码/纯文本视图的自动换行。改动写
  // draft.codeWordWrap 后调 touch()——「应用」后经设置订阅在已打开的代码视图上即时
  // 切换（ViewerPane 订阅 → 实例 setWordWrap）；状态栏「换行」开关与 Alt+Z 为同字段
  // 的即时通道。
  import { t } from '../i18n/index.svelte';
  import type { Settings } from '../stores/settings';

  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  function toggle(): void {
    draft.codeWordWrap = !draft.codeWordWrap;
    touch();
  }
</script>

<section class="vv-sc-section">
  <label class="vv-settings-toggle">
    <input type="checkbox" checked={draft.codeWordWrap} onchange={toggle} aria-label={t('settings.code.wordWrap')} />
    <span>{t('settings.code.wordWrap')}</span>
  </label>
  <div class="vv-settings-hint">
    {t('settings.code.hint')}
  </div>
</section>
