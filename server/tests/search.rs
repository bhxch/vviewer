//! Task 4 集成测试：POST /api/search（ripgrep NDJSON 流式）。
//!
//! 真 rg 子进程断言：命中帧形状 / --max-count 截断 / glob / 大小写 /
//! 字面量与正则 / path 限定与越界 403 / pattern 校验 400 / rg 缺失 501 / Bearer。

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;
use vviewer::state::AppState;

struct Fixture {
    _dir: tempfile::TempDir,
    state: AppState,
}

fn fixture(token: Option<&str>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("a.txt"), "hello world\nneedle here\nno match\nNEEDLE UP\n").unwrap();
    std::fs::create_dir(root.join("sub")).unwrap();
    std::fs::write(root.join("sub/b.rs"), "needle in b\n").unwrap();
    // 多字节行：断言字节偏移 → 1 起字符列换算（"中文needle" 的 n 在第 3 列）
    std::fs::write(root.join("zh.txt"), "中文needle\n").unwrap();
    // 字面量 vs 正则区分：'a.c' 字面量只命中第 2 行，正则命中两行
    std::fs::write(root.join("lit.txt"), "abc\na.c\n").unwrap();
    // --max-count 50：60 个命中行只保留前 50
    let many: String = "needle line\n".repeat(60);
    std::fs::write(root.join("many.txt"), many).unwrap();
    // --max-filesize 2M：略超 2MiB 的大文件即使含命中也跳过
    let mut big = "x".repeat(2 * 1024 * 1024);
    big.push_str("\nneedle in big\n");
    std::fs::write(root.join("big.txt"), big).unwrap();

    let state = AppState::new(dir.path().to_path_buf(), None, token.map(str::to_string), false, None);
    Fixture { _dir: dir, state }
}

/// 截断场景独立 fixture：25 个文件 × 60 命中行（每文件被 --max-count 压到 50，
/// 潜在 1250 > 上限 1000，必然触发截断）。
fn big_fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    for i in 0..25 {
        let content: String = "needle line\n".repeat(60);
        std::fs::write(dir.path().join(format!("t{i:02}.txt")), content).unwrap();
    }
    let state = AppState::new(dir.path().to_path_buf(), None, None, false, None);
    Fixture { _dir: dir, state }
}

async fn post_search(state: AppState, body: Value) -> (StatusCode, Vec<Value>) {
    let app = vviewer::build_router(state);
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/search")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    let frames: Vec<Value> = String::from_utf8(bytes.to_vec())
        .unwrap()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("每行必须是合法 JSON"))
        .collect();
    (status, frames)
}

fn match_frames(frames: &[Value]) -> Vec<&Value> {
    frames.iter().filter(|f| f.get("file").is_some()).collect()
}

fn done_frame(frames: &[Value]) -> &Value {
    frames.last().expect("必须有终帧")
}

fn file_names(frames: &[&Value]) -> Vec<String> {
    let mut names: Vec<String> = frames
        .iter()
        .map(|f| f["file"].as_str().unwrap().to_string())
        .collect();
    names.dedup();
    names
}

// ---------- 环境守卫：无 rg 的机器跳过真子进程断言 ----------

fn rg_available() -> bool {
    vviewer::routes::search::probe_rg().is_some()
}

// ---------- 基本命中 ----------

#[tokio::test]
async fn streams_match_frames_and_done() {
    if !rg_available() {
        return;
    }
    let f = fixture(None);
    let (status, frames) = post_search(f.state, json!({ "pattern": "needle" })).await;
    assert_eq!(status, StatusCode::OK);
    let hits = match_frames(&frames);
    assert!(!hits.is_empty());
    // 相对 root 的路径、1 起行列、行文本（无换行符）
    let first = hits.iter().find(|h| h["file"] == "a.txt").unwrap();
    assert_eq!(first["line"], 2);
    assert_eq!(first["col"], 1);
    assert_eq!(first["text"], "needle here");
    // 多字节行：字节偏移 6 → 字符列 3
    let zh = hits.iter().find(|h| h["file"] == "zh.txt").unwrap();
    assert_eq!(zh["line"], 1);
    assert_eq!(zh["col"], 3);
    assert_eq!(zh["text"], "中文needle");
    // 大文件（>2MiB）被跳过
    assert!(!file_names(&hits).iter().any(|n| n == "big.txt"));
    // 终帧
    let done = done_frame(&frames);
    assert_eq!(done["done"], true);
    assert_eq!(done["truncated"], false);
}

// ---------- --max-count 50：每文件命中行数上限 ----------

#[tokio::test]
async fn max_count_caps_matches_per_file() {
    if !rg_available() {
        return;
    }
    let f = fixture(None);
    let (_, frames) = post_search(f.state, json!({ "pattern": "needle" })).await;
    let hits = match_frames(&frames);
    let many_count = hits.iter().filter(|h| h["file"] == "many.txt").count();
    assert_eq!(many_count, 50, "60 个命中行应被 --max-count 压到 50");
    let many_lines: Vec<u64> = hits
        .iter()
        .filter(|h| h["file"] == "many.txt")
        .map(|h| h["line"].as_u64().unwrap())
        .collect();
    assert_eq!(many_lines, (1..=50).collect::<Vec<_>>(), "保留前 50 行");
}

// ---------- 大小写 ----------

#[tokio::test]
async fn case_insensitive_by_default_and_flag_is_respected() {
    if !rg_available() {
        return;
    }
    let f = fixture(None);
    // 默认不敏感：needle 命中 "needle here" 与 "NEEDLE UP"
    let (_, frames) = post_search(f.state, json!({ "pattern": "NEEDLE" })).await;
    let a_lines: Vec<u64> = match_frames(&frames)
        .iter()
        .filter(|h| h["file"] == "a.txt")
        .map(|h| h["line"].as_u64().unwrap())
        .collect();
    assert_eq!(a_lines, vec![2, 4]);

    let f2 = fixture(None);
    let (_, frames) =
        post_search(f2.state, json!({ "pattern": "NEEDLE", "caseSensitive": true })).await;
    let a_lines: Vec<u64> = match_frames(&frames)
        .iter()
        .filter(|h| h["file"] == "a.txt")
        .map(|h| h["line"].as_u64().unwrap())
        .collect();
    assert_eq!(a_lines, vec![4], "caseSensitive 只命中字面相同行");
}

// ---------- 字面量 vs 正则 ----------

#[tokio::test]
async fn literal_by_default_and_regex_opt_in() {
    if !rg_available() {
        return;
    }
    // 默认字面量：'a.c' 只命中 "a.c" 行
    let f = fixture(None);
    let (_, frames) = post_search(f.state, json!({ "pattern": "a.c" })).await;
    let lit_hits: Vec<u64> = match_frames(&frames)
        .iter()
        .filter(|h| h["file"] == "lit.txt")
        .map(|h| h["line"].as_u64().unwrap())
        .collect();
    assert_eq!(lit_hits, vec![2]);

    // regex: true → 默认正则引擎，'a.c' 命中 abc 与 a.c
    let f2 = fixture(None);
    let (_, frames) = post_search(f2.state, json!({ "pattern": "a.c", "regex": true })).await;
    let lit_hits: Vec<u64> = match_frames(&frames)
        .iter()
        .filter(|h| h["file"] == "lit.txt")
        .map(|h| h["line"].as_u64().unwrap())
        .collect();
    assert_eq!(lit_hits, vec![1, 2]);
}

// ---------- glob 过滤 ----------

#[tokio::test]
async fn glob_filters_files() {
    if !rg_available() {
        return;
    }
    let f = fixture(None);
    let (_, frames) = post_search(f.state, json!({ "pattern": "needle", "glob": "*.rs" })).await;
    let hits = match_frames(&frames);
    assert_eq!(file_names(&hits), vec!["sub/b.rs".to_string()]);
}

// ---------- path 限定与越界 ----------

#[tokio::test]
async fn path_scopes_search() {
    if !rg_available() {
        return;
    }
    let f = fixture(None);
    let (_, frames) = post_search(f.state, json!({ "pattern": "needle", "path": "sub" })).await;
    let hits = match_frames(&frames);
    assert_eq!(file_names(&hits), vec!["sub/b.rs".to_string()]);
}

#[cfg(unix)]
#[tokio::test]
async fn path_escaping_root_is_403() {
    if !rg_available() {
        return;
    }
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "needle outside").unwrap();
    let f = fixture(None);
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), f._dir.path().join("link")).unwrap();
    let (status, frames) =
        post_search(f.state, json!({ "pattern": "needle", "path": "link" })).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // 错误响应是单个 {"error": ...} JSON 体（非 NDJSON 帧）
    assert_eq!(frames.len(), 1);
    assert!(frames[0].get("error").is_some());
}

// ---------- pattern 校验 ----------

#[tokio::test]
async fn empty_pattern_is_400() {
    let f = fixture(None);
    let (status, _) = post_search(f.state, json!({ "pattern": "" })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn overlong_pattern_is_400() {
    let f = fixture(None);
    let (status, _) = post_search(f.state, json!({ "pattern": "a".repeat(257) })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

// ---------- 1000 命中截断 ----------

#[tokio::test]
async fn truncates_at_1000_matches() {
    if !rg_available() {
        return;
    }
    let f = big_fixture();
    let (status, frames) = post_search(f.state, json!({ "pattern": "needle" })).await;
    assert_eq!(status, StatusCode::OK);
    let hits = match_frames(&frames);
    assert_eq!(hits.len(), 1000, "恰好 1000 帧后停止");
    let done = done_frame(&frames);
    assert_eq!(done["done"], true);
    assert_eq!(done["truncated"], true);
}

// ---------- rg 缺失 → 501 ----------

#[tokio::test]
async fn missing_rg_is_501() {
    let f = fixture(None);
    let state = f.state.with_rg_path(Some("/nonexistent/rg-for-test".to_string()));
    let (status, frames) = post_search(state, json!({ "pattern": "needle" })).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(frames.len(), 1);
    assert!(frames[0].get("error").is_some());
}

// ---------- Bearer 鉴权 ----------

#[tokio::test]
async fn search_requires_bearer_when_token_configured() {
    if !rg_available() {
        return;
    }
    let f = fixture(Some("tok-1"));
    let app = vviewer::build_router(f.state.clone());
    let res = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/search")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "pattern": "needle" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}
