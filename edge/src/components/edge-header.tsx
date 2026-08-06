"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Database, FileArchive, LogOut, RadioTower } from "lucide-react";

export function EdgeHeader() {
  const pathname = usePathname();
  const isLoginPage = pathname === "/login";

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  };

  return (
    <header className="sticky top-0 z-50 border-b border-[#d7e0de] bg-white/95 shadow-[0_1px_12px_rgba(23,35,33,0.05)] backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-full max-w-[clamp(1200px,95vw,2400px)] items-center justify-between px-4 sm:px-6 lg:px-8 xl:px-12">
        <Link href="/" className="group flex min-w-0 items-center gap-3" aria-label="EdgeSub 首页">
          <Image
            src="/edgesub-mark.svg"
            alt="EdgeSub"
            width={40}
            height={40}
            priority
            className="h-10 w-10"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-base font-semibold text-[#172321] sm:text-lg">EdgeSub</span>
              <span className="hidden rounded border border-[#8ccfc5] bg-[#edf9f7] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#05665b] sm:inline-flex">
                Edge
              </span>
            </div>
            <span className="hidden text-[11px] text-[#60706d] sm:block">sub.cces.us.ci</span>
          </div>
        </Link>

        <div className="flex items-center gap-2">
          {!isLoginPage && <div className="hidden items-center gap-2 text-xs text-[#60706d] md:flex" aria-label="边缘服务在线">
            <RadioTower className="h-3.5 w-3.5 text-[#087f70]" />
            <span>KV + Cron</span>
          </div>}
          {!isLoginPage && (
            <Link
              href="/dashboard"
              className="inline-flex h-9 items-center justify-center gap-2 rounded border border-[#d7e0de] bg-[#f8faf9] px-2.5 text-sm text-[#475754] transition-colors hover:border-[#9dc9c2] hover:bg-[#edf9f7] hover:text-[#05665b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#087f70]/40 sm:px-3"
              title="订阅记录"
            >
              <Database className="h-4 w-4" />
              <span className="hidden sm:inline">订阅记录</span>
            </Link>
          )}
          <a
            href="/subboost-edge-source.tar.gz"
            download
            className="inline-flex h-9 w-9 items-center justify-center rounded border border-[#d7e0de] bg-[#f8faf9] text-[#60706d] transition-colors hover:border-[#9dc9c2] hover:bg-[#edf9f7] hover:text-[#05665b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#087f70]/40"
            aria-label="下载 EdgeSub 对应源代码"
            title="下载对应源代码"
          >
            <FileArchive className="h-4 w-4" />
          </a>
          {!isLoginPage && (
            <button
              type="button"
              onClick={() => void logout()}
              className="inline-flex h-9 w-9 items-center justify-center rounded border border-[#d7e0de] bg-[#f8faf9] text-[#60706d] transition-colors hover:border-[#e4aaa0] hover:bg-[#fff3f0] hover:text-[#b54236] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#dc654f]/40"
              aria-label="退出登录"
              title="退出登录"
            >
              <LogOut className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
