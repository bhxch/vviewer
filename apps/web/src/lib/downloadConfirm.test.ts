// downloadConfirm.test.ts — 远端下载确认门（计划 2 Task 6，spec §6.4）。
// 根 vitest 无 svelte 插件（downloadProgressUi.test.ts 同款约束）：决策纯函数
// shouldConfirm/mbToBytes 在 downloadConfirm.ts 直测（四边界锚 + 单位锚）；确认卡
// 组件与 ViewerPane 接线按既有「源码契约断言」先例锁定字段、泵前置拦截位、确认/
// 取消流转锚；运行时行为由 e2e 兜底（Task 7 验收锚面）。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mbToBytes, shouldConfirm } from './downloadConfirm';

// vitest 会转译 import.meta.url（downloadProgressUi.test.ts 同款处理）：双 cwd 兼容根/apps/web
function readSrc(relFromWeb: string): string {
  return readFileSync(
    [`apps/web/${relFromWeb}`, relFromWeb].map((p) => resolve(p)).find((p) => existsSync(p))!,
    'utf8'
  );
}

// ---------- 纯函数：确认门决策（downloadConfirm.ts 直测，spec §6.4 四边界锚） ----------

describe('shouldConfirm（确认门决策单源：total > 阈值先确认后下载）', () => {
  it('边界一：size null → false（size 未知不适用确认门，直接不定态下载）', () => {
    expect(shouldConfirm(null, mbToBytes(512))).toBe(false);
    expect(shouldConfirm(null, 0)).toBe(false);
    expect(shouldConfirm(null, 1)).toBe(false);
  });

  it('边界二：size ≤ 阈值 → false（等界不确认——「total > 阈值」严比较）', () => {
    expect(shouldConfirm(mbToBytes(512), mbToBytes(512))).toBe(false); // 等界
    expect(shouldConfirm(mbToBytes(511), mbToBytes(512))).toBe(false); // 界下
    expect(shouldConfirm(0, mbToBytes(512))).toBe(false); // 零字节文件
  });

  it('边界三：size > 阈值 → true（默认 512MB 场景）', () => {
    expect(shouldConfirm(mbToBytes(513), mbToBytes(512))).toBe(true);
    expect(shouldConfirm(mbToBytes(512) + 1, mbToBytes(512))).toBe(true); // 超界一字节
  });

  it('边界四（单位锚）：阈值 1（字节）时 1MB → true——阈值以字节比较，MB 值未换算即红', () => {
    expect(shouldConfirm(mbToBytes(1), 1)).toBe(true);
  });
});

describe('mbToBytes（settings MB 字段 → 字节换算单源）', () => {
  it('MB × 1024 × 1024：默认 512MB 与下界 1MB 换算正确', () => {
    expect(mbToBytes(1)).toBe(1024 * 1024);
    expect(mbToBytes(512)).toBe(512 * 1024 * 1024);
  });
});

// ---------- 组件契约：DownloadConfirmCard.svelte（字段/决策回调） ----------

describe('DownloadConfirmCard 骨架（spec §6.4 确认卡字段全锚）', () => {
  const src = readSrc('src/lib/DownloadConfirmCard.svelte');

  it('props 五件套：name/sizeBytes/rendererLabel + onconfirm/oncancel（决策回调上抛，组件无本地状态）', () => {
    expect(src).toMatch(/name: string/);
    expect(src).toMatch(/sizeBytes: number/);
    expect(src).toMatch(/rendererLabel: string/);
    expect(src).toMatch(/onconfirm: \(\) => void/);
    expect(src).toMatch(/oncancel: \(\) => void/);
  });

  it('字段全锚：标题/文件名/大小（formatBytes 单源）/目标渲染器/内存影响文案/开始下载/取消钮', () => {
    expect(src).toMatch(/vv-dl-confirm-name/);
    expect(src).toMatch(/\{formatBytes\(sizeBytes\)\}/);
    expect(src).toMatch(/vv-dl-confirm-renderer/);
    expect(src).toMatch(/vv-dl-confirm-impact/);
    expect(src).toContain('>开始下载</button>');
    expect(src).toContain('>取消</button>');
    expect(src).toMatch(/onclick=\{onconfirm\}/);
    expect(src).toMatch(/onclick=\{oncancel\}/);
  });

  it('alertdialog 语义（读屏可达，StorageSection 确认面板先例）：role="alertdialog" + aria-label', () => {
    expect(src).toMatch(/role="alertdialog"/);
    expect(src).toMatch(/aria-label="确认下载"/);
  });

  it('「下载并另存为」次动作（计划 2 Task 7 双形态二）：onsaveas 缺省不渲染（无 FS Access 降级普通下载路径）', () => {
    expect(src).toMatch(/onsaveas\?: \(\) => void/);
    expect(src).toMatch(/\{#if onsaveas !== undefined\}/);
    expect(src).toContain('>下载并另存为</button>');
    expect(src).toMatch(/class="vv-dl-confirm-saveas"/);
  });
});

// ---------- 接线契约：ViewerPane（门公式/泵前置拦截位/确认取消流转/生命周期锚） ----------

describe('ViewerPane 确认门接线（计划 2 Task 6）', () => {
  const src = readSrc('src/lib/ViewerPane.svelte');

  it('门公式：远端来源（isRemoteDownload）× shouldConfirm（阈值 = loadSettings 现值经 mbToBytes 换算）× 未确认键——每轮现算不持副本', () => {
    expect(src).toMatch(/import \{[^}]*shouldConfirm[^}]*\} from '\.\/downloadConfirm'/);
    expect(src).toMatch(/import \{[^}]*mbToBytes[^}]*\} from '\.\/downloadConfirm'/);
    expect(src).toMatch(/isRemoteDownload\(current\.source\.storeId\)/);
    expect(src).toMatch(
      /shouldConfirm\(dlSize, mbToBytes\(loadSettings\(\)\.storage\.remoteDownloadConfirmMb\)\)/
    );
    expect(src).toMatch(/dlApprovedKey !== dlKey/);
  });

  it('size 门数据源：FileSource.size（typeof 守卫，未知归 null 不适用）+ 确认作用域键 storeId/path/size 三元组', () => {
    expect(src).toMatch(/typeof current\.source\.size === 'number'/);
    expect(src).toMatch(/dlGateKeyOf\(current\.source\.storeId, current\.source\.path, dlSize\)/);
  });

  it('泵前置拦截：确认卡装配早于 dispatcher.dispatch（门不过不进渲染/泵），目标渲染器 = override 有效显 label/其余中性文案（残余 A3）', () => {
    const gateIdx = src.indexOf('dlConfirm = {');
    const dispatchIdx = src.indexOf('dispatcher.dispatch(');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(dispatchIdx);
    expect(src).toMatch(/registry\.byId\(current\.overrideRenderer\)\?\.label/);
    // 残余 A3：探测链偏差面不显示估计渲染器名——扩展名路由命中给中性限定文案，
    // extless/未命中给「自动识别」；不再回落 byExtension(...)?.label 估计名
    expect(src).toMatch(
      /registry\.byExtension\(extractExtension\(current\.source\.name\)\) !== undefined\s*\?\s*'自动识别（按扩展名）'\s*:\s*'自动识别'/
    );
    expect(src).not.toMatch(/registry\.byExtension\(extractExtension\(current\.source\.name\)\)\?\.label/);
  });

  it('确认/取消流转锚：确认登记作用域键后重跑进 dispatch（泵才启动）；取消静默卸卡不写键不 dispatch', () => {
    expect(src).toMatch(/function confirmDownload\(\): void \{[\s\S]{0,200}dlApprovedKey = dlConfirm\.key/);
    expect(src).toMatch(/function cancelConfirm\(\): void \{[\s\S]{0,100}dlConfirm = null/);
    // 取消不触发 effect 重跑（dlApprovedKey 不变）：取消后不得再现同键确认卡
    expect(src).toMatch(/function cancelConfirm\(\): void \{[^}]*\}/);
  });

  it('孤儿清偿（评审 I-1）：守卫分支（!host/占位/目录 tab）return 前清 dlConfirm——确认等待期关 tab/切目录 tab 不留孤儿卡', () => {
    expect(src).toMatch(
      /if \(!host \|\| !tab \|\| tab\.source\.path === ''\) \{[\s\S]{0,80}dlConfirm = null;[\s\S]{0,40}return;/
    );
  });

  it('模板挂载：进度卡同域 pane 级浮层（host 外侧）渲染确认卡，决策回调双接线', () => {
    expect(src).toMatch(/\{#if dlConfirm\}[\s\S]{0,400}<DownloadConfirmCard/);
    expect(src).toMatch(/onconfirm=\{confirmDownload\}/);
    expect(src).toMatch(/oncancel=\{cancelConfirm\}/);
  });

  it('门不写进度卡状态：确认等待期不装配 tracker/地址行（进度卡接力在确认后的 dispatch 轮）', () => {
    // 门分支 return 早于渲染 effect 内 tracker 装配（dlAddress 写入）——确认等待期
    // 加载态区只有确认卡。检索锚取渲染 effect 区段（dlConfirm = { 装配点之后）：
    // saveAsCompleted（评审 I-3，组件函数域）同款 dlAddressText 写点在文件更前，
    // 全文首查会误配（I-3 评审波注）
    const gateIdx = src.indexOf('dlConfirm = {');
    const addrIdx = src.indexOf('dlAddress = dlAddressText(', gateIdx);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(addrIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(addrIdx);
  });
});
