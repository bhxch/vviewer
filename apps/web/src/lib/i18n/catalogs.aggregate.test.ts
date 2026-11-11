// catalogs.aggregate.test.ts — i18n 目录聚合机检（D5/D15 硬门槛；aelrova
// i18n-aggregate.test.ts 移植）。四道断言：
// ① zh 各域文件 key 数之和 == 聚合总数（spread 静默覆盖同名 key 即红）；
// ② 全部 key 首段 == 其域段（satisfies 编译期锁 + 本测试运行时双锁）；
// ③ en 键集 == zh 键集（缺键/孤儿键双向断言，失败输出差集清单——回落机制是
//    安全网不是欠账通道，D15 全量覆盖收口）；
// ④ zh/en 逐 key 占位符集合相等（插值占位符跨语言漂移即红）。
// ⑤（aelrova 的 registerAll 后查表含全量）不适用：单 app 直读目录（D4/D5 裁决），
//    无 aelrova registry 运行时注入层（无 registerMessages/getRegisteredMessages），
//    core.translate 直接消费聚合目录——① 已锁 spread 全量性，注入断言无对象。
import { describe, expect, it } from 'vitest';
import { MESSAGE_PACKS as EN_PACKS, messages as enMessages } from './catalogs/en';
import { MESSAGE_PACKS, messages as zhMessages } from './catalogs/zh-CN';

/**
 * 抽取值中全部 {占位符} 名（排序后拼接，集合比较免序敏感）。
 * 前置守卫（修复轮 M-5）：③（键集相等）不变式破时④独立可诊断——缺键侧返回哨兵
 * 串（不与任何真实占位符集合相等），④失败 diff 点名「缺键」而非裸 TypeError
 * （undefined.matchAll）。类型入参收 string：交付态目录 satisfies 全 string，
 * undefined 仅在③所锁不变式被破坏时运行时可达。
 */
function placeholdersOf(v: string | undefined): string {
  if (v === undefined) return '⟨缺键：③键集相等已破⟩';
  return [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
}

describe('i18n 目录聚合机检（D5/D15）', () => {
  it('① zh 各域文件 key 数之和 == 聚合总数（spread 静默覆盖即红）', () => {
    const packTotal = Object.values(MESSAGE_PACKS).reduce((sum, pack) => sum + Object.keys(pack).length, 0);
    expect(Object.keys(zhMessages).length).toBe(packTotal);
  });

  it('② 全部 key 首段 == 其域段（三段命名首段纪律）', () => {
    for (const [domain, pack] of Object.entries(MESSAGE_PACKS)) {
      for (const key of Object.keys(pack)) {
        expect(key.startsWith(`${domain}.`), `key ${key} 应属域 ${domain}`).toBe(true);
      }
    }
  });

  it('③ en 键集 == zh 键集（缺键/孤儿键断言，失败输出差集清单）', () => {
    const zhKeys = new Set(Object.keys(zhMessages));
    const enKeys = new Set(Object.keys(enMessages));
    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
    const orphanInEn = [...enKeys].filter((k) => !zhKeys.has(k));
    expect(missingInEn, `en 缺键（回落 zh 兜底但欠账）：${missingInEn.join(', ')}`).toEqual([]);
    expect(orphanInEn, `en 孤儿键（zh 无对应）：${orphanInEn.join(', ')}`).toEqual([]);
    // en 包自身同构对账：MESSAGE_PACKS 计数 == en 聚合总数（en 侧 spread 覆盖同锁）
    const enPackTotal = Object.values(EN_PACKS).reduce((sum, pack) => sum + Object.keys(pack).length, 0);
    expect(Object.keys(enMessages).length).toBe(enPackTotal);
  });

  it('④ zh/en 逐 key 占位符集合相等（插值占位符跨语言漂移即红）', () => {
    for (const key of Object.keys(zhMessages)) {
      const zh = zhMessages[key as keyof typeof zhMessages];
      const en = enMessages[key as keyof typeof enMessages];
      expect(placeholdersOf(en), `占位符集合不一致 @ ${key}`).toBe(placeholdersOf(zh));
    }
  });
});
