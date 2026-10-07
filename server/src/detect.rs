//! 服务端检测：扩展名→语言（X-VV-Lang）与编码采样检测（X-VV-Encoding）。
//!
//! 与前端 packages/core/src/detect/encoding.ts 对齐：取值 'utf-8' | 'utf-16le' |
//! 'utf-16be' | 'gb18030'；BOM 优先，UTF-8 校验失败回退 gb18030。

use std::collections::HashMap;
use std::path::Path;

use once_cell::sync::Lazy;
use serde::Deserialize;

/// 编码检测采样窗口：只读文件头 8KB。
pub const ENCODING_HEAD_BYTES: usize = 8 * 1024;

/// 构建期内嵌语言清单（packages/highlight/assets/languages.json），零运行时 IO。
const LANGUAGES_JSON: &str = include_str!("../../packages/highlight/assets/languages.json");

#[derive(Deserialize)]
struct LangInfo {
    #[serde(default, rename = "fileTypes")]
    file_types: Vec<String>,
}

/// 扩展名（小写）→ 语言名 反查索引。fileTypes 中混有 glob 形态
/// （如 `containers.conf.d/*.conf`），只收纯扩展名条目；同名扩展先到先得。
static LANG_BY_EXT: Lazy<HashMap<&'static str, &'static str>> = Lazy::new(|| {
    let langs: HashMap<String, LangInfo> = serde_json::from_str(LANGUAGES_JSON)
        .expect("embedded languages.json must be valid");
    let mut map = HashMap::new();
    for (name, info) in langs {
        // 一次性初始化：leak 进 'static 表，量级为语言数（数百），可接受
        let name: &'static str = Box::leak(name.into_boxed_str());
        for ft in info.file_types {
            if ft.contains('/') || ft.contains('*') {
                continue;
            }
            let ext: &'static str = Box::leak(ft.to_lowercase().into_boxed_str());
            map.entry(ext).or_insert(name);
        }
    }
    map
});

pub fn lang_for_ext(ext: &str) -> Option<&'static str> {
    LANG_BY_EXT.get(ext.to_ascii_lowercase().as_str()).copied()
}

pub fn lang_for_path(path: &Path) -> Option<&'static str> {
    lang_for_ext(path.extension()?.to_str()?)
}

/// 编码检测：head 为文件头采样（≤8KB）。
pub fn detect_encoding(head: &[u8]) -> &'static str {
    if head.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return "utf-8";
    }
    if head.starts_with(&[0xFF, 0xFE]) {
        return "utf-16le";
    }
    if head.starts_with(&[0xFE, 0xFF]) {
        return "utf-16be";
    }
    if is_probable_utf8(head) {
        "utf-8"
    } else {
        "gb18030"
    }
}

/// UTF-8 采样校验。与前端 isStrictUtf8 的唯一差异在采样边界：
/// - head 恰为 8KB（采样截断）：末尾多字节序列不完整 → 视为合法前缀（容错）；
/// - head 小于 8KB（已读到文件尾）：不完整序列是文件本身损坏 → 严格判否，
///   与前端全量 isStrictUtf8 行为一致。
fn is_probable_utf8(head: &[u8]) -> bool {
    let sampled = head.len() >= ENCODING_HEAD_BYTES;
    match std::str::from_utf8(head) {
        Ok(_) => true,
        Err(e) => match e.error_len() {
            // 有界错误：真非法序列
            Some(_) => false,
            // 截断的不完整序列：仅采样边界才容错
            None => sampled,
        },
    }
}
