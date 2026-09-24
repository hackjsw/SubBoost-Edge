const BUILTIN_TARGETS = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", "GLOBAL"]);

export function validateProxyReferences(config: Record<string, unknown>): void {
  const proxies = config.proxies ?? [];
  const groups = config["proxy-groups"] ?? [];
  if (!Array.isArray(proxies) || !Array.isArray(groups)) throw new Error("proxies 和 proxy-groups 必须是数组");
  const graph = new Map<string, string[]>();
  const providers = config["proxy-providers"];
  if (providers !== undefined && (!providers || typeof providers !== "object" || Array.isArray(providers))) throw new Error("proxy-providers 必须是对象");
  const providerNames = new Set(providers && typeof providers === "object" ? Object.keys(providers) : []);
  for (const item of [...proxies, ...groups]) {
    if (!item || typeof item !== "object" || typeof item.name !== "string" || !item.name.trim()) {
      throw new Error("节点和代理组必须具有有效名称");
    }
    if (graph.has(item.name) || BUILTIN_TARGETS.has(item.name)) throw new Error(`节点或代理组名称冲突：${item.name}`);
    const refs: unknown[] = [];
    if (item["dialer-proxy"] !== undefined) refs.push(item["dialer-proxy"]);
    if (item.proxies !== undefined) {
      if (!Array.isArray(item.proxies)) throw new Error(`代理组 ${item.name} 的 proxies 必须是数组`);
      refs.push(...item.proxies);
    }
    if (item.use !== undefined && (!Array.isArray(item.use) || item.use.some((name: unknown) => typeof name !== "string" || !providerNames.has(name)))) {
      throw new Error(`代理组 ${item.name} 引用了不存在的节点提供者`);
    }
    if (refs.some(ref => typeof ref !== "string")) throw new Error(`代理引用必须是名称：${item.name}`);
    graph.set(item.name, refs as string[]);
  }
  for (const [name, refs] of graph) {
    for (const ref of refs) {
      if (!ref.trim()) throw new Error(`${name} 包含空的代理引用`);
      if (!BUILTIN_TARGETS.has(ref) && !graph.has(ref)) throw new Error(`${name} 引用了不存在的代理：${ref}`);
    }
  }
  if (config.listeners !== undefined) {
    if (!Array.isArray(config.listeners)) throw new Error("listeners 必须是数组");
    for (const listener of config.listeners) {
      if (!listener || typeof listener !== "object" || Array.isArray(listener)) throw new Error("listeners 项必须是对象");
      if (listener.proxy !== undefined && (typeof listener.proxy !== "string" || !listener.proxy.trim())) throw new Error("监听端口的代理引用必须是名称");
      if (listener.proxy !== undefined && !graph.has(listener.proxy) && !BUILTIN_TARGETS.has(listener.proxy)) {
        throw new Error(`监听端口引用了不存在的代理：${listener.proxy}`);
      }
    }
  }
  // Iterative DFS also handles deeply nested groups without exhausting the stack.
  const done = new Set<string>();
  const active = new Set<string>();
  for (const name of graph.keys()) {
    if (done.has(name)) continue;
    const stack = [{ name, next: 0 }];
    active.add(name);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const refs = graph.get(frame.name)!;
      if (frame.next === refs.length) {
        active.delete(frame.name);
        done.add(frame.name);
        stack.pop();
        continue;
      }
      const ref = refs[frame.next++];
      if (active.has(ref)) throw new Error(`代理依赖存在循环：${stack.slice(-12).map(item => item.name).join(" → ")} → ${ref}`);
      if (done.has(ref) || !graph.has(ref)) continue;
      active.add(ref);
      stack.push({ name: ref, next: 0 });
    }
  }
}
