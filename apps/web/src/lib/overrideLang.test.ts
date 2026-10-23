// overrideLang.test.ts — renderer-lang-override Task 3：Tab.overrideLang 状态与持久化链
// （spec §4.1）。openFlow.svelte.ts 为 runes 模块，根 vitest 无 svelte 插件不可编译
// （watchHealth.test.ts 同因同形态）：setHighlightLang/snapshot/duplicate/restore 的
// 行为直测不可达，按既有「源码契约断言」先例钉住触点与 setter 语义；运行期行为由
// Task 6/8 的 UI 接线与 e2e 收口。持久层（stores/session.ts）为纯 TS 模块，快照回环
// 以 fake-indexeddb 行为直测（session.test.ts 同款装置）。
//
// 契约面（与 overrideRenderer 持久化链完全同形态，触点经 rg 找齐防漏面）：
// ① session.ts TabSnapshot.overrideLang 字段声明（overrideRenderer 旁）；
// ② openFlow.svelte.ts Tab 声明 + snapshot 仅置位写入（条件 spread，缺省不产字段）；
// ③ duplicate 读回（复制继承）+ reopenClosed 读回（撤销重建）+ AppShell restore 读回
//    （页面重载恢复链，AppShell 的 overrideRenderer C 项读回同位）；
// ④ setHighlightLang：未变化早退 / null 清除（delete）/ rev 自增 / persist
//    （setRendererOverride 同款顺序）。
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { loadSession, saveTabs } from './stores/session';

// vitest 会转译 import.meta.url（watchHealth.test.ts 同款双 cwd 兼容根/apps/web）
function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

/** 函数体窗口：自签名行至首个行首 `}`（内层块均有缩进，watchHealth.test.ts 同款）。 */
function fnWindow(src: string, signature: RegExp): string {
  const fn = src.match(signature);
  expect(fn, `函数窗口未命中：${signature}`).not.toBeNull();
  return fn![0];
}

describe('overrideLang 快照持久层（session.ts 行为直测）', () => {
  it('快照含 overrideLang（仅置位写入形态），保存/读回不变', async () => {
    const tabs = [{
      id: 't1', storeId: 's1', storeLabel: 'x', path: 'a.py', name: 'a.py',
      kind: 'restorable' as const, scrollTop: 0, active: true, overrideLang: 'python'
    }];
    await saveTabs(tabs);
    const { tabs: loaded } = await loadSession();
    expect(loaded[0]?.overrideLang).toBe('python');
  });

  it('旧快照无 overrideLang 字段读回 undefined（天然兼容，无需迁移）', async () => {
    const legacy = [{
      id: 't2', storeId: 's1', storeLabel: 'x', path: 'a.py', name: 'a.py',
      kind: 'restorable' as const, scrollTop: 0, active: true
    }];
    await saveTabs(legacy);
    const { tabs: loaded } = await loadSession();
    expect(loaded[0]?.overrideLang).toBeUndefined();
  });
});

describe('openFlow.svelte.ts 触点契约（runes 模块源码锚）', () => {
  const src = readSrc('src/lib/openFlow.svelte.ts');

  it('Tab 声明含 overrideLang（overrideRenderer 同位）', () => {
    const tabDecl = fnWindow(src, /export interface Tab \{[\s\S]*?\n\}/);
    expect(tabDecl).toContain('overrideLang?: string;');
  });

  it('session.ts TabSnapshot 声明 overrideLang（持久层类型锚）', () => {
    const session = readSrc('src/lib/stores/session.ts');
    expect(session).toContain('overrideLang?: string;');
  });

  it('snapshot 仅置位写入（条件 spread，缺省不产字段——pinned/overrideRenderer 同款）', () => {
    const fn = fnWindow(src, /function snapshot\(t: Tab\): TabSnapshot \{[\s\S]*?\n\}/);
    expect(fn).toContain('...(t.overrideLang !== undefined ? { overrideLang: t.overrideLang } : {})');
  });

  it('duplicate 读回（复制继承，overrideRenderer 同形态）', () => {
    const fn = fnWindow(src, /duplicate\(tabId: string\): Tab \| null \{[\s\S]*?\n  \}/);
    expect(fn).toContain('if (src.overrideLang !== undefined) tab.overrideLang = src.overrideLang;');
  });

  it('reopenClosed（撤销重建）读回（快照 → 新 tab，overrideRenderer 同形态）', () => {
    const fn = fnWindow(src, /reopenClosed\(\): Tab \| null \{[\s\S]*?\n  \}/);
    expect(fn).toContain('if (snap.overrideLang !== undefined) tab.overrideLang = snap.overrideLang;');
  });

  it('setHighlightLang 语义：未变化早退 → null 清除（delete）/置位 → rev++ → persist（setRendererOverride 同款顺序）', () => {
    const fn = fnWindow(src, /setHighlightLang\(tabId: string, lang: string \| null\): void \{[\s\S]*?\n  \}/);
    const earlyReturn = fn.indexOf('if (unchanged) return;');
    const clear = fn.indexOf('delete tab.overrideLang;');
    const assign = fn.indexOf('tab.overrideLang = lang;');
    const rev = fn.indexOf('tab.rev = (tab.rev ?? 0) + 1;');
    const persist = fn.indexOf('void persist()');
    expect(earlyReturn).toBeGreaterThan(-1); // 重复手选/重复清除不 rev++、不落盘
    expect(clear).toBeGreaterThan(-1); // null 清除 = delete（快照仅置位写入的前提）
    expect(assign).toBeGreaterThan(-1);
    expect(rev).toBeGreaterThan(assign); // rev 在写后自增（ViewerPane 渲染 effect 重跑通道）
    expect(persist).toBeGreaterThan(rev); // persist 最后（写 + rev 均落定后）
  });
});

describe('AppShell.svelte 恢复读回契约（页面重载 restore 链）', () => {
  it('restore 逐 tab 循环读回 overrideLang（overrideRenderer C 项读回同位）', () => {
    const shell = readSrc('src/lib/AppShell.svelte');
    expect(shell).toContain('if (t.overrideLang !== undefined) tab.overrideLang = t.overrideLang;');
  });
});
