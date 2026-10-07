//! Task 2 集成测试：--compute 能力开关与 POST /api/compute/markdown（comrak）。

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

// ---------- capabilities 开关 ----------

#[tokio::test]
async fn health_reports_compute_only_when_enabled() {
    let f = fixture(false, None);
    let app = vviewer::build_router(f.state);
    let res = app.oneshot(Request::builder().uri("/api/health").body(Body::empty()).unwrap()).await.unwrap();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let caps: Vec<String> = serde_json::from_slice::<serde_json::Value>(&bytes)
        .unwrap()["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    assert_eq!(caps, vec!["file-server"]);

    let f = fixture(true, None);
    let app = vviewer::build_router(f.state);
    let res = app.oneshot(Request::builder().uri("/api/health").body(Body::empty()).unwrap()).await.unwrap();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(v["capabilities"].as_array().unwrap().iter().any(|c| c == "compute"));
}

// ---------- GFM 渲染 ----------

#[tokio::test]
async fn markdown_renders_gfm_table_tasklist_footnotes() {
    let f = fixture(true, None);
    let app = vviewer::build_router(f.state);
    let text = "| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\nx[^1]\n\n[^1]: note\n";
    let (status, body) = post_json(app, "/api/compute/markdown", None, json!({ "text": text })).await;
    assert_eq!(status, StatusCode::OK);
    let html = body["html"].as_str().unwrap();
    assert!(html.contains("<table"), "表格: {html}");
    assert!(html.contains("<th>a</th>"), "表头: {html}");
    assert!(html.contains("checkbox"), "任务列表: {html}");
    assert!(html.contains("footnote-ref"), "脚注引用: {html}");
    assert!(html.contains(r#"class="footnotes""#), "脚注定义区块: {html}");
}

#[tokio::test]
async fn markdown_passes_raw_html_through_unsafe() {
    let f = fixture(true, None);
    let app = vviewer::build_router(f.state);
    let (status, body) = post_json(
        app,
        "/api/compute/markdown",
        None,
        json!({ "text": "<div class=\"x\">raw</div>\n" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["html"].as_str().unwrap().contains(r#"<div class="x">raw</div>"#));
}

#[tokio::test]
async fn markdown_hardbreaks_off_by_default() {
    let f = fixture(true, None);
    let app = vviewer::build_router(f.state);
    let (status, body) = post_json(app, "/api/compute/markdown", None, json!({ "text": "a\nb\n" })).await;
    assert_eq!(status, StatusCode::OK);
    let html = body["html"].as_str().unwrap();
    // hardbreaks=false：单换行是软换行（段落内换行符保留，不生成 <br />）
    assert!(html.contains("<p>a\nb</p>"), "软换行: {html}");
    assert!(!html.contains("<br"), "不应有硬换行: {html}");
}

// ---------- wikilinks ----------

#[tokio::test]
async fn markdown_wikilinks_target_and_text_forms() {
    let f = fixture(true, None);
    let app = vviewer::build_router(f.state);
    let (status, body) = post_json(
        app,
        "/api/compute/markdown",
        None,
        json!({
            "text": "see [[docs/index|首页]] and [[notes]]\n",
            "options": { "wikilinks": true }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let html = body["html"].as_str().unwrap();
    assert!(
        html.contains(r#"<a class="vv-wikilink" data-target="docs/index">首页</a>"#),
        "带文本 wikilink: {html}"
    );
    assert!(
        html.contains(r#"<a class="vv-wikilink" data-target="notes">notes</a>"#),
        "裸 target wikilink: {html}"
    );
}

#[tokio::test]
async fn markdown_wikilinks_default_off_and_attr_escaped() {
    let f = fixture(true, None);
    let app = vviewer::build_router(f.state);

    // 默认关闭：[[x]] 保持原样（comrak 不识别，原文输出）
    let (status, body) = post_json(app.clone(), "/api/compute/markdown", None, json!({ "text": "[[x]]\n" })).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["html"].as_str().unwrap().contains("[[x]]"), "默认不处理 wikilink");

    // 属性值 HTML 转义：引号与尖括号不破坏属性边界
    let (status, body) = post_json(
        app,
        "/api/compute/markdown",
        None,
        json!({
            "text": "[[a\"<b>|t]]\n",
            "options": { "wikilinks": true }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let html = body["html"].as_str().unwrap();
    assert!(html.contains(r#"data-target="a&quot;&lt;b&gt;""#), "属性转义: {html}");
    assert!(!html.contains(r#"data-target="a""#), "不得提前终止属性: {html}");
}

// ---------- 体积上限 / 开关缺失 / 鉴权 ----------

#[tokio::test]
async fn markdown_over_5mb_rejected_413() {
    let f = fixture(true, None);
    let app = vviewer::build_router(f.state);
    let big = "a".repeat(5 * 1024 * 1024 + 1);
    let (status, body) = post_json(app.clone(), "/api/compute/markdown", None, json!({ "text": big })).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(body["error"].is_string(), "413 应有 JSON error: {body}");
}

#[tokio::test]
async fn markdown_under_5mb_accepted() {
    let f = fixture(true, None);
    let app = vviewer::build_router(f.state);
    // 5MB 整（临界值）可过；comrak 处理足够快（ASCII 无结构）
    let ok = "a".repeat(5 * 1024 * 1024);
    let (status, _) = post_json(app.clone(), "/api/compute/markdown", None, json!({ "text": ok })).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn markdown_404_without_compute_flag() {
    let f = fixture(false, None);
    let app = vviewer::build_router(f.state);
    let (status, body) = post_json(app.clone(), "/api/compute/markdown", None, json!({ "text": "# hi" })).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body["error"].is_string());
}

#[tokio::test]
async fn markdown_requires_bearer_when_token_configured() {
    let f = fixture(true, Some("tok-1"));
    let app = vviewer::build_router(f.state);
    let (status, _) = post_json(app.clone(), "/api/compute/markdown", None, json!({ "text": "# hi" })).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, body) = post_json(
        app,
        "/api/compute/markdown",
        Some("Bearer tok-1"),
        json!({ "text": "# hi" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // header_id_prefix 使 h1 带 id 属性：<h1 id="user-content-hi">
    assert!(body["html"].as_str().unwrap().contains("<h1"), "{body}");
}
