"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { List, Plus, WandSparkles } from "lucide-react";

export function EdgeMobileNav() {
  const pathname = usePathname();
  if (pathname === "/login") return null;

  return (
    <nav className="es-tabbar" aria-label="主导航">
      <Link href="/" className={pathname === "/" ? "on" : undefined}>
        <WandSparkles />
        生成器
      </Link>
      <Link href="/?newSubscription=1" aria-label="新建订阅">
        <span className="es-new-c">
          <Plus />
        </span>
        新建
      </Link>
      <Link href="/dashboard" className={pathname?.startsWith("/dashboard") ? "on" : undefined}>
        <List />
        我的订阅
      </Link>
    </nav>
  );
}
