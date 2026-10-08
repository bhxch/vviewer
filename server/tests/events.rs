//! Task 4 集成测试：`GET /api/events` SSE 变更推送。
//!
//! SSE body 是流：`oneshot` 拿到响应头后用 http_body_util 逐帧收集
//! （tokio::time 超时窗口兜底），断言窗口内收到的 `data:` 帧内容——
//! 含 changed 推送、500ms debounce 聚合与 watcher 建立失败的降级帧。

use std::path::PathBuf;
use std::time::Duration;

use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;
use vviewer::state::AppState;

struct Fixture {
    dir: tempfile::TempDir,
    state: AppState,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("a.txt"), "seed").unwrap();
    std::fs::create_dir_all(root.join("sub")).unwrap();
    let state = AppState::new(root.to_path_buf(), None, None, false, None);
    Fixture { dir, state }
}

async fn issue_ticket(state: &AppState) -> String {
    let app = vviewer::build_router(state.clone());
    let req = Request::builder()
        .method("POST")
        .uri("/api/ticket")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    v["ticket"].as_str().unwrap().to_string()
}

/// 带 ticket 连接 SSE，返回响应头与流式 body（连接此时已订阅广播）。
async fn connect(state: &AppState, ticket: &str) -> (StatusCode, HeaderMap, axum::body::Body) {
    let app = vviewer::build_router(state.clone());
    let req = Request::builder()
        .uri(&format!("/api/events?ticket={ticket}"))
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    (res.status(), res.headers().clone(), res.into_body())
}

/// 在 window 内收集所有 SSE 帧，返回其中 `data:` 载荷（每帧一个字符串）。
/// 超时后返回已收到的部分；连接被服务端关闭则提前返回。
async fn collect_data_frames(body: &mut axum::body::Body, window: Duration) -> Vec<String> {
    let mut buf = String::new();
    let _ = tokio::time::timeout(window, async {
        while let Some(Ok(frame)) = body.frame().await {
            if let Ok(data) = frame.into_data() {
                buf.push_str(&String::from_utf8_lossy(&data));
            }
        }
    })
    .await;
    buf.lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .map(str::to_string)
        .collect()
}

fn parse(frames: &[String]) -> Vec<serde_json::Value> {
    frames
        .iter()
        .map(|s| serde_json::from_str(s).expect("data 帧应为 JSON"))
        .collect()
}

// ---------- ticket 门与响应头 ----------

#[tokio::test]
async fn missing_ticket_still_unauthorized() {
    let f = fixture();
    let (status, _, _) = connect(&f.state, "").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn ticket_upgrades_to_sse_stream() {
    let f = fixture();
    let ticket = issue_ticket(&f.state).await;
    let (status, headers, mut body) = connect(&f.state, &ticket).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers["content-type"],
        "text/event-stream",
        "SSE 响应头"
    );
    assert_eq!(headers["cache-control"], "no-cache", "SSE 流禁缓存");
    // 连接保持打开：短窗口内无文件变更 → 无 data 帧
    let frames = collect_data_frames(&mut body, Duration::from_millis(800)).await;
    assert!(frames.is_empty(), "未变更时不应有 data 帧: {frames:?}");
}

// ---------- changed 推送 ----------

#[tokio::test]
async fn write_pushes_changed_with_relative_path() {
    let f = fixture();
    let root: PathBuf = f.dir.path().to_path_buf();
    let ticket = issue_ticket(&f.state).await;
    let (status, _, mut body) = connect(&f.state, &ticket).await;
    assert_eq!(status, StatusCode::OK);

    std::fs::write(root.join("sub/new.txt"), "hello").unwrap();
    let frames = collect_data_frames(&mut body, Duration::from_secs(4)).await;
    let parsed = parse(&frames);
    assert!(
        parsed.iter().any(|v| v["type"] == "changed"
            && v["paths"]
                .as_array()
                .is_some_and(|ps| ps.iter().any(|p| p == "sub/new.txt"))),
        "4s 窗口内应收到含 sub/new.txt 的 changed 帧: {frames:?}"
    );
}

// ---------- debounce 聚合 ----------

#[tokio::test]
async fn rapid_writes_aggregate_into_single_frame() {
    let f = fixture();
    let root: PathBuf = f.dir.path().to_path_buf();
    let ticket = issue_ticket(&f.state).await;
    let (status, _, mut body) = connect(&f.state, &ticket).await;
    assert_eq!(status, StatusCode::OK);

    // 三个文件背靠背写入（微秒级间隔），必须落入同一个 500ms 窗口
    for name in ["b1.txt", "b2.txt", "b3.txt"] {
        std::fs::write(root.join(name), name).unwrap();
    }

    let frames = collect_data_frames(&mut body, Duration::from_secs(4)).await;
    let parsed = parse(&frames);
    let changed: Vec<&serde_json::Value> =
        parsed.iter().filter(|v| v["type"] == "changed").collect();
    assert_eq!(changed.len(), 1, "窗口内多事件应聚合为一条: {frames:?}");
    let paths: Vec<&str> = changed[0]["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().unwrap())
        .collect();
    for name in ["b1.txt", "b2.txt", "b3.txt"] {
        assert!(paths.contains(&name), "聚合帧应含 {name}: {paths:?}");
    }
}

// ---------- watcher 建立失败的健康快照 ----------

/// root 不可 watch → 健康停留 Recovering：建连快照发单条 `watch-degraded`
/// （前端未知 type 天然忽略、连接保持，不用前端终态语义的 `watch-error`）；
/// 该 root 永不恢复故之后无更多帧。恢复后帧照常流动的行为由 src/watch.rs
/// 单测覆盖（runtime_error_recovers_via_rebuilt_watcher 等）。
#[tokio::test]
async fn recovering_snapshot_emits_single_degraded_frame() {
    let state = AppState::new(
        PathBuf::from("/nonexistent-vviewer-watch-root"),
        None,
        None,
        false,
        None,
    );
    let ticket = issue_ticket(&state).await;
    let (status, _, mut body) = connect(&state, &ticket).await;
    assert_eq!(status, StatusCode::OK);

    let frames = collect_data_frames(&mut body, Duration::from_millis(1200)).await;
    assert_eq!(frames.len(), 1, "Recovering 快照只发一条降级帧: {frames:?}");
    let v = parse(&frames).remove(0);
    assert_eq!(v["type"], "watch-degraded");
}
