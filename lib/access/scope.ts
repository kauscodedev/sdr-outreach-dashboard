/** Pure scope decision (focus model: org view stays available to all) — unit-tested.
 *  Lives apart from resolve.ts so tests can import it without the server-only guard
 *  in supabaseAdmin (same split as callquality map.ts vs fetch.ts). */
import { Role, Viewer } from "../spine/types";

export function decideScope(
  email: string,
  roleRow: { role: string; team_id: string | null } | null,
  trackedOwnerId: string | null,
  teamMemberOwnerIds: string[],
  allTracked: string[],
): Viewer {
  if (roleRow?.role === "admin" || roleRow?.role === "leadership") {
    return { email, role: roleRow.role as Role, defaultOwnerIds: allTracked, isAdmin: true };
  }
  if (roleRow?.role === "manager" && roleRow.team_id) {
    const scope = teamMemberOwnerIds.filter((id) => allTracked.includes(id));
    return { email, role: "manager", defaultOwnerIds: scope, isAdmin: false };
  }
  if (trackedOwnerId) return { email, role: "rep", defaultOwnerIds: [trackedOwnerId], isAdmin: false };
  return { email, role: "viewer", defaultOwnerIds: allTracked, isAdmin: false };
}
