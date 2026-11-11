import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '@playwright/test';
import { hash8 } from '@bhxch/vviewer-core';
import { openDirText, openFile, openRightIfNarrow, tabNamed, waitAppMounted } from './helpers';
import { ensureRightDrawer } from './drawer';

/**
 * 打开方式「更多渲染器」展开三入口 e2e（议题一，域文档条目 OWM-01~03）：
 * - OWM-01 MetaPanel 下拉（入口 B）：受限候选尾「更多渲染器…」哨兵（value=__more__）
 *   就地展开为「自动 + registry 全量 + 收起附加候选」（value=__less__；全量 61=29 diagram+20 foreign+12 core，统一验证阶段重定基），全量选择
 *   archive 落 override + （手动）徽标；
 * - OWM-02 状态栏浮层（壳 A）：指示器钮弹候选浮层，「更多渲染器…」就地展开，选
 *   JSON Lines 即时重渲染（jsonl 专有视图上位）+ 指示器跟随 + （手动）徽标；
 * - OWM-03 Tab 右键（壳 B）：「打开方式」子菜单内「更多渲染器」二级子菜单（registry
 *   全量）可选 PDF，run 必关 + 即时重渲染 + ✓ 回显 + （手动）徽标。
 *
 * 简报 Step 2 四处校准的实测事实（2026-10-28 核对源码）：
 * ① 状态栏指示器钮 = `.vv-status-openwith`（aria-label 动态「打开方式: {渲染器}
 *   （{检出}）」——a11y Task 2 纳入可见值，原静态「打开方式」，非简报草稿的
 *   「渲染器」）；浮层项为 `.vv-status-picker[role=menu]` 内 role=menuitem 按钮
 *   （ViewerPane.svelte :527-536），简报 getByRole('button') 按 menuitem 校准。
 * ② registry 真实 label：jsonl = 「JSON Lines」（render-text/src/jsonl/index.ts:950）、
 *   pdf = 「PDF」（render-doc/src/pdf.ts:142）；全量 61 项 = 29 diagram + 20 foreign 桥接组 + 自有 core（代码/文本、Markdown、）
 *   HTML 预览、图片、音视频、PDF、Word 文档、Excel 表格、PowerPoint（文本提纲）、
 *   二进制、压缩包、JSON Lines（viewer.ts install 序，展开面 OWM-01 断言钉住）。
 * ③ TabContextMenu 项确为 role=menuitem；但父项（子菜单）经 onclick 展开无 hover
 *   路径（toggleSub，TA-09 先例），且父项可访问名带「 ›」尾缀——简报的 hover/exact
 *   按 click + 子串匹配校准。
 * ④ tab 定位复用 t-tab-actions 的 tabNamed 装置（.vv-tab-name 子元素锚定，右键菜单
 *   同款）；简报 getByRole('tab') 弃用系历史口径（a11y Task 2 前关闭字形在 tab 根级
 *   textContent 内）——Task 2 后 role=tab 落内层 .vv-tab-hit 且 ✕ aria-hidden，
 *   getByRole('tab', { name }) 已实测可用（Task 13 探针校准）；tabNamed 保留为类锚
 *   稳态装置（可访问名随徽标/图标字形组合面变化，见 helpers.ts tabNamed 注记）。
 *
 * 已知语义（Task 2 评审裁定，断言面据此校准）：override 指向受限候选外的渲染器时
 * MetaPanel select 回退显示「自动」（受限面无匹配项，回退自动 > 空白选中——Svelte
 * value effect 随 openWithUi 重写），（手动）徽标为生效标识——故 OWM-01 简报的
 * toHaveValue('archive') 校准为「错误卡片上位（重渲染产物）+ 回退自动 + 徽标」，
 * OWM-02/03 同理断言徽标 + 重渲染产物而非 select value。
 *
 * 通道：目录注入经 __vvOpenDirImpl（helpers.ts openDirText，组名 owm）+ 树行点击开
 * 文件 tab（helpers.ts openFile——只建目录 store tab，文件 tab 须树行打开）。
 * default 套件双 project 全跑，窄视口经 helpers openFile/openRightIfNarrow 适配。
 *
 * OWM-04..07（域文档测绘差距新增锚，2026-11-03 核对源码的断言口径）：
 * - OWM-04 三入口收起对称性：__more__/__less__ 是纯 UI 哨兵（RendererPickerMenu.ts
 *   :13-14），收起必须精确还原受限面——MetaPanel option 逐项 toHaveText 对照 OWM-01
 *   受限序；浮层 LESS 分支只复位展开态不关浮层（ViewerPane.svelte:176 pickRenderer
 *   的 __less__ 拦截 return，不写 pickerOpen）；TabCtx 二级 = 「✓ 自动（按扩展名）」
 *   头项 + registry 全量 61 = 62 项、无「收起附加候选」（形态差异，TabBar.svelte
 *   :136-148 无 LESS 哨兵——回受限由菜单重开承担，OWM-05①）。受限面 label 序统一
 *   以词落 toHaveText（hex label=「二进制」，openWithOf 兜底序 自动/code/markdown/hex，
 *   openWith.ts:32-34）；浮层计数用 .vv-status-picker-item（避开尾部语言项
 *   .vv-status-picker-lang 同 role=menuitem，ViewerPane.svelte:876）。
 * - OWM-05 展开态生命周期（434e6a4 修复面）：TabContextMenu 随 {#if ctx !== null}
 *   整棵卸载（TabBar.svelte:335）、关闭路径收敛 onclose（TabContextMenu.svelte:24），
 *   openPath 组件局部新实例空起步 → 重开即受限头面（一级 5 项 = 受限 4 + 「更多
 *   渲染器 ›」父项）；切 tab 的 pointerdown 走外点关菜单（TabContextMenu.svelte:148）
 *   → 重开二级 = 62 项不残留；状态栏浮层展开态随激活 tab id 复位（ViewerPane
 *   .svelte:118-121 复位 effect，MetaPanel :66-69 同款）→ 切 tab 重开浮层回受限面。
 *   备案（非断言）：同 tab 内关浮层再开不复位——pickerExpanded 写点仅 MORE/LESS
 *   拦截与 tab 复位 effect 两类，spec §2.2「不持久化」指不进快照/设置，非浮层开关复位。
 * - OWM-06 override 会话恢复：**场景文档前置「目录注入」对本断言不可达**（2026-11-03
 *   实测核对）——本地注入目录（openDirectoryViaInput 内存 File store）不在 restore
 *   重建范围（AppShell.svelte:872/:886/:907 仅 localfs 句柄/remote/direct 三类），
 *   reload 落 addPlaceholderTab（:960）：占位 store read 即抛错且不读回
 *   overrideRenderer（:1018-1024，t-open-with OPEN-03「本地注入内容不跨刷新」同源
 *   语义），jsonl 视图/徽标/指示器三锚均不可能出现。故沿 BUG-69（t-open-with
 *   .spec.ts:258）的测试内假 vviewer 服务器 remote 来源通道：remote 来源 reload 后
 *   可重连重建并读回 overrideRenderer（AppShell.svelte:953-955），验收语义（运行期
 *   浮层选择 → 快照落盘 → reload 恢复三锚同帧）不变。语料全本地（127.0.0.1 测试内
 *   http 服务 + /api/file 内联合法 jsonl 两行），零外网面。
 * - OWM-07 双向回显（MetaPanel 主入口 → 状态栏指示器，OWM-02 只锚反向）：受限内
 *   选择 markdown 与候选集匹配 → select 不回退自动（与 OWM-01 受限外回退分叉）；
 *   指示器 label 以 registry label 全文断言（'Markdown' 非 id，ViewerPane.svelte:669）。
 */

test.describe('打开方式「更多渲染器」展开（OWM）', () => {
  test('OWM-01 MetaPanel：受限候选尾有「更多渲染器…」，激活后展开全量并可选 archive', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await waitAppMounted(page);
    await openDirText(page, 'owm', 'aa.txt', 'hello vviewer');
    await openFile(page, 'aa.txt');
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });

    await openRightIfNarrow(page);
    const sel = page.locator('.meta-openwith');
    await expect(sel).toBeVisible();
    // .txt 受限候选：自动/code/markdown/hex + 哨兵「更多渲染器…」（value=__more__）
    await expect(sel.locator('option')).toHaveCount(5);
    await expect(sel.locator('option[value="__more__"]')).toHaveCount(1);
    await expect(sel.locator('option[value="__more__"]')).toHaveText('更多渲染器…');
    await sel.selectOption('__more__');
    // 展开面 = 自动 头项 + registry 全量 + 「收起附加候选」（__less__）。统一验证阶段
    // 重定基（时代差锚）：registry 实态 61 = 29 diagram（计划 1）+ 20 foreign 桥接组
    // （计划 3/4）+ 12 自有 core，展开面 63 项（自动 + 61 + 收起）——计数随注册面增长
    // 重定，install 序语义（diagram → foreign → core，viewer.ts 装配序）以首尾 + 代表
    // 项钉住不再逐项全列
    await expect(sel.locator('option')).toHaveCount(63);
    await expect(sel.locator('option').first()).toHaveText('自动（按扩展名）');
    await expect(sel.locator('option[value="__less__"]')).toHaveText('收起附加候选');
    await expect(sel.locator('option').nth(1)).toHaveText('Mermaid'); // diagram 块居首（装配序锚）
    // 语义锚保持：archive 可选（受限外选择 → 错误卡片面）、PDF/JSON Lines 在全量面
    await expect(sel.locator('option[value="archive"]')).toHaveCount(1);
    await expect(sel.locator('option[value="pdf"]')).toHaveCount(1);
    await expect(sel.locator('option[value="jsonl"]')).toHaveCount(1);
    // 全量面选择 archive：override 落盘即时重渲染（rev++ 复用渲染 effect 通道）——
    // txt 字节非压缩包 → archive 构造失败抛中文错误，dispatcher 错误卡兜底上位。
    // select 显示回「自动」为既有语义：override 指向受限候选外的渲染器时 openWithUi
    // current 落空、Svelte value effect 重写回 ''（Task 2 评审裁定「受限外回退自动」，
    // 简报的 toHaveValue('archive') 按此校准），（手动）徽标为生效标识
    await sel.selectOption('archive');
    await expect(page.locator('.vv-error-card')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-code-pre')).toHaveCount(0);
    await expect(sel).toHaveValue('');
    await expect(page.locator('.meta-openwith-manual')).toBeVisible();
  });

  test('OWM-02 状态栏浮层：「更多渲染器…」就地展开，选 JSON Lines 生效', async ({ page }) => {
    test.setTimeout(60_000);
    await waitAppMounted(page);
    await openDirText(page, 'owm', 'aa.txt', 'hello vviewer');
    await openFile(page, 'aa.txt');
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });

    // 指示器钮（aria-label 动态含可见值，a11y Task 2——校准①）弹候选浮层（壳 A 既有交互）
    const btn = page.locator('.vv-status-openwith');
    await btn.click();
    const picker = page.locator('.vv-status-picker');
    await expect(picker).toBeVisible();
    // 收起面：✓ 自动 头项 + 受限候选 + 「更多渲染器…」哨兵（项形态 role=menuitem）
    await expect(picker.getByRole('menuitem', { name: '✓ 自动（按扩展名）' })).toBeVisible();
    const more = picker.getByRole('menuitem', { name: '更多渲染器…' });
    await expect(more).toBeVisible();
    await more.click();
    // 就地展开（浮层不关）：自动 头项 + 全量 + 收起哨兵
    await expect(picker.getByRole('menuitem', { name: '自动（按扩展名）' })).toBeVisible();
    await expect(picker.getByRole('menuitem', { name: '收起附加候选' })).toBeVisible();
    const jsonl = picker.getByRole('menuitem', { name: 'JSON Lines' });
    await expect(jsonl).toBeVisible();
    await jsonl.click();
    // pickRenderer 收口（浮层关）+ setRendererOverride rev++ 即时重渲染：
    // jsonl 专有视图上位、指示器跟随 override 的 label
    await expect(picker).toHaveCount(0);
    await expect(btn).toContainText('JSON Lines');
    await expect(page.locator('.vv-jsonl')).toBeVisible({ timeout: 20_000 });
    // override 回显：（手动）徽标。MetaPanel 受限候选无 JSON Lines 项 → select 显示
    // 回「自动」为既有语义（Task 2 评审裁定），徽标为生效标识（校准④注）
    await openRightIfNarrow(page);
    await expect(page.locator('.meta-openwith-manual')).toBeVisible();
  });

  test('OWM-03 Tab 右键：打开方式 ▸ 更多渲染器 二级子菜单可选 PDF', async ({ page }) => {
    test.setTimeout(60_000);
    await waitAppMounted(page);
    await openDirText(page, 'owm', 'aa.txt', 'hello vviewer');
    await openFile(page, 'aa.txt');
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });

    // 右键菜单（壳 B）：「打开方式」父项点击展开（无 hover 展开路径——校准③，
    // TA-09 先例）；子菜单内「更多渲染器」二级父项再展开 registry 全量
    await tabNamed(page, 'aa.txt').click({ button: 'right' });
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.getByRole('menuitem', { name: '打开方式' }).click();
    const sub = page.locator('.vv-tabctx-sub');
    await expect(sub).toBeVisible();
    const moreParent = page.getByRole('menuitem', { name: '更多渲染器' });
    await expect(moreParent).toBeVisible();
    await moreParent.click();
    const pdf = page.getByRole('menuitem', { name: 'PDF', exact: true });
    await expect(pdf).toBeVisible();
    await pdf.click();
    // run 语义（动作后必关）+ override pdf 即时重派 dispatch：txt 字节非 PDF →
    // 错误卡片上位（code 退场）
    await expect(page.locator('.vv-tabctx')).toHaveCount(0);
    await expect(page.locator('.vv-code-pre')).toHaveCount(0);
    await expect(page.locator('.vv-error-card')).toBeVisible({ timeout: 20_000 });

    // ✓ 随 override 回显于二级子菜单（TabBar 按 overrideRenderer 打标）；Esc 逐层收
    // 子菜单（一层一次，收尽再关主菜单——TabContextMenu onKey 语义，两层展开共三次）
    await tabNamed(page, 'aa.txt').click({ button: 'right' });
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.getByRole('menuitem', { name: '打开方式' }).click();
    await page.getByRole('menuitem', { name: '更多渲染器' }).click();
    await expect(page.getByRole('menuitem', { name: '✓ PDF' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-tabctx-sub')).toHaveCount(1); // 二级收、一级留
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-tabctx-sub')).toHaveCount(0);
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-tabctx')).toHaveCount(0);

    // override 回显：（手动）徽标（受限候选无 PDF 项 → select 显示回「自动」为既有
    // 语义，OWM-02 注同源）；窄视口右栏在抽屉里，先断言菜单面后开抽屉
    await openRightIfNarrow(page);
    await expect(page.locator('.meta-openwith-manual')).toBeVisible();
  });

  test('OWM-04 三入口收起对称性：MetaPanel __less__ / 浮层「收起附加候选」/ TabCtx 二级无收起项', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await waitAppMounted(page);
    await openDirText(page, 'owm', 'aa.txt', 'hello vviewer');
    await openFile(page, 'aa.txt');
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });

    // ① MetaPanel：__more__ 展开后 __less__ 收起 → option 面精确还原受限 5 项。
    // mobile 用 ensureRightDrawer(true)（openRightIfNarrow 点完不等 0.2s transform
    // 过渡落定，后续瞬时采样会在过渡中段把「开」读成「关」——drawer.ts:53-56 同款
    // 陷阱）；桌面视口两函数同为 no-op
    await ensureRightDrawer(page, true);
    const sel = page.locator('.meta-openwith');
    await expect(sel).toBeVisible();
    await sel.selectOption('__more__');
    // 展开面 63 = 自动 + registry 全量 61（29 diagram + 20 foreign + 12 core）+ 收起
    //（统一验证阶段注册面增长重定基，OWM-01 注）
    await expect(sel.locator('option')).toHaveCount(63);
    await sel.selectOption('__less__');
    await expect(sel.locator('option')).toHaveCount(5);
    await expect(sel.locator('option')).toHaveText([
      '自动（按扩展名）',
      '代码/文本',
      'Markdown',
      '二进制',
      '更多渲染器…'
    ]);
    // 哨兵文案复位（收起把 __more__ 项重新放回受限尾，非残留展开态）
    await expect(sel.locator('option[value="__more__"]')).toHaveText('更多渲染器…');
    // 收起动作不触碰 override：current 回显自动
    await expect(sel).toHaveValue('');
    // ② 前收右抽屉（mobile）：.vv-status-openwith 在主区状态栏（左下），375px 视口
    // 下 .vv-right 开态 inset:0 全高盖过其命中点（aside z 20 > main 内 z auto）——
    // 不收则该钮 hit-target 校验被 aside 截胡无限重试直至测试超时（两轮 trace 实证
    // 同象：aside.vv-right intercepts pointer events）。close 探针实证 toggle 钮在
    // 开态仍处 elementsFromPoint 首位（同 z 20 DOM 序在后），关通道本身可达（OUT-03
    // 先例）；此前的挂死根因是 openRightIfNarrow 不等过渡落定 + 瞬时采样误判「已
    // 关」跳过收起。OWM-03「先断言菜单面后开抽屉」的反向运用；桌面视口 ≤600px 门
    // no-op，chromium 既有路径零变化
    await ensureRightDrawer(page, false);

    // ② 浮层：「更多渲染器…」→「收起附加候选」→ 浮层不关、menuitem 面回受限 5 项
    const btn = page.locator('.vv-status-openwith');
    await btn.click();
    const picker = page.locator('.vv-status-picker');
    await expect(picker).toBeVisible();
    await picker.getByRole('menuitem', { name: '更多渲染器…' }).click();
    await expect(picker.locator('.vv-status-picker-item')).toHaveCount(63);
    await picker.getByRole('menuitem', { name: '收起附加候选' }).click();
    // LESS 分支只复位展开态（pickRenderer 拦截 return）：浮层仍开
    await expect(picker).toBeVisible();
    await expect(picker.locator('.vv-status-picker-item')).toHaveCount(5);
    await expect(picker.locator('.vv-status-picker-item')).toHaveText([
      '✓ 自动（按扩展名）',
      '代码/文本',
      'Markdown',
      '二进制',
      '更多渲染器…'
    ]);
    // 收起不封死重开路径：再次「更多渲染器…」就地展开全量仍可用
    await picker.getByRole('menuitem', { name: '更多渲染器…' }).click();
    await expect(picker.locator('.vv-status-picker-item')).toHaveCount(63);
    await page.keyboard.press('Escape'); // 收尾关浮层（Esc 关闭路径，无 override 落盘）
    await expect(picker).toHaveCount(0);

    // ③ TabCtx 二级子菜单静态形态：「✓ 自动」头项 + registry 全量 61 = 62 项，
    // 无「收起附加候选」（计数重定基同 OWM-01 注；首尾 + 语义在位锚代逐项全列）
    await tabNamed(page, 'aa.txt').click({ button: 'right' });
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.getByRole('menuitem', { name: '打开方式' }).click();
    await page.getByRole('menuitem', { name: '更多渲染器' }).click();
    const sub = page.locator('.vv-tabctx-sub[aria-label="更多渲染器"]');
    await expect(sub).toBeVisible();
    await expect(sub.locator('.vv-tabctx-item')).toHaveCount(62);
    await expect(sub.locator('.vv-tabctx-item').first()).toHaveText('✓ 自动（按扩展名）');
    await expect(sub.locator('.vv-tabctx-item').nth(1)).toHaveText('Mermaid');
    await expect(sub.getByRole('menuitem', { name: 'PDF', exact: true })).toHaveCount(1);
    await expect(sub.locator('.vv-tabctx-item', { hasText: '收起附加候选' })).toHaveCount(0);
    // 限高滚动面（可达性修复锚，随 CI 稳定化补）：62 项 ~1900px 超出 max-height
    // 100vh-16px → 子菜单内部可滚，尾部自有 core 段（PDF 等）经滚动触达——
    // fixed 浮层内越界部分曾鼠标永不可达（OWM-03 pdf.click「outside of the viewport」
    // 实录）；动态点击可达性由 OWM-03 的 pdf.click() 承担
    const [scrollHeight, clientHeight] = await sub.evaluate((el) => [el.scrollHeight, el.clientHeight]);
    expect(scrollHeight, '62 项超出子菜单限高（内部滚动面成立）').toBeGreaterThan(clientHeight);
    // Esc 逐层收（二级 → 一级 → 主菜单，OWM-03 同款三层语义）
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-tabctx')).toHaveCount(0);
  });

  test('OWM-05 展开态生命周期：TabCtx 重开即新实例 / 切 tab 二级不残留 / 浮层随激活 tab 复位', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await waitAppMounted(page);
    // 一次注入两文件（同组 owm）：openDirText 单文件通道两次调用会各建目录 store
    // （addDirStoreTab 按 store.id 去重，同 label 不同 store 不合并）——本 spec 局部
    // 双文件变体（helpers openDirText 同构 evaluate，Files 数组一次注入）
    await page.evaluate(
      ({ g, files }) => {
        const fs = files.map(
          ({ n, t }) =>
            Object.defineProperty(new File([t], n, { type: 'text/plain' }), 'webkitRelativePath', {
              value: `${g}/${n}`
            }) as File
        );
        return (window as unknown as { __vvOpenDirImpl: (f: File[]) => void }).__vvOpenDirImpl(fs);
      },
      { g: 'owm', files: [{ n: 'aa.txt', t: 'hello vviewer' }, { n: 'bb.txt', t: 'another text' }] }
    );
    await openFile(page, 'aa.txt');
    await openFile(page, 'bb.txt');
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });

    // ① 重开即新实例：展开二级 → Esc 逐层收尽 → 再右键同 tab 直接读一级面
    await tabNamed(page, 'bb.txt').click({ button: 'right' });
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.getByRole('menuitem', { name: '打开方式' }).click();
    await page.getByRole('menuitem', { name: '更多渲染器' }).click();
    await expect(page.locator('.vv-tabctx-sub[aria-label="更多渲染器"]')).toBeVisible();
    await page.keyboard.press('Escape'); // 收二级
    await page.keyboard.press('Escape'); // 收一级
    await page.keyboard.press('Escape'); // 关主菜单
    await expect(page.locator('.vv-tabctx')).toHaveCount(0);
    await tabNamed(page, 'bb.txt').click({ button: 'right' });
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.getByRole('menuitem', { name: '打开方式' }).click();
    // 新实例 openPath 空起步：一级 = 受限 4 + 「更多渲染器 ›」父项 = 5 项，二级未展开
    const firstSub = page.locator('.vv-tabctx-sub[aria-label="打开方式"]');
    await expect(firstSub).toBeVisible();
    await expect(firstSub.locator('.vv-tabctx-item')).toHaveCount(5);
    await expect(firstSub.locator('.vv-tabctx-item')).toHaveText([
      '✓ 自动（按扩展名）',
      '代码/文本',
      'Markdown',
      '二进制',
      '更多渲染器 ›'
    ]);
    await expect(page.locator('.vv-tabctx-sub[aria-label="更多渲染器"]')).toHaveCount(0);
    // 一级子菜单已展开（点过「打开方式」openPath=[idx]）→ Esc 一层一次：先收一级
    // 子菜单，再关主菜单（TabContextMenu.svelte:139-143，二级展开态三次的同构少一层）
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-tabctx')).toHaveCount(0);

    // ② 切 tab 二级不残留（434e6a4 修复面）：二级展开态下点另一 tab（pointerdown
    // 外点先关旧菜单 + activateTab）→ 重开二级 = ✓ 自动头项 + 全量 61 = 62 项
    await tabNamed(page, 'bb.txt').click({ button: 'right' });
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.getByRole('menuitem', { name: '打开方式' }).click();
    await page.getByRole('menuitem', { name: '更多渲染器' }).click();
    await expect(page.locator('.vv-tabctx-sub[aria-label="更多渲染器"]')).toBeVisible();
    // 外点关菜单 + 切激活 tab。点 tab 上半沿（position y=6 < tab 行中线）：ctx 菜单
    // 自右键点（tab 行中线 y）向下铺开，tab 上半沿恒在浮层覆盖带之外——标签栏收敛
    // Task 1 左簇收窄使 aa.txt tab 左移入浮层 x 覆盖带，中心点（=行中线）恰被浮层
    // 上缘截住（基线布局的亚像素侥幸），改点上半沿保语义不依赖布局巧合
    await tabNamed(page, 'aa.txt').click({ position: { x: 30, y: 6 } });
    await expect(page.locator('.vv-tabctx')).toHaveCount(0);
    await tabNamed(page, 'aa.txt').click({ button: 'right' });
    await expect(page.locator('.vv-tabctx')).toBeVisible();
    await page.getByRole('menuitem', { name: '打开方式' }).click();
    await page.getByRole('menuitem', { name: '更多渲染器' }).click();
    const subAgain = page.locator('.vv-tabctx-sub[aria-label="更多渲染器"]');
    await expect(subAgain).toBeVisible();
    await expect(subAgain.locator('.vv-tabctx-item')).toHaveCount(62);
    await expect(subAgain.locator('.vv-tabctx-item').first()).toHaveText('✓ 自动（按扩展名）');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-tabctx')).toHaveCount(0);

    // ③ 状态栏浮层随激活 tab 复位：展开态下切 tab（渲染 effect cleanup 关浮层 +
    // 复位 effect 翻 pickerExpanded）→ 重开浮层回受限 5 项（非展开 63 项）
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 }); // aa.txt 渲染完成
    const btn = page.locator('.vv-status-openwith');
    await btn.click();
    const picker = page.locator('.vv-status-picker');
    await expect(picker).toBeVisible();
    await picker.getByRole('menuitem', { name: '更多渲染器…' }).click();
    // 展开面 63 = 自动 + registry 全量 61 + 收起（OWM-02/④ 同面口径；本行注册面
    // 增长期未随 f0bee90 重定基——彼时本用例恒在 ③ 前的 TabCtx 段（label 重复崩页）
    // 失败，此行从未被跑到，陈旧计数 14（M4 时代 registry 12+自动+哨兵）漏网至本批）
    await expect(picker.locator('.vv-status-picker-item')).toHaveCount(63);
    await tabNamed(page, 'bb.txt').click(); // 切 tab：浮层随实例切换关闭
    await expect(picker).toHaveCount(0);
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 }); // bb.txt 渲染完成
    await btn.click();
    await expect(picker).toBeVisible();
    await expect(picker.locator('.vv-status-picker-item')).toHaveCount(5);
    await expect(picker.locator('.vv-status-picker-item').first()).toHaveText('✓ 自动（按扩展名）');
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
  });

  test('OWM-06 override 会话恢复：浮层选 JSON Lines 快照落盘 → reload 后视图/徽标/指示器三锚同帧', async ({
    page
  }) => {
    test.setTimeout(60_000);
    // 假 vviewer 文件服务器（BUG-69 / t-open-with.spec.ts:258 同款通道）：remote 来源
    // reload 后可重连重建并读回 overrideRenderer（AppShell.svelte:953-955）——场景文档
    // 前置「目录注入」不可恢复内容（头注 OWM-06 段），验收语义（运行期浮层选择 →
    // 落盘 → reload 恢复）不变。/api/file 返回合法 jsonl 两行，恢复后卡片可断言内容。
    const jsonlBody = '{"id":1,"label":"first"}\n{"id":2,"label":"second"}\n';
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const cors = { 'Access-Control-Allow-Origin': '*' };
      if (url.pathname === '/api/health') {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ capabilities: ['file-server'] }));
        return;
      }
      if (url.pathname === '/api/file') {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/jsonl' });
        res.end(jsonlBody);
        return;
      }
      if (url.pathname === '/api/ticket') {
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ticket: 'e2e' }));
        return;
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
        return; // 保持打开、无数据帧：SSE 挂起即可（测试结束统一断连）
      }
      res.writeHead(404, cors);
      res.end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitAppMounted(page);
      // 预置 remote 会话（无 override，BUG-69 同款快照形态）：目录条目派生来源 + 文件 tab
      const remoteId = `remote:${hash8(`${base}:e2e-fake`)}`;
      const baseTab = {
        storeId: remoteId,
        storeLabel: 'e2e-fake',
        storeBase: base,
        kind: 'rename-only' as const,
        scrollTop: 0
      };
      await page.evaluate(
        (seed) =>
          new Promise<void>((resolve, reject) => {
            sessionStorage.setItem(
              'vviewer-last-server',
              JSON.stringify({ baseUrl: seed.base, token: null })
            );
            const open = indexedDB.open('vviewer');
            open.onupgradeneeded = () => {
              if (!open.result.objectStoreNames.contains('kv')) open.result.createObjectStore('kv');
            };
            open.onsuccess = () => {
              const db = open.result;
              const tx = db.transaction('kv', 'readwrite');
              tx.objectStore('kv').put(
                [
                  { ...seed.baseTab, id: 't0', path: '', name: 'e2e-fake', active: false },
                  { ...seed.baseTab, id: 't1', path: 'notes.txt', name: 'notes.txt', active: true }
                ],
                'tabs'
              );
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onerror = () => {
                db.close();
                reject(tx.error);
              };
            };
            open.onerror = () => reject(open.error);
          }),
        { base, baseTab }
      );
      await page.reload(); // 第一次 reload：remote 会话恢复（自动路由 code 视图）
      await expect(tabNamed(page, 'notes.txt')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });

      // ① 状态栏浮层展开选 JSON Lines（受限外选择，OWM-02 同链）：jsonl 专有视图 +
      // （手动）徽标 + 指示器 label 跟随
      const btn = page.locator('.vv-status-openwith');
      await btn.click();
      const picker = page.locator('.vv-status-picker');
      await expect(picker).toBeVisible();
      await picker.getByRole('menuitem', { name: '更多渲染器…' }).click();
      await picker.getByRole('menuitem', { name: 'JSON Lines' }).click();
      await expect(picker).toHaveCount(0);
      await expect(page.locator('.vv-jsonl')).toBeVisible({ timeout: 20_000 });
      await openRightIfNarrow(page);
      await expect(page.locator('.meta-openwith-manual')).toBeVisible();
      await expect(btn).toContainText('JSON Lines');

      // ② 等快照落盘（v2 workspaces 键含 notes.txt overrideRenderer='jsonl'，
      // OPEN-03 轮询先例：异步 debounce 写勿用固定 sleep）
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                new Promise<boolean>((resolve) => {
                  const open = indexedDB.open('vviewer');
                  open.onsuccess = () => {
                    const db = open.result;
                    try {
                      const get = db.transaction('kv', 'readonly').objectStore('kv').get('workspaces');
                      get.onsuccess = () => {
                        const snap = get.result as
                          | { workspaces?: { tabs?: { name?: string; overrideRenderer?: string }[] }[] }
                          | undefined;
                        const tabs = Array.isArray(snap?.workspaces)
                          ? snap.workspaces.flatMap((w) => w.tabs ?? [])
                          : [];
                        resolve(
                          tabs.some((t) => t.name === 'notes.txt' && t.overrideRenderer === 'jsonl')
                        );
                        db.close();
                      };
                      get.onerror = () => {
                        resolve(false);
                        db.close();
                      };
                    } catch {
                      resolve(false);
                      db.close();
                    }
                  };
                  open.onerror = () => resolve(false);
                })
            ),
          {
            timeout: 20_000,
            message: 'override 落盘：workspaces 快照应含 notes.txt overrideRenderer=jsonl'
          }
        )
        .toBe(true);

      // ③ reload → 会话恢复三锚同帧：override 读回（AppShell.svelte:953-955）→
      // jsonl 视图（非 code 视图）+ 内容卡 + 指示器 label 随恢复的 override 重建
      await page.reload();
      await expect(tabNamed(page, 'notes.txt')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('.vv-jsonl')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('.vv-code-pre')).toHaveCount(0);
      await expect(page.locator('.vv-jsonl-card', { hasText: 'first' })).toBeVisible({
        timeout: 20_000
      });
      await expect(page.locator('.vv-status-openwith')).toContainText('JSON Lines');
      await openRightIfNarrow(page); // reload 后抽屉复位，重开右栏断徽标
      await expect(page.locator('.meta-openwith-manual')).toBeVisible();
    } finally {
      server.close();
      server.closeAllConnections(); // /api/events 长连接不 end：close() 需配套断连
    }
  });

  test('OWM-07 MetaPanel 主入口 → 状态栏指示器回显：受限内选 Markdown 不回退自动', async ({
    page
  }) => {
    test.setTimeout(60_000);
    await waitAppMounted(page);
    await openDirText(page, 'owm', 'aa.txt', 'hello vviewer');
    await openFile(page, 'aa.txt');
    await expect(page.locator('.vv-code-pre')).toBeVisible({ timeout: 20_000 });

    await openRightIfNarrow(page);
    const sel = page.locator('.meta-openwith');
    await expect(sel).toBeVisible();
    // 受限内选择（.txt 候选含 markdown）：override 与候选集匹配 → select 保持
    // markdown 不回退（与 OWM-01 受限外选择回退自动分叉）
    await sel.selectOption('markdown');
    await expect(sel).toHaveValue('markdown');
    await expect(page.locator('.meta-openwith-manual')).toBeVisible();
    // setRendererOverride rev++ 重派：markdown 专有视图上位（code 退场）
    await expect(page.locator('.vv-markdown')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.vv-code-pre')).toHaveCount(0);
    // 双向回显主锚：状态栏指示器 label 以 registry label 全文重建（'Markdown' 非 id，
    // ViewerPane.svelte:669 rendererLabel = registry.byId(res.rendererId)?.label）
    await expect(page.locator('.vv-status-openwith')).toContainText('Markdown');
  });
});
