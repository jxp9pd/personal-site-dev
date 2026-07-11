import { describe, it, expect, vi } from "vitest";
import { createRecorder } from "../fe-artifacts/assets/js/recorder.js";

const RESULT = { gameId: "sf-neighborhoods", mode: "find", score: 8, total: 10 };

describe("recorder", () => {
  it("holds a guest completion pending, then flushes exactly once on login", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    let authed = false;
    const recorder = createRecorder({
      persist,
      isAuthenticated: () => authed,
    });

    recorder.capture(RESULT);
    expect(persist).not.toHaveBeenCalled();
    expect(recorder.hasPending()).toBe(true);

    authed = true;
    await recorder.onAuthenticated();

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(RESULT);
    expect(recorder.hasPending()).toBe(false);
  });

  it("never flushes when login is dismissed/failed", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const recorder = createRecorder({
      persist,
      isAuthenticated: () => false,
    });

    recorder.capture(RESULT);
    // No auth event ever arrives.
    expect(persist).not.toHaveBeenCalled();
    expect(recorder.hasPending()).toBe(true);
  });

  it("persists an already-authenticated completion immediately", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const recorder = createRecorder({
      persist,
      isAuthenticated: () => true,
    });

    await recorder.capture(RESULT);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(RESULT);
    expect(recorder.hasPending()).toBe(false);
  });

  it("does not double-write on repeated auth events", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    let authed = false;
    const recorder = createRecorder({
      persist,
      isAuthenticated: () => authed,
    });

    recorder.capture(RESULT);
    authed = true;

    await recorder.onAuthenticated();
    await recorder.onAuthenticated();
    await recorder.authChanged(true);

    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("does not double-write when overlapping auth events fire before persist resolves", async () => {
    let resolvePersist;
    const persist = vi.fn(
      () => new Promise((resolve) => { resolvePersist = resolve; })
    );
    const recorder = createRecorder({
      persist,
      isAuthenticated: () => false,
    });

    recorder.capture(RESULT);
    const first = recorder.onAuthenticated();
    const second = recorder.onAuthenticated();
    resolvePersist();
    await Promise.all([first, second]);

    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("ignores invalid or incomplete results", () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const recorder = createRecorder({
      persist,
      isAuthenticated: () => true,
    });

    recorder.capture(null);
    recorder.capture(undefined);
    recorder.capture({});
    recorder.capture({ gameId: "x", mode: "find", score: 1 });
    recorder.capture({ gameId: "x", mode: "find", total: 10 });

    expect(persist).not.toHaveBeenCalled();
    expect(recorder.hasPending()).toBe(false);
  });
});
