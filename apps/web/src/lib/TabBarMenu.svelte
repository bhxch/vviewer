<script lang="ts">
  // TabBarMenu.svelte — TabBar 左端融合菜单（标签栏收敛 spec Task 1）：触发钮
  // 「工作区名 ▾」+ 单浮层承载全部全局功能，替代原 [WorkspaceSwitcher][＋][↻][⋯]
  // 四件簇（TabBarActions/WorkspaceSwitcher 退役）。首层 8 行序固定（spec §3.2）：
  // 工作区▸/打开▸/刷新当前文件/连接服务器/主题▸/目录管理/设置/专注模式，子菜单
  // 为就地手风琴（sub 单槽，同刻至多一个展开；aria-expanded 在三个父项上）。
  // themeMode/onsettheme/onsettings/onmounts/zen/onToggleZen 由 AppShell 持有
  // ——订阅链所有权在壳层，本组件只消费；onsettheme 为显式三显项入参（主题
  // 轮换 oncycletheme 退役，spec §8 裁决）。
  // aria-label/title 逐字沿用（e2e 锚锚面：刷新当前文件/目录管理/
  // 设置/zen 文案随态/文件 URL）；触发钮 aria-label 例外（a11y Task 2 真修）：
  // 静态「切换工作区」改动态「工作区：工作区名」——axe label-content-name-mismatch
  // 要求可见文本含于 accessible name（模板处注）。触发钮 title 换「工作区与全局功能菜单」——
  // 单钮承载全域，原「新建/重命名/删除」注解归「工作区」子菜单本体。首层条目
  // accessible name=可见文本（chevron ▸/▾ 为 aria-hidden span，不进 name）；
  // 「工作区/打开/主题/粘贴 URL/打开文件/打开文件夹/连接服务器」等条目文案
  // 逐字沿用旧簇（helper 流语义零漂移），刷新条目 ↻ 字形 aria-hidden（name 与
  // 可见非字形文本一致）。narrow「工作区 ▾」分支退役（spec §3.4：单按钮形态下
  // 工作区名不再让位）。
  // 浮层通道 = 外点 pointerdown + 容器 Esc（appShellZenEsc I-2 契约形态：状态名
  // menuOpen、class .vv-tbmenu-pop 由计划正则钉死）+ window 兜底（target 在浮层
  // 外的物理 Esc）；fixed 视口收敛（chrome 菜单模式，无 scroll-close）；开合时
  // 从触发钮 rect 一次 clamp（POP_EST），子菜单/行内表单开合经 $effect 实测
  // pop.offsetHeight 重收敛并压 max-height 转内部滚动（spec §3.3 超高策略——
  // 移动端 667px 高、矮窗下工作区列表 + 行内表单叠加展开必触顶，mobile project
  // 触达流依赖它稳定）。
  import ServerConnectForm from './ServerConnectForm.svelte';
  import WorkspaceCreateModal from './WorkspaceCreateModal.svelte';
  import WorkspaceList from './WorkspaceList.svelte';
  import {
    openFiles,
    openDirectoryViaPicker,
    openUrl,
    tabStore,
    workspacesView
  } from './openFlow.svelte';
  import type { Settings } from './stores/settings';

  let {
    themeMode,
    onsettheme,
    onsettings,
    onmounts,
    zen,
    onToggleZen
  }: {
    themeMode: Settings['themeMode'];
    onsettheme(mode: Settings['themeMode']): void;
    onsettings(): void;
    onmounts(): void;
    zen: boolean;
    onToggleZen(): void;
  } = $props();

  /** 当前 workspace（workspacesView 为 workspaceStore 的 runes 镜像）——触发钮文案读它。 */
  const activeWorkspace = $derived(
    workspacesView.list.find((w) => w.id === workspacesView.activeId) ?? null
  );

  // ---------- hidden file input（常驻挂载，菜单收合不丢；TabBarActions 原样迁）----------

  let fileInput = $state<HTMLInputElement | null>(null);

  function onPick(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files) openFiles([...input.files]);
    input.value = '';
  }

  // ---------- 浮层开合（单触发钮 + 单浮层；子菜单单槽同刻至多一个）----------

  let menuOpen = $state(false);
  /** 子菜单单槽：'ws' 工作区 / 'open' 打开 / 'theme' 主题，null = 全收。切换互斥
   * （旧簇 menu 'open'|'more' 单槽同思路，展开面并入本状态）。 */
  let sub = $state<'ws' | 'open' | 'theme' | null>(null);
  /** 行内展开态：「粘贴 URL」表单（打开子菜单）与「连接服务器」表单——开合归属
   * 各自条目；瞬态面语义沿旧簇（未提交输入跨浮层开合不保，收合即清）。 */
  let urlOpen = $state(false);
  let srvOpen = $state(false);
  let urlValue = $state('');
  /** 新建工作区模态（WorkspaceCreateModal 条件挂载）：挂在本组件体——浮层
   * {#if} 之外，「新建先关菜单」不连带卸载模态（原 WorkspaceSwitcher 同构落位，
   * spec §3.1 builder check 核实项；WorkspaceList 内挂会随浮层卸载被带走）。 */
  let createOpen = $state(false);
  /** fixed 定位坐标：开合时从触发钮 rect 取一次（chrome 菜单模式估算收敛，不追滚动）。 */
  let popPos = $state<{ left: number; top: number }>({ left: 8, top: 8 });
  let triggerBtn = $state<HTMLButtonElement | null>(null);
  let popEl = $state<HTMLElement | null>(null);

  /** 视口收敛估算尺寸（chrome 菜单模式同款粗估）：取「首层 8 行 + 子菜单/表单
   * 展开」上界 220×400——估算偏大只把 top 收得偏上，实测重收敛（下方 $effect）
   * 兜底回正；偏小场景由 top 拉回分支兜底。 */
  const POP_EST = { w: 220, h: 400 } as const;

  /** 主题三显式项（spec §3.2：跟随系统/亮/暗，当前项 ✓ 前缀——TabContextMenu 先例）。 */
  const THEME_MODES = [
    ['system', '跟随系统'],
    ['light', '亮'],
    ['dark', '暗']
  ] as const;

  function toggleMenu(e: MouseEvent): void {
    if (menuOpen) {
      menuOpen = false; // 再点触发钮收起
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    popPos = {
      left: Math.max(8, Math.min(rect.left, window.innerWidth - POP_EST.w - 8)),
      top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - POP_EST.h - 8))
    };
    menuOpen = true;
  }

  $effect(() => {
    // 浮层超高策略（spec §3.3）：menuOpen/sub/urlOpen/srvOpen 任一开合变化即实测
    // pop 占高（getBoundingClientRect，border-box 渲染值，与「底缘 ≤ 视口」断言
    // 同源）与可用高（视口 − top − 8）同面比较——超高则压 max-height 转内部滚动
    // （.vv-tbmenu-pop overflow-y:auto，该滚动条属面板滚动非 tab 条，不隐藏）；
    // 否则保持清空，并把 top 拉回视口内（POP_EST 估算偏小的兜底，右下溢出时上
    // 移、不低于 8）。Svelte effect 在 DOM 落定后运行；打开期间不追滚动/缩放
    //（fixed 一次估算同档语义）
    void sub;
    void urlOpen;
    void srvOpen;
    const el = popEl;
    if (menuOpen === false || el === null) return;
    // max-height 的约束面随 box-sizing 而异（Task 4 探针定性，评审修复轮 2）：
    // app 全局无 box-sizing 重置，本浮层为 content-box——maxHeight 限的是
    // content，须扣除 padding+border（chrome）才等于占高上限；border-box 下
    // maxHeight 即占高上限，chrome=0。判定面（自然占高 > avail）与设置面
    //（content 上限 = avail − chrome）同构：首版按 border-box 语义直写 avail，
    // content-box 下底缘越视口 +2px，且「内容略超可用高 ≤chrome 带」内
    // maxHeight ≥ content 不产生溢出——10px 死窗（不触发内滚）
    const cs = getComputedStyle(el);
    const chrome =
      cs.boxSizing === 'border-box'
        ? 0
        : el.offsetHeight -
            el.clientHeight + // border 两侧（clientHeight 含 padding 不含 border）
          parseFloat(cs.paddingTop) +
          parseFloat(cs.paddingBottom);
    const avail = window.innerHeight - popPos.top - 8;
    // 先清再测自然占高：钳制在位时 rect 反映钳后值，直接判定会被自身钳制钉死
    //（占高恒 = avail，重跑如「钳制在位再展开连接服务器表单」误走解除分支，
    // 钳制丢失且无恢复）——解除→实测→按需写回，单轮内自洽
    el.style.maxHeight = '';
    const h = el.getBoundingClientRect().height;
    if (h > avail) {
      el.style.maxHeight = `${Math.max(avail - chrome, 0)}px`;
    } else if (popPos.top + h > window.innerHeight - 8) {
      popPos = { ...popPos, top: Math.max(8, window.innerHeight - h - 8) };
    }
  });

  $effect(() => {
    if (menuOpen === false) {
      // 收合即清瞬态面（旧双浮层随卸载即焚语义：未提交 URL/服务器表单输入跨
      // 开合不保；子菜单单槽一并归位，下次打开从首层起）
      sub = null;
      urlOpen = false;
      srvOpen = false;
      urlValue = '';
      return;
    }
    // 关闭通道（chrome 菜单模式）：外点 pointerdown + window 兜底 Esc。无
    // scroll-close（fixed 定位不随 tabbar 横向滚动失锚）。window keydown 只接
    // target 在浮层外的 Esc——容器通道（浮层 onkeydown）覆盖浮层内焦点物理 Esc
    // 与移动端合成 Esc（closeTopOverlayForZen 派发目标即 pop 本体，被本兜底的
    // contains 守卫挡下，appShellZenEsc I-2 契约）；同一事件只有一个 target，
    // 互补不双触发
    const onKey = (e: KeyboardEvent): void => {
      if (
        e.key === 'Escape' &&
        popEl !== null &&
        (e.target instanceof Node ? !popEl.contains(e.target) : true)
      ) {
        e.preventDefault();
        menuOpen = false;
      }
    };
    const onDown = (e: PointerEvent): void => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (popEl?.contains(t) === true) return; // 菜单内交互不关（含子菜单/行内表单）
      if (triggerBtn?.contains(t) === true) return; // 触发钮交还 click toggle
      menuOpen = false;
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
    urlValue = ''; // 提交后展开行收起、菜单保持开（旧 ＋ 菜单同语义）
    urlOpen = false;
  }

  // ---------- 手动刷新（TabBarActions :118-126 原样迁，tabStore 直连）----------

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

<!-- 触发钮（spec §3.4 DOM 契约）：class/.aria-expanded 红线逐字；aria-label 原为
     静态「切换工作区」（旧红线），axe label-content-name-mismatch（wcag2a，a11y
     Task 2）真修：可见文本「工作区名 ▾」须含于 accessible name——label 动态
     「工作区：工作区名」纳入可见值（word 分词后「名」为 label 子序列，▾ 为非
     字形 token 剥离，双态均匹配）；文本恒「工作区名 ▾」（▾ 直排可见文案） -->
<button
  type="button"
  class="vv-tbmenu-trigger"
  bind:this={triggerBtn}
  aria-label={`工作区：${activeWorkspace?.name ?? '工作区'}`}
  aria-expanded={menuOpen}
  title="工作区与全局功能菜单"
  onclick={toggleMenu}>{activeWorkspace?.name ?? '工作区'} ▾</button
>
<input type="file" multiple hidden bind:this={fileInput} onchange={onPick} />
{#if menuOpen}
  <!-- 不用 role="menu"：条目均为原生 button（键盘可达），menu 角色反而要求
       tabindex/方向键管理（a11y_interactive_supports_focus 警告）；aria-expanded
       已在触发钮上表达展开态 -->
  <!-- svelte-ignore a11y_no_static_element_interactions --><!-- 容器 Esc 同仓库
       dialog keydown 模式（设置中心/GlobalSearchPanel 等）：合成 Esc（移动端返回键
       closeTopOverlayForZen 派发）与浮层内焦点物理 Esc 的统一关闭通道。
       oncontextmenu（TabContextMenu 同款）：浮层为 .vv-tabbar 后代，壳层
       onShellContextMenu 会把右键条目当 tabbar 空白叠开 chrome 菜单——
       stopPropagation 截断冒泡；preventDefault 只对非输入元素（重命名框/URL 框
       保留原生粘贴菜单，AppShell 同款守卫） -->
  <div
    class="vv-tbmenu-pop"
    style="left:{popPos.left}px; top:{popPos.top}px"
    bind:this={popEl}
    oncontextmenu={(e) => {
      e.stopPropagation();
      if ((e.target as HTMLElement).closest('input, textarea, select') === null) e.preventDefault();
    }}
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        menuOpen = false;
      }
    }}
  >
    <!-- ① 工作区 ▸：子菜单=WorkspaceList（列表条目类名零变更）；oncreate 内
         先关菜单再开模态（模态挂本组件体，见 createOpen 注） -->
    <button
      type="button"
      class="vv-tbmenu-item"
      aria-expanded={sub === 'ws'}
      onclick={() => (sub = sub === 'ws' ? null : 'ws')}>
      工作区
      <span class="vv-tbmenu-caret" aria-hidden="true">{sub === 'ws' ? '▾' : '▸'}</span>
    </button>
    {#if sub === 'ws'}
      <div class="vv-tbmenu-sub">
        <WorkspaceList
          onclose={() => (menuOpen = false)}
          oncreate={() => {
            menuOpen = false;
            createOpen = true;
          }}
        />
      </div>
    {/if}
    <!-- ② 打开 ▸：打开文件（filechooser，点击先收菜单再弹原生选择器——hidden
         input 常驻挂载不丢）/ 打开文件夹（showDirectoryPicker + 既有 fallback）/
         粘贴 URL（行内表单就地展开） -->
    <button
      type="button"
      class="vv-tbmenu-item"
      aria-expanded={sub === 'open'}
      onclick={() => (sub = sub === 'open' ? null : 'open')}>
      打开
      <span class="vv-tbmenu-caret" aria-hidden="true">{sub === 'open' ? '▾' : '▸'}</span>
    </button>
    {#if sub === 'open'}
      <div class="vv-tbmenu-sub">
        <button
          type="button"
          class="vv-tbmenu-item"
          onclick={() => {
            menuOpen = false;
            fileInput?.click();
          }}>打开文件</button
        >
        <button
          type="button"
          class="vv-tbmenu-item"
          onclick={() => {
            menuOpen = false;
            void openDirectoryViaPicker();
          }}>打开文件夹</button
        >
        <button
          type="button"
          class="vv-tbmenu-item"
          aria-expanded={urlOpen}
          onclick={() => (urlOpen = !urlOpen)}>
          粘贴 URL
        </button>
        {#if urlOpen}
          <!-- 选中就在菜单内就地展开的单行 URL 表单：input aria-label 沿用原文
               （e2e 锚「文件 URL」）；提交通道同 TopBar submit（trim 后 openUrl），
               另配显式「打开」钮（空态引导区同款形态）；提交后展开行收起、菜单
               保持开 -->
          <form class="vv-tbmenu-row" onsubmit={submitUrl}>
            <input placeholder="粘贴文件 URL" bind:value={urlValue} aria-label="文件 URL" />
            <button type="submit">打开</button>
          </form>
        {/if}
      </div>
    {/if}
    <!-- ③ 刷新当前文件：直动作（aria-label/title 逐字；↻ 字形 aria-hidden 不进
         name；点击即收菜单——动作类条目统一收合语义，同 ⑥⑦⑧） -->
    <button
      type="button"
      class="vv-tbmenu-item"
      aria-label="刷新当前文件"
      title="手动刷新当前文件与目录树（快捷键 Ctrl+, 打开设置可关自动刷新）"
      onclick={() => {
        menuOpen = false;
        manualRefresh();
      }}>
      <span aria-hidden="true">↻</span> 刷新当前文件
    </button>
    <!-- ④ 连接服务器：直展开行内表单（菜单保持开）。常驻挂载+hidden 控制
         （TopBar 终审 Minor 同款）：本菜单会话内切换收展不卸载，未提交输入
         保留；随菜单关闭整体卸载（瞬态面语义）。连接成功收起整个菜单 -->
    <button
      type="button"
      class="vv-tbmenu-item"
      aria-expanded={srvOpen}
      onclick={() => (srvOpen = !srvOpen)}>
      连接服务器
    </button>
    <div hidden={!srvOpen}>
      <ServerConnectForm
        onconnected={() => {
          srvOpen = false;
          menuOpen = false;
        }}
      />
    </div>
    <!-- ⑤ 主题 ▸：三显式项子菜单，选择即应用（onsettheme 显式入参）并收菜单
         （主题「点击即收」沿旧簇语义，与连接服务器「保持开」不同）；当前项 ✓
         前缀随 themeMode 回显 -->
    <button
      type="button"
      class="vv-tbmenu-item"
      aria-expanded={sub === 'theme'}
      onclick={() => (sub = sub === 'theme' ? null : 'theme')}>
      主题
      <span class="vv-tbmenu-caret" aria-hidden="true">{sub === 'theme' ? '▾' : '▸'}</span>
    </button>
    {#if sub === 'theme'}
      <div class="vv-tbmenu-sub">
        {#each THEME_MODES as [mode, label] (mode)}
          <button
            type="button"
            class="vv-tbmenu-item"
            onclick={() => {
              onsettheme(mode);
              menuOpen = false;
            }}>
            {themeMode === mode ? '✓ ' : ''}{label}
          </button>
        {/each}
      </div>
    {/if}
    <!-- ⑥ 目录管理（aria/title 逐字，title 含 Ctrl+Alt+M） -->
    <button
      type="button"
      class="vv-tbmenu-item"
      aria-label="目录管理"
      title="目录管理（Ctrl+Alt+M）：服务端挂载 / 前端直连与代理 / 本机授权"
      onclick={() => {
        menuOpen = false;
        onmounts();
      }}>
      目录管理
    </button>
    <!-- ⑦ 设置（aria/title 逐字，title 含 Ctrl+,） -->
    <button
      type="button"
      class="vv-tbmenu-item"
      aria-label="设置"
      title="设置（Ctrl+,）：外观 / 字体 / 图表 / 搜索与排除 / 自动刷新 / 计算"
      onclick={() => {
        menuOpen = false;
        onsettings();
      }}>
      设置
    </button>
    <!-- ⑧ 专注模式：aria-label 沿用 TopBar 原文随 zen 态切换，title 旧簇原文
         （随顶栏退役删「隐藏顶栏」字样，appShellZenToast 契约锚），可见文案
         随 zen 态切换 -->
    <button
      type="button"
      class="vv-tbmenu-item"
      aria-label={zen ? '退出专注模式' : '进入专注模式'}
      title={zen
        ? '退出专注模式（Esc 或 Ctrl+Alt+Z）'
        : '专注模式（Ctrl+Alt+Z）：隐藏标签栏与两侧面板，进入后按 Esc 或 Ctrl+Alt+Z 退出'}
      onclick={() => {
        menuOpen = false;
        onToggleZen();
      }}>
      {zen ? '退出专注' : '专注'}
    </button>
  </div>
{/if}
{#if createOpen}
  <!-- 新建工作区模态：挂本组件体（浮层 {#if} 之外，spec §3.1）——「新建先关菜单」
       不连带卸载；.vv-wscreate 的 visibility:visible 逃生门继续生效（chrome-off
       潜在继承域，app.css 该段注释） -->
  <WorkspaceCreateModal onclose={() => (createOpen = false)} />
{/if}
