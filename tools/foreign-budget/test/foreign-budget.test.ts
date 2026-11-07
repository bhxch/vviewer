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
import { foreignDepsOf, scanForeignBudget } from '../../foreign-budget.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'foreign-budget-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function fixture(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 干净 sw.js（workbox generateSW 压缩输出形态：url:"…" 键不带引号）。清单只含
// index.html（断言⑤对非 .js 条目不追产物）：各夹具按需自写 .js 清单，避免
// CLEAN_SW 泛用条目与「在册产物必须在盘」的 fail-closed 面互相绊线
const CLEAN_SW = 'define:[{url:"index.html",revision:"1"}]';

describe('scanForeignBudget', () => {
  it('build 目录缺失返回 fatal（提示先构建，不是 pass）', () => {
    const { fatal, violations } = scanForeignBudget(join(tmp, 'no-such-build'), []);
    expect(fatal).toContain('先 pnpm --filter web build');
    expect(violations).toBeUndefined();
  });

  it('锚一：主 chunk 混入 @file-viewer import 检出（entry 与普通 chunk 同面）', () => {
    const dir = fixture('main-chunk');
    writeFileSync(join(dir, 'entry-abc.js'), 'import{v}from"@file-viewer/core";export default v');
    writeFileSync(join(dir, 'chunk-def.js'), 'import("@file-viewer/renderer-email").then(m=>m.render())');
    mkdirSync(join(dir, 'chunks'), { recursive: true });
    writeFileSync(join(dir, 'chunks', 'foreign-core-abc.js'), 'import{v}from"@file-viewer/core"');
    writeFileSync(join(dir, 'sw.js'), CLEAN_SW);
    const { violations } = scanForeignBudget(dir, ['@file-viewer/core', '@file-viewer/renderer-email']);
    expect(violations).toHaveLength(2);
    expect(violations).toContainEqual(expect.objectContaining({ kind: 'chunk-import', file: 'entry-abc.js' }));
    expect(violations).toContainEqual(expect.objectContaining({ kind: 'chunk-import', file: 'chunk-def.js' }));
  });

  it('M1：非压缩形态 marker 检出（带空格 from 与 side-effect import）', () => {
    const dir = fixture('unminified-markers');
    mkdirSync(join(dir, 'chunks'), { recursive: true });
    writeFileSync(join(dir, 'chunks', 'a.js'), 'import {v} from "@file-viewer/core";export default v');
    writeFileSync(join(dir, 'chunks', 'b.js'), 'import"@file-viewer/renderer-email";');
    writeFileSync(join(dir, 'chunks', 'foreign-core-abc.js'), 'import{v}from"@file-viewer/core"');
    writeFileSync(join(dir, 'sw.js'), CLEAN_SW);
    const { violations } = scanForeignBudget(dir, ['@file-viewer/core']);
    expect(violations).toHaveLength(2);
    expect(violations).toContainEqual(expect.objectContaining({ kind: 'chunk-import', file: 'chunks/a.js' }));
    expect(violations).toContainEqual(expect.objectContaining({ kind: 'chunk-import', file: 'chunks/b.js' }));
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
    const { violations } = scanForeignBudget(dir, []);
    expect(violations).toEqual([]);
  });

  it('锚二：precache 清单混入 foreign-*.js 或 @file-viewer CDN URL 检出', () => {
    const dir = fixture('precache');
    writeFileSync(
      join(dir, 'sw.js'),
      'define:[{url:"index.html",revision:"1"},{url:"_app/immutable/chunks/foreign-core-abc.js",revision:"2"},{url:"https://cdn.jsdelivr.net/npm/@file-viewer/assets-standard@3.3.3/viewer/app.js",revision:"3"}]'
    );
    mkdirSync(join(dir, '_app/immutable/chunks'), { recursive: true });
    // 在册产物须在盘（断言⑤ fail-closed 面），内容 bare specifier 不入闭包解析
    writeFileSync(join(dir, '_app/immutable/chunks', 'foreign-core-abc.js'), 'import{v}from"@file-viewer/core"');
    const { violations } = scanForeignBudget(dir, ['@file-viewer/core']);
    expect(violations).toEqual([
      expect.objectContaining({ kind: 'precache-foreign', url: '_app/immutable/chunks/foreign-core-abc.js' }),
      expect.objectContaining({ kind: 'precache-cdn', url: 'https://cdn.jsdelivr.net/npm/@file-viewer/assets-standard@3.3.3/viewer/app.js' })
    ]);
  });

  it('终审 C1：precache 清单混入 foreign worker 匿名资产检出（assets/ 下 .worker 形态）', () => {
    const dir = fixture('precache-worker');
    writeFileSync(
      join(dir, 'sw.js'),
      'define:[{url:"_app/immutable/assets/pptjs.worker.BxR0ofQt.js",revision:"1"},{url:"_app/immutable/assets/pptx.worker.CpTu_kXy.js",revision:"2"}]'
    );
    // 在册产物须在盘（断言⑤ fail-closed 面）：空体 chunk 即可，本锚只断言 ②
    mkdirSync(join(dir, '_app/immutable/assets'), { recursive: true });
    writeFileSync(join(dir, '_app/immutable/assets', 'pptjs.worker.BxR0ofQt.js'), '');
    writeFileSync(join(dir, '_app/immutable/assets', 'pptx.worker.CpTu_kXy.js'), '');
    const { violations } = scanForeignBudget(dir, []);
    expect(violations).toEqual([
      expect.objectContaining({ kind: 'precache-worker', url: '_app/immutable/assets/pptjs.worker.BxR0ofQt.js' }),
      expect.objectContaining({ kind: 'precache-worker', url: '_app/immutable/assets/pptx.worker.CpTu_kXy.js' })
    ]);
  });

  it('终审 C1 负例：vviewer 自有 worker（workers/ 目录、无 .worker 名段）不误报', () => {
    const dir = fixture('own-workers');
    writeFileSync(
      join(dir, 'sw.js'),
      'define:[{url:"_app/immutable/workers/ts-worker-ZCbjXEqt.js",revision:"1"},{url:"_app/immutable/workers/binary.worker-Crh1y-60.js",revision:"2"},{url:"_app/immutable/assets/worker-bundle.Dx5mKZOL.js",revision:"3"}]'
    );
    mkdirSync(join(dir, '_app/immutable/workers'), { recursive: true });
    mkdirSync(join(dir, '_app/immutable/assets'), { recursive: true });
    for (const f of ['ts-worker-ZCbjXEqt.js', 'binary.worker-Crh1y-60.js']) {
      writeFileSync(join(dir, '_app/immutable/workers', f), '');
    }
    writeFileSync(join(dir, '_app/immutable/assets', 'worker-bundle.Dx5mKZOL.js'), '');
    const { violations } = scanForeignBudget(dir, []);
    expect(violations).toEqual([]);
  });

  it('终审 I1 断言⑤：precache\u2019d chunk 静态 import 非缓存 chunk 检出（离线 docx 断链形态，三引号形态）', () => {
    const dir = fixture('precache-closure');
    writeFileSync(
      join(dir, 'sw.js'),
      'define:[{url:"_app/immutable/chunks/a.js",revision:"1"},{url:"_app/immutable/chunks/b.js",revision:"2"}]'
    );
    mkdirSync(join(dir, '_app/immutable/chunks'), { recursive: true });
    // a.js：静态边指向在册 b.js（合规）+ 三引号形态指向不在册目标（检出）；
    // missing 目标不落盘（与「组 chunk 被 globIgnores 排除 precache」同态）
    writeFileSync(
      join(dir, '_app/immutable/chunks/a.js'),
      'import{q}from"./b.js";import{r}from"./missing1.js";import { s } from \'./missing2.js\';export*from`./missing3.js`;'
    );
    writeFileSync(join(dir, '_app/immutable/chunks/b.js'), 'export const q=1');
    const { violations } = scanForeignBudget(dir, []);
    expect(violations).toEqual([
      expect.objectContaining({ kind: 'precache-closure', file: '_app/immutable/chunks/a.js', target: '_app/immutable/chunks/missing1.js' }),
      expect.objectContaining({ kind: 'precache-closure', file: '_app/immutable/chunks/a.js', target: '_app/immutable/chunks/missing2.js' }),
      expect.objectContaining({ kind: 'precache-closure', file: '_app/immutable/chunks/a.js', target: '_app/immutable/chunks/missing3.js' })
    ]);
  });

  it('终审 I1 断言⑤合规：动态 import 排除 chunk 属设计内、bare/外部引用不追，闭包完整即通过', () => {
    const dir = fixture('precache-closure-clean');
    writeFileSync(
      join(dir, 'sw.js'),
      'define:[{url:"_app/immutable/entry.js",revision:"1"},{url:"_app/immutable/chunks/a.js",revision:"2"},{url:"_app/immutable/chunks/b.js",revision:"3"}]'
    );
    mkdirSync(join(dir, '_app/immutable/chunks'), { recursive: true });
    writeFileSync(
      join(dir, '_app/immutable/entry.js'),
      'import{q}from"./chunks/b.js";import("./lazy-engine.js").then(m=>m.run())'
    );
    writeFileSync(
      join(dir, '_app/immutable/chunks/a.js'),
      'import{q}from"./b.js";import x from "isomorphic-git";const u="https://cdn.example.com/x.js";new URL(u,import.meta.url)'
    );
    writeFileSync(join(dir, '_app/immutable/chunks/b.js'), 'export const q=1');
    const { violations } = scanForeignBudget(dir, []);
    expect(violations).toEqual([]);
  });

  it('终审 I1 断言⑤：precache 在册产物缺失 fail-closed（不因读不到而静默放行）', () => {
    const dir = fixture('precache-missing-file');
    writeFileSync(
      join(dir, 'sw.js'),
      'define:[{url:"_app/immutable/chunks/ghost.js",revision:"1"}]'
    );
    const { violations } = scanForeignBudget(dir, []);
    expect(violations).toEqual([
      expect.objectContaining({ kind: 'precache-missing-file', url: '_app/immutable/chunks/ghost.js' })
    ]);
  });

  it('终审 I1 断言⑤：sw.js 存在但清单零条目 fail-closed（清单解析失败不按空闭包放行）', () => {
    const dir = fixture('precache-empty');
    writeFileSync(join(dir, 'sw.js'), 'define:[]');
    const { violations } = scanForeignBudget(dir, []);
    expect(violations).toEqual([expect.objectContaining({ kind: 'precache-empty', file: 'sw.js' })]);
  });

  it('锚三：合规产物通过（声明依赖 + foreign 组 chunk 存在 + 干净主 chunk + 干净 precache）', () => {
    const dir = fixture('clean');
    mkdirSync(join(dir, 'chunks'), { recursive: true });
    writeFileSync(join(dir, 'chunks', 'entry-abc.js'), 'import{b}from"./other";export default b');
    writeFileSync(join(dir, 'chunks', 'foreign-email-def.js'), 'import{r}from"@file-viewer/renderer-email"');
    writeFileSync(join(dir, 'sw.js'), CLEAN_SW);
    const { violations } = scanForeignBudget(dir, ['@file-viewer/core', '@file-viewer/renderer-email']);
    expect(violations).toEqual([]);
  });

  it('I1 存在性：声明了 @file-viewer 依赖但产物无 foreign-*.js chunk 检出', () => {
    const dir = fixture('no-foreign-chunk');
    writeFileSync(join(dir, 'entry-abc.js'), 'import{b}from"./other";export default b');
    writeFileSync(join(dir, 'sw.js'), CLEAN_SW);
    const { violations } = scanForeignBudget(dir, ['@file-viewer/core']);
    expect(violations).toEqual([expect.objectContaining({ kind: 'no-foreign-chunk', deps: ['@file-viewer/core'] })]);
  });

  it('I1 存在性：零依赖（plan-3-not-applied）不触发存在性断言', () => {
    const dir = fixture('no-deps');
    writeFileSync(join(dir, 'entry-abc.js'), 'import{b}from"./other";export default b');
    writeFileSync(join(dir, 'sw.js'), CLEAN_SW);
    const { violations } = scanForeignBudget(dir, []);
    expect(violations).toEqual([]);
  });

  it('边界：dist 出现 file-viewer 资产目录检出', () => {
    const dir = fixture('assets-dir');
    mkdirSync(join(dir, 'file-viewer'), { recursive: true });
    writeFileSync(join(dir, 'file-viewer', 'font.woff2'), 'x');
    writeFileSync(join(dir, 'sw.js'), CLEAN_SW);
    const { violations } = scanForeignBudget(dir, []);
    expect(violations).toEqual([expect.objectContaining({ kind: 'assets-dir' })]);
  });
});

describe('foreignDepsOf', () => {
  it('取 dependencies + devDependencies 中 @file-viewer/* 前缀，其余忽略', () => {
    expect(
      foreignDepsOf({
        dependencies: { '@file-viewer/core': '3.3.3', buffer: '^6.0.3' },
        devDependencies: { '@file-viewer/renderer-email': '3.3.3', '@bhxch/vviewer-core': 'workspace:*' }
      })
    ).toEqual(['@file-viewer/core', '@file-viewer/renderer-email']);
  });
});
