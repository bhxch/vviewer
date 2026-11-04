<script lang="ts">
  // DownloadConfirmCard.svelte — 远端下载确认卡（计划 2 Task 6，spec §6.4 确认门）。
  // ViewerPane 加载态区（进度卡同域 pane 级浮层）：远端全量物化超过阈值（settings
  // 「远端下载确认阈值」，MB 计）时在泵启动前显示——明示文件名/大小/目标渲染器与
  // 内存影响，「开始下载」确认后泵才启动（知情自担，无独立硬上限）；「取消」静默
  // （不 dispatch、无错误卡——与进度卡取消同域的静默面）。size 未知的不定态下载
  // 不适用确认门（无前置数字，ViewerPane 门直接放行）。
  // 纯展示组件：字段进、DOM 出，无本地状态（根 vitest 无 svelte 插件不可挂载，
  // 字段契约由 downloadConfirm.test.ts 源码断言锁定，运行时行为 e2e 兜底）。
  import { formatBytes } from './storageHealth';

  let {
    name,
    sizeBytes,
    rendererLabel,
    onconfirm,
    oncancel,
    onsaveas
  }: {
    name: string;
    sizeBytes: number;
    rendererLabel: string;
    onconfirm: () => void;
    oncancel: () => void;
    /** 「下载并另存为」次动作（计划 2 Task 7，spec §6.4 双形态二）：仅 FS Access
     * 可用环境传入（ViewerPane 以 showSaveFilePicker 探测装配）；缺省不渲染按钮
     * （降级为普通下载路径——spec「无 FS Access 环境降级为普通下载」）。 */
    onsaveas?: () => void;
  } = $props();
</script>

<div class="vv-dl-confirm" role="alertdialog" aria-label="确认下载">
  <div class="vv-dl-confirm-head">
    <span class="vv-dl-confirm-title">确认下载</span>
    <span class="vv-dl-confirm-name" title={name}>{name}</span>
  </div>
  <!-- size/renderer 子行类名仅作测试锚（app.css 无对应规则，样式由 .vv-dl-confirm-meta 统辖） -->
  <div class="vv-dl-confirm-meta">
    <span class="vv-dl-confirm-size">大小 {formatBytes(sizeBytes)}</span>
    <span class="vv-dl-confirm-renderer">目标渲染器：{rendererLabel}</span>
  </div>
  <div class="vv-dl-confirm-impact">下载期间文件将全量读入内存，超大文件可能造成卡顿或内存压力。</div>
  <div class="vv-dl-confirm-actions">
    <button type="button" class="vv-dl-confirm-start" onclick={onconfirm}>开始下载</button>
    {#if onsaveas !== undefined}
      <!-- 双形态二（Task 7）：泵字节 tee 直写 FS writable 落盘 + 渲染并行（句柄已
           在确认卡点击的 user gesture 内选定，ViewerPane effect 重跑消费） -->
      <button type="button" class="vv-dl-confirm-saveas" onclick={onsaveas}>下载并另存为</button>
    {/if}
    <button type="button" class="vv-dl-confirm-cancel" onclick={oncancel}>取消</button>
  </div>
</div>
