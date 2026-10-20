<script lang="ts">
  // SearchSection.svelte — 设置中心「搜索与排除」节（settings center spec §2）。
  // 自 SettingsPanel 排除规则节原样迁移（2026-10-19 设置中心 Task 1）：条目删除/
  // 手动添加/预设一键加入。改动写 draft.excludedPatterns 后调 touch()——落盘与
  // 生效时机由 SettingsCenter 统一决定（Task 1 即时持久化 / Task 2 起草稿统一应用）。
  import type { Settings } from '../stores/settings';

  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  const patterns = $derived(draft.excludedPatterns);
  let inputEl = $state<HTMLInputElement | null>(null);
  let value = $state('');

  /** 常用排除预设：一键加入（重复添加幂等） */
  const PRESETS: readonly string[] = ['.git', 'node_modules'];

  function addPattern(raw: string): void {
    const v = raw.trim();
    if (v === '' || patterns.includes(v)) return;
    draft.excludedPatterns = [...patterns, v];
    touch();
  }

  function removePattern(p: string): void {
    draft.excludedPatterns = patterns.filter((x) => x !== p);
    touch();
  }

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    addPattern(value);
    value = '';
  }
</script>

<section class="vv-sc-section">
  <div class="vv-settings-label">排除规则</div>
  <div class="vv-settings-hint">命中名称的文件/目录不显示在文件树与快速打开中（如 .git、node_modules；*.log 排除所有 .log 文件）</div>
  {#if patterns.length > 0}
    <ul class="vv-settings-patterns">
      {#each patterns as p (p)}
        <li class="vv-settings-pattern">
          <code>{p}</code>
          <button
            type="button"
            class="vv-settings-remove"
            aria-label="删除排除规则 {p}"
            title="删除"
            onclick={() => removePattern(p)}>✕</button
          >
        </li>
      {/each}
    </ul>
  {:else}
    <div class="vv-settings-empty">暂无排除规则</div>
  {/if}
  <form class="vv-settings-add" onsubmit={submit}>
    <input
      bind:this={inputEl}
      bind:value
      placeholder="添加名称或 *.后缀"
      aria-label="添加排除规则"
      spellcheck="false"
    />
    <button type="submit" disabled={value.trim() === ''}>添加</button>
  </form>
  <div class="vv-settings-presets">
    {#each PRESETS as p (p)}
      <button
        type="button"
        disabled={patterns.includes(p)}
        aria-label="加入预设排除规则 {p}"
        onclick={() => addPattern(p)}>+ {p}</button
      >
    {/each}
  </div>
</section>
