<script lang="ts">
  import type { OutlineEntry } from '@bhxch/vviewer-highlight';

  /**
   * 代码大纲视图（code-outline Task 3）：entries 由 AppShell 传入——ViewerPane
   * onoutline 上行（code 全量实例 tags.scm 提取，T1/T2 契约）经 AppShell
   * outlineDefinitions 单源过滤（评审 Minor 2：reference.* 不进大纲视图，本组件
   * 直接吃过滤后定义条目，不重复过滤）。
   * - kind 展示名剥 definition. 前缀映射常用中文（未收录显示原词）
   * - depth 缩进树（钳制 8 层防深嵌套爆版面——spec §3 builder 裁决，12px/层）
   * - 点击经 onclick(line) 上抛：AppShell 写激活 tab pendingLine（1 起）+ rev++
   *   触发重跑消费（GlobalSearchPanel 同款通道），本组件零实例依赖（tab 从父层来）
   * - activeLine = AppShell 滚动跟随节流循环二分得的激活条目 line（0 起）；同行
   *   多条目（同位双捕获，罕见）一并高亮，不放宽为猜测单选
   * - 空 entries 由父层门控（目录视图仅在 outlineDefinitions.length > 0 时切到本组件）
   */
  let {
    entries,
    activeLine,
    onclick
  }: {
    entries: OutlineEntry[];
    activeLine?: number;
    onclick?: (line: number) => void;
  } = $props();

  /** kind 短名 → 展示名（tags.scm 高频捕获实测枚举：现盘全量 @definition.* grep
   * 取头部；未收录的残余词形——如 strictdoc 的 section.uid——显示原词不猜测） */
  const KIND_LABELS: Record<string, string> = {
    function: '函数',
    method: '方法',
    class: '类',
    struct: '结构体',
    interface: '接口',
    enum: '枚举',
    type: '类型',
    module: '模块',
    namespace: '命名空间',
    constant: '常量',
    variable: '变量',
    property: '属性',
    field: '字段',
    macro: '宏',
    union: '联合',
    trait: '特质',
    object: '对象',
    constructor: '构造函数',
    section: '小节',
    name: '符号'
  };

  /** 引用条目已由 AppShell outlineDefinitions 单源过滤（props 契约），本组件直吃 */
  function kindLabel(kind: string): string {
    const short = kind.startsWith('definition.') ? kind.slice('definition.'.length) : kind;
    return KIND_LABELS[short] ?? short;
  }

  /** 缩进层级（spec §3：depth 钳制 8 层） */
  function depthOf(e: OutlineEntry): number {
    return Math.min(e.depth, 8);
  }
</script>

<nav class="vv-outline" aria-label="代码大纲">
  <ul>
    {#each entries as e, i (e.byteStart + ':' + i)}
      <li style="padding-left: {depthOf(e) * 12}px">
        <button
          type="button"
          class:active={activeLine !== undefined && e.line === activeLine}
          title={e.name}
          onclick={() => onclick?.(e.line)}
        >
          <span class="vv-outline-kind">{kindLabel(e.kind)}</span>
          <span class="vv-outline-name">{e.name}</span>
        </button>
      </li>
    {/each}
  </ul>
</nav>
