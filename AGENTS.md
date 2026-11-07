# vviewer 项目规则

## Svelte 编译器：全局强制 runes 模式

- kit 3 的 SvelteKit 配置不再读 `svelte.config.js`，全部经 `apps/web/vite.config.ts` 中
  `sveltekit()` 插件参数传入。全局 `runes: true` 在该处
  `compilerOptions: { runes: true }` 强制开启（2026-11-07 起），任何位置不得关闭或用
  `<!-- svelte-ignore -->` 绕过。
- 新增/修改 `.svelte` 与 `.svelte.ts` 代码一律 runes 写法（`$state`/`$derived`/`$props`/
  `$effect` 等），禁止 legacy 语法（`export let`、`$:` 响应式语句、`$:` 前缀等）。
  编译器按硬规则执法，legacy 语法会直接编译报错。
- 需要无 runes 的纯 `.ts` 模块（vitest 直测）保持 `.ts` 后缀并避免 runes 语法；
  runes 状态模块用 `.svelte.ts` 后缀。
