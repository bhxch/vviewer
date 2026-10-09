//! `GET /api/health`：免鉴权能力发现。

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
pub struct Health {
    pub name: &'static str,
    pub version: &'static str,
    pub capabilities: Vec<&'static str>,
    /// `--compute` 时宣告服务端高亮支持的 canonical 语言清单：客户端 auto 策略
    /// 据此路由（清单外语言直接本地，不再白发 400 再回退）；缺省（非 compute）
    /// 字段整体省略。客户端清单过期/缺失时按未知处理（保持既有先试远程行为）。
    #[serde(rename = "computeLanguages", skip_serializing_if = "Option::is_none")]
    pub compute_languages: Option<Vec<&'static str>>,
}

/// 能力宣告：`file-server` 恒有；`--compute` 时追加 `compute`
/// （前端连接时缓存，compute 路由据此判定是否走远程）。
pub async fn health(State(state): State<AppState>) -> Json<Health> {
    let mut capabilities = vec!["file-server"];
    let mut compute_languages = None;
    if state.compute {
        capabilities.push("compute");
        compute_languages = Some(crate::compute::queries::supported_languages());
    }
    Json(Health {
        name: "vviewer",
        version: env!("CARGO_PKG_VERSION"),
        capabilities,
        compute_languages,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::response::IntoResponse;
    use std::path::PathBuf;

    async fn health_json(compute: bool) -> serde_json::Value {
        let state = AppState::new(PathBuf::from("."), None, None, false, None).with_compute(compute);
        let res = health(State(state)).await;
        let bytes = to_bytes(res.into_response().into_body(), 64 * 1024)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("json")
    }

    #[tokio::test]
    async fn no_compute_omits_language_list() {
        let v = health_json(false).await;
        assert_eq!(v["capabilities"], serde_json::json!(["file-server"]));
        assert!(v.get("computeLanguages").is_none());
    }

    #[tokio::test]
    async fn compute_advertises_sorted_full_registry() {
        let v = health_json(true).await;
        assert!(v["capabilities"].as_array().unwrap().contains(&serde_json::json!("compute")));
        let langs = v["computeLanguages"].as_array().expect("computeLanguages 数组");
        let names: Vec<&str> = langs.iter().map(|x| x.as_str().expect("str")).collect();
        assert_eq!(names, {
            let mut sorted = names.clone();
            sorted.sort_unstable();
            sorted
        });
        assert!(names.contains(&"rust") && names.contains(&"python"));
        // 阶段 1 收口：java 已进服务端集合（BUG-06c 时代的缺席断言翻转）
        assert!(names.contains(&"java"));
    }
}
