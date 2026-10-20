//! Bearer 鉴权中间件（constant-time 比较语义在 vviewer-core::auth——多端发布
//! 阶段二业务体下沉，此处只留头部提取与 401 响应构造的 axum 面）。

use axum::extract::{Request, State};
use axum::http::{header, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

use vviewer_core::auth;

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
        .and_then(auth::bearer_token);

    let ok = provided.is_some_and(|t| auth::check(t, expected));
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
