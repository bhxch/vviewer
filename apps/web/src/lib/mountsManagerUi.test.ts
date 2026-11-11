// mountsManagerUi.test.ts — 目录管理页组件骨架与接线（目录挂载 spec §5 阶段四）
// 源码契约。根 vitest 无 svelte 插件，MountsManager.svelte 不可挂载——按既有
// 「源码契约断言」先例（settingsCenter.test.ts / appShellZenEsc.test.ts /
// directMountFlow.test.ts 同形态）锁定骨架、三组、警示双处、测试连接回显与
// AppShell/标签栏动作簇接线；纯逻辑在 mountsManager.test.ts 直测，行为由 e2e
// b-mounts-manager 兜底（plan Task 3 深矩阵扩展）。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// i18n 目录（Task 4 域 A / Task 8 域 E 抽取）：融合菜单条目与面板本体文案均迁入
// 目录，锚改指 t() key + zh 值逐字节等价双锁（S5 口径，断言力不弱化）
import { messages as zhTabs } from './i18n/catalogs/zh-CN/tabs';
import { messages as zhMounts } from './i18n/catalogs/zh-CN/mounts';

// vitest 会转译 import.meta.url（metaStore.test 同款处理）：双 cwd 兼容根/apps/web
function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

describe('MountsManager 骨架（全屏 overlay，SettingsCenter 同形态）', () => {
  const src = readSrc('src/lib/MountsManager.svelte');

  it('OVERLAY_SELECTOR 入册类名 vv-mounts-manager：dialog 角色 + 容器/窗兜底双 Esc 通道 + 关闭焦点还原', () => {
    expect(src).toContain('class="vv-mounts-manager"');
    expect(src).toMatch(/role="dialog"/);
    // i18n Task 8：aria-label 迁目录——新形态 + zh 值逐字节双锁
    expect(src).toMatch(/aria-label=\{t\('mounts\.title'\)\}/);
    expect(zhMounts['mounts.title']).toBe('目录管理');
    // 容器 keydown（合成 Esc 派发目标即根元素）+ window 兜底（target 在面板外），
    // 与 SettingsCenter/GlobalSearchPanel 同仓库 dialog 模式
    expect(src).toMatch(/function onRootKeydown[\s\S]*?e\.key === 'Escape'/);
    expect(src).toMatch(/!rootEl\.contains\(e\.target\)/);
    expect(src).toMatch(/document\.activeElement/); // 关闭前记录焦点，卸载后还原
    // 逐层退出：表单在场时 Esc 先关表单（设置中心导入弹层同语义）
    expect(src).toMatch(/onRootKeydown[\s\S]{0,400}formOpen/);
  });

  it('三组 sections：服务端根与挂载 / 前端配置挂载 / 本机授权来源（装配纯函数接线）', () => {
    // i18n Task 8：组标题迁目录——键形态 + zh 值逐字节双锁
    expect(src).toContain("t('mounts.group.server')");
    expect(src).toContain("t('mounts.group.configured')");
    expect(src).toContain("t('mounts.group.local')");
    expect(zhMounts['mounts.group.server']).toBe('服务端根与挂载');
    expect(zhMounts['mounts.group.configured']).toBe('前端配置挂载');
    expect(zhMounts['mounts.group.local']).toBe('本机授权来源');
    expect(src).toMatch(/assembleServerMountRows/);
    expect(src).toMatch(/assembleMountRows/);
    expect(src).toMatch(/assembleLocalRows/);
  });

  it('凭据警示双处固定（spec §6：新增表单 + 列表详情；credentialWarning() 单一出处渲染两次）', () => {
    // Task 8：常量改函数（Task 7 saveDeniedNotice 先例——装载时刻取值钉死 locale）
    expect(src.match(/\{credentialWarning\(\)\}/g)?.length).toBeGreaterThanOrEqual(2);
    expect(zhMounts['mounts.warn.credential']).toContain('明文');
    expect(zhMounts['mounts.warn.credential']).toContain('同源脚本');
    expect(zhMounts['mounts.warn.credential']).toContain('本机用户');
  });

  it('WebDAV CORS 预检提示随 kind 切换（webdavCorsHint()）', () => {
    expect(src).toContain('{webdavCorsHint()}');
    expect(zhMounts['mounts.warn.webdavCors']).toContain('CORS');
  });

  it('测试连接状态机：探测中/成功回显条目数+延迟/失败回显错误（formatProbeResult 单一渲染口）', () => {
    expect(src).toMatch(/probing/);
    expect(src).toContain('formatProbeResult');
    expect(src).toMatch(/probeDraft/);
    expect(src).toMatch(/probeRecord/);
  });

  it('L3：runProbe 先过表单校验（必填/L1 拦截面不被「测试连接」旁路）', () => {
    expect(src).toMatch(/async function runProbe\(\): Promise<void> \{[\s\S]{0,300}mountFormIssues\(draft\)/);
  });

  it('M1 跨连接作用域：装配传当前连接 base、offsite 徽标「注册于他机」、打开守卫、强制本地删除逃生口、编辑注册阻断', () => {
    expect(src).toMatch(/assembleMountRows\(records, last\?\.baseUrl \?\? null\)/);
    expect(src).toContain('proxyOffsiteOf');
    // i18n Task 8：offsite 徽标/逃生口后缀/阻断文案迁目录——键形态 + zh 值双锁
    expect(src).toContain("t('mounts.state.offsite')");
    expect(zhMounts['mounts.state.offsite']).toBe('注册于他机');
    // 打开守卫（defense in depth——offsite 行模板本就不渲染打开钮）
    expect(src).toMatch(/openProxyRow[\s\S]{0,400}proxyOffsiteOf\(rec, last\.baseUrl\)/);
    // 删除逃生口：offsite proxy 跳过服务端注销（强制本地删除，确认文案声明）——
    // 文案在目录 offsiteNote，源码锚改指逃生口后缀键
    expect(src).toMatch(/t\('mounts\.delete\.forceLocalSuffix'\)/);
    expect(zhMounts['mounts.delete.forceLocalSuffix']).toBe('（强制本地删除）');
    expect(zhMounts['mounts.delete.offsiteNote']).toContain('强制本地删除');
    expect(src).toMatch(/rec\.kind === 'proxy' && !offsite && typeof rec\.registeredRootIndex === 'number'/);
    // 编辑注册阻断：offsite old → formError（当前 token 打他机只会 401）
    expect(src).toMatch(/proxyOffsiteOf\(old, last\?\.baseUrl \?\? null\)/);
    expect(src).toMatch(/t\('mounts\.edit\.offsiteBlock'/);
    expect(zhMounts['mounts.edit.offsiteBlock']).toContain('与当前连接的服务器不一致');
    // D8（Task 8）：data-mode 判别改 record.kind 稳定标识符（显示串比较废除）
    expect(src).toMatch(/data-mode=\{row\.record\.kind\}/);
  });

  it('表单 kind→字段集切换 + 必填校验（mountFormIssues 统一入口）', () => {
    expect(src).toMatch(/mountFormIssues/);
    expect(src).toMatch(/draft\.backend === 's3'/);
  });

  it('proxy 保存即时注册（registerProxyMount 失败抛错不落库）；删除先注销服务端（unregisterProxyMount）', () => {
    expect(src).toMatch(/registerProxyMount/);
    expect(src).toMatch(/unregisterProxyMount/);
    expect(src).toMatch(/saveMount|saveDirectMount/);
  });

  it('组①/组②「打开」openRemoteSource 不覆写 label（终审 I-2：同 rootIndex 与 RemoteSourceModal 单 storeId）；组②直连「打开」openDirectMount', () => {
    expect(src).toMatch(/openRemoteSource\(last\.baseUrl, last\.token, row\.rootIndex, ''\)/);
    expect(src).toMatch(/openRemoteSource\(last\.baseUrl, last\.token, rec\.registeredRootIndex, ''\)/);
    expect(src).not.toMatch(/\{ label: row\.title \}/);
    // 不覆写 = openRemoteSource 调用不带 opts 对象（i18n Task 8 勘正：原字面负锚
    // /label: rec\.label/ 会误报删除确认 t() 插值参数对象 { label: rec.label }——
    // 该处是目录占位符消费非覆写口，负锚收窄为「openRemoteSource 无 opts」口径）
    expect(src).not.toMatch(/openRemoteSource\([^)]*, \{/);
    expect(src).toContain('openDirectMount(');
  });

  it('I-3 凭据轮换生效：direct 保存成功即释放同 id 存活实例（releaseDirectMountStore——下次打开新建即新凭据）', () => {
    expect(src).toMatch(/saveDirectMount\(rec\);[\s\S]{0,200}releaseDirectMountStore\(rec\.id\)/);
  });

  it('I-4 proxy 探测语义勘误：表单 proxy 模式示「浏览器侧探测」文案（代理链路以服务器出口为准，CORS 拦截不误签）', () => {
    expect(src).toMatch(/draft\.mode === 'proxy'[\s\S]{0,400}t\('mounts\.form\.proxyProbeHint'\)/);
    expect(zhMounts['mounts.form.proxyProbeHint']).toContain('浏览器侧探测');
    expect(zhMounts['mounts.form.proxyProbeHint']).toContain('服务器出口为准');
  });

  it('组③句柄动作：打开 openSavedDirectory / 清除 saveDirHandle(null)+confirm（快照恢复失效提示）', () => {
    expect(src).toMatch(/openSavedDirectory/);
    expect(src).toMatch(/saveDirHandle\(null\)/);
    const flow = readSrc('src/lib/openFlow.svelte.ts');
    expect(flow).toMatch(/export async function openSavedDirectory/);
  });
});

describe('AppShell/标签栏动作簇接线（Ctrl+Alt+M + 📁 双入口 + overlay 判定入册）', () => {
  const shell = readSrc('src/lib/AppShell.svelte');

  it('OVERLAY_SELECTOR 含 .vv-mounts-manager（zen Esc 优先级判定依赖——设置中心 .vv-settings-center 先例）', () => {
    const sel = shell.match(/const OVERLAY_SELECTOR = \[([\s\S]*?)\]\.join/);
    expect(sel).not.toBeNull();
    expect(sel![1]).toContain('.vv-mounts-manager');
  });

  it('MountsManager 由 AppShell 挂载（{#if} 条件挂载，在 DOM 即开）；requestClose 统一关闭', () => {
    expect(shell).toMatch(/import MountsManager from '\.\/MountsManager\.svelte'/);
    expect(shell).toMatch(
      /\{#if mountsOpen\}[\s\S]*?<MountsManager bind:this=\{mountsEl\} onclose=\{\(\) => \(mountsOpen = false\)\} \/>[\s\S]*?\{\/if\}/
    );
  });

  it('Ctrl+Alt+M 切换目录管理（组合键分支置于 inField 判定之前——Ctrl+Alt+Z 放行先例；全仓 KeyM 无既有占用）', () => {
    expect(shell).toMatch(
      /if \(\(e\.ctrlKey \|\| e\.metaKey\) && e\.altKey && !e\.shiftKey && e\.code === 'KeyM'\) \{\s*e\.preventDefault\(\);\s*toggleMountsManager\(\);/
    );
  });

  it('融合菜单目录管理条目（aria-label=目录管理，title 提示 Ctrl+Alt+M；标签栏收敛 Task 1 后宿主为 TabBarMenu），回调经 onmounts 注入', () => {
    const menu = readSrc('src/lib/TabBarMenu.svelte');
    expect(menu).toMatch(/onmounts/);
    expect(menu).toMatch(/aria-label=\{t\('tabs\.menu\.mounts'\)\}/);
    expect(menu).toMatch(/title=\{t\('tabs\.menu\.mountsTitle'\)\}/);
    expect(zhTabs['tabs.menu.mounts']).toBe('目录管理');
    expect(zhTabs['tabs.menu.mountsTitle']).toMatch(/Ctrl\+Alt\+M/);
    expect(shell).toMatch(/onmounts=\{\(\) => toggleMountsManager\(\)\}/);
  });
});
