"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LogOut, ServerCog, ShieldCheck } from "lucide-react";

import { Button } from "@subboost/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@subboost/ui/components/ui/card";
import { useUserStore } from "@subboost/ui/store/user-store";

export default function SettingsPage() {
  const router = useRouter();
  const { user, fetchUser, logout } = useUserStore();

  React.useEffect(() => {
    void fetchUser();
  }, [fetchUser]);

  const handleLogout = async () => {
    await logout();
    router.replace("/login");
    router.refresh();
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-1">账户设置</h1>
          <p className="text-white/50">本地管理员、订阅容量和运行端点</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <div className="rounded-lg bg-indigo-500/20 p-2 text-indigo-300">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <CardTitle className="text-base">本地管理员</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-xs text-white/40">用户名</p>
              <p className="mt-1 font-medium">{user?.username || "未登录"}</p>
            </div>
            <div>
              <p className="text-xs text-white/40">已保存订阅</p>
              <p className="mt-1 font-medium">{user ? `${user.subscriptionCount} / ${user.quota.maxSubscriptions}` : "-"}</p>
            </div>
            <Button variant="destructive" className="gap-2" onClick={() => void handleLogout()} disabled={!user}>
              <LogOut className="h-4 w-4" />
              退出登录
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center gap-3 space-y-0">
            <div className="rounded-lg bg-sky-500/20 p-2 text-sky-300">
              <ServerCog className="h-5 w-5" />
            </div>
            <CardTitle className="text-base">运行端点</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-white/60">
            <div>
              <p className="text-xs text-white/40">存活检查</p>
              <code className="mt-1 block rounded-md bg-white/5 px-3 py-2 text-white/70">/api/health/live</code>
            </div>
            <div>
              <p className="text-xs text-white/40">就绪检查</p>
              <code className="mt-1 block rounded-md bg-white/5 px-3 py-2 text-white/70">/api/health/ready</code>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
