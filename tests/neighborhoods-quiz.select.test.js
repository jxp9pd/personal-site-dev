// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Keep the Supabase-backed data + auth layers out of the DOM test.
vi.mock("../fe-artifacts/assets/js/dataClient.js", () => ({
  fetchQuiz: vi.fn(),
  fetchQuizList: vi.fn(async () => [
    { slug: "sf-neighborhoods", name: "San Francisco", description: "SF", artSvg: '<svg data-city="sf"></svg>' },
    { slug: "seattle-neighborhoods", name: "Seattle", description: "Seattle", artSvg: null },
  ]),
}));

vi.mock("../fe-artifacts/assets/js/profiles.js", () => ({
  Profiles: {
    init: vi.fn().mockResolvedValue(undefined),
    recordPlay: vi.fn().mockResolvedValue({ status: "pending" }),
    isLoggedIn: () => false,
    promptLogin: vi.fn(),
  },
}));

import { loadPage } from "./helpers/loadPage.js";
import { Profiles } from "../fe-artifacts/assets/js/profiles.js";
import { start } from "../fe-artifacts/assets/js/neighborhoods-quiz.js";

describe("neighborhoods quiz — city select screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadPage();
    // No ?city= => the city selector renders.
    window.history.replaceState({}, "", "/games/neighborhoods-quiz.html");
  });

  it("shows the selector and mounts the auth/profile header on it", async () => {
    await start();

    expect(document.getElementById("select").style.display).toBe("flex");

    // Bug 1: the profile/login button must be reachable from the selector,
    // not only from inside an in-progress game.
    expect(Profiles.init).toHaveBeenCalledTimes(1);
    const arg = Profiles.init.mock.calls[0][0];
    expect(arg.headerMount).toBeInstanceOf(HTMLElement);
    expect(document.getElementById("select").contains(arg.headerMount)).toBe(true);
  });

  it("renders the landmark art layer only when a quiz has artSvg", async () => {
    await start();

    const cards = document.querySelectorAll("#cityGrid .city-card");
    expect(cards).toHaveLength(2);

    const [sf, seattle] = cards;
    // SF has art: the art layer is present and holds the inlined SVG.
    const sfArt = sf.querySelector(".art");
    expect(sfArt).not.toBeNull();
    expect(sfArt.querySelector("svg")).not.toBeNull();
    // Seattle has no art: just the centered name, no art layer.
    expect(seattle.querySelector(".art")).toBeNull();
    expect(seattle.querySelector(".name").textContent).toBe("Seattle");
  });
});
