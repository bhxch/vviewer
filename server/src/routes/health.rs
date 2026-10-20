//! `GET /api/health`：免鉴权能力发现。
//!
//! 业务体（Health 结构 + 宣告逻辑）随多端发布阶段二 Task 1 迁入
//! `vviewer-core::health`；本模块只留 axum 适配：State 提取 → core handler →
//! CoreResponse → axum Response。模块内单测经本适配层走与线上同一路径
//! （断言零变化——行为锁）。

use axum::extract::State;
use axum::response::Response;

use crate::adapt;
use crate::state::AppState;

/// axum 适配：`GET /api/health` 无请求参数，直接以业务核状态调用 core handler。
pub async fn health(State(state): State<AppState>) -> Response {
    adapt::to_axum(vviewer_core::health::handle(&state.core))
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
    async fn compute_advertises_diagram_subset() {
        let v = health_json(base_state().with_compute(true)).await;
        assert_eq!(v["diagrams"], serde_json::json!(["graphviz", "svgbob"]));
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
        assert!(v.get("rootPaths").is_none(), "单根部署应省略 rootPaths 字段: {v}");
    }

    #[tokio::test]
    async fn no_mounts_omits_fs_roots_and_mount_fields() {
        // 无挂载部署（历史形状）：fsRoots/mounts 字段整体省略（零变化契约）
        let v = health_json(base_state()).await;
        assert!(v.get("fsRoots").is_none(), "{v}");
        assert!(v.get("mounts").is_none(), "{v}");
    }

    #[tokio::test]
    async fn multi_root_advertises_roots_count() {
        let state = base_state().with_roots(vec![PathBuf::from("."), PathBuf::from(".")]);
        let v = health_json(state).await;
        assert_eq!(v["roots"], 2, "多根应宣告根数量");
    }

    #[tokio::test]
    async fn multi_root_no_token_advertises_root_paths() {
        let state = base_state().with_roots(vec![PathBuf::from("."), PathBuf::from("server")]);
        let v = health_json(state).await;
        let paths = v["rootPaths"].as_array().expect("多根免鉴权应宣告 rootPaths");
        assert_eq!(paths.len(), 2, "rootPaths 与 roots 数量一致: {v}");
        // canonicalize 已把 "." 解析为绝对路径（canonical 宣告语义）
        let first = paths[0].as_str().expect("str");
        assert!(first.starts_with('/'), "首根为 canonical 绝对路径: {first}");
        assert!(paths[1].as_str().expect("str").ends_with("server"));
    }

    #[tokio::test]
    async fn token_deployment_omits_root_paths() {
        // health 免鉴权可读：token 鉴权部署宣告路径 = 向未认证对端泄漏目录结构
        let state = AppState::new(PathBuf::from("."), None, Some("tok".to_string()), false, None)
            .with_roots(vec![PathBuf::from("."), PathBuf::from(".")]);
        let v = health_json(state).await;
        assert_eq!(v["roots"], 2, "数量宣告不受 token 影响");
        assert!(v.get("rootPaths").is_none(), "token 部署应省略 rootPaths: {v}");
    }
}
