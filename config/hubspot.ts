/**
 * HubSpot deep-link builders for portal 242626590 (app-na2).
 * Mirrors the tam-dashboard pattern: link entities to their HubSpot record pages.
 * Object type prefixes: contacts = 0-1, companies = 0-2.
 */
export const HUBSPOT_PORTAL_ID = "242626590";

const RECORD_BASE = `https://app-na2.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record`;

export const companyUrl = (companyId: string) => `${RECORD_BASE}/0-2/${companyId}`;
export const contactUrl = (contactId: string) => `${RECORD_BASE}/0-1/${contactId}`;

/**
 * Cumulative-coverage lookback anchor (US/Eastern civil date, YYYY-MM-DD). The sync pulls
 * outbound activity back to this date so "has the rep ever tapped this owned account" is
 * effectively all-time and monotonic. Widen/narrow to trade coverage history for sync cost.
 */
export const COVERAGE_ANCHOR = "2025-01-01";
