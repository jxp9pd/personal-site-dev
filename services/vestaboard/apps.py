"""Exclusive board ownership shared by UI commands and background workers."""
import threading


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
            # Validation, missing credentials, and definite rate limits do not
            # displace an app. Ambiguous cloud failures may have sent the note.
            if status not in (400, 429, 503):
                self._take_over(None)
            return status, result

    def deliver(self, app, revision, characters):
        with self.lock:
            if self.owner is not app or app.revision != revision:
                return 409, {'error': 'Another command has replaced this board update.'}
            return self.gateway.send(characters)


class BoardApp:
    """Inherit UI precedence; implement _command and a silent deactivate hook.

    Capture the revision with each frame and call deliver outside the app's
    state lock. Background delivery never acquires ownership by itself.
    """
    passive_actions = frozenset()

    def __init__(self, controller):
        self.controller = controller
        self.gateway = controller.gateway
        controller.register(self)

    def command(self, body):
        return self.controller.command(self, body)

    def deliver(self, revision, characters):
        return self.controller.deliver(self, revision, characters)

    def deactivate(self):
        raise NotImplementedError('Apps must cancel their activity without sending a frame.')
