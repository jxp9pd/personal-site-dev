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
// A find/name round plays every neighborhood in the city.
const ROUND = N;
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

// Name mode (timed type-to-recall) driver: set the box, fire an `input` event
// (live-typing path), optionally submit with Enter, then advance the ~400ms
// debounce so any live check runs.
async function typeName(text, { enter = false } = {}) {
  const input = el("nameInput");
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  if (enter) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  await vi.advanceTimersByTimeAsync(400);
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
describe("neighborhoods quiz — name mode (timed type-to-recall)", () => {
  it("shows the pre-game panel with the total and a Start button; clock/input inactive", async () => {
    await bootQuiz();
    switchMode("name");

    expect(el("namePregame").hidden).toBe(false);
    expect(el("namePregameCount").textContent).toContain(String(N));
    expect(el("nameStart")).toBeTruthy();
    // Input + clock are not active yet.
    expect(el("namePlay").hidden).toBe(true);
    expect(el("stat").textContent).toBe("");
  });

  it("Start reveals the text input and starts the clock", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    expect(el("namePregame").hidden).toBe(true);
    expect(el("namePlay").hidden).toBe(false);
    expect(el("stat").textContent).toContain(`0/${N} found`);
    expect(el("stat").textContent).toMatch(/\d+:\d{2}/);
  });

  it("credits a correct dataset name: counter ticks, box clears, layer gets a permanent label", async () => {
    const L = await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await typeName("chinatown");

    expect(el("stat").textContent).toContain(`1/${N} found`);
    expect(el("nameInput").value).toBe("");
    const tip = L.layerFor("Chinatown")._tooltip;
    expect(tip).not.toBe(null);
    expect(tip.content).toBe("Chinatown");
    expect(tip.opts.permanent).toBe(true);
  });

  it("credits an alias guess (PH → Pacific Heights)", async () => {
    const L = await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await typeName("PH");

    expect(el("stat").textContent).toContain(`1/${N} found`);
    expect(L.layerFor("Pacific Heights")._tooltip.content).toBe("Pacific Heights");
  });

  it("credits a space-removed alias guess (NobHill → Nob Hill)", async () => {
    const L = await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await typeName("NobHill");

    expect(el("stat").textContent).toContain(`1/${N} found`);
    expect(L.layerFor("Nob Hill")._tooltip.content).toBe("Nob Hill");
  });

  it("credits a punctuation/case-insensitive guess (castro upper market → Castro/Upper Market)", async () => {
    const L = await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await typeName("castro upper market");

    expect(el("stat").textContent).toContain(`1/${N} found`);
    expect(L.layerFor("Castro/Upper Market")._tooltip.content).toBe("Castro/Upper Market");
  });

  it("a duplicate already-found guess is a no-op and leaves the text in the box", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await typeName("Chinatown");
    expect(el("stat").textContent).toContain(`1/${N} found`);

    await typeName("Chinatown");

    expect(el("stat").textContent).toContain(`1/${N} found`);
    expect(el("nameInput").value).toBe("Chinatown");
  });

  it("Enter on a non-match does not credit and flashes the input", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await typeName("zzz not a neighborhood", { enter: true });

    expect(el("stat").textContent).toContain(`0/${N} found`);
    expect(el("nameInput").classList.contains("flash-bad")).toBe(true);
  });

  it("finding all N shows the done screen", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    for (const name of HOOD_NAMES) {
      if (doneShown()) break;
      await typeName(name);
    }

    expect(doneShown()).toBe(true);
  });

  it("the 10-minute timer expiring ends the round", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await vi.advanceTimersByTimeAsync(600 * 1000);

    expect(doneShown()).toBe(true);
  });

  it("finishing records the play as mode:'name' with score = found count", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    for (const name of HOOD_NAMES) {
      if (doneShown()) break;
      await typeName(name);
    }
    await flush();

    expect(Profiles.recordPlay).toHaveBeenCalledWith({
      gameId: "sf-neighborhoods",
      mode: "name",
      score: N,
      total: N,
    });
  });
});

describe("neighborhoods quiz — name mode finish (give up, missed reveal, time used)", () => {
  it("give up during a round ends it and shows the done screen", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    el("nameGiveUp").click();

    expect(doneShown()).toBe(true);
  });

  it("lists + reveals the missed hoods while leaving the found ones off the list", async () => {
    const L = await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await typeName("Chinatown");
    await typeName("Nob Hill");
    el("nameGiveUp").click();

    const missedText = el("doneMissed").textContent;
    // Found hoods are not in the missed list.
    expect(missedText).not.toContain("Chinatown");
    expect(missedText).not.toContain("Nob Hill");

    // Two specific known misses are listed and revealed on the map.
    const missedNames = HOOD_NAMES.filter(n => n !== "Chinatown" && n !== "Nob Hill");
    for (const name of missedNames.slice(0, 2)) {
      expect(missedText).toContain(name);
      const tip = L.layerFor(name)._tooltip;
      expect(tip).not.toBe(null);
      expect(tip.content).toBe(name);
      expect(tip.opts.permanent).toBe(true);
    }

    // A found layer keeps its own label and is not part of the missed reveal.
    expect(L.layerFor("Chinatown")._tooltip.content).toBe("Chinatown");
  });

  it("shows the full time used when the timer expires", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await vi.advanceTimersByTimeAsync(600 * 1000);

    expect(el("doneScore").textContent).toContain("Time used 10:00");
  });

  it("shows the elapsed time used when giving up mid-round", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await vi.advanceTimersByTimeAsync(5 * 1000);
    el("nameGiveUp").click();

    expect(el("doneScore").textContent).toContain("Time used 0:05");
  });

  it("records the play as mode:'name' with score = found count when giving up", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await typeName("Chinatown");
    await typeName("Nob Hill");
    el("nameGiveUp").click();
    await flush();

    expect(Profiles.recordPlay).toHaveBeenCalledWith({
      gameId: "sf-neighborhoods",
      mode: "name",
      score: 2,
      total: N,
    });
  });

  it("clears the missed list when starting a new round", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();
    await typeName("Chinatown");
    el("nameGiveUp").click();
    expect(el("doneMissed").hidden).toBe(false);

    el("doneRestart").click();

    expect(el("doneMissed").hidden).toBe(true);
    expect(el("doneMissed").innerHTML).toBe("");
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
