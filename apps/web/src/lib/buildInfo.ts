// buildInfo.ts — 构建期注入的版本信息读取（settings center spec §2.1 关于分节）。
// vite define 注入 __APP_VERSION__（package.json version，vite.config.ts）；根
// vitest 无 define——typeof 门返回 null，UI 以「开发构建」降级显示（可测形态）。
declare const __APP_VERSION__: string | undefined;

/** 前端版本（package.json version 构建期注入）；不可得返回 null */
export function appVersion(): string | null {
  try {
    return typeof __APP_VERSION__ === 'string' && __APP_VERSION__ !== '' ? __APP_VERSION__ : null;
  } catch {
    return null;
  }
}
