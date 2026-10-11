# Vestaboard Note

Public apps for a 3 × 15 Vestaboard Note:

- [Apps home](https://jpentakalos.com/tools/vestaboard/)
- [Leave a Note](https://jpentakalos.com/tools/vestaboard.html)
- [Pomodoro](https://jpentakalos.com/tools/pomodoro.html)
- [NFL scores](https://jpentakalos.com/tools/nfl.html)
- [Fantasy football](https://jpentakalos.com/tools/fantasy.html)

Vanilla HTML/CSS/JS pages call a Python gateway. nginx proxies
`/api/vestaboard/` to the loopback-only service, which holds the token and
calls Vestaboard's Cloud API. Optional Supabase storage keeps private Leave a
Note history; there are no npm production dependencies.

## Shared behavior

- **UI commands take precedence.** Sending a note, using a Pomodoro control,
  tracking an NFL game, or starting Fantasy silently stops every other app and
  cancels its queued displays. Displaced apps stay stopped until restarted.
- Previews, status reads, invalid commands, and NFL/Fantasy Stop do not take
  ownership. Notes rejected for validation, missing credentials, or rate limits
  also leave ownership unchanged. An ambiguous note failure stops other apps
  because the note may have reached the board.
- All apps share a minimum **15-second cooldown** and respect quiet hours.
  Clients cannot request a `forced` override. Definite rate limits defer
  background delivery; ambiguous failures do not automatically retry an
  unchanged frame. An in-flight cloud write finishes before a new command takes
  effect; stale worker frames cannot write afterward.
- Background sessions continue when the browser closes. Pages poll status every
  five seconds while visible. State is in memory: restarting the gateway ends
  sessions and tracking, while the physical display remains until another write.
- Previews show intended content, not physical readback. Cloud acceptance does
  not confirm physical delivery; Wi-Fi, quiet hours, or other integrations may
  delay or replace a message. Configured history records Leave a Note submissions;
  automated timer and sports updates are excluded.
- Controls are public: anyone can send or change the shared apps. Origin checks
  are not authentication. nginx limits request size and traffic; the gateway
  validates input and uses fixed upstream destinations. Run one gateway process
  per board; cooldown state resets on restart.

## Apps

### Leave a Note

The composer previews a draft and sends the same character array to the board.
Previewing needs no token; sending replaces the current display.

### Pomodoro

Runs one focus → break → done cycle. Durations are whole minutes from 1–180,
defaulting to 25/5. The gateway owns the clock; the browser shows live seconds
between status polls.

- Focus uses violet tiles and one random phrase fixed for the session. Break
  uses green tiles and “TAKE A BREATHER.” Whole minutes remaining round up;
  the 15-tile progress bar shrinks with time.
- Board updates occur every five focus minutes and every break minute, counted
  from start or resume. Phase changes occur on time even if delivery is delayed;
  queued frames coalesce to the latest display.
- Pause preserves exact remaining time and shows “PAUSED.” Resume continues
  that phase. Explicit Stop writes “TIMER STOPPED”; completion writes “ALL DONE.”
  Another app taking ownership stops the timer silently.

### NFL scores

Select a game to preview it, then **Track game** to start or switch tracking.
Upcoming and live games are trackable; finished games remain previewable.
ESPN's public feed supplies the current week, which rolls over automatically.

- Away team appears left, home team right, with scores and an orange possession
  tile. Missing possession stays blank; quarter and clock are omitted.
  Upcoming games show `--` scores and Pacific kickoff time. The website picker
  uses the visitor's local time zone. Halftime/delays/suspensions show a status.
- Polls every three minutes and writes only changed frames. A selected game
  that leaves the week's feed is fetched by its Eastern game-day date.
- Final, canceled, and postponed games queue their last display and end
  tracking. **Stop tracking** cancels pending writes and leaves the board alone.
- Feed failures retain the last data, show a warning, and retry after 30 seconds.
  New selections are disabled during an outage; Stop remains available. The
  feed is unofficial and has no guaranteed update latency.

### Fantasy football

Shows two Sleeper matchups, your score first, rounded to whole points; bye weeks
show `BYE`. Each league needs a URL, username, and unique 1–3 character label.
Defaults use `pentakalos` in Show Me Your TDs (`TD`) and Shmeed League (`SH`).
The server resolves league membership, co-owners, and matchups.

- **Preview matchups** works without a board token. **Start tracking** polls
  scores and plays every 15 seconds, writing scores when rounded values change.
  **Stop tracking** clears alerts and leaves the board alone. Stop before
  changing leagues. The current week rolls forward automatically.
- **Big Plays** require a starter to earn **at least 3 standard half-PPR points
  on one play**: 0.5 per catch, 1 per 10 rushing/receiving yards, 1 per 25 passing
  yards, 6 per rushing/receiving/return touchdown, 4 per passing touchdown, and
  −2 per interception thrown or fumble lost. A 30-yard completion qualifies its
  receiver (3.5 points), but its QB earns only 1.2. Each starter qualifies separately;
  bench players, opponents, tacklers, and plays before tracking began are excluded.
  Plays are deduplicated across players/leagues. Alerts run chronologically for
  30 seconds each, starting after the delivery attempt, then the scores return.
- Metadata/rosters cache for one minute and the player catalog for a day;
  starting lineups come from fresh matchups. Idle previews refresh at most once
  per minute when requested. Outages preserve scores and show warnings; play
  outages do not stop score updates.
- League data uses Sleeper's documented API. Alerts use its undocumented
  `plays/nfl/recent` endpoint, limited to the newest 1,000 plays. Prolonged
  outages may miss events. No sports credentials are needed. The public API
  supplies no win probabilities, so the third row stays blank.

## Connect the Note

1. Pair the Note with Wi-Fi in the official Vestaboard app and send a message
   there first.
2. At [web.vestaboard.com](https://web.vestaboard.com), select the Note, open
   **API → Create New Token**, and enable **Write**. The mobile app also offers
   tokens under **Settings → Advanced Settings**. Read permission is unnecessary.
3. From this repository on John's Mac, run:

   ```sh
   python3 scripts/configure-vestaboard.py
   ```

   The hidden prompt sends the token over SSH, saves it in
   `/etc/vestaboard-note.env` (root-owned, mode `0600`), and restarts the gateway.
   It keeps the token out of command arguments, Git, frontend assets, and stdout.
4. Reload Leave a Note, send a message, and check the device. An enabled Send
   button means credentials are configured; “Accepted by Vestaboard” means the
   Cloud API accepted the write.

## Local preview

From the repository root, start with physical sends disabled:

```sh
VESTABOARD_API_TOKEN='' python3 services/vestaboard/server.py --preview fe-artifacts --port 8000
```

Open [the hub](http://127.0.0.1:8000/tools/vestaboard/) or any app's usual
`/tools/*.html` path. Note and Fantasy previews and NFL browsing work without
a token; starting background sessions requires one. Sports previews use real
feeds. The server serves only `fe-artifacts/`.

For live local sends, copy `.env.example` to the repository root's `.env`, set
`VESTABOARD_API_TOKEN`, run `chmod 600 .env`, and restart without the empty-token
override. Explicit environment values take precedence over `.env`; an empty
token disables sends even when `.env` has one. Keep `.env` outside the web root
and Git. Production reads the systemd environment file instead. TLS verification
stays enabled; explicit `SSL_CERT_FILE` / `SSL_CERT_DIR` settings take precedence
over the macOS system certificate fallback.

## Private message history

Supabase table `vestaboard_messages` stores Leave a Note submissions: original
composer text, the exact character grid, a server-generated UTC timestamp,
sender IP, and delivery outcome. Legacy clients that send only a grid have no
original text. Outcomes distinguish cloud acceptance, definite rejection, and
unknown delivery. Valid requests rejected by the gateway's cooldown are recorded
too; requests blocked by nginx never reach history storage.

1. Apply `supabase/migrations/0009_vestaboard_messages.sql` to the site's Supabase
   project. Row-level security and explicit grants restrict access to the server's
   service role; browser users cannot read or write the table directly.
2. Run `python3 scripts/configure-vestaboard.py --history` on John's Mac. Enter
   the project URL and a secret/service-role key at the hidden prompt. This writes
   `/etc/vestaboard-history.env` (root-owned, mode `0600`) separately from the board
   token. Install the updated gateway and frontend to enable capture.
3. View the private table in Supabase, ordered by `submitted_at`, or group by
   `sender_ip` for a report. IPs may be shared or change over time.

nginx accepts `CF-Connecting-IP` only from the official ranges in
`cloudflare-real-ip.conf`, then overwrites `X-Real-IP` for the local gateway.
Direct connections retain their actual socket IP; a client-supplied sender IP
in the request body is ignored. Maintain the trusted ranges from Cloudflare's
official list when they change.

The initial record is saved before sending. If storage is unavailable, the
request fails without sending or taking ownership. If the later outcome update
fails, the saved message remains `unknown` and the board write is not retried.
History is disabled when both Supabase settings are absent. Local previews can
use `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`; omit them for previews
that should not write history. Existing unrecorded message text cannot be recovered.

## API

Routes share the `/api/vestaboard/` prefix. POST requests use JSON and the same
origin, body-size, and validation checks. For actions without other fields, send
an object such as `{"action":"stop"}`.

| Route | GET | POST |
| --- | --- | --- |
| `status` | Gateway configuration and cooldown | — |
| `messages` | — | `{"characters":[[…],[…],[…]],"message":"Original text"}` |
| `pomodoro` | Session, preview, delivery | `{"action":"start","focusMinutes":25,"breakMinutes":5}`; or `pause`, `resume`, `stop` |
| `nfl` | Games, selection, previews, source/delivery status | `{"action":"track","gameId":"…"}`; or `stop` |
| `fantasy` | Leagues, matchups, preview, alerts, source/delivery status | `{"action":"start","leagues":[…]}`; or `preview` with leagues, or `stop` |

Each Fantasy league object contains `url`, `username`, and `label`. NFL IDs must
come from the current game list. Clients cannot supply scores, fetch destinations,
or credentials. App commands schedule asynchronous work; poll status for source
and delivery results. Status reads use cached data and may request a background
sports refresh without writing to the board.

## Shared code and adding apps

| Module | Responsibility |
| --- | --- |
| `board.py` | Encoding, validation, credentials, TLS, cloud transport, cooldown |
| `apps.py` | `BoardController` ownership and `BoardApp` command/delivery contract |
| `history.py` | Private Note submission records and delivery outcomes |
| `server.py` | HTTP routes and shared-controller wiring |
| `pomodoro.py`, `nfl.py`, `fantasy.py` | App state, scheduling, feeds, rendering |

To add a background app:

1. Inherit `BoardApp` and pass the shared controller to `super().__init__`.
2. Implement `_command(body)`, validating before mutation. Successful commands
   claim ownership by default; put non-writing actions in `passive_actions`.
3. Implement silent `deactivate()`: stop activity, increment the revision, and
   clear queued displays. Also increment the revision when commands replace or
   cancel work.
4. Capture the revision with each display and call
   `self.deliver(revision, characters)` outside the app state lock. Never call
   `gateway.send` directly from a feature.
5. Wire the app in `server.py` and copy its module in `install.sh`. Add its page
   to `fe-artifacts/tools/vestaboard/index.html` and link back to the hub.

Acquire the controller lock before app state locks; never call the controller
while holding an app state lock. Keep sports I/O outside the controller lock.
This lets new apps inherit precedence without pairwise stop logic.

Frontend helpers in `fe-artifacts/assets/js/` share gateway requests
(`vestaboard-api.js`), tile rendering (`vestaboard-preview.js`), and text layout
(`vestaboard-layout.js`). Page controllers own their forms and feedback. The hub
uses decorative previews only; it never calls the gateway.

## Production install / update

GitHub Actions publishes `fe-artifacts/` on pushes to `main`. Gateway changes
also require running this on the Hetzner VM after deploying the repository:

```sh
sudo bash /var/www/personal-site-dev/services/vestaboard/install.sh
```

The script installs into `/opt/vestaboard-note`, updates systemd/nginx, validates
nginx, and restarts the gateway. It preserves both private environment files and saves
the original nginx config at `/etc/nginx/site.conf.before-vestaboard` on first
install. Missing credentials leave sending disabled.

```sh
systemctl status vestaboard-note
journalctl -u vestaboard-note -n 30
curl http://127.0.0.1:8787/api/vestaboard/status
```

Replace tokens with `scripts/configure-vestaboard.py`. Stop the service with
`sudo systemctl stop vestaboard-note`. To uninstall, stop/disable the service,
remove its include from nginx's `site.conf`, validate with `nginx -t`, and reload.
Avoid restoring the entire old config over later site changes.

## Verification and references

```sh
npm test
python3 -m unittest discover -s services/vestaboard -p 'test_*.py'
```

Tests use fake upstreams and board delivery; they never write to the device.
Shared suites cover transport/HTTP validation, ownership, worker lifecycle,
delivery policy, and browser reconnection/races. Feature suites cover timing,
feed parsing, rollover, alerts, rendering, and forms. Backend fixtures live in
`test_helpers.py`; browser fixtures in `tests/helpers/vestaboard.js`.

Cloud writes use `POST https://cloud.vestaboard.com/`, header
`X-Vestaboard-Token`, and a `characters` array. Both `success` and `ok` response
statuses are accepted. Character code `62` is a heart on the Note (a degree
sign on the Flagship).

- Vestaboard: [Authentication](https://docs.vestaboard.com/docs/read-write-api/authentication),
  [endpoints](https://docs.vestaboard.com/docs/read-write-api/endpoints),
  [character codes](https://docs.vestaboard.com/docs/characterCodes)
- [Sleeper API](https://docs.sleeper.com/)
