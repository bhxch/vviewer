// app-html.test.ts — app.html 模板占位符契约（源码契约断言先例同款，无 Svelte
// 插件不涉挂载）。根 vitest 环境 import.meta.url 非 file 协议，按既有
// appShellFontScroll.test.ts 的 readSrc cwd 双候选解析读模板源文件。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * app.html 模板占位符契约（%sveltekit.head% 页面顶部泄漏的回归守卫）：
 *
 * kit 生成运行时模板时对 head/body 占位符用 String.replace **字符串模式**——
 * 仅替换全模板**首次出现**（@sveltejs/kit src/core/sync/write_server.js 的
 * templates.app 生成；%sveltekit.assets% 等其余占位符才是 /g 全局正则）。
 * 因此 app.html 的注释等任何位置若再出现 head/body 占位符字面量且排在真
 * 占位符之前，真占位符即漏替换：泄漏文本位于 head 内，浏览器解析器在
 * "in head" 模式遇非空白字符数据会隐式闭 head 开 body——渲染为页面顶部
 * 可见文本；同时 kit 注入的壳 stylesheet（真 head 内容）整体落进 HTML 注释
 * 被吞（首帧无样式）。49bc813 在 axe 标题注释中提及占位符字面量即中招。
 *
 * kit 的 load_template 校验只查存在性（indexOf === -1）不查唯一性，构建期
 * 不报错——唯一性契约只能靠本测试执法。改动 app.html 后必须保持：
 * head/body 占位符字面量各恰好出现一次，且不出现在任何 HTML 注释内。
 */
function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

describe('app.html 占位符契约', () => {
  const template = readSrc('src/app.html');
  // 剥离 HTML 注释后的模板：注释内的占位符字面量不参与 kit 替换语义
  const sansComments = template.replace(/<!--[\s\S]*?-->/g, '');
  const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

  it('head/body 占位符全模板各恰好一次（kit 字符串 replace 仅首次出现）', () => {
    expect(count(template, '%sveltekit.head%')).toBe(1);
    expect(count(template, '%sveltekit.body%')).toBe(1);
  });

  it('head/body 占位符不得出现在 HTML 注释内（注释内出现即注入目标漂移）', () => {
    expect(count(sansComments, '%sveltekit.head%')).toBe(1);
    expect(count(sansComments, '%sveltekit.body%')).toBe(1);
  });
});
