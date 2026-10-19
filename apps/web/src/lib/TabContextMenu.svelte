<script module lang="ts">
  /** 菜单项形状（TabBar 组装传入）：disabled 项渲染为 aria-disabled 置灰、点击不动作。
   * 子菜单父项（布局自由化 Task 3「打开方式」）以 children 判别（TabCtxSubmenu）：
   * 点击展开/收起子菜单而非执行动作；子项恒为 TabCtxAction（必带 onClick），
   * 形态与顶层项一致。 */
  export interface TabCtxAction {
    label: string;
    disabled?: boolean;
    onClick(): void;
  }

  export interface TabCtxSubmenu {
    label: string;
    children: TabCtxAction[];
  }

  export type TabCtxEntry = TabCtxAction | TabCtxSubmenu;
</script>

<script lang="ts">
  // TabContextMenu.svelte — tab 右键菜单自绘浮层（F 项 T2）。TabBar 在 oncontextmenu
  // 时组装六动作闭包（含 disabled 态）挂载本组件；关闭路径全部收敛到 onclose 回调：
  //   Esc / 外点（pointerdown 落点不在菜单内）/ 任意滚动（capture——scroll 不冒泡，
  //   tabbar 横向滚动等任何容器都要关）/ 视口 resize / 菜单项点击（动作执行后必关）。
  // disabled 用 aria-disabled 而非 disabled 属性：元素保持可命中（e2e 可点击断言无
  // 动作），置灰观感由 CSS 承担。定位 fixed + 视口内收敛：测得尺寸把右/下越界拉回
  // 视口内，首帧 bind 未完成时按项数估算兜底（避免闪出边界后再跳位）。
  // 子菜单（Task 3）：absolute 于本浮层（fixed 元素即 absolute 后代的包含块），
  // 坐标按父项 offset 测出（首帧未测得以估算兜底，同主浮层两段式）；右侧放不下
  // 翻折左侧。Esc 先收子菜单再关主菜单。
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
    actions: TabCtxEntry[];
    onclose(): void;
  } = $props();

  let menuEl = $state<HTMLElement | null>(null);

  /** 子菜单态：展开的父项序 + 其按钮（offset 基准）+ 子浮层元素（尺寸测量）。
   * 组件随菜单开合整棵卸载（TabBar {#if} 挂载），无跨开合残留态。 */
  let openSub = $state<number | null>(null);
  let subAnchor = $state<HTMLElement | null>(null);
  let subEl = $state<HTMLElement | null>(null);

  /** 子浮层视口内收敛：top 贴父项（下越界拉回）；默认父项右侧弹出（主浮层右缘
   * 略叠 6px），右侧放不下翻左侧。宽高未测得（首帧）按 170×项数估算兜底。 */
  const subPos = $derived.by(() => {
    if (openSub === null || subAnchor === null) return null;
    const margin = 8;
    const cur = actions[openSub];
    const childCount = cur !== undefined && 'children' in cur ? cur.children.length : 0;
    const w = subEl?.offsetWidth ?? 170;
    const h = subEl?.offsetHeight ?? childCount * 30 + margin * 2;
    const top = Math.max(margin, Math.min(subAnchor.offsetTop, window.innerHeight - h - margin));
    const rightOf = subAnchor.offsetLeft + (menuEl?.offsetWidth ?? 160) - 6;
    const left =
      rightOf + w <= window.innerWidth - margin
        ? rightOf
        : Math.max(margin, subAnchor.offsetLeft - w + 6);
    return { top, left };
  });

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

  /** 父项点击：展开/收起子菜单（再点另一父项直接切换）。 */
  function toggleSub(i: number, btn: HTMLElement): void {
    if (openSub === i) {
      openSub = null;
      subAnchor = null;
      return;
    }
    openSub = i;
    subAnchor = btn;
  }

  function closeSub(): void {
    openSub = null;
    subAnchor = null;
  }

  $effect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (openSub !== null) {
          closeSub(); // 先收子菜单再关主菜单（两层各一次 Esc）
          return;
        }
        onclose();
      }
    };
    const onDown = (e: PointerEvent): void => {
      const t = e.target;
      if (t instanceof Node && menuEl !== null && menuEl.contains(t)) return; // 菜单内交互不关（含子浮层）
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
  {#each actions as action, i (action.label)}
    {#if 'children' in action}
      <button
        type="button"
        class="vv-tabctx-item"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={openSub === i}
        onclick={(e) => toggleSub(i, e.currentTarget as HTMLElement)}>{action.label} ›</button
      >
      {#if openSub === i && subPos !== null}
        <div
          class="vv-tabctx-sub"
          role="menu"
          aria-label={action.label}
          style:top="{subPos.top}px"
          style:left="{subPos.left}px"
          bind:this={subEl}
        >
          {#each action.children as child (child.label)}
            <button
              type="button"
              class="vv-tabctx-item"
              role="menuitem"
              aria-disabled={child.disabled === true ? 'true' : undefined}
              onclick={() => run(child)}>{child.label}</button
            >
          {/each}
        </div>
      {/if}
    {:else}
      <button
        type="button"
        class="vv-tabctx-item"
        role="menuitem"
        aria-disabled={action.disabled === true ? 'true' : undefined}
        onclick={() => run(action)}>{action.label}</button
      >
    {/if}
  {/each}
</div>
