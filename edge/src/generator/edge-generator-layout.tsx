"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Download, Eye, FileText, Layers, Link2, Loader2, Pencil, X } from "lucide-react";
import type { SubscriptionFormat } from "@subboost/core/subscription/output-format";
import { autoUpdateIntervalHoursToSeconds } from "@subboost/core/subscription/auto-update-interval";
import { resolveNodeNameFilter } from "@subboost/core/subscription/node-name-filter";
import { confirmDialog } from "@subboost/ui/components/ui/confirm-dialog";
import { toast } from "@subboost/ui/components/ui/toaster";
import { useConfigStore } from "@subboost/ui/store/config-store";
import { isSourcePendingImport } from "@subboost/ui/product/subscription/source-import-state";
import type { HomeLayoutProps } from "@subboost/ui/product/home/home-layout";
import { LinkDialog } from "@edge/dashboard/link-dialog";
import { intervalLabel } from "@edge/dashboard/format";
import { buildConfigModel } from "./config-model";
import { proxyGroupOrderKeys } from "./group-order";
import { PreviewDrawer, type PreviewTab } from "./preview-drawer";
import { RuleScheme } from "./rule-scheme";
import { SourceList } from "./source-list";

const INTERVAL_OPTIONS = [6, 12, 24, 48, 72, 168];

function defaultName(sourceName: string | undefined): string {
  if (sourceName?.trim()) return sourceName.trim().slice(0, 100);
  const now = new Date();
  return `我的订阅 ${now.getMonth() + 1}-${now.getDate()}`;
}

function SaveFields({ layout }: { layout: HomeLayoutProps }) {
  const { subscription } = layout;
  const hours = subscription.autoUpdateEnabled ? subscription.autoUpdateHours : 0;
  const options = INTERVAL_OPTIONS.includes(hours) || hours === 0 ? INTERVAL_OPTIONS : [...INTERVAL_OPTIONS, hours].sort((a, b) => a - b);
  return (
    <div className="es-fields">
      <label>
        <span>订阅名称</span>
        <input
          className="es-input"
          value={subscription.subscriptionName}
          maxLength={100}
          onChange={(event) => subscription.setSubscriptionName(event.target.value)}
        />
      </label>
      <label>
        <span>自动更新</span>
        <select
          className="es-input"
          value={hours}
          onChange={(event) => {
            const value = Number(event.target.value);
            subscription.setAutoUpdateEnabled(value > 0);
            if (value > 0) subscription.setAutoUpdateHours(value);
          }}
        >
          <option value={0}>关闭（手动更新）</option>
          {options.map((value) => (
            <option key={value} value={value}>
              {intervalLabel(autoUpdateIntervalHoursToSeconds(value))}
            </option>
          ))}
        </select>
      </label>
      <p className="es-help">自动更新每 6 小时批量执行一次，按间隔对齐到最近一次执行；失败时继续提供上次成功的配置。</p>
    </div>
  );
}

export function EdgeGeneratorLayout(layout: HomeLayoutProps) {
  const {
    authChecked,
    user,
    editingSubscription,
    isLoadingEditingSubscription,
    generatedYaml,
    generatedYamlError,
    handleDownload,
    subscription,
  } = layout;
  const nodes = useConfigStore((state) => state.nodes);
  const sources = useConfigStore((state) => state.sources);
  const generateConfig = useConfigStore((state) => state.generateConfig);
  const parseSingleSource = useConfigStore((state) => state.parseSingleSource);

  const [drawer, setDrawer] = React.useState<{ open: boolean; tab: PreviewTab }>({ open: false, tab: "graph" });
  const [linkOpen, setLinkOpen] = React.useState(false);
  const [fieldsOpen, setFieldsOpen] = React.useState(false);
  const [saveQueued, setSaveQueued] = React.useState(false);
  const [preparing, setPreparing] = React.useState(false);
  const nameTouched = React.useRef(false);
  const editing = subscription.isEditingExistingSubscription && editingSubscription;

  const model = React.useMemo(() => buildConfigModel(generatedYaml), [generatedYaml]);
  const firstSourceName = sources.find((source) => source.content.trim() && source.name)?.name;

  // Parsing a source does not regenerate by itself; keep the preview and save in sync.
  React.useEffect(() => {
    if (nodes.length > 0) generateConfig();
  }, [nodes, generateConfig]);

  // The save form lives on the page instead of a dialog, so seed it like the dialog did.
  React.useEffect(() => {
    if (editing) {
      nameTouched.current = true;
      subscription.setSubscriptionName(editingSubscription.name);
      const interval = editingSubscription.autoUpdateInterval;
      subscription.setAutoUpdateEnabled(Boolean(interval));
      if (interval) subscription.setAutoUpdateHours(Math.max(6, Math.round(interval / 3600)));
      subscription.setSmartNodeMatchingEnabled(editingSubscription.smartNodeMatchingEnabled !== false);
    } else {
      nameTouched.current = false;
      subscription.setAutoUpdateEnabled(true);
      subscription.setAutoUpdateHours(subscription.autoUpdatePolicy.defaultHours);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingSubscription?.id]);

  React.useEffect(() => {
    if (!editing && !nameTouched.current) subscription.setSubscriptionName(defaultName(firstSourceName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstSourceName, editing]);

  // Saving reads YAML from props, so wait for the re-render after a regeneration.
  // Show the link after every successful save: when editing, the URL never changes.
  React.useEffect(() => {
    if (!saveQueued || generatedYaml !== useConfigStore.getState().generatedYaml) return;
    setSaveQueued(false);
    void subscription.handleCreateSubscription().then((saved) => {
      if (saved) setLinkOpen(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveQueued, generatedYaml]);

  const save = async () => {
    if (!authChecked || !user) {
      subscription.handleGenerateSubscription("quick");
      return;
    }
    if (!subscription.subscriptionName.trim()) {
      toast({ title: "请填写订阅名称", variant: "warning" });
      setFieldsOpen(true);
      return;
    }
    setPreparing(true);
    try {
      for (const source of useConfigStore.getState().sources) {
        if (source.content.trim() && isSourcePendingImport(source)) await parseSingleSource(source.id);
      }
      generateConfig();
      const state = useConfigStore.getState();
      if (state.generatedYamlError) {
        toast({ title: "配置有错误，无法保存", description: state.generatedYamlError, variant: "destructive" });
        return;
      }
      const usesProviders = state.sources.some((source) => source.useProxyProviders);
      if (!state.nodes.length && !usesProviders) {
        toast({ title: "还没有可用节点", description: "请先在左侧添加订阅来源。", variant: "warning" });
        return;
      }
      if (!usesProviders && resolveNodeNameFilter(state.nodes, state.nodeNameFilter).effectiveCount === 0) {
        toast({ title: "所有节点都被排除了", description: "请在“节点管理 → 自动处理”中调整规则。", variant: "warning" });
        return;
      }
      setSaveQueued(true);
    } finally {
      setPreparing(false);
    }
  };

  const exitEditing = async () => {
    const ok = await confirmDialog({
      title: "退出编辑？",
      description: "未保存的修改将会丢失，原订阅不受影响。",
      confirmText: "退出编辑",
    });
    if (ok) window.location.href = "/?newSubscription=1";
  };

  const download = (format: SubscriptionFormat) => handleDownload("quick", format);
  const nativeProfileId = subscription.conversionProfiles.find((profile) => !profile.configUrl)?.id;
  const usingRemoteProfile = Boolean(nativeProfileId && subscription.conversionProfileId !== nativeProfileId);
  const reorderGroups = (names: string[]) => {
    const state = useConfigStore.getState();
    state.setProxyGroupOrder(proxyGroupOrderKeys(names, state));
  };
  const busy = preparing || saveQueued || subscription.isCreatingSubscription;
  const saveLabel = editing ? "保存修改" : "保存并获取订阅链接";
  const nodeCount = model?.nodeCount ?? nodes.length;
  const openPreview = (tab: PreviewTab) => setDrawer({ open: true, tab });

  return (
    <div className="es-page es-gen-page">
      <div className="es-ph">
        <div>
          <h1>{editing ? "编辑订阅" : "新建订阅"}</h1>
          <p>
            {editing ? (
              <>
                正在编辑「{editingSubscription.name}」，保存后原订阅链接保持不变 ·{" "}
                <button type="button" className="es-link" onClick={() => void exitEditing()}>
                  退出编辑
                </button>
              </>
            ) : (
              "导入节点 → 选择规则 → 保存得到订阅链接"
            )}
          </p>
        </div>
      </div>

      {isLoadingEditingSubscription && (
        <div className="es-card es-loading-bar">
          <Loader2 className="es-spin" />
          正在加载订阅…
        </div>
      )}

      <div className="es-gen">
        <section className="es-card">
          <div className="es-step">
            <div className="es-sh">
              <span className={`es-n${nodeCount ? " done" : ""}`}>{nodeCount ? <Check /> : 1}</span>
              <h3>订阅来源</h3>
              <span className="es-aux es-mono">
                {sources.filter((source) => source.content.trim()).length} 个来源 · 共 {nodeCount} 个节点
              </span>
            </div>
            <SourceList />
          </div>
          <div className="es-step">
            <div className="es-sh">
              <span className="es-n">2</span>
              <h3>规则方案</h3>
              <span className="es-aux es-only-d">选一个模板即可，需要时再自定义</span>
            </div>
            <RuleScheme
              conversionProfiles={subscription.conversionProfiles}
              conversionProfileId={subscription.conversionProfileId}
              setConversionProfileId={subscription.setConversionProfileId}
            />
          </div>
        </section>

        <aside className="es-card es-rail es-only-d">
          <div className="es-rail-sec">
            <div className="es-sh">
              <span className="es-n">3</span>
              <h3>保存</h3>
              <span className="es-aux">随时可保存</span>
            </div>
            <div className="es-mini">
              <div>
                <b className="es-mono">{nodeCount}</b>
                <span>节点</span>
              </div>
              <div>
                <b className="es-mono">{model?.groupCount ?? 0}</b>
                <span>代理组</span>
              </div>
              <div>
                <b className="es-mono">{(model?.ruleCount ?? 0).toLocaleString("zh-CN")}</b>
                <span>规则</span>
              </div>
            </div>
            {model && model.regions.length > 0 && (
              <div className="es-regions">
                {model.regions.slice(0, 6).map((region) => (
                  <span key={region.id}>
                    {region.label}
                    <b className="es-mono">{region.count}</b>
                  </span>
                ))}
              </div>
            )}
            {generatedYamlError && <p className="es-rail-err">{generatedYamlError}</p>}
            <div className="es-views">
              <button type="button" onClick={() => openPreview("yaml")} disabled={!generatedYaml}>
                <FileText />
                查看 YAML
              </button>
              <button type="button" onClick={() => openPreview("graph")} disabled={!generatedYaml}>
                <Layers />
                关系图
              </button>
            </div>
          </div>
          <div className="es-rail-sec">
            <SaveFields layout={layout} />
          </div>
          <div className="es-rail-sec">
            <button type="button" className="es-btn pri lg es-block" onClick={() => void save()} disabled={busy}>
              {busy ? <Loader2 className="es-spin" /> : <Link2 />}
              {busy ? "正在保存…" : saveLabel}
            </button>
            <div className="es-dl">
              <button type="button" className="es-btn" onClick={() => download("clash")} disabled={!generatedYaml}>
                <Download />
                Clash
              </button>
              <button type="button" className="es-btn" onClick={() => download("v2rayn")} disabled={!generatedYaml}>
                <Download />
                v2rayN
              </button>
            </div>
          </div>
        </aside>
      </div>

      <button type="button" className="es-card es-summary es-only-m" onClick={() => openPreview("graph")} disabled={!generatedYaml}>
        <Eye />
        <b className="es-mono">{nodeCount} 个节点</b>
        <span>
          {model ? `${model.groupCount} 代理组 · ${model.regions.slice(0, 2).map((region) => `${region.label} ${region.count}`).join(" · ")}` : "添加来源后显示预览"}
        </span>
        <span className="es-sp" />
        <span className="es-summary-go">预览 ›</span>
      </button>

      <div className="es-savebar es-only-m">
        <button type="button" className="es-savebar-meta" onClick={() => setFieldsOpen(true)}>
          <b>{subscription.subscriptionName || "未命名订阅"}</b>
          <span>· {subscription.autoUpdateEnabled ? `${intervalLabel(autoUpdateIntervalHoursToSeconds(subscription.autoUpdateHours))}自动更新` : "手动更新"}</span>
          <span className="es-savebar-edit">
            <Pencil />
            修改
          </span>
        </button>
        <div className="es-savebar-btns">
          <button type="button" className="es-btn icon lg" onClick={() => download("clash")} disabled={!generatedYaml} aria-label="下载 Clash 配置">
            <Download />
          </button>
          <button type="button" className="es-btn pri lg" onClick={() => void save()} disabled={busy}>
            {busy ? <Loader2 className="es-spin" /> : <Link2 />}
            {busy ? "正在保存…" : saveLabel}
          </button>
        </div>
      </div>

      <Dialog.Root open={fieldsOpen} onOpenChange={setFieldsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="es-scrim" />
          <Dialog.Content className="es-dialog" aria-describedby={undefined}>
            <div className="es-dialog-h">
              <Dialog.Title asChild>
                <h2>名称与自动更新</h2>
              </Dialog.Title>
              <Dialog.Close className="es-btn ghost icon" aria-label="关闭">
                <X />
              </Dialog.Close>
            </div>
            <div className="es-dialog-b">
              <SaveFields layout={layout} />
              <Dialog.Close className="es-btn pri es-block" style={{ marginTop: 12 }}>
                完成
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <PreviewDrawer
        open={drawer.open}
        onOpenChange={(open) => setDrawer((prev) => ({ ...prev, open }))}
        tab={drawer.tab}
        onTabChange={(tab) => setDrawer((prev) => ({ ...prev, tab }))}
        title={subscription.subscriptionName || "未命名订阅"}
        yaml={generatedYaml}
        model={model}
        onDownload={() => download("clash")}
        onReorder={usingRemoteProfile ? undefined : reorderGroups}
        reorderNote={usingRemoteProfile ? "已选择 ACL4SSR 模板，代理组顺序由远程模板决定" : undefined}
      />

      {subscription.subscriptionUrl && (
        <LinkDialog
          open={linkOpen}
          onOpenChange={setLinkOpen}
          name={subscription.subscriptionName}
          subtitle={editing ? "已保存修改" : "已保存"}
          subscriptionUrl={subscription.subscriptionUrl}
        />
      )}
    </div>
  );
}
