// toc.test.ts — toc 面板数据面与交互契约（spec H T5）。
//
// 覆盖面：markdown heading（getToc）与 code symbol（getOutline）归一为同一面板条目；
// 条目点击 → 滚动到目标（heading id / 符号行号）。
import { describe, expect, it, vi } from 'vitest';
import { Shell, type ShellLabels } from '../src/webview/shell';
import { bindTocClicks, scrollToHeadingIn, tocEntriesOf } from '../src/webview/toc';

const LABELS: ShellLabels = {
  tocTitle: '目录',
  tocToggle: '目录面板',
  tocEmpty: '本文档没有目录',
  engineBadge: '高亮引擎：{engine}'
};

function makeShell(): Shell {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return new Shell({ root, labels: LABELS });
}

describe('toc · 数据面归一', () => {
  it('markdown getToc → heading 条目（id/label/level）', () => {
    const entries = tocEntriesOf({
      getToc: () => [
        { level: 1, text: '标题', id: 'h-title' },
        { level: 3, text: '子标题', id: 'h-sub' }
      ]
    });
    expect(entries).toEqual([
      { id: 'h-title', label: '标题', level: 1, kind: 'heading' },
      { id: 'h-sub', label: '子标题', level: 3, kind: 'heading' }
    ]);
  });

  it('code getOutline → symbol 条目（id 为行号）', () => {
    const entries = tocEntriesOf({
      getOutline: () => [
        { name: 'main', line: 12, depth: 1 },
        { name: 'helper', line: 30, depth: 2 }
      ]
    });
    expect(entries).toEqual([
      { id: '12', label: 'main', level: 1, kind: 'symbol' },
      { id: '30', label: 'helper', level: 2, kind: 'symbol' }
    ]);
  });

  it('两者同在时以 heading 为准', () => {
    const entries = tocEntriesOf({
      getToc: () => [{ level: 1, text: 'T', id: 'x' }],
      getOutline: () => [{ name: 'sym', line: 3 }]
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe('heading');
  });

  it('无目录面 → 空数组（不抛错）', () => {
    expect(tocEntriesOf({})).toEqual([]);
    expect(tocEntriesOf({ getToc: () => [], getOutline: () => [] })).toEqual([]);
  });
});

describe('toc · 条目点击 → 滚动', () => {
  it('heading 条目 → scrollToHeading(id)；symbol 条目 → scrollToLine(行号)', () => {
    const shell = makeShell();
    const scrollToHeading = vi.fn();
    const scrollToLine = vi.fn();
    bindTocClicks(shell, { scrollToHeading, scrollToLine });
    shell.setToc([
      { id: 'h-1', label: '标题', level: 1, kind: 'heading' },
      { id: '42', label: 'sym', level: 1, kind: 'symbol' }
    ]);
    const buttons = shell.elements.tocList.querySelectorAll('button.vv-shell__toc-item');
    (buttons[0] as HTMLElement).click();
    expect(scrollToHeading).toHaveBeenCalledWith('h-1');
    expect(scrollToLine).not.toHaveBeenCalled();
    (buttons[1] as HTMLElement).click();
    expect(scrollToLine).toHaveBeenCalledWith(42);
  });

  it('点击非条目区域不触发滚动', () => {
    const shell = makeShell();
    const scrollToHeading = vi.fn();
    bindTocClicks(shell, { scrollToHeading, scrollToLine: vi.fn() });
    shell.elements.tocList.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(scrollToHeading).not.toHaveBeenCalled();
  });
});

describe('toc · 按 id 滚动（markdown 面）', () => {
  it('命中元素 → scrollIntoView 调用', () => {
    const container = document.createElement('div');
    const heading = document.createElement('h2');
    heading.id = 'h-x';
    const scrollIntoView = vi.fn();
    (heading as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollIntoView;
    container.appendChild(heading);
    expect(scrollToHeadingIn(container, 'h-x')).toBe(true);
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('未命中 → false（不抛错——文档结构与目录可能出入）', () => {
    const container = document.createElement('div');
    expect(scrollToHeadingIn(container, 'nope')).toBe(false);
    expect(scrollToHeadingIn(container, '')).toBe(false);
  });

  it('id 含特殊字符时按 CSS 转义查询（不抛错）', () => {
    const container = document.createElement('div');
    expect(scrollToHeadingIn(container, 'a.b#c')).toBe(false);
  });
});
