<script lang="ts">
  // DownloadProgressCard.svelte — 远端下载进度卡（计划 2 Task 4，spec §6.4）。
  // ViewerPane 加载态区（错误卡片同域的 loading-progress 形态）：远端全量物化下载
  // 进行中显示，字段全锚——地址（脱敏 display endpoint + path，dlAddressText 产出）、
  // 进度条（ratio 驱动宽度；不定态 indeterminate 动画）、已下载/完整大小（dlLoadedLine
  // 单行双形态）、速度（~5s 滑窗均值，未稳隐藏）、预估剩余（未稳「计算中」不带
  // 「剩余」前缀，有真实 ETA「剩余 X」；不定态隐藏——评审 M-4 去前缀叠用）、
  // 取消（回调上抛——组件不持 AbortController，abort 由 ViewerPane 的
  // effectAbort 统一承担）。
  // 完成态（计划 2 Task 7，spec §6.4「完成后另存为」）：done 非 null = 卡转完成态
  // ——标题「下载完成」+ 文件名/总大小 + 「另存为」（saveAsTab 统一管线，onsaveas
  // 上抛）与「关闭」动作，TTL 自动卸载由 ViewerPane 承担（DL-PROG-01 完成后卡自动
  // 卸载锚；浮层不占布局，内容渲染并行接管）。纯展示组件：快照进、DOM 出，无本地
  // 状态（根 vitest 无 svelte 插件不可挂载，字段契约由 downloadProgressUi.test.ts
  // 源码断言锁定，运行时行为 e2e 兜底）。
  import { dlLoadedLine, ETA_PENDING_TEXT, type ProgressSnapshot } from './downloadProgress';

  let {
    snapshot,
    address = '',
    oncancel,
    done = null,
    onsaveas,
    onclose
  }: {
    /** 下载中快照（done 非 null 时传 null——完成态分支不消费快照行） */
    snapshot: ProgressSnapshot | null;
    address?: string;
    oncancel: () => void;
    /** 完成态数据（null = 下载中形态）：name + totalText（size 未知为 null） */
    done?: { name: string; totalText: string | null } | null;
    onsaveas?: () => void;
    onclose?: () => void;
  } = $props();
</script>

{#if done !== null}
  <div class="vv-dl-progress vv-dl-progress-done" role="status" aria-label="下载完成">
    <div class="vv-dl-progress-head">
      <span class="vv-dl-progress-title">下载完成</span>
      <span class="vv-dl-progress-address" title={done.name}>{done.name}</span>
    </div>
    {#if done.totalText !== null}
      <div class="vv-dl-progress-meta"><span class="vv-dl-progress-loaded">共 {done.totalText}</span></div>
    {/if}
    <div class="vv-dl-progress-actions">
      <button type="button" class="vv-dl-progress-saveas" onclick={onsaveas}>另存为</button>
      <button type="button" class="vv-dl-progress-close" onclick={onclose}>关闭</button>
    </div>
  </div>
{:else if snapshot !== null}
  <div class="vv-dl-progress" role="status" aria-label="正在下载">
    <div class="vv-dl-progress-head">
      <span class="vv-dl-progress-title">正在下载</span>
      <span class="vv-dl-progress-address" title={address}>{address}</span>
    </div>
    <!-- 进度条：ratio 有值 = 确定态（宽度驱动 + valuenow 定态回显）；null = 不定态
         （indeterminate 滑块动画，省略 valuenow）。progressbar 语义 + valuemin/max 恒挂
         （评审 M-5 读屏可达），与容器 role="status" 文本行双通道承担语义 -->
    <div
      class="vv-dl-progress-bar"
      class:vv-dl-progress-bar-indeterminate={snapshot.ratio === null}
      role="progressbar"
      aria-label="下载进度"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={snapshot.ratio === null ? undefined : Math.round(snapshot.ratio * 100)}
    >
      {#if snapshot.ratio !== null}
        <div class="vv-dl-progress-fill" style:width="{Math.round(snapshot.ratio * 100)}%"></div>
      {/if}
    </div>
    <div class="vv-dl-progress-meta">
      <span class="vv-dl-progress-loaded">{dlLoadedLine(snapshot)}</span>
      {#if snapshot.speedText !== null}<span class="vv-dl-progress-speed">{snapshot.speedText}</span>{/if}
      {#if snapshot.etaText !== null}<span class="vv-dl-progress-eta">{snapshot.etaText === ETA_PENDING_TEXT ? ETA_PENDING_TEXT : `剩余 ${snapshot.etaText}`}</span>{/if}
    </div>
    <button type="button" class="vv-dl-progress-cancel" onclick={oncancel}>取消</button>
  </div>
{/if}
