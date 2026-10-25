// zenGuard.test.ts — zen 守卫历史项状态机（spec 2026-10-19 §3.1 返回键拦截，FE-2
// 自 AppShell.svelte 抽出的纯模块）直测：history 经构造注入假件，锁定「移动断点
// 进 zen 压守卫 / 非 popstate 通道退出 back 消费 / popstate 通道退出不 back /
// reload 认领」的状态转移。popstate 分派语义本身是 layout.zenPopAction 纯函数
// （layout.test.ts 直测），AppShell 侧事件接线由 appShellZenMobile.test.ts 源码
// 契约锚定，行为面由 e2e b-layout-zen 收口。
import { describe, expect, it } from 'vitest';
import { ZenHistoryGuard, type ZenHistoryOps } from './zenGuard';

/** 记录型 history 假件：pushState 入参/back 计数/state 只读。 */
function fakeHistory(state: unknown = null) {
  const ops = {
    pushStates: [] as unknown[],
    backCount: 0,
    state
  };
  const history: ZenHistoryOps = {
    pushState(data: unknown, unused: string) {
      ops.pushStates.push([data, unused]);
    },
    back() {
      ops.backCount++;
    },
    get state() {
      return ops.state;
    }
  };
  return { ops, history };
}

describe('zenGuard 守卫历史项状态机（spec §3.1 返回键拦截）', () => {
  it('进 zen（移动断点）：压入 {vvZen:1} 守卫且置 armed——桌面断点不压（history 保持纯净）', () => {
    const { ops, history } = fakeHistory();
    const g = new ZenHistoryGuard(() => history);
    g.update(true, false, true); // 移动断点进 zen
    expect(g.isArmed).toBe(true);
    expect(ops.pushStates).toEqual([[{ vvZen: 1 }, '']]);
    expect(ops.backCount).toBe(0);

    const desk = fakeHistory();
    const gd = new ZenHistoryGuard(() => desk.history);
    gd.update(true, false, false); // 桌面断点进 zen：无返回键语义，不压守卫
    expect(gd.isArmed).toBe(false);
    expect(desk.ops.pushStates).toEqual([]);
  });

  it('非 popstate 通道退出（浮钮/菜单/Esc/快捷键）：back() 恰一次消费守卫（返回键语义回归原生）', () => {
    const { ops, history } = fakeHistory();
    const g = new ZenHistoryGuard(() => history);
    g.update(true, false, true);
    g.update(false, false, true);
    expect(ops.backCount).toBe(1);
    expect(g.isArmed).toBe(false);
  });

  it('popstate 通道退出：本次回退已弹出守卫，不再 back（不双重回退）', () => {
    const { ops, history } = fakeHistory();
    const g = new ZenHistoryGuard(() => history);
    g.update(true, false, true);
    g.consume(); // onPopstate exitZen 分支：回退已消费守卫
    g.update(false, true, true);
    expect(ops.backCount).toBe(0);
    expect(g.isArmed).toBe(false);
  });

  it('守卫不在场时退出：不动 history（桌面进入后退出/残留态清理零副作用）', () => {
    const { ops, history } = fakeHistory();
    const g = new ZenHistoryGuard(() => history);
    g.update(false, false, true);
    expect(ops.backCount).toBe(0);
    expect(ops.pushStates).toEqual([]);
  });

  it('closeOverlay 分支重压守卫（zen 在场即守卫在顶不变式）：consume 后 arm 再次压入', () => {
    const { ops, history } = fakeHistory();
    const g = new ZenHistoryGuard(() => history);
    g.update(true, false, true);
    g.consume(); // 返回键先关面板：本次回退消费守卫
    g.arm(); // 关面板后重压——下次返回继续承接
    expect(g.isArmed).toBe(true);
    expect(ops.pushStates).toHaveLength(2);
  });

  it('reload 认领：当前历史项即守卫（history.state 持久）→ armed；无守卫 → false 不动 history', () => {
    const reloaded = fakeHistory({ vvZen: 1 });
    const gr = new ZenHistoryGuard(() => reloaded.history);
    expect(gr.claimReloaded()).toBe(true);
    expect(gr.isArmed).toBe(true);
    expect(reloaded.ops.pushStates).toEqual([]); // 认领不补压

    const fresh = fakeHistory(null);
    const gf = new ZenHistoryGuard(() => fresh.history);
    expect(gf.claimReloaded()).toBe(false);
    expect(gf.isArmed).toBe(false);

    const foreign = fakeHistory({ other: 2 });
    expect(new ZenHistoryGuard(() => foreign.history).claimReloaded()).toBe(false);
  });
});
