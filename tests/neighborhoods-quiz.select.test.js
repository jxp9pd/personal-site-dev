// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Keep the Supabase-backed data + auth layers out of the DOM test.
vi.mock("../fe-artifacts/assets/js/dataClient.js", () => ({
  fetchQuiz: vi.fn(),
  fetchQuizList: vi.fn(async () => [
    { slug: "sf-neighborhoods", name: "San Francisco", description: "SF" },
    { slug: "seattle-neighborhoods", name: "Seattle", description: "Seattle" },
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

import { Profiles } from "../fe-artifacts/assets/js/profiles.js";
import { start } from "../fe-artifacts/assets/js/neighborhoods-quiz.js";

// Minimal version of the page markup the select path touches.
function renderPageSkeleton() {
  document.body.innerHTML = `
    <section id="select">
      <div class="select-head">
        <div id="selectProfileMount"></div>
      </div>
      <div class="city-grid" id="cityGrid"></div>
    </section>
    <div id="app">
      <div id="profileMount"></div>
    </div>`;
}

describe("neighborhoods quiz — city select screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renderPageSkeleton();
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
});
