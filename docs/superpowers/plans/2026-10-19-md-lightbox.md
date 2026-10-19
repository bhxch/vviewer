# Lightbox 增强 Implementation Plan（spec 阶段四）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** lightbox 从「单图查看」升级为 markpad ZoomOverlay 同交互集：缩放（按钮/滚轮光标中心/键盘，限幅）、平移（拖拽）、多图导航（图片+图表 SVG 共画廊，prev/next+方向键）、r/f 重置；owner 代币与 destroy 清理契约不变。

**Architecture:** lightbox 段从 pipeline.ts 抽出为 `lightbox.ts` 独立模块（状态机纯函数化：gallery 收集/zoom/pan 计算可单测；DOM 组装薄壳）；overlay 仍为 body 级单例（LIGHTBOX_OVERLAY_ID/OWNER_ATTR 契约不变，markdownRenderer destroy 零改动）；CSS 落 app.css。

**Tech Stack:** 纯 DOM/CSS transform、vitest/jsdom（WheelEvent/KeyboardEvent 可构造派发）、playwright。

**Spec:** `docs/superpowers/specs/2026-10-19-markdown-markpad-alignment-design.md` §5

## Global Constraints

- 契约不变：`LIGHTBOX_OVERLAY_ID`/`LIGHTBOX_OWNER_ATTR`/`removeLightboxOverlay(doc, ownerId?)` 三导出签名与语义（owner 校验/Esc 移除/markdownRenderer destroy 收口）零变化。
- 画廊收集：文档内 `img` + 已渲染图表 SVG（`.md-diagram-view svg`），跳过 <32px 尺寸元素与 KaTeX 块内 img；kroki img 天然入画廊（Plan 1 已核）。
- 缩放：MIN/MAX 限幅（0.2–8 倍），滚轮以光标为中心；键盘 `+`/`-`/`=` 缩放、`r`/`f` 重置、←/→ 导航、Esc 关闭。
- 移动端：按钮缩放（无捏合，spec 非目标）；controls 在窄屏可用（触控目标 ≥32px）。
- 每任务原子提交；测试在仓库根跑。

---

### Task 1: lightbox 模块化 + 画廊导航 + 键盘

**Files:**
- Create: `packages/render-text/src/markdown/lightbox.ts`（自 pipeline.ts 迁出三导出+新增状态机）
- Modify: `packages/render-text/src/markdown/pipeline.ts`（lightbox 段替换为 re-export + runLightbox 迁移调用）
- Modify: `apps/web/src/app.css`（overlay/画廊控制件样式扩展）
- Create: `packages/render-text/src/markdown/lightbox.test.ts`

**Interfaces:**
- Produces（契约不变三导出 + 内部新态）: `removeLightboxOverlay(doc, ownerId?)`、`openLightbox(img, ctx, gallery)`；状态机纯函数 `clampZoom(z): number`、`zoomAt(state, factor, cx, cy): state`（光标中心锚定：缩放后光标下内容点保持）、`navigate(state, delta): state`（index 环绕）——单测直测。
- 画廊条目形态：`{ type: 'img'|'svg', src: string, alt: string }`（img 取 src/alt；svg 取 outerHTML）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/render-text/src/markdown/lightbox.test.ts
import { describe, expect, it } from 'vitest';
import { clampZoom, collectGallery, navigate, zoomAt } from './lightbox';

describe('collectGallery', () => {
  it('收集 img 与图表 svg，跳过 <32px 与 KaTeX 内 img', () => {
    const doc = document.implementation.createHTMLDocument('');
    doc.body.innerHTML = [
      '<img src="a.png" alt="A" width="100" height="80">',
      '<img src="tiny.gif" width="10" height="10">',
      '<div class="katex"><img src="k.png"></div>',
      '<div class="md-diagram-view"><svg viewBox="0 0 10 10"></svg></div>'
    ].join('');
    const g = collectGallery(doc.body);
    expect(g).toHaveLength(2);
    expect(g[0]).toEqual({ type: 'img', src: 'a.png', alt: 'A' });
    expect(g[1]!.type).toBe('svg');
  });
});

describe('zoom/pan 状态机', () => {
  it('clampZoom 限幅 0.2–8', () => {
    expect(clampZoom(0.01)).toBe(0.2);
    expect(clampZoom(100)).toBe(8);
    expect(clampZoom(1)).toBe(1);
  });
  it('zoomAt 光标中心锚定：光标下内容点缩放后不动', () => {
    const s0 = { zoom: 1, tx: 0, ty: 0 };
    // 视口 200x200，光标 (150,50)：内容点 = (150/1 - 0) → 缩放 2 后 tx 应使该点仍在 (150,50)
    const s1 = zoomAt(s0, 2, 150, 50, 200, 200);
    expect(s1.zoom).toBe(2);
    const px = 150 * s0.zoom + s0.tx; // 150
    const pxAfter = 150 * s1.zoom + s1.tx;
    expect(pxAfter).toBeCloseTo(px, 6);
  });
  it('navigate 环绕', () => {
    expect(navigate({ index: 0, count: 3 }, -1).index).toBe(2);
    expect(navigate({ index: 2, count: 3 }, 1).index).toBe(0);
  });
});
```

（zoomAt 签名若实现取视口尺寸来源不同——overlay 尺寸或 client 尺寸——以实现为准调整测试参数，语义锚=光标下内容点不动。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run packages/render-text/src/markdown/lightbox.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 lightbox.ts**

迁移 pipeline.ts 现有三导出（L255-319 段语义原样）；新增：
- `collectGallery(root: ParentNode): GalleryItem[]`（querySelectorAll('img') + '.md-diagram-view svg'；跳过宽高均存在且 <32 的 img（getBoundingClientRect 或 width 属性，jsdom 可测后者）；KaTeX 祖先跳过）。
- overlay DOM 扩展：prev/next 按钮、zoom-in/out/reset 按钮、计数徽标（`i/N`）、内容容器（img 或 div.svg-host innerHTML=svg）；状态 { zoom, tx, ty, index }；`applyState()` 写 transform（`translate(tx,ty) scale(zoom)`）与计数。
- 键盘处理扩展既有 escHandlers 模式：Escape 关、←/→ navigate、+/-/= zoomAt 视口中心 1.25 倍步进、r/f 重置。
- wheel：preventDefault + zoomAt(factor, offsetX, offsetY)（光标相对 overlay 位置）。
- 拖拽 pan（Task 2 实现，本任务仅留 state 字段）。
- runLightbox 点击回调改为 `openLightbox(img, ctx, collectGallery(root))`——同一画廊内导航。

pipeline.ts：删原 lightbox 段，`export { removeLightboxOverlay, LIGHTBOX_OVERLAY_ID, LIGHTBOX_OWNER_ATTR } from './lightbox';`（re-export 保住 markdownRenderer 的 import 面与既有测试 import 路径——若既有测试从 pipeline import 这三符号，re-export 保持兼容）。

- [ ] **Step 4: 跑测试确认通过 + render-text 全量回归**（既有 lightbox 用例若 import 路径/行为断言变化——迁移断言到新文件并保语义）

- [ ] **Step 5: Commit**

```bash
git add packages/render-text/src/markdown/lightbox.ts packages/render-text/src/markdown/lightbox.test.ts packages/render-text/src/markdown/pipeline.ts apps/web/src/app.css
git commit -m "feat(md): lightbox 模块化——画廊导航/键盘集/状态机纯函数"
```

---

### Task 2: 缩放+平移交互

**Files:**
- Modify: `packages/render-text/src/markdown/lightbox.ts`（wheel/拖拽/按钮接线）
- Modify: `apps/web/src/app.css`（cursor grab/grabbing、按钮组、触控目标）

- [ ] **Step 1: 写失败测试**

```ts
it('拖拽 pan：drag 位移写入 tx/ty', () => {
  // dispatch pointer/mouse 事件序列（mousedown→mousemove×2→mouseup）于内容容器
  // 断言 state.tx/ty 累计位移、zoom>1 才允许 pan（zoom 1 时 pan 无效——markpad 同款？实现按：任何 zoom 允许 pan，但 zoom=1 时拖到边界无视觉变化；取「恒允许」最简）
});
it('wheel 缩放以光标为中心且限幅', () => {
  // WheelEvent deltaY<0 放大；连滚到超限被 clamp
});
```

（pan 交互形态：mousedown 起、mousemove 增量、mouseup 落；用 MouseEvent 派发可测。）

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**：内容容器 mousedown 记起点、document mousemove 增量写 tx/ty（仅按下态）、mouseup 结束；wheel handler 接 zoomAt；按钮组 click 接 zoomIn/zoomOut/reset（视口中心）；cursor 样式随拖拽态切换。

- [ ] **Step 4: 跑测试确认通过 + 回归**

- [ ] **Step 5: Commit**

```bash
git add packages/render-text/src/markdown/lightbox.ts packages/render-text/src/markdown/lightbox.test.ts apps/web/src/app.css
git commit -m "feat(md): lightbox 缩放平移——滚轮光标中心/拖拽 pan/按钮组"
```

---

### Task 3: e2e + 门禁 + 文档

**Files:**
- Modify: `apps/web/e2e/b-md-syntax.spec.ts`（或新建 b-md-lightbox.spec.ts——新建为佳，画廊语义独立）
- Create: `samples/md/lightbox-sampler.md`（多图+一个 graphviz 图）
- Modify: `README.md`（lightbox 能力行）

- [ ] **Step 1: e2e 用例**：
  1. 点击图 → overlay 开；←/→ 切换（计数徽标变化）；Esc 关。
  2. 图表 svg 在画廊内（graphviz 图打开后 next 到位）。
  3. 缩放：+ 键后 transform scale 变化、r 重置。
  4. 平移：鼠标拖拽后 transform translate 变化（chromium project）。
- [ ] **Step 2: 门禁**：`pnpm typecheck && pnpm vitest run && pnpm --filter web build:e2e && pnpm --filter web exec playwright test b-md-lightbox`
- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/b-md-lightbox.spec.ts samples/md/lightbox-sampler.md README.md
git commit -m "test(e2e): lightbox 全交互四用例+README 同步"
```
