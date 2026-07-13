/** Shared contract for the /api/deals route ↔ the Accounts page's Deal Funnel view. Pure types. */
import { DealStageKey } from "../../config/deal-stages";
import { DealHealth } from "./deal-health";
import { Forecast } from "./forecast";

export interface DealListItem {
  id: string;
  company_id: string | null;
  company_name: string | null;
  stage_key: DealStageKey;
  stage_label: string;
  health: DealHealth | null;
  health_reason: string | null;
  amount: number | null;
  sdr_owner_id: string | null;
  sdr_name: string | null;
  ae_owner_id: string | null;
  ae_name: string | null;
  entered_stage_ms: number | null; // when it entered its CURRENT stage (ledger)
  created_ms: number | null; // createdate
  demo_scheduled_for_ms: number | null; // the SDR's commitment date
  expected_close_ms: number | null; // the AE's commitment date (expected_contract_closure_date)
  last_activity_ms: number | null; // company-level last activity
}

export interface DealFunnelPayload {
  lens: string;
  window: number | "all"; // days the funnel is scoped to (deal start date)
  total: number; // matching deals in the window (lists below are capped per stage)
  undated: number; // deals excluded from the window for lack of any start date
  funnel: {
    stages: Record<string, { count: number; amount: number }>; // keyed by DealStageKey
    lost: { count: number; amount: number };
    /** Event-truth flow over the ledger: ever scheduled → completed → reached contract → won. */
    flow: { scheduled: number; completed: number; contract: number; won: number };
  };
  deals: DealListItem[]; // up to list_cap per stage bucket, longest-in-stage first
  list_cap: number;
  forecast: Forecast; // resolved-cohort conversion, stage velocity, expected pipeline value
}
