<script lang="ts">
  import type { OutlineEntry } from '@bhxch/vviewer-highlight';
  import { OUTLINE_EXPAND_ALL_TEXT, OUTLINE_TRUNCATE_TEXT } from './outlineTruncate';
  import { outlineLogicalDepths } from './outlineDepth';

  /**
   * 代码大纲视图（code-outline Task 3）：entries 由 AppShell 传入——ViewerPane
   * onoutline 上行（code 全量实例 tags.scm 提取，T1/T2 契约）经 AppShell
   * outlineDefinitions 单源过滤（评审 Minor 2：reference.* 不进大纲视图，本组件
   * 直接吃过滤后定义条目，不重复过滤）。
   * - kind 展示名剥 definition. 前缀映射常用中文（未收录显示原词）
   * - depth 缩进树（过滤后栈重算逻辑深度——单点 outlineDepth.ts；钳制 8 层防深嵌套
   *   爆版面——spec §3 builder 裁决，12px/层）
   * - 点击经 onclick(line) 上抛：AppShell 写激活 tab pendingLine（1 起）+ rev++
   *   触发重跑消费（GlobalSearchPanel 同款通道），本组件零实例依赖（tab 从父层来）
   * - activeLine = AppShell 滚动跟随节流循环二分得的激活条目 line（0 起）；同行
   *   多条目（同位双捕获，罕见）一并高亮，不放宽为猜测单选
   * - 空 entries 由父层门控（目录视图仅在 outlineDefinitions.length > 0 时切到本组件）
   * - 门限截断（>2000 条折叠 + 展开全部）：entries 是 AppShell outlineDisplayed
   *   显示集（未展开时前 OUTLINE_TRUNCATE_LIMIT 条，切片口径单点在 outlineTruncate），
   *   本组件零截断逻辑；truncated 在场渲染提示条 + 「全部展开」（onexpandall 上抛
   *   AppShell 翻展开态），展开后 entries 变全量、提示条随 truncated 消失
   */
  let {
    entries,
    activeLine,
    onclick,
    truncated = false,
    onexpandall
  }: {
    entries: OutlineEntry[];
    activeLine?: number;
    onclick?: (line: number) => void;
    truncated?: boolean;
    onexpandall?: () => void;
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

  /**
   * 缩进层级重归一（栈重算）单点 outlineDepth.ts：提取端 depth 按全量 raw 口径栈深计
   * （highlight 包 outline.ts pairsToOutline，reference.* 同样入栈），AppShell 过滤
   * 引用后直读会缩进跳层。byte 区间开放栈重跑提取端同款循环 = 显示集真实祖先计数
   * （算法与 raw depth 栈的区别证据见 outlineDepth.test.ts real·SIBLING 用例）。
   * 只依赖 entries（activeLine 变化不重算，OUT-11 性能面一致）。
   */
  const depths = $derived(outlineLogicalDepths(entries));
</script>

<nav class="vv-outline" aria-label="代码大纲">
  {#if truncated}
    <!-- 门限截断提示条（文案/门限常量单点 outlineTruncate）：置列表顶部——容器
         overflow:auto，置尾部初始不可见须滚 2000 条才能发现；「全部展开」经
         onexpandall 上抛 AppShell 翻展开态（显示集切片取消，entries 变全量） -->
    <div class="vv-outline-truncate" role="note">
      <span class="vv-outline-truncate-text">{OUTLINE_TRUNCATE_TEXT}</span>
      <button type="button" class="vv-outline-expand" onclick={() => onexpandall?.()}>
        {OUTLINE_EXPAND_ALL_TEXT}
      </button>
    </div>
  {/if}
  <ul>
    {#each entries as e, i (e.byteStart + ':' + i)}
      <li style="padding-left: {(depths[i] ?? 0) * 12}px">
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

<style>
  /* 截断提示条（组件内 scoped——落点约简，app.css 全局段不加规则；特异性
     (0,2,0) 压过 .vv-outline button (0,1,1) 的全局钮基座，展开钮形态自持）。
     提示条在滚动流顶部：初始未滚动窗口恒可见——置尾部则须滚过全部条目才能发现 */
  .vv-outline-truncate {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px 8px;
    font-size: var(--vv-fs-xs);
    color: var(--ui-fg-muted);
  }
  .vv-outline-truncate-text {
    min-width: 0;
  }
  .vv-outline-expand {
    flex: none;
    /* width:auto / font-size:inherit 压过全局钮基座（app.css .vv-outline button 的
       width:100% 与 --vv-fs-sm）：width:100% 未覆写时 basis:auto 取全宽且 shrink:0
       横贯整条，同排文案 span（shrink:1）被压塌到 0 宽 */
    width: auto;
    padding: 2px 10px;
    border: 1px solid var(--ui-border);
    border-radius: var(--vv-radius-sm, 4px);
    color: var(--ui-fg);
    font-size: inherit;
    cursor: pointer;
  }
  .vv-outline-expand:hover {
    background: var(--ui-hover-bg);
  }
</style>
