// toc.ts — toc 面板的数据面与交互（spec H T5）。
//
// 数据面（spec §7 技术订正）：markdown → 渲染实例的 `getToc?.()`（core 的
// `RenderedInstance` 鸭子面，packages/vviewer-core/src/types.ts:121）；code →
// `getOutline?.()`（highlight 包的 OutlineEntry）。两者归一为同一面板条目形态。
//
// 面板行为：`vviewer.toc.side` 决定停靠侧、默认收起；折叠态记忆 workspaceState
// （宿主侧持久化——webview 侧只经 onToggle 回调上抛）；折叠钮 `aria-expanded` 同步
// （shell.ts 承接）；点击条目 → 滚动到目标（markdown heading id / code 符号行号）。
import type { Shell } from './shell';

/** 面板条目（markdown heading 与 code symbol 合流） */
export interface TocEntryView {
  /** markdown：heading 的 DOM id；code：符号所在行号（字符串形态） */
  id: string;
  /** 显示文本 */
  label: string;
  /** 层级 1-4（缩进档；越界由 shell 的 clampLevel 裁剪） */
  level: number;
  kind: 'heading' | 'symbol';
}

/** 渲染实例的 toc 面（鸭子面——缺省面缺席即无目录） */
export interface TocSource {
  getToc?(): Array<{ level: number; text: string; id: string }>;
  getOutline?(): Array<{ name: string; line: number; depth?: number }>;
}

/**
 * toc 条目归一（markdown 优先——两者同时在场时以 heading 为准：markdown 文档不会
 * 同时产出 outline；code 文档只产 outline）。
 */
export function tocEntriesOf(source: TocSource): TocEntryView[] {
  const toc = source.getToc?.() ?? [];
  if (toc.length > 0) {
    return toc.map((entry) => ({
      id: entry.id,
      label: entry.text,
      level: entry.level,
      kind: 'heading' as const
    }));
  }
  const outline = source.getOutline?.() ?? [];
  return outline.map((entry, index) => ({
    id: String(entry.line ?? index),
    label: entry.name,
    level: entry.depth ?? 1,
    kind: 'symbol' as const
  }));
}

/** 滚动导航（宿主侧注入——渲染实例的滚动面各异） */
export interface TocNavigator {
  /** 滚到 markdown heading（DOM id） */
  scrollToHeading(id: string): void;
  /** 滚到 code 符号所在行（0 起行号） */
  scrollToLine(line: number): void;
}

/**
 * 绑定 toc 条目点击（事件委托——条目随渲染重建，绑定在列表容器上不需重挂）。
 */
export function bindTocClicks(shell: Shell, navigator: TocNavigator): void {
  shell.elements.tocList.addEventListener('click', (event: Event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest('button.vv-shell__toc-item') as HTMLElement | null;
    if (!button) return;
    const id = button.dataset['id'] ?? '';
    const kind = button.dataset['kind'];
    if (kind === 'symbol') {
      navigator.scrollToLine(Number(id));
      return;
    }
    navigator.scrollToHeading(id);
  });
}

/**
 * 按 heading id 滚动（markdown 面）：元素缺席即无动作（不抛错——文档结构与目录
 * 可能有出入）。
 */
export function scrollToHeadingIn(container: HTMLElement, id: string): boolean {
  if (!id) return false;
  let target: HTMLElement | null;
  try {
    target = container.querySelector(`#${CSS.escape(id)}`);
  } catch {
    target = null;
  }
  if (!target) return false;
  target.scrollIntoView?.({ block: 'start' });
  return true;
}
