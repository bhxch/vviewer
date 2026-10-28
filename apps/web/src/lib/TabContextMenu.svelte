<script module lang="ts">
  /** 菜单项形状（TabBar 组装传入）：disabled 项渲染为 aria-disabled 置灰、点击不动作。
   * 子菜单父项（布局自由化 Task 3「打开方式」及其中「更多渲染器」二级）以 children
   * 判别（TabCtxSubmenu）：点击展开/收起子菜单而非执行动作；children 递归为
   * TabCtxEntry（二级嵌套同形，更深同理），叶子项恒为 TabCtxAction（必带 onClick），
   * 形态与顶层项一致。 */
  export interface TabCtxAction {
    label: string;
    disabled?: boolean;
    onClick(): void;
  }

  export interface TabCtxSubmenu {
    label: string;
    children: TabCtxEntry[];
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
   // 翻折左侧。二级嵌套（渲染器选择壳 B「更多渲染器」）以路径式展开态 + 递归
   // snippet 渲染，深层子浮层 absolute 于上一层子浮层（同法测位）。Esc 逐层收
   // 子菜单，收尽再关主菜单。
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

  /** 子菜单态：展开路径（openPath[k] = 第 k 层展开父项在其层内的序，空数组 =
   * 全收起）+ 各层锚按钮与子浮层元素（offset/尺寸测量，数组下标即层深）。路径式
   * 而非单序号：二级嵌套（「打开方式 ▸ 更多渲染器」）下两层各有展开项，同层
   * 同刻至多一路展开。组件随菜单开合整棵卸载（TabBar {#if} 挂载），无跨开合残留态。 */
  let openPath = $state<number[]>([]);
  let subAnchors = $state<(HTMLElement | null)[]>([]);
  let subEls = $state<(HTMLElement | null)[]>([]);

  /** 展开路径第 depth 层父项的 children：自顶层 actions 沿 openPath 逐层下钻
   * （路径未达 / 中途项非父项 → 空数组，仅作首帧估算兜底读数）。 */
  function childrenAt(depth: number): TabCtxEntry[] {
    const head = openPath[0];
    if (head === undefined) return [];
    let cur: TabCtxEntry | undefined = actions[head];
    for (let k = 1; k <= depth; k++) {
      if (cur === undefined || !('children' in cur)) return [];
      const idx = openPath[k];
      if (idx === undefined) return [];
      cur = cur.children[idx];
    }
    return cur !== undefined && 'children' in cur ? cur.children : [];
  }

  /** 子浮层视口内收敛（各层独立推导）：top 贴父项（下越界拉回）；默认父项右侧
   * 弹出（宿层右缘略叠 6px），右侧放不下翻折左侧。宽高未测得（首帧）按 170×项数
   * 估算兜底。宿层取锚按钮 offsetParent——首层为 fixed 主浮层、深层为上一层
   * 子浮层（absolute 即包含块），坐标系与内联 top/left 的解析基准一致。 */
  const subPositions = $derived.by(
    (): ({ top: number; left: number } | null)[] =>
      openPath.map((_, depth) => {
        const anchor = subAnchors[depth];
        if (anchor === null || anchor === undefined) return null;
        const margin = 8;
        const childCount = childrenAt(depth).length;
        const w = subEls[depth]?.offsetWidth ?? 170;
        const h = subEls[depth]?.offsetHeight ?? childCount * 30 + margin * 2;
        const top = Math.max(margin, Math.min(anchor.offsetTop, window.innerHeight - h - margin));
        const host = anchor.offsetParent as HTMLElement | null;
        const rightOf = anchor.offsetLeft + (host?.offsetWidth ?? 160) - 6;
        const left =
          rightOf + w <= window.innerWidth - margin
            ? rightOf
            : Math.max(margin, anchor.offsetLeft - w + 6);
        return { top, left };
      })
  );

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

  /** 父项点击：展开该层子菜单或收起（再点同层另一父项直接切换；展开/切换按
   * depth 截断路径，更深层随之收起——同一父项下只保一路展开）。 */
  function toggleSub(depth: number, i: number, btn: HTMLElement): void {
    if (openPath[depth] === i) {
      openPath = openPath.slice(0, depth);
      return;
    }
    openPath = [...openPath.slice(0, depth), i];
    subAnchors[depth] = btn;
  }

  $effect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (openPath.length > 0) {
          openPath = openPath.slice(0, -1); // 先收最内层子菜单再关主菜单（一层一次 Esc）
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
  <!-- 项渲染抽成递归 snippet（Task 3 壳 B 二级嵌套）：父项（有 children）点击
       展开子浮层，子浮层内递归渲染同形项；叶子项点击 run（执行动作 + 必关）。
       expanded/sp 以 @const 收敛一次下标读取（noUncheckedIndexedAccess 面）。 -->
  {#snippet entryList(entries: TabCtxEntry[], depth: number)}
    {#each entries as entry, i (entry.label)}
      {@const expanded = openPath[depth] === i}
      {@const sp = subPositions[depth]}
      {#if 'children' in entry}
        <button
          type="button"
          class="vv-tabctx-item"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={expanded}
          onclick={(e) => toggleSub(depth, i, e.currentTarget as HTMLElement)}>{entry.label} ›</button
        >
        {#if expanded && sp}
          <div
            class="vv-tabctx-sub"
            role="menu"
            aria-label={entry.label}
            style:top="{sp.top}px"
            style:left="{sp.left}px"
            bind:this={subEls[depth]}
          >
            {@render entryList(entry.children, depth + 1)}
          </div>
        {/if}
      {:else}
        <button
          type="button"
          class="vv-tabctx-item"
          role="menuitem"
          aria-disabled={entry.disabled === true ? 'true' : undefined}
          onclick={() => run(entry)}>{entry.label}</button
        >
      {/if}
    {/each}
  {/snippet}
  {@render entryList(actions, 0)}
</div>
