<script lang="ts">
  // AppearanceSection.svelte — 设置中心「外观」节（settings center spec §2：亮暗
  // 双槽外观主题 + 代码主题）。外观双槽/导入/删除自 SettingsPanel 界面主题节迁移；
  // 代码主题下拉自 TopBar 迁入（设置中心 Task 1，低频项收进设置页）——同 schema
  // 字段同绑定语义，写入当前生效亮暗槽（system 按 prefers-color-scheme 解析）。
  // 槽改动写 draft 后调 touch()——落盘与注入时机由 SettingsCenter 统一决定
  // （注入由 TopBar 的 onSettingsChanged 订阅 diff 触发，spec 2026-10-12 §2.4）。
  import { onMount } from 'svelte';
  import { deleteTheme, listThemes, type ImportedTheme } from '../stores/session';
  import { importThemeFiles } from '../vsixImport';
  import { onSystemModeChange, themeOptions } from '../theme';
  import type { Settings } from '../stores/settings';

  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  /** 已导入主题（spec B §2.3）：挂载后异步填充，导入/删除后刷新 */
  let imported = $state<ImportedTheme[]>([]);
  let importing = $state(false);
  let importNote = $state('');
  let importErrors = $state<string[]>([]);
  let themeInputEl = $state<HTMLInputElement | null>(null);

  // 主题表经动态 import 惰性加载（不进主 chunk，TopBar 旧实现同款），选项挂载后异步填充
  let codeThemeOptions = $state<Awaited<ReturnType<typeof themeOptions>>>([]);

  /** OS 亮暗响应式镜像（BUG-49 惯例）：matchMedia 非响应式信号，以 change 事件
   * 写入 $state 闭合依赖链；无 matchMedia 环境（jsdom/SSR）初值 false → light。 */
  let osDark = $state(
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
  );
  /** 当前生效亮暗（system 按 prefers-color-scheme 解析），决定双槽读写哪个记忆槽 */
  const mode = $derived(draft.themeMode === 'system' ? (osDark ? 'dark' : 'light') : draft.themeMode);
  const currentCodeTheme = $derived(mode === 'dark' ? draft.codeThemeDark : draft.codeThemeLight);
  const currentAppearance = $derived(mode === 'dark' ? draft.appearanceDark : draft.appearanceLight);
  /** 外观接管（spec B §2.3）：当前 mode 槽非 default 时代码配色由外观 tokenColors 决定 */
  const appearanceTakesOver = $derived(currentAppearance !== 'default');

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
    const k = appearanceKind(draft.appearanceLight);
    return k === 'dark' ? '已选主题为暗色，与当前亮色槽不匹配（仍会生效）' : '';
  });
  const darkWarn = $derived.by(() => {
    const k = appearanceKind(draft.appearanceDark);
    return k === 'light' ? '已选主题为亮色，与当前暗色槽不匹配（仍会生效）' : '';
  });

  $effect(() => {
    // 已导入列表挂载后异步填充（IndexedDB）；失败（存储不可用）留空不阻塞设置页
    void listThemes()
      .then((ts) => (imported = ts.sort((a, b) => a.name.localeCompare(b.name) || a.addedAt - b.addedAt)))
      .catch(() => (imported = []));
    void themeOptions().then((opts) => (codeThemeOptions = opts));
  });

  onMount(() => {
    // themeMode=system：OS 亮暗切换不经 saveSettings，mode 派生需响应式镜像闭合
    const offSystem = onSystemModeChange((m) => {
      osDark = m === 'dark';
    });
    return offSystem;
  });

  /** 槽切换：写 draft + touch——注入由 TopBar 的 onSettingsChanged 订阅 diff 触发 */
  function onAppearanceChange(slot: 'light' | 'dark', e: Event): void {
    const v = (e.currentTarget as HTMLSelectElement).value;
    if (slot === 'light') draft.appearanceLight = v;
    else draft.appearanceDark = v;
    touch();
  }

  /** 代码主题（TopBar 迁入）：写当前生效 mode 的记忆槽（同 schema 字段同绑定）。
   * 注入由订阅 diff（codeTheme 变化）触发，此处不直调。 */
  function onCodeThemeChange(e: Event): void {
    const name = (e.currentTarget as HTMLSelectElement).value;
    if (mode === 'dark') draft.codeThemeDark = name;
    else draft.codeThemeLight = name;
    touch();
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
   * 删库失败（存储不可用等）只记 console.error，列表/槽保持不动（onImportChange 容错风格）。 */
  async function removeImported(t: ImportedTheme): Promise<void> {
    if (!window.confirm(`删除已导入主题「${t.name}」？`)) return;
    try {
      await deleteTheme(t.id);
    } catch (err) {
      console.error(`删除已导入主题「${t.name}」失败`, err);
      return;
    }
    let changed = false;
    if (draft.appearanceLight === t.id) {
      draft.appearanceLight = 'default';
      changed = true;
    }
    if (draft.appearanceDark === t.id) {
      draft.appearanceDark = 'default';
      changed = true;
    }
    if (changed) {
      // 槽归位只写 draft：注入由 TopBar 订阅 diff 触发（spec 2026-10-12 §2.4）
      touch();
    }
    imported = imported.filter((x) => x.id !== t.id);
  }
</script>

<section class="vv-sc-section">
  <div class="vv-settings-label">界面主题</div>
  <div class="vv-settings-hint">
    VSCode 外观主题同时接管代码配色（亮/暗各自记忆，跟随顶栏主题模式）；非默认时代码主题选择停用
  </div>
  <label class="vv-settings-theme-row">
    <span>亮色</span>
    <select value={draft.appearanceLight} onchange={(e) => onAppearanceChange('light', e)} aria-label="亮色界面主题">
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
    <select value={draft.appearanceDark} onchange={(e) => onAppearanceChange('dark', e)} aria-label="暗色界面主题">
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
  <div class="vv-settings-label">代码主题</div>
  <label class="vv-settings-theme-row">
    <span>高亮配色</span>
    <select
      value={currentCodeTheme}
      onchange={onCodeThemeChange}
      aria-label="代码主题"
      title={appearanceTakesOver ? '由外观主题接管（界面主题区选回「默认」后可换）' : '代码主题'}
      disabled={appearanceTakesOver}
    >
      {#each codeThemeOptions as { group, themes } (group)}
        <optgroup label={group}>
          {#each themes as t (t)}
            <option value={t}>{t}</option>
          {/each}
        </optgroup>
      {/each}
    </select>
  </label>
</section>
