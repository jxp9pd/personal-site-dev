"""Lock drivers. Each exposes `name`, `state()`, `lock()` and `unlock()`."""
import threading


class LockError(Exception):
    """The lock did not confirm the command. Message is safe to show users."""


class MockLock:
    """In-memory stand-in used until real hardware is connected."""
    name = 'mock'

    def __init__(self, state='locked'):
        self._state = state
        self._guard = threading.Lock()

    def state(self):
        return self._state

    def lock(self):
        with self._guard:
            self._state = 'locked'

    def unlock(self):
        with self._guard:
            self._state = 'unlocked'


def lock_from_environment(value):
    """`value(name)` reads one setting; DOOR_LOCK_DRIVER picks `mock` (default) or `seam`."""
    name = (value('DOOR_LOCK_DRIVER') or 'mock').lower()
    if name == 'mock':
        return MockLock()
    if name == 'seam':
        from seam import SeamLock
        return SeamLock(value('SEAM_API_KEY'), value('SEAM_DEVICE_ID'))
    raise ValueError(f'Unknown DOOR_LOCK_DRIVER {name!r}; use mock or seam.')
