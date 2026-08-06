"use client";

import { Check, Cloud, Sparkles } from "lucide-react";
import type {
  ClashConversionProfile,
  ClashConversionProfileId,
} from "@subboost/core/subscription/clash-conversion-profiles";
import { Button } from "@subboost/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@subboost/ui/components/ui/dialog";
import { cn } from "@subboost/ui/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: readonly ClashConversionProfile[];
  value: ClashConversionProfileId;
  onValueChange: (value: ClashConversionProfileId) => void;
};

function ProfileOption({
  profile,
  checked,
  onValueChange,
}: {
  profile: ClashConversionProfile;
  checked: boolean;
  onValueChange: (value: ClashConversionProfileId) => void;
}) {
  const inputId = `clash-profile-${profile.id}`;
  const descriptionId = `${inputId}-description`;
  const Icon = profile.configUrl ? Cloud : Sparkles;

  return (
    <div className="relative">
      <input
        id={inputId}
        type="radio"
        name="clash-conversion-profile"
        value={profile.id}
        checked={checked}
        onChange={() => onValueChange(profile.id)}
        onKeyDown={(event) => {
          if (event.key !== " " && event.key !== "Enter") return;
          event.preventDefault();
          onValueChange(profile.id);
        }}
        aria-describedby={descriptionId}
        className="peer sr-only"
      />
      <label
        htmlFor={inputId}
        onClick={() => onValueChange(profile.id)}
        className={cn(
          "grid min-h-[5rem] cursor-pointer grid-cols-[2.5rem_minmax(0,1fr)_1.25rem] items-start gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors",
          "border-[#d7e0de] bg-white hover:border-[#9fc8c1] hover:bg-[#f4f8f7]",
          "peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-[#087f70] peer-focus-visible:ring-offset-2",
          checked && "border-[#087f70] bg-[#edf9f7] shadow-[0_0_0_1px_rgba(8,127,112,0.18)]"
        )}
      >
        <span
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-lg border",
            checked
              ? "border-[#9fd8ce] bg-white text-[#087f70]"
              : "border-[#d7e0de] bg-[#f4f7f7] text-[#60706d]"
          )}
        >
          <Icon className="h-4.5 w-4.5" aria-hidden="true" />
        </span>

        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="break-words text-sm font-semibold text-[#172321]">{profile.name}</span>
            {profile.recommended && (
              <span className="text-[11px] font-medium text-[#087f70]">推荐</span>
            )}
          </span>
          <span id={descriptionId} className="mt-1 block break-words text-xs leading-5 text-[#60706d]">
            {profile.description}
          </span>
          <span className="mt-1.5 block break-words text-[11px] text-[#52635f] [overflow-wrap:anywhere]">
            {profile.provider} · {profile.tags.join(" · ")}
          </span>
        </span>

        <span
          className={cn(
            "mt-2 flex h-5 w-5 items-center justify-center rounded-full border",
            checked ? "border-[#087f70] bg-[#087f70] text-[#ffffff]" : "border-[#aebbb8] text-transparent"
          )}
          aria-hidden="true"
        >
          <Check className="h-3 w-3" strokeWidth={3} />
        </span>
      </label>
    </div>
  );
}

export function ClashConversionProfileDialog({
  open,
  onOpenChange,
  profiles,
  value,
  onValueChange,
}: Props) {
  const nativeProfiles = profiles.filter((profile) => !profile.configUrl);
  const remoteProfiles = profiles.filter((profile) => profile.configUrl);
  const selectedProfile = profiles.find((profile) => profile.id === value) ?? profiles[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col gap-0 overflow-hidden border-[#d7e0de] bg-white p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-[#e1e8e6] px-5 pb-4 pt-5 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-[#172321]">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#edf9f7] text-[#087f70]">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            </span>
            Clash 规则方案
          </DialogTitle>
          <DialogDescription className="text-[#60706d]">
            决定订阅链接交付原生 YAML，还是套用 ACL4SSR 远程配置。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 custom-scrollbar">
          {nativeProfiles.length > 0 && (
            <section aria-labelledby="native-profile-heading" className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 id="native-profile-heading" className="text-xs font-semibold text-[#40514e]">
                  EdgeSub 原生
                </h3>
                <span className="text-[11px] text-[#52635f]">本地生成</span>
              </div>
              {nativeProfiles.map((profile) => (
                <ProfileOption
                  key={profile.id}
                  profile={profile}
                  checked={profile.id === value}
                  onValueChange={onValueChange}
                />
              ))}
            </section>
          )}

          {remoteProfiles.length > 0 && (
            <section aria-labelledby="remote-profile-heading" className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <h3 id="remote-profile-heading" className="text-xs font-semibold text-[#40514e]">
                  ACL4SSR 远程配置
                </h3>
                <span className="text-[11px] text-[#52635f]">跟随官方 master 更新</span>
              </div>
              <div className="space-y-2">
                {remoteProfiles.map((profile) => (
                  <ProfileOption
                    key={profile.id}
                    profile={profile}
                    checked={profile.id === value}
                    onValueChange={onValueChange}
                  />
                ))}
              </div>
              <p className="rounded-lg border border-[#d6e5e1] bg-[#f4f8f7] px-3 py-2.5 text-xs leading-5 text-[#52635f]">
                远程方案会通过当前 subconverter 后端生成配置；上游不可用时请求会返回错误，不会静默改用原生规则。
              </p>
            </section>
          )}
        </div>

        <DialogFooter className="flex-row items-center justify-between space-x-0 border-t border-[#e1e8e6] bg-[#fbfcfc] px-5 py-4">
          <p className="min-w-0 truncate pr-3 text-xs text-[#60706d]">
            当前：<span className="font-medium text-[#263633]">{selectedProfile?.name ?? "未选择"}</span>
          </p>
          <Button type="button" onClick={() => onOpenChange(false)} className="shrink-0">
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
