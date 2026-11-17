/**
 * main.ts — webview 侧入口（spec H）。
 *
 * T1（骨架）：落最小壳挂载，使 esbuild 的 webview bundle（ESM + code splitting）有真实
 * entry point。渲染器注册、注入缝接线、host↔webview 消息协议、壳的完整 DOM（含
 * toc 面板头部、条目与顶部提示条文案）与渲染调度在 T3 填充——**用户可见文案一律走扩展
 * i18n 目录**（T2 建目录、T3/T5 接线），本骨架不含任何可见文案。
 *
 * 样式供给：壳样式由 host 侧合成为单个 `<style nonce>` 内联进 webview HTML
 * （MARKDOWN_CSS + SHELL_CSS，T2 落）；本文件不注入任何样式（markdown 排版样式由
 * MARKDOWN_CSS 提供，katex 排印样式由 T3 的 katex CSS 注入面提供）。
 */

/** 壳根容器 id（host 侧 HTML 模板与本文件约定） */
const MOUNT_ID = 'vv-root';

/** 挂载壳骨架：内容区 + toc 面板 + 顶部提示条（占位） */
function mountShell(): HTMLElement {
  const root = document.getElementById(MOUNT_ID) ?? document.body;
  root.className = 'vv-shell';
  root.innerHTML = `
    <div class="vv-shell__notice" role="status" hidden></div>
    <div class="vv-shell__main" id="vv-content"></div>
    <aside class="vv-shell__toc vv-shell__toc--right" role="complementary" data-collapsed="true"></aside>
  `;
  return root;
}

if (typeof document !== 'undefined') {
  mountShell();
}
