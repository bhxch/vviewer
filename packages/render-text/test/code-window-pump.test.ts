// code 窗口流式后台索引泵单测（BUG-201 修复驱动，TDD RED 先行）。
// 缺陷：窗口流式下行索引仅靠滚动续读推进（maybeContinue 距尾 20 行闸），start()
// 排空仅在 bs.atEnd() 形态可达——size 已知的 range 流式打开后不滚动则行数永久
// 冻结在首块部分值（BUG-20 契约锚 b-code-highlight-degrade.spec.ts:179 确定性
// 双红）。修复方向：后台逐块推进至 EOF/防线停机（io spec §4.3「后台逐块推进、
// 可取消」承诺兑现），复用 pulling 单飞闸与 continueFailed 停机闩。
// 本文件只测行为面（不滚动即推进至 EOF）；停机条件复用既有闩（滚动续读/扫描
// 同款），由既有套件与 e2e 锚回归保护。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamCtx } from '@vviewer/core';
import { LINE_HEIGHT, renderCode } from '../src/code';

const LINE_BYTES = 72;
const LINE = 'x'.repeat(LINE_BYTES - 1) + '\n';
const LINE_ENC = new TextEncoder().encode(LINE);
/** 每块完整行数：floor(256KB / 72) = 3640（64B 悬挂尾段不提交行） */
const BLOCK = 256 * 1024;
const LINES_PER_BLOCK = Math.floor(BLOCK / LINE_BYTES);

function stubResizeObserver(): void {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('code 窗口流式后台索引泵（BUG-201）', () => {
  it('首拉在飞窗口内泵 tick 插入——同块只喂一次（start() 与泵并发双喂防线）', async () => {
    stubResizeObserver();
    // 缺陷复现口径（2026-10-14 CI 幻影行三观测：DEG-03 +4096 / BUG-20 阶段4 +3640 /
    // SCAN-10 mobile +4096，均为恰一整块行数且内容重复已扫块）：ctx.read 直返（微任务
    // 即落）时 start() 首拉与泵 tick 无重叠窗口——真实 fetch 的 RTT 是宏任务级延迟，
    // 用户动作（ResizeObserver 初次回调/scroll → onUserScroll → scheduleIndexPump(0)）
    // 启动的泵 tick 恰落在首拉在飞窗口内。泵经 blockStream inflight 表去重 await 同一
    // 块 promise，落地后 start() 与泵的 pullBlock 各自 advanceCodeIndex 一次 = 同块
    // 双喂：行数恰多一整块、内容重复。本用例以宏任务级延迟（30ms > 0ms 泵拍）复现该
    // 窗口，断言 EOF 终行数守恒。
    const blocks = 11; // 11×256KB ≈ 2.8MB > 2MB 阈值 → 窗口路由
    const totalLines = LINES_PER_BLOCK * blocks;
    const full = new Uint8Array(totalLines * LINE_BYTES);
    for (let i = 0; i < totalLines; i++) full.set(LINE_ENC, i * LINE_BYTES);
    const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
    let firstBlockInflight = false;
    const ctx: StreamCtx = {
      size: full.length,
      head: full.slice(0, 8192),
      read: async (r) => {
        // 块 0 首请求挂起一个宏任务级 RTT（start() 首拉在飞窗口）；后续块直返
        if (r.start === 0 && !firstBlockInflight) {
          firstBlockInflight = true;
          await sleep(30);
        }
        return full.slice(r.start, r.end + 1);
      }
    };
    const host = document.createElement('div');
    document.body.append(host);
    const inst = renderCode(full.slice(0, 8192), host, { ctx, ext: 'js', highlight: false });
    try {
      // renderCode 同步返回时 start() 已挂在块 0 上：scroll → onUserScroll 启动泵，
      // pumpTick（0ms 拍）在 RTT 窗口内插入
      const pre = host.querySelector<HTMLElement>('.vv-code-pre')!;
      pre.dispatchEvent(new Event('scroll'));
      // 修复前：双喂使终行数多恰 LINES_PER_BLOCK（3640），本断言超时失败
      await vi.waitFor(
        () => {
          expect(inst.getMeta().lines).toBe(totalLines);
        },
        { timeout: 5_000, interval: 50 }
      );
    } finally {
      inst.destroy();
    }
  });

  it('打开后不滚动，行数自动推进至 EOF 终值（后台逐块推进，不再冻结首块值）', async () => {
    stubResizeObserver();
    const blocks = 11; // 11×256KB ≈ 2.8MB > 2MB 阈值 → 窗口路由
    const totalLines = LINES_PER_BLOCK * blocks;
    const full = new Uint8Array(totalLines * LINE_BYTES);
    for (let i = 0; i < totalLines; i++) full.set(LINE_ENC, i * LINE_BYTES);
    const ctx: StreamCtx = {
      size: full.length,
      head: full.slice(0, 8192),
      read: async (r) => full.slice(r.start, r.end + 1)
    };
    const host = document.createElement('div');
    document.body.append(host);
    // highlight:false → plain 策略（单测不接 hljs）；buffer 形参仅作探测头部样本
    const inst = renderCode(full.slice(0, 8192), host, { ctx, ext: 'js', highlight: false });
    try {
      // 修复前：行数冻结在首块完整行数 3640（262144B 中 3640×72=262080B 为完整行）
      // 修复后：后台泵逐块推进，EOF 收口提交悬挂尾段（末条目空串，lines=rows-1）
      await vi.waitFor(
        () => {
          expect(inst.getMeta().lines).toBe(totalLines);
        },
        { timeout: 5_000, interval: 50 }
      );
      // spacer 随索引增长（泵逐块 remount 上屏）：滚到底可达真实末行——缺此步则
      // scroller 行数冻结在末次滚动续读的 mount 值（BUG-20 mobile 回归面）。spacer
      // 按 rows()（索引条目数，含末尾空串）计，与 getMeta 的 wc-l 展示口径差 1
      const spacer = host.querySelector<HTMLElement>('.vv-virtual-spacer');
      expect(spacer).not.toBeNull();
      expect(spacer!.style.height).toBe(`${(totalLines + 1) * LINE_HEIGHT}px`);
    } finally {
      inst.destroy();
    }
  });
});
