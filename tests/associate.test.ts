import { describe, expect, it } from "vitest";
import { companyIdsForActivity } from "../lib/sync/associate";

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
