# 触屏适配：自动感应 + 三态设置 + 触屏档案 — 设计

日期：2026-11-12　状态：待用户审阅

## 1. 背景与动机

当前「移动端」体验完全由宽度断点驱动（≤900px 左栏抽屉 / ≤600px 右栏抽屉），没有任何触屏探测：触屏笔记本在 1440px 宽下得不到触屏交互优化，而小窗桌面浏览器反而吃到移动形态。用户要求：感知到触屏设备自动启用触屏优化，并支持设置强制指定。

**拍板（2026-11-12）**：触屏档案 ≠ 移动布局——布局仍按宽度断点判定，触屏感知后**叠加交互优化**；配三态设置：自动 / 强制触屏 / 强制桌面。

## 2. 现状锚点

- 判定方式：纯 CSS media query（断点 900/600）+ 少量 JS `matchMedia('(max-width:900px)')`（AppShell:532-534 `isDrawerBreakpoint`）；无 `pointer:coarse`、无 `maxTouchPoints` 探测。
- 现有触屏特化（全部绑宽度或 hover:none）：
  - 双抽屉状态机 shellDrawers.ts（左 ☰ / 右 ℹ 浮钮 32×32，AppShell:1491-1492/:1663-1707）；
  - zen 移动端 44px 退出浮钮 + 返回键拦截（zenGuard.ts）；
  - `@media (hover:none)` 仅一处：FileTree 源行删除钮恒显（FileTree.svelte:156-158）；
  - ≤600px 常显替代 hover：工作区操作钮（app.css:463）、wspanel 关闭钮（:515）、菜单触发钮/条目 padding-block:8px（:604-608）。
- 设置面：无任何移动/触屏字段；加设置的改动面清单见侦察（Settings 类型/DEFAULTS/normalizeSettings/settingsDraft validate+allowed 手工表/节组件/i18n 双目录/测试，AppShell:766-797 消费订阅）。

## 3. 设计

### 3.1 检测与生效态

- 新单源响应式模块 `apps/web/src/lib/touchProfile.svelte.ts`（runes）：
  - `touchMode: 'auto'|'touch'|'desktop'`（来自 settings）；
  - 感知：`matchMedia('(pointer: coarse)').matches` 且 `navigator.maxTouchPoints > 0` → coarse 主动输入；监听 pointercoarse/pointerfine 变化（外接键鼠切换热更新）；
  - `isTouchActive = mode==='touch' ? true : mode==='desktop' ? false : coarse`（auto）。
- 反目标：不做 UA 嗅探、不做触摸事件首次命中启发（pointer:coarse 已足够且可热切换）。

### 3.2 设置面

- `settings.touch.mode: 'auto'|'touch'|'desktop'`，默认 `'auto'`。
- 归属节（裁量）：**layout 节**（布局与交互近邻，避免新组）；`layout.ts` 的 `LayoutSettings/DEFAULT_LAYOUT/sanitizeLayout` 同步（先例 zen 字段）；`settingsDraft.ts` layout 节走 `sanitizeLayout` 复用（零 allowed 表改动——选 layout 节的关键收益）。
- UI：LayoutSection 加三态控件（对齐 themeMode 三态控件先例）；i18n 双目录补键（zh-CN/en settings）。

### 3.3 触屏档案行为清单（本期落地面）

1. **hover 依赖控件常显**：FileTree 源行删除钮（现 hover:none 特化改挂 `isTouchActive`）、工作区操作钮、wspanel 关闭钮、TabBar 悬浮滚动箭头（SCRL 箭头 hover/focus 显隐——触屏档案下常显或点滚动体边缘唤出，裁量）。实现：`touchProfile.svelte.ts` 输出 body 级 class（如 `data-touch="on"`）或 CSS 变量/类切换，CSS 侧以属性选择器替代/叠加 media query。
2. **点击目标加大**：菜单触发钮/条目 padding-block:8px（现仅 ≤600px）在触屏档案下同样生效；浮钮类（抽屉 toggle、zen 退出）≥40px 检查（现 32×32 抽屉钮在触屏档案升 40×40 或扩热区，裁量）。
3. **滚动箭头/把手**：`.vv-colhandle` 已 `touch-action:none`；TabBar wheel 横移在触屏档案下仍可用（触屏无 wheel——确认现有 SCRL-08 触屏补口覆盖，裁量记录）。
4. **明确不做**（反目标）：宽度断点布局任何改变；抽屉浮钮在 >900px 触屏设备上出现（抽屉仍按宽度触发）；滑动手势/长按菜单（后续候选）。

### 3.4 强制档语义

- `desktop`：coarse 设备上恢复 hover 语义（常显类全部回收），供外接鼠标为主、偶触屏的混合设备。
- `touch`：fine pointer 设备（如带触摸屏的台式机）强行启用常显与加大目标。

## 4. 验收锚点

- 单测：touchProfile 派生逻辑（三态 × coarse/fine 矩阵）；settings 归位/校验用例（layout 节新字段）。
- e2e：①设置三态切换 → body 属性/常显类翻转；②auto 档在 chromium（fine pointer）不吃触屏档案、mobile project（hasTouch）吃档案；③FileTree 删除钮在 mobile project 恒显（既有 hover:none 断言迁移后保持）。
- 既有锚：b-layout-zen、MOB-01、SCRL-08 不翻转。

## 5. 留给 builder 的裁量

- body 级 data 属性 vs 各组件内订阅的传导方式（推荐 data 属性单点，CSS 集中）；触屏档案下各 hover 控件的具体常显样式归并；设置归属节的最终决定（若离开 layout 节需同步补 settingsDraft allowed 表）；SCRL 箭头触屏形态。
