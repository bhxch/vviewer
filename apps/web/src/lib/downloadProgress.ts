// downloadProgress.ts — 下载进度纯函数层（spec §6.4 远端全量物化进度卡，计划 2 Task 3，
// Task 4 扩卡片行文案/地址拼装/来源门）。消费 dispatcher onReadProgress 的 (loaded, total)
// 平面参数（计划 2 Task 2 ReadProgressEvent 的载荷），产出进度卡纯展示快照
// ProgressSnapshot 与卡片行级文案；UI 接线（ViewerPane loading-progress 形态）在 Task 4。
// 纯 .ts 模块，无 runes/无 DOM，vitest 直测。
//
// 字节格式化：复用 storageHealth.formatBytes 单源（评审 I-1：删除本地双实现）——
// 二进制进位（1024）B/KB/MB/GB/TB，KB 起一位小数，「数值+空格+单位」文案风格同
// fonts.ts formatFontSize（'512 B' / '2.0 MB'）；fonts.ts 的 MB 级字体场景继续用
// formatFontSize，不回改。
//
// 语义约定（spec §6.4）：
// - 速度：~5s 滑动窗口均值；窗口 <2 样本或首末跨度 <1s 视为未稳 → speedText null（进度卡
//   隐藏速度行）、etaText「计算中」。
// - ETA：剩余/速度；total 未知（不定态）无 ETA 概念 → etaText null；速度未稳或停滞
//   （速度 ≤0 且仍有剩余）→「计算中」。
// - 不定态：total 从未上报 → totalText/ratio/etaText null（进度卡只显已下载）。
// - 节流：默认 200ms（spec ~200ms），窗口内多 update 单 tick；首个 update 必发；
//   done() 终态不受节流、必发且幂等（重复 done/done 后 update 均忽略）。

import { displayEndpoint } from './mountsSync';
import { formatBytes } from './storageHealth';
import { sourceKindOf } from './workspaceStore';
// 纯层 i18n（Task 7 域 D）：卡片行级文案调用时刻取当下 locale（非响应式）
import { translate as t } from './i18n/core';

// 字节格式化单源转发（评审 I-1）：实现只在 storageHealth（B/KB/MB/GB/TB），本模块
// 保留 formatBytes 既有导出面供测试/消费方直引——不再持有第二实现。
export { formatBytes };

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
  /** update 是否发生过（终审修复波 I-3 泵参与门）：streaming 渲染在 range-capable
   * 远端源只做 head 探测 + 按需窗，零全量下载零 update——完成态卡（ViewerPane
   * dlDone 装配门）以本标志区分「真实泵参与」与「零下载流式路径」，防误报。 */
  readonly pumped: boolean;
}

const WINDOW_MS = 5000; // spec §6.4：~5s 滑动窗口均值
const STABLE_SPAN_MS = 1000; // 窗口首末跨度 <1s 视为未稳
const DEFAULT_THROTTLE_MS = 200; // spec §6.4：节流 ~200ms

// ---------- Task 4 卡片行级文案与装配门（displayLayer 纯面，ViewerPane 消费） ----------

/** 进度卡「已下载」行（spec §6.4）：total 已知 → 「已下载 N / M」（已下载/完整大小
 * 同行）；不定态（totalText null，total 从未上报）→ 「已下载 N（总大小未知）」——
 * T3 报告移交的拼装面（快照只给 loadedText，括注由本层依 totalText===null 补齐）。 */
export function dlLoadedLine(snap: ProgressSnapshot): string {
  return snap.totalText === null
    ? t('viewer.dl.loadedLineUnknown', { loaded: snap.loadedText })
    : t('viewer.dl.loadedLine', { loaded: snap.loadedText, total: snap.totalText });
}

/** 进度卡「地址」行（spec §6.4：脱敏 display endpoint + path）：endpoint 缺席
 * （R2 记录未列出过/本地源退化）时只显 path。脱敏走 mountsSync.displayEndpoint
 * 单源（userinfo 剥除，server display_endpoint 的 TS 镜像）；endpoint 尾斜杠与
 * path 前导斜杠归一防双拼（getRemoteBase 的 normalizeServerBase 已剥尾斜杠，
 * direct 记录 endpoint 是原始输入，此处统一兜）。 */
export function dlAddressText(endpoint: string | null | undefined, path: string): string {
  if (!endpoint) return path;
  const base = displayEndpoint(endpoint).replace(/\/+$/, '');
  return `${base}/${path.replace(/^\/+/, '')}`;
}

/** 进度卡作用门（spec §6.4：进度卡/确认门仅 R1/R2 远端全量物化；本地 L1–L3 不显示）：
 * sourceKindOf 单源判定（workspaceStore 既有前缀分类）——'remote'（R1 服务端）与
 * 'direct'（R2 s3direct:/davdirect: 直连）为真。'url' 不入面：url store 无视 Range
 * 请求（memoized 全量 fetch），泵的 4MiB 请求窗循环对其不成立（T2 ⑧ 钳块锚的违约
 * 域外），v1 URL 通道维持现状（spec §6.4「URL 通道维持 v1 不启用」）。 */
export function isRemoteDownload(storeId: string): boolean {
  const kind = sourceKindOf(storeId);
  return kind === 'remote' || kind === 'direct';
}

/** ETA 未稳/停滞的占位文案（下载进度卡以此区分无前缀占位与「剩余 X」真实 ETA，M-4）。
 * 原 ETA_PENDING_TEXT 常量（Task 7 抽取改函数——目录键调用时刻取值；快照值与
 * 组件侧比较恒用本函数（同 locale 同值），身份比较语义保持）。 */
export function etaPendingText(): string {
  return t('viewer.dl.etaPending');
}

/** ETA 文案：整秒进位；<60s 秒、<1h 分秒、其余时分（余数四舍五入，60 进位收敛） */
function formatEta(seconds: number): string {
  if (seconds <= 0) return t('viewer.dl.etaSeconds', { n: 0 });
  if (seconds < 60) return t('viewer.dl.etaSeconds', { n: Math.ceil(seconds) });
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const r = Math.round(seconds - m * 60);
    if (r === 60) return t('viewer.dl.etaMinutes', { m: m + 1 });
    return r > 0 ? t('viewer.dl.etaMinSec', { m, r }) : t('viewer.dl.etaMinutes', { m });
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds - h * 3600) / 60);
  if (m === 60) return t('viewer.dl.etaHours', { h: h + 1 });
  return m > 0 ? t('viewer.dl.etaHourMin', { h, m }) : t('viewer.dl.etaHours', { h });
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
  let pumpedFlag = false; // 泵参与标志：任一 update 置位（I-3 完成态卡装配门）

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
      else etaText = etaPendingText();
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
      pumpedFlag = true; // 泵参与标志先于 finished 短路：任一 update 即算参与（I-3）
      if (finished) return;
      loaded = nextLoaded;
      if (nextTotal !== null) total = nextTotal; // total 一旦上报不回退 null（事件流定态）
      const stamp = now(); // 每 update 只取一个时刻（假时钟语义）
      samples.push({ t: stamp, loaded: nextLoaded });
      if (stamp - lastTickAt >= throttleMs) {
        lastTickAt = stamp;
        onTick(snapshot());
      }
    },
    done(): void {
      if (finished) return;
      finished = true;
      onTick(snapshot()); // 终态不受节流，必发
    },
    get pumped(): boolean {
      return pumpedFlag;
    }
  };
}
