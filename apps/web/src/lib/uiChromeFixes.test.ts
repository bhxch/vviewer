// uiChromeFixes.test.ts — 2026-10-23 用户反馈两处 UI 缺陷的回归锚（源码/CSS 契约）：
// ① 右栏折叠钮原定位左上角（left:6px）压住 MetaPanel 首行「属性」标题——双栏统一
//    右上角（VS Code 侧栏动作位惯例，右上角是标题行右侧空白）；
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

  it('双栏折叠钮统一右上角（right: 6px）——右栏左上角让位给 MetaPanel 标题', () => {
    expect(css).toMatch(/\.vv-collapse-left, \.vv-collapse-right \{ right: 6px; \}/);
    // 旧定位不得残留（折叠钮均为 absolute top:6px 锚点，left:6px 即重叠形态）
    expect(css).not.toMatch(/\.vv-collapse-right \{ left: 6px/);
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
