import { describe, it, expect, vi } from "vitest";
import { createRecorder } from "../fe-artifacts/assets/js/recorder.js";

const RESULT = { gameId: "sf-neighborhoods", mode: "find", score: 8, total: 10 };

// Bug 3 (robustness): a completed game must report its *actual* persistence
// outcome so the UI only claims "Saved to your profile" when the row truly
// landed — and a transient failure must not silently drop the play.
describe("recorder save outcome", () => {
  it("reports { status: 'saved' } when an authenticated persist succeeds", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const recorder = createRecorder({ persist, isAuthenticated: () => true });

    const outcome = await recorder.capture(RESULT);

    expect(outcome).toEqual({ status: "saved" });
    expect(recorder.hasPending()).toBe(false);
  });

  it("reports { status: 'pending' } for a guest and holds the play", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const recorder = createRecorder({ persist, isAuthenticated: () => false });

    const outcome = await recorder.capture(RESULT);

    expect(outcome).toEqual({ status: "pending" });
    expect(persist).not.toHaveBeenCalled();
    expect(recorder.hasPending()).toBe(true);
  });

  it("reports failure and RETAINS the play when an authenticated persist throws", async () => {
    const boom = new Error("network down");
    const persist = vi.fn().mockRejectedValue(boom);
    const recorder = createRecorder({ persist, isAuthenticated: () => true });

    const outcome = await recorder.capture(RESULT);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBe(boom);
    // The play must not be lost: a later retry/login can still flush it.
    expect(recorder.hasPending()).toBe(true);
  });

  it("retries a previously-failed play on the next auth event without dropping it", async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);
    const recorder = createRecorder({ persist, isAuthenticated: () => true });

    const first = await recorder.capture(RESULT);
    expect(first.status).toBe("failed");
    expect(recorder.hasPending()).toBe(true);

    await recorder.authChanged(true);

    expect(persist).toHaveBeenCalledTimes(2);
    expect(recorder.hasPending()).toBe(false);
  });

  it("reports { status: 'ignored' } for invalid results", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const recorder = createRecorder({ persist, isAuthenticated: () => true });

    const outcome = await recorder.capture({ gameId: "x", mode: "find" });

    expect(outcome).toEqual({ status: "ignored" });
    expect(persist).not.toHaveBeenCalled();
  });
});
