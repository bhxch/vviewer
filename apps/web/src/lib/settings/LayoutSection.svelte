<script lang="ts">
  // LayoutSection.svelte — 设置中心「布局」节（布局自由化 spec 2026-10-19 §2，
  // settings center spec §2 分组定稿位：图表与搜索之间）。顶栏/标签栏显示、
  // 左右栏折叠与宽度、zen 状态重置。与其他节同契约：写 draft.layout 后 touch()，
  // 落盘统一在「应用」（应用经 saveSettings 订阅链刷新 AppShell 布局副本即时生效；
  // zen 覆盖语义不动其余字段——layout.ts enterZen/exitZen 正交性）。
  // 与 AppShell 即时通道（拖拽调宽/折叠钮/右键菜单）并存：同一 schema 字段两个
  // 写入口——本节走草稿统一应用，AppShell updateLayout 读最新持久值局部合并，
  // 互不覆盖对方字段。
  import { clampWidth, LEFT_WIDTH_RANGE, RIGHT_WIDTH_RANGE } from '../layout';
  import type { Settings } from '../stores/settings';

  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  type CheckField = 'leftCollapsed' | 'rightCollapsed' | 'topBarVisible' | 'tabBarVisible';

  /** 布尔字段：checkbox 写 draft + touch */
  function onCheck(field: CheckField, e: Event): void {
    draft.layout[field] = (e.currentTarget as HTMLInputElement).checked;
    touch();
  }

  /** 宽度：blur/回车提交时 clamp（与拖拽通道 clampWidth 同口径），输入框同步为
   * 规范化值（字号输入同款——渐进键入不被回写打断） */
  function onWidth(side: 'left' | 'right', e: Event): void {
    const inp = e.currentTarget as HTMLInputElement;
    const clamped = clampWidth(side, Number(inp.value));
    inp.value = String(clamped);
    if (side === 'left') draft.layout.leftWidth = clamped;
    else draft.layout.rightWidth = clamped;
    touch();
  }

  /** zen 重置（spec §2 布局组「zen 重置」项）：只翻 zen 字段（正交性） */
  function resetZen(): void {
    draft.layout.zen = false;
    touch();
  }
</script>

<section class="vv-sc-section">
  <div class="vv-settings-label">布局</div>
  <div class="vv-settings-hint">
    改动写入草稿，点右上「应用」后生效（订阅链刷新整个界面）；左右栏折叠与拖拽调宽在界面内即时生效，与本节同一存储字段。
  </div>
  <label class="vv-settings-theme-row">
    <span>显示顶栏</span>
    <input
      type="checkbox"
      checked={draft.layout.topBarVisible}
      onchange={(e) => onCheck('topBarVisible', e)}
      aria-label="显示顶栏"
    />
  </label>
  <label class="vv-settings-theme-row">
    <span>显示标签栏</span>
    <input
      type="checkbox"
      checked={draft.layout.tabBarVisible}
      onchange={(e) => onCheck('tabBarVisible', e)}
      aria-label="显示标签栏"
    />
  </label>
  <label class="vv-settings-theme-row">
    <span>折叠文件树（左栏）</span>
    <input
      type="checkbox"
      checked={draft.layout.leftCollapsed}
      onchange={(e) => onCheck('leftCollapsed', e)}
      aria-label="折叠文件树（左栏）"
    />
  </label>
  <label class="vv-settings-theme-row">
    <span>折叠属性面板（右栏）</span>
    <input
      type="checkbox"
      checked={draft.layout.rightCollapsed}
      onchange={(e) => onCheck('rightCollapsed', e)}
      aria-label="折叠属性面板（右栏）"
    />
  </label>
  <label class="vv-settings-theme-row">
    <span>左栏宽度（px，{LEFT_WIDTH_RANGE[0]}–{LEFT_WIDTH_RANGE[1]}）</span>
    <input
      type="number"
      min={LEFT_WIDTH_RANGE[0]}
      max={LEFT_WIDTH_RANGE[1]}
      step="1"
      value={draft.layout.leftWidth}
      onchange={(e) => onWidth('left', e)}
      aria-label="左栏宽度（px）"
    />
  </label>
  <label class="vv-settings-theme-row">
    <span>右栏宽度（px，{RIGHT_WIDTH_RANGE[0]}–{RIGHT_WIDTH_RANGE[1]}）</span>
    <input
      type="number"
      min={RIGHT_WIDTH_RANGE[0]}
      max={RIGHT_WIDTH_RANGE[1]}
      step="1"
      value={draft.layout.rightWidth}
      onchange={(e) => onWidth('right', e)}
      aria-label="右栏宽度（px）"
    />
  </label>
  <div class="vv-settings-label">专注模式（zen）</div>
  {#if draft.layout.zen}
    <div class="vv-settings-note" role="status">当前草稿为专注模式（覆盖顶栏/标签栏/双栏显示），其余布局字段保持原值。</div>
    <div class="vv-settings-import">
      <button type="button" onclick={resetZen} aria-label="重置专注模式">重置专注模式（应用后生效）</button>
    </div>
  {:else}
    <div class="vv-settings-hint">专注模式经界面右键菜单或移动端浮钮进入；本节仅提供重置。</div>
  {/if}
</section>
