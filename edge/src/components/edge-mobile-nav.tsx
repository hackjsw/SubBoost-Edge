"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Database, Download, Eye, Settings2 } from "lucide-react";

const items = [
  { id: "config", label: "配置", icon: Settings2 },
  { id: "preview", label: "预览", icon: Eye },
] as const;

export function EdgeMobileNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [active, setActive] = React.useState("config");

  const goTo = (id: string) => {
    if (pathname !== "/") {
      router.push(`/#${id}`);
      return;
    }
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.history.replaceState(null, "", `/#${id}`);
    setActive(id);
  };

  if (pathname === "/login") return null;

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 h-16 border-t border-[#d7e0de] bg-white/95 shadow-[0_-4px_18px_rgba(23,35,33,0.06)] backdrop-blur-xl md:hidden" aria-label="工作台导航">
      <div className="grid h-full grid-cols-4">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => goTo(item.id)}
            className={`flex min-w-0 flex-col items-center justify-center gap-1 text-xs transition-colors ${
              active === item.id ? "text-[#087f70]" : "text-[#71817e]"
            }`}
          >
            <item.icon className="h-5 w-5" />
            <span>{item.label}</span>
          </button>
        ))}
        <Link
          href="/dashboard"
          className={`flex min-w-0 flex-col items-center justify-center gap-1 text-xs transition-colors ${
            pathname === "/dashboard" ? "text-[#087f70]" : "text-[#71817e]"
          }`}
        >
          <Database className="h-5 w-5" />
          <span>记录</span>
        </Link>
        <a
          href="/subboost-edge-source.tar.gz"
          download
          className="flex min-w-0 flex-col items-center justify-center gap-1 text-xs text-[#71817e] transition-colors hover:text-[#087f70]"
        >
          <Download className="h-5 w-5" />
          <span>源码</span>
        </a>
      </div>
    </nav>
  );
}
