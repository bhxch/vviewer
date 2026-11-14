<script lang="ts">
  import type { TocEntry } from '@bhxch/vviewer-core';
  import type { OutlineEntry } from '@bhxch/vviewer-highlight';
  import OutlineView from './OutlineView.svelte';
  import Toc from './Toc.svelte';
  import MetaPanel from './MetaPanel.svelte';

  /**
   * 目录视图装配件（spec A Task 2，原 AppShell 右栏 'toc' 分支原样抽出）：md TOC
   * 与代码大纲的互斥装配单点，右栏（本 task 换挂）/ 左栏目录 tab（Task 3）/
   * zen 目录视图（Task 4）三消费点共用同一装配件。
   * - 互斥规则与原右栏分支逐字节等价：outlineDisplayed 在场渲染代码大纲（引用已
   *   过滤的显示集），否则 md TOC；两者皆空回落 MetaPanel 兜底空态（右栏 touched
   *   后无数据路径仍可达——校正 effect 随即归位 'meta'；左栏/zen 消费点数据被门控，
   *   兜底仅瞬时态无害）
   * - 纯装配组件：传参面与滚动跟随数据流零改动——outlineDisplayed 是 AppShell 引用
   *   过滤 + outlineDisplaySlice 门限切片后的显示集（切片口径单点在 outlineTruncate），
   *   activeLine 是跟随二分结果，跳转/全部展开经回调上行 AppShell 消费（pendingLine
   *   通道单点在 AppShell）；本组件不触 metaStore 总线、不持状态（B1 三层形态）
   * - 根元素不引入新容器：三分支组件原样输出（.vv-outline / .toc / .meta-panel
   *   直接成为消费点滚动体的 flex 子项，多包一层 div 会改变子项布局语义）
   */
  let {
    /** md TOC 全量（AppShell tocEntries 直传） */
    tocEntries,
    /** 代码大纲显示集（AppShell 引用过滤 + 门限切片后的 outlineDisplayed 直传） */
    outlineDisplayed,
    /** 跟随高亮行（0 起大纲条目 line；undefined = 跟随未启用） */
    activeLine,
    /** 大纲点击跳转上抛（AppShell 写 pendingLine 消费） */
    onOutlineJump,
    /** 截断态旗标（>门限未展开；提示条 + 「全部展开」在场与否） */
    outlineTruncated,
    /** 「全部展开」动作上抛（AppShell 翻展开态、切片取消） */
    onExpandAll
  }: {
    tocEntries: TocEntry[];
    outlineDisplayed: OutlineEntry[];
    activeLine?: number;
    onOutlineJump?: (line: number) => void;
    outlineTruncated?: boolean;
    onExpandAll?: () => void;
  } = $props();
</script>

{#if outlineDisplayed.length > 0}
  <OutlineView
    entries={outlineDisplayed}
    activeLine={activeLine}
    onclick={onOutlineJump}
    truncated={outlineTruncated}
    onexpandall={onExpandAll}
  />
{:else if tocEntries.length > 0}
  <Toc entries={tocEntries} />
{:else}
  <MetaPanel />
{/if}
