/* lint 自检样例（必命中，i18n 三纪律 + 双向化遗留）：CJK 字面量 / 模板静态段 /
 * 裸 toLocale* / 直读 catalogs / console.log / 未用实参各一处必命中。
 * 本目录已入 eslint.config.js 的全局 ignores，常规 lint 不扫；且 i18n 三规则的
 * 挂载块只作用 apps/web/src/lib 子集——lint-config.test.ts 以 --stdin
 * --stdin-filename（lib 路径形态）驱动本样例（块挂载与内容命中同时被验）。
 * 注意：本注释勿以 eslint 指令形态开头（会被当成文件级配置解析）。 */

import { messages as zh } from './i18n/catalogs/zh-CN'; // 直读 catalogs 必命中
import { t } from './i18n/index.svelte'; // 门面导入：合法对照（不命中）

export const BAD = '中文字面量'; // CJK 字面量必命中
export const TPL = `模板静态段中文`; // CJK TemplateElement 必命中

export function fmt(d: Date): string {
  return d.toLocaleDateString(); // 裸 toLocale* 必命中
}

export function logIt(): void {
  console.log('log only'); // console.log 必命中（no-console 放行 warn/error/debug）
}

export function unusedParam(needed: number, spare: number): number {
  return needed; // spare 未用实参必命中（@typescript-eslint/no-unused-vars）
}

void zh;
void t;
