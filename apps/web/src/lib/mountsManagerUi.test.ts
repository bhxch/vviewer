// mountsManagerUi.test.ts — 目录管理页组件骨架与接线（目录挂载 spec §5 阶段四）
// 源码契约。根 vitest 无 svelte 插件，MountsManager.svelte 不可挂载——按既有
// 「源码契约断言」先例（settingsCenter.test.ts / appShellZenEsc.test.ts /
// directMountFlow.test.ts 同形态）锁定骨架、三组、警示双处、测试连接回显与
// AppShell/TopBar 接线；纯逻辑在 mountsManager.test.ts 直测，行为由 e2e
// b-mounts-manager 兜底（plan Task 3 深矩阵扩展）。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
    expect(src).toMatch(/aria-label="目录管理"/);
    // 容器 keydown（合成 Esc 派发目标即根元素）+ window 兜底（target 在面板外），
    // 与 SettingsCenter/GlobalSearchPanel 同仓库 dialog 模式
    expect(src).toMatch(/function onRootKeydown[\s\S]*?e\.key === 'Escape'/);
    expect(src).toMatch(/!rootEl\.contains\(e\.target\)/);
    expect(src).toMatch(/document\.activeElement/); // 关闭前记录焦点，卸载后还原
    // 逐层退出：表单在场时 Esc 先关表单（设置中心导入弹层同语义）
    expect(src).toMatch(/onRootKeydown[\s\S]{0,400}formOpen/);
  });

  it('三组 sections：服务端根与挂载 / 前端配置挂载 / 本机授权来源（装配纯函数接线）', () => {
    expect(src).toContain('服务端根与挂载');
    expect(src).toContain('前端配置挂载');
    expect(src).toContain('本机授权来源');
    expect(src).toMatch(/assembleServerMountRows/);
    expect(src).toMatch(/assembleMountRows/);
    expect(src).toMatch(/assembleLocalRows/);
  });

  it('凭据警示双处固定（spec §6：新增表单 + 列表详情；CREDENTIAL_WARNING 单一出处渲染两次）', () => {
    expect(src.match(/\{CREDENTIAL_WARNING\}/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('WebDAV CORS 预检提示随 kind 切换（WEBDAV_CORS_HINT）', () => {
    expect(src).toContain('{WEBDAV_CORS_HINT}');
  });

  it('测试连接状态机：探测中/成功回显条目数+延迟/失败回显错误（formatProbeResult 单一渲染口）', () => {
    expect(src).toMatch(/probing/);
    expect(src).toContain('formatProbeResult');
    expect(src).toMatch(/probeDraft/);
    expect(src).toMatch(/probeRecord/);
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

  it('组①「在树中打开」openRemoteSource 携 label 覆写；组②直连「打开」openDirectMount', () => {
    expect(src).toMatch(/openRemoteSource\([\s\S]{0,200}\{ label: row\.title \}/);
    expect(src).toContain('openDirectMount(');
  });

  it('组③句柄动作：打开 openSavedDirectory / 清除 saveDirHandle(null)+confirm（快照恢复失效提示）', () => {
    expect(src).toMatch(/openSavedDirectory/);
    expect(src).toMatch(/saveDirHandle\(null\)/);
    const flow = readSrc('src/lib/openFlow.svelte.ts');
    expect(flow).toMatch(/export async function openSavedDirectory/);
  });
});

describe('AppShell/TopBar 接线（Ctrl+Alt+M + 📁 双入口 + overlay 判定入册）', () => {
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

  it('TopBar 目录管理按钮（aria-label=目录管理，title 提示 Ctrl+Alt+M），回调经 onmounts 注入', () => {
    const topbar = readSrc('src/lib/TopBar.svelte');
    expect(topbar).toMatch(/onmounts/);
    expect(topbar).toMatch(/aria-label="目录管理"/);
    expect(topbar).toMatch(/Ctrl\+Alt\+M/);
    expect(shell).toMatch(/onmounts=\{\(\) => toggleMountsManager\(\)\}/);
  });
});
