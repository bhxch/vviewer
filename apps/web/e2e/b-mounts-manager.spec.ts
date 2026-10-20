import { test, expect, type Page } from '@playwright/test';

/**
 * b-mounts-manager 目录管理页冒烟（目录挂载 spec §5 阶段四，plan Task 2 e2e 兜底；
 * b-filetree-src-remove.spec.ts 先例形态）：
 * - MM-01 双入口与骨架：📁/Ctrl+Alt+M 开合、三组渲染、Esc 关闭
 * - MM-02 新增表单：L1 endpoint userinfo 拒绝 → 修正保存 → 列表落库（刷新存活）
 *   → 删除联动；凭据警示双处可见（表单 + 列表详情，spec §6）
 * - MM-03 测试连接：route 拦截 S3 ListObjectsV2（免验签 mock）成功回显条目数与
 *   延迟；CORS 头缺失 → 特征化文案（Task 1 疑虑①场景族）
 *
 * plan Task 3 将扩展：mock dav/代理注册全链、在树中打开→树渲染、恢复落占位链、
 * watch 不可用提示（b-mounts 回归矩阵）。
 */

/**
 * 最小 ListObjectsV2 响应（2 文件 + 1 目录 → 根目录 3 条目）。条目须符合
 * delimiter=/ 语义（prefix 为空时 Contents 只含顶层 key、子目录走 CommonPrefixes
 * 顶层前缀）——次级 key/嵌套前缀会被直连 store 的越层防御丢弃（directS3
 * listChildren 注）。
 */
const S3_LIST_XML = `<?xml version="1.0"?><ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>a.txt</Key><Size>3</Size></Contents>
  <Contents><Key>b.txt</Key><Size>1</Size></Contents>
  <CommonPrefixes><Prefix>sub/</Prefix></CommonPrefixes>
</ListBucketResult>`;

async function openManager(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.vv-topbar')).toBeVisible();
  await page.locator('button[aria-label="目录管理"]').click();
  await expect(page.locator('.vv-mounts-manager')).toBeVisible();
}

/** CORS 预检 + 响应头齐备的 S3 mock（浏览器直连 fetch 会被预检与 CORS 双关卡）。 */
async function mockS3(page: Page): Promise<void> {
  await page.route('**/127.0.0.1:9000/**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') {
      return route.fulfill({
        status: 200,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization,x-amz-content-sha256,x-amz-date',
          'access-control-allow-methods': 'GET,OPTIONS'
        },
        body: ''
      });
    }
    return route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/xml' },
      body: S3_LIST_XML
    });
  });
}

async function fillS3Form(
  page: Page,
  fields: { label: string; endpoint: string; bucket: string; ak: string; sk: string }
): Promise<void> {
  // 访问方式/类型使用表单缺省（直连 + S3）——未连接服务器时「访问方式」禁用
  // （代理不可选），不做 selectOption
  await page.locator('#vv-mm-label').fill(fields.label);
  await page.locator('#vv-mm-endpoint').fill(fields.endpoint);
  await page.locator('#vv-mm-bucket').fill(fields.bucket);
  await page.locator('#vv-mm-username').fill(fields.ak);
  await page.locator('#vv-mm-secret').fill(fields.sk);
}

test.describe('b-mounts-manager 目录管理页', () => {
  test('MM-01 双入口与骨架：📁/Ctrl+Alt+M 开合、三组渲染、Esc 关闭', async ({ page }) => {
    await openManager(page);
    const root = page.locator('.vv-mounts-manager');
    await expect(root).toHaveAttribute('aria-label', '目录管理');
    // 三组标题（role=heading——组②标题含「新增挂载」按钮文案，getByText 会与
    // 空态段落「暂无前端配置挂载」子串双命中）
    await expect(root.getByRole('heading', { name: '服务端根与挂载' })).toBeVisible();
    await expect(root.getByRole('heading', { name: /前端配置挂载/ })).toBeVisible();
    await expect(root.getByRole('heading', { name: /本机授权来源/ })).toBeVisible();
    // 未连接降级（组①）与空态（组②③）
    await expect(root.getByText(/未连接服务器/)).toBeVisible();
    await expect(root.getByText('暂无前端配置挂载。')).toBeVisible();
    // Esc 关闭（面板优先——无 zen 态时直接关面板）
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);

    // 入口② Ctrl+Alt+M：开 → 再按经 requestClose 关（Toggle 语义）
    await page.keyboard.press('Control+Alt+KeyM');
    await expect(page.locator('.vv-mounts-manager')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.vv-mounts-manager')).toHaveCount(0);
  });

  test('MM-02 新增表单：L1 userinfo 拒绝 → 修正保存 → 刷新存活 → 删除联动；警示双处可见', async ({ page }) => {
    await openManager(page);
    await page.getByRole('button', { name: '＋ 新增挂载' }).click();
    const form = page.locator('.vv-mm-form');
    await expect(form).toBeVisible();

    // spec §6：凭据警示双处固定（列表详情 + 新增表单）
    await expect(page.getByText(/明文保存在浏览器 IndexedDB/)).toHaveCount(2);

    // L1：endpoint 带 userinfo → 保存被拦并提示（不落库）
    await fillS3Form(page, {
      label: '测试桶',
      endpoint: 'https://user:pass@s3.example.com',
      bucket: 'bkt',
      ak: 'AK',
      sk: 'SK'
    });
    await form.getByRole('button', { name: '保存' }).click();
    await expect(form.getByText('请使用不含凭据的 endpoint，凭据在下方字段填写')).toBeVisible();
    await expect(form).toBeVisible(); // 未保存：表单在场

    // 修正后保存 → 列表出现（直连徽标 + 凭据已存指示）
    await page.locator('#vv-mm-endpoint').fill('https://s3.example.com');
    await form.getByRole('button', { name: '保存' }).click();
    await expect(form).toHaveCount(0);
    const row = page.locator('.vv-mm-item', { hasText: '测试桶' });
    await expect(row).toBeVisible();
    await expect(row.getByText('直连')).toBeVisible();
    await expect(row.getByText('凭据已存')).toBeVisible();

    // IndexedDB 持久化：刷新后重开仍在
    await page.reload();
    await openManager(page);
    await expect(page.locator('.vv-mm-item', { hasText: '测试桶' })).toBeVisible();

    // 删除联动（confirm 接受 → 列表空）
    page.on('dialog', (d) => void d.accept());
    await page.locator('.vv-mm-item', { hasText: '测试桶' }).getByRole('button', { name: '删除' }).click();
    await expect(page.getByText('暂无前端配置挂载。')).toBeVisible();
  });

  test('MM-03 测试连接：S3 探测回显条目数与延迟；CORS 头缺失给特征化文案', async ({ page }) => {
    await openManager(page);
    await page.getByRole('button', { name: '＋ 新增挂载' }).click();
    await fillS3Form(page, {
      label: '直连桶',
      endpoint: 'http://127.0.0.1:9000',
      bucket: 'bkt',
      ak: 'AK',
      sk: 'SK'
    });

    // 成功路径：CORS 齐备 mock → 条目数 + 延迟回显（spec §5 list_dir 探测）
    await mockS3(page);
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(page.locator('.vv-mm-form').getByText(/连接成功：根目录 3 个条目，延迟 \d+ ms/)).toBeVisible();

    // 失败路径：CORS 拦截特征（fetch TypeError）→ 特征化文案回显。用全新 origin
    // 的 route.abort——同 URL 复测会被缓存层回放首个成功响应（SW/HTTP cache，
    // CORS 失败面必须是「从未成功过」的端点，这也是真实场景形态）
    await page.locator('#vv-mm-endpoint').fill('http://127.0.0.1:9001');
    await page.route('**/127.0.0.1:9001/**', (route) => void route.abort());
    await page.getByRole('button', { name: '测试连接' }).click();
    await expect(
      page.locator('.vv-mm-form').getByText('连接失败：S3 直连失败：bucket CORS 未配置或网络不可达')
    ).toBeVisible();

    // 表单不保存关闭：未落库（mock 面不影响持久化）
    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.locator('.vv-mm-form')).toHaveCount(0);
    await expect(page.getByText('暂无前端配置挂载。')).toBeVisible();
  });

  test('MM-04 跨服务器作用域（M1）：他机注册记录徽标「注册于他机」、无打开钮、删除走强制本地删除逃生口', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.vv-topbar')).toBeVisible();
    // 装置：直写 IndexedDB v4 mounts store 预置「他机注册」代理记录
    // （serverBase 指向另一台服务器；本会话未连接 → 恒 offsite）
    await page.evaluate(async () => {
      const rec = {
        id: 'mount:offsite-e2e',
        kind: 'proxy',
        backend: 'webdav',
        label: '他机挂载',
        endpoint: 'https://dav.other.example',
        prefix: '',
        username: 'u',
        secret: 'p',
        fingerprint: 'offsite-fp',
        serverBase: 'http://other-host:9999',
        createdAt: 1700000000000,
        registeredRootIndex: 7
      };
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('vviewer', 4);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('mounts', 'readwrite');
        tx.objectStore('mounts').put(rec, rec.id);
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    await page.locator('button[aria-label="目录管理"]').click();
    const row = page.locator('.vv-mm-item', { hasText: '他机挂载' });
    await expect(row).toBeVisible();

    // ② 徽标不误导：已注册 rootIndex=7 但注册在他机 → 「注册于他机」
    await expect(row.getByText('注册于他机')).toBeVisible();
    // ① 打开禁用：offsite 行不渲染打开钮（rootIndex 是他机命名空间）
    await expect(row.getByRole('button', { name: '打开' })).toHaveCount(0);

    // ③ 删除逃生口：确认文案声明强制本地删除（跳过服务端注销），接受后本地删除
    const dialogText = page
      .waitForEvent('dialog')
      .then((d) => {
        const t = d.message();
        void d.accept();
        return t;
      });
    await row.getByRole('button', { name: '删除' }).click();
    expect(await dialogText).toContain('强制本地删除');
    await expect(page.locator('.vv-mm-item', { hasText: '他机挂载' })).toHaveCount(0);
    await expect(page.getByText('暂无前端配置挂载。')).toBeVisible();
  });
});
