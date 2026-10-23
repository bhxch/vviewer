// 裁剪形态（worker，--no-default-features）断言面为死路径：compute 域随
// native feature 编译裁剪（多端发布阶段二 Task 3 门控语义），本文件整体
// 门禁化（tests/compute_markdown.rs 先例；断言零变化——native 形态照常全量运行）。
#![cfg(feature = "native")]
//! Task 4（P3 批次）集成测试：`POST /api/compute/diagram` 单图渲染端点
//! （spec 2026-10-23 §8.1）。
//!
//! oneshot 既有模式（tests/compute_markdown.rs 同款 fixture）。断言面：
//! - 成功 200 `{svg}`：graphviz 规范名 + dot 别名/大小写不敏感（canonical_of
//!   NATIVE 表，与围栏 M1 同语义）+ svgbob 第二引擎路径；
//! - 渲染失败 400：零节点 `digraph{}`（判空早退面，终审 C2 同源）与解析失败
//!   同落「图表渲染失败」；
//! - 非 NATIVE 语言 400：mermaid 等「非服务端原生图表语言」；
//! - 门控面：`--compute` 缺失 404；鉴权矩阵有 token 无 Bearer → 401（compute
//!   组同款，镜像 tests/compute_markdown.rs）。

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;
use vviewer::state::AppState;

struct Fixture {
    _dir: tempfile::TempDir,
    state: AppState,
}

fn fixture(compute: bool, token: Option<&str>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(dir.path().to_path_buf(), None, token.map(str::to_string), false, None)
        .with_compute(compute);
    Fixture { _dir: dir, state }
}

/// POST JSON 并取回（状态码 + body）。
async fn post_json(
    app: axum::Router,
    uri: &str,
    authorization: Option<&str>,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(auth) = authorization {
        builder = builder.header("authorization", auth);
    }
    let res = app
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, body)
}

fn diagram_body(lang: &str, source: &str) -> serde_json::Value {
    json!({ "lang": lang, "source": source })
}

// ---------- 成功面：200 {svg} ----------

#[tokio::test]
async fn diagram_renders_graphviz_to_svg() {
    let f = fixture(true, None);
    let app = vviewer::build_router(f.state);
    let (status, body) = post_json(
        app,
        "/api/compute/diagram",
        None,
        diagram_body("graphviz", "digraph { a -> b }"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["svg"].as_str().unwrap().contains("<svg"), "{body}");
}

#[tokio::test]
async fn diagram_accepts_alias_and_case_insensitive_lang() {
    let f = fixture(true, None);
    let app = vviewer::build_router(f.state);
    // dot 是 graphviz 的别名（NATIVE 表）；大小写不敏感与围栏管线（M1）同语义
    for lang in ["dot", "DOT", "GraphViz"] {
        let (status, body) = post_json(
            app.clone(),
            "/api/compute/diagram",
            None,
            diagram_body(lang, "digraph { a -> b }"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "lang={lang}");
        assert!(body["svg"].as_str().unwrap().contains("<svg"), "lang={lang}: {body}");
    }
    // svgbob：第二引擎路径（纯 Rust 直出，无进程）
    let (status, body) = post_json(
        app,
        "/api/compute/diagram",
        None,
        diagram_body("SVGBOB", "+---+   |a|"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["svg"].as_str().unwrap().contains("<svg"), "{body}");
}

// ---------- 渲染失败 400 ----------

#[tokio::test]
async fn diagram_zero_node_graph_rejected_400() {
    // 终审 C2 同源：零节点图 layout-rs do_it 内 assert panic——判空早退 None
    // → 端点 400（围栏管线是保留原 fence 交客户端，端点无原文可保留故显式 400）
    let f = fixture(true, None);
    let app = vviewer::build_router(f.state);
    let (status, body) = post_json(
        app,
        "/api/compute/diagram",
        None,
        diagram_body("graphviz", "digraph{}"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "图表渲染失败", "{body}");
}

#[tokio::test]
async fn diagram_parse_failure_rejected_400() {
    let f = fixture(true, None);
    let app = vviewer::build_router(f.state);
    let (status, body) = post_json(
        app,
        "/api/compute/diagram",
        None,
        diagram_body("graphviz", "digraph { a ->"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "图表渲染失败", "{body}");
}

// ---------- 非 NATIVE 语言 400 ----------

#[tokio::test]
async fn diagram_non_native_lang_rejected_400() {
    let f = fixture(true, None);
    let app = vviewer::build_router(f.state);
    for lang in ["mermaid", "plantuml", ""] {
        let (status, body) = post_json(
            app.clone(),
            "/api/compute/diagram",
            None,
            diagram_body(lang, "graph TD; a -> b"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "lang={lang}");
        assert_eq!(body["error"], "非服务端原生图表语言", "lang={lang}: {body}");
    }
}

// ---------- 门控面：--compute 缺失 404 / Bearer 401 ----------

#[tokio::test]
async fn diagram_404_without_compute_flag() {
    let f = fixture(false, None);
    let app = vviewer::build_router(f.state);
    let (status, body) = post_json(
        app,
        "/api/compute/diagram",
        None,
        diagram_body("dot", "digraph { a -> b }"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn diagram_requires_bearer_when_token_configured() {
    let f = fixture(true, Some("tok-1"));
    let app = vviewer::build_router(f.state);
    let (status, _) = post_json(
        app.clone(),
        "/api/compute/diagram",
        None,
        diagram_body("dot", "digraph { a -> b }"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, body) = post_json(
        app,
        "/api/compute/diagram",
        Some("Bearer tok-1"),
        diagram_body("dot", "digraph { a -> b }"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["svg"].as_str().unwrap().contains("<svg"), "{body}");
}
