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

describe("neighborhoods quiz — find mode (perfect round)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("drives a full perfect FIND round to a saved done screen", async () => {
    const L = await bootQuiz();

    expect(document.getElementById("pTarget").textContent).not.toBe("");
    await playFindPerfect(L);

    expect(doneShown()).toBe(true);
    expect(document.getElementById("doneTitle").textContent.trim()).not.toBe("");
    expect(document.getElementById("doneScore").textContent).toContain(`${N}/${N}`);

    expect(Profiles.recordPlay).toHaveBeenCalledWith({
      gameId: "sf-neighborhoods",
      mode: "find",
      score: N,
      total: N,
    });
  });
});
