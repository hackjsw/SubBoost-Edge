import {
  handleAuthMe,
  handleCronSubscriptionUpdates,
  handleHealth,
  handleSourceImport,
  handleStoredConfig,
  handleSubscriptionRecord,
  handleSubscriptions,
  runScheduledSubscriptionUpdates,
} from "./edge-api";
import { handleAuthLogin, handleAuthLogout, isAuthenticated, unauthorizedResponse } from "./auth";
import { handleClash, handleShorten, handleSub, handleTest } from "./subscription";
import { methodNotAllowed } from "./http";
import { handleStoredConfigCapability } from "./stored-config-capability";
import {
  handleRulesRefresh,
  handleCnRuleCandidates,
  handleRulesSearch,
  handleRulesStatus,
  RULE_CATALOG_CRON,
  runScheduledRuleCatalogUpdate,
} from "./rules-api";
import type { ExecutionContextLike, ScheduledControllerLike, WorkerEnv } from "./types";

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isPublicAsset(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname.startsWith("/login/") ||
    pathname.startsWith("/login.") ||
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/__next") ||
    pathname === "/edgesub-mark.svg" ||
    pathname === "/logo.png" ||
    pathname === "/favicon.ico" ||
    pathname === "/404.html" ||
    pathname === "/subboost-edge-source.tar.gz"
  );
}

export async function handleRequest(
  request: Request,
  env: WorkerEnv,
  ctx?: ExecutionContextLike
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" } });
  }
  if (url.pathname === "/api/health") return handleHealth(request, env);
  if (url.pathname === "/api/cron/update-subscriptions") return handleCronSubscriptionUpdates(request, env);
  if (url.pathname === "/api/auth/login") return handleAuthLogin(request, env);
  if (url.pathname === "/api/auth/logout") return handleAuthLogout(request);
  if (url.pathname.startsWith("/config-cap/")) return handleStoredConfigCapability(request, env);
  if (url.pathname.startsWith("/config/")) return handleStoredConfig(request, env, ctx);

  const publicStoredSubscription =
    (url.pathname === "/sub" || url.pathname === "/clash" || url.searchParams.has("id")) &&
    Boolean(url.searchParams.get("id")) &&
    !url.searchParams.has("source");
  if (publicStoredSubscription) {
    return url.pathname === "/clash" ? handleClash(request, env, ctx) : handleSub(request, env, ctx);
  }

  const authenticated = await isAuthenticated(request, env);
  if (url.pathname === "/api/auth/me") {
    return authenticated ? handleAuthMe(request, env) : unauthorizedResponse();
  }
  if (url.pathname === "/api/source-import") {
    return authenticated ? handleSourceImport(request) : unauthorizedResponse();
  }
  if (url.pathname === "/api/rules/search") {
    return authenticated ? handleRulesSearch(request, env) : unauthorizedResponse();
  }
  if (url.pathname === "/api/rules/status") {
    return authenticated ? handleRulesStatus(request, env) : unauthorizedResponse();
  }
  if (url.pathname === "/api/rules/refresh") {
    return authenticated ? handleRulesRefresh(request, env) : unauthorizedResponse();
  }
  if (url.pathname === "/api/rules/cn-candidates") {
    return authenticated ? handleCnRuleCandidates(request, env) : unauthorizedResponse();
  }
  if (url.pathname === "/api/subscriptions") {
    return authenticated ? handleSubscriptions(request, env) : unauthorizedResponse();
  }
  if (url.pathname.startsWith("/api/subscriptions/")) {
    return authenticated ? handleSubscriptionRecord(request, env) : unauthorizedResponse();
  }
  if (
    !authenticated &&
    (url.pathname === "/clash" ||
      url.pathname === "/shorten" ||
      url.pathname === "/sub" ||
      url.pathname === "/test" ||
      url.searchParams.has("source"))
  ) {
    return unauthorizedResponse();
  }
  if (url.pathname === "/clash") return handleClash(request, env, ctx);
  if (url.pathname === "/shorten") {
    return request.method === "POST" ? handleShorten(request, env) : methodNotAllowed(["POST"]);
  }
  if (url.pathname === "/sub" || url.searchParams.has("source") || url.searchParams.has("id")) {
    return handleSub(request, env, ctx);
  }
  if (url.pathname === "/test") return handleTest(request);

  if (!env.ASSETS) return new Response("Static assets are not configured", { status: 404 });
  if (!authenticated && !isPublicAsset(url.pathname)) {
    const loginUrl = new URL("/login", url.origin);
    loginUrl.searchParams.set("next", `${url.pathname}${url.search}`);
    return withSecurityHeaders(Response.redirect(loginUrl, 302));
  }
  return withSecurityHeaders(await env.ASSETS.fetch(request));
}

const worker = {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContextLike) {
    return handleRequest(request, env, ctx);
  },
  scheduled(controller: ScheduledControllerLike, env: WorkerEnv, ctx: ExecutionContextLike) {
    if (controller.cron === RULE_CATALOG_CRON) {
      const run = runScheduledRuleCatalogUpdate(env)
        .then((summary) => console.info("[edgesub-rules-cron] completed", summary))
        .catch((error) => {
          console.error("[edgesub-rules-cron] failed", {
            message: error instanceof Error ? error.message : "unknown error",
          });
        });
      ctx.waitUntil(run);
      return;
    }

    const run = runScheduledSubscriptionUpdates(env, new Date(controller.scheduledTime))
      .then((summary) => console.info("[edgesub-cron] completed", summary))
      .catch((error) => {
        console.error("[edgesub-cron] failed", {
          message: error instanceof Error ? error.message : "unknown error",
        });
      });
    ctx.waitUntil(run);
  },
};

export default worker;
