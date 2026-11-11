<script lang="ts">
  // RenderersSection.svelte — 设置中心「打开方式」节：同一扩展名有多个可用渲染器时，
  // 选择默认用哪个打开（settings.rendererDefaults）。行集由注册表候选声明
  // （altExtensions）派生（rendererDefaults.ts 纯函数）；改动写 draft 后调 touch()，
  // 「应用」后对之后打开（含重新打开）的文件生效。单个标签页仍可经状态栏/标签右键
  // 「打开方式」临时改选——标签级覆盖优先于本设置。改回内置默认写 ''（不删键：
  // mergeDraftOnto 删键不传播）。
  import { registry } from '../viewer';
  import { multiRendererFormats, selectedDefault } from '../rendererDefaults';
  import { t } from '../i18n/index.svelte';
  import type { Settings } from '../stores/settings';

  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  const formats = multiRendererFormats(registry);

  function onChange(ext: string, e: Event): void {
    draft.rendererDefaults = { ...draft.rendererDefaults, [ext]: (e.currentTarget as HTMLSelectElement).value };
    touch();
  }
</script>

<section class="vv-sc-section">
  <div class="vv-settings-label">{t('settings.renderers.label')}</div>
  {#each formats as f (f.ext)}
    <label class="vv-settings-theme-row">
      <span>.{f.ext}</span>
      <select
        value={selectedDefault(draft.rendererDefaults, f)}
        onchange={(e) => onChange(f.ext, e)}
        aria-label={t('settings.renderers.selectAria', { ext: f.ext })}
      >
        <option value="">{t('settings.renderers.builtinOption', { label: f.owner.label })}</option>
        {#each f.alternatives as a (a.id)}<option value={a.id}>{a.label}</option>{/each}
      </select>
    </label>
  {:else}
    <div class="vv-settings-hint">{t('settings.renderers.emptyHint')}</div>
  {/each}
  <div class="vv-settings-hint">
    {t('settings.renderers.hint')}
  </div>
</section>
