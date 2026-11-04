// downloadProgress.test.ts — 下载进度纯函数层（spec §6.4 远端全量物化进度卡，计划 2 Task 3）。
// downloadProgress.ts 为纯 .ts 模块（无 runes/无 DOM），vitest 直测：字节格式化（仓库无通用
// 字节 helper，本地实现——镜像 fonts.ts formatFontSize 的「数值+空格+单位」风格，扩 GB、
// KB 一位小数）、滑窗速度（注入假时钟 now）、ETA 稳定前「计算中」、不定态（total=null）
// totalText/ratio null、节流（默认 200ms 内多 update 单 tick）、done() 终态必发且幂等。
import { describe, expect, it } from 'vitest';
import { createProgressTracker, formatBytes, type ProgressSnapshot } from './downloadProgress';

// 假时钟：按脚本逐次返回；耗尽后停在末值（update 每次消费一个时刻，done 不取时刻）
function makeClock(...times: number[]): () => number {
  let i = 0;
  return () => {
    const t = times[Math.min(i, times.length - 1)]!;
    i += 1;
    return t;
  };
}

function collect(onTickLog: ProgressSnapshot[]) {
  return (s: ProgressSnapshot) => {
    onTickLog.push(s);
  };
}

describe('formatBytes（字节格式化：二进制进位，数值+空格+单位）', () => {
  it('四档位：B / KB（一位小数）/ MB（一位小数）/ GB（一位小数）', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});

describe('createProgressTracker——不定态（total=null，spec §6.4「总大小未知」）', () => {
  it('首个 update 必发 tick；totalText/etaText/ratio 全 null，仅 loadedText', () => {
    const ticks: ProgressSnapshot[] = [];
    const tracker = createProgressTracker(collect(ticks), { now: makeClock(0) });
    tracker.update(500, null);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toEqual({
      loadedText: '500 B',
      totalText: null,
      speedText: null,
      etaText: null,
      ratio: null
    });
  });
});

describe('createProgressTracker——滑窗速度 + ETA（假时钟注入）', () => {
  it('窗口 <2 样本或跨度 <1s 未稳：speedText null、etaText「计算中」', () => {
    const ticks: ProgressSnapshot[] = [];
    const tracker = createProgressTracker(collect(ticks), { now: makeClock(0) });
    tracker.update(0, 10000);
    expect(ticks[0]).toMatchObject({ speedText: null, etaText: '计算中', totalText: '9.8 KB', ratio: 0 });
  });

  it('跨度达 1s 起速度稳定：speedText 逐窗更新，ETA=剩余/速度', () => {
    const ticks: ProgressSnapshot[] = [];
    const tracker = createProgressTracker(collect(ticks), { now: makeClock(0, 1000, 2000) });
    tracker.update(0, 10000); // 未稳
    tracker.update(1000, 10000); // 跨度 1s：1000 B/s → 剩 9000 → 「9 秒」
    tracker.update(3000, 10000); // 全窗 [0,2s]：3000/2s=1500 B/s → 剩 7000 → 「5 秒」
    expect(ticks).toHaveLength(3);
    expect(ticks[1]).toMatchObject({
      loadedText: '1000 B',
      totalText: '9.8 KB',
      speedText: '1000 B/s',
      etaText: '9 秒',
      ratio: 0.1
    });
    expect(ticks[2]).toMatchObject({
      loadedText: '2.9 KB',
      speedText: '1.5 KB/s',
      etaText: '5 秒',
      ratio: 0.3
    });
  });

  it('5s 窗口剪枝：窗外旧样本不计入速度差分', () => {
    const ticks: ProgressSnapshot[] = [];
    const tracker = createProgressTracker(collect(ticks), { now: makeClock(0, 1000, 6000) });
    tracker.update(0, 60000);
    tracker.update(4000, 60000); // 4000 B/s
    tracker.update(6000, 60000); // 剪枝后窗 [1s,6s]：2000/5s=400 B/s（不剪则 1000 B/s）
    expect(ticks[2]).toMatchObject({ speedText: '400 B/s' });
    // 剩 54000 / 400 = 135s → 「2 分 15 秒」
    expect(ticks[2]).toMatchObject({ etaText: '2 分 15 秒', ratio: 0.1 });
  });

  it('停滞（窗口内零字节增量）：speedText 「0 B/s」、etaText 回落「计算中」', () => {
    const ticks: ProgressSnapshot[] = [];
    const tracker = createProgressTracker(collect(ticks), { now: makeClock(0, 1000) });
    tracker.update(0, 10000);
    tracker.update(0, 10000);
    expect(ticks[1]).toMatchObject({ speedText: '0 B/s', etaText: '计算中' });
  });
});

describe('createProgressTracker——节流（默认 200ms，spec §6.4 ~200ms）', () => {
  it('窗口内多 update 单 tick，跨窗后放行', () => {
    const ticks: ProgressSnapshot[] = [];
    const tracker = createProgressTracker(collect(ticks), { now: makeClock(0, 100, 150, 210, 500) });
    tracker.update(0, null); // t=0 首 tick
    tracker.update(100, null); // t=100 节流
    tracker.update(150, null); // t=150 节流
    tracker.update(210, null); // t=210 ≥200ms 放行
    tracker.update(500, null); // t=500-210=290 放行
    expect(ticks).toHaveLength(3);
    expect(ticks.map((t) => t.loadedText)).toEqual(['0 B', '210 B', '500 B']);
  });
});

describe('createProgressTracker——done() 终态', () => {
  it('节流期内也必发终态 tick（重算滑窗速度/ETA/ratio）', () => {
    const ticks: ProgressSnapshot[] = [];
    const tracker = createProgressTracker(collect(ticks), { now: makeClock(0, 1000, 1100) });
    tracker.update(0, 10000); // tick1 未稳
    tracker.update(2000, 10000); // tick2：2000 B/s，剩 8000 → 「4 秒」
    tracker.update(3000, 10000); // t=1100 节流不发
    tracker.done(); // 终态必发：全窗 [0,1.1s] 3000/1.1s≈2727 B/s → 剩 7000 → 「3 秒」
    expect(ticks).toHaveLength(3);
    expect(ticks[2]).toMatchObject({
      loadedText: '2.9 KB',
      speedText: '2.7 KB/s',
      etaText: '3 秒',
      ratio: 0.3
    });
  });

  it('done() 幂等：重复 done 不再发 tick；done 后 update 忽略', () => {
    const ticks: ProgressSnapshot[] = [];
    const tracker = createProgressTracker(collect(ticks), { now: makeClock(0) });
    tracker.update(0, null);
    tracker.done();
    tracker.done();
    tracker.update(999, null);
    expect(ticks).toHaveLength(2);
    expect(ticks[1]!.loadedText).toBe('0 B');
  });
});
