<!-- lint 自检样例（必命中）：带 onclick 的静态 div 既无 role 也无键盘处理——Svelte 编译器的
     a11y 警告经 svelte/valid-compile 报为 lint error（a11y 硬门槛载体）。
     本目录已入 eslint.config.js 的全局 ignores，常规 lint 不扫，仅
     tools/lint-selfcheck/test/lint-config.test.ts 以 --no-ignore 显式驱动。
     注意：本注释勿以 eslint 指令形态开头（会被当成行内配置解析）。 -->
<script lang="ts">
  let count = $state(0);
</script>

<div onclick={() => (count += 1)}>{count}</div>
