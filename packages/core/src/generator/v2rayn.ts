import { load } from "js-yaml";
import { encodeBase64 } from "../parser/base64";

type RecordValue = Record<string, unknown>;

export type V2rayNExport = {
  content: string;
  nodeCount: number;
  skippedNodes: Array<{ name: string; type: string; reason: string }>;
  providerCount: number;
};

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function required(node: RecordValue, key: string): string {
  const value = text(node[key]);
  if (!value) throw new Error(`缺少 ${key}`);
  return value;
}

function list(value: unknown): string {
  return Array.isArray(value) ? value.map(text).filter(Boolean).join(",") : text(value);
}

function set(query: URLSearchParams, key: string, value: unknown): void {
  const normalized = text(value);
  if (normalized) query.set(key, normalized);
}

function endpoint(node: RecordValue): { server: string; authority: string } {
  const server = required(node, "server").replace(/^\[|\]$/g, "");
  const port = Number(node.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || /[\s/@?#\\%]/.test(server)) {
    throw new Error("无效的服务器地址或端口");
  }
  const host = server.includes(":") ? `[${server}]` : server;
  const parsed = new URL(`https://${host}:${port}`);
  return { server, authority: `${parsed.hostname}:${port}` };
}

function tlsQuery(node: RecordValue, query: URLSearchParams): void {
  const reality = record(node["reality-opts"]);
  query.set("security", Object.keys(reality).length ? "reality" : node.tls === true ||
    ["trojan", "hysteria2", "tuic", "anytls"].includes(text(node.type)) ? "tls" : "none");
  set(query, "sni", node.servername || node.sni);
  set(query, "alpn", list(node.alpn));
  set(query, "fp", node["client-fingerprint"]);
  set(query, "pbk", reality["public-key"]);
  set(query, "sid", reality["short-id"]);
  set(query, "spx", reality["_spider-x"]);
  set(query, "pqv", node.pqv);
  if (node["skip-cert-verify"] === true) {
    query.set("allowInsecure", "1");
    query.set("insecure", "1");
  }
  const ech = record(node["ech-opts"]);
  if (ech.enable === true) {
    if (!text(ech.config)) throw new Error("ECH 自动查询无法转换为 v2rayN 分享链接");
    query.set("ech", text(ech.config));
  }
  if (node["certificate"] || node["private-key"]) {
    throw new Error("分享链接无法保留自定义证书或私钥");
  }
}

function transportQuery(node: RecordValue, query: URLSearchParams): void {
  const network = text(node.network) || "tcp";
  if (!["tcp", "ws", "grpc", "http", "xhttp"].includes(network)) {
    throw new Error(`无法转换 ${network} 传输层`);
  }
  query.set("type", network === "http" ? "tcp" : network);
  if (network === "tcp") return;

  const opts = record(node[`${network}-opts`]);
  const headers = record(opts.headers);
  if (network !== "xhttp" && Object.keys(headers).some(key => key.toLowerCase() !== "host")) {
    throw new Error("分享链接无法保留自定义传输请求头");
  }
  if (network === "ws") {
    if (opts["v2ray-http-upgrade"] === true) query.set("type", "httpupgrade");
    let path = text(opts.path) || "/";
    const earlyData = Number(opts["max-early-data"]);
    if (earlyData > 0) {
      const header = text(opts["early-data-header-name"]);
      if (header && header.toLowerCase() !== "sec-websocket-protocol") {
        throw new Error("无法转换自定义 WebSocket early-data 请求头");
      }
      path += `${path.includes("?") ? "&" : "?"}ed=${earlyData}`;
    }
    query.set("path", path);
    set(query, "host", headers.Host || headers.host);
  } else if (network === "grpc") {
    set(query, "serviceName", opts["grpc-service-name"]);
    set(query, "authority", opts["_grpcAuthority"] || opts.authority);
    set(query, "mode", opts["_grpcType"] || opts.mode);
  } else if (network === "http") {
    if (opts.method && opts.method !== "GET") throw new Error("无法转换非 GET 的 HTTP 伪装");
    query.set("headerType", "http");
    set(query, "host", list(headers.Host || headers.host));
    set(query, "path", list(opts.path));
  } else {
    set(query, "path", opts.path || "/");
    set(query, "host", opts.host);
    set(query, "mode", opts.mode);
    // Xray's XHTTP extra uses camelCase; do not silently discard advanced
    // Mihomo settings whose download/reuse semantics cannot be represented.
    if (Object.keys(record(opts["download-settings"])).length || Object.keys(record(opts["reuse-settings"])).length) {
      throw new Error("XHTTP download/reuse 设置暂不支持转换");
    }
    const extra: RecordValue = {};
    if (Object.keys(headers).length) extra.headers = headers;
    for (const [source, target] of [
      ["no-grpc-header", "noGRPCHeader"],
      ["x-padding-bytes", "xPaddingBytes"],
      ["sc-max-each-post-bytes", "scMaxEachPostBytes"],
    ]) {
      if (opts[source] !== undefined) extra[target] = opts[source];
    }
    if (Object.keys(extra).length) query.set("extra", JSON.stringify(extra));
  }
}

function ssPlugin(node: RecordValue, query: URLSearchParams): void {
  if (!node.plugin) return;
  const opts = record(node["plugin-opts"]);
  const plugin = text(node.plugin);
  const parts: string[] = [];
  if (["obfs", "obfs-local", "simple-obfs"].includes(plugin)) {
    if (opts.mode !== "http" || !text(opts.host)) throw new Error("v2rayN 不支持此 SS 混淆配置");
    parts.push("obfs-local", "obfs=http", `obfs-host=${text(opts.host)}`);
  } else if (plugin === "v2ray-plugin") {
    if ((opts.mode && opts.mode !== "websocket") || opts.mux === true) {
      throw new Error("v2rayN 不支持此 SS 插件模式");
    }
    parts.push("v2ray-plugin", "mode=websocket", "mux=0");
    if (opts.tls === true) parts.push("tls");
    if (opts.host) parts.push(`host=${text(opts.host)}`);
    if (opts.path) parts.push(`path=${text(opts.path).replace(/([\\=,])/g, "\\$1")}`);
  } else {
    throw new Error("v2rayN 不支持此 SS 插件");
  }
  if (Object.values(opts).some(value => typeof value === "string" && value.includes(";"))) {
    throw new Error("SS 插件参数含无法保留的分隔符");
  }
  query.set("plugin", parts.join(";"));
}

function nodeLink(node: RecordValue): string {
  const type = text(node.type);
  if (!["ss", "vmess", "vless", "trojan", "hysteria2", "tuic", "anytls"].includes(type)) {
    throw new Error("暂不支持此协议的 v2rayN 导出");
  }
  if (node["dialer-proxy"] && node["dialer-proxy"] !== "DIRECT") {
    throw new Error("节点依赖链式代理，无法单独导出");
  }
  const { server, authority } = endpoint(node);
  const query = new URLSearchParams();
  const name = text(node.name) || `${type}-${server}`;
  let credentials: string;

  if (type === "ss") {
    credentials = encodeBase64(`${required(node, "cipher")}:${required(node, "password")}`)
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    ssPlugin(node, query);
  } else {
    tlsQuery(node, query);
    if (["vmess", "vless", "trojan"].includes(type)) transportQuery(node, query);
    if (type === "vmess") {
      if (query.has("ech") || query.has("extra") || query.get("security") === "reality") {
        throw new Error("VMess 分享格式无法保留 ECH、REALITY 或 XHTTP extra");
      }
      return `vmess://${encodeBase64(JSON.stringify({
        v: "2", ps: name, add: server, port: String(node.port), id: required(node, "uuid"),
        aid: text(node.alterId) || "0", scy: text(node.cipher) || "auto",
        net: query.get("type"),
        type: query.get("headerType") || query.get("mode") || "none",
        host: query.get("host") || query.get("authority") || "",
        path: query.get("path") || query.get("serviceName") || "",
        tls: node.tls === true ? "tls" : "", sni: query.get("sni") || "",
        alpn: query.get("alpn") || "", fp: query.get("fp") || "",
        insecure: node["skip-cert-verify"] === true ? "1" : "0",
      }))}`;
    }
    if (type === "vless") {
      credentials = encodeURIComponent(required(node, "uuid"));
      query.set("encryption", text(node.encryption) || "none");
      set(query, "flow", node.flow);
    } else if (type === "tuic") {
      if (node.token) throw new Error("v2rayN 分享链接仅支持 TUIC v5");
      if (node["disable-sni"] === true) throw new Error("分享链接无法保留 TUIC disable-sni");
      credentials = `${encodeURIComponent(required(node, "uuid"))}:${encodeURIComponent(required(node, "password"))}`;
      set(query, "congestion_control", node["congestion-controller"]);
      if (node["skip-cert-verify"] === true) query.set("allow_insecure", "1");
    } else {
      credentials = encodeURIComponent(required(node, "password"));
      if (type === "hysteria2") {
        if (node.obfs && node.obfs !== "salamander") throw new Error("无法转换此 Hysteria2 混淆模式");
        set(query, "obfs", node.obfs);
        if (node.obfs) query.set("obfs-password", required(node, "obfs-password"));
        set(query, "mport", text(node.ports).replace(/:/g, "-"));
        set(query, "pinSHA256", node.fingerprint);
      }
    }
  }

  const suffix = query.toString();
  return `${type}://${credentials}@${authority}${suffix ? `?${suffix}` : ""}#${encodeURIComponent(name)}`;
}

// Export the generated snapshot, so deletions, renames and node ordering agree
// with the Clash download. This never fetches provider URLs or mutates YAML.
export function generateV2rayNSubscription(yaml: string): V2rayNExport {
  let config: RecordValue;
  try {
    config = record(load(yaml));
  } catch {
    throw new Error("无法导出 v2rayN：配置不是有效的 YAML。");
  }
  const providerCount = Object.keys(record(config["proxy-providers"])).length;
  const proxies = Array.isArray(config.proxies) ? config.proxies : [];
  const links: string[] = [];
  const skippedNodes: V2rayNExport["skippedNodes"] = [];
  for (const value of proxies) {
    const node = record(value);
    try {
      links.push(nodeLink(node));
    } catch (error) {
      skippedNodes.push({
        name: text(node.name), type: text(node.type),
        reason: error instanceof Error ? error.message : "无法转换此节点",
      });
    }
  }
  if (!links.length) {
    throw new Error(providerCount > 0
      ? "没有可导出的 v2rayN 节点。请将远程节点提供者改为直接导入节点后重试。"
      : "没有可导出的 v2rayN 节点。请检查协议、传输参数或链式代理设置。");
  }
  return { content: encodeBase64(links.join("\n")), nodeCount: links.length, skippedNodes, providerCount };
}
