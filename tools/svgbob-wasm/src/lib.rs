//! svgbob wasm wrapper（spec 2026-10-23 §7）：与服务端 native 同 API to_svg，
//! 版本锁 "=0.7.6" 保证前后端渲染 byte 级一致（probe 已实证）。
use wasm_bindgen::prelude::wasm_bindgen;

#[wasm_bindgen]
pub fn render(source: String) -> String {
    svgbob::to_svg(&source)
}
