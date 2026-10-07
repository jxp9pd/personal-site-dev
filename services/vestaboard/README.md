# Vestaboard Note

Public page: https://jpentakalos.com/tools/vestaboard.html

A vanilla HTML/CSS/JS composer previews exactly 3 rows × 15 columns and posts
the same character array to a Python gateway. nginx forwards `/api/vestaboard/`
to a loopback-only service. The gateway alone holds the API token and calls
Vestaboard's Cloud API. No npm production dependencies or database are required.

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
   **Sending enabled** only means a token is configured. **Accepted by Vestaboard**
   requires a successful API response. Physical delivery must be checked on the
   device; Wi-Fi, quiet hours, or other integrations can delay/replace a message.

Anyone can send, as requested. Each new message replaces the board's display.
Sends from this service are spaced by at least 15 seconds, including concurrent
visitors. The page does not display the board's current content or store messages.
The preview is the visitor's draft. A token is never needed to use the preview.

## Local preview

```sh
python3 services/vestaboard/server.py --preview fe-artifacts --port 8000
```

Open http://127.0.0.1:8000/tools/vestaboard.html. Without a token, the preview
works and sending is visibly disabled. The server serves only `fe-artifacts/`.
For local live sends, set `VESTABOARD_API_TOKEN` privately in the process
environment. Do not add the key to client JavaScript or commit an environment file.

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
- No automatic retries: a timeout can mean the upstream accepted the message.
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
