// shell.ts — webview 壳（spec H T3）。
//
// 结构（类名契约见 src/webview/shellCss.ts——勿改名，改名即视觉漂移）：
//
//   .vv-shell                     壳根（纵向：提示条 + 主体行）
//   ├── .vv-shell__notice         顶部提示条（role="status"——异步反馈读屏可达）
//   └── .vv-shell__body           主体行（横向：内容区 + toc 面板）
//       ├── .vv-shell__main       内容区（渲染目标）
//       └── .vv-shell__toc        toc 面板（role="complementary"）
//           ├── .vv-shell__toc-head   头部（标题 + 引擎徽标 + 折叠钮）
//           └── .vv-shell__toc-list   条目列表
//
// **无状态栏**（spec §4.2：不得引入状态栏）——可见反馈面 = 顶部提示条 + toc 头部徽标。
//
// a11y 基线（frontend-conventions §4）：
// - 提示条 `role="status"`（异步反馈读屏可达）
// - toc 面板 `role="complementary"` + `aria-label`
// - 折叠钮 `aria-expanded` 与折叠态同步 + `aria-controls` 指向列表
// - 徽标与折叠钮的 `aria-label` **含可见文本词形**（axe label-content-name-mismatch）
// - 所有文案经入参注入（i18n 目录），壳内无裸文案常量
export interface ShellLabels {
  /** toc 面板标题（同时作面板的 aria-label） */
  tocTitle: string;
  /** 折叠钮文案（可见文本与 aria-label 同值） */
  tocToggle: string;
  /** 空态文案 */
  tocEmpty: string;
  /** 引擎徽标的可读名称模板（`{engine}` 占位） */
  engineBadge: string;
}

/** toc 条目（markdown heading 与 code symbol 归一后的形态） */
export interface TocEntryView {
  id: string;
  label: string;
  /** 层级 1-4（缩进档） */
  level: number;
  kind: 'heading' | 'symbol';
}

/** 壳的 DOM 面 */
export interface ShellElements {
  root: HTMLElement;
  notice: HTMLElement;
  body: HTMLElement;
  main: HTMLElement;
  toc: HTMLElement;
  tocTitle: HTMLElement;
  tocBadge: HTMLElement;
  tocToggle: HTMLButtonElement;
  tocList: HTMLElement;
}

/** 壳的构造入参 */
export interface ShellOptions {
  /** 壳根容器 */
  root: HTMLElement;
  /** 文案（i18n 目录取值） */
  labels: ShellLabels;
  /** toc 停靠侧 */
  side?: 'left' | 'right';
  /** 初始折叠态（缺省 true——spec §4.2「右侧内容默认也该收起来」） */
  collapsed?: boolean;
  /** 折叠态变更回调（宿主持久化到 workspaceState） */
  onToggle?: (collapsed: boolean) => void;
}

/** 提示条级别（对应 shellCss 的 `--warn` / `--error` 变体） */
export type NoticeLevel = 'info' | 'warn' | 'error';

export class Shell {
  readonly elements: ShellElements;
  private readonly labels: ShellLabels;
  private collapsedState: boolean;
  /** 折叠态变更回调（宿主装配后挂载——上报 workspaceState 持久化） */
  onToggle?: (collapsed: boolean) => void;

  constructor(options: ShellOptions) {
    this.labels = options.labels;
    this.onToggle = options.onToggle;
    this.collapsedState = options.collapsed ?? true;

    const root = options.root;
    root.className = 'vv-shell';
    root.replaceChildren();

    const notice = document.createElement('div');
    notice.className = 'vv-shell__notice';
    notice.setAttribute('role', 'status');
    notice.hidden = true;

    const body = document.createElement('div');
    body.className = 'vv-shell__body';

    const main = document.createElement('div');
    main.className = 'vv-shell__main';
    main.id = 'vv-content';

    const toc = document.createElement('aside');
    toc.className = `vv-shell__toc vv-shell__toc--${options.side ?? 'right'}`;
    toc.setAttribute('role', 'complementary');
    toc.setAttribute('aria-label', options.labels.tocTitle);

    const head = document.createElement('div');
    head.className = 'vv-shell__toc-head';

    const title = document.createElement('span');
    title.className = 'vv-shell__toc-title';
    title.textContent = options.labels.tocTitle;

    const badge = document.createElement('span');
    badge.className = 'vv-shell__toc-badge';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'vv-shell__toc-toggle';
    toggle.textContent = options.labels.tocToggle;
    toggle.setAttribute('aria-label', options.labels.tocToggle);
    toggle.setAttribute('aria-controls', 'vv-toc-list');

    const list = document.createElement('ul');
    list.className = 'vv-shell__toc-list';
    list.id = 'vv-toc-list';

    head.append(title, badge, toggle);
    toc.append(head, list);
    body.append(main, toc);
    root.append(notice, body);

    this.elements = { root, notice, body, main, toc, tocTitle: title, tocBadge: badge, tocToggle: toggle, tocList: list };

    toggle.addEventListener('click', () => {
      this.setCollapsed(!this.collapsedState);
      this.onToggle?.(this.collapsedState);
    });
    this.setCollapsed(this.collapsedState);
  }

  /** 当前折叠态 */
  get collapsed(): boolean {
    return this.collapsedState;
  }

  /**
   * 停靠侧切换（`vviewer.toc.side` 设置项——左右可选，spec §4.2）。
   * 面板的方位类随之切换（`.vv-shell__toc--left` / `--right`）。
   */
  setSide(side: 'left' | 'right'): void {
    const next = side === 'left' ? 'left' : 'right';
    this.elements.toc.classList.remove('vv-shell__toc--left', 'vv-shell__toc--right');
    this.elements.toc.classList.add(`vv-shell__toc--${next}`);
  }

  /** 折叠态切换（`aria-expanded` 与 `data-collapsed` 同步） */
  setCollapsed(collapsed: boolean): void {
    this.collapsedState = collapsed;
    this.elements.toc.dataset['collapsed'] = collapsed ? 'true' : 'false';
    this.elements.tocToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  /** 顶部提示条（文本为 null → 隐藏；异步反馈经 role=status 读屏可达） */
  setNotice(text: string | null, level: NoticeLevel = 'info'): void {
    const notice = this.elements.notice;
    if (text === null || text === '') {
      notice.hidden = true;
      notice.textContent = '';
      notice.className = 'vv-shell__notice';
      return;
    }
    notice.hidden = false;
    notice.textContent = text;
    notice.className =
      level === 'info' ? 'vv-shell__notice' : `vv-shell__notice vv-shell__notice--${level}`;
  }

  /** 引擎徽标（可读名称含可见文本词形） */
  setEngineBadge(engine: string): void {
    const badge = this.elements.tocBadge;
    badge.textContent = engine;
    badge.setAttribute('aria-label', this.engineLabel(engine));
  }

  /** toc 条目渲染（空态走文案） */
  setToc(entries: readonly TocEntryView[]): void {
    const list = this.elements.tocList;
    list.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'vv-shell__toc-empty';
      empty.textContent = this.labels.tocEmpty;
      list.append(empty);
      return;
    }
    for (const entry of entries) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `vv-shell__toc-item vv-shell__toc-item--depth-${clampLevel(entry.level)}`;
      button.textContent = entry.label;
      button.dataset['id'] = entry.id;
      button.dataset['kind'] = entry.kind;
      item.append(button);
      list.append(item);
    }
  }

  /** 引擎徽标的可读名称（模板含 `{engine}` 占位） */
  private engineLabel(engine: string): string {
    return this.labels.engineBadge.replace('{engine}', engine);
  }

}

/** 层级裁剪到 1-4（缩进档） */
export function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.min(4, Math.max(1, Math.trunc(level)));
}
