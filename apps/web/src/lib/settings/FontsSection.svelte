<script lang="ts">
  // FontsSection.svelte — 设置中心「字体」节（settings center spec §2）。
  // 自 SettingsPanel 字体节整体迁移（字体系统 spec 2026-10-19 §4/§5，设置中心
  // Task 1）：上半两槽 picker = 预设/网络字体下拉 + 「自定义…」手输框 + 字号
  // number input；下半网络字体管理列表 = URL/上传添加、启停开关、删除（被引用
  // 槽位回落默认）、样张/体积行、错误态重试。
  // 槽位改动写 draft.fonts 后调 touch()——落盘与生效时机由 SettingsCenter 统一
  // 决定（Task 1 即时持久化 / Task 2 起草稿统一应用，应用经订阅链触发注入与
  // 重渲染）；网络字体管理（IndexedDB store 操作）不属 settings schema，保持
  // 即时生效，仅被删除字体引用的槽位经 draft 回落。
  import { untrack } from 'svelte';
  import { clampSize, CODE_SIZE_RANGE, UI_SIZE_RANGE, type Settings } from '../stores/settings';
  import {
    CODE_FONT_PRESETS,
    CUSTOM_FONT_SENTINEL,
    FONT_SPECIMEN,
    UI_FONT_PRESETS,
    fontFamilyOptions,
    formatFontSize,
    mergedFamilyOptions,
    type FontPreset
  } from '../fonts';
  import { DEFAULT_CODE_FONT_STACK, DEFAULT_UI_FONT_STACK, fontFamilyValue } from '../theme';
  import {
    addFontFromFile,
    addFontFromUrl,
    deleteFont,
    listFontRecords,
    setEnabledFont,
    stemOf,
    type FontRecord
  } from '../stores/fontsStore';

  let { draft, touch }: { draft: Settings; touch(): void } = $props();

  // ---------- 网络字体管理状态（字体系统 spec §5 下半） ----------
  // 列表挂载后异步填充（IndexedDB），uiCustomMode 初判时多为空——槽值命中网络
  // 字体名的自定义态纠偏由下方 $effect 兜住
  let fontRecords = $state<FontRecord[]>([]);
  /** URL 添加失败暂存（spec §6 错误态 + 重试钮；url 键去重，store 不留死记录） */
  let fontFailures = $state<{ url: string; name: string; message: string }[]>([]);
  let fontBusy = $state(false);
  let fontNote = $state('');
  let fontUrlDraft = $state('');
  let fontNameDraft = $state('');
  let fontInputEl = $state<HTMLInputElement | null>(null);
  /** 已启用网络字体名（两槽下拉合并源；也是「值已被选项表示」的判定集合） */
  const enabledFontNames = $derived(fontRecords.filter((r) => r.enabled).map((r) => r.name));
  const networkNames = $derived(new Set(enabledFontNames));

  // 字体节槽位自定义态（字体系统 spec §4 上半）：手输模式按打开时的槽值一次性
  // 初判（untrack——只取打开时刻值，后续纠偏走下方 effect，不建立响应式依赖；
  // 自定义族打开设置页立即可编辑，不必再点一次「自定义…」；列表未载时网络字体
  // 名暂判自定义态，由纠偏 effect 收敛）
  let uiCustomMode = $state(isCustomFamily(untrack(() => draft.fonts.uiFamily), UI_FONT_PRESETS, new Set<string>()));
  let codeCustomMode = $state(isCustomFamily(untrack(() => draft.fonts.codeFamily), CODE_FONT_PRESETS, new Set<string>()));
  const uiOptions = $derived(mergedFamilyOptions(fontFamilyOptions(UI_FONT_PRESETS), enabledFontNames));
  const codeOptions = $derived(mergedFamilyOptions(fontFamilyOptions(CODE_FONT_PRESETS), enabledFontNames));

  /** 槽位 family 是否为手输值（非默认空栈、不在预设清单内、也不是已启用网络字体
   * 名）→ select 显示「自定义…」 */
  function isCustomFamily(f: string, presets: readonly FontPreset[], networkNames: ReadonlySet<string>): boolean {
    return f !== '' && !presets.some((p) => p.value === f) && !networkNames.has(f);
  }

  /** select 当前值：自定义态（模式开或值不在预设/网络字体清单内）显哨兵，否则即族值本身 */
  const uiSelectValue = $derived(
    uiCustomMode || isCustomFamily(draft.fonts.uiFamily, UI_FONT_PRESETS, networkNames)
      ? CUSTOM_FONT_SENTINEL
      : draft.fonts.uiFamily
  );
  const codeSelectValue = $derived(
    codeCustomMode || isCustomFamily(draft.fonts.codeFamily, CODE_FONT_PRESETS, networkNames)
      ? CUSTOM_FONT_SENTINEL
      : draft.fonts.codeFamily
  );

  $effect(() => {
    // 网络字体列表载入后纠偏手输模式：初判时列表多为空，槽值命中已启用网络字体名
    // 即退出（值已可被下拉选项表示；打字途中命中同名同语义）
    if (networkNames.has(draft.fonts.uiFamily)) uiCustomMode = false;
    if (networkNames.has(draft.fonts.codeFamily)) codeCustomMode = false;
  });

  $effect(() => {
    // 网络字体列表挂载后异步填充（IndexedDB）；失败（存储不可用）留空不阻塞设置页
    // （已导入主题列表同款容错）
    void listFontRecords()
      .then((rs) => (fontRecords = rs))
      .catch(() => (fontRecords = []));
  });

  /** 字体槽 picker（字体系统 spec §4）：选「自定义…」只展开手输框不改值；
   * 选默认/预设收起手输框并写 draft + touch。 */
  function onFamilyChange(slot: 'ui' | 'code', e: Event): void {
    const v = (e.currentTarget as HTMLSelectElement).value;
    if (v === CUSTOM_FONT_SENTINEL) {
      if (slot === 'ui') uiCustomMode = true;
      else codeCustomMode = true;
      return;
    }
    if (slot === 'ui') {
      uiCustomMode = false;
      draft.fonts.uiFamily = v;
    } else {
      codeCustomMode = false;
      draft.fonts.codeFamily = v;
    }
    touch();
  }

  /** 手输 family：写 draft（空串 = 默认栈语义；多级回退栈原样存储，转义/拆段在
   * 注入侧）。清空即退出手输态回预设视图（台账 Low-2）：值已是默认栈，select 不
   * 再停留「自定义…」。value 绑定同文回写不打断输入（无 clamp 分歧）。 */
  function onFamilyInput(slot: 'ui' | 'code', e: Event): void {
    const v = (e.currentTarget as HTMLInputElement).value;
    if (slot === 'ui') {
      draft.fonts.uiFamily = v;
      if (v === '') uiCustomMode = false;
    } else {
      draft.fonts.codeFamily = v;
      if (v === '') codeCustomMode = false;
    }
    touch();
  }

  /** 字号提交（onchange，blur/回车触发）：输入框与 draft 同步为规范化值（终审
   * I-1 承续：无 oninput 通道，输入途中不写 draft/DOM——渐进键入不被回写打断；
   * 台账 Low-1 的 13.7/013 漂移在此回正），非法/空输入回落当前 draft 值。 */
  function onSizeChange(slot: 'ui' | 'code', e: Event): void {
    const inp = e.currentTarget as HTMLInputElement;
    const range = slot === 'ui' ? UI_SIZE_RANGE : CODE_SIZE_RANGE;
    const cur = slot === 'ui' ? draft.fonts.uiSize : draft.fonts.codeSize;
    const clamped = inp.value.trim() === '' ? cur : clampSize(Number(inp.value), range, cur);
    inp.value = String(clamped);
    if (slot === 'ui') draft.fonts.uiSize = clamped;
    else draft.fonts.codeSize = clamped;
    touch();
  }

  // ---------- 网络字体管理（字体系统 spec §5 下半） ----------

  /** URL 添加（spec §5.2）：store 全管线（https 白名单 / 30MB 门禁 / 先装载验证后
   * 入库）。失败入错误态暂存（url 键去重，spec §6），重试钮复跑同管线；错误不落库
   * （Task 4 语义），列表不留死记录。 */
  async function onFontUrlSubmit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const url = fontUrlDraft.trim();
    if (url === '' || fontBusy) return;
    fontBusy = true;
    fontNote = '';
    const explicit = fontNameDraft.trim();
    try {
      const rec = await addFontFromUrl(url, explicit || undefined);
      fontRecords = [...fontRecords, rec];
      fontUrlDraft = '';
      fontNameDraft = '';
      fontFailures = fontFailures.filter((f) => f.url !== url);
      fontNote = `已添加字体「${rec.name}」`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fontFailures = [...fontFailures.filter((f) => f.url !== url), { url, name: explicit || stemOf(url), message }];
    } finally {
      fontBusy = false;
    }
  }

  /** 本地上传（spec §5.2）：同 ArrayBuffer 路径，扩展名白名单由 input accept 把关。
   * 文件对象一次性（选完即失效），失败直接注记不设重试态——重选文件即重试。 */
  async function onFontFileChange(e: Event): Promise<void> {
    const inp = e.currentTarget as HTMLInputElement;
    const file = inp.files?.[0];
    inp.value = ''; // 允许重复选同一文件
    if (!file || fontBusy) return;
    fontBusy = true;
    fontNote = '';
    try {
      const rec = await addFontFromFile(file);
      fontRecords = [...fontRecords, rec];
      fontNote = `已添加字体「${rec.name}」`;
    } catch (err) {
      fontNote = err instanceof Error ? err.message : String(err);
    } finally {
      fontBusy = false;
    }
  }

  /** 启停（spec §5.2）：停用注销 document.fonts（引用槽由浏览器回退显示），启用
   * 重建注册；已启用项随 enabledFontNames 派生进/出两槽下拉。失败注记并触发行
   * 重渲回滚开关显示（checkbox 受控于 rec.enabled）。 */
  async function onFontToggle(rec: FontRecord, e: Event): Promise<void> {
    const enabled = (e.currentTarget as HTMLInputElement).checked;
    try {
      await setEnabledFont(rec.id, enabled);
    } catch (err) {
      console.error(`切换网络字体「${rec.name}」失败`, err);
      fontNote = err instanceof Error ? err.message : String(err);
      fontRecords = [...fontRecords];
      return;
    }
    fontRecords = fontRecords.map((r) => (r.id === rec.id ? { ...r, enabled } : r));
  }

  /** 删除（spec §5.2）：store 移除 + document.fonts 注销；被 uiFamily/codeFamily
   * 引用时槽位回落默认（''）并写 draft + touch（已导入主题删除同款）。 */
  async function removeFont(rec: FontRecord): Promise<void> {
    if (!window.confirm(`删除网络字体「${rec.name}」？`)) return;
    let gone: FontRecord | null = null;
    try {
      gone = await deleteFont(rec.id);
    } catch (err) {
      console.error(`删除网络字体「${rec.name}」失败`, err);
      return; // 删库失败：列表/槽保持不动（removeImported 容错风格）
    }
    fontRecords = fontRecords.filter((x) => x.id !== rec.id);
    if (gone === null) return;
    let changed = false;
    const fell: string[] = [];
    if (draft.fonts.uiFamily === gone.name) {
      draft.fonts.uiFamily = '';
      uiCustomMode = false;
      changed = true;
      fell.push('界面字体');
    }
    if (draft.fonts.codeFamily === gone.name) {
      draft.fonts.codeFamily = '';
      codeCustomMode = false;
      changed = true;
      fell.push('代码字体');
    }
    if (changed) touch();
    fontNote = fell.length > 0 ? `已删除「${gone.name}」，${fell.join('、')}槽已回落默认字体` : `已删除「${gone.name}」`;
  }

  /** 错误态重试：复跑同 URL/名称的添加管线，成功移出暂存、失败原位更新错误信息。 */
  async function retryFont(f: { url: string; name: string; message: string }): Promise<void> {
    if (fontBusy) return;
    fontBusy = true;
    fontNote = '';
    try {
      const rec = await addFontFromUrl(f.url, f.name || undefined);
      fontRecords = [...fontRecords, rec];
      fontFailures = fontFailures.filter((x) => x.url !== f.url);
      fontNote = `已添加字体「${rec.name}」`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      fontFailures = fontFailures.map((x) => (x.url === f.url ? { ...x, message } : x));
    } finally {
      fontBusy = false;
    }
  }

  function dismissFontFailure(f: { url: string; name: string; message: string }): void {
    fontFailures = fontFailures.filter((x) => x.url !== f.url);
  }
</script>

<section class="vv-sc-section">
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
        value={draft.fonts.uiFamily}
        oninput={(e) => onFamilyInput('ui', e)}
        placeholder="Family 名，逗号分隔多级回退"
        aria-label="自定义界面字体族"
        spellcheck="false"
      />
    </label>
    <div
      class="vv-settings-font-sample"
      style:font-family={fontFamilyValue(draft.fonts.uiFamily, DEFAULT_UI_FONT_STACK)}
      style:font-size="{draft.fonts.uiSize}px"
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
      value={draft.fonts.uiSize}
      onchange={(e) => onSizeChange('ui', e)}
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
        value={draft.fonts.codeFamily}
        oninput={(e) => onFamilyInput('code', e)}
        placeholder="Family 名，逗号分隔多级回退"
        aria-label="自定义代码字体族"
        spellcheck="false"
      />
    </label>
    <div
      class="vv-settings-font-sample"
      style:font-family={fontFamilyValue(draft.fonts.codeFamily, DEFAULT_CODE_FONT_STACK)}
      style:font-size="{draft.fonts.codeSize}px"
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
      value={draft.fonts.codeSize}
      onchange={(e) => onSizeChange('code', e)}
      aria-label="代码字号（px）"
    />
  </label>
  <div class="vv-settings-hint">
    family 支持逗号分隔多级回退（如 JetBrains Mono, monospace）；本机缺失的字体由浏览器回退。
    代码字号变更后行高联动、已打开文件自动以新行高重排。
  </div>
  <div class="vv-settings-label">网络字体</div>
  <div class="vv-settings-hint">
    https 直链或本地上传 .ttf/.otf/.woff/.woff2（单文件 ≤30MB）；已启用的字体进上方两槽下拉，
    停用即从下拉移除（已引用槽位由浏览器回退显示），删除后 IndexedDB 不再保留。
  </div>
  <form class="vv-settings-add" onsubmit={onFontUrlSubmit}>
    <input
      bind:value={fontUrlDraft}
      placeholder="https://example.com/font.woff2"
      aria-label="网络字体地址"
      spellcheck="false"
    />
    <button type="submit" disabled={fontBusy || fontUrlDraft.trim() === ''}>添加</button>
  </form>
  <div class="vv-settings-font-addrow">
    <input
      type="text"
      bind:value={fontNameDraft}
      placeholder="字体名称（可选，默认取地址末段/文件名）"
      aria-label="网络字体名称（可选）"
      spellcheck="false"
    />
    <button type="button" disabled={fontBusy} onclick={() => fontInputEl?.click()}>
      {fontBusy ? '处理中…' : '上传字体…'}
    </button>
    <input type="file" accept=".ttf,.otf,.woff,.woff2" hidden bind:this={fontInputEl} onchange={onFontFileChange} />
  </div>
  {#if fontNote}
    <div class="vv-settings-note" role="status">{fontNote}</div>
  {/if}
  {#if fontRecords.length > 0 || fontFailures.length > 0}
    <ul class="vv-settings-fonts">
      {#each fontRecords as rec (rec.id)}
        <li class="vv-settings-font">
          <div class="vv-settings-font-head">
            <label class="vv-settings-font-toggle">
              <input
                type="checkbox"
                checked={rec.enabled}
                aria-label="启用网络字体 {rec.name}"
                onchange={(e) => void onFontToggle(rec, e)}
              />
              <span class="vv-settings-font-name" title={rec.name}>{rec.name}</span>
            </label>
            <span class="vv-settings-font-size">{formatFontSize(rec.size)}</span>
            <button
              type="button"
              class="vv-settings-remove"
              aria-label="删除网络字体 {rec.name}"
              title="删除"
              onclick={() => void removeFont(rec)}>✕</button
            >
          </div>
          <div class="vv-settings-font-sample" style:font-family={fontFamilyValue(rec.name, DEFAULT_UI_FONT_STACK)}>
            {FONT_SPECIMEN}
          </div>
        </li>
      {/each}
      {#each fontFailures as f (f.url)}
        <li class="vv-settings-font vv-settings-font-failed">
          <div class="vv-settings-font-head">
            <span class="vv-settings-font-name" title={f.name}>{f.name}</span>
            <button
              type="button"
              class="vv-settings-font-retry"
              disabled={fontBusy}
              aria-label="重试添加网络字体 {f.name}"
              onclick={() => void retryFont(f)}>重试</button
            >
            <button
              type="button"
              class="vv-settings-remove"
              aria-label="忽略网络字体 {f.name}"
              title="忽略"
              onclick={() => dismissFontFailure(f)}>✕</button
            >
          </div>
          <div class="vv-settings-font-errmsg" role="status">{f.message}</div>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="vv-settings-empty">暂无网络字体</div>
  {/if}
</section>
