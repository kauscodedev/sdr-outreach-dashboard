import { describe, it, expect } from "vitest";
import { isAllowedEmail, isAllowedUser } from "../lib/auth/domain";

describe("isAllowedEmail", () => {
  it("accepts spyne.ai emails case-insensitively", () => {
    expect(isAllowedEmail("kaustubh.chauhan@spyne.ai")).toBe(true);
    expect(isAllowedEmail("X@SPYNE.AI ")).toBe(true);
  });
  it("rejects lookalike domains, subdomains, empty and null", () => {
    expect(isAllowedEmail("a@spyne.ai.evil.com")).toBe(false);
    expect(isAllowedEmail("a@sub.spyne.ai")).toBe(false);
    expect(isAllowedEmail("")).toBe(false);
    expect(isAllowedEmail(null)).toBe(false);
    expect(isAllowedEmail("a@gmail.com")).toBe(false);
  });
});

describe("isAllowedUser (email domain AND google provider)", () => {
  it("accepts an @spyne.ai Google session", () => {
    expect(isAllowedUser({ email: "a@spyne.ai", app_metadata: { provider: "google" } })).toBe(true);
    expect(isAllowedUser({ email: "a@spyne.ai", app_metadata: { providers: ["google"] } })).toBe(true);
  });
  it("rejects a spoofed @spyne.ai email on a non-Google provider", () => {
    expect(isAllowedUser({ email: "a@spyne.ai", app_metadata: { provider: "email" } })).toBe(false);
    expect(isAllowedUser({ email: "a@spyne.ai", app_metadata: { providers: ["email"] } })).toBe(false);
    expect(isAllowedUser({ email: "a@spyne.ai" })).toBe(false); // no provider info → deny
  });
  it("rejects a Google session on the wrong domain, and null", () => {
    expect(isAllowedUser({ email: "a@gmail.com", app_metadata: { provider: "google" } })).toBe(false);
    expect(isAllowedUser(null)).toBe(false);
  });
});
