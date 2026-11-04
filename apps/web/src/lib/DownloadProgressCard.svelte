<script lang="ts">
  // DownloadProgressCard.svelte — 远端下载进度卡（计划 2 Task 4，spec §6.4）。
  // ViewerPane 加载态区（错误卡片同域的 loading-progress 形态）：远端全量物化下载
  // 进行中显示，字段全锚——地址（脱敏 display endpoint + path，dlAddressText 产出）、
  // 进度条（ratio 驱动宽度；不定态 indeterminate 动画）、已下载/完整大小（dlLoadedLine
  // 单行双形态）、速度（~5s 滑窗均值，未稳隐藏）、预估剩余（未稳「计算中」，不定态
  // 隐藏）、取消（回调上抛——组件不持 AbortController，abort 由 ViewerPane 的
  // effectAbort 统一承担）。完成/失败/取消/tab 切换由 ViewerPane 清 dlProgress 卸卡。
  // 纯展示组件：快照进、DOM 出，无本地状态（根 vitest 无 svelte 插件不可挂载，
  // 字段契约由 downloadProgressUi.test.ts 源码断言锁定，运行时行为 e2e 兜底）。
  import { dlLoadedLine, type ProgressSnapshot } from './downloadProgress';

  let { snapshot, address, oncancel }: { snapshot: ProgressSnapshot; address: string; oncancel: () => void } = $props();
</script>

<div class="vv-dl-progress" role="status" aria-label="正在下载">
  <div class="vv-dl-progress-head">
    <span class="vv-dl-progress-title">正在下载</span>
    <span class="vv-dl-progress-address" title={address}>{address}</span>
  </div>
  <!-- 进度条：ratio 有值 = 确定态（宽度驱动）；null = 不定态（indeterminate 滑块动画，
       aria-hidden 装饰性——语义由 role="status" 文本行承担） -->
  <div
    class="vv-dl-progress-bar"
    class:vv-dl-progress-bar-indeterminate={snapshot.ratio === null}
    aria-hidden="true"
  >
    {#if snapshot.ratio !== null}
      <div class="vv-dl-progress-fill" style:width="{Math.round(snapshot.ratio * 100)}%"></div>
    {/if}
  </div>
  <div class="vv-dl-progress-meta">
    <span class="vv-dl-progress-loaded">{dlLoadedLine(snapshot)}</span>
    {#if snapshot.speedText !== null}<span class="vv-dl-progress-speed">{snapshot.speedText}</span>{/if}
    {#if snapshot.etaText !== null}<span class="vv-dl-progress-eta">剩余 {snapshot.etaText}</span>{/if}
  </div>
  <button type="button" class="vv-dl-progress-cancel" onclick={oncancel}>取消</button>
</div>
