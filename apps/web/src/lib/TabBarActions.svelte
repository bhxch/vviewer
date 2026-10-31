<script lang="ts">
  // TabBarActions.svelte — TabBar 左端全局动作按钮簇（顶栏退役 spec Task 2）。
  // 全局动作唯一宿主（Task 3 随 TopBar 组件退役）：工作区切换（内容一，
  // WorkspaceSwitcher 自持）＋ 打开菜单（内容二：打开文件/打开文件夹/粘贴 URL）＋
  // 手动刷新（内容三）＋ 更多菜单（内容四：连接服务器/主题/目录管理/设置/专注）。
  // themeMode/回调由 AppShell 持有——订阅链所有权在壳层，本组件只消费。
  // aria-label/title 逐字沿用退役前 TopBar 原文（e2e 锚红线：设置/目录管理/
  // 刷新当前文件/zen 文案随态/文件 URL）。
  // 浮层菜单通道 = 外点 pointerdown + Esc + fixed 视口收敛（chrome 菜单模式，无
  // scroll-close）；fixed 坐标开合时从触发钮 rect 取一次，不追滚动/缩放。
  import ServerConnectForm from './ServerConnectForm.svelte';
  import WorkspaceSwitcher from './WorkspaceSwitcher.svelte';
  import { openFiles, openDirectoryViaPicker, openUrl, tabStore } from './openFlow.svelte';
  import type { Settings } from './stores/settings';

  let {
    themeMode,
    oncycletheme,
    onsettings,
    onmounts,
    zen,
    onToggleZen
  }: {
    themeMode: Settings['themeMode'];
    oncycletheme(): void;
    onsettings(): void;
    onmounts(): void;
    zen: boolean;
    onToggleZen(): void;
  } = $props();

  // ---------- 内容二：hidden file input（常驻挂载，菜单收合不丢）+ onPick 自 TopBar 迁（Task 2） ----------

  let fileInput = $state<HTMLInputElement | null>(null);

  function onPick(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files) openFiles([...input.files]);
    input.value = '';
  }

  // ---------- 浮层开合（＋ 打开菜单 / ⋯ 更多菜单，同刻至多一个）----------

  /** 'open' = ＋ 打开菜单、'more' = ⋯ 更多菜单、null = 全收。切换互斥（开一个收另一个）。 */
  let menu = $state<'open' | 'more' | null>(null);
  /** 菜单内行内展开态：「粘贴 URL」行（＋ 菜单）与「连接服务器」表单（⋯ 菜单）——
   * 开合归属各自菜单项，随所在菜单整体卸载（菜单为瞬态面，未提交输入跨开合不保）。 */
  let urlOpen = $state(false);
  let srvOpen = $state(false);
  let urlValue = $state('');
  /** fixed 定位坐标：开合时从触发钮 rect 取一次（chrome 菜单模式估算收敛，不追滚动）。 */
  let popPos = $state<{ left: number; top: number }>({ left: 8, top: 8 });
  let openBtn = $state<HTMLButtonElement | null>(null);
  let moreBtn = $state<HTMLButtonElement | null>(null);
  let popEl = $state<HTMLElement | null>(null);

  /** 视口收敛估算尺寸（chrome 菜单模式同款粗估，chromeMenu 取 170×110 同思路）：
   * open 按「三项目 + URL 行展开」、more 按「五项目 + 服务器表单展开」取上界
   *（more 宽取表单展开态实测 ~236px 上取整——收起态偏左移无害，展开态不右溢）。 */
  const POP_EST = {
    open: { w: 220, h: 200 },
    more: { w: 240, h: 280 }
  } as const;

  function togglePop(which: 'open' | 'more', e: MouseEvent): void {
    if (menu === which) {
      menu = null; // 再点同触发钮收起
      return;
    }
    const est = POP_EST[which];
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    popPos = {
      left: Math.max(8, Math.min(rect.left, window.innerWidth - est.w - 8)),
      top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - est.h - 8))
    };
    menu = which;
  }

  $effect(() => {
    // 浮层关闭通道（chrome 菜单模式）：外点 pointerdown + Esc。无 scroll-close
    //（brief 明示——fixed 定位不随 tabbar 横向滚动失锚，无 TabContextMenu 的滚动
    // 关闭需求）。window keydown 同时承接容器内物理 Esc 与移动端合成 Esc
    //（closeTopOverlayForZen 派发目标即 pop 本体，冒泡到 window 命中本监听）
    if (menu === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        menu = null;
      }
    };
    const onDown = (e: PointerEvent): void => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (popEl?.contains(t) === true) return; // 菜单内交互不关（含行内表单）
      if (menu === 'open' && openBtn?.contains(t) === true) return; // 触发钮交还 click toggle
      if (menu === 'more' && moreBtn?.contains(t) === true) return;
      menu = null;
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  });

  function submitUrl(e: SubmitEvent): void {
    e.preventDefault();
    const url = urlValue.trim();
    if (url) openUrl(url);
    urlValue = ''; // 打开钮：openUrl 后清空收起（brief Step 1 内容二）
    urlOpen = false;
  }

  // ---------- 内容三：手动刷新（自 TopBar 原样迁，tabStore 直连）----------

  /** 手动刷新（BUG-05，SRV-07）：复用 SSE 的 refreshPaths 通道（rev++ 驱动重读）。
   * 活动为文件 tab 时 [path] 同时刷新该文件与目录树（refreshPaths 对目录 tab
   * 恒自增）；活动为目录 tab 时空 paths 刷新整个 store。不受 autoRefresh 开关
   * 限制（开关只过滤 SSE 推送，手动刷新语义即用户显式要求）。 */
  function manualRefresh(): void {
    const t = tabStore.list.find((x) => x.active);
    if (!t) return;
    tabStore.refreshPaths(t.source.storeId, t.source.path === '' ? [] : [t.source.path]);
  }
</script>

<!-- 内容一：工作区切换器（Task 1 独立组件，无 props 自持——本簇只排首位消费） -->
<WorkspaceSwitcher />
<button
  type="button"
  class="vv-tbact"
  bind:this={openBtn}
  aria-label="打开"
  title="打开文件 / 打开文件夹 / 粘贴 URL"
  aria-expanded={menu === 'open'}
  onclick={(e) => togglePop('open', e)}>＋</button
>
<button
  type="button"
  class="vv-tbact"
  aria-label="刷新当前文件"
  title="手动刷新当前文件与目录树（快捷键 Ctrl+, 打开设置可关自动刷新）"
  onclick={manualRefresh}>↻</button
>
<button
  type="button"
  class="vv-tbact"
  bind:this={moreBtn}
  aria-label="更多"
  title="连接服务器 / 主题 / 目录管理 / 设置 / 专注模式"
  aria-expanded={menu === 'more'}
  onclick={(e) => togglePop('more', e)}>⋯</button
>
<input type="file" multiple hidden bind:this={fileInput} onchange={onPick} />
{#if menu === 'open'}
  <!-- ＋ 打开菜单：fixed 定位内联坐标（开合时一次计算）；oncontextmenu 防壳层布局
       菜单叠入（TabContextMenu 同款） -->
  <!-- svelte-ignore a11y_no_static_element_interactions --><!-- 静态容器的
       contextmenu 仅阻止默认菜单，非交互语义 -->
  <div
    class="vv-tbact-pop"
    style="left:{popPos.left}px; top:{popPos.top}px"
    bind:this={popEl}
    oncontextmenu={(e) => e.preventDefault()}
  >
    <button
      type="button"
      class="vv-tbact-item"
      onclick={() => {
        menu = null;
        fileInput?.click();
      }}>打开文件</button
    >
    <button
      type="button"
      class="vv-tbact-item"
      onclick={() => {
        menu = null;
        void openDirectoryViaPicker();
      }}>打开文件夹</button
    >
    <button type="button" class="vv-tbact-item" aria-expanded={urlOpen} onclick={() => (urlOpen = !urlOpen)}>
      粘贴 URL
    </button>
    {#if urlOpen}
      <!-- 选中就在菜单内就地展开的单行 URL 表单：input aria-label 沿用 TopBar 原文
           （e2e 锚「文件 URL」）；提交通道同 TopBar submit（trim 后 openUrl），
           另配显式「打开」钮（空态引导区同款形态） -->
      <form class="vv-tbact-row" onsubmit={submitUrl}>
        <input placeholder="粘贴文件 URL" bind:value={urlValue} aria-label="文件 URL" />
        <button type="submit">打开</button>
      </form>
    {/if}
  </div>
{/if}
{#if menu === 'more'}
  <!-- ⋯ 更多菜单：条目序按 brief（连接服务器/主题/目录管理/设置/专注）；
       目录管理/设置/主题/专注点击即收后回调（brief 裁决），连接服务器切换内联表单不收 -->
  <!-- svelte-ignore a11y_no_static_element_interactions --><!-- 静态容器的
       contextmenu 仅阻止默认菜单，非交互语义 -->
  <div
    class="vv-tbact-pop"
    style="left:{popPos.left}px; top:{popPos.top}px"
    bind:this={popEl}
    oncontextmenu={(e) => e.preventDefault()}
  >
    <button type="button" class="vv-tbact-item" aria-expanded={srvOpen} onclick={() => (srvOpen = !srvOpen)}>
      连接服务器
    </button>
    <!-- 常驻挂载+hidden 控制（TopBar 终审 Minor 同款）：本菜单会话内切换收展不卸载，
         未提交输入保留；随菜单关闭整体卸载（瞬态面语义）。连接成功收起浮层 -->
    <div hidden={!srvOpen}>
      <ServerConnectForm
        onconnected={() => {
          srvOpen = false;
          menu = null;
        }}
      />
    </div>
    <button
      type="button"
      class="vv-tbact-item"
      onclick={() => {
        oncycletheme();
        menu = null;
      }}>
      主题：{themeMode === 'system' ? '跟随系统' : themeMode === 'light' ? '亮' : '暗'}
    </button>
    <button
      type="button"
      class="vv-tbact-item"
      aria-label="目录管理"
      title="目录管理（Ctrl+Alt+M）：服务端挂载 / 前端直连与代理 / 本机授权"
      onclick={() => {
        menu = null;
        onmounts();
      }}>
      目录管理
    </button>
    <button
      type="button"
      class="vv-tbact-item"
      aria-label="设置"
      title="设置（Ctrl+,）：外观 / 字体 / 图表 / 搜索与排除 / 自动刷新 / 计算"
      onclick={() => {
        menu = null;
        onsettings();
      }}>
      设置
    </button>
    <!-- 专注模式菜单项：aria-label/title 沿用 TopBar 原文，文案随 zen 态切换 -->
    <button
      type="button"
      class="vv-tbact-item"
      aria-label={zen ? '退出专注模式' : '进入专注模式'}
      title={zen
        ? '退出专注模式（Esc 或 Ctrl+Alt+Z）'
        : '专注模式（Ctrl+Alt+Z）：隐藏顶栏/标签栏与两侧面板，进入后按 Esc 或 Ctrl+Alt+Z 退出'}
      onclick={() => {
        menu = null;
        onToggleZen();
      }}>
      {zen ? '退出专注' : '专注'}
    </button>
  </div>
{/if}
