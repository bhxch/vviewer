<!-- lint 自检样例（必命中）：legacy 写法的组件（export let + $: 响应式语句）。全局强制 runes
     模式下这是编译错误，经 svelte/valid-compile 报为 lint error——lint 期即拦，不必等到构建。
     本目录已入 eslint.config.js 的全局 ignores，常规 lint 不扫，仅
     tools/lint-selfcheck/test/lint-config.test.ts 以 --no-ignore 显式驱动。
     注意：本注释勿以 eslint 指令形态开头（会被当成行内配置解析）。 -->
<script lang="ts">
  export let count = 0;
  $: doubled = count * 2;
</script>

<p>{doubled}</p>
