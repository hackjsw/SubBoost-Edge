"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { List, LogOut, WandSparkles } from "lucide-react";
import { ThemeToggle } from "@edge/components/theme-toggle";

export function EdgeMark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path
        className="es-logo-path"
        d="M13 17h25c7.2 0 13 5.8 13 13s-5.8 13-13 13H26c-7.2 0-13 5.8-13 13"
        fill="none"
        strokeLinecap="round"
        strokeWidth="7"
      />
      <circle className="es-logo-ink" cx="13" cy="17" r="6" />
      <circle cx="51" cy="30" r="6" fill="#dc654f" />
      <circle cx="13" cy="56" r="6" fill="#315fcb" />
    </svg>
  );
}

export function EdgeHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const isLoginPage = pathname === "/login";
  // Static export: the deployment host is only known in the browser.
  const [host, setHost] = React.useState("");
  React.useEffect(() => setHost(window.location.host), []);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
    router.refresh();
  };

  return (
    <header className="es-hdr">
      <div className="es-hdr-in">
        <Link href="/" className="es-logo" aria-label="EdgeSub 首页">
          <EdgeMark />
          EdgeSub
        </Link>
        {!isLoginPage && (
          <nav className="es-nav" aria-label="主导航">
            <Link href="/" className={pathname === "/" ? "on" : undefined}>
              <WandSparkles className="h-4 w-4" />
              生成器
            </Link>
            <Link href="/dashboard" className={pathname?.startsWith("/dashboard") ? "on" : undefined}>
              <List className="h-4 w-4" />
              我的订阅
            </Link>
          </nav>
        )}
        <div className="es-sp" />
        {host && <span className="es-host es-mono">{host}</span>}
        <ThemeToggle />
        {!isLoginPage && (
          <button type="button" className="es-btn ghost sm" onClick={() => void logout()}>
            <LogOut />
            <span className="es-only-d">退出</span>
          </button>
        )}
      </div>
    </header>
  );
}
