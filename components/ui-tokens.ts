/** Shared chip/icon lookups used by Dashboard + drawer components (single source, no drift). */
import { StageGroup } from "../lib/sync/types";

/** Lifecycle-stage pills — weak background + colored text, keyed to the design tokens. */
export const STAGE_CHIP: Record<StageGroup, string> = {
  Prospect: "bg-surface-muted text-ink-muted",
  "In Pipeline": "bg-primary-weak text-primary",
  "Contract Closed": "bg-good-weak text-good",
  "Drop Off": "bg-danger-weak text-danger",
  Other: "bg-surface-muted text-ink-subtle",
};

/** Solid temperature chips (tiles / dots). */
export const TEMP_CHIP: Record<string, string> = {
  hot: "bg-hot text-white",
  warm: "bg-warm text-white",
  cold: "bg-cold text-white",
};

/** Weak temperature chips (inline badges on light rows). */
export const TEMP_CHIP_WEAK: Record<string, string> = {
  hot: "bg-hot-weak text-hot",
  warm: "bg-warm-weak text-warm",
  cold: "bg-cold-weak text-cold",
};

/** Emoji kept for back-compat with components not yet migrated to lucide (GdExplorer, drawer). */
export const TEMP_ICON: Record<string, string> = { hot: "🔥", warm: "🌤", cold: "🧊" };

export const TEMP_LABEL: Record<string, string> = { hot: "Hot", warm: "Warm", cold: "Cold" };
