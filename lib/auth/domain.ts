/** Single source of truth for who may access the dashboard. */
export const ALLOWED_EMAIL_DOMAIN = "spyne.ai";

/** True only for a verified-shape email on the allowed Google Workspace domain. */
export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.trim().toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}

/** Structural shape of the bits of a Supabase auth user we gate on. */
type GateUser = { email?: string | null; app_metadata?: { provider?: string | null; providers?: string[] | null } | null };

/** The authoritative app-side gate: an @spyne.ai email AND a Google identity — mirroring the
 *  DB RLS floor (email domain + provider=google). Verifying the provider (not just the domain)
 *  keeps the gate safe even if the Supabase project ever gains another sign-in method where an
 *  attacker could set an @spyne.ai email without Google verification. */
export function isAllowedUser(user: GateUser | null | undefined): boolean {
  if (!user || !isAllowedEmail(user.email)) return false;
  const provider = user.app_metadata?.provider ?? null;
  const providers = user.app_metadata?.providers ?? [];
  return provider === "google" || providers.includes("google");
}
