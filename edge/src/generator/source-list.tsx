"use client";

import * as React from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Check, FileText, Globe, Link2, Loader2, Plus, X } from "lucide-react";
import { DEFAULT_NODE_NAME_TEMPLATE } from "@subboost/core/node-name-template";
import { normalizeSubscriptionImportErrorInfo } from "@subboost/core/subscription/import-error";
import { useConfigStore, type SourceType, type SubscriptionSource } from "@subboost/ui/store/config-store";
import { markSourceAsPendingImport } from "@subboost/ui/product/subscription/source-import-state";
import { formatBytes } from "@edge/dashboard/format";
import { detectSource, isIpLiteralUrl, maskSubscriptionUrl, sourceTypeFor } from "./detect-source";

type SourceFlag = "ip" | "ambiguous";

const TYPE_LABELS: Record<SourceType, string> = { url: "订阅链接", yaml: "Clash YAML", nodes: "节点链接" };
const TYPE_ICONS: Record<SourceType, React.ComponentType<{ className?: string }>> = { url: Link2, yaml: FileText, nodes: Globe };

// Client identifiers offered when a panel only serves specific apps.
const CLIENT_USER_AGENTS = [
  { label: "mihomo", value: "mihomo/1.19.24" },
  { label: "Clash Verge", value: "clash-verge/v2.2.3" },
  { label: "Clash Meta 安卓版", value: "ClashMetaForAndroid/2.11.5.Meta" },
  { label: "v2rayN", value: "v2rayN/7.20.4" },
  { label: "Shadowrocket", value: "Shadowrocket/2.2.65" },
] as const;

export function userAgentLabel(value: string): string {
  return CLIENT_USER_AGENTS.find((item) => item.value === value)?.label ?? value;
}

function UserAgentRetry({ current, onRetry }: { current?: string; onRetry: (userAgent: string) => void }) {
  const preset = CLIENT_USER_AGENTS.find((item) => item.value === current);
  const [choice, setChoice] = React.useState<string>(preset ? preset.value : current ? "custom" : CLIENT_USER_AGENTS[1].value);
  const [custom, setCustom] = React.useState(preset ? "" : current ?? "");
  const value = choice === "custom" ? custom.trim() : choice;
  return (
    <>
      <div className="es-ua" role="radiogroup" aria-label="客户端标识">
        {CLIENT_USER_AGENTS.map((item) => (
          <button key={item.value} type="button" role="radio" aria-checked={choice === item.value} className={choice === item.value ? "on" : undefined} onClick={() => setChoice(item.value)}>
            {item.label}
          </button>
        ))}
        <button type="button" role="radio" aria-checked={choice === "custom"} className={choice === "custom" ? "on" : undefined} onClick={() => setChoice("custom")}>
          自定义…
        </button>
      </div>
      {choice === "custom" && (
        <input className="es-input es-ua-input es-mono" value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="例如 clash.meta/1.19.24" maxLength={200} aria-label="自定义客户端标识" />
      )}
      <div className="es-src-acts">
        <button type="button" className="es-btn sm pri" disabled={!value} onClick={() => onRetry(value)}>
          用 {choice === "custom" ? "自定义" : userAgentLabel(value)} 标识重试
        </button>
      </div>
    </>
  );
}

let sourceSeq = 0;
const newSourceId = () => `${Date.now().toString(36)}-${(sourceSeq += 1)}`;

function usageText(source: SubscriptionSource): string | null {
  const info = source.subscriptionUserInfo;
  if (!info) return null;
  const used = (info.upload ?? 0) + (info.download ?? 0);
  if (info.total) return `流量 ${formatBytes(used)} / ${formatBytes(info.total)}`;
  return used ? `已用 ${formatBytes(used)}` : null;
}

function SourceStatus({ source, flag }: { source: SubscriptionSource; flag?: SourceFlag }) {
  const errorInfo = normalizeSubscriptionImportErrorInfo(source.errorInfo ?? source.error ?? null);
  if (flag === "ip") return <span className="es-src-err">Cloudflare 无法访问 IP 地址形式的订阅</span>;
  if (flag === "ambiguous") return <span className="es-src-warn">无法判断这段内容的类型</span>;
  if (source.parsing) {
    return (
      <span className="es-src-muted">
        <Loader2 className="es-spin" />
        {source.type === "url" ? "正在拉取订阅…" : "正在解析…"}
      </span>
    );
  }
  if (errorInfo) {
    return (
      <span className="es-src-err">
        {errorInfo.httpStatus === 401 || errorInfo.httpStatus === 403
          ? `订阅服务器拒绝访问（HTTP ${errorInfo.httpStatus}）`
          : errorInfo.message}
      </span>
    );
  }
  if (source.parsed && !source.nodeCount && !source.useProxyProviders) {
    return <span className="es-src-warn">返回了内容，但没有可用节点</span>;
  }
  if (source.parsed) {
    const usage = usageText(source);
    return (
      <span className="es-src-ok">
        <Check />
        {source.useProxyProviders ? "由客户端拉取节点" : `已解析 ${source.nodeCount ?? 0} 个节点`}
        {usage ? ` · ${usage}` : ""}
      </span>
    );
  }
  return <span className="es-src-muted">待解析</span>;
}

function SourceFix({
  source,
  flag,
  onPasteContentInstead,
  onTryAnyway,
  onChooseType,
  onRetryWithUserAgent,
}: {
  source: SubscriptionSource;
  flag?: SourceFlag;
  onPasteContentInstead: () => void;
  onTryAnyway: () => void;
  onChooseType: (type: SourceType) => void;
  onRetryWithUserAgent: (userAgent: string) => void;
}) {
  const errorInfo = normalizeSubscriptionImportErrorInfo(source.errorInfo ?? source.error ?? null);
  if (flag === "ip") {
    return (
      <div className="es-src-fix">
        <p>Cloudflare Workers 只能请求域名，不能直接请求 IP 地址（会返回 403）。可以选择：</p>
        <div className="es-src-acts">
          <button type="button" className="es-btn sm pri" onClick={onPasteContentInstead}>
            <FileText />
            改为粘贴订阅内容
          </button>
          <button type="button" className="es-btn sm ghost" onClick={onTryAnyway}>
            仍然尝试
          </button>
        </div>
        <p className="es-src-note">
          在浏览器打开这个链接，复制全部内容粘贴进来即可生成配置，但该来源不能自动更新。需要自动更新时，请给订阅服务器绑定域名并使用域名证书。
        </p>
      </div>
    );
  }
  if (flag === "ambiguous") {
    return (
      <div className="es-src-fix">
        <p>请选择这段内容的类型：</p>
        <div className="es-src-acts">
          {(["nodes", "yaml", "url"] as const).map((type) => (
            <button key={type} type="button" className="es-btn sm" onClick={() => onChooseType(type)}>
              {TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (!source.parsing && errorInfo && source.type === "url") {
    const blocked = errorInfo.httpStatus === 401 || errorInfo.httpStatus === 403;
    return (
      <div className="es-src-fix">
        <p>
          {blocked
            ? source.userAgent
              ? `用 ${userAgentLabel(source.userAgent)} 标识访问仍被拒绝。可以换一种客户端标识重试；仍然失败时，可能是机场限制了访问地区或订阅已失效。`
              : "已依次用 v2rayN、mihomo、浏览器标识尝试，都被拒绝。多半是机场只放行特定客户端，可以指定一种客户端标识重试："
            : errorInfo.suggestedActions[0] ?? "请检查链接是否正确，或稍后重试。"}
        </p>
        {blocked && <UserAgentRetry current={source.userAgent} onRetry={onRetryWithUserAgent} />}
        <div className="es-src-acts" style={blocked ? { marginTop: 8 } : undefined}>
          <button type="button" className="es-btn sm" onClick={onTryAnyway}>
            重新拉取
          </button>
          <button type="button" className="es-btn sm" onClick={onPasteContentInstead}>
            <FileText />
            改为粘贴订阅内容
          </button>
        </div>
      </div>
    );
  }
  if (source.parsed && !source.nodeCount && !source.useProxyProviders && !errorInfo) {
    return (
      <div className="es-src-fix">
        <p>返回的可能是说明页面（例如“流量已用完”“请续费”），请检查订阅是否到期。</p>
      </div>
    );
  }
  return null;
}

function SourceCard({
  source,
  index,
  total,
  flag,
  onUpdate,
  onRemove,
  onMove,
  onFlag,
  onParse,
}: {
  source: SubscriptionSource;
  index: number;
  total: number;
  flag?: SourceFlag;
  onUpdate: (patch: Partial<SubscriptionSource>, reparse: boolean) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onFlag: (flag: SourceFlag | null) => void;
  onParse: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(source.content);
  React.useEffect(() => setDraft(source.content), [source.content]);
  const Icon = TYPE_ICONS[source.type];
  const errorInfo = normalizeSubscriptionImportErrorInfo(source.errorInfo ?? source.error ?? null);
  const state = flag === "ip" || (errorInfo && !source.parsing) ? "err" : flag === "ambiguous" || (source.parsed && !source.nodeCount && !source.useProxyProviders) ? "warn" : "";

  const commit = () => {
    setEditing(false);
    if (draft.trim() === source.content.trim()) return;
    onUpdate({ content: draft.trim() }, true);
  };

  return (
    <div className={`es-src ${state}`}>
      <div className="es-src-top">
        {flag || errorInfo ? <AlertTriangle className="es-src-ic" /> : null}
        <span className={`es-badge ${source.type === "url" ? "brand" : "blue"}`}>
          <Icon className="es-badge-ic" />
          {TYPE_LABELS[source.type]}
        </span>
        <SourceStatus source={source} flag={flag} />
        {source.type === "url" && source.userAgent && (
          <button type="button" className="es-ua-pin" title="点击恢复为自动尝试默认客户端标识" onClick={() => onUpdate({ userAgent: undefined }, true)}>
            以 {userAgentLabel(source.userAgent)} 身份拉取 ×
          </button>
        )}
        <span className="es-sp" />
        <select
          className="es-src-type"
          aria-label="来源类型"
          value={source.type}
          onChange={(event) => {
            onFlag(null);
            onUpdate({ type: event.target.value as SourceType }, true);
          }}
        >
          {(["url", "yaml", "nodes"] as const).map((type) => (
            <option key={type} value={type}>
              {TYPE_LABELS[type]}
            </option>
          ))}
        </select>
        <button type="button" className="es-btn ghost sm icon" onClick={() => onMove(-1)} disabled={index === 0} aria-label="上移">
          <ArrowUp />
        </button>
        <button type="button" className="es-btn ghost sm icon" onClick={() => onMove(1)} disabled={index === total - 1} aria-label="下移">
          <ArrowDown />
        </button>
        <button type="button" className="es-btn ghost sm icon" onClick={onRemove} aria-label="移除来源">
          <X />
        </button>
      </div>
      {source.type === "url" && !editing ? (
        <button type="button" className="es-src-body es-mono es-src-url" onClick={() => setEditing(true)} title="点击编辑">
          {maskSubscriptionUrl(source.content)}
        </button>
      ) : (
        <textarea
          className="es-src-body es-mono"
          value={draft}
          rows={source.type === "url" ? 1 : Math.min(6, Math.max(2, draft.split("\n").length))}
          autoFocus={editing}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          aria-label={`${TYPE_LABELS[source.type]}内容`}
        />
      )}
      <SourceFix
        source={source}
        flag={flag}
        onPasteContentInstead={() => {
          onFlag(null);
          onUpdate({ type: "yaml", content: "" }, false);
          setEditing(true);
        }}
        onTryAnyway={() => {
          onFlag(null);
          onParse();
        }}
        onChooseType={(type) => {
          onFlag(null);
          onUpdate({ type }, true);
        }}
        onRetryWithUserAgent={(userAgent) => onUpdate({ userAgent }, true)}
      />
    </div>
  );
}

export function SourceList() {
  const sources = useConfigStore((state) => state.sources);
  const setSources = useConfigStore((state) => state.setSources);
  const parseSingleSource = useConfigStore((state) => state.parseSingleSource);
  const [flags, setFlags] = React.useState<Record<string, SourceFlag>>({});
  const [draft, setDraft] = React.useState("");
  const visible = sources.filter((source) => source.content.trim());

  const setFlag = (id: string, flag: SourceFlag | null) =>
    setFlags((prev) => {
      const next = { ...prev };
      if (flag) next[id] = flag;
      else delete next[id];
      return next;
    });

  const parse = React.useCallback((id: string) => void parseSingleSource(id), [parseSingleSource]);

  const addFromText = (text: string) => {
    const detected = detectSource(text);
    if (!text.trim()) return;
    const created: SubscriptionSource[] = [];
    const newFlags: Record<string, SourceFlag> = {};
    const make = (type: SourceType, content: string): SubscriptionSource => ({
      id: newSourceId(),
      type,
      content,
      nameTemplate: DEFAULT_NODE_NAME_TEMPLATE,
    });
    if (detected.kind === "urls") {
      for (const url of detected.urls) {
        const source = make("url", url);
        if (isIpLiteralUrl(url)) newFlags[source.id] = "ip";
        created.push(source);
      }
    } else {
      const type = sourceTypeFor(detected) ?? "nodes";
      const source = make(type, detected.content);
      if (detected.kind === "unknown") newFlags[source.id] = "ambiguous";
      created.push(source);
    }
    // Empty placeholder sources from the old editor are dropped here.
    setSources([...sources.filter((source) => source.content.trim()), ...created]);
    setFlags((prev) => ({ ...prev, ...newFlags }));
    setDraft("");
    for (const source of created) if (!newFlags[source.id]) parse(source.id);
  };

  const update = (id: string, patch: Partial<SubscriptionSource>, reparse: boolean) => {
    const next = sources.map((source) => (source.id === id ? markSourceAsPendingImport({ ...source, ...patch }) : source));
    setSources(next);
    if (reparse && next.find((source) => source.id === id)?.content.trim()) parse(id);
  };

  const move = (id: string, direction: -1 | 1) => {
    const order = [...visible];
    const index = order.findIndex((source) => source.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    setSources(order);
  };

  return (
    <div className="es-sources">
      {visible.map((source, index) => (
        <SourceCard
          key={source.id}
          source={source}
          index={index}
          total={visible.length}
          flag={flags[source.id]}
          onUpdate={(patch, reparse) => update(source.id, patch, reparse)}
          onRemove={() => setSources(sources.filter((item) => item.id !== source.id))}
          onMove={(direction) => move(source.id, direction)}
          onFlag={(flag) => setFlag(source.id, flag)}
          onParse={() => parse(source.id)}
        />
      ))}
      <div className="es-src es-src-new">
        <div className="es-src-top">
          <Plus className="es-src-ic" />
          <b>添加来源</b>
          <span className="es-sp" />
          <span className="es-src-tip es-only-d">粘贴后自动识别类型，并在下方自动留出新的空白框</span>
        </div>
        <textarea
          className="es-src-body es-mono"
          rows={3}
          value={draft}
          spellCheck={false}
          placeholder={"粘贴订阅链接、Clash YAML 或节点链接（vless:// trojan:// ss:// …）\n也可以把 .yaml 文件拖到这里"}
          aria-label="添加订阅来源"
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (!text.trim()) return;
            event.preventDefault();
            addFromText(`${draft}${text}`);
          }}
          onBlur={() => draft.trim() && addFromText(draft)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            const file = event.dataTransfer.files?.[0];
            if (!file) return;
            event.preventDefault();
            void file.text().then(addFromText);
          }}
        />
      </div>
    </div>
  );
}
