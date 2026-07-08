import { describe, it, expect } from "vitest";
import { decideScope } from "../lib/access/scope";

const TRACKED = ["A", "B", "C", "D"];

describe("decideScope", () => {
  it("admin/leadership → all tracked + admin flag", () => {
    const v = decideScope("boss@spyne.ai", { role: "admin", team_id: null }, null, [], TRACKED);
    expect(v).toMatchObject({ role: "admin", isAdmin: true, defaultOwnerIds: TRACKED });
    expect(decideScope("l@spyne.ai", { role: "leadership", team_id: null }, null, [], TRACKED).isAdmin).toBe(true);
  });
  it("manager → own team ∩ tracked", () => {
    const v = decideScope("mgr@spyne.ai", { role: "manager", team_id: "T1" }, null, ["A", "X", "C"], TRACKED);
    expect(v).toMatchObject({ role: "manager", isAdmin: false, defaultOwnerIds: ["A", "C"] });
  });
  it("tracked rep (no role row) → own data", () => {
    const v = decideScope("rep@spyne.ai", null, "B", [], TRACKED);
    expect(v).toMatchObject({ role: "rep", defaultOwnerIds: ["B"] });
  });
  it("everyone else → viewer with org-wide default", () => {
    const v = decideScope("cs@spyne.ai", null, null, [], TRACKED);
    expect(v).toMatchObject({ role: "viewer", isAdmin: false, defaultOwnerIds: TRACKED });
  });
  it("manager row without team falls back to viewer", () => {
    expect(decideScope("m@spyne.ai", { role: "manager", team_id: null }, null, [], TRACKED).role).toBe("viewer");
  });
});
