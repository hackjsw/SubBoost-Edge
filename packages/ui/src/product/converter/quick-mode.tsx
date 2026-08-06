"use client";

import { SourcesSection } from "./quick-mode/sources-section";
import { TemplatesSection } from "./quick-mode/templates-section";
import type {
  ClashConversionProfile,
  ClashConversionProfileId,
} from "@subboost/core/subscription/clash-conversion-profiles";

type Props = {
  conversionProfiles?: readonly ClashConversionProfile[];
  conversionProfileId?: ClashConversionProfileId;
  setConversionProfileId?: (value: ClashConversionProfileId) => void;
};

export function QuickMode({
  conversionProfiles,
  conversionProfileId,
  setConversionProfileId,
}: Props) {
  return (
    <div className="flex flex-col gap-3">
      <SourcesSection />
      <TemplatesSection
        conversionProfiles={conversionProfiles}
        conversionProfileId={conversionProfileId}
        setConversionProfileId={setConversionProfileId}
      />
    </div>
  );
}
