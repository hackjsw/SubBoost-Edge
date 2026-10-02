"use client";

import * as React from "react";
import { Eye, EyeOff, KeyRound, LoaderCircle, LogIn } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { EdgeMark } from "@edge/components/edge-header";

function safeNextPath(value: string | null): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function LoginForm() {
  const searchParams = useSearchParams();
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState("");
  const nextPath = safeNextPath(searchParams.get("next"));

  React.useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/me", { cache: "no-store" }).then((response) => {
      if (!cancelled && response.ok) window.location.replace(nextPath);
    });
    return () => {
      cancelled = true;
    };
  }, [nextPath]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error || "登录失败");
      window.location.replace(nextPath);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "登录失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="es-login">
      <section className="es-card es-login-card">
        <div className="es-login-bar" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="es-login-body">
          <div className="es-login-head">
            <span className="es-logo es-login-mark">
              <EdgeMark />
            </span>
            <div>
              <h1>管理员登录</h1>
              <p>EdgeSub · 订阅转换与自动更新工作台</p>
            </div>
          </div>

          <form onSubmit={submit} className="es-login-form">
            <label htmlFor="admin-password">管理密码</label>
            <div className="es-login-field">
              <KeyRound className="es-login-key" aria-hidden="true" />
              <input
                id="admin-password"
                className="es-input"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                autoFocus
                required
              />
              <button
                type="button"
                className="es-btn ghost sm icon es-login-eye"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                title={showPassword ? "隐藏密码" : "显示密码"}
              >
                {showPassword ? <EyeOff /> : <Eye />}
              </button>
            </div>

            {error && (
              <div role="alert" className="es-login-err">
                {error}
              </div>
            )}

            <button type="submit" className="es-btn pri lg es-block" disabled={!password || submitting}>
              {submitting ? <LoaderCircle className="es-spin" /> : <LogIn />}
              {submitting ? "正在登录…" : "登录"}
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}

export default function LoginPage() {
  return (
    <React.Suspense fallback={<div className="es-login" />}>
      <LoginForm />
    </React.Suspense>
  );
}
