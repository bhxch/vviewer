// app-env.ts — `$app/env` 的 vitest 桩（SvelteKit 虚拟模块）。
//
// 根 vitest 无 svelte 插件 → `$app/env` 不可求值；apps/web 中仅 highlightClient.ts 与
// viewer.ts 引用它（两者此前零直测面——本桩为其直测开面）。桩值取浏览器构建语义：
// browser=true（应用级单例的浏览器端闸门）、dev=true、building=false。
export const browser = true;
export const dev = true;
export const building = false;
export const version = 'test';
