<!-- lint 自检样例（合法代码，零报错——防误伤回归，Task 10 评审 M-2）：style 块内的
     中文 CSS 注释是开发者面注释（与 // /* */ 同口径，非用户可见文案）——
     cjkSvelteText 选择器以 :not(SvelteStyleElement SvelteText) 排除，缺此排除即本
     样例整块误报。经 lint-config.test.ts 以 --stdin（lib 路径形态）驱动断言零报错。
     注意：本注释勿以 eslint 指令形态开头（会被当成行内配置解析）。 -->
<script lang="ts">
  let { label }: { label: string } = $props(); // runes 形态（export let 即 valid-compile 必命中样例语义）
</script>

<div class="clean-marker">{label}</div>

<style>
  /* 中文样式注释——合法：开发者面注释，:not 排除面的直接验证对象 */
  .clean-marker {
    color: inherit;
  }
</style>
