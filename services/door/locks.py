"""Lock drivers. Each exposes `name`, `state()`, `lock()`, `unlock()`, and keypad codes:
`list_codes()`, `create_code(name, starts_at, ends_at, code)` -> code id, `delete_code(code_id)`,
plus `list_events()`. Codes are dicts with id, name, code, starts_at and ends_at (ISO strings);
events are dicts with at, action ('lock' or 'unlock') and code_id (or None)."""
from datetime import datetime, timezone
import threading
from uuid import uuid4


class LockError(Exception):
    """The lock did not confirm the command. Message is safe to show users."""


class MockLock:
    """In-memory stand-in used until real hardware is connected."""
    name = 'mock'

    def __init__(self, state='locked', clock=lambda: datetime.now(timezone.utc)):
        self._state, self.clock = state, clock
        self.codes, self.events = {}, []
        self._guard = threading.Lock()

    def state(self):
        return self._state

    def _set(self, state):
        with self._guard:
            self._state = state
            self.events.append({'at': self.clock().isoformat(), 'action': state[:-2], 'code_id': None})

    def lock(self):
        self._set('locked')

    def unlock(self):
        self._set('unlocked')

    def list_codes(self):
        now = self.clock().isoformat()
        with self._guard:
            return [{'id': code_id, **code} for code_id, code in self.codes.items() if code['ends_at'] > now]

    def create_code(self, name, starts_at, ends_at, code):
        code_id = str(uuid4())
        with self._guard:
            self.codes[code_id] = {'name': name, 'code': code, 'starts_at': starts_at, 'ends_at': ends_at}
        return code_id

    def delete_code(self, code_id):
        with self._guard:
            self.codes.pop(code_id, None)

    def list_events(self):
        with self._guard:
            return list(reversed(self.events[-50:]))


def lock_from_environment(value):
    """`value(name)` reads one setting; DOOR_LOCK_DRIVER picks `mock` (default) or `seam`."""
    name = (value('DOOR_LOCK_DRIVER') or 'mock').lower()
    if name == 'mock':
        return MockLock()
    if name == 'seam':
        from seam import SeamLock
        return SeamLock(value('SEAM_API_KEY'), value('SEAM_DEVICE_ID'))
    raise ValueError(f'Unknown DOOR_LOCK_DRIVER {name!r}; use mock or seam.')
