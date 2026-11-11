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

## 前端规范入口

涉及以下触发词的任务，先加载对应文档再动手（全文加载，不凭记忆转述条款）：

| 触发词 | 文档 |
|---|---|
| 改 / 加 UI 文案（含 `aria-label` 等无障碍文案）、i18n / 目录键、日期数字格式化 | `docs/design/frontend-conventions.md`（§3 i18n 纪律） |
| 新增 / 修改交互组件、浮层、菜单、确认与提示通道 | `docs/design/semantic-components.md`（先 grep 复用清单，新增条目先登记后使用） |
| 无障碍 / a11y / 对比度 / 减少动效 | `docs/design/frontend-conventions.md`（§4 a11y 基线 + §6 评审必查清单） |
| ESLint / lint 规则、样式与 z-index、设计 token | 两份文档 + 设计系统 `docs/design/ui-design-system.md`；设计决策记录（含执行期订正）见 `docs/superpowers/specs/2026-11-11-frontend-conventions-design.md` |

条款正文只载于上述文档（单源防漂移），本节只做指针，不复制规则。
