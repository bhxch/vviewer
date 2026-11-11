/* lint 自检样例（合法代码，零报错——防误伤回归）：console 三放行（warn/error/debug）与
 * `_` 前缀的未用形参/变量都不该命中。
 * 本目录已入 eslint.config.js 的全局 ignores，常规 lint 不扫，仅
 * tools/lint-selfcheck/test/lint-config.test.ts 以 --no-ignore 显式驱动。
 * 注意：本注释勿以 eslint 指令形态开头（会被当成文件级配置解析）。 */

export function report(message: string, _reserved?: unknown): void {
  const _unusedPlaceholder = message.length;
  console.warn(message);
  console.error(message);
  console.debug(message);
}

// —— i18n 三纪律合法面增补（Task 10）：以下形态在 lib 子集规则块下也不得命中
// （lint-config.test.ts 以 --stdin（lib 路径形态）驱动本文件断言零报错）——
// \u 转义正则与数据值串（raw 形态无 CJK 字符，D8 审计数据值裁决）、i18n 门面
// 导入与 t() 调用（非直读 catalogs）。
import { t } from './i18n/index.svelte'; // i18n 门面导入（对照：直读 catalogs 才拦）

export const ESCAPE_RE = /[\u4e00-\u9fff]+/g; // \u 转义正则：合法
export const FAMILY_NAME = '\u5fae\u8f6f\u96c5\u9ed1'; // \u 转义数据值串（family 名）：合法
export const TPL_ESCAPED = `pre \u4e2d\u6587 post`; // 模板串静态段 \u 转义：合法（TemplateElement value.raw 豁免面；装饰词用 ASCII——样例行自身不得含字面 CJK）

export function translated(): string {
  return t('shell.empty.title'); // 门面 t() 调用：合法
}
