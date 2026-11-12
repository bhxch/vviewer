import { test, expect } from '@playwright/test';

/**
 * 应用壳直出 HTML 契约（t- 前缀标记本轮新增；README §3.2：一域一文件、
 * 标题以场景编号开头、子场景加后缀）。与既有覆盖的分工（不重写既有文件）：
 * 既有 spec 全部从渲染后的交互面切入，`/` 直出 HTML 的模板替换面从未被
 * 断言过——本域补齐该缺口。
 *
 * - SHELL-HTML-01：kit 运行时模板对 head/body 占位符仅替换**首次出现**
 *   （write_server.js 字符串 replace；assets 等其余占位符才是全局正则），
 *   app.html 注释等位置若再出现占位符字面量即真占位符漏替换——残留文本在
 *   head 内被浏览器解析器隐式抬入 body，渲染为页面顶部可见文本；且 kit
 *   注入的壳 stylesheet（真 head 内容）整体落进 HTML 注释被吞（首帧无样式）。
 *   源码侧唯一性契约由 src/app-html.test.ts 执法，本场景对真实构建产物直出
 *   做端到端兜底（纯静态断言，chromium/mobile 双 project 同面覆盖）。
 */

test('SHELL-HTML-01: 应用壳直出零占位符泄漏，壳样式表未被注释吞掉', async ({ page }) => {
  await page.goto('/');

  // ① 用户可见面：body 渲染文本不得出现占位符字面量（泄漏即页面顶部可见文本）
  await expect(page.locator('body')).not.toContainText('%sveltekit');

  // ② 产物面：剥离 HTML 注释后的直出 DOM 必须仍含壳 stylesheet link——
  //    真 head 内容被整体吞进注释即无样式首帧（泄漏 bug 的第二损伤面）
  const html = await page.content();
  const sansComments = html.replace(/<!--[\s\S]*?-->/g, '');
  expect(sansComments).toMatch(/<link[^>]+rel="stylesheet"/);

  // ③ 源码面：head/body 占位符零残留（模板链断裂的同族信号，全族零容忍）
  expect(html).not.toContain('%sveltekit.head%');
  expect(html).not.toContain('%sveltekit.body%');
});
