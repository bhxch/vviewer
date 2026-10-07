//! Bearer 鉴权中间件（constant-time 比较）。

use axum::extract::{Request, State};
use axum::http::{header, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

/// 有 token 时：除豁免路由（/api/health、ticket 制的 /api/events）外，
/// 要求 `Authorization: Bearer <t>`；无 token 配置时全部放行。
pub async fn auth_mw(
    State(state): State<crate::state::AppState>,
    req: Request,
    next: Next,
) -> Response {
    let Some(expected) = state.token.as_deref() else {
        return next.run(req).await;
    };

    // CORS 预检不携带 Authorization，放行（预检不触达资源）
    if req.method() == Method::OPTIONS {
        return next.run(req).await;
    }

    let provided = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(bearer_token);

    let ok = provided.is_some_and(|t| ct_eq(t.as_bytes(), expected.as_bytes()));
    if ok {
        next.run(req).await
    } else {
        unauthorized()
    }
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer")],
        Json(serde_json::json!({ "error": "unauthorized" })),
    )
        .into_response()
}

/// `Authorization: Bearer <t>`（scheme 大小写不敏感，RFC 7235）。
fn bearer_token(value: &str) -> Option<&str> {
    let (scheme, rest) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then_some(rest.trim())
}

/// 逐字节 OR 的 constant-time 比较：长度差异与逐字节差异都累积后统一判定，
/// 不因首个不同字节提前返回。
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= (x ^ y) as usize;
    }
    diff == 0
}
