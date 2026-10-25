// watchHealth.test.ts — SSE 变更推送健康旗标的复位方向契约（台账 3-2，终审 I-1
// 修复的测试面收尾；FE-1 拆分锚随迁：watchHealth 与 wireStoreWatch 归一接线在
// serverConnect.svelte.ts，openRemoteSource 调用点在 openFlow.svelte.ts façade；
// FE-2：AppShell 的 reconnectRemoteStore 迁入 serverConnect.svelte.ts 并归一
// wireStoreWatch——remote 创建链第四处调用点，未归一接线窗口清零）。
// watchHealth 是连接域模块级 runes $state（全局单旗标），根 vitest 无 svelte 插件
// 不可挂载 runes 模块/组件——行为直测不可达，按既有「源码契约断言」先例
// （directMountFlow.test.ts 同因同形态）锁定 remote 创建链接线写点与顺序；运行期
// 行为由 e2e 收口。
//
// 复位方向契约（诚实定性：本文件为源码锚非行为用例，裁决见 task-5-report）：
// - watchHealth 为全局单旗标，「源 B 的 degraded」不存在独立通道；per-source 面
//   由 ViewerPane 按 isMountRootStoreId 派生（挂载来源显示「此源不支持变更推送」，
//   与全局降级指示按 tab 互斥）。全局旗标的复位方向 = 复位只发生在「新建 store
//   实例」时序（createRemoteStore 之后、store.watch 接线之前）——新连接的降级
//   指示不复用上一次连接的；存活实例复用路径早退不触旗标（各函数仅单一复位点）。
//   FE-1 起 remote 创建链接线归一进 wireStoreWatch（复位/置位写点各唯一），全部
//   调用点仍在各自 createRemoteStore 之后（创建期复位的调用位置语义）——复位/
//   置位顺序与单一写点断言逐字保留在 wireStoreWatch 函数窗口用例。
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

describe('watchHealth 复位方向（台账 3-2：remote 创建链接线写点与顺序）', () => {
  const ofSrc = readSrc('src/lib/openFlow.svelte.ts');
  const scSrc = readSrc('src/lib/serverConnect.svelte.ts');

  it('wireStoreWatch（remote 创建链接线归一，FE-1）：创建期复位先于 store.watch 接线，置位只经 onError 且为唯一写点', () => {
    // connectServer/openRemoteSource 两例的复位方向断言随接线归一迁至本函数窗口
    //（复位先于 store.watch 接线、置位唯一写点在 onError 回调内——原样迁移；
    //   FE-2 起 reconnectRemoteStore 的未归一窗口清零，复位/置位语义单点在此）
    const fn = fnWindow(
      scSrc,
      /export function wireStoreWatch\(store: ReturnType<typeof createRemoteStore>\): void \{[\s\S]*?\n\}/
    );
    const reset = fn.indexOf('watchHealth.degraded = false;');
    const wiring = fn.indexOf('store.watch(');
    const setDegraded = fn.indexOf('watchHealth.degraded = true;');
    expect(reset).toBeGreaterThan(-1); // 复位写点在位（缺失时顺序断言会假绿，先钉存在性）
    expect(wiring).toBeGreaterThan(-1);
    expect(wiring).toBeGreaterThan(reset); // 复位先于 watch 接线（创建期，非错误后补）
    expect(setDegraded).toBeGreaterThan(wiring); // 置位只在 onError 回调内
    expect(fn.indexOf('watchHealth.degraded = true;', setDegraded + 1)).toBe(-1); // 单一写点
  });

  it('三调用点存在性：connectServer/applyMountRootIndexMigrations（serverConnect）与 openRemoteSource（openFlow façade）各在 createRemoteStore 之后调 wireStoreWatch（创建期复位，存活实例复用早退不触旗标——多源打开不互相清写）', () => {
    const cs = fnWindow(
      scSrc,
      /export async function connectServer\(baseUrl: string, token: string \| null\): Promise<void> \{[\s\S]*?\n\}/
    );
    expect(cs.indexOf('wireStoreWatch(')).toBeGreaterThan(cs.indexOf('createRemoteStore('));
    const mig = fnWindow(
      scSrc,
      /export function applyMountRootIndexMigrations\(moves: RootIndexMove\[\], token: string \| null\): void \{[\s\S]*?\n\}/
    );
    expect(mig.indexOf('wireStoreWatch(')).toBeGreaterThan(mig.indexOf('createRemoteStore('));
    const ors = fnWindow(ofSrc, /export function openRemoteSource\(\n[\s\S]*?\n\}/);
    expect(ors.indexOf('wireStoreWatch(')).toBeGreaterThan(ors.indexOf('createRemoteStore('));
  });

  it('reconnectRemoteStore（restore 恢复重连，FE-2 迁 serverConnect 并归一 wireStoreWatch）：createRemoteStore 之后调 wireStoreWatch（创建期复位；复位/置位顺序与单一写点经上方 wireStoreWatch 窗口用例逐字锁定）', () => {
    // FE-2 锚随迁：readSrc 目标 AppShell → serverConnect.svelte.ts，内联接线窗口
    //（原 expectResetDirection 断言面）随归一收敛进 wireStoreWatch 单点
    const fn = fnWindow(
      scSrc,
      /export async function reconnectRemoteStore\(\n[\s\S]*?\n\}/
    );
    expect(fn.indexOf('wireStoreWatch(')).toBeGreaterThan(fn.indexOf('createRemoteStore('));
  });

  it('direct 链不入全局通道（「只置本源」构成面）：createDirectMountStore 零 watchHealth 写点；per-source 文案由 isMountRootStoreId 派生', () => {
    const fn = fnWindow(ofSrc, /export function createDirectMountStore\(rec: DirectMountRecord\): DirectStore \{[\s\S]*?\n\}/);
    expect(fn).not.toMatch(/watchHealth\./); // 防线主锚在 directMountFlow.test.ts（终审 I-1），此处跨文件桥锚
    const viewerPane = readSrc('src/lib/ViewerPane.svelte');
    expect(viewerPane).toMatch(/isMountRootStoreId\(tab\.source\.storeId\)/);
    expect(viewerPane).toMatch(/watchHealth\.degraded/); // 全局降级指示与 per-source 文案按 tab 互斥
  });
});
