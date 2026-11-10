<!-- lint 自检样例（必命中）：用 svelte:options 逐组件退出 runes 模式。该标记在编译器里优先于
     全局 compilerOptions.runes，样例本身以 legacy 模式编译通过——构建期拦不住，只能靠
     eslint.config.js 里针对它的 no-restricted-syntax 选择器（runesOptOut）机检。
     本目录已入 eslint.config.js 的全局 ignores，常规 lint 不扫，仅
     tools/lint-selfcheck/test/lint-config.test.ts 以 --no-ignore 显式驱动。
     注意：本注释勿以 eslint 指令形态开头（会被当成行内配置解析）。 -->
<svelte:options runes={false} />

<script lang="ts">
  export let count = 0;
</script>

<p>{count}</p>
