// uiChromeFixes.test.ts — 2026-10-23 用户反馈两处 UI 缺陷的回归锚（源码/CSS 契约）：
// ① 右栏折叠钮原定位左上角（left:6px）压住 MetaPanel 首行「属性」标题——双栏统一
//    右上角（VS Code 侧栏动作位惯例，右上角是标题行右侧空白）。2026-11-14 spec A
//    §4.3 折叠钮固定重排后锚升级：absolute 浮置退役（浮置于滚动容器内随列表滚动，
//    正是折叠按钮固定诉求的根因），钮入流落 aside 固定 header 行右端——「右上角、
//    不压标题」由 DOM 序（切换器先、折叠钮后）+ margin-left:auto 流内右锚承接；
// ② tab 名无宽度约束，长文件名单 tab 撑满整个标签栏——max-width + ellipsis 截断，
//    全名走 title（成熟编辑器惯例）。
// 根 vitest 无 svelte 插件，组件不可挂载——按既有「源码契约断言」先例锁定。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

describe('面板折叠钮定位（缺陷①：不再压住「属性」标题）', () => {
  const css = readSrc('src/app.css');
  const appshell = readSrc('src/lib/AppShell.svelte');

  it('折叠钮入流（spec A §4.3 固定 header 行）——不浮置滚动容器，流内右端锚定', () => {
    // absolute 浮置退役（随列表滚动的根因形态不得残留）
    expect(css).not.toMatch(/\.vv-collapse-btn \{[^}]*position:\s*absolute/);
    // 入流右端锚定：margin-left:auto 推至 header 行右端（上下 6px 即原 top/right:6
    // 锚点的入流等距）；切换器 flex:1 占满余宽时 auto 归零、钮自然落右端
    expect(css).toMatch(/\.vv-collapse-btn \{[^}]*margin: 6px 6px 6px auto/);
    // 旧左上角定位不得残留（折叠钮压 MetaPanel「属性」标题的原缺陷形态）
    expect(css).not.toMatch(/\.vv-collapse-right \{ left: 6px/);
  });

  it('右栏 header 行内切换器在折叠钮之前（DOM 序=视觉序，折叠钮不压标题行）', () => {
    expect(appshell).toMatch(/vv-right-head[\s\S]*?vv-right-switch[\s\S]*?vv-collapse-right/);
  });
});

describe('tab 名超长截断（缺陷②：单 tab 不撑满标签栏）', () => {
  const css = readSrc('src/app.css');
  const tabbar = readSrc('src/lib/TabBar.svelte');

  it('.vv-tab-name 有定宽上限 + ellipsis（成熟编辑器惯例），全名走 title', () => {
    const rule = css.match(/\.vv-tab-name \{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const body = rule![1] ?? '';
    expect(body).toMatch(/max-width: \d+px/);
    expect(body).toContain('overflow: hidden');
    expect(body).toContain('text-overflow: ellipsis');
    expect(body).toContain('white-space: nowrap');
    // 截断后 hover 可见全名（与来源徽标 .vv-tab-src 的 title 惯例同款）
    expect(tabbar).toContain('<span class="vv-tab-name" title={tab.source.name}>');
  });
});
