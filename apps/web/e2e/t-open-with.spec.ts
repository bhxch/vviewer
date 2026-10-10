import { test, expect, type Page } from '@playwright/test';

/**
 * open-with 域回归（C 项「格式覆盖自动化」Task 7）：探测链与打开方式 override 的
 * 端到端验收（spec §2.2/§2.3）。
 * - OPEN-01：未知扩展名 probe.foo（PNG 签名内容）→ 签名改派 → image 视图
 * - OPEN-02：未知扩展名 bin.foo（NUL 二进制）→ 探测链 hex 兜底 → hex 视图
 * - OPEN-03：MetaPanel「打开方式」手选二进制 → override 即时重渲染 + 快照落盘；
 *   刷新后本地注入文件按既有语义以占位恢复（m1.spec.ts:102 先例）。override 的
 *   UI 级刷新恢复（restore 透传回读）当前实现失效（BUG-69），占位于下方 fixme。
 * - OPEN-04：notes.jsonl → code 视图——jsonl 不在 codeRenderer.extensions 手工清单
 *   （仅 json/jsonc），可预览只能来自 gen-code-extensions 生成物（C/D 装配锚点）。
 *
 * 注入通道：合成 drop（页内 new DataTransfer + DragEvent 派发 window）——先例
 * t-shell.spec.ts L145-155（SHELL-03①）；二进制载荷经 base64 → Uint8Array
 * （m1/b-* 套件的 b64 通道）。
 */

/** 1×1 PNG（与 samples/m1/pixel.png、b-app-shell-sources BUG-04 用例同源 base64） */
const PNG_1PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface DropPayload {
  name: string;
  type: string;
  content?: string;
  b64?: string;
}

/** 等应用挂载（svelte:window 的 drop 监听与 TopBar 就绪；t-shell waitAppMounted 同款） */
async function waitAppMounted(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.vv-topbar')).toBeVisible();
}

/** 合成 drop 注入单文件并等 tab 激活（先例 t-shell.spec.ts L145-155） */
async function dropFile(page: Page, payload: DropPayload): Promise<void> {
  await page.evaluate((p) => {
    const file = new File(
      [
        p.content !== undefined
          ? p.content
          : Uint8Array.from(atob(p.b64!), (c) => c.charCodeAt(0))
      ],
      p.name,
      { type: p.type }
    );
    const dt = new DataTransfer();
    dt.items.add(file);
    // 构造 File 的 webkitGetAsEntry 恒 null → collectDirectoryFiles 返回 null 走单文件通道
    window.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    );
  }, payload);
  await expect(page.locator('.vv-tab.active', { hasText: payload.name })).toBeVisible();
}

/** ≤600px 断点右栏（MetaPanel）收进抽屉（b-app-shell-sources/t-shell 同款本文件先例） */
async function openRightIfNarrow(page: Page): Promise<boolean> {
  const narrow = await page.evaluate(() => window.innerWidth <= 600);
  if (!narrow) return false;
  await page.locator('.vv-right-toggle').click();
  return true;
}

test('OPEN-01：未知扩展名 probe.foo + PNG 签名内容 → 签名改派 image 渲染', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  await dropFile(page, { name: 'probe.foo', type: 'application/octet-stream', b64: PNG_1PX_B64 });
  // .foo 不在任何扩展名清单：可渲染只能来自内容探测链 ① 签名改派（png → image）
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-image img')).toBeVisible({ timeout: 20_000 });
});

test('OPEN-02：未知扩展名 bin.foo（NUL 二进制）→ 探测链 hex 兜底', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  // 00 01 ff fe 7f 00 09：NUL 即二进制（looksTextual 与 git 同口径），且无已知签名
  // → 探测链 ③ hex 兜底（旧行为是「不支持的扩展名 ".foo"」错误卡片）
  await dropFile(page, { name: 'bin.foo', type: 'application/octet-stream', b64: 'AAH//n8ACQ==' });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-hex')).toBeVisible();
  await expect(page.locator('.vv-hex-row').first()).toBeVisible();
  // 无已知签名 → 结构树不出现，状态行落「未知二进制」（struct 解析完成后改写）
  await expect(page.locator('.vv-hex-status')).toContainText('未知二进制', { timeout: 20_000 });
});

test('OPEN-03：MetaPanel 手选二进制 → override 即时重渲染 + 快照落盘；刷新后 tab 以占位恢复', async ({
  page
}) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);

  // —— 手选链：txt 自动路由 code → 手选 hex 即时重渲染 ——
  await dropFile(page, { name: 'manual.txt', type: 'text/plain', content: 'plain text body\n' });
  await expect(page.locator('.vv-code-pre')).toContainText('plain text body', { timeout: 20_000 });
  await openRightIfNarrow(page);
  const openWith = page.locator('.meta-openwith');
  await expect(openWith).toBeVisible();
  await openWith.selectOption('hex');
  // rev++ 复用渲染 effect 重跑通道：code 退场、hex 上位（override 路径跳过探测链）
  await expect(page.locator('.vv-hex')).toBeVisible();
  await expect(page.locator('.vv-code-pre')).toHaveCount(0);
  await expect(openWith).toHaveValue('hex');
  await expect(page.locator('.meta-openwith-manual')).toBeVisible(); // （手动）标记

  // override 落盘（setRendererOverride 经代理写 → persist）：IDB tabs 快照含
  // overrideRenderer:'hex'（确定性等待异步写，m1.spec.ts:74 轮询先例）
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open('vviewer', 1);
        open.onsuccess = () => {
          const db = open.result;
          try {
            const get = db.transaction('kv', 'readonly').objectStore('kv').get('tabs');
            get.onsuccess = () => {
              const tabs = (get.result ?? []) as { name?: string; overrideRenderer?: string }[];
              resolve(
                Array.isArray(tabs) &&
                  tabs.some((t) => t.name === 'manual.txt' && t.overrideRenderer === 'hex')
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
      }),
    undefined,
    { polling: 50 }
  );

  // 刷新：本地注入 File 内容不跨刷新（m1.spec.ts:102 先例）——tab 以占位恢复（名称保留），
  // 内容侧错误卡片。override 的 UI 级刷新恢复（restore 透传回读）当前实现失效，
  // 见下方 BUG-69 fixme（根因与转正断言齐备，修复后转正）。
  await page.reload();
  await expect(
    page.locator('.vv-error-card, .vv-empty').first()
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.vv-tab', { hasText: 'manual.txt' })).toBeVisible();
});

test.fixme(
  'BUG-69 [open-with e2e]: restore 透传 overrideRenderer 裸写不生效——快照回读的 UI 级恢复恒丢 override（scrollTop 同机理，BUG-64 症状的根因补充）',
  async () => {
    // 现象（severity medium）：会话恢复时 AppShell.svelte 对 addTab 返回值的两处透传
    // `tab.overrideRenderer = t.overrideRenderer`（localfs restorable 分支与 remote 重连
    // 分支各一处，Task 4「C 项读回」）从不生效——恢复后的 tab 恒无 override：UI 按自动
    // 路由渲染（txt → code 而非手选 hex），且后续 persist 把快照里的 overrideRenderer
    // 覆写丢失。MetaPanel 手选链（setRendererOverride 经代理写）本身正常。
    //
    // 根因（Svelte 5 proxy 语义）：TabCollection.add 返回裸对象 a（openFlow.svelte.ts
    // `return this.list.push(a), persist(), a`），而 tabStore.list 是 $state 深代理——
    // proxy 的 get trap 为每个属性建 per-property source 缓存（首读时定值），后续读恒走
    // 缓存、只有经代理的写（set trap）才更新它。时序：add 内同步 persist() 的
    // snapshot(t) 经代理首读 overrideRenderer（缓存 undefined/不存在）→ AppShell 对裸
    // 对象的赋值绕过 set trap → 之后 ViewerPane 渲染 effect 与一切后续 persist 读到的
    // 都是 stale undefined。`tab.scrollTop = t.scrollTop` 的裸写同机理失效——
    // t-shell.spec.ts BUG-64 的症状（恢复 scrollTop 恒 0、快照被覆写为 0）正是此机理，
    // 本条把根因从「非同一引用」修正为「裸对象写不更新代理 per-property source」。
    //
    // 复现（本文件可达，假 vviewer 服务 + 预置快照通道）：
    //   1) 测试内起 http server（/api/health、/api/file，ACAO:*）；
    //   2) 预置 IDB 快照 [{... name:'notes.txt', storeBase, overrideRenderer:'hex'}] +
    //      sessionStorage vviewer-last-server（同 base）；
    //   3) goto('/') → restore 命中 remote 重连分支（健康探测过 → addTab → 读回行执行）；
    //   4) 期望 .vv-hex（override 命中），实际 .vv-code-pre（auto 路由 code），
    //      .meta-openwith value=''（自动）。
    // 证据（.temp/probe-openwith/ 探针，IDBObjectStore.get/put 拦截日志）：app get 到
    // 的快照 override:'hex'（读侧无误）→ addTab 同步 persist put 无 override（首读
    // 缓存 + 裸写未生效）→ 无后续 persist（预置 storeId 与重建 id 不同时 alignActive
    // 不匹配；真实流程 id 相同会再 persist，但读到的仍是 stale undefined，同样丢失）。
    //
    // 转正提示：修复方向为 Tab 状态变更一律经代理写——最小改法是 TabCollection.add
    // 返回 list 内的代理对象（`return this.list[this.list.length - 1]`），AppShell
    // restore 两处透传与 scrollTop 裸写随之全部生效（BUG-64 一并修复）；或为 restore
    // 提供 tabStore 侧透传方法（setRendererOverride 同款代理写）。修复后本占位转正：
    // 假服务 + 预置快照（overrideRenderer:'hex'）→ goto → 断言 `.vv-hex` 可见、
    // `.vv-code-pre` count 0、`.meta-openwith` value 'hex'、`.meta-openwith-manual` 可见。
  }
);

test('OPEN-04：jsonl（生成扩展名集契约锚点）→ 以 code 视图渲染', async ({ page }) => {
  test.setTimeout(60_000);
  await waitAppMounted(page);
  const jsonl = '{"id":1,"label":"first"}\n{"id":2,"label":"second"}\n';
  await dropFile(page, { name: 'notes.jsonl', type: 'application/jsonl', content: jsonl });
  await expect(page.locator('.vv-error-card')).toHaveCount(0);
  await expect(page.locator('.vv-code-pre')).toContainText('"first"', { timeout: 20_000 });
  await expect(page.locator('.vv-code-pre')).toContainText('"second"');
});
