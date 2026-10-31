<script lang="ts">
  import { onMount } from 'svelte';
  import { connectServer, loadLastServer } from './openFlow.svelte';

  /** 连接服务器表单（侧栏多根 spec Task 3 自 TopBar 抽取的共享组件）：TopBar 与
   * 侧栏 0 目录空态引导区（AppShell .vv-side-empty）两消费点复用，顶栏退役 spec
   * 后续只消费不重建。内部自持 url/token/connecting/error state——挂载即用会话内
   * 上次成功连接的服务器预填（TopBar 原 toggleServerPanel 预填半段迁入；两消费
   * 形态：TopBar 常驻挂载+hidden 控制（启动即预填，收起保留未提交输入，终审
   * Minor）、AppShell 空态 {#if} 门控挂载（展开首渲染预填，语义等价）），提交走
   * connectServer，成功后清空表单并回调 onconnected（消费点借此收起各自的面板
   * 开关）。组件只管表单，不持任何开合状态（所有权在消费点）。样式零迁移：
   * .vv-server-form/.vv-server-error 在 app.css 全局（原 TopBar 展开行共用），
   * 两消费点视觉一致。 */
  let { onconnected }: { onconnected?: () => void } = $props();

  let serverUrl = $state('');
  let serverToken = $state('');
  let serverError = $state<string | null>(null);
  let connecting = $state(false);

  onMount(() => {
    // 展开首渲染预填（本期不做自动重连）
    if (serverUrl === '') {
      const last = loadLastServer();
      if (last) {
        serverUrl = last.baseUrl;
        serverToken = last.token ?? '';
      }
    }
  });

  async function connect(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (connecting) return;
    const url = serverUrl.trim();
    if (!url) {
      serverError = '请输入服务器地址';
      return;
    }
    connecting = true;
    serverError = null;
    try {
      await connectServer(url, serverToken.trim() === '' ? null : serverToken.trim());
      serverUrl = '';
      serverToken = '';
      onconnected?.();
    } catch (err) {
      serverError = err instanceof Error ? err.message : String(err);
    } finally {
      connecting = false;
    }
  }
</script>

<form class="vv-server-form" onsubmit={connect}>
  <input
    placeholder="http://127.0.0.1:8321"
    bind:value={serverUrl}
    aria-label="服务器地址"
    spellcheck="false"
  />
  <input
    type="password"
    placeholder="访问令牌（可空）"
    bind:value={serverToken}
    aria-label="访问令牌"
  />
  <button type="submit" disabled={connecting}>{connecting ? '连接中…' : '连接'}</button>
  {#if serverError}
    <span class="vv-server-error" role="alert">{serverError}</span>
  {/if}
</form>
