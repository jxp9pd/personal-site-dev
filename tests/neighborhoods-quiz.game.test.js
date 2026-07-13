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

// The leaderboard modal is the end screen. Stub it so tests assert it opened
// (and with what) without pulling in its DOM + data-client calls.
vi.mock("../fe-artifacts/assets/js/leaderboard.js", () => ({
  Leaderboard: { open: vi.fn(), close: vi.fn() },
}));

import { fetchQuiz } from "../fe-artifacts/assets/js/dataClient.js";
import { Profiles } from "../fe-artifacts/assets/js/profiles.js";
import { Leaderboard } from "../fe-artifacts/assets/js/leaderboard.js";
import { start } from "../fe-artifacts/assets/js/neighborhoods-quiz.js";

// A finished round opens the leaderboard as its end screen (there is no separate
// score page). These read that signal.
const boardOpened = () => Leaderboard.open.mock.calls.length > 0;
const lastBoard = () => Leaderboard.open.mock.calls.at(-1)?.[0];

async function bootQuiz() {
  fetchQuiz.mockResolvedValue(sfQuiz());
  globalThis.L = fakeLeaflet();
  loadPage();
  window.history.replaceState({}, "", "/games/neighborhoods-quiz.html?city=sf-neighborhoods");
  await start();
  return globalThis.L;
}

// Drives a perfect FIND round: click whatever #pTarget asks for, skip the
// 700ms gap, until the leaderboard opens. Never assumes question order.
async function playFindPerfect(L, cap = N + 5) {
  for (let i = 0; i < cap; i++) {
    if (boardOpened()) return;
    const target = document.getElementById("pTarget").textContent;
    L.fireClick(target);
    await vi.advanceTimersByTimeAsync(700);
  }
  await flush();
  if (boardOpened()) return;
  throw new Error("FIND round did not open the leaderboard within the cap");
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

// Name mode (timed type-to-recall): a guess is only checked on Enter — there is
// no live auto-submit — so this sets the box and presses Enter.
async function typeName(text) {
  const input = el("nameInput");
  input.value = text;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
}

describe("neighborhoods quiz — find mode (perfect round)", () => {
  it("drives a full perfect FIND round to the leaderboard end screen", async () => {
    const L = await bootQuiz();
    switchMode("find");

    expect(document.getElementById("pTarget").textContent).not.toBe("");
    await playFindPerfect(L);

    expect(boardOpened()).toBe(true);
    expect(lastBoard().mode).toBe("find");
    expect(lastBoard().subline).toContain(`${ROUND} of ${ROUND}`);
    // The map is revealed for exploration: a played hood carries its label.
    expect(L.layerFor(SORTED[0])._tooltip).not.toBe(null);

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
    switchMode("find");
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
      switchMode("find");
      const first = el("pTarget").textContent;
      const w = SORTED[3]; // in-round (index < ROUND) and not yet asked
      expect(first).toBe(SORTED[0]);

      // Round 0: misclick w while the target is `first`.
      L.fireClick(w);
      await vi.advanceTimersByTimeAsync(700);

      // Play correctly until w itself becomes the target.
      let reached = false;
      for (let i = 0; i < ROUND + 5; i++) {
        if (boardOpened()) break;
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
    switchMode("find");

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
  it("defaults to Name it on boot: the tab is active and the pre-game panel shows", async () => {
    await bootQuiz();

    expect(el("app").dataset.mode).toBe("name");
    expect(document.querySelector('#modeTabs button[data-mode="name"]').classList.contains("active")).toBe(true);
    expect(el("namePregame").hidden).toBe(false);
    expect(el("prompt").style.display).toBe("none");
  });

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

  it("credits a correct dataset name: counter ticks, box clears, layer gets a hover-reveal label", async () => {
    const L = await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await typeName("chinatown");

    expect(el("stat").textContent).toContain(`1/${N} found`);
    expect(el("nameInput").value).toBe("");
    const tip = L.layerFor("Chinatown")._tooltip;
    expect(tip).not.toBe(null);
    expect(tip.content).toBe("Chinatown");
    // Found labels reveal on hover/tap, not permanently, so they don't bury the map.
    expect(tip.opts.permanent).toBeFalsy();
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

    await typeName("zzz not a neighborhood");

    expect(el("stat").textContent).toContain(`0/${N} found`);
    expect(el("nameInput").classList.contains("flash-bad")).toBe(true);
  });

  it("live typing does not auto-submit — only Enter credits a guess", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    // Type a valid name and fire the input event (no Enter); wait well past the
    // old debounce window. Nothing should be credited and the text stays.
    const input = el("nameInput");
    input.value = "Chinatown";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(1000);

    expect(el("stat").textContent).toContain(`0/${N} found`);
    expect(input.value).toBe("Chinatown");
  });

  it("finding all N opens the leaderboard end screen", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    for (const name of HOOD_NAMES) {
      if (boardOpened()) break;
      await typeName(name);
    }
    await flush();

    expect(boardOpened()).toBe(true);
  });

  it("the 10-minute timer expiring ends the round", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await vi.advanceTimersByTimeAsync(600 * 1000);
    await flush();

    expect(boardOpened()).toBe(true);
  });

  it("finishing records the play as mode:'name' with score = found count", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    for (const name of HOOD_NAMES) {
      if (boardOpened()) break;
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
  it("give up during a round opens the leaderboard end screen", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await typeName("Chinatown");
    el("nameGiveUp").click();
    await flush();

    expect(boardOpened()).toBe(true);
  });

  it("reveals the full map on finish: found and missed hoods all carry a label", async () => {
    const L = await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await typeName("Chinatown");
    await typeName("Nob Hill");
    el("nameGiveUp").click();
    await flush();

    // A found hood keeps its own label.
    expect(L.layerFor("Chinatown")._tooltip.content).toBe("Chinatown");
    // A hood never typed is now revealed on the map (missed → red + hover label).
    const missed = HOOD_NAMES.filter(n => n !== "Chinatown" && n !== "Nob Hill");
    for (const name of missed.slice(0, 2)) {
      const tip = L.layerFor(name)._tooltip;
      expect(tip).not.toBe(null);
      expect(tip.content).toBe(name);
    }
  });

  it("puts the full time used in the leaderboard subline on timer expiry", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await vi.advanceTimersByTimeAsync(600 * 1000);
    await flush();

    expect(lastBoard().subline).toContain("10:00");
  });

  it("puts the elapsed time used in the subline when giving up mid-round", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();

    await vi.advanceTimersByTimeAsync(5 * 1000);
    el("nameGiveUp").click();
    await flush();

    expect(lastBoard().subline).toContain("0:05");
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

  it("Go again from the board returns name mode to the pre-game panel", async () => {
    await bootQuiz();
    switchMode("name");
    el("nameStart").click();
    await typeName("Chinatown");
    el("nameGiveUp").click();
    await flush();

    lastBoard().onAgain();

    expect(el("namePregame").hidden).toBe(false);
    expect(el("namePlay").hidden).toBe(true);
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

  it("never finishes: the leaderboard never opens and recordPlay is never called", async () => {
    const L = await bootQuiz();
    switchMode("learn");

    HOOD_NAMES.slice(0, 5).forEach(n => L.fireHover(n));
    await vi.advanceTimersByTimeAsync(2000);

    expect(boardOpened()).toBe(false);
    expect(Profiles.recordPlay).not.toHaveBeenCalled();
  });
});

// ---- T5 ---------------------------------------------------------------------
describe("neighborhoods quiz — finish records + opens the leaderboard", () => {
  it("a logged-in finish records the play and opens the round leaderboard", async () => {
    const L = await bootQuiz();
    switchMode("find");
    Profiles.isLoggedIn.mockReturnValue(true);
    Profiles.recordPlay.mockResolvedValue({ status: "saved" });

    await playFindPerfect(L);
    await flush();

    expect(Profiles.recordPlay).toHaveBeenCalledWith({
      gameId: "sf-neighborhoods",
      mode: "find",
      score: ROUND,
      total: ROUND,
    });
    expect(boardOpened()).toBe(true);
    expect(lastBoard().variant).toBe("round");
  });

  it("a guest finish still records (captured for later login) and opens the board", async () => {
    const L = await bootQuiz();
    switchMode("find");
    Profiles.isLoggedIn.mockReturnValue(false);
    Profiles.recordPlay.mockReturnValue({ status: "pending" });

    await playFindPerfect(L);
    await flush();

    expect(Profiles.recordPlay).toHaveBeenCalledWith({
      gameId: "sf-neighborhoods",
      mode: "find",
      score: ROUND,
      total: ROUND,
    });
    expect(boardOpened()).toBe(true);
  });
});

// ---- T6 ---------------------------------------------------------------------
describe("neighborhoods quiz — chrome (tabs, restart, mount)", () => {
  it("activates the clicked mode tab and clears the others, resetting the round", async () => {
    const L = await bootQuiz();
    switchMode("find");

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
    switchMode("find");
    L.fireClick(el("pTarget").textContent);
    expect(el("stat").querySelector("b").textContent).toBe("1");

    el("restart").click();

    expect(el("pFb").textContent).toBe("");
    expect(el("stat").querySelector("b").textContent).toBe("0");
  });

  it("the leaderboard's Go again restarts the round after finishing", async () => {
    const L = await bootQuiz();
    switchMode("find");
    await playFindPerfect(L);
    expect(boardOpened()).toBe(true);

    const again = lastBoard().onAgain;
    expect(typeof again).toBe("function");
    again();

    expect(el("pFb").textContent).toBe("");
    expect(el("stat").querySelector("b").textContent).toBe("0");
    expect(el("pTarget").textContent).not.toBe("");
  });

  it("mounts the profile header inside #app", async () => {
    await bootQuiz();

    expect(Profiles.init).toHaveBeenCalled();
    const arg = Profiles.init.mock.calls.at(-1)[0];
    expect(arg.headerMount).toBe(el("profileMount"));
    expect(el("app").contains(arg.headerMount)).toBe(true);
  });
});
