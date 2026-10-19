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
  import { fileMeta, setInspectorLittle, exportState, getExportDoc } from './metaStore.svelte';
  import { tabStore } from './openFlow.svelte';
  import {
    collectExportHtml,
    collectPrintHtml,
    exportBaseCss
  } from '@vviewer/render-text/markdown/export';
  import {
    downloadExport,
    exportFileName,
    printDocument,
    repaintMermaidForPrint,
    resolveExportImage
  } from './markdownExport';

  /** 手选打开方式（MetaPanel 由 AppShell 渲染、非 ViewerPane 子组件，故回调
   * 经 tabStore 单例直连而非 prop 下传）：'' = 自动（清 override），其余写 override */
  function onOpenWith(id: string): void {
    const tab = tabStore.list.find((t) => t.active);
    if (!tab) return;
    tabStore.setRendererOverride(tab.id, id === '' ? null : id);
  }

  // ---------- 导出动作区（md-export Task 2，spec 2026-10-19 §6/§7） ----------
  // 可见性走 metaStore.exportState.available（markdown 实例 getExportDocument 句柄
  // 可得性，ViewerPane 上行）；两钮共享装配链：实例句柄取克隆 doc →（PDF 路径先
  // mermaid 浅色重画）→ collectExportHtml 自包含 HTML → HTML 钮 Blob 下载 / PDF 钮
  // collectPrintHtml 包打印模板经隐藏 iframe 唤起系统打印（二选一不并存的主路径，
  // 被策略拦截经 notice 降级提示不静默）。连点防抖用 exportBusy。

  let exportBusy = $state(false);
  let exportNotice = $state('');

  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /** 降级/结果提示（不静默）：4s 自动消退 */
  function showNotice(text: string): void {
    exportNotice = text;
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      exportNotice = '';
      noticeTimer = null;
    }, 4000);
  }

  /** 导出样式合成（spec §6）：基础排版单源常量（export.ts exportBaseCss）+ 当前
   * 生效主题两块（style#vv-code-theme 的 --vv-ts-* 与 --hljs-* 及 UI vars，与预留
   * 的 style#vv-font——字体系统落地后自动带上，缺节点跳过）。 */
  function currentStyleCss(): string {
    const parts = [exportBaseCss];
    for (const id of ['vv-code-theme', 'vv-font']) {
      const el = document.getElementById(id) as HTMLStyleElement | null;
      if (el?.textContent) parts.push(el.textContent);
    }
    return parts.join('\n');
  }

  /** 克隆 doc 的亮暗标记（exportBaseCss 暗块键 html[data-vv-mode]）：取当前注入
   * 的代码主题节点 dataset.mode（theme.ts applyAppearance 写入），缺失回退亮色。
   * data-theme-mode 同步打标（终审 I1）：注入主题文本的选择器含
   * :root[data-theme-mode="dark"] 提权形态（theme.ts THEME_ROOT_SELECTOR，0,2,0），
   * 只打 data-vv-mode 时注入文本仅裸 :root（0,1,0）生效，暗色下变量会被
   * exportBaseCss 的 (0,2,0) 暗块默认值压制——双属性使注入块以同特异性 + 文档序
   * 在后（currentStyleCss 中 exportBaseCss 先行）稳定胜出。 */
  function stampMode(doc: Document): void {
    const mode = (document.getElementById('vv-code-theme') as HTMLStyleElement | null)?.dataset.mode;
    doc.documentElement.setAttribute('data-vv-mode', mode === 'dark' ? 'dark' : 'light');
    doc.documentElement.setAttribute('data-theme-mode', mode === 'dark' ? 'dark' : 'light');
  }

  /** 共享装配：模式标记 + 基础/主题样式 + KaTeX 排印样式（Task 2b 全嵌上限形态，
   * 惰性 chunk 点击才加载；装配失败降级为无排印不阻断导出）→ 自包含 HTML。 */
  async function assembleExportHtml(doc: Document): Promise<string> {
    stampMode(doc);
    let katexCss: string | undefined;
    try {
      katexCss = (await import('./katexExportCss')).buildKatexExportCss();
    } catch {
      katexCss = undefined; // 排印样式装配失败：与修复前的无排印形态一致
    }
    return collectExportHtml(doc, {
      title: fileMeta.name,
      styleCss: currentStyleCss(),
      katexCss,
      resolveImage: resolveExportImage
    });
  }

  async function onExportHtml(): Promise<void> {
    if (exportBusy) return;
    exportBusy = true;
    try {
      const doc = getExportDoc();
      if (!doc) {
        showNotice('导出快照不可用，请重新打开文件后再试');
        return;
      }
      const html = await assembleExportHtml(doc);
      downloadExport(html, exportFileName(fileMeta.name, 'html'));
      showNotice('已导出 HTML');
    } catch (err) {
      showNotice(`导出 HTML 失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      exportBusy = false;
    }
  }

  async function onExportPdf(): Promise<void> {
    if (exportBusy) return;
    exportBusy = true;
    try {
      // PDF 独立装配链：克隆 doc 先 mermaid 浅色重画（spec §7，HTML 导出保持当前
      // 主题 WYSIWYG 不走此步）再 collectExportHtml → collectPrintHtml 包打印模板
      const doc = getExportDoc();
      if (!doc) {
        showNotice('导出快照不可用，请重新打开文件后再试');
        return;
      }
      await repaintMermaidForPrint(doc);
      const printSource = await assembleExportHtml(doc);
      const printHtml = collectPrintHtml(printSource, { page: 'a4' });
      printDocument(printHtml, () =>
        showNotice('当前环境无法唤起打印，请改用浏览器菜单打印并另存为 PDF')
      );
      showNotice('已唤起系统打印，请在对话框中选择「另存为 PDF」');
    } catch (err) {
      showNotice(`导出 PDF 失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      exportBusy = false;
    }
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
    {#if fileMeta.name && exportState.available}
      <div class="meta-export">
        <span class="meta-export-title">导出</span>
        <div class="meta-export-actions">
          <button type="button" class="meta-export-btn" onclick={onExportHtml} disabled={exportBusy}>导出 HTML</button>
          <button type="button" class="meta-export-btn" onclick={onExportPdf} disabled={exportBusy}>导出 PDF</button>
        </div>
        {#if exportNotice}<p class="meta-export-notice" role="status">{exportNotice}</p>{/if}
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
