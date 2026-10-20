<script lang="ts">
  // AutoRefreshSection.svelte — 设置中心「自动刷新」节（settings center spec §2）。
  // 自 SettingsPanel 自动刷新节原样迁移（2026-10-19 设置中心 Task 1）：关闭后目录
  // 树 SSE 自动同步停用，手动刷新 ↻ 不受影响。改动写 draft.autoRefresh 后调
  // touch()——落盘与生效时机由 SettingsCenter 统一决定。
  import type { Settings } from '../stores/settings';

  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  function toggle(): void {
    draft.autoRefresh = !draft.autoRefresh;
    touch();
  }
</script>

<section class="vv-sc-section">
  <label class="vv-settings-toggle">
    <input type="checkbox" checked={draft.autoRefresh} onchange={toggle} />
    <span>自动刷新</span>
  </label>
  <div class="vv-settings-hint">
    连接服务器时内容变更自动重读；关闭后目录树同步停用，可用顶栏 ↻ 手动刷新当前文件与目录树
  </div>
</section>
