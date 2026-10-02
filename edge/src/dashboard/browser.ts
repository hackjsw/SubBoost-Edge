import { buildSubscriptionFormatUrl, type SubscriptionFormat } from "@subboost/core/subscription/output-format";

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back below: non-secure origins and some embedded browsers lack the API.
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

function safeFilename(name: string, format: SubscriptionFormat): string {
  const base =
    String(name || "edgesub")
      .trim()
      .replace(/[\r\n]/g, " ")
      .replace(/[<>:"/\\|?*]+/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 80) || "edgesub";
  return `${base}.${format === "v2rayn" ? "txt" : "yaml"}`;
}

// Fetch first so a failing subscription surfaces as an error instead of a saved error page.
export async function downloadSubscription(name: string, subscriptionUrl: string, format: SubscriptionFormat): Promise<void> {
  const response = await fetch(buildSubscriptionFormatUrl(subscriptionUrl, format), { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = safeFilename(name, format);
  anchor.rel = "noopener noreferrer";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
