import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadPage } from "./helpers/loadPage.js";
import { fakeLeaflet } from "./helpers/fakeLeaflet.js";

// Real SF export, committed so CI / fresh clones are reproducible (data/quizzes
// is gitignored). Wrapped into the quiz object the game consumes; center/zoom
// are arbitrary because the fake ignores geometry.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "fixtures/sf-neighborhoods.data.json"), "utf8"),
);
const HOOD_NAMES = fixture.geo.features.map(f => f.properties.name);
const N = HOOD_NAMES.length;
// A find/name round is capped at 10 sampled hoods (see ROUND_MAX in the game).
const ROUND = Math.min(10, N);
// The game sorts hood names; a stubbed identity shuffle makes a round the first
// ROUND of this sorted list, in order — used where a test needs a known round.
const SORTED = [...HOOD_NAMES].sort();

function sfQuiz() {
  return {
    slug: "sf-neighborhoods",
    name: "San Francisco",
    center: [37.76, -122.44],
    zoom: 12,
    geo: fixture.geo,
    artSvg: null,
  };
}

vi.mock("../fe-artifacts/assets/js/dataClient.js", () => ({
  fetchQuiz: vi.fn(),
  fetchQuizList: vi.fn(),
}));

vi.mock("../fe-artifacts/assets/js/profiles.js", () => ({
  Profiles: {
    init: vi.fn().mockResolvedValue(undefined),
    isLoggedIn: vi.fn(() => true),
    recordPlay: vi.fn().mockResolvedValue({ status: "saved" }),
    promptLogin: vi.fn(),
  },
}));

import { fetchQuiz } from "../fe-artifacts/assets/js/dataClient.js";
import { Profiles } from "../fe-artifacts/assets/js/profiles.js";
import { start } from "../fe-artifacts/assets/js/neighborhoods-quiz.js";

const doneShown = () => document.getElementById("done").style.display === "flex";

async function bootQuiz() {
  fetchQuiz.mockResolvedValue(sfQuiz());
  globalThis.L = fakeLeaflet();
  loadPage();
  window.history.replaceState({}, "", "/games/neighborhoods-quiz.html?city=sf-neighborhoods");
  await start();
  return globalThis.L;
}

// Drives a perfect FIND round: click whatever #pTarget asks for, skip the
// 700ms gap, until the done screen appears. Never assumes question order.
async function playFindPerfect(L, cap = N + 5) {
  for (let i = 0; i < cap; i++) {
    if (doneShown()) return;
    const target = document.getElementById("pTarget").textContent;
    L.fireClick(target);
    await vi.advanceTimersByTimeAsync(700);
  }
  throw new Error("FIND round did not reach the done screen within the cap");
}

// setup.js clears CALL HISTORY (clearAllMocks) but not implementations, so a
// pending/failed override from one test would otherwise leak into the next.
// Re-establish defaults every test; individual tests override after bootQuiz().
beforeEach(() => {
  vi.useFakeTimers();
  Profiles.isLoggedIn.mockReturnValue(true);
  Profiles.recordPlay.mockResolvedValue({ status: "saved" });
});

const el = id => document.getElementById(id);
const flush = () => vi.advanceTimersByTimeAsync(0);
const switchMode = m => document.querySelector(`#modeTabs button[data-mode="${m}"]`).click();
const nameButtons = () => [...document.querySelectorAll("#prompt button")];
const nameCorrectBtn = L => nameButtons().find(b => b.textContent === L.currentTarget());
const nameWrongBtn = L => nameButtons().find(b => b.textContent !== L.currentTarget());

// Drives a perfect NAME round by picking the button matching the locked answer.
async function playNamePerfect(L, cap = N + 5) {
  for (let i = 0; i < cap; i++) {
    if (doneShown()) return;
    nameCorrectBtn(L).click();
    await vi.advanceTimersByTimeAsync(700);
  }
  throw new Error("NAME round did not reach the done screen within the cap");
}

describe("neighborhoods quiz — find mode (perfect round)", () => {
  it("drives a full perfect FIND round to a saved done screen", async () => {
    const L = await bootQuiz();

    expect(document.getElementById("pTarget").textContent).not.toBe("");
    await playFindPerfect(L);

    expect(doneShown()).toBe(true);
    expect(document.getElementById("doneTitle").textContent.trim()).not.toBe("");
    expect(document.getElementById("doneScore").textContent).toContain(`${ROUND}/${ROUND}`);

    expect(Profiles.recordPlay).toHaveBeenCalledWith({
      gameId: "sf-neighborhoods",
      mode: "find",
      score: ROUND,
      total: ROUND,
    });
  });
});

// ---- T2 ---------------------------------------------------------------------
describe("neighborhoods quiz — find mode wrong-pick handling", () => {
  it("leaves a wrongly-clicked hood untouched and updates feedback", async () => {
    const L = await bootQuiz();
    const target = el("pTarget").textContent;
    const w = HOOD_NAMES.find(n => n !== target);

    L.fireClick(w);

    expect(el("pFb").textContent).toBe("Incorrect");
    expect(el("pFb").className).toBe("fb bad");
    expect(L.layerFor(w)._locked).toBe(false);
    expect(L.layerFor(w)._revealed).toBe(false);
    expect(L.layerFor(w)._tooltip).toBe(null);
  });

  it("still presents the wrongly-clicked hood as its own unrevealed target later", async () => {
    // Pin the round so a specific in-round hood is guaranteed to come back:
    // an identity shuffle makes the round SORTED[0..ROUND-1] in order.
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0.999999);
    try {
      const L = await bootQuiz();
      const first = el("pTarget").textContent;
      const w = SORTED[3]; // in-round (index < ROUND) and not yet asked
      expect(first).toBe(SORTED[0]);

      // Round 0: misclick w while the target is `first`.
      L.fireClick(w);
      await vi.advanceTimersByTimeAsync(700);

      // Play correctly until w itself becomes the target.
      let reached = false;
      for (let i = 0; i < ROUND + 5; i++) {
        if (doneShown()) break;
        if (el("pTarget").textContent === w) { reached = true; break; }
        L.fireClick(el("pTarget").textContent);
        await vi.advanceTimersByTimeAsync(700);
      }

      expect(reached).toBe(true);
      expect(el("pTarget").textContent).toBe(w);
      expect(L.layerFor(w)._locked).toBe(false);
      expect(L.layerFor(w)._revealed).toBe(false);
      expect(L.layerFor(w)._tooltip).toBe(null);
    } finally {
      rnd.mockRestore();
    }
  });

  it("shows a running accuracy that is 50% after one correct then one wrong", async () => {
    const L = await bootQuiz();

    // One correct.
    L.fireClick(el("pTarget").textContent);
    await vi.advanceTimersByTimeAsync(700);

    // One wrong (any name that isn't the current target).
    const target = el("pTarget").textContent;
    L.fireClick(HOOD_NAMES.find(n => n !== target));

    const stat = el("stat").textContent;
    expect(stat).toContain("50%");
    expect(stat).toContain("correct");
    expect(stat).toContain("left");
  });
});

// ---- T3 ---------------------------------------------------------------------
describe("neighborhoods quiz — name mode multiple choice", () => {
  it("renders exactly 4 choices including the answer", async () => {
    const L = await bootQuiz();
    switchMode("name");

    const btns = nameButtons();
    expect(btns).toHaveLength(4);
    expect(btns.map(b => b.textContent)).toContain(L.currentTarget());
    expect(el("pTarget").textContent).toBe("???");
  });

  it("marks a correct choice and reveals the name", async () => {
    const L = await bootQuiz();
    switchMode("name");
    const answer = L.currentTarget();

    nameCorrectBtn(L).click();

    expect(el("pFb").textContent).toBe("Correct");
    expect(el("pFb").className).toBe("fb good");
    expect(el("pTarget").textContent).toBe(answer);
    expect(el("pTarget").textContent).not.toBe("???");
  });

  it("marks a wrong choice with the answer and disables all buttons", async () => {
    const L = await bootQuiz();
    switchMode("name");
    const answer = L.currentTarget();
    const btns = nameButtons();
    const correctBtn = btns.find(b => b.textContent === answer);

    nameWrongBtn(L).click();

    expect(el("pFb").textContent).toBe(`Nope — ${answer}`);
    expect(el("pFb").className).toBe("fb bad");
    // The correct button is the one the wrong-branch re-styles. Color-based
    // highlighting isn't observable here (the page's :root CSS vars live in the
    // stripped <head><style>, so getComputedStyle → '' and style assignments are
    // no-ops); assert instead that the correct choice is identifiable + revealed.
    expect(correctBtn.textContent).toBe(answer);
    expect(el("pTarget").textContent).toBe(answer);
    expect(btns.every(b => b.disabled)).toBe(true);
  });

  it("completes a full NAME round to the done screen", async () => {
    const L = await bootQuiz();
    switchMode("name");

    await playNamePerfect(L);

    expect(doneShown()).toBe(true);
  });
});

// ---- T4 ---------------------------------------------------------------------
describe("neighborhoods quiz — learn mode hover reveal", () => {
  it("hides the prompt and shows the hover instructions with the total", async () => {
    await bootQuiz();
    switchMode("learn");

    expect(el("prompt").style.display).toBe("none");
    expect(el("stat").textContent).toBe(
      `Hover a neighborhood to reveal its name · ${N} total`,
    );
    expect(el("stat").textContent).toContain(`${N} total`);
  });

  it("reveals a hood's name on hover via a bound, opened tooltip", async () => {
    const L = await bootQuiz();
    switchMode("learn");

    const name = HOOD_NAMES[0];
    L.fireHover(name);

    const tip = L.layerFor(name)._tooltip;
    expect(tip).not.toBe(null);
    expect(tip.content).toBe(name);
    expect(tip.open).toBe(true);
  });

  it("reveals a hood's name on tap via the same bound, opened tooltip", async () => {
    const L = await bootQuiz();
    switchMode("learn");

    const name = HOOD_NAMES[0];
    L.fireClick(name);

    const tip = L.layerFor(name)._tooltip;
    expect(tip).not.toBe(null);
    expect(tip.content).toBe(name);
    expect(tip.open).toBe(true);
  });

  it("never finishes: no done screen and recordPlay is never called", async () => {
    const L = await bootQuiz();
    switchMode("learn");

    HOOD_NAMES.slice(0, 5).forEach(n => L.fireHover(n));
    await vi.advanceTimersByTimeAsync(2000);

    expect(el("done").style.display).not.toBe("flex");
    expect(Profiles.recordPlay).not.toHaveBeenCalled();
  });
});

// ---- T5 ---------------------------------------------------------------------
describe("neighborhoods quiz — save/auth outcomes", () => {
  it("logged-in + saved shows the saved note", async () => {
    const L = await bootQuiz();
    Profiles.isLoggedIn.mockReturnValue(true);
    Profiles.recordPlay.mockResolvedValue({ status: "saved" });

    await playFindPerfect(L);
    await flush();

    expect(el("savedNote").hidden).toBe(false);
    expect(el("savedNote").textContent).toBe("Saved to your profile");
    expect(Profiles.recordPlay).toHaveBeenCalledWith({
      gameId: "sf-neighborhoods",
      mode: "find",
      score: ROUND,
      total: ROUND,
    });
  });

  it("logged-in + pending falls back to the save nudge", async () => {
    const L = await bootQuiz();
    Profiles.isLoggedIn.mockReturnValue(true);
    Profiles.recordPlay.mockResolvedValue({ status: "pending" });

    await playFindPerfect(L);
    await flush();

    expect(el("saveNudge").hidden).toBe(false);
    expect(el("savedNote").hidden).toBe(true);
  });

  it("a failed save shows the error and retry re-invokes recordPlay", async () => {
    const L = await bootQuiz();
    Profiles.isLoggedIn.mockReturnValue(true);
    Profiles.recordPlay.mockRejectedValue(new Error("network"));

    await playFindPerfect(L);
    await flush();

    expect(el("saveError").hidden).toBe(false);

    const before = Profiles.recordPlay.mock.calls.length;
    el("saveRetry").click();
    await flush();

    expect(Profiles.recordPlay.mock.calls.length).toBe(before + 1);
  });

  it("guest sees the nudge and login button prompts login", async () => {
    const L = await bootQuiz();
    Profiles.isLoggedIn.mockReturnValue(false);

    await playFindPerfect(L);
    await flush();

    expect(el("saveNudge").hidden).toBe(false);
    expect(Profiles.recordPlay).toHaveBeenCalledWith({
      gameId: "sf-neighborhoods",
      mode: "find",
      score: ROUND,
      total: ROUND,
    });

    el("saveLogin").click();
    expect(Profiles.promptLogin).toHaveBeenCalled();
  });
});

// ---- T6 ---------------------------------------------------------------------
describe("neighborhoods quiz — chrome (tabs, restart, mount)", () => {
  it("activates the clicked mode tab and clears the others, resetting the round", async () => {
    const L = await bootQuiz();

    // Bump the correct count so we can prove the round resets on tab switch.
    L.fireClick(el("pTarget").textContent);
    expect(el("stat").querySelector("b").textContent).toBe("1");

    for (const mode of ["name", "learn", "find"]) {
      switchMode(mode);
      const tabs = [...document.querySelectorAll("#modeTabs button")];
      for (const t of tabs) {
        expect(t.classList.contains("active")).toBe(t.dataset.mode === mode);
      }
    }

    // Back in find mode after the loop: correct was reset to 0.
    expect(el("stat").querySelector("b").textContent).toBe("0");
  });

  it("#restart resets the round state", async () => {
    const L = await bootQuiz();
    L.fireClick(el("pTarget").textContent);
    expect(el("stat").querySelector("b").textContent).toBe("1");

    el("restart").click();

    expect(el("done").style.display).toBe("none");
    expect(el("pFb").textContent).toBe("");
    expect(el("stat").querySelector("b").textContent).toBe("0");
  });

  it("#doneRestart resets state after finishing a round", async () => {
    const L = await bootQuiz();
    await playFindPerfect(L);
    await flush();
    expect(doneShown()).toBe(true);

    el("doneRestart").click();

    expect(el("done").style.display).toBe("none");
    expect(el("pFb").textContent).toBe("");
    expect(el("stat").querySelector("b").textContent).toBe("0");
  });

  it("mounts the profile header inside #app", async () => {
    await bootQuiz();

    expect(Profiles.init).toHaveBeenCalled();
    const arg = Profiles.init.mock.calls.at(-1)[0];
    expect(arg.headerMount).toBe(el("profileMount"));
    expect(el("app").contains(arg.headerMount)).toBe(true);
  });
});
