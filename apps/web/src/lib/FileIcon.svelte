<script lang="ts">
  /**
   * FileIcon — 文件/目录图标单字形（图标主题 spec §3.2，Task 3）。读
   * iconThemeState.runtime 走 matchIconTheme（T1 优先级链：fileNames >
   * fileExtensions > languageIds 反向表 > _file 回退）；无主题（runtime null）或
   * 无命中（含回退链终点落空）→ 不渲染任何元素——布局零位移（spec Review Focus：
   * 防占位空 span 撑行高）。作用域开关（settings.iconThemes.scopes）由调用点
   * 门控，本组件保持零 settings 依赖：`{#if settings.iconThemes.scopes.tree}
   * <FileIcon …/>{/if}`（Task 4 五消费点接线）。字体族经 fontFamilyOf
   * （per-definition fontId → 注册家族名，CSS-ready 已带引号）；color/fontSize
   * 为主题静态值，缺省字段省略样式继承现状。
   */
  import { matchIconTheme } from '@bhxch/vviewer-highlight';
  import { fontFamilyOf, iconThemeState } from './iconTheme.svelte';

  let { kind, name }: { kind: 'file' | 'folder' | 'folderExpanded'; name: string } = $props();

  const glyph = $derived(
    iconThemeState.runtime === null ? null : matchIconTheme(iconThemeState.runtime, { kind, name })
  );
</script>

{#if glyph !== null}
  <span
    class="vv-file-icon"
    style:font-family={fontFamilyOf(glyph.fontId)}
    style:color={glyph.color}
    style:font-size={glyph.fontSize}>{glyph.char}</span
  >
{/if}
