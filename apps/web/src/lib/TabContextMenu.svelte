<script module lang="ts">
  /** 菜单项形状（TabBar 组装传入）：disabled 项渲染为 aria-disabled 置灰、点击不动作 */
  export interface TabCtxAction {
    label: string;
    disabled?: boolean;
    onClick(): void;
  }
</script>

<script lang="ts">
  // TabContextMenu.svelte — tab 右键菜单自绘浮层（F 项 T2）。TabBar 在 oncontextmenu
  // 时组装六动作闭包（含 disabled 态）挂载本组件；关闭路径全部收敛到 onclose 回调：
  //   Esc / 外点（pointerdown 落点不在菜单内）/ 任意滚动（capture——scroll 不冒泡，
  //   tabbar 横向滚动等任何容器都要关）/ 视口 resize / 菜单项点击（动作执行后必关）。
  // disabled 用 aria-disabled 而非 disabled 属性：元素保持可命中（e2e 可点击断言无
  // 动作），置灰观感由 CSS 承担。定位 fixed + 视口内收敛：测得尺寸把右/下越界拉回
  // 视口内，首帧 bind 未完成时按项数估算兜底（避免闪出边界后再跳位）。
  import type { Tab } from './openFlow.svelte';

  let {
    x,
    y,
    tab,
    actions,
    onclose
  }: {
    x: number;
    y: number;
    tab: Tab;
    actions: TabCtxAction[];
    onclose(): void;
  } = $props();

  let menuEl = $state<HTMLElement | null>(null);

  /** 打开动作自身滚动的宽限窗（毫秒）：溢出 TabBar 上右键裁剪目标时，动作性滚动
   * （浏览器/自动化 scrollIntoView、触屏裁剪目标自动滚入）的位移虽先于 contextmenu
   * 完成，scroll 事件却在下一渲染帧异步派发——落在菜单挂载之后，原「任意滚动即关」
   * 会把刚弹出的菜单秒关（WSX 观察 2，TAX-11）。宽限窗只豁免打开动作自身的尾随
   * 滚动；其后的用户滚动照常关闭（设计意图保留）。 */
  const SELF_SCROLL_GRACE_MS = 200;
  let openedAt = 0;

  /** 视口内收敛：右/下越界向内平移（8px 边距）；尺寸未测得（首帧）按 160×项数×30 估算 */
  const pos = $derived.by(() => {
    const margin = 8;
    const w = menuEl?.offsetWidth ?? 160;
    const h = menuEl?.offsetHeight ?? actions.length * 30 + margin * 2;
    return {
      left: Math.max(margin, Math.min(x, window.innerWidth - w - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - h - margin))
    };
  });

  function run(action: TabCtxAction): void {
    if (action.disabled === true) return; // 置灰项：可命中但点击不动作
    action.onClick();
    onclose(); // 菜单关闭时机：action 执行后必关（brief Step 1）
  }

  $effect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onclose();
      }
    };
    const onDown = (e: PointerEvent): void => {
      const t = e.target;
      if (t instanceof Node && menuEl !== null && menuEl.contains(t)) return; // 菜单内交互不关
      onclose();
    };
    const onGone = (): void => {
      if (performance.now() - openedAt < SELF_SCROLL_GRACE_MS) return; // 打开动作自身滚动宽限
      onclose(); // 滚动 / resize：锚定位置失真，直接关
    };
    openedAt = performance.now();
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    // capture：scroll 不冒泡——只有捕获阶段能覆盖任意滚动容器（WorkspaceTabsPanel 同款思路）
    window.addEventListener('scroll', onGone, true);
    window.addEventListener('resize', onGone);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', onGone, true);
      window.removeEventListener('resize', onGone);
    };
  });
</script>

<div
  class="vv-tabctx"
  role="menu"
  tabindex="-1"
  aria-label="标签菜单 {tab.source.name}"
  style:left="{pos.left}px"
  style:top="{pos.top}px"
  bind:this={menuEl}
  oncontextmenu={(e) => e.preventDefault()}
>
  {#each actions as action (action.label)}
    <button
      type="button"
      class="vv-tabctx-item"
      role="menuitem"
      aria-disabled={action.disabled === true ? 'true' : undefined}
      onclick={() => run(action)}>{action.label}</button
    >
  {/each}
</div>
