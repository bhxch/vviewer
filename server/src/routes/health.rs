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
    /// 跨文件搜索引擎宣告（A 项）：rg/grep 择一；双缺时字段整体省略。
    /// 与 /api/search 同一选择链，测试经 rg_path/grep_path 注入覆盖。
    #[serde(rename = "searchEngine", skip_serializing_if = "Option::is_none")]
    pub search_engine: Option<&'static str>,
    /// 多根宣告（workspace 阶段 1）：数据根数量；=1（单根部署，历史形状）时
    /// 字段整体省略。客户端据命中帧的 root 索引定位所属根。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roots: Option<usize>,
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
    let search_engine =
        crate::routes::search::resolve_engine(&state).ok().map(|(engine, _)| engine.name());
    let root_count = state.roots.len();
    Json(Health {
        name: "vviewer",
        version: env!("CARGO_PKG_VERSION"),
        capabilities,
        compute_languages,
        search_engine,
        roots: (root_count > 1).then_some(root_count),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::response::IntoResponse;
    use std::path::PathBuf;

    async fn health_json(state: AppState) -> serde_json::Value {
        let res = health(State(state)).await;
        let bytes = to_bytes(res.into_response().into_body(), 64 * 1024)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("json")
    }

    fn base_state() -> AppState {
        AppState::new(PathBuf::from("."), None, None, false, None)
    }

    #[tokio::test]
    async fn no_compute_omits_language_list() {
        let v = health_json(base_state()).await;
        assert_eq!(v["capabilities"], serde_json::json!(["file-server"]));
        assert!(v.get("computeLanguages").is_none());
    }

    #[tokio::test]
    async fn compute_advertises_sorted_full_registry() {
        let v = health_json(base_state().with_compute(true)).await;
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

    #[tokio::test]
    async fn search_engine_omitted_when_both_engines_missing() {
        let state = base_state()
            .with_rg_path(Some("/nonexistent/rg-for-test".to_string()))
            .with_grep_path(Some("/nonexistent/grep-for-test".to_string()));
        let v = health_json(state).await;
        assert!(v.get("searchEngine").is_none());
    }

    #[tokio::test]
    async fn search_engine_announces_forced_grep() {
        let grep = crate::routes::search::probe("grep").expect("CI 需要系统 grep");
        let state = base_state()
            .with_rg_path(Some("/nonexistent/rg-for-test".to_string()))
            .with_grep_path(Some(grep));
        let v = health_json(state).await;
        assert_eq!(v["searchEngine"], "grep");
    }

    #[tokio::test]
    async fn single_root_omits_roots_field() {
        let v = health_json(base_state()).await;
        assert!(v.get("roots").is_none(), "单根部署应省略 roots 字段: {v}");
    }

    #[tokio::test]
    async fn multi_root_advertises_roots_count() {
        let state = base_state().with_roots(vec![PathBuf::from("."), PathBuf::from(".")]);
        let v = health_json(state).await;
        assert_eq!(v["roots"], 2, "多根应宣告根数量");
    }
}
