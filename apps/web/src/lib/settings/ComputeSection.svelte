<script lang="ts">
  // ComputeSection.svelte — 设置中心「计算」节（settings center spec §2）。
  // 自 TopBar 计算策略下拉迁入（2026-10-19 设置中心 Task 1，低频项收进设置页）：
  // 同 schema 字段同绑定语义（draft.computePolicy），三态 auto/local/remote。
  // 改动写 draft 后调 touch()——落盘与生效时机由 SettingsCenter 统一决定
  // （下次高亮/渲染调用即生效：router 每次实时读 settings）。
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
    <span>计算策略</span>
    <select value={draft.computePolicy} onchange={onPolicyChange} aria-label="计算策略" title="计算策略：决定高亮等计算在本地还是服务器执行">
      <option value="auto">计算: 自动</option>
      <option value="local">计算: 本地</option>
      <option value="remote">计算: 远程</option>
    </select>
  </label>
  <div class="vv-settings-hint">
    决定高亮等计算在本地还是服务器执行：自动 = 远程文件优先远程计算（失败回退本地）；本地/远程显式指定。下次计算调用即生效。
  </div>
</section>
