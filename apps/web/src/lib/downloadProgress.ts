// downloadProgress.ts — 下载进度纯函数层（spec §6.4 远端全量物化进度卡，计划 2 Task 3）。
// 消费 dispatcher onReadProgress 的 (loaded, total) 平面参数（计划 2 Task 2
// ReadProgressEvent 的载荷），产出进度卡纯展示快照 ProgressSnapshot，UI 接线（ViewerPane
// loading-progress 形态）在 Task 4。纯 .ts 模块，无 runes/无 DOM，vitest 直测。
//
// 字节格式化：仓库无通用字节 helper（rg formatBytes/humanBytes 零命中），本地实现
// formatBytes——二进制进位（1024），文案镜像 fonts.ts formatFontSize 的「数值+空格+单位」
// 风格（'512 B' / '2.0 MB'），按进度卡需要扩 GB 档、KB 起一位小数；fonts.ts 的 MB 级
// 字体场景继续用 formatFontSize，不回改。
//
// 语义约定（spec §6.4）：
// - 速度：~5s 滑动窗口均值；窗口 <2 样本或首末跨度 <1s 视为未稳 → speedText null（进度卡
//   隐藏速度行）、etaText「计算中」。
// - ETA：剩余/速度；total 未知（不定态）无 ETA 概念 → etaText null；速度未稳或停滞
//   （速度 ≤0 且仍有剩余）→「计算中」。
// - 不定态：total 从未上报 → totalText/ratio/etaText null（进度卡只显已下载）。
// - 节流：默认 200ms（spec ~200ms），窗口内多 update 单 tick；首个 update 必发；
//   done() 终态不受节流、必发且幂等（重复 done/done 后 update 均忽略）。

/** 进度卡纯展示快照（Task 4 进度卡逐字段消费；null=该行隐藏/不定态） */
export interface ProgressSnapshot {
  loadedText: string;
  totalText: string | null;
  speedText: string | null;
  etaText: string | null;
  ratio: number | null;
}

export interface ProgressTrackerOptions {
  /** 进度 tick 节流间隔（ms），默认 200 */
  throttleMs?: number;
  /** 时钟注入（测试假时钟），默认 Date.now */
  now?: () => number;
}

export interface ProgressTracker {
  update(loaded: number, total: number | null): void;
  done(): void;
}

const WINDOW_MS = 5000; // spec §6.4：~5s 滑动窗口均值
const STABLE_SPAN_MS = 1000; // 窗口首末跨度 <1s 视为未稳
const DEFAULT_THROTTLE_MS = 200; // spec §6.4：节流 ~200ms

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** ETA 文案：整秒进位；<60s 秒、<1h 分秒、其余时分（余数四舍五入，60 进位收敛） */
function formatEta(seconds: number): string {
  if (seconds <= 0) return '0 秒';
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const r = Math.round(seconds - m * 60);
    if (r === 60) return `${m + 1} 分`;
    return r > 0 ? `${m} 分 ${r} 秒` : `${m} 分`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds - h * 3600) / 60);
  if (m === 60) return `${h + 1} 小时`;
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

interface Sample {
  t: number;
  loaded: number;
}

export function createProgressTracker(
  onTick: (snapshot: ProgressSnapshot) => void,
  opts?: ProgressTrackerOptions
): ProgressTracker {
  const now = opts?.now ?? (() => Date.now());
  const throttleMs = opts?.throttleMs ?? DEFAULT_THROTTLE_MS;
  const samples: Sample[] = [];
  let loaded = 0;
  let total: number | null = null;
  let lastTickAt = -Infinity; // 首个 update 必发 tick
  let finished = false;

  /** 滑窗速度：剪去窗口外旧样本（至少保留末两点）后首末差分；未稳/负增量 → null */
  function computeSpeed(): number | null {
    if (samples.length < 2) return null;
    const newest = samples[samples.length - 1]!;
    const cutoff = newest.t - WINDOW_MS;
    let first = 0;
    while (first < samples.length - 2 && samples[first]!.t < cutoff) first += 1;
    const span = newest.t - samples[first]!.t;
    if (span < STABLE_SPAN_MS) return null;
    const delta = newest.loaded - samples[first]!.loaded;
    if (delta < 0) return null; // loaded 回退（重试等）按未稳处理
    return (delta * 1000) / span;
  }

  function snapshot(): ProgressSnapshot {
    const speed = computeSpeed();
    const totalKnown = total !== null;
    let etaText: string | null = null;
    if (totalKnown) {
      const remaining = total! - loaded;
      if (remaining <= 0) etaText = formatEta(0);
      else if (speed !== null && speed > 0) etaText = formatEta(remaining / speed);
      else etaText = '计算中';
    }
    return {
      loadedText: formatBytes(loaded),
      totalText: totalKnown ? formatBytes(total!) : null,
      speedText: speed === null ? null : `${formatBytes(speed)}/s`,
      etaText,
      ratio: totalKnown ? Math.min(1, Math.max(0, loaded / total!)) : null
    };
  }

  return {
    update(nextLoaded: number, nextTotal: number | null): void {
      if (finished) return;
      loaded = nextLoaded;
      if (nextTotal !== null) total = nextTotal; // total 一旦上报不回退 null（事件流定态）
      const t = now(); // 每 update 只取一个时刻（假时钟语义）
      samples.push({ t, loaded: nextLoaded });
      if (t - lastTickAt >= throttleMs) {
        lastTickAt = t;
        onTick(snapshot());
      }
    },
    done(): void {
      if (finished) return;
      finished = true;
      onTick(snapshot()); // 终态不受节流，必发
    }
  };
}
