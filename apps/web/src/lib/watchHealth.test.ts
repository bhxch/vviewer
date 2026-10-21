// watchHealth.test.ts — SSE 变更推送健康旗标的复位方向契约（台账 3-2，终审 I-1
// 修复的测试面收尾）。watchHealth 是 openFlow.svelte.ts 的模块级 runes $state
// （全局单旗标），根 vitest 无 svelte 插件不可挂载 runes 模块/组件——行为直测
// 不可达，按既有「源码契约断言」先例（directMountFlow.test.ts 同因同形态）锁定
// 三处 remote 创建链写点与顺序；运行期行为由 e2e 收口。
//
// 复位方向契约（诚实定性：本文件为源码锚非行为用例，裁决见 task-5-report）：
// - watchHealth 为全局单旗标，「源 B 的 degraded」不存在独立通道；per-source 面
//   由 ViewerPane 按 isMountRootStoreId 派生（挂载来源显示「此源不支持变更推送」，
//   与全局降级指示按 tab 互斥）。全局旗标的复位方向 = 复位只发生在「新建 store
//   实例」时序（createRemoteStore 之后、store.watch 接线之前）——新连接的降级
//   指示不复用上一次连接的；存活实例复用路径早退不触旗标（各函数仅单一复位点）。
// - direct 创建链不入全局通道：createDirectMountStore 立即 onError 只走 console
//   诊断、创建期亦不复位（否则会抹掉 remote 的真实降级指示）——防线锚
//   directMountFlow.test.ts「watch 接线（终审 I-1）」用例，本文件作跨文件桥锚。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// vitest 会转译 import.meta.url（metaStore.test 同款处理）：双 cwd 兼容根/apps/web
function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

/** 函数体窗口：自签名行至首个行首 `}`（内层块均有缩进，directMountFlow.test.ts 同款）。 */
function fnWindow(src: string, signature: RegExp): string {
  const fn = src.match(signature);
  expect(fn, `函数窗口未命中：${signature}`).not.toBeNull();
  return fn![0];
}

/**
 * 复位方向断言（remote 创建链三处共用）：createRemoteStore → 复位 degraded=false
 * → store.watch 接线 → onError 置 degraded=true；置位写点全函数唯一（只经
 * onError 回调，不散落）。顺序即方向：复位在创建期（新连接不复用旧降级），
 * 置位在推送故障期。
 */
function expectResetDirection(fn: string): void {
  const create = fn.indexOf('createRemoteStore(');
  const reset = fn.indexOf('watchHealth.degraded = false;');
  const wiring = fn.indexOf('store.watch(');
  const setDegraded = fn.indexOf('watchHealth.degraded = true;');
  expect(create).toBeGreaterThan(-1);
  expect(reset).toBeGreaterThan(-1); // 复位写点在位（缺失时顺序断言会假绿，先钉存在性）
  expect(wiring).toBeGreaterThan(-1);
  expect(reset).toBeGreaterThan(create); // 复位在新建实例之后（复用早退路径不触旗标）
  expect(wiring).toBeGreaterThan(reset); // 复位先于 watch 接线（创建期，非错误后补）
  expect(setDegraded).toBeGreaterThan(wiring); // 置位只在 onError 回调内
  expect(fn.indexOf('watchHealth.degraded = true;', setDegraded + 1)).toBe(-1); // 单一写点
}

describe('watchHealth 复位方向（台账 3-2：remote 创建链三处写点与顺序）', () => {
  const ofSrc = readSrc('src/lib/openFlow.svelte.ts');
  const shellSrc = readSrc('src/lib/AppShell.svelte');

  it('connectServer：创建期复位（新连接降级指示不复用上一次连接），置位只经 onError', () => {
    expectResetDirection(
      fnWindow(ofSrc, /export async function connectServer\(baseUrl: string, token: string \| null\): Promise<void> \{[\s\S]*?\n\}/)
    );
  });

  it('openRemoteSource：同款创建期复位（存活实例复用早退不触旗标——多源打开不互相清写）', () => {
    expectResetDirection(
      fnWindow(ofSrc, /export function openRemoteSource\(\n[\s\S]*?\n\}/)
    );
  });

  it('reconnectRemoteStore（AppShell 恢复重连）：与 connectServer 同款创建期复位/置位', () => {
    expectResetDirection(
      // Svelte 组件 script 块内函数缩进 2 空格：窗口取至首个列 2 闭合 `  }`（体内
      // 块均 ≥4 缩进，首个列 2 闭合即本函数尾）
      fnWindow(shellSrc, /async function reconnectRemoteStore\(\n[\s\S]*?\n  \}/)
    );
  });

  it('direct 链不入全局通道（「只置本源」构成面）：createDirectMountStore 零 watchHealth 写点；per-source 文案由 isMountRootStoreId 派生', () => {
    const fn = fnWindow(ofSrc, /export function createDirectMountStore\(rec: DirectMountRecord\): DirectStore \{[\s\S]*?\n\}/);
    expect(fn).not.toMatch(/watchHealth\./); // 防线主锚在 directMountFlow.test.ts（终审 I-1），此处跨文件桥锚
    const viewerPane = readSrc('src/lib/ViewerPane.svelte');
    expect(viewerPane).toMatch(/isMountRootStoreId\(tab\.source\.storeId\)/);
    expect(viewerPane).toMatch(/watchHealth\.degraded/); // 全局降级指示与 per-source 文案按 tab 互斥
  });
});
