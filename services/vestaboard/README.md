# Vestaboard Note

Apps home: https://jpentakalos.com/tools/vestaboard/

Send a note page: https://jpentakalos.com/tools/vestaboard.html

Pomodoro page: https://jpentakalos.com/tools/pomodoro.html

NFL scores page: https://jpentakalos.com/tools/nfl.html

The Tools page links to the apps home. To add an app, append an entry to the
list in `fe-artifacts/tools/vestaboard/index.html` and link back to the hub
from the new page. The hub has its own stylesheet, `vestaboard-hub.css`, and
uses the shared layout and preview helpers to draw decorative board examples.
Set `data-preview` on an app's illustration to customize its message; the hub
does not call the gateway or send to the physical board.

A vanilla HTML/CSS/JS composer previews exactly 3 rows × 15 columns and posts
the same character array to a Python gateway. nginx forwards `/api/vestaboard/`
to a loopback-only service. The gateway alone holds the API token and calls
Vestaboard's Cloud API. No npm production dependencies or database are required.

## Shared code

`board.py` owns character encoding/validation, credentials, TLS, cloud sends,
and the shared cooldown. It has no dependency on the HTTP server or Pomodoro.
`server.py` wires one gateway instance into note routes, `pomodoro.py`, and `nfl.py`;
features should reuse that instance rather than create independent senders.

In `fe-artifacts/assets/js/`, `vestaboard-api.js` owns gateway requests and the
reusable `sendBoardMessage` helper. `vestaboard-preview.js` renders the tiles;
`vestaboard-layout.js` handles text layout. Page controllers import these
helpers and retain only their own form, countdown, and feedback behavior.

## Connect the Note

1. Install the Vestaboard app, sign in, and follow its **Add Vestaboard** pairing
   flow to connect the Note to Wi-Fi. Send a message in the official app first.
2. Open https://web.vestaboard.com and select that Note. In **API**, choose
   **Create New Token**, give it a name such as `Penta Projects`, enable **Write**,
   and copy the token. The mobile app also exposes tokens under
   **Settings → Advanced Settings**. No read permission is needed by this site.
3. From this repository on John's Mac, run:

   ```sh
   python3 scripts/configure-vestaboard.py
   ```

   Paste into the hidden prompt. It uses the personal SSH key to send the token
   over encrypted stdin and atomically saves it in `/etc/vestaboard-note.env`,
   owned by root with mode `0600`, outside the web root. It restarts the gateway.
   The token never appears in shell arguments, Git, frontend assets, or stdout.
4. Reload the public page, click **Send to the board**, and check the Note.
   An enabled **Send to the board** button means a token is configured. **Accepted by Vestaboard**
   requires a successful API response. Physical delivery must be checked on the
   device; Wi-Fi, quiet hours, or other integrations can delay/replace a message.

Anyone can send, as requested. Each new message replaces the board's display.
Sends from this service are spaced by at least 15 seconds, including concurrent
visitors. The page does not display the board's current content or store messages.
The preview is the visitor's draft. A token is never needed to use the preview.

## Pomodoro

The separate Pomodoro page runs one focus → break → done session. Anyone can
start, pause, resume, or stop the shared timer. Focus and break durations are
editable whole minutes (1–180 each), defaulting to 25 / 5. The page contains just
the board preview and timer controls. Active sessions show the same state to
every visitor; their durations stay fixed until a new session starts.

The Python gateway owns the clock and a background scheduler, so closing the
page, locking a phone, or losing the browser connection does not stop a session.
The website polls status every five seconds while visible and counts seconds
locally between polls. It reconnects when reopened and never sends individual
countdown updates from the browser.

- The Note shows a randomly chosen focus phrase that stays fixed for the
  session, whole minutes remaining (rounded up), and a shrinking 15-tile bar.
  Both time and bar update every five minutes during focus and every minute
  during break. Updates count from the start or resume of a phase, so a
  12-minute focus shows 12, 7, then 2 minutes. The website countdown still shows
  live seconds. Focus is violet; break is green with “TAKE A BREATHER.” Phase
  changes happen on time and update the message and colors
  together, making the physical shuffle the cue. No extra animation sends.
- Pause saves the exact remaining time and displays “PAUSED.” Resume continues
  that phase with the original focus phrase. Stop ends it with “TIMER STOPPED.”
  Normal completion leaves “ALL DONE.” Paused and terminal displays stay static.
- Notes remain independent: either can overwrite the other, and a note does
  not stop the timer. Both share the existing minimum 15-second cloud cooldown.
  Controls and transitions queue the latest timer display until that cooldown
  clears; missed frames are discarded, and board delays never extend a phase.
- The preview is the timer's intended display, not a readback of the physical
  board. Delivery feedback distinguishes pending, cloud-accepted, and failed
  updates. Timeouts are not retried for the same frame; the next scheduled update or
  explicit control can send the current display. Quiet hours still apply.
- Timer state lives in memory. Restarting the gateway ends the session; the
  last physical display remains until the next write. No persistence, session
  history, authentication, or note/timer conflict arbitration is added.

`GET /api/vestaboard/pomodoro` returns the current shared session and intended
character array without contacting Vestaboard. `POST` to the same path accepts
`{"action":"start","focusMinutes":25,"breakMinutes":5}` or an action of `pause`,
`resume`, or `stop`, with the same origin/body restrictions as note sends. A
successful command changes the timer; board delivery is asynchronous and
reported in the response's `delivery` field on subsequent status requests.

For a preview that cannot send to the physical board even if `.env` is configured:

```sh
VESTABOARD_API_TOKEN='' python3 services/vestaboard/server.py --preview fe-artifacts --port 8000
```

Open http://127.0.0.1:8000/tools/pomodoro.html. Duration controls and the board
preview work; starting a session requires a configured board. Tests use a fake
upstream and controlled clock to exercise complete sessions without live sends.

## NFL scores

The NFL page lists this week's games from ESPN's public scoreboard feed as
selectable bubbles grouped by kickoff day in the visitor's local time zone.
Each bubble shows team colors plus kickoff time or the score and live/final
status. The current week comes from the feed, with no hardcoded week or date;
the list automatically rolls over on a refresh, including while the page is
open. An older game can finish tracking without appearing in the new week's
bubbles. Select a game to preview it, then press **Track game** to start or switch the shared
scoreboard. Selection alone never writes to the board. Upcoming and live games
can be tracked; finished games can be previewed. Anyone can switch or stop the
shared selection, matching the existing apps.

- The Note shows the away team on the left and home team on the right, with
  primary/secondary colors approximated using the available tile colors. Scores
  sit underneath. A single orange tile beneath a team's score indicates
  possession; brown is not available on the Note. Missing possession information
  leaves that row blank rather than guessing. Quarter and game clock are omitted.
- An upcoming game displays `--` scores and its kickoff day/time in Pacific
  time. The website's game picker shows kickoff in the visitor's local time zone.
  Tracking switches to live scores and possession after the feed reports kickoff.
  Halftime, delays, and suspensions use a status label instead of possession.
- The server polls every three minutes and queues a board write only when the
  displayed score, possession, or status changes. Closing the browser does not
  stop tracking. The selected game is also fetched by its Eastern game-day date
  if it disappears from the current week's feed, including Monday-night games.
- A final score queues one `FINAL` display and ends tracking. Canceled and
  postponed games also end tracking with their status. The last display stays on
  the board. **Stop tracking** cancels pending writes and future game polling,
  leaving the physical display untouched; a write already in flight may finish.
- The same gateway and 15-second cooldown serve notes, Pomodoro, and NFL. There
  is no app priority or ownership arbitration: each can overwrite another.
  Queued updates coalesce to the newest frame; final delivery can wait for the
  cooldown after tracking ends. Ambiguous cloud failures are not retried for an
  unchanged frame. The preview is intended content, not physical readback.
- Feed outages retain the last known score, show a warning on the website,
  and retry after 30 seconds. Starting a new selection
  is disabled while the source is unavailable; Stop remains available. The feed
  is public and requires no API key, but is an unofficial interface and has no
  guaranteed update latency. No sports data token reaches the browser.

`GET /api/vestaboard/nfl` returns the cached game list, shared selection, exact
preview arrays, and source/delivery feedback. It requests a background refresh
when the list is stale; opening the picker does not perform a synchronous
upstream request or write to the board. The website checks gateway status every
five seconds while visible; this does not increase the sports polling frequency.
`POST` accepts `{"action":"track","gameId":"401872992"}` or
`{"action":"stop"}`, using the existing origin/body checks. Game IDs must come
from the current list; clients cannot supply URLs, scores, colors, or credentials.
State is in memory, like Pomodoro; restarting the gateway ends tracking.

The existing install script also copies `nfl.py`; rerun it after deploying gateway
changes. The local preview below supports browsing real games with board writes
disabled by setting `VESTABOARD_API_TOKEN=''`. NFL tests use fake scores and a fake
gateway to cover background polling, start/stop races, final delivery, rollover,
missing possession, outages, and shared delivery limits without live board sends.

## Local preview

```sh
python3 services/vestaboard/server.py --preview fe-artifacts --port 8000
```

Open http://127.0.0.1:8000/tools/vestaboard.html. Without a token, the preview
works and sending is visibly disabled. The server serves only `fe-artifacts/`.
For local live sends, copy `.env.example` to `.env` in the repository root and
set `VESTABOARD_API_TOKEN` there. The preview gateway loads it automatically on
startup. Keep `.env` outside `fe-artifacts/`, Git-ignored, and owner-only (`chmod
600 .env`). Restart the preview after changing it. An explicitly set process
environment variable takes precedence; setting it to an empty string disables
live sends even when `.env` contains a token. The loader supports plain or quoted
values and comments; it does not execute shell commands or expand variables.

Production continues to read `/etc/vestaboard-note.env` via systemd. The local
`.env` is never deployed or committed. Do not add the key to client JavaScript.
On macOS, if Python has no CA certificates configured, the gateway uses the
existing `/etc/ssl/cert.pem` bundle. Explicit `SSL_CERT_FILE` / `SSL_CERT_DIR`
settings take precedence, and TLS certificate verification remains enabled.

## Production install / update

The site's existing GitHub Actions deployment publishes `fe-artifacts/` on a
push to `main`. After deploying changes to the gateway, run on the Hetzner VM:

```sh
sudo bash /var/www/personal-site-dev/services/vestaboard/install.sh
```

This copies the gateway into `/opt/vestaboard-note`, installs its sandboxed
systemd unit, adds an nginx snippet alongside the existing fantasy dashboard,
checks nginx configuration, then starts/restarts the service and reloads nginx.
It preserves `/etc/vestaboard-note.env`. The original nginx config is saved at
`/etc/nginx/site.conf.before-vestaboard` on first install. Token setup can happen
after installation; missing credentials leave the endpoint safely unconfigured.

```sh
systemctl status vestaboard-note
journalctl -u vestaboard-note -n 30
curl http://127.0.0.1:8787/api/vestaboard/status
```

Re-run the private setup script to replace an expired/revoked token. To stop
sending immediately, `sudo systemctl stop vestaboard-note`. Revoke the token in
Vestaboard's app if needed. To uninstall, stop/disable that service and remove
the Vestaboard include from nginx's `site.conf`, then `nginx -t` and reload.
Do not restore the whole old nginx file if other site changes were made later.

## Boundaries

- This is intentionally a public write endpoint with no access code. Origin
  checks prevent casual cross-site browser submissions, not scripted clients.
- nginx bounds request size and traffic; the gateway validates the exact Note
  dimensions and allowed character codes, and serializes sends with a shared
  cooldown. One process owns this board. Cooldown state resets on restart.
- Quiet hours are respected: clients cannot forward a `forced` override.
- No retries of ambiguous sends: a timeout can mean the upstream accepted the
  message. The timer can defer a definitely rejected, rate-limited frame.
- The API URL is fixed. Client requests cannot choose a destination or token.
- No current-message read endpoint, analytics, or message history is added.

## Verification

```sh
npm test
python3 -m unittest discover -s services/vestaboard -p 'test_*.py'
```

Tests mock the upstream API; they do not change the physical board. Coverage
includes character mapping, overflow, Unicode, blank input, HTTP validation,
simultaneous sends, upstream failures, secret isolation, and rate limiting.
Pomodoro tests also cover background execution, exact pause/resume timing,
single-session completion, stable messages, phase-specific update intervals, independent
note writes, delayed/rate-limited delivery, and browser reconnection/races.

Cloud transport is tested in `test_board.py`; common HTTP validation and shared
note/timer delivery are tested in `test_server.py`. `test_pomodoro.py` uses a
fake gateway to focus on scheduling rather than repeat cloud contract tests.
Browser request errors are covered once in `vestaboard-api.test.js`; connection
checks use the same parameterized scenario for all three pages. Page-specific tests
retain their distinct interactions and timer synchronization checks.

Official documentation checked October 7, 2026:
- https://docs.vestaboard.com/docs/read-write-api/authentication
- https://docs.vestaboard.com/docs/read-write-api/endpoints
- https://docs.vestaboard.com/docs/characterCodes

Current endpoint: `POST https://cloud.vestaboard.com/`, header
`X-Vestaboard-Token`, body `{"characters": [[...], [...], [...]]}`.
The live API returns `"status": "success"` (verified with a real Note on October
7, 2026); the documentation examples use `"status": "ok"`. Both are accepted.
Code `62` is a heart on the Note
(a degree sign on the Flagship). The cloud docs recommend no more than one
message every 15 seconds.
