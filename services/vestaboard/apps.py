"""Exclusive board ownership shared by UI commands and background workers."""
import threading

from board import DEFINITE_REJECTIONS, not_connected


class BoardController:
    def __init__(self, gateway):
        self.gateway = gateway
        self.lock = threading.RLock()
        self.apps = []
        self.owner = None

    def register(self, app):
        self.apps.append(app)

    def _take_over(self, owner):
        self.owner = owner
        for app in self.apps:
            if app is not owner:
                app.deactivate()

    def command(self, app, body):
        # Commands and cloud writes share this lock. An in-flight write finishes
        # before a new command takes ownership; a prepared old frame is rejected.
        # Always acquire this lock before any app state lock, never the reverse.
        with self.lock:
            status, result = app._command(body)
            if status == 200 and body['action'] not in app.passive_actions:
                self._take_over(app)
            return status, result

    def send_note(self, characters):
        with self.lock:
            status, result = self.gateway.send(characters)
            # Definite rejections do not displace an app. Ambiguous cloud
            # failures may have sent the note.
            if status not in DEFINITE_REJECTIONS:
                self._take_over(None)
            return status, result

    def deliver(self, app, revision, characters):
        with self.lock:
            if self.owner is not app or app.revision != revision:
                return 409, {'error': 'Another command has replaced this board update.'}
            return self.gateway.send(characters)


class BoardApp:
    """Inherit UI precedence; implement _command and a silent deactivate hook.

    Background apps implement tick() and send frames through _attempt, which
    captures the revision with each frame and calls deliver outside the app's
    state lock. Background delivery never acquires ownership by itself.
    """
    passive_actions = frozenset()
    name = 'board-app'
    # Longer than one Cloud send (10s timeout). After close(), _attempt sends
    # nothing new, so a tick still waiting on a feed cannot write later.
    join_seconds = 12

    def __init__(self, controller):
        self.controller = controller
        self.gateway = controller.gateway
        self.lock = threading.Lock()
        self.wake, self.shutdown = threading.Event(), threading.Event()
        self.worker = None
        self.revision = 0
        self.last_attempt = None
        self.delivery = {'status': 'idle'}
        controller.register(self)

    @property
    def configured(self):
        return bool(self.gateway.token)

    def require_board(self, hint='Please try again later.'):
        """Return the 503 reply for commands that need a board token, else None."""
        return None if self.configured else not_connected(hint)

    def command(self, body):
        return self.controller.command(self, body)

    def deliver(self, revision, characters):
        return self.controller.deliver(self, revision, characters)

    def deactivate(self):
        raise NotImplementedError('Apps must cancel their activity without sending a frame.')

    def _attempt(self, revision, key, characters):
        """Send one prepared frame unless the shared cooldown defers it.

        A definite 429 or a superseded revision keeps the latest frame pending.
        Any other outcome records the attempt: an ambiguous timeout is never
        retried for the same frame. A changed frame or a command sends again.
        """
        if self.gateway.status()['retryAfter'] or self.shutdown.is_set():
            return
        status, result = self.deliver(revision, characters)
        with self.lock:
            if revision != self.revision or status == 429:
                return
            self.last_attempt = key
            self.delivery = ({'status': 'accepted'} if status == 200 else
                             {'status': 'error', 'error': result.get('error', 'Board update failed.')})
            self._attempted(key)

    def _attempted(self, key):
        """Called with the app lock held after a frame's delivery was attempted."""

    def start_worker(self):
        def run():
            while not self.shutdown.is_set():
                self.wake.clear()
                self.tick()
                self.wake.wait(0.5)
        self.worker = threading.Thread(target=run, name=self.name, daemon=True)
        self.worker.start()

    def close(self):
        self.shutdown.set()
        self.wake.set()
        if self.worker:
            self.worker.join(timeout=self.join_seconds)
