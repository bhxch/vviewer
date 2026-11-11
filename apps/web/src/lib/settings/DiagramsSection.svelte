<script lang="ts">
  // DiagramsSection.svelte — 设置中心「图表」节（settings center spec §2）。
  // 自 SettingsPanel 图表节原样迁移（markdown diagrams spec 2026-10-19 §2.1，设置
  // 中心 Task 1）：kroki host + kroki 通道 + 按语言模式网格，键恒为注册表 t.id。
  // 改动写 draft.diagrams 后调 touch()——落盘与生效时机由 SettingsCenter 统一决定
  // （改动不回溯重渲已打开文档，重新打开后生效）。
  // spec 2026-10-23 §8.3（Task 5）：krokiVia 通道 select（server=服务端代发，能力
  // 缺失时 option 禁用+hint 说明）与模式网格的「服务端」选项（注册表 server 旗标
  // 门控=graphviz/svgbob；运行时能力协商以 health diagrams 子集为准，见 viewer.ts
  // 注入）。krokiProxy 组件挂载时读会话缓存（loadCapabilities try/catch 对 SSR/
  // 无记录安全，RemoteSourceModal loadLastServer 同款先例）。
 // spec 2026-10-23 §9.1（Task 6）：多渲染器类型第二列渲染器 select（注册表
 // dt.renderers 门控=graphviz: viz-js/hpcc；缺省显示注册表首项 viz-js）。
 // 模式档位按注册表能力门控（本地=dt.local、Kroki=dt.krokiType，同「服务端」
 // dt.server 先例只列实际可用的档位）；遗留脏档经 displayMode 按回落链如实显示。
  import { DIAGRAM_TYPES, type DiagramMode, type DiagramType } from '@bhxch/vviewer-render-diagram';
  import { loadCapabilities } from '../openFlow.svelte';
  import { t } from '../i18n/index.svelte';
  import type { Settings } from '../stores/settings';

  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  /** kroki 服务端代发能力（capabilities 'kroki-proxy' 恒宣告项；未连接=false）。 */
  const krokiProxy = loadCapabilities().includes('kroki-proxy');

  /** Kroki host 输入：非法值（非 http(s):// 开头）由 loadSettings 白名单在下次
   * 读取时归位空串 = 默认 https://kroki.io（diagrams.ts 回落）。 */
  function onKrokiHostInput(e: Event): void {
    draft.diagrams.krokiHost = (e.currentTarget as HTMLInputElement).value.trim();
    touch();
  }

  /** kroki 通道切换（spec §8.3）：client=前端直连 img；server=部署侧 /api/kroki 代发。 */
  function onKrokiViaChange(e: Event): void {
    draft.diagrams.krokiVia = (e.currentTarget as HTMLSelectElement).value as 'client' | 'server';
    touch();
  }

  /** mermaid 主题切换（spec §9.2）：'auto'=跟随外观亮暗（现状语义）；显式五枚举
   * 经 settings 保存路径派发 vv:diagram-settings-applied 即时重画已打开文档。 */
  function onMermaidThemeChange(e: Event): void {
    draft.diagrams.mermaidTheme = (e.currentTarget as HTMLSelectElement).value as Settings['diagrams']['mermaidTheme'];
    touch();
  }

  /** 模式下拉的显示值：注册表不支持的档位不渲染 option（本地/Kroki 门控与
   * 「服务端」dt.server、「官方服务器」dt.officialServer 同款先例），遗留脏档
   * （旧版本地为不可本地语言存过 local、手改 JSON 为 math 存过 kroki/official 等）
   * 按管线 effectiveModeOf 的回落链如实显示，避免选中值落在隐藏 option 上显示成空。 */
  function displayMode(dt: DiagramType): DiagramMode {
    const stored = draft.diagrams.modes[dt.id] ?? dt.defaultMode;
    if (stored === 'local' && !dt.local) return dt.krokiType ? 'kroki' : 'source';
    if (stored === 'kroki' && !dt.krokiType) return 'source';
    if (stored === 'server' && !dt.server) return dt.local ? 'local' : dt.krokiType ? 'kroki' : 'source';
    if (stored === 'official' && !dt.officialServer) return dt.local ? 'local' : dt.krokiType ? 'kroki' : 'source';
    return stored;
  }

  /** 按语言模式切换：键恒为注册表类型 id（dt.id，不用别名）——已打开文档不回溯
   * 重渲，重新打开后生效。 */
  function onDiagramModeChange(id: string, e: Event): void {
    draft.diagrams.modes = { ...draft.diagrams.modes, [id]: (e.currentTarget as HTMLSelectElement).value as DiagramMode };
    touch();
  }

  /** 按语言渲染器切换（spec §9.1）：键恒为注册表类型 id；值经 loadSettings 白名单
   * （注册表 renderers 选择面）裁决，未配置/空 = 注册表默认渲染器。 */
  function onDiagramRendererChange(id: string, e: Event): void {
    draft.diagrams.renderers = { ...draft.diagrams.renderers, [id]: (e.currentTarget as HTMLSelectElement).value };
    touch();
  }
</script>

<section class="vv-sc-section">
  <div class="vv-settings-label">{t('settings.diagrams.label')}</div>
  <label class="vv-settings-theme-row">
    <span>{t('settings.diagrams.krokiRow')}</span>
    <input
      type="text"
      placeholder="https://kroki.io"
      value={draft.diagrams.krokiHost}
      oninput={onKrokiHostInput}
      aria-label={t('settings.diagrams.krokiAria')}
      spellcheck="false"
    />
  </label>
  <div class="vv-settings-hint">{t('settings.diagrams.krokiHint')}</div>
  <label class="vv-settings-theme-row">
    <span>{t('settings.diagrams.viaRow')}</span>
    <select value={draft.diagrams.krokiVia} onchange={onKrokiViaChange} aria-label={t('settings.diagrams.viaAria')}>
      <option value="client">{t('settings.diagrams.viaClient')}</option>
      <option value="server" disabled={!krokiProxy}>{t('settings.diagrams.viaServer')}</option>
    </select>
  </label>
  <div class="vv-settings-hint">{t('settings.diagrams.viaHint')}</div>
  <label class="vv-settings-theme-row">
    <span>{t('settings.diagrams.mermaidRow')}</span>
    <select value={draft.diagrams.mermaidTheme} onchange={onMermaidThemeChange} aria-label={t('settings.diagrams.mermaidAria')}>
      <option value="auto">{t('settings.diagrams.mermaidAuto')}</option>
      <option value="default">{t('settings.diagrams.mermaidDefault')}</option>
      <option value="neutral">{t('settings.diagrams.mermaidNeutral')}</option>
      <option value="dark">{t('settings.diagrams.mermaidDark')}</option>
      <option value="forest">{t('settings.diagrams.mermaidForest')}</option>
      <option value="base">{t('settings.diagrams.mermaidBase')}</option>
    </select>
  </label>
  <div class="vv-settings-hint">{t('settings.diagrams.mermaidHint')}</div>
  <div class="vv-settings-diagram-modes">
    <span>{t('settings.diagrams.modesRow')}</span>
    <div class="vv-diagram-mode-grid">
      {#each DIAGRAM_TYPES as dt (dt.id)}
        <label class="vv-diagram-mode-item">
          <span class="vv-diagram-mode-lang">{dt.id}</span>
          {#if dt.renderers?.length}
            <select
              class="vv-diagram-renderer"
              value={draft.diagrams.renderers[dt.id] ?? dt.renderers[0]}
              onchange={(e) => onDiagramRendererChange(dt.id, e)}
              aria-label={t('settings.diagrams.rendererAria', { id: dt.id })}
            >
              {#each dt.renderers as r (r)}<option value={r}>{r}</option>{/each}
            </select>
          {/if}
          <select
            value={displayMode(dt)}
            onchange={(e) => onDiagramModeChange(dt.id, e)}
            aria-label={t('settings.diagrams.modeAria', { id: dt.id })}
          >
            {#if dt.local}<option value="local">{t('settings.diagrams.modeLocal')}</option>{/if}
            {#if dt.server}<option value="server">{t('settings.diagrams.modeServer')}</option>{/if}
            {#if dt.krokiType}<option value="kroki">Kroki</option>{/if}
            {#if dt.officialServer}<option value="official">{t('settings.diagrams.modeOfficial')}</option>{/if}
            <option value="source">{t('settings.diagrams.modeSource')}</option>
          </select>
        </label>
      {/each}
    </div>
  </div>
  <div class="vv-settings-hint">
    {t('settings.diagrams.gridHint')}
  </div>
</section>
