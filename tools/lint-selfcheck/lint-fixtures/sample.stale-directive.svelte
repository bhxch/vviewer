<!-- lint 自检样例（必命中）：模板里一条失效的豁免指令——它要豁免的规则在下一行并不会报。
     ESLint 核心的 reportUnusedDisableDirectives 只管 JS 注释指令；.svelte 模板里的 HTML 注释
     指令归 svelte 插件的 svelte/comment-directive 上报（其同名选项默认关，须在
     eslint.config.js 里显式打开）。
     本目录已入 eslint.config.js 的全局 ignores，常规 lint 不扫，仅
     tools/lint-selfcheck/test/lint-config.test.ts 以 --no-ignore 显式驱动。
     注意：本注释勿以 eslint 指令形态开头（会被当成行内配置解析）。 -->
<script lang="ts">
  const label = 'ok';
</script>

<!-- eslint-disable-next-line svelte/require-each-key -- 失效指令：下一行没有 each 块，该规则不会在此报 -->
<p>{label}</p>
