<script lang="ts">
  import type { Tab } from './openFlow.svelte';
  import type { WorkspaceSource } from './workspaceStore';
  import { activateTab, closeTab, closedStackSize, reopenClosed, showStatusNotice, tabStore } from './openFlow.svelte';
  import { reorderIds } from './tabOrder';
  import { arrowVisibility, dominantWheelDelta } from './tabScroll';
  import { badgeOf } from './tabBadge';
  import { formatBytes } from './storageHealth';
  import { isRemoteDownload } from './downloadProgress';
  import { SAVE_DENIED_NOTICE, saveAsDisabledOf, saveAsTab } from './saveAs';
  import { registry } from './viewer';
  import { rendererCandidatesOfTab } from './RendererPickerMenu';
  import { requestMetaLangFocus } from './metaLangFocus';
  import TabContextMenu, { type TabCtxEntry } from './TabContextMenu.svelte';
  import TabBarMenu from './TabBarMenu.svelte';
  import FileIcon from './FileIcon.svelte';
  import type { Settings } from './stores/settings';
  // i18n（Task 4 域 A 抽取）：右键菜单/箭头/管理钮文案入 tabs.* 目录；label 仍只作
  // 显示面（TabContextMenu each key 为 位置+label 复合，无 label-keyed each 风险）
  import { t } from './i18n/index.svelte';

  /**
   * tabs：AppShell 传当前 workspace 组内过滤值（tabStore.tabsOf(activeId)，T6）——
   * TabBar 只渲染本组标签，跨组总览/触达走「管理」面板。sources：当前组已登记
   * 来源（模型）；onmanage：右端「管理」按钮回调（AppShell 切换面板）。
   * temp/hidden/onenter/onleave：chrome 隐藏与边缘唤出临时条（spec 2026-10-19
   * §2/§3），语义同 TopBar 同名 props（所有权在 AppShell）。
   * themeMode/onsettheme/onsettings/onmounts/zen/onToggleZen（顶栏退役 Task 2，
   * 标签栏收敛 Task 1 换签名）：左端融合菜单（TabBarMenu）六项透传——订阅链/
   * 设置中心/目录管理/zen 状态所有权均在 AppShell，本组件只作 DOM 宿主；
   * onsettheme 为显式三显项入参（主题轮换 oncycletheme 退役，spec §8）。
   */
  let {
    tabs,
    sources,
    onmanage,
    temp = false,
    hidden = false,
    onenter,
    onleave,
    themeMode,
    onsettheme,
    onsettings,
    onmounts,
    zen,
    onToggleZen,
    iconTabs = false
  }: {
    tabs: Tab[];
    sources: WorkspaceSource[];
    onmanage(): void;
    temp?: boolean;
    hidden?: boolean;
    onenter?: () => void;
    onleave?: () => void;
    themeMode: Settings['themeMode'];
    onsettheme(mode: Settings['themeMode']): void;
    onsettings(): void;
    onmounts(): void;
    zen: boolean;
    onToggleZen(): void;
    /** 图标主题 tabs 作用域门（图标主题 spec §3.1/§3.3，Task 4）：AppShell 传
     * settings.iconThemes.scopes.tabs 布尔（本组件无 settings 访问路径） */
    iconTabs?: boolean;
  } = $props();

  /** 行内来源徽标（T6；多根 Task 1 同名跨源消歧）：逻辑在 tabBadge.ts 可单测；
   * 此处注入当前组来源集与本组 tabs（消歧冲突名册）。 */
  function badgeOfFor(tab: Tab): string | null {
    return badgeOf(sources, tabs, tab);
  }

  /**
   * 语言轻入口标签（Task 6，spec §4.2）：被右键 tab 的 overrideLang 优先（手动
   * 标注），否则「自动」——非激活 tab 无 meta 实例对应面，fileMeta.lang（激活
   * tab 的检测语言上行）不适用于此，故无检测值回显。文案只读，动作走
   * requestMetaLangFocus 单一跳转通道（metaLangFocus.ts）：属性面板聚焦语言行
   * 由 AppShell 裁决，本组件不复制展开/聚焦逻辑。
   */
  function langLabelOf(tab: Tab): string {
    return tab.overrideLang !== undefined
      ? t('tabs.ctx.langManual', { lang: tab.overrideLang })
      : t('tabs.ctx.langAuto');
  }

  // ---------- F 项 T2：右键菜单 / 中键关闭 / 拖拽重排 / pinned 态 ----------

  /** 右键菜单态：目标 tab + 触发视口坐标（null = 关）。actions 每次开菜单重新组装。 */
  let ctx = $state<{ x: number; y: number; tab: Tab } | null>(null);

  function openMenu(e: MouseEvent, tab: Tab): void {
    e.preventDefault(); // 阻止浏览器默认菜单，自绘浮层取而代之
    ctx = { x: e.clientX, y: e.clientY, tab };
  }

  /**
   * 菜单动作组装（随菜单开合经 $derived 重算）：置灰态按 spec §2.2——
   * 「关闭右侧」按「右侧无普通 tab」判定、「复制标签页」unrestorable、「重新打开
   * 已关闭标签」撤销栈空（调用时查询：菜单每次打开重组即拿到最新栈深，无需响应式）；
   * pinned 动态换「固定 / 取消固定」标签。末项「打开方式」（Task 3 壳 B）：候选
   * 经 rendererCandidatesOfTab（与 MetaPanel 下拉/状态栏指示器同源同集；未渲染
   * 过的 tab 以名称扩展名兜底），当前项 ✓ 前缀标记，选择走 setRendererOverride
   * （'' = null 清 override，MetaPanel onOpenWith 同语义）——pinned 等既有语义不受
   * 影响。其中「更多渲染器」二级子菜单（TabCtxEntry children 递归）= 「自动」头项
   * + registry 全量（语义不变：默认受限、更多=任意），✓ 按显式 overrideRenderer
   * 回显（头项在 overrideRenderer === undefined 时打 ✓——自动路由无显式 override，
   * 与受限面/展开面的「自动」头项同形；终审 M-1 补齐缺落的头项）。第七动作「另存为」
   * （计划 2 Task 7，spec §6.4 tab 级泛化）：占位（unrestorable）/错误（lastRendererId
   * 'error'）/目录（path ''）置灰（saveAsDisabledOf 单源判定）；动作分发进 saveAs
   * 管线（saveAsTab：远端面残余 A2 picker-first——右键点击即 user gesture，picker
   * 首个 await 直接弹出后确认门+泵直写盘；在手/zipStore 读全量→saveAsBlob；无 FS
   * Access 环境降级 blob 兜底），失败上状态栏一次性提示（BUG-19 通道）。picker 关闭
   * 双语义（saveAsTab/saveAsBlob 同形）：AbortError（用户主动关对话框）静默、
   * NotAllowedError（浏览器拒绝）'denied' → 状态条固定文案提示。
   */
  // 回调显式标注返回 TabCtxEntry[]：字面量数组的联合推断会给缺省属性填
  // `undefined` 型，过不了 $derived 泛型边界（子菜单父项无 onClick 的推断面）
  const ctxActions: TabCtxEntry[] = $derived.by((): TabCtxEntry[] => {
    if (ctx === null) return [];
    const tab = ctx.tab;
    const at = tabs.findIndex((t) => t.id === tab.id);
    const normalRight = at >= 0 ? tabs.slice(at + 1).filter((t) => !t.pinned).length : 0;
    return [
      { label: t('tabs.ctx.close'), onClick: () => tabStore.close(tab.id) },
      { label: t('tabs.ctx.closeOthers'), onClick: () => tabStore.closeOthers(tab.id) },
      { label: t('tabs.ctx.closeRight'), disabled: normalRight === 0, onClick: () => tabStore.closeRight(tab.id) },
      tab.pinned === true
        ? { label: t('tabs.ctx.unpin'), onClick: () => tabStore.unpin(tab.id) }
        : { label: t('tabs.ctx.pin'), onClick: () => tabStore.pin(tab.id) },
      {
        label: t('tabs.ctx.duplicate'),
        disabled: tab.unrestorable === true,
        onClick: () => tabStore.duplicate(tab.id)
      },
      {
        label: t('tabs.ctx.reopen'),
        disabled: closedStackSize() === 0,
        onClick: () => reopenClosed()
      },
      {
        label: t('tabs.ctx.openWith'),
        children: [
          ...rendererCandidatesOfTab(registry, tab).map((c) => ({
            label: c.current ? `✓ ${c.label}` : c.label,
            onClick: () => tabStore.setRendererOverride(tab.id, c.id === '' ? null : c.id)
          })),
          {
            label: t('tabs.ctx.moreRenderers'),
            children: [
              // 「自动」头项（终审 M-1，受限面/状态栏浮层展开面同形）：✓ 按
              // overrideRenderer === undefined 打标（未显式 override 即自动路由），
              // 点击清 override 回自动（onOpenWith 选「自动」= null 同语义）
              {
                label:
                  tab.overrideRenderer === undefined
                    ? `✓ ${t('tabs.ctx.autoRenderer')}`
                    : t('tabs.ctx.autoRenderer'),
                onClick: () => tabStore.setRendererOverride(tab.id, null)
              },
              ...registry.all().map((r) => ({
                label:
                  tab.overrideRenderer !== undefined && r.id === tab.overrideRenderer
                    ? `✓ ${r.label}`
                    : r.label,
                onClick: () => tabStore.setRendererOverride(tab.id, r.id)
              }))
            ]
          }
        ]
      },
      {
        // 语言轻入口（Task 6）：只读文案 + 跳转（属性面板聚焦语言行，AppShell 监听
        // 侧展开/开抽屉），非候选菜单——语言手动指定的编辑面唯一在 MetaPanel 语言行。
        // 终审 I-1：label 读的是被右键 tab 的 overrideLang（langLabelOf(tab)），onClick
        // 须先激活同一 tab 再派发聚焦——否则右键非激活 tab 时文案与落点跨 tab 错位
        //（聚焦落到原激活 tab 的语言行）。监听在 AppShell document 级 $effect（无
        // 响应式依赖，激活重渲不摘除），先激活后派发即兼容；新 tab meta 异步上行
        // 期间 rAF 聚焦落空按既有静默跳过语义（AppShell onFocusMetaLang 注）。
        label: t('tabs.ctx.lang', { lang: langLabelOf(tab) }),
        onClick: () => {
          activateTab(tab.id);
          requestMetaLangFocus();
        }
      },
      {
        // 另存为（Task 7，spec §6.4）：置灰判定 saveAsDisabledOf（占位/错误/目录），
        // 动作进 saveAs 管线（saveAsTab）。残余 A2 picker-first：远端面 picker 先弹
        // （本点击处理器同步进入 saveAsTab，首个 await 即 showSaveFilePicker——右键
        // 手势的瞬态激活窗内），确认门在其后（远端超阈值钩子用 window.confirm，
        // WorkspaceList/FileTree 同款原生确认先例）：门拒绝 = cancelled 静默。
        // picker 关闭双语义：AbortError（用户主动关对话框）静默；NotAllowedError
        // （浏览器拒绝授权/激活过期——用户没关任何对话框却回到原状）'denied' →
        // 状态条固定文案提示（SAVE_DENIED_NOTICE 单源）。
        // 进度反馈（评审 I-3）：dlProgress 为 ViewerPane 渲染 effect 私有装配面、
        // 跨组件无复用缝——本路径取轻量状态条（远端重下开始/完成一次性提示，本地
        // 在手读零开始提示）；数值进度面为完成态卡路径专属（ViewerPane 内
        // dlProgress 复用，同卡同字段零新造）。
        label: t('tabs.ctx.saveAs'),
        disabled: saveAsDisabledOf(tab),
        onClick: () => {
          const remote = isRemoteDownload(tab.source.storeId);
          if (remote) showStatusNotice(t('tabs.ctx.saveAsFetching'));
          void saveAsTab(tab, {
            confirm: (info) =>
              window.confirm(
                t('tabs.ctx.saveAsConfirm', {
                  name: info.name,
                  size: formatBytes(info.sizeBytes)
                })
              )
          })
            .then((r) => {
              if (r === 'saved') showStatusNotice(t('tabs.ctx.saveAsSaved', { name: tab.source.name }));
              else if (r === 'denied') showStatusNotice(SAVE_DENIED_NOTICE);
              // 'cancelled'（用户主动取消）：静默维持现状
            })
            .catch((err: unknown) => {
              showStatusNotice(
                t('tabs.ctx.saveAsFailed', {
                  message: err instanceof Error ? err.message : String(err)
                })
              );
            });
        }
      }
    ];
  });

  /** 中键关闭（spec §1 决策表：auxclick button 1）——closeTab 默认 undoable，入撤销栈。 */
  function onaux(e: MouseEvent, tab: Tab): void {
    if (e.button !== 1) return; // auxclick 对所有非主键派发（右键在此放过，走 contextmenu）
    e.preventDefault(); // 防默认行为（brief：防中键滚动）
    closeTab(tab.id);
  }

  // 拖拽源 id（组件变量而非 dataTransfer 读回：dragover/drop 与 dragstart 同处本组件，
  // 直接持有更简；dataTransfer 仅按 Firefox 要求写入占位数据启动 drag）。
  let dragFromId: string | null = null;
  /** 拖拽落点指示（渲染 .vv-tab-dragover 与前后沿内嵌线）：仅受理落点会置值。 */
  let dragOver = $state<{ id: string; before: boolean } | null>(null);

  function ondragstart(e: DragEvent, tab: Tab): void {
    dragFromId = tab.id;
    const dt = e.dataTransfer;
    if (dt === null) return;
    dt.setData('text/plain', tab.id); // Firefox：空 dataTransfer 不启动 drag
    dt.effectAllowed = 'move';
  }

  /**
   * 落点是否被拒：直接用 tabOrder.reorderIds 纯函数判定（与 drop 时 dragReorder 同一
   * 数学，不复制 pinned 边界条件）——普通 tab 插入 pinned 区内 / pinned tab 越区尾 /
   * 拖回自身 → 拒，dragover 显示禁止光标且不置落点指示。
   */
  function dropRejected(tab: Tab, before: boolean): boolean {
    if (dragFromId === null) return true;
    return (
      reorderIds(
        tabs.map((t) => t.id),
        dragFromId,
        tab.id,
        before,
        new Set(tabs.filter((t) => t.pinned).map((t) => t.id))
      ) === null
    );
  }

  function ondragover(e: DragEvent, tab: Tab): void {
    if (dragFromId === null) return;
    e.preventDefault(); // 允许 drop（HTML5 dnd 默认 = 禁止）
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2; // 中点前 = 插到目标之前
    if (dropRejected(tab, before)) {
      if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'none'; // 禁止光标
      dragOver = null;
      return;
    }
    if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'move';
    dragOver = { id: tab.id, before };
  }

  function ondragleave(e: DragEvent, tab: Tab): void {
    // 行内子元素间移动同样触发 dragleave：落点还在本行内则不清指示
    const to = e.relatedTarget;
    if (to instanceof Node && (e.currentTarget as HTMLElement).contains(to)) return;
    if (dragOver?.id === tab.id) dragOver = null;
  }

  function ondrop(e: DragEvent, tab: Tab): void {
    e.preventDefault();
    const from = dragFromId;
    const over = dragOver;
    dragFromId = null;
    dragOver = null;
    if (from === null || over === null || over.id !== tab.id) return;
    // 受理性已在 dragover 用同一数学判定（拒收落点 dragOver 已置 null，不会到达这里）；
    // dragReorder 对越界返回 false 不动作，双保险
    tabStore.dragReorder(from, tab.id, over.before);
  }

  function ondragend(): void {
    // drop 成功 / 拖出取消 / Esc 释放统一清理（drop 内也清一次，防个别宿主缺 dragend）
    dragFromId = null;
    dragOver = null;
    stopDragAutoScroll(); // 边缘自动滚 rAF 链随拖拽会话终止（含 Esc 取消路径）
  }

  // ---------- tab 条优雅滚动（标签栏收敛 Task 2，spec §4）----------

  /**
   * 滚动容器（.vv-tabbar-tabs）与箭头/渐隐可见性。bind:this 赋值可能晚于首轮
   * effect（GlobalSearchPanel 同款）：effect 判空先行，挂载后 cleanup/重跑幂等重建。
   * 箭头与遮罩的 absolute 锚在 wrapper 上（.vv-tabbar-tabs-wrap，position:relative），
   * 绝不放滚动容器内——会随 scrollLeft 位移（spec §4.3 结构红线）。
   */
  let scroller = $state<HTMLElement | null>(null);
  let vis = $state({ left: false, right: false });

  function updateVis(): void {
    const el = scroller;
    if (el === null) return;
    vis = arrowVisibility(el.scrollLeft, el.clientWidth, el.scrollWidth);
  }

  // 重算触发面（spec §4.3）：scroll（passive）+ ResizeObserver（容器盒变）+ window
  // resize + tabs 依赖——tabs 为 props 深响应代理，枚举即对数组建依赖（开/关 tab、
  // 恢复快照后箭头随 tab 数刷新）。徽标/图标态变更若改 tab 宽度，盒面由 RO 兜底。
  $effect(() => {
    const el = scroller;
    if (el === null) return;
    void [...tabs];
    updateVis();
    const ro = new ResizeObserver(updateVis);
    ro.observe(el);
    const onScroll = (): void => updateVis();
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', updateVis);
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', updateVis);
    };
  });

  // 滚轮横移（spec §4.2）：Svelte 委托路径 onwheel 的 preventDefault 不可靠（评审
  // 焦点 2）——手动元素级非被动监听。竖向占优：归一为 px 后横移并阻断页面竖滚；
  // 横向占优（dominantWheelDelta 返回 0）：放行原生横滚。
  $effect(() => {
    const el = scroller;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      const d = dominantWheelDelta(e);
      if (d === 0) return;
      e.preventDefault();
      el.scrollLeft += d;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  /** 行为常数（spec §4.3 拍板档：单击 0.8×视宽平滑；按住 350ms 后 80ms 步进 64px）。 */
  const HOLD_DELAY_MS = 350;
  const REPEAT_INTERVAL_MS = 80;
  const REPEAT_STEP_PX = 64;
  /** 连滚已发生旗标：抑制随后 click 补滚（释放即停，不叠加一次 0.8×视宽跳跃）。 */
  let held = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let repeatTimer: ReturnType<typeof setInterval> | null = null;

  function arrowNudge(side: 'left' | 'right', px: number, behavior: ScrollBehavior): void {
    scroller?.scrollBy({ left: side === 'left' ? -px : px, behavior });
  }

  function onArrowDown(side: 'left' | 'right'): void {
    // 重入守卫：双指/双指针二次按下会覆盖 holdTimer/repeatTimer 引用，旧链（尤其
    // 80ms 步进 interval）孤儿化永续自动滚——先清既有链再开新链（resetHeld 同时
    // 复位 held，语义与原行内 held=false 一致）
    holdCleanup(true);
    const el = scroller;
    if (el === null) return;
    holdTimer = setTimeout(() => {
      held = true; // 进入连滚：随后的 click 补滚在 onArrowClick 抑制
      repeatTimer = setInterval(() => arrowNudge(side, REPEAT_STEP_PX, 'auto'), REPEAT_INTERVAL_MS);
    }, HOLD_DELAY_MS);
  }

  /**
   * 按住链路清理（pointerup / pointercancel / pointerleave）。held 复位分两路：
   * pointerup 不复位——click 在其之后派发，须读到 held=true 才能抑制补滚；
   * leave/cancel 复位——指针已离开本钮，click 不再落此，旗标滞留会吞掉下一次单击。
   */
  function holdCleanup(resetHeld: boolean): void {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (repeatTimer !== null) {
      clearInterval(repeatTimer);
      repeatTimer = null;
    }
    if (resetHeld) held = false;
  }

  // 卸载兜底：按住中滚到尽头 → {#if} 卸载被按住的按钮，常规清理押注在「DOM 移除
  // 时浏览器派发 pointerleave」上——Chromium 不保证该派发，本仓兼容的老 webkit2gtk
  // 更无保证；漏清则 80ms 步进 interval 孤儿化（组件卸载后仍存活，后续新开 tab 恢复
  // 溢出即无输入自动滚）。$effect 无依赖 → 挂载后跑一次、卸载时执行 cleanup 清两个 timer
  $effect(() => {
    return () => holdCleanup(true);
  });

  function onArrowClick(side: 'left' | 'right'): void {
    if (held) {
      held = false; // 连滚刚发生：本次 click 是按住释放的派发余波，吞掉并复位
      return;
    }
    const el = scroller;
    if (el === null) return;
    arrowNudge(side, el.clientWidth * 0.8, 'smooth');
  }

  /**
   * 激活 tab 滚入（spec §4.4）：instant（auto）裁决——平滑动画与连续点击/拖拽重排
   * 竞态，e2e 稳定优先；树/quick open 等一切 activateTab 通道自动获益。拖拽进行中
   * 跳过（评审焦点 5）：dragFromId 故意保持非响应式（不建依赖、不触发重跑）——
   * 拖拽中的激活变化不动作，被拖 tab 本就在可视区，结束后亦无需补滚。
   */
  let activeTabId = $derived(tabs.find((t) => t.active)?.id ?? null);
  $effect(() => {
    const id = activeTabId;
    if (id === null) return;
    const el = scroller;
    if (el === null) return;
    if (dragFromId !== null) return;
    // a11y Task 2：role=tab 落内层 .vv-tab-hit 后，.active 仍在壳上——按类锚滚入
    el.querySelector<HTMLElement>('.vv-tab.active')?.scrollIntoView({
      inline: 'nearest',
      block: 'nearest',
      behavior: 'auto'
    });
  });

  // ---------- 拖拽边缘自动滚（标签栏收敛 Task 2，spec §4.5）----------
  // native-first 探针结论（SCRL-07，Chromium headless / playwright CDP drag）：
  // 悬置右缘 36px 带 1.2s scrollLeft 恒 0——合成 drag 会话不驱动浏览器原生
  // autoscroll timer，按计划走「探针红 → 补手工实现」终态。§4.5 参数逐字：
  // 36px 边缘带 + rAF 步进 ±10px/帧；dragleave（离容器）/drop/dragend 清理。
  const DRAG_EDGE_PX = 36;
  const DRAG_STEP_PX = 10;
  let dragRafId: number | null = null;
  let dragDir = 0;

  function stopDragAutoScroll(): void {
    if (dragRafId !== null) {
      cancelAnimationFrame(dragRafId);
      dragRafId = null;
    }
    dragDir = 0;
  }

  /**
   * 容器级 dragover（与 tab 级落点指示 handler 并存，冒泡后到）：clientX 落左右
   * 36px 带则起 rAF 链步进滚动。方向未变不重挂（dragover 高频派发，反复重挂会使
   * 步进永远凑不满一帧）；方向翻转/回中带即停旧链。dragFromId 门禁：外部文件拖入
   * （AppShell window drop 通道）不触发自动滚。
   */
  function onScrollerDragover(e: DragEvent): void {
    if (dragFromId === null) {
      stopDragAutoScroll();
      return;
    }
    const el = scroller;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const rel = e.clientX - rect.left;
    const dir = rel < DRAG_EDGE_PX ? -1 : rel > rect.width - DRAG_EDGE_PX ? 1 : 0;
    if (dir === dragDir) return;
    stopDragAutoScroll();
    if (dir === 0) return;
    dragDir = dir;
    const step = (): void => {
      el.scrollLeft += dir * DRAG_STEP_PX;
      dragRafId = requestAnimationFrame(step);
    };
    dragRafId = requestAnimationFrame(step);
  }

  /** 拖出容器（relatedTarget 已不在容器内）即停——tab 间穿越的 dragleave 不清。 */
  function onScrollerDragleave(e: DragEvent): void {
    const to = e.relatedTarget;
    if (to instanceof Node && scroller?.contains(to)) return;
    stopDragAutoScroll();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions --><!--
     pointerenter/leave 为临时条唤出通道（无 AT 语义）。a11y Task 2：role=tablist
     从本容器落位 .vv-tabbar-tabs（axe aria-required-children：tablist 的
     required owned=tab，容器直下还挂着融合菜单/箭头/管理钮等非 tab 可聚焦件，
     一律判 unallowed——落位后 owned 仅剩各 role=tab；键盘焦点在滚动容器内
     各 role=tab 的 .vv-tab-hit[tabindex=0] 上，ARIA APG tab 惯例） -->
<div
  class="vv-tabbar"
  class:vv-chrome-temp={temp}
  class:vv-chrome-off={hidden}
  onpointerenter={() => onenter?.()}
  onpointerleave={() => onleave?.()}
>
  <!-- 顶栏退役 Task 2：嵌套滚动结构——左端全局动作簇（flex:none 定宽不随滚动）+
       tabs 横向滚动容器（overflow-x 收进内层）+ 既有管理钮。role=tablist 原留守
       .vv-tabbar，a11y Task 2 落位 .vv-tabbar-tabs（上方容器注）。标签栏收敛 Task 1：
       簇内四件收敛为融合菜单单钮（.vv-tabbar-actions → .vv-tabbar-menu） -->
  <div class="vv-tabbar-menu">
    <TabBarMenu {themeMode} {onsettheme} {onsettings} {onmounts} {zen} {onToggleZen} />
  </div>
  <!-- tab 条优雅滚动（标签栏收敛 Task 2）：外包 .vv-tabbar-tabs-wrap
       （position:relative）包住滚动容器与两组箭头/渐隐——absolute 锚若置于
       .vv-tabbar-tabs（滚动容器）内会随 scrollLeft 位移（spec §4.3 红线）；
       不可滚方向整钮+遮罩 {#if} 不渲染 -->
  <div class="vv-tabbar-tabs-wrap">
    {#if vis.left}
      <button
        type="button"
        class="vv-tabbar-arrow"
        data-side="left"
        aria-label={t('tabs.arrow.left')}
        title={t('tabs.arrow.left')}
        onpointerdown={() => onArrowDown('left')}
        onpointerup={() => holdCleanup(false)}
        onpointercancel={() => holdCleanup(true)}
        onpointerleave={() => holdCleanup(true)}
        onclick={() => onArrowClick('left')}>◂</button><div class="vv-tabbar-fade" data-side="left"></div>
    {/if}
    <div
      class="vv-tabbar-tabs"
      role="tablist"
      tabindex="-1"
      bind:this={scroller}
      ondragover={onScrollerDragover}
      ondragleave={onScrollerDragleave}
      ondrop={stopDragAutoScroll}
    >
    {#each tabs as tab (tab.id)}
      {@const badge = badgeOfFor(tab)}
      <!-- a11y Task 2 结构落位（axe nested-interactive + aria-required-children 真修，
           替代遗留 U2 注）：
           · role=tablist 移至 .vv-tabbar-tabs（required owned=tab 即其直子级；
             reviewEmpty 使空条态为 needs-review 非 violation）；
           · tab 为 childrenPresentational 角色（AT 把整钮呈现为单一原子件），
             内嵌可聚焦件必违 nested-interactive——故 .vv-tab 壳降为
             presentation（指针/拖拽/右键 handler 全留壳上，类名锚不变），
             role=tab 落内层 .vv-tab-hit（tabindex/aria-selected/键盘接线随迁）；
           · 关闭钮改 aria-hidden 纯指针字形（span.vv-tab-close，类名锚不变）：
             键盘关闭 = hit 聚焦后 Delete/Backspace（编辑器惯例）或右键菜单
             「关闭」（Shift+F10），键盘路径不丢；aria-hidden + 不可聚焦不触发
             axe aria-hidden-focus。 -->
      <!-- presentation 壳不进 AT 树（键盘交互由内层 hit 承担，见上注） -->
      <div
        class="vv-tab"
        role="presentation"
        class:active={tab.active}
        class:vv-tab-pinned={tab.pinned === true}
        data-pinned={tab.pinned === true ? 'true' : undefined}
        class:vv-tab-dragover={dragOver?.id === tab.id}
        data-drop-before={dragOver?.id === tab.id ? String(dragOver.before) : undefined}
        draggable="true"
        onclick={() => activateTab(tab.id)}
        oncontextmenu={(e) => openMenu(e, tab)}
        onauxclick={(e) => onaux(e, tab)}
        onmousedown={(e) => {
          // 中键自动滚动由 mousedown 默认行为启动（auxclick 的 preventDefault 已迟）——
          // 仅拦中键，左键默认（聚焦/文本选择）不动；auxclick 仍照常派发，关闭在其上接线
          if (e.button === 1) e.preventDefault();
        }}
        ondragstart={(e) => ondragstart(e, tab)}
        ondragover={(e) => ondragover(e, tab)}
        ondragleave={(e) => ondragleave(e, tab)}
        ondrop={(e) => ondrop(e, tab)}
        ondragend={ondragend}>
        <div
          class="vv-tab-hit"
          role="tab"
          tabindex="0"
          aria-selected={tab.active}
          onkeydown={(e) => {
            // 键盘接线（ARIA APG tab 键盘约定的本仓形态）：Enter/Space 激活；
            // Delete/Backspace 关闭（aria-hidden 关闭字形的键盘等价通道）。
            // 快捷键只认 hit 本身：命中子元素时不吞（现子元素均不可聚焦，防御保留）
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activateTab(tab.id);
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
              e.preventDefault();
              closeTab(tab.id);
            }
          }}>
          {#if iconTabs}
            <!-- tab 图标位（图标主题 spec §3.3 tabs 作用域）：文件 tab kind=file、
                 目录 tab（path===''，目录挂载/恢复通道）kind=folder -->
            <FileIcon kind={tab.source.path === '' ? 'folder' : 'file'} name={tab.source.name} />
          {/if}
          <span class="vv-tab-name" title={tab.source.name}>{tab.source.name}</span>
          {#if badge !== null}
            <!-- 来源徽标（多源 workspace 才显示）：截短由 CSS ellipsis 承担，title 全名 -->
            <span class="vv-tab-src" title={badge}>{badge}</span>
          {/if}
        </div>
        <!-- aria-hidden 纯指针字形（键盘关闭走 hit 的 Delete/右键菜单，见上注） -->
        <span
          class="vv-tab-close"
          aria-hidden="true"
          onclick={(e) => {
            e.stopPropagation();
            closeTab(tab.id);
          }}>✕</span>
      </div>
    {/each}
    </div>
    {#if vis.right}
      <button
        type="button"
        class="vv-tabbar-arrow"
        data-side="right"
        aria-label={t('tabs.arrow.right')}
        title={t('tabs.arrow.right')}
        onpointerdown={() => onArrowDown('right')}
        onpointerup={() => holdCleanup(false)}
        onpointercancel={() => holdCleanup(true)}
        onpointerleave={() => holdCleanup(true)}
        onclick={() => onArrowClick('right')}>▸</button><div class="vv-tabbar-fade" data-side="right"></div>
    {/if}
  </div>
  <!-- T6：tab 管理面板入口。data-vv-wspanel-trigger 供面板外点关闭豁免
       （pointerdown 先关 + click 切换会打架，见 WorkspaceTabsPanel 头注释） -->
  <button
    type="button"
    class="vv-tabbar-manage"
    data-vv-wspanel-trigger
    aria-label={t('tabs.manage.aria')}
    title={t('tabs.manage.title')}
    onclick={onmanage}>▾</button>
  {#if ctx !== null}
    <!-- 右键菜单浮层（fixed 定位不随 tabbar 横向滚动；关闭路径收敛在组件内） -->
    <TabContextMenu
      x={ctx.x}
      y={ctx.y}
      tab={ctx.tab}
      actions={ctxActions}
      onclose={() => (ctx = null)}
    />
  {/if}
</div>
