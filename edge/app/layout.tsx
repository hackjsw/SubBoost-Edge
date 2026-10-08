import type { Metadata } from "next";
import "@subboost/ui/styles/globals.css";
import "../src/styles/edge-light.css";
import "../src/styles/edge-dark.css";
import "../src/styles/edgesub.css";
import "../src/styles/generator.css";
import "../src/styles/login.css";
import { ConfirmDialogHost } from "@subboost/ui/components/ui/confirm-dialog";
import { ScrollLockStabilizer } from "@subboost/ui/components/layout/scroll-lock-stabilizer";
import { Toaster } from "@subboost/ui/components/ui/toaster";
import { EdgeFooter } from "@edge/components/edge-footer";
import { EdgeHeader } from "@edge/components/edge-header";
import { EdgeMobileNav } from "@edge/components/edge-mobile-nav";
import { ACCENT_BOOT_SCRIPT } from "@edge/lib/accent";
import { THEME_BOOT_SCRIPT } from "@edge/lib/theme";

export const metadata: Metadata = {
  title: "EdgeSub",
  description: "Cloudflare Edge 上的 Clash 与 Mihomo 订阅工作台",
  icons: { icon: "/edgesub-mark.svg", apple: "/edgesub-mark.svg" },
};

export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f6f5" },
    { media: "(prefers-color-scheme: dark)", color: "#111316" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // The boot scripts set data-theme, the theme class and data-accent before hydration.
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: ACCENT_BOOT_SCRIPT }} />
      </head>
      <body className="font-sans">
        <ScrollLockStabilizer />
        <div className="min-h-screen bg-gradient-radial flex flex-col">
          <EdgeHeader />
          <main className="flex-1">{children}</main>
          <EdgeFooter />
          <EdgeMobileNav />
        </div>
        <Toaster />
        <ConfirmDialogHost />
      </body>
    </html>
  );
}
