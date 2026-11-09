<script lang="ts">
  // CodeSection.svelte — 设置中心「代码视图」节：代码/纯文本视图的自动换行。改动写
  // draft.codeWordWrap 后调 touch()——「应用」后经设置订阅在已打开的代码视图上即时
  // 切换（ViewerPane 订阅 → 实例 setWordWrap）；状态栏「换行」开关与 Alt+Z 为同字段
  // 的即时通道。
  import type { Settings } from '../stores/settings';

  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  function toggle(): void {
    draft.codeWordWrap = !draft.codeWordWrap;
    touch();
  }
</script>

<section class="vv-sc-section">
  <label class="vv-settings-toggle">
    <input type="checkbox" checked={draft.codeWordWrap} onchange={toggle} aria-label="自动换行" />
    <span>自动换行</span>
  </label>
  <div class="vv-settings-hint">
    长行在视图宽度内折行显示，不再横向滚动。也可用代码视图状态栏的「换行」开关或 Alt+Z 随时切换。
  </div>
</section>
