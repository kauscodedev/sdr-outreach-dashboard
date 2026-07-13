import { describe, expect, it } from "vitest";
import { companyIdsForActivity, fallbackCompanyFor } from "../lib/sync/associate";

describe("fallbackCompanyFor — deal orphan heal via contacts", () => {
  const map = new Map([["c2", "co9"], ["c3", "co7"]]);
  it("returns the FIRST contact that resolves to a company", () => {
    expect(fallbackCompanyFor(["c1", "c2", "c3"], map)).toBe("co9"); // c1 unresolved → c2 wins
  });
  it("returns null when no contact resolves (or no contacts at all)", () => {
    expect(fallbackCompanyFor(["c1"], map)).toBeNull();
    expect(fallbackCompanyFor([], map)).toBeNull();
  });
});

describe("companyIdsForActivity", () => {
  it("keeps a direct rooftop company even when the contact primary company differs", () => {
    const contactCompany = new Map([["C1", "PRIMARY"]]);

    expect(companyIdsForActivity(["C1"], contactCompany, ["ROOFTOP"])).toEqual(["PRIMARY", "ROOFTOP"]);
  });

  it("still supports no-contact activities through direct company associations", () => {
    expect(companyIdsForActivity([], new Map(), ["ROOFTOP"])).toEqual(["ROOFTOP"]);
  });

  it("deduplicates when direct and contact-derived company ids match", () => {
    const contactCompany = new Map([["C1", "ROOFTOP"]]);

    expect(companyIdsForActivity(["C1"], contactCompany, ["ROOFTOP"])).toEqual(["ROOFTOP"]);
  });
});
