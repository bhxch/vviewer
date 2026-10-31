<script lang="ts">
  import { onMount } from 'svelte';
  import ServerConnectForm from './ServerConnectForm.svelte';
  // 工作区切换器（顶栏退役 spec Task 1 自本文件内联块抽取，切换器逻辑/DOM 契约
  // 归 WorkspaceSwitcher 自持，本组件只消费——顶栏退役第一步降耦）
  import WorkspaceSwitcher from './WorkspaceSwitcher.svelte';
  import { openFiles, openDirectoryViaPicker, openUrl, tabStore } from './openFlow.svelte';
  import { loadSettings, saveSettings, onSettingsChanged, type Settings } from './stores/settings';
  import { applyAppearanceFromSettings, applyFontsFromSettings, onSystemModeChange } from './theme';
  import { reactToFontsChange } from './fontsReaction';

  /** chrome 隐藏/临时条形态（spec 2026-10-19 §2/§3，AppShell 传值）：hidden=移出
   * 视口的隐藏态（组件保持挂载，设置中心入口回调 onsettings 不失效）；temp=边缘
   * 悬停唤出的半透条。onenter/onleave 供 AppShell 做「重入取消隐藏定时/移开 1.5s
   * 再隐」——组件不持有 layout 状态（所有权在 AppShell）。设置中心（⚙/Ctrl+,，
   * spec 2026-10-19 设置中心 §2）与目录管理页（📁/Ctrl+Alt+M，目录挂载 spec §5
   * 阶段四）开关状态归 AppShell，本组件只发回调。zen/onToggleZen（专注模式可见
   * 入口）：zen 态展示与切换回调同归 AppShell（toggleZen 所在地），本组件只发
   * 回调——zen 下顶栏隐藏但热区唤出的临时条上按钮仍可点（退出通道之一）。 */
  let {
    temp = false,
    hidden = false,
    onenter,
    onleave,
    onsettings,
    onmounts,
    zen = false,
    onToggleZen
  }: {
    temp?: boolean;
    hidden?: boolean;
    onenter?: () => void;
    onleave?: () => void;
    onsettings(): void;
    onmounts(): void;
    zen?: boolean;
    onToggleZen(): void;
  } = $props();
  let urlValue = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);
  let settings = $state<Settings>(loadSettings());

  // 连接服务器：内联展开开关（表单本体已抽 ServerConnectForm 共享组件——
  // 侧栏多根 spec Task 3，与空态引导区共用；本组件只持开合，预填/连接/错误归组件。
  // 消费形态为常驻挂载+hidden 控制（终审 Minor）：收起不卸载，未提交输入再展开保留）
  let serverOpen = $state(false);

  /** OS 亮暗响应式镜像（BUG-49）：matchMedia 非响应式信号——OS 切换时经
   * onSystemModeChange 订阅在 themeMode=system 下补一发注入（UI 配色由
   * prefers-color-scheme 媒体查询自动跟随，JS 注入变量需要这步）。高亮配色槽位
   * 读写已迁设置中心外观节（AppearanceSection 自带同款镜像）。 */

  onMount(() => {
    applyAppearanceFromSettings(settings); // 首次注入：签名初值 null 必命中
    applyFontsFromSettings(settings); // 首次字体注入（style#vv-font；返回值忽略——挂载期无活动渲染实例）
    // 订阅设置变更保持本副本最新（防本组件 saveSettings 写回旧值），同时作为
    // 注入的唯一触发通道：diff 四元组、槽相关变化才注入（spec 2026-10-12 §2.4）
    const offSettings = onSettingsChanged((s) => {
      settings = s;
      applyAppearanceFromSettings(s);
      // fonts 变更 → style#vv-font 重注入 + 激活 tab rev++ 重渲染（行高联动，
      // 字体系统 spec §2.3/§3，Task 2；无关字段变化零触发）
      reactToFontsChange(s, () => tabStore.touchActiveTab());
    });
    // themeMode=system：OS 亮暗切换不经 saveSettings（BUG-49，见上注释）
    const offSystem = onSystemModeChange(() => {
      if (settings.themeMode !== 'system') return;
      applyAppearanceFromSettings(settings);
    });
    return () => {
      offSettings();
      offSystem();
    };
  });

  function cycleTheme(): void {
    const order: Settings['themeMode'][] = ['system', 'light', 'dark'];
    settings.themeMode = order[(order.indexOf(settings.themeMode) + 1) % 3]!;
    saveSettings(settings);
    // 'system' 模式的暗色由 app.css 的 @media prefers-color-scheme 处理，无需 JS
    document.documentElement.dataset.themeMode = settings.themeMode;
    // 注入不在此直调：saveSettings → onSettingsChanged 订阅 → effectiveMode
    // 变化命中 diff（spec 2026-10-12 §2.4）
  }

  function onPick(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files) openFiles([...input.files]);
    input.value = '';
  }

  /** 手动刷新（BUG-05，SRV-07）：复用 SSE 的 refreshPaths 通道（rev++ 驱动重读）。
   * 活动为文件 tab 时 [path] 同时刷新该文件与目录树（refreshPaths 对目录 tab
   * 恒自增）；活动为目录 tab 时空 paths 刷新整个 store。不受 autoRefresh 开关
   * 限制（开关只过滤 SSE 推送，手动刷新语义即用户显式要求）。 */
  function manualRefresh(): void {
    const t = tabStore.list.find((x) => x.active);
    if (!t) return;
    tabStore.refreshPaths(t.source.storeId, t.source.path === '' ? [] : [t.source.path]);
  }

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    const url = urlValue.trim();
    if (url) {
      openUrl(url);
      urlValue = '';
    }
  }

  function toggleServerPanel(): void {
    serverOpen = !serverOpen;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions --><!-- pointerenter/leave 是
     视觉唤出通道（临时条），无 AT 语义，header 不宜加交互角色 -->
<header
  class="vv-topbar"
  class:vv-chrome-temp={temp}
  class:vv-chrome-off={hidden}
  onpointerenter={() => onenter?.()}
  onpointerleave={() => onleave?.()}
>
  <span class="vv-brand">vviewer</span>
  <button onclick={() => fileInput?.click()}>打开文件</button>
  <input type="file" multiple hidden bind:this={fileInput} onchange={onPick} />
  <button onclick={() => void openDirectoryViaPicker()}>打开文件夹</button>
  <WorkspaceSwitcher />
  <form onsubmit={submit}>
    <input placeholder="粘贴文件 URL" bind:value={urlValue} aria-label="文件 URL" />
  </form>
  <button onclick={toggleServerPanel} aria-expanded={serverOpen}>连接服务器</button>
  <button onclick={manualRefresh} aria-label="刷新当前文件" title="手动刷新当前文件与目录树（快捷键 Ctrl+, 打开设置可关自动刷新）">↻</button>
  <!-- 常驻挂载+hidden 控制（终审 Minor，替代 {#if}）：收起仅隐藏不卸载——未提交
       输入/错误态在收起再展开后保留；组件 onMount 预填语义不变（启动即预填、
       展开时可见，行为等价）。hidden 用原生属性（app.css 无 .hidden 类，class
       指令无样式支撑；本 div 无 display 规则不覆盖 UA [hidden]） -->
  <div hidden={!serverOpen}>
    <ServerConnectForm onconnected={() => (serverOpen = false)} />
  </div>
  <button onclick={cycleTheme}>
    主题：{settings.themeMode === 'system' ? '跟随系统' : settings.themeMode === 'light' ? '亮' : '暗'}
  </button>
  <button onclick={onsettings} aria-label="设置" title="设置（Ctrl+,）：外观 / 字体 / 图表 / 搜索与排除 / 自动刷新 / 计算">
    ⚙
  </button>
  <button
    onclick={onmounts}
    aria-label="目录管理"
    title="目录管理（Ctrl+Alt+M）：服务端挂载 / 前端直连与代理 / 本机授权"
  >
    目录
  </button>
  <!-- 专注模式可见入口：tooltip 写明进出双方式（快捷键 + zen 内退出通道），
       文案随 zen 态切换（zen 下经热区唤出的临时条上即「退出」钮） -->
  <button
    onclick={() => onToggleZen()}
    aria-label={zen ? '退出专注模式' : '进入专注模式'}
    title={zen
      ? '退出专注模式（Esc 或 Ctrl+Alt+Z）'
      : '专注模式（Ctrl+Alt+Z）：隐藏顶栏/标签栏与两侧面板，进入后按 Esc 或 Ctrl+Alt+Z 退出'}
  >
    {zen ? '退出专注' : '专注'}
  </button>
</header>

<style>
  /* 字形钮触控目标（§6.4/§10-G1，≤600px 档，变更 ~26→≥32px 高）：↻/⚙/目录 三钮
     无类名、DOM 零变更红线不可加类，按 aria-label 选取（e2e 同锚稳定：
     button[aria-label="设置"] settings-center.ts、button[aria-label="目录管理"]
     b-mounts-manager.spec.ts:135）。全局 button padding-block 4px 下钮高 ~26px，
     补至 8px 使触控高 ≥32px（13px 字号 + normal 行高 ≈ 33.6px）；随用户字号
     --vv-ui-font-size 联动增大，恒过线。桌面断点不适用，零漂移 */
  @media (max-width: 600px) {
    .vv-topbar button[aria-label='刷新当前文件'],
    .vv-topbar button[aria-label='设置'],
    .vv-topbar button[aria-label='目录管理'] {
      padding-block: 8px;
    }
  }
</style>
