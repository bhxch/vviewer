<script lang="ts">
  // 元数据面板（BUG-04 兑付 M4 占位）：读 metaStore 的模块级状态展示当前活动
  // 文件的名称/大小/编码/语言/行数/来源。数据由 ViewerPane 渲染实例的 getMeta
  // 写入（code 含行列；媒体/图片等渲染器至少大小与编码），错误卡片/tab 空时显示占位。
  // 「打开方式」下拉（C 项入口 B）：候选与选中态来自 fileMeta.openWith（ViewerPane
  // 渲染成功时上行）；change 经 tabStore.setRendererOverride 写 override（选「自动」
  // = null 清 override 回自动路由）——rev++ 复用渲染 effect 重跑通道即时生效。
  // 「数据检查器」区块（hex 增强 Task 3）：值表与光标偏移来自 fileMeta.inspector
  // （ViewerPane 轮询 hex 实例 getInspector 上行）；字节序 select 写 inspectorBus
  // （模块级 $state 总线下行，ViewerPane 探测 hex 实例 setLittle 透传——本组件
  // 无 props 是 C 项约束）。样式在 app.css（区块全局类，与 .meta-list 同层）。
  import { fileMeta, setInspectorLittle } from './metaStore.svelte';
  import { tabStore } from './openFlow.svelte';

  /** 手选打开方式（MetaPanel 由 AppShell 渲染、非 ViewerPane 子组件，故回调
   * 经 tabStore 单例直连而非 prop 下传）：'' = 自动（清 override），其余写 override */
  function onOpenWith(id: string): void {
    const tab = tabStore.list.find((t) => t.active);
    if (!tab) return;
    tabStore.setRendererOverride(tab.id, id === '' ? null : id);
  }
</script>

<section class="meta-panel">
  <h2 class="meta-title">属性</h2>
  {#if fileMeta.name}
    <dl class="meta-list">
      <div class="meta-row"><dt>名称</dt><dd class="meta-name">{fileMeta.name}</dd></div>
      {#if fileMeta.openWith}
        <div class="meta-row">
          <dt>打开方式</dt>
          <dd>
            <select
              class="meta-openwith"
              aria-label="打开方式"
              value={fileMeta.openWith.current}
              onchange={(e) => onOpenWith(e.currentTarget.value)}
            >
              {#each fileMeta.openWith.options as opt (opt.id)}
                <option value={opt.id}>{opt.label}</option>
              {/each}
            </select>
            {#if fileMeta.openWith.manual}<span class="meta-openwith-manual">（手动）</span>{/if}
          </dd>
        </div>
      {/if}
      {#if fileMeta.size !== null}
        <div class="meta-row"><dt>大小</dt><dd>{fileMeta.size} 字节</dd></div>
      {/if}
      {#if fileMeta.encoding}
        <div class="meta-row"><dt>编码</dt><dd>{fileMeta.encoding}</dd></div>
      {/if}
      {#if fileMeta.lang}
        <div class="meta-row"><dt>语言</dt><dd>{fileMeta.lang}</dd></div>
      {/if}
      {#if fileMeta.lines !== null}
        <div class="meta-row"><dt>行数</dt><dd>{fileMeta.lines}</dd></div>
      {/if}
      {#if fileMeta.sourceLabel}
        <div class="meta-row"><dt>来源</dt><dd>{fileMeta.sourceLabel}</dd></div>
      {/if}
    </dl>
    {#if fileMeta.inspector}
      <div class="meta-inspector">
        <div class="meta-inspector-head">
          <span class="meta-inspector-title">数据检查器</span>
          <span class="meta-inspector-offset">@ 0x{fileMeta.inspector.offset.toString(16)}</span>
          <select
            class="meta-inspector-little"
            aria-label="字节序"
            value={fileMeta.inspector.little ? 'little' : 'big'}
            onchange={(e) => setInspectorLittle(e.currentTarget.value === 'little')}
          >
            <option value="little">小端</option>
            <option value="big">大端</option>
          </select>
        </div>
        <dl class="meta-list">
          {#each fileMeta.inspector.rows as row (row.label)}
            <div class="meta-row" class:meta-unavailable={!row.available}>
              <dt>{row.label}</dt><dd>{row.value}</dd>
            </div>
          {/each}
        </dl>
      </div>
    {/if}
  {:else}
    <p class="meta-empty">未打开文件</p>
  {/if}
</section>

<style>
  .meta-list {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
  }
  .meta-row {
    display: flex;
    gap: 6px;
    min-width: 0;
  }
  .meta-row dt {
    color: var(--ui-fg-muted);
    flex: none;
    width: 2.6em;
  }
  .meta-row dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .meta-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta-openwith {
    font: inherit;
    max-width: 100%;
  }
  .meta-openwith-manual {
    color: var(--ui-fg-muted);
  }
</style>
