<script lang="ts">
  // DiagramsSection.svelte — 设置中心「图表」节（settings center spec §2）。
  // 自 SettingsPanel 图表节原样迁移（markdown diagrams spec 2026-10-19 §2.1，设置
  // 中心 Task 1）：kroki host + 按语言模式网格，键恒为注册表 t.id。改动写
  // draft.diagrams 后调 touch()——落盘与生效时机由 SettingsCenter 统一决定
  // （改动不回溯重渲已打开文档，重新打开后生效）。
  import { DIAGRAM_TYPES, type DiagramMode } from '@vviewer/render-text/markdown/diagrams';
  import type { Settings } from '../stores/settings';

  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  /** Kroki host 输入：非法值（非 http(s):// 开头）由 loadSettings 白名单在下次
   * 读取时归位空串 = 默认 https://kroki.io（diagrams.ts 回落）。 */
  function onKrokiHostInput(e: Event): void {
    draft.diagrams.krokiHost = (e.currentTarget as HTMLInputElement).value.trim();
    touch();
  }

  /** 按语言模式切换：键恒为注册表类型 id（t.id，不用别名）——已打开文档不回溯
   * 重渲，重新打开后生效。 */
  function onDiagramModeChange(id: string, e: Event): void {
    draft.diagrams.modes = { ...draft.diagrams.modes, [id]: (e.currentTarget as HTMLSelectElement).value as DiagramMode };
    touch();
  }
</script>

<section class="vv-sc-section">
  <div class="vv-settings-label">图表</div>
  <label class="vv-settings-theme-row">
    <span>Kroki 服务</span>
    <input
      type="text"
      placeholder="https://kroki.io"
      value={draft.diagrams.krokiHost}
      oninput={onKrokiHostInput}
      aria-label="Kroki 服务地址"
      spellcheck="false"
    />
  </label>
  <div class="vv-settings-diagram-modes">
    <span>渲染模式</span>
    <div class="vv-diagram-mode-grid">
      {#each DIAGRAM_TYPES as t (t.id)}
        <label class="vv-diagram-mode-item">
          <span class="vv-diagram-mode-lang">{t.id}</span>
          <select
            value={draft.diagrams.modes[t.id] ?? t.defaultMode}
            onchange={(e) => onDiagramModeChange(t.id, e)}
            aria-label="{t.id} 渲染模式"
          >
            <option value="local">本地</option>
            <option value="kroki">Kroki</option>
            <option value="source">源码</option>
          </select>
        </label>
      {/each}
    </div>
  </div>
  <div class="vv-settings-hint">
    本地引擎支持 mermaid/graphviz/nomnoml/公式/svgbob 与 excalidraw/bpmn/vega/vegalite（CDN 按需加载），
    其余语言本地档自动回落 Kroki；Kroki 服务填 http(s):// 开头地址，留空用 https://kroki.io。
    改动对已打开文档重新打开后生效。
  </div>
</section>
