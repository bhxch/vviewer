// foreign-budget.test.ts — foreign 预算门禁产物断言的单测（临时夹具目录，不依赖真实 build）。
// 三锚：主 chunk 混入检出、precache 混入检出、合规通过；附 build 缺失 fatal 与
// file-viewer 资产目录检出两个边界。测试目录落 tools/foreign-budget/test/
//（vitest include 为 tools/*/test/**，与 check-foreign-deps 先例一致；简报字面
// tools/test/ 不被 include 匹配会漏跑，故沿用先例），校验器本体按简报平铺
// tools/foreign-budget.mjs。
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanForeignBudget } from '../../foreign-budget.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'foreign-budget-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function fixture(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 干净 sw.js（workbox generateSW 压缩输出形态：url:"…" 键不带引号）
const CLEAN_SW = 'define:[{url:"index.html",revision:"1"},{url:"_app/immutable/chunks/entry-abc.js",revision:"2"}]';

describe('scanForeignBudget', () => {
  it('build 目录缺失返回 fatal（提示先构建，不是 pass）', () => {
    const { fatal, violations } = scanForeignBudget(join(tmp, 'no-such-build'));
    expect(fatal).toContain('先 pnpm --filter web build');
    expect(violations).toBeUndefined();
  });

  it('锚一：主 chunk 混入 @file-viewer import 检出（entry 与普通 chunk 同面）', () => {
    const dir = fixture('main-chunk');
    writeFileSync(join(dir, 'entry-abc.js'), 'import{v}from"@file-viewer/core";export default v');
    writeFileSync(join(dir, 'chunk-def.js'), 'import("@file-viewer/renderer-email").then(m=>m.render())');
    writeFileSync(join(dir, 'sw.js'), CLEAN_SW);
    const { violations } = scanForeignBudget(dir);
    expect(violations).toHaveLength(2);
    expect(violations).toContainEqual(expect.objectContaining({ kind: 'chunk-import', file: 'entry-abc.js' }));
    expect(violations).toContainEqual(expect.objectContaining({ kind: 'chunk-import', file: 'chunk-def.js' }));
  });

  it('锚一负例：foreign-*.js 组 chunk 与 workbox/sw 的 urlPattern 字符串不违规', () => {
    const dir = fixture('foreign-allowed');
    mkdirSync(join(dir, 'chunks'), { recursive: true });
    // foreign 组 chunk 打包 @file-viewer 代码面：允许存在于 dist（仅断言「非主 chunk」）
    writeFileSync(join(dir, 'chunks', 'foreign-core-abc.js'), 'import{v}from"@file-viewer/core";export default v');
    // sw.js 的 vv-foreign-assets urlPattern 含 @file-viewer CDN 前缀（运行时缓存策略，非代码 import）
    writeFileSync(
      join(dir, 'sw.js'),
      'registerRoute(/^https:\\/\\/cdn\\.jsdelivr\\.net\\/npm\\/@file-viewer\\/assets-/,new e.CacheFirst({cacheName:"vv-foreign-assets-0.1.0-x"}));' + CLEAN_SW
    );
    writeFileSync(join(dir, 'workbox-835c8c05.js'), 'console.log("workbox runtime")');
    const { violations } = scanForeignBudget(dir);
    expect(violations).toEqual([]);
  });

  it('锚二：precache 清单混入 foreign-*.js 或 @file-viewer CDN URL 检出', () => {
    const dir = fixture('precache');
    writeFileSync(
      join(dir, 'sw.js'),
      'define:[{url:"index.html",revision:"1"},{url:"_app/immutable/chunks/foreign-core-abc.js",revision:"2"},{url:"https://cdn.jsdelivr.net/npm/@file-viewer/assets-standard@3.3.3/viewer/app.js",revision:"3"}]'
    );
    const { violations } = scanForeignBudget(dir);
    expect(violations).toEqual([
      expect.objectContaining({ kind: 'precache-foreign', url: '_app/immutable/chunks/foreign-core-abc.js' }),
      expect.objectContaining({ kind: 'precache-cdn', url: 'https://cdn.jsdelivr.net/npm/@file-viewer/assets-standard@3.3.3/viewer/app.js' })
    ]);
  });

  it('锚三：合规产物通过（foreign 组 chunk 存在 + 干净主 chunk + 干净 precache）', () => {
    const dir = fixture('clean');
    mkdirSync(join(dir, 'chunks'), { recursive: true });
    writeFileSync(join(dir, 'chunks', 'entry-abc.js'), 'import{b}from"./other";export default b');
    writeFileSync(join(dir, 'chunks', 'foreign-email-def.js'), 'import{r}from"@file-viewer/renderer-email"');
    writeFileSync(join(dir, 'sw.js'), CLEAN_SW);
    const { violations } = scanForeignBudget(dir);
    expect(violations).toEqual([]);
  });

  it('边界：dist 出现 file-viewer 资产目录检出', () => {
    const dir = fixture('assets-dir');
    mkdirSync(join(dir, 'file-viewer'), { recursive: true });
    writeFileSync(join(dir, 'file-viewer', 'font.woff2'), 'x');
    writeFileSync(join(dir, 'sw.js'), CLEAN_SW);
    const { violations } = scanForeignBudget(dir);
    expect(violations).toEqual([expect.objectContaining({ kind: 'assets-dir' })]);
  });
});
