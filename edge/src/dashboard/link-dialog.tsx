"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Copy, X } from "lucide-react";
import { buildSubscriptionFormatUrl, type SubscriptionFormat } from "@subboost/core/subscription/output-format";
import { copyText } from "./browser";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  subtitle: string;
  subscriptionUrl: string;
  initialFormat?: SubscriptionFormat;
};

function QrCode({ text }: { text: string }) {
  const [svg, setSvg] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    // Loaded on demand: the encoder only ships when someone opens this dialog.
    void import("uqr").then(({ renderSVG }) => {
      if (!cancelled) setSvg(renderSVG(text, { ecc: "M", border: 1, pixelSize: 6 }));
    });
    return () => {
      cancelled = true;
    };
  }, [text]);
  return (
    <div className="es-qr" role="img" aria-label="订阅链接二维码">
      {svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="es-qr-loading" />}
    </div>
  );
}

export function LinkDialog({ open, onOpenChange, name, subtitle, subscriptionUrl, initialFormat = "clash" }: Props) {
  const [format, setFormat] = React.useState<SubscriptionFormat>(initialFormat);
  const [copied, setCopied] = React.useState(false);
  const [copyFailed, setCopyFailed] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setFormat(initialFormat);
      setCopied(false);
      setCopyFailed(false);
    }
  }, [open, initialFormat]);

  const url = buildSubscriptionFormatUrl(subscriptionUrl, format);
  const copy = async () => {
    const ok = await copyText(url);
    setCopied(ok);
    setCopyFailed(!ok);
    if (ok) setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="es-scrim" />
        <Dialog.Content className="es-dialog" aria-describedby={undefined}>
          <div className="es-dialog-h">
            <div>
              <Dialog.Title asChild>
                <h2>订阅链接</h2>
              </Dialog.Title>
              <p>
                {name} · {subtitle}
              </p>
            </div>
            <Dialog.Close className="es-btn ghost icon" aria-label="关闭">
              <X />
            </Dialog.Close>
          </div>
          <div className="es-dialog-b">
            <div className="es-seg" role="tablist" aria-label="订阅格式">
              {(["clash", "v2rayn"] as const).map((value) => (
                <button key={value} type="button" role="tab" aria-selected={format === value} onClick={() => setFormat(value)}>
                  {value === "clash" ? "Clash / Mihomo" : "v2rayN"}
                </button>
              ))}
            </div>
            <QrCode text={url} />
            <div className="es-urlbox">
              <code className="es-mono" title={url}>
                {url}
              </code>
              <button type="button" className="es-btn pri" onClick={() => void copy()}>
                {copied ? <Check /> : <Copy />}
                {copied ? "已复制" : "复制"}
              </button>
            </div>
            {copyFailed && <p className="es-copy-failed">复制失败，请长按或选中上方链接手动复制。</p>}
            <div className="es-hint">订阅链接相当于访问凭证，请勿公开分享。手机客户端可直接扫描二维码导入。</div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
