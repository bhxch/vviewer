/* lint 自检样例（裸 Intl 双向探针）：同一内容以两个虚拟路径驱动——
 * lib 普通路径必命中（bareIntl 挂载验证）、i18n/format.ts 路径零报
 * （唯一豁免点验证）。驱动形态见 lint-config.test.ts（--stdin --stdin-filename）。
 * 注意：本注释勿以 eslint 指令形态开头（会被当成文件级配置解析）。 */

export const DATE_OPTS: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit' };

export function formatWithIntl(d: Date): string {
  return new Intl.DateTimeFormat('zh-CN', DATE_OPTS).format(d);
}
