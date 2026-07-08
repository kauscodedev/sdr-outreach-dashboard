/** Row shapes for the sdr_* Postgres tables + the viewer model. */
import { Activity } from "../sync/types";

export interface ActivityRow {
  hs_id: string;
  type: "call" | "email";
  owner_id: string;
  ts_ms: number;
  disposition: string | null;
  email_status: string | null;
  email_opened: boolean;
  email_replied: boolean;
  email_clicked: boolean;
  contact_ids: string[];
  company_ids: string[];
  hs_lastmodified_ms: number | null;
}

export interface CompanyRow {
  hs_id: string;
  name: string | null;
  gd_stage: string | null;
  owner_id: string | null;
  gd_id: string | null;
  is_group: boolean;
  group_name: string | null;
  segment: string | null;
  dealership_type: string | null;
  hs_lastmodified_ms: number | null;
}

export interface ContactRow {
  hs_id: string;
  name: string | null;
  title: string | null;
  dm: boolean;
}

export interface OwnerRow { owner_id: string; email: string | null; name: string; active: boolean; }
export interface TeamRow { team_id: string; name: string; }
export interface TeamMemberRow { team_id: string; owner_id: string; is_primary: boolean; }

export type Role = "admin" | "leadership" | "manager" | "rep" | "viewer";

export interface Viewer {
  email: string;
  role: Role;
  /** The viewer's DEFAULT scope (focus model — org view remains available to all). */
  defaultOwnerIds: string[];
  isAdmin: boolean; // admin OR leadership → /admin access
}

export type { Activity };
