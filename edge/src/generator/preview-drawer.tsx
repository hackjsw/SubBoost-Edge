"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Copy, Download, Search, X } from "lucide-react";
import { toast } from "@subboost/ui/components/ui/toaster";
import { copyText } from "@edge/dashboard/browser";
import { groupTypeLabel, type ConfigModel, type GroupModel } from "./config-model";
import { moveName } from "./group-order";

export type PreviewTab = "graph" | "yaml";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: PreviewTab;
  onTabChange: (tab: PreviewTab) => void;
  title: string;
  yaml: string;
  model: ConfigModel | null;
  onDownload: () => void;
  /** Persists a new proxy-group order; omitted when the order cannot be changed. */
  onReorder?: (names: string[]) => void;
  reorderNote?: string;
};

const SECRET_KEYS = /^(\s*-?\s*)(password|passwd|uuid|private-key|pre-shared-key|psk|auth|auth-str|token|obfs-password|public-key|short-id)(\s*:\s*)(.+)$/i;
const SECTIONS = ["proxies", "proxy-groups", "rule-providers", "rules"] as const;

function GraphView({ model, onReorder, reorderNote }: { model: ConfigModel; onReorder?: (names: string[]) => void; reorderNote?: string }) {
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{ name: string; position: "before" | "after" } | null>(null);
  const positionOf = (event: React.DragEvent<HTMLElement>): "before" | "after" => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY >= rect.top + rect.height / 2 ? "after" : "before";
  };
  // Start on a group that rules actually point at, so the flow is visible.
  const [selected, setSelected] = React.useState(
    () => (model.groups.find((item) => item.ruleCount > 0) ?? model.groups[0])?.name ?? ""
  );
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [paths, setPaths] = React.useState<string[]>([]);
  const group: GroupModel | undefined = model.groups.find((item) => item.name === selected) ?? model.groups[0];
  const exitIds = new Set([
    ...(group?.regions.map((region) => `x-${region.id}`) ?? []),
    ...(group?.builtins.map((name) => `x-${name}`) ?? []),
  ]);
  const exits = [
    ...model.regions.map((region) => ({ id: `x-${region.id}`, label: region.label, count: region.count })),
    { id: "x-DIRECT", label: "DIRECT 直连", count: null },
    { id: "x-REJECT", label: "REJECT 拒绝", count: null },
  ];
  const rules = group?.rules ?? [];
  const shownRules = rules.slice(0, 12);

  // Connectors follow the rendered boxes so they stay right at any width.
  React.useLayoutEffect(() => {
    const root = containerRef.current;
    if (!root || !group) return;
    const box = root.getBoundingClientRect();
    const center = (el: Element | null, side: "left" | "right") => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { x: (side === "left" ? rect.left : rect.right) - box.left, y: rect.top + rect.height / 2 - box.top };
    };
    const curve = (a: { x: number; y: number } | null, b: { x: number; y: number } | null) =>
      a && b ? `M${a.x},${a.y} C${(a.x + b.x) / 2},${a.y} ${(a.x + b.x) / 2},${b.y} ${b.x},${b.y}` : null;
    const groupEl = root.querySelector(`[data-group="${CSS.escape(group.name)}"]`);
    const next: string[] = [];
    shownRules.forEach((_, index) => {
      const path = curve(center(root.querySelector(`[data-rule="${index}"]`), "right"), center(groupEl, "left"));
      if (path) next.push(path);
    });
    for (const id of exitIds) {
      const path = curve(center(groupEl, "right"), center(root.querySelector(`[data-exit="${id}"]`), "left"));
      if (path) next.push(path);
    }
    setPaths(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, model]);

  if (!group) return <p className="es-drawer-empty">配置中没有代理组。</p>;

  return (
    <>
      <p className="es-graph-hint">
        点选代理组查看流量去向{onReorder ? " · 拖动代理组可调整在客户端里的显示顺序" : reorderNote ? ` · ${reorderNote}` : ""}
      </p>
      <div className="es-graph" ref={containerRef}>
        <svg className="es-graph-links" aria-hidden="true">
          {paths.map((d, index) => (
            <path key={index} d={d} />
          ))}
        </svg>
        <div className="es-gcol">
          <h4>
            规则<span className="es-mono">{group.ruleCount} 条</span>
          </h4>
          {shownRules.length ? (
            shownRules.map((rule, index) => (
              <div key={rule.label} className="es-gn hl" data-rule={index}>
                <span className="es-gn-label">{rule.label}</span>
                <span className="es-gn-c es-mono">{rule.count}</span>
              </div>
            ))
          ) : (
            <p className="es-gcol-empty">没有规则直接指向这个组，它被其他代理组引用。</p>
          )}
          {rules.length > shownRules.length && <p className="es-gcol-empty">还有 {rules.length - shownRules.length} 类规则</p>}
        </div>
        <div className="es-gcol">
          <h4>
            代理组<span className="es-mono">{model.groupCount} 个</span>
          </h4>
          {model.groups.map((item) => (
            <button
              key={item.name}
              type="button"
              data-group={item.name}
              className={`es-gn${item.name === group.name ? " sel" : group.groups.includes(item.name) ? " hl" : ""}${
                dragging === item.name ? " dragging" : ""
              }${dropTarget?.name === item.name ? ` drop-${dropTarget.position}` : ""}`}
              onClick={() => setSelected(item.name)}
              draggable={Boolean(onReorder)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", item.name);
                setDragging(item.name);
              }}
              onDragOver={(event) => {
                if (!onReorder || !dragging || dragging === item.name) return;
                event.preventDefault();
                const position = positionOf(event);
                if (dropTarget?.name !== item.name || dropTarget.position !== position) setDropTarget({ name: item.name, position });
              }}
              onDragLeave={() => dropTarget?.name === item.name && setDropTarget(null)}
              onDrop={(event) => {
                event.preventDefault();
                if (onReorder && dragging) {
                  onReorder(moveName(model.groups.map((entry) => entry.name), dragging, item.name, positionOf(event)));
                }
                setDragging(null);
                setDropTarget(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropTarget(null);
              }}
            >
              <span className="es-gn-label">{item.name}</span>
              <span className="es-gn-t">{groupTypeLabel(item.type)}</span>
            </button>
          ))}
        </div>
        <div className="es-gcol">
          <h4>
            出口<span className="es-mono">{model.nodeCount} 个节点</span>
          </h4>
          {exits.map((exit) => (
            <div key={exit.id} data-exit={exit.id} className={`es-gn${exitIds.has(exit.id) ? " hl" : " dim"}`}>
              <span className="es-gn-label">{exit.label}</span>
              {exit.count !== null && <span className="es-gn-c es-mono">{exit.count}</span>}
            </div>
          ))}
        </div>
      </div>
      <div className="es-graph-detail">
        <div>
          <span>已选代理组</span>
          <b>{group.name}</b>
        </div>
        <div>
          <span>类型</span>
          <b>{groupTypeLabel(group.type)}</b>
        </div>
        <div>
          <span>可选节点</span>
          <b className="es-mono">{group.nodes.length} 个</b>
        </div>
        <div>
          <span>规则</span>
          <b className="es-mono">{group.ruleCount} 条</b>
        </div>
        <p>
          {group.groups.length > 0 && (
            <>
              可切换到代理组：<b>{group.groups.join("、")}</b>。{" "}
            </>
          )}
          {group.regions.length > 0 && <>节点分布：{group.regions.map((region) => `${region.label} ${region.count}`).join("、")}。</>}
          {group.builtins.length > 0 && <> 内置出口：{group.builtins.join("、")}。</>}
        </p>
      </div>
    </>
  );
}

function YamlView({ yaml }: { yaml: string }) {
  const [mask, setMask] = React.useState(true);
  const [query, setQuery] = React.useState("");
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const lines = React.useMemo(() => yaml.split("\n"), [yaml]);
  const sectionLines = React.useMemo(() => {
    const found: Partial<Record<(typeof SECTIONS)[number], number>> = {};
    lines.forEach((line, index) => {
      const key = line.match(/^([a-z-]+):/)?.[1] as (typeof SECTIONS)[number] | undefined;
      if (key && (SECTIONS as readonly string[]).includes(key) && found[key] === undefined) found[key] = index;
    });
    return found;
  }, [lines]);
  const needle = query.trim().toLowerCase();
  const hits = needle ? lines.reduce((count, line) => count + (line.toLowerCase().includes(needle) ? 1 : 0), 0) : 0;

  const jump = (index: number | undefined) => {
    if (index === undefined) return;
    bodyRef.current?.querySelector(`[data-line="${index}"]`)?.scrollIntoView({ block: "start" });
  };

  const renderLine = (line: string) => {
    const secret = mask ? line.match(SECRET_KEYS) : null;
    if (secret) {
      return (
        <>
          {secret[1]}
          <span className="k">{secret[2]}</span>
          {secret[3]}
          <span className="mask">•••••••• 已隐藏</span>
        </>
      );
    }
    const keyMatch = line.match(/^(\s*-?\s*)([A-Za-z0-9_.-]+)(\s*:)(.*)$/);
    const highlight = (text: string) => {
      if (!needle) return text;
      const index = text.toLowerCase().indexOf(needle);
      if (index < 0) return text;
      return (
        <>
          {text.slice(0, index)}
          <mark>{text.slice(index, index + needle.length)}</mark>
          {text.slice(index + needle.length)}
        </>
      );
    };
    if (!keyMatch) return highlight(line);
    return (
      <>
        {keyMatch[1]}
        <span className="k">{keyMatch[2]}</span>
        {keyMatch[3]}
        <span className="s">{highlight(keyMatch[4])}</span>
      </>
    );
  };

  return (
    <>
      <div className="es-drawer-bar">
        <div className="es-jump">
          {SECTIONS.map((section) => (
            <button key={section} type="button" disabled={sectionLines[section] === undefined} onClick={() => jump(sectionLines[section])}>
              {section}
            </button>
          ))}
        </div>
        <span className="es-sp" />
        <label className="es-search">
          <Search />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" aria-label="搜索 YAML" />
          {needle && <span className="es-mono es-search-n">{hits} 处</span>}
        </label>
      </div>
      <div className="es-drawer-bar plain">
        <label className="es-toggle-line">
          <input type="checkbox" checked={mask} onChange={(event) => setMask(event.target.checked)} />
          <span className={`es-switch sm${mask ? " on" : ""}`} aria-hidden="true" />
          隐藏密码、UUID 等敏感信息
        </label>
        <span className="es-sp" />
        <span className="es-drawer-note">只读预览；复制和下载得到的是完整配置</span>
      </div>
      <div className="es-code es-mono" ref={bodyRef}>
        {lines.map((line, index) => (
          <div key={index} data-line={index}>
            <span className="ln" aria-hidden="true">
              {index + 1}
            </span>
            {renderLine(line)}
          </div>
        ))}
      </div>
    </>
  );
}

export function PreviewDrawer({ open, onOpenChange, tab, onTabChange, title, yaml, model, onDownload, onReorder, reorderNote }: Props) {
  const copyYaml = async () => {
    const ok = await copyText(yaml);
    toast(ok ? { title: "已复制完整 YAML", variant: "success" } : { title: "复制失败，请改用下载", variant: "destructive" });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="es-scrim" />
        <Dialog.Content className="es-drawer" aria-describedby={undefined}>
          <div className="es-drawer-h">
            <div>
              <Dialog.Title asChild>
                <h2>配置预览</h2>
              </Dialog.Title>
              <p>
                {title}
                {model ? ` · ${model.nodeCount} 节点 · ${model.groupCount} 代理组 · ${model.ruleCount.toLocaleString("zh-CN")} 规则` : ""}
              </p>
            </div>
            <span className="es-sp" />
            <div className="es-seg" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "graph"} onClick={() => onTabChange("graph")}>
                关系图
              </button>
              <button type="button" role="tab" aria-selected={tab === "yaml"} onClick={() => onTabChange("yaml")}>
                YAML
              </button>
            </div>
            <Dialog.Close className="es-btn ghost icon" aria-label="关闭">
              <X />
            </Dialog.Close>
          </div>
          <div className="es-drawer-body">
            {!yaml ? (
              <p className="es-drawer-empty">还没有生成配置，先在左侧添加订阅来源。</p>
            ) : tab === "graph" ? (
              model ? <GraphView model={model} onReorder={onReorder} reorderNote={reorderNote} /> : <p className="es-drawer-empty">配置暂时无法解析为关系图，可切换到 YAML 查看。</p>
            ) : (
              <YamlView yaml={yaml} />
            )}
          </div>
          <div className="es-drawer-foot">
            <button type="button" className="es-btn" onClick={() => void copyYaml()} disabled={!yaml}>
              <Copy />
              复制 YAML
            </button>
            <button type="button" className="es-btn" onClick={onDownload} disabled={!yaml}>
              <Download />
              下载 Clash
            </button>
            <span className="es-sp" />
            <span className="es-drawer-note">需要修改时，在“自定义”里调整，预览会同步更新</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
