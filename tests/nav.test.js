import { describe, it, expect } from "vitest";
import { safeInternalPath, buildProfileHref, resolveHomeHref } from "../fe-artifacts/assets/js/nav.js";

const QUIZ = "/games/neighborhoods-quiz.html?city=sf-neighborhoods";

describe("safeInternalPath", () => {
  it("passes through a same-origin absolute path (with query)", () => {
    expect(safeInternalPath(QUIZ)).toBe(QUIZ);
  });

  it("falls back for absolute URLs to another origin", () => {
    expect(safeInternalPath("https://evil.example.com/steal")).toBe("/");
  });

  it("falls back for protocol-relative URLs (//host)", () => {
    expect(safeInternalPath("//evil.example.com")).toBe("/");
  });

  it("falls back for javascript: and other scheme payloads", () => {
    expect(safeInternalPath("javascript:alert(1)")).toBe("/");
    expect(safeInternalPath("data:text/html,<script>")).toBe("/");
  });

  it("falls back for paths that don't start with a single slash", () => {
    expect(safeInternalPath("games/quiz.html")).toBe("/");
    expect(safeInternalPath("\\evil")).toBe("/");
  });

  it("falls back for empty/nullish input", () => {
    expect(safeInternalPath("")).toBe("/");
    expect(safeInternalPath(null)).toBe("/");
    expect(safeInternalPath(undefined)).toBe("/");
  });

  it("honors a custom fallback", () => {
    expect(safeInternalPath("https://evil.example.com", "/games")).toBe("/games");
  });
});

describe("buildProfileHref", () => {
  it("encodes the current location into a ?from= param", () => {
    expect(buildProfileHref(QUIZ)).toBe(
      `/profile.html?from=${encodeURIComponent(QUIZ)}`
    );
  });

  it("omits ?from= when the current location is not a safe internal path", () => {
    expect(buildProfileHref("https://evil.example.com")).toBe("/profile.html");
  });
});

describe("resolveHomeHref", () => {
  it("returns the decoded internal path from ?from=", () => {
    const search = `?from=${encodeURIComponent(QUIZ)}`;
    expect(resolveHomeHref(search)).toBe(QUIZ);
  });

  it("defaults to / when there is no from param", () => {
    expect(resolveHomeHref("")).toBe("/");
    expect(resolveHomeHref("?foo=bar")).toBe("/");
  });

  it("refuses an off-origin from param (open-redirect guard)", () => {
    const search = `?from=${encodeURIComponent("https://evil.example.com")}`;
    expect(resolveHomeHref(search)).toBe("/");
  });
});
