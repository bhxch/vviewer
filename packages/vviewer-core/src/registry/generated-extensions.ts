// 由 tools/grammar-builder/gen-sources.mjs 生成；勿手改。
// 生成物不入库（构建源头化），消费端缺失时报错指向 pnpm gen:sources。
// 来源：packages/vviewer-highlight/assets/languages.json 的 fileTypes 全集。
//
// —— **提交面占位**（构建源头化 spec F 的落地形，评审 important ⑫）——
// 本文件**在库**仅为「模块图可解析」：core barrel 静态 re-export 本模块，生成物缺失
// 时整个 barrel 的导入方（web/vscode 构建、vitest、tsc）全部因「模块解析失败」而红，
// 干净克隆无任何可用起点（且无修复指引）。
//
// 占位语义：**空集**——真实清单由 `pnpm gen:sources`（构建源头化，helix pin 派生；
// 需联网）就地覆写本文件生成。空集期间的行为面：
//   · 扩展名兜底面为空（installFallbackExtensions 不补位）——未知扩展名回落通用渲染器；
//   · 依赖该清单的断言（apps/vscode 扩展名清单域）**跳过**而非红（见 extensions.test.ts
//     的「生成物在位」守卫）。
// 因此：**生成内容不得入库**（入库即与 pin 漂移，且绕过构建源头化）——本文件在库内容
// 恒为下方占位；apps/vscode/test/extensions.test.ts 的「生成物不入库」守卫用例据此
// 断言（HEAD 版本须含占位标记）。
export const GENERATED_EXTENSIONS: readonly string[] = [];
