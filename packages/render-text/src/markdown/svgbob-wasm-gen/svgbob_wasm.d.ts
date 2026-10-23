// svgbob wasm 引擎类型声明（手写入库）：js/wasm 产物由 `pnpm gen:svgbob-wasm` 构建
// 期生成不入库（spec §7），本文件随源码入库保证 typecheck 与 import 类型解析不依赖
// 构建时序。init 无参调用即按 glue 内置的 import.meta.url 相对路径取同目录
// svgbob_wasm_bg.wasm；render 与服务端 native svgbob::to_svg 同源同版（"=0.7.6"）。
export default function init(): Promise<void>;
export function render(source: string): string;
