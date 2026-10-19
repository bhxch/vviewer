<script lang="ts">
  // SettingsPanel.svelte — 设置面板浮层（BUG-05，SHELL-09/13 + SRV-07）。
  // TopBar 以 ⚙ 挂载（Ctrl+comma 切换）：排除规则编辑（条目删除/手动添加/预设
  // 一键加入）、autoRefresh 开关（关闭后目录树 SSE 自动同步停用，手动刷新 ↻
  // 不受影响）、界面主题管理（spec B §2.3：亮暗双槽 select + JSON/VSIX 导入 +
  // 已导入列表删除；槽切换/删除归位只经 saveSettings 持久化，注入由 TopBar 的
  // onSettingsChanged 订阅 diff 触发——订阅即注入通道，本面板不直调注入，
  // spec 2026-10-12 §2.4）、图表渲染（spec 2026-10-19 §2.1：kroki host +
  // 按语言模式网格，键恒为注册表 t.id；改动不回溯重渲已打开文档，下次打开生效）、
  // 字体（字体系统 spec 2026-10-19 §4/§5.3 上半：UI/代码两槽 picker = 预设下拉 +
  // 「自定义…」手输框 + 字号 number input；下半网络字体管理列表为 Task 5）。
  // 修改即时经 saveSettings 持久化，AppShell 经
  // onSettingsChanged 订阅刷新响应式副本（FileTree 随排除规则重建）。Esc / ✕ 关闭。
  import { DIAGRAM_TYPES, type DiagramMode } from '@vviewer/render-text/markdown/diagrams';
  import { loadSettings, saveSettings, CODE_SIZE_RANGE, UI_SIZE_RANGE } from './stores/settings';
  import { deleteTheme, listThemes, type ImportedTheme } from './stores/session';
  import { importThemeFiles } from './vsixImport';
  import {
    CODE_FONT_PRESETS,
    CUSTOM_FONT_SENTINEL,
    FONT_SPECIMEN,
    UI_FONT_PRESETS,
    fontFamilyOptions,
    type FontPreset
  } from './fonts';
  import { DEFAULT_CODE_FONT_STACK, DEFAULT_UI_FONT_STACK, fontFamilyValue } from './theme';

  let { onclose }: { onclose(): void } = $props();

  /** 面板本地草稿：打开时从 localStorage 读一次；保存时合并最新持久值 */
  let patterns = $state<string[]>([...loadSettings().excludedPatterns]);
  let autoRefresh = $state(loadSettings().autoRefresh);
  let appearanceLight = $state(loadSettings().appearanceLight);
  let appearanceDark = $state(loadSettings().appearanceDark);
  let krokiHost = $state(loadSettings().diagrams.krokiHost);
  let diagramModes = $state<Record<string, DiagramMode>>({ ...loadSettings().diagrams.modes });
  // 字体节草稿（字体系统 spec §4 上半）：family '' = 默认栈；手输模式按打开时的
  // 槽值初始化（自定义族重开面板立即可编辑，不必再点一次「自定义…」）
  let uiFamily = $state(loadSettings().fonts.uiFamily);
  let uiSize = $state(loadSettings().fonts.uiSize);
  let codeFamily = $state(loadSettings().fonts.codeFamily);
  let codeSize = $state(loadSettings().fonts.codeSize);
  let uiCustomMode = $state(isCustomFamily(loadSettings().fonts.uiFamily, UI_FONT_PRESETS));
  let codeCustomMode = $state(isCustomFamily(loadSettings().fonts.codeFamily, CODE_FONT_PRESETS));
  const uiOptions = fontFamilyOptions(UI_FONT_PRESETS);
  const codeOptions = fontFamilyOptions(CODE_FONT_PRESETS);
  let draft = $state('');
  let inputEl = $state<HTMLInputElement | null>(null);
  let panelEl = $state<HTMLElement | null>(null);

  /** 已导入主题（spec B §2.3）：挂载后异步填充，导入/删除后刷新 */
  let imported = $state<ImportedTheme[]>([]);
  let importing = $state(false);
  let importNote = $state('');
  let importErrors = $state<string[]>([]);
  let themeInputEl = $state<HTMLInputElement | null>(null);

  /** 常用排除预设：一键加入（重复添加幂等） */
  const PRESETS: readonly string[] = ['.git', 'node_modules'];

  /** 内置外观候选（spec B §2.3）：值即 theme.ts BUILTIN_APPEARANCES 清单键 + default */
  const APPEARANCE_BUILTINS: readonly { value: string; label: string }[] = [
    { value: 'default', label: '默认' },
    { value: 'vscode:Dark Modern', label: 'Dark Modern (VSCode)' },
    { value: 'vscode:Light Modern', label: 'Light Modern (VSCode)' }
  ];

  /**
   * 外观引用的亮暗归属（spec B §2.3 不匹配提醒用）：内置两主题 kind 已知；
   * imported 主题查已导入列表取 kind 字段（列表未加载/已删除 → null）。
   * default 不归属任一槽（null）。仅用于显示提醒，不阻止选择。
   */
  function appearanceKind(ref: string): 'dark' | 'light' | null {
    if (ref === 'vscode:Dark Modern') return 'dark';
    if (ref === 'vscode:Light Modern') return 'light';
    if (ref.startsWith('imported:')) return imported.find((t) => t.id === ref)?.kind ?? null;
    return null;
  }

  /** 槽与主题亮暗不匹配提醒文案（空串=无不匹配）：与所选主题 kind 反色的槽才提示 */
  const lightWarn = $derived.by(() => {
    const k = appearanceKind(appearanceLight);
    return k === 'dark' ? '已选主题为暗色，与当前亮色槽不匹配（仍会生效）' : '';
  });
  const darkWarn = $derived.by(() => {
    const k = appearanceKind(appearanceDark);
    return k === 'light' ? '已选主题为亮色，与当前暗色槽不匹配（仍会生效）' : '';
  });

  /** 槽位 family 是否为手输值（非默认空栈、也不在预设清单内）→ select 显示「自定义…」 */
  function isCustomFamily(f: string, presets: readonly FontPreset[]): boolean {
    return f !== '' && !presets.some((p) => p.value === f);
  }

  /** select 当前值：自定义态（模式开或值不在预设内）显哨兵，否则即族值本身 */
  const uiSelectValue = $derived(
    uiCustomMode || isCustomFamily(uiFamily, UI_FONT_PRESETS) ? CUSTOM_FONT_SENTINEL : uiFamily
  );
  const codeSelectValue = $derived(
    codeCustomMode || isCustomFamily(codeFamily, CODE_FONT_PRESETS) ? CUSTOM_FONT_SENTINEL : codeFamily
  );

  $effect(() => {
    inputEl?.focus();
  });

  $effect(() => {
    // 已导入列表挂载后异步填充（IndexedDB）；失败（存储不可用）留空不阻塞面板
    void listThemes()
      .then((ts) => (imported = ts.sort((a, b) => a.name.localeCompare(b.name) || a.addedAt - b.addedAt)))
      .catch(() => (imported = []));
  });

  $effect(() => {
    // Esc 全局化兜底（与 GlobalSearchPanel 同模式）：焦点落到面板外时 Esc 也关闭
    const onWinKey = (e: KeyboardEvent): void => {
      if (
        e.key === 'Escape' &&
        panelEl !== null &&
        (e.target instanceof Node ? !panelEl.contains(e.target) : true)
      ) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onWinKey);
    return () => window.removeEventListener('keydown', onWinKey);
  });

  /**
   * 保存：读最新持久值只覆盖本面板管的字段（排除规则/自动刷新/外观双槽/图表/字体）——
   * 面板打开期间 TopBar 若改了主题模式/计算策略，不被面板的旧草稿覆盖。
   */
  function persist(): void {
    const fresh = loadSettings();
    fresh.excludedPatterns = [...patterns];
    fresh.autoRefresh = autoRefresh;
    fresh.appearanceLight = appearanceLight;
    fresh.appearanceDark = appearanceDark;
    fresh.diagrams = { krokiHost: krokiHost.trim(), modes: { ...diagramModes } };
    fresh.fonts = { uiFamily, uiSize, codeFamily, codeSize };
    saveSettings(fresh);
  }

  function addPattern(raw: string): void {
    const v = raw.trim();
    if (v === '' || patterns.includes(v)) return;
    patterns = [...patterns, v];
    persist();
  }

  function removePattern(p: string): void {
    patterns = patterns.filter((x) => x !== p);
    persist();
  }

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    addPattern(draft);
    draft = '';
  }

  function toggleAutoRefresh(): void {
    autoRefresh = !autoRefresh;
    persist();
  }

  /** 槽切换：即时持久化——注入由 TopBar 的 onSettingsChanged 订阅 diff 触发
   * （spec 2026-10-12 §2.4） */
  function onAppearanceChange(slot: 'light' | 'dark', e: Event): void {
    const v = (e.currentTarget as HTMLSelectElement).value;
    if (slot === 'light') appearanceLight = v;
    else appearanceDark = v;
    persist();
  }

  /** Kroki host 输入：即时持久化。非法值（非 http(s):// 开头）由 loadSettings
   * 白名单在下次读取时归位空串 = 默认 https://kroki.io（diagrams.ts 回落）。 */
  function onKrokiHostInput(e: Event): void {
    krokiHost = (e.currentTarget as HTMLInputElement).value.trim();
    persist();
  }

  /** 按语言模式切换：键恒为注册表类型 id（t.id，不用别名）；即时持久化——
   * 已打开文档不回溯重渲，重新打开后生效（spec 2026-10-19 §2.1）。 */
  function onDiagramModeChange(id: string, e: Event): void {
    diagramModes[id] = (e.currentTarget as HTMLSelectElement).value as DiagramMode;
    persist();
  }

  /** 字体槽 picker（字体系统 spec §4）：选「自定义…」只展开手输框不改值不落盘；
   * 选默认/预设收起手输框并即时持久化（saveSettings → Task 1 注入/Task 2 重渲染）。 */
  function onFamilyChange(slot: 'ui' | 'code', e: Event): void {
    const v = (e.currentTarget as HTMLSelectElement).value;
    if (v === CUSTOM_FONT_SENTINEL) {
      if (slot === 'ui') uiCustomMode = true;
      else codeCustomMode = true;
      return;
    }
    if (slot === 'ui') {
      uiCustomMode = false;
      uiFamily = v;
    } else {
      codeCustomMode = false;
      codeFamily = v;
    }
    persist();
  }

  /** 手输 family：即时持久化（空串 = 默认栈语义；多级回退栈原样存储，转义/拆段在注入侧） */
  function onFamilyInput(slot: 'ui' | 'code', e: Event): void {
    const v = (e.currentTarget as HTMLInputElement).value;
    if (slot === 'ui') uiFamily = v;
    else codeFamily = v;
    persist();
  }

  /** 字号输入：即时 clamp（spec §2.1 范围）并持久化；半截/清空输入不落盘，
   * 保留上一有效值——loadSettings 白名单兜底仅防脏 JSON，不在此重复。 */
  function onSizeInput(slot: 'ui' | 'code', e: Event): void {
    const raw = (e.currentTarget as HTMLInputElement).value;
    if (raw.trim() === '') return;
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    const range = slot === 'ui' ? UI_SIZE_RANGE : CODE_SIZE_RANGE;
    const clamped = Math.min(range[1], Math.max(range[0], Math.round(v)));
    if (slot === 'ui') uiSize = clamped;
    else codeSize = clamped;
    persist();
  }

  /** 文件选择 → 导入管线（.json 直读 / .vsix 解包全部主题）：计数通知 + 刷新列表 */
  async function onImportChange(e: Event): Promise<void> {
    const inp = e.currentTarget as HTMLInputElement;
    const files = Array.from(inp.files ?? []); // FileList 非可迭代（该 tsconfig lib 下）→ Array.from
    inp.value = ''; // 允许重复选同一文件
    if (files.length === 0) return;
    importing = true;
    importNote = '';
    importErrors = [];
    try {
      const { imported: ok, errors } = await importThemeFiles(files);
      importErrors = errors;
      importNote = errors.length === 0 ? `已导入 ${ok.length} 个主题` : `已导入 ${ok.length} 个，失败 ${errors.length} 个`;
      imported = [...(await listThemes())].sort((a, b) => a.name.localeCompare(b.name) || a.addedAt - b.addedAt);
    } catch (err) {
      importErrors = [err instanceof Error ? err.message : String(err)];
      importNote = '导入失败';
    } finally {
      importing = false;
    }
  }

  /** 删除已导入主题：确认后删库；仍被槽引用的回 'default'（悬空 id 本有 warn 回退，UI 同步归位）。
   * 删库失败（存储不可用等）只记 console.error，列表/槽保持不动（对齐 onImportChange 的容错风格）。 */
  async function removeImported(t: ImportedTheme): Promise<void> {
    if (!window.confirm(`删除已导入主题「${t.name}」？`)) return;
    try {
      await deleteTheme(t.id);
    } catch (err) {
      console.error(`删除已导入主题「${t.name}」失败`, err);
      return;
    }
    const fresh = loadSettings();
    let changed = false;
    if (fresh.appearanceLight === t.id) {
      fresh.appearanceLight = 'default';
      appearanceLight = 'default';
      changed = true;
    }
    if (fresh.appearanceDark === t.id) {
      fresh.appearanceDark = 'default';
      appearanceDark = 'default';
      changed = true;
    }
    if (changed) {
      // 槽归位只持久化：注入由 TopBar 订阅 diff 触发（spec 2026-10-12 §2.4）
      saveSettings(fresh);
    }
    imported = imported.filter((x) => x.id !== t.id);
  }

  function close(): void {
    // 关闭前记录焦点：面板卸载后还原（与 GlobalSearchPanel 同模式）
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onclose();
    setTimeout(() => {
      if (prev !== null && prev.isConnected) {
        prev.focus();
        return;
      }
      document.querySelector<HTMLElement>('.vv-viewer-host')?.focus();
    }, 0);
  }

  function onpanelkeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
</script>

<div class="vv-settings" role="dialog" aria-label="设置" tabindex="-1" bind:this={panelEl} onkeydown={onpanelkeydown}>
  <div class="vv-settings-head">
    <span class="vv-settings-title">设置</span>
    <button type="button" class="vv-settings-close" aria-label="关闭设置" title="关闭（Esc）" onclick={close}>✕</button>
  </div>

  <section class="vv-settings-sec">
    <div class="vv-settings-label">排除规则</div>
    <div class="vv-settings-hint">命中名称的文件/目录不显示在文件树与快速打开中（如 .git、node_modules；*.log 排除所有 .log 文件）</div>
    {#if patterns.length > 0}
      <ul class="vv-settings-patterns">
        {#each patterns as p (p)}
          <li class="vv-settings-pattern">
            <code>{p}</code>
            <button
              type="button"
              class="vv-settings-remove"
              aria-label="删除排除规则 {p}"
              title="删除"
              onclick={() => removePattern(p)}>✕</button
            >
          </li>
        {/each}
      </ul>
    {:else}
      <div class="vv-settings-empty">暂无排除规则</div>
    {/if}
    <form class="vv-settings-add" onsubmit={submit}>
      <input
        bind:this={inputEl}
        bind:value={draft}
        placeholder="添加名称或 *.后缀"
        aria-label="添加排除规则"
        spellcheck="false"
      />
      <button type="submit" disabled={draft.trim() === ''}>添加</button>
    </form>
    <div class="vv-settings-presets">
      {#each PRESETS as p (p)}
        <button
          type="button"
          disabled={patterns.includes(p)}
          aria-label="加入预设排除规则 {p}"
          onclick={() => addPattern(p)}>+ {p}</button
        >
      {/each}
    </div>
  </section>

  <section class="vv-settings-sec">
    <label class="vv-settings-toggle">
      <input type="checkbox" checked={autoRefresh} onchange={toggleAutoRefresh} />
      <span>自动刷新</span>
    </label>
    <div class="vv-settings-hint">
      连接服务器时内容变更自动重读；关闭后目录树同步停用，可用顶栏 ↻ 手动刷新当前文件与目录树
    </div>
  </section>

  <section class="vv-settings-sec">
    <div class="vv-settings-label">图表</div>
    <label class="vv-settings-theme-row">
      <span>Kroki 服务</span>
      <input
        type="text"
        placeholder="https://kroki.io"
        value={krokiHost}
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
              value={diagramModes[t.id] ?? t.defaultMode}
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
      本地引擎本期支持 mermaid/graphviz/nomnoml/公式，其余语言本地档自动回落 Kroki；Kroki 服务填
      http(s):// 开头地址，留空用 https://kroki.io。改动对已打开文档重新打开后生效。
    </div>
  </section>

  <section class="vv-settings-sec">
    <div class="vv-settings-label">字体</div>
    <label class="vv-settings-theme-row">
      <span>界面字体</span>
      <select value={uiSelectValue} onchange={(e) => onFamilyChange('ui', e)} aria-label="界面字体族">
        {#each uiOptions as o (o.value)}
          <option value={o.value}>{o.label}</option>
        {/each}
      </select>
    </label>
    {#if uiCustomMode}
      <label class="vv-settings-theme-row">
        <span>界面自定义</span>
        <input
          type="text"
          value={uiFamily}
          oninput={(e) => onFamilyInput('ui', e)}
          placeholder="Family 名，逗号分隔多级回退"
          aria-label="自定义界面字体族"
          spellcheck="false"
        />
      </label>
      <div
        class="vv-settings-font-sample"
        style:font-family={fontFamilyValue(uiFamily, DEFAULT_UI_FONT_STACK)}
        style:font-size="{uiSize}px"
      >
        {FONT_SPECIMEN}
      </div>
    {/if}
    <label class="vv-settings-theme-row">
      <span>界面字号</span>
      <input
        type="number"
        min={UI_SIZE_RANGE[0]}
        max={UI_SIZE_RANGE[1]}
        step="1"
        value={uiSize}
        oninput={(e) => onSizeInput('ui', e)}
        aria-label="界面字号（px）"
      />
    </label>
    <label class="vv-settings-theme-row">
      <span>代码字体</span>
      <select value={codeSelectValue} onchange={(e) => onFamilyChange('code', e)} aria-label="代码字体族">
        {#each codeOptions as o (o.value)}
          <option value={o.value}>{o.label}</option>
        {/each}
      </select>
    </label>
    {#if codeCustomMode}
      <label class="vv-settings-theme-row">
        <span>代码自定义</span>
        <input
          type="text"
          value={codeFamily}
          oninput={(e) => onFamilyInput('code', e)}
          placeholder="Family 名，逗号分隔多级回退"
          aria-label="自定义代码字体族"
          spellcheck="false"
        />
      </label>
      <div
        class="vv-settings-font-sample"
        style:font-family={fontFamilyValue(codeFamily, DEFAULT_CODE_FONT_STACK)}
        style:font-size="{codeSize}px"
      >
        {FONT_SPECIMEN}
      </div>
    {/if}
    <label class="vv-settings-theme-row">
      <span>代码字号</span>
      <input
        type="number"
        min={CODE_SIZE_RANGE[0]}
        max={CODE_SIZE_RANGE[1]}
        step="1"
        value={codeSize}
        oninput={(e) => onSizeInput('code', e)}
        aria-label="代码字号（px）"
      />
    </label>
    <div class="vv-settings-hint">
      family 支持逗号分隔多级回退（如 JetBrains Mono, monospace）；本机缺失的字体由浏览器回退。
      代码字号变更后行高联动、已打开文件自动以新行高重排。
    </div>
  </section>

  <section class="vv-settings-sec">
    <div class="vv-settings-label">界面主题</div>
    <div class="vv-settings-hint">
      VSCode 外观主题同时接管代码配色（亮/暗各自记忆，跟随顶栏主题模式）；非默认时顶栏代码主题选择停用
    </div>
    <label class="vv-settings-theme-row">
      <span>亮色</span>
      <select value={appearanceLight} onchange={(e) => onAppearanceChange('light', e)} aria-label="亮色界面主题">
        {#each APPEARANCE_BUILTINS as o (o.value)}
          <option value={o.value}>{o.label}</option>
        {/each}
        {#each imported as t (t.id)}
          <option value={t.id}>{t.name}（{t.kind === 'dark' ? '暗' : '亮'}）</option>
        {/each}
      </select>
    </label>
    {#if lightWarn}
      <div class="vv-settings-warn" role="status">{lightWarn}</div>
    {/if}
    <label class="vv-settings-theme-row">
      <span>暗色</span>
      <select value={appearanceDark} onchange={(e) => onAppearanceChange('dark', e)} aria-label="暗色界面主题">
        {#each APPEARANCE_BUILTINS as o (o.value)}
          <option value={o.value}>{o.label}</option>
        {/each}
        {#each imported as t (t.id)}
          <option value={t.id}>{t.name}（{t.kind === 'dark' ? '暗' : '亮'}）</option>
        {/each}
      </select>
    </label>
    {#if darkWarn}
      <div class="vv-settings-warn" role="status">{darkWarn}</div>
    {/if}
    <div class="vv-settings-import">
      <button type="button" disabled={importing} onclick={() => themeInputEl?.click()}>
        {importing ? '导入中…' : '导入主题…'}
      </button>
      <input type="file" multiple accept=".json,.vsix" hidden bind:this={themeInputEl} onchange={onImportChange} />
    </div>
    {#if importNote}
      <div class="vv-settings-note" title={importErrors.length > 0 ? importErrors.join('\n') : undefined} role="status">
        {importNote}
      </div>
    {/if}
    {#if imported.length > 0}
      <ul class="vv-settings-themes">
        {#each imported as t (t.id)}
          <li class="vv-settings-theme">
            <span class="vv-settings-theme-name" title={t.name}>{t.name}</span>
            <span class="vv-settings-theme-src">{t.source}</span>
            <button
              type="button"
              class="vv-settings-remove"
              aria-label="删除已导入主题 {t.name}"
              title="删除"
              onclick={() => void removeImported(t)}>✕</button
            >
          </li>
        {/each}
      </ul>
    {:else}
      <div class="vv-settings-empty">暂无已导入主题</div>
    {/if}
  </section>
</div>

<style>
  .vv-settings {
    position: fixed;
    top: 44px;
    right: 8px;
    width: min(340px, calc(100vw - 16px));
    max-height: min(75vh, 560px);
    overflow: auto;
    background: var(--ui-bg);
    border: 1px solid var(--ui-border);
    border-radius: 8px;
    box-shadow: 0 8px 28px rgb(0 0 0 / 22%);
    z-index: 30;
    padding: 10px 12px;
  }
  .vv-settings-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }
  .vv-settings-title {
    font-weight: 600;
  }
  .vv-settings-sec {
    padding: 8px 0;
    border-top: 1px solid var(--ui-border);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .vv-settings-label {
    font-weight: 600;
    font-size: 13px;
  }
  .vv-settings-hint {
    color: var(--ui-fg-muted);
    font-size: 12px;
  }
  .vv-settings-patterns {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .vv-settings-pattern {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid var(--ui-border);
    border-radius: 12px;
    padding: 1px 4px 1px 8px;
    font-size: 12px;
  }
  .vv-settings-remove {
    border: 0;
    background: none;
    padding: 0 3px;
    cursor: pointer;
    color: var(--ui-fg-muted);
  }
  .vv-settings-remove:hover {
    color: var(--ui-fg);
  }
  .vv-settings-empty {
    color: var(--ui-fg-muted);
    font-size: 12px;
  }
  .vv-settings-add {
    display: flex;
    gap: 6px;
  }
  .vv-settings-add input {
    flex: 1;
    min-width: 0;
  }
  .vv-settings-presets {
    display: flex;
    gap: 6px;
  }
  .vv-settings-presets button {
    font-size: 12px;
  }
  .vv-settings-presets button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .vv-settings-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    cursor: pointer;
  }
  /* 槽与主题亮暗不匹配提醒（spec B §2.3）：消费 --ui-warning token，不阻止选择 */
  .vv-settings-warn {
    color: var(--ui-warning);
    font-size: 12px;
  }
</style>
