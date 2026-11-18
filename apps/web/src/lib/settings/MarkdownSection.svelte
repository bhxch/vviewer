<script lang="ts">
  // MarkdownSection.svelte — 设置中心「Markdown」节（spec D §3.1）：外链图片三档
  // （blocked=剥除占位 / manual=占位逐张确认（默认档） / auto=直接放行）+ 域名白名单
  // chip 列表编辑（镜像 SearchSection 排除规则先例）。改动写 draft.markdown 后调
  // touch()——落盘与生效时机由 SettingsCenter 统一决定；sanitize 档位消费面每渲染
  // 现读 loadSettings（viewer.ts provider，Task 5 装配），应用后下一渲染生效。
  import { normalizeMarkdownAllowlist, type Settings } from '../stores/settings';
  import { t } from '../i18n/index.svelte';

  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  const entries = $derived(draft.markdown.externalImagesAllowlist);
  let value = $state('');

  /** 外链图片档位切换（spec D §3.1 三档）：白名单优先于档位的判定在 sanitize 包侧。 */
  function onExternalImagesChange(e: Event): void {
    draft.markdown.externalImages = (e.currentTarget as HTMLSelectElement).value as Settings['markdown']['externalImages'];
    touch();
  }

  /** 非法条目提示（评审 minor：非法条目此前被静默丢弃、用户零反馈）——复用既有目录键
   * settings.issue.allowlistEntry（目录里已有该键，此前未被本节消费）。 */
  let issue = $state('');

  /** 白名单添加：normalizeMarkdownAllowlist 同口径预归一（trim+lowercase+拒非法），
   * 归一后空串（非法条目）与重复条目不加——**非法条目给出可见提示**（不静默丢弃）。 */
  function addEntry(raw: string): void {
    const [v] = normalizeMarkdownAllowlist([raw]);
    if (v === undefined) {
      issue = t('settings.issue.allowlistEntry');
      return;
    }
    issue = '';
    if (entries.includes(v)) return;
    draft.markdown.externalImagesAllowlist = [...entries, v];
    touch();
  }

  function removeEntry(entry: string): void {
    draft.markdown.externalImagesAllowlist = entries.filter((x) => x !== entry);
    touch();
  }

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    addEntry(value);
    // 非法条目：保留输入（便于改写）；合法条目（含重复）：清空
    if (issue === '') value = '';
  }
</script>

<section class="vv-sc-section">
  <label class="vv-settings-theme-row">
    <span>{t('settings.markdown.extImagesRow')}</span>
    <select value={draft.markdown.externalImages} onchange={onExternalImagesChange} aria-label={t('settings.markdown.extImagesAria')}>
      <option value="blocked">{t('settings.markdown.extImagesBlocked')}</option>
      <option value="manual">{t('settings.markdown.extImagesManual')}</option>
      <option value="auto">{t('settings.markdown.extImagesAuto')}</option>
    </select>
  </label>
  <div class="vv-settings-hint">{t('settings.markdown.extImagesHint')}</div>
  <!-- 白名单 chip 列表：逐条 chip 移除钮 + 添加表单（镜像 SearchSection 形态） -->
  <div class="vv-settings-label">{t('settings.markdown.allowlistRow')}</div>
  {#if entries.length > 0}
    <ul class="vv-settings-patterns">
      {#each entries as entry (entry)}
        <li class="vv-settings-pattern">
          <code>{entry}</code>
          <button
            type="button"
            class="vv-settings-remove"
            aria-label={t('settings.markdown.allowlistRemove', { domain: entry })}
            onclick={() => removeEntry(entry)}>✕</button
          >
        </li>
      {/each}
    </ul>
  {/if}
  <form class="vv-settings-add" onsubmit={submit}>
    <input
      bind:value
      placeholder="example.com"
      aria-label={t('settings.markdown.allowlistAria')}
      spellcheck="false"
    />
    <button type="submit" disabled={value.trim() === ''}>{t('settings.markdown.allowlistAdd')}</button>
  </form>
  {#if issue}<div class="vv-settings-note" role="status">{issue}</div>{/if}
  <div class="vv-settings-hint">{t('settings.markdown.allowlistHint')}</div>
</section>
