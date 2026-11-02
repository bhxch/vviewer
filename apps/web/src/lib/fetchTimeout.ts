/**
 * fetchTimeout.ts — 网络 fetch 超时统一上限（单源）。
 *
 * 消费点：openVsx.ts fetchResponse（Open VSX 元数据/manifest/vsix 三类 GET）与
 * fontsStore.ts addFontFromUrl（字体 URL 通道），均以 AbortSignal.timeout(FETCH_TIMEOUT_MS)
 * 传入 fetch。来由：评审 Minor——无超时 fetch 在网络 busy 时悬挂 UI，60s 上限令
 * AbortError 归入各通道既有的网络失败面文案（Open VSX networkPrefix / 字体 CORS 提示）。
 * 此前两文件各持同值常量互注对齐，现收敛为此单源：改上限只动此处。
 */
export const FETCH_TIMEOUT_MS = 60_000;
