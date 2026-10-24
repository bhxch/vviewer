/**
 * serverCapsCache.ts — 会话级服务端能力缓存与上次连接记录（FE-1 自
 * openFlow.svelte.ts 抽出的纯存储层）：capabilities / computeLanguages /
 * diagrams 三组 sessionStorage 读写 + lastServer 记录读写。形态同
 * searchEngineCache.ts / serverHealthCache.ts 先例（sessionStorage 单键 +
 * 损坏/脏值容错）。写入方 serverConnect.svelte.ts 的 connectServer（连接
 * 成功时自 health 落缓存）；读取方 viewer.ts / highlightRouter /
 * highlightClient / globalSearch（经 openFlow façade 再导出，消费方导入面
 * 零改动）。
 */
import { SESSION_LAST_SERVER_KEY, type LastServerRecord } from '@vviewer/core';

/**
 * 会话内上次成功连接的服务器（sessionStorage，不做持久）。
 * 键名与值形状的权威定义在 @vviewer/core（SESSION_LAST_SERVER_KEY/LastServerRecord）：
 * render-media av.ts 的 HLS 直连 XHR 鉴权读同一键，形状改动须走 core 单点。
 */
export type LastServer = LastServerRecord;

const LAST_SERVER_KEY = SESSION_LAST_SERVER_KEY;

/** 连接时 health capabilities 的会话缓存键（M6 compute 路由的能力判定来源）。 */
const CAPABILITIES_KEY = 'vv:capabilities';

/** 连接时 health computeLanguages 的会话缓存键（BUG-06c：auto 策略远程路由的
 * 服务端语言集合依据；空/缺失 = 未知，路由保持既有先试远程行为）。 */
const COMPUTE_LANGUAGES_KEY = 'vv:compute-languages';

/** 连接时 health diagrams 子集的会话缓存键（spec 2026-10-23 §8.3：图表 server
 * 模式的能力协商依据；空/缺失 = 未知，server 模式按降级链回退）。 */
const DIAGRAM_CAPABILITIES_KEY = 'vv:diagram-capabilities';

/** 读取会话级服务端图表类型集合（spec §8.3；无记录/损坏/非数组返回 [] 表示未知）。 */
export function loadDiagramCapabilities(): string[] {
  try {
    const raw = sessionStorage.getItem(DIAGRAM_CAPABILITIES_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 读取会话级服务端高亮语言集合（BUG-06c；无记录/损坏/非数组返回 [] 表示未知）。 */
export function loadComputeLanguages(): string[] {
  try {
    const raw = sessionStorage.getItem(COMPUTE_LANGUAGES_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 读取会话能力缓存（无记录/损坏/非浏览器环境返回 []）。 */
export function loadCapabilities(): string[] {
  try {
    const raw = sessionStorage.getItem(CAPABILITIES_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

/** 写会话能力缓存（connectServer 连接成功时自 health 落盘；非数组丢弃不写）。 */
export function saveCapabilities(capabilities: unknown): void {
  try {
    if (Array.isArray(capabilities)) {
      sessionStorage.setItem(
        CAPABILITIES_KEY,
        JSON.stringify(capabilities.filter((c): c is string => typeof c === 'string'))
      );
    }
  } catch {
    // 存储不可用：连接本身不受影响，compute 路由回落本地
  }
}

/** 写会话高亮语言集合（compute 宣告则缓存；未宣告（旧服务端）清除旧缓存表示
 * 未知，路由保持既有先试远程行为）。 */
export function saveComputeLanguages(v: unknown): void {
  try {
    if (Array.isArray(v)) {
      sessionStorage.setItem(
        COMPUTE_LANGUAGES_KEY,
        JSON.stringify(v.filter((x): x is string => typeof x === 'string'))
      );
    } else {
      sessionStorage.removeItem(COMPUTE_LANGUAGES_KEY);
    }
  } catch {
    // 存储不可用：路由回落既有行为，连接不受影响
  }
}

/** 写会话图表子集（health 宣告则缓存；未宣告（旧服务端/非 compute 部署）清除
 * 旧缓存表示未知，server 模式按降级链回退 local/kroki）。 */
export function saveDiagramCapabilities(v: unknown): void {
  try {
    if (Array.isArray(v)) {
      sessionStorage.setItem(
        DIAGRAM_CAPABILITIES_KEY,
        JSON.stringify(v.filter((x): x is string => typeof x === 'string'))
      );
    } else {
      sessionStorage.removeItem(DIAGRAM_CAPABILITIES_KEY);
    }
  } catch {
    // 存储不可用：server 模式回落 local/kroki，连接不受影响
  }
}

/** 读取会话内上次成功连接的服务器（供连接表单预填；无记录/损坏返回 null）。 */
export function loadLastServer(): LastServer | null {
  try {
    const raw = sessionStorage.getItem(LAST_SERVER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastServer>;
    if (typeof v.baseUrl !== 'string' || v.baseUrl === '') return null;
    return { baseUrl: v.baseUrl, token: typeof v.token === 'string' && v.token !== '' ? v.token : null };
  } catch {
    return null;
  }
}

/** 记录会话内上次成功连接的服务器（connectServer 连接成功时；存储不可用静默）。 */
export function saveLastServer(baseUrl: string, token: string | null): void {
  try {
    sessionStorage.setItem(LAST_SERVER_KEY, JSON.stringify({ baseUrl, token } satisfies LastServer));
  } catch {
    // 存储不可用（隐私模式等）：连接本身不受影响
  }
}
