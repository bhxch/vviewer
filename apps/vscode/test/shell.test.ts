// shell.test.ts — webview 壳 DOM 契约 + a11y（spec H T3 Step 2）。
//
// 覆盖面（计划 T3 Step 2 明列）：壳 DOM 契约 + a11y（toc 面板 `role="complementary"`/
// `aria-label`、折叠钮 `aria-expanded` 同步、**顶部提示条 `role="status"`**、toc 头部
// 徽标有可读名称、图标钮 aria-label 含可见文本词形）。
import { describe, expect, it } from 'vitest';
import { Shell, clampLevel, type ShellLabels } from '../src/webview/shell';

const LABELS: ShellLabels = {
  tocTitle: '目录',
  tocToggle: '目录面板',
  tocEmpty: '本文档没有目录',
  engineBadge: '高亮引擎：{engine}'
};

function makeShell(overrides: Partial<ConstructorParameters<typeof Shell>[0]> = {}): Shell {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return new Shell({ root, labels: LABELS, ...overrides });
}

describe('壳 · DOM 契约', () => {
  it('壳根与三类区块齐备（内容区 / toc 面板 / 顶部提示条）', () => {
    const shell = makeShell();
    expect(shell.elements.root.classList.contains('vv-shell')).toBe(true);
    expect(shell.elements.root.querySelector('.vv-shell__main')).not.toBeNull();
    expect(shell.elements.root.querySelector('.vv-shell__toc')).not.toBeNull();
    expect(shell.elements.root.querySelector('.vv-shell__notice')).not.toBeNull();
  });

  it('**无状态栏**（spec §4.2：不得引入状态栏）', () => {
    const shell = makeShell();
    expect(shell.elements.root.querySelector('.vv-statusbar')).toBeNull();
    expect(shell.elements.root.querySelector('[role="statusbar"]')).toBeNull();
  });

  it('toc 面板停靠侧可切（左/右）', () => {
    const left = makeShell({ side: 'left' });
    expect(left.elements.toc.classList.contains('vv-shell__toc--left')).toBe(true);
    const right = makeShell({ side: 'right' });
    expect(right.elements.toc.classList.contains('vv-shell__toc--right')).toBe(true);
  });
});

describe('壳 · a11y', () => {
  it('顶部提示条 role="status"（异步反馈读屏可达）', () => {
    const shell = makeShell();
    expect(shell.elements.notice.getAttribute('role')).toBe('status');
    expect(shell.elements.notice.hidden).toBe(true);
  });

  it('toc 面板 role="complementary" + aria-label', () => {
    const shell = makeShell();
    expect(shell.elements.toc.getAttribute('role')).toBe('complementary');
    expect(shell.elements.toc.getAttribute('aria-label')).toBe(LABELS.tocTitle);
  });

  it('折叠钮 aria-expanded 与折叠态同步（默认收起）', () => {
    const shell = makeShell();
    expect(shell.collapsed).toBe(true);
    expect(shell.elements.tocToggle.getAttribute('aria-expanded')).toBe('false');
    expect(shell.elements.toc.dataset['collapsed']).toBe('true');
    shell.setCollapsed(false);
    expect(shell.elements.tocToggle.getAttribute('aria-expanded')).toBe('true');
    expect(shell.elements.toc.dataset['collapsed']).toBe('false');
  });

  it('折叠钮点击切换并回调（宿主持久化面）', () => {
    const seen: boolean[] = [];
    const shell = makeShell({ onToggle: (collapsed) => seen.push(collapsed) });
    shell.elements.tocToggle.click();
    expect(shell.collapsed).toBe(false);
    expect(shell.elements.tocToggle.getAttribute('aria-expanded')).toBe('true');
    shell.elements.tocToggle.click();
    expect(shell.collapsed).toBe(true);
    expect(seen).toEqual([false, true]);
  });

  it('折叠钮 aria-label 含可见文本词形（axe label-content-name-mismatch）', () => {
    const shell = makeShell();
    const visible = shell.elements.tocToggle.textContent ?? '';
    const label = shell.elements.tocToggle.getAttribute('aria-label') ?? '';
    expect(visible.length).toBeGreaterThan(0);
    expect(label).toContain(visible);
  });

  it('引擎徽标有可读名称且含可见文本', () => {
    const shell = makeShell();
    shell.setEngineBadge('tree-sitter');
    const visible = shell.elements.tocBadge.textContent ?? '';
    const label = shell.elements.tocBadge.getAttribute('aria-label') ?? '';
    expect(visible).toBe('tree-sitter');
    expect(label).toContain(visible);
  });

  it('提示条文本可见性与级别变体', () => {
    const shell = makeShell();
    shell.setNotice('已导出到 /tmp/a.html');
    expect(shell.elements.notice.hidden).toBe(false);
    expect(shell.elements.notice.textContent).toBe('已导出到 /tmp/a.html');
    shell.setNotice('降级', 'warn');
    expect(shell.elements.notice.classList.contains('vv-shell__notice--warn')).toBe(true);
    shell.setNotice('失败', 'error');
    expect(shell.elements.notice.classList.contains('vv-shell__notice--error')).toBe(true);
    shell.setNotice(null);
    expect(shell.elements.notice.hidden).toBe(true);
    expect(shell.elements.notice.textContent).toBe('');
  });
});

describe('壳 · toc 条目', () => {
  it('条目渲染为可聚焦按钮并带缩进档', () => {
    const shell = makeShell();
    shell.setToc([
      { id: 'h1', label: '标题', level: 1, kind: 'heading' },
      { id: 'h3', label: '子标题', level: 3, kind: 'symbol' }
    ]);
    const buttons = shell.elements.tocList.querySelectorAll('button.vv-shell__toc-item');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.className).toContain('vv-shell__toc-item--depth-1');
    expect(buttons[1]!.className).toContain('vv-shell__toc-item--depth-3');
    expect(buttons[0]!.textContent).toBe('标题');
  });

  it('空态走文案', () => {
    const shell = makeShell();
    shell.setToc([]);
    expect(shell.elements.tocList.textContent).toContain(LABELS.tocEmpty);
  });

  it('层级裁剪到 1-4', () => {
    expect(clampLevel(0)).toBe(1);
    expect(clampLevel(9)).toBe(4);
    expect(clampLevel(2.7)).toBe(2);
    expect(clampLevel(Number.NaN)).toBe(1);
  });
});
