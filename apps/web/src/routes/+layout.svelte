<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { registerSW } from 'virtual:pwa-register';

  let { children } = $props();

  // M7 PWA（Task 1）：SW 注册走 virtual:pwa-register 手动注入——SvelteKit 的
  // app.html 不经 vite transformIndexHtml，插件的自动注册不可依赖。
  // registerType autoUpdate（vite.config.ts）：新版本 SW skipWaiting+clientsClaim，
  // immediate 注册后由 workbox-window 在更新就绪时自动刷新页面。
  onMount(() => {
    registerSW({ immediate: true });
  });
</script>
{@render children()}
