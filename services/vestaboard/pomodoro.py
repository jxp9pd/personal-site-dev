"""One shared Pomodoro, driven by a server clock rather than an open browser."""
import math
import random
import threading
import time

from board import BLANK, GREEN, VIOLET, WHITE, text_row


FOCUS_MESSAGES = (
    'ONE THING', 'YOU GOT THIS', 'MAKE SOME SPACE', 'FIND YOUR FLOW',
    'BIT BY BIT', 'STAY WITH IT', 'HERE & NOW', 'KEEP IT SIMPLE',
)
BREAK_MESSAGE = 'TAKE A BREATHER'


def board_frame(state, phase, remaining, duration, focus_message):
    """Render the sampled countdown so time and progress always update together."""
    if state in ('completed', 'stopped'):
        done = state == 'completed'
        color = GREEN if done else WHITE
        return [text_row('ALL DONE' if done else 'TIMER STOPPED'),
                [color] + text_row('NICE WORK' if done else 'TAKE A BREATH', 13) + [color],
                [color, color, BLANK, WHITE, BLANK] * 3]
    minutes = max(1, math.ceil(remaining / 60))
    color = WHITE if state == 'paused' else VIOLET if phase == 'focus' else GREEN
    message = 'PAUSED' if state == 'paused' else focus_message if phase == 'focus' else BREAK_MESSAGE
    filled = min(15, max(1, math.ceil(15 * minutes * 60 / duration)))
    return [text_row(message),
            [color] + text_row(f'{phase.upper()} {minutes} MIN', 13) + [color],
            [color] * filled + [BLANK] * (15 - filled)]


class Pomodoro:
    def __init__(self, gateway, clock=time.monotonic, choose=random.choice):
        self.gateway = gateway
        self.clock = clock
        self.choose = choose
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.shutdown = threading.Event()
        self.worker = None
        self.state = 'idle'
        self.phase = 'focus'
        self.focus_minutes = 25
        self.break_minutes = 5
        self.focus_message = FOCUS_MESSAGES[0]
        self.deadline = 0
        self.frozen_remaining = 0
        self.update_anchor_remaining = 0
        self.revision = 0
        self.last_attempt = None
        self.delivery = {'status': 'idle'}

    def _advance(self, now):
        if self.state != 'running' or now < self.deadline:
            return
        if self.phase == 'focus':
            self.phase = 'break'
            # Keep the planned boundary even after a delayed scheduler wakeup.
            self.deadline += self.break_minutes * 60
            self.update_anchor_remaining = self.break_minutes * 60
            self.revision += 1
        if now >= self.deadline:
            self.state = 'completed'
            self.revision += 1

    def _snapshot(self, now):
        self._advance(now)
        if self.state == 'running':
            remaining = max(0, self.deadline - now)
        elif self.state == 'paused':
            remaining = self.frozen_remaining
        else:
            remaining = self.focus_minutes * 60 if self.state == 'idle' else 0
        duration = (self.focus_minutes if self.phase == 'focus' else self.break_minutes) * 60
        display_remaining = remaining
        if self.state == 'running':
            interval = 300 if self.phase == 'focus' else 60
            # Count intervals from start/resume, not round-number minutes left:
            # a 12-minute focus shows 12, 7, 2, then transitions on time.
            elapsed = max(0, self.update_anchor_remaining - remaining)
            display_remaining = self.update_anchor_remaining - math.floor(elapsed / interval) * interval
        characters = board_frame(self.state, self.phase, display_remaining, duration, self.focus_message)
        key = (self.revision, tuple(code for row in characters for code in row))
        delivery = self.delivery if key == self.last_attempt or self.state == 'idle' else {'status': 'pending'}
        return {'configured': bool(self.gateway.token), 'state': self.state, 'phase': self.phase,
                'focusMinutes': self.focus_minutes, 'breakMinutes': self.break_minutes,
                'focusMessage': self.focus_message, 'remainingSeconds': remaining,
                'characters': characters, 'delivery': dict(delivery)}, key

    def status(self):
        with self.lock:
            return self._snapshot(self.clock())[0]

    def command(self, body):
        if not isinstance(body, dict) or body.get('action') not in ('start', 'pause', 'resume', 'stop'):
            return 400, {'error': 'Choose start, pause, resume, or stop.'}
        action = body['action']
        if action == 'start':
            focus, rest = body.get('focusMinutes'), body.get('breakMinutes')
            if any(type(value) is not int or not 1 <= value <= 180 for value in (focus, rest)):
                return 400, {'error': 'Focus and break must each be a whole number from 1 to 180 minutes.'}
            if not self.gateway.token:
                return 503, {'error': 'The board is not connected yet. Please try again later.'}
        with self.lock:
            now = self.clock()
            self._advance(now)
            if action == 'start':
                self.focus_minutes, self.break_minutes = focus, rest
                self.focus_message = self.choose(FOCUS_MESSAGES)
                self.phase, self.state = 'focus', 'running'
                self.deadline = now + focus * 60
                self.update_anchor_remaining = focus * 60
            elif action == 'pause' and self.state == 'running':
                self.frozen_remaining = max(0, self.deadline - now)
                self.state = 'paused'
            elif action == 'resume' and self.state == 'paused':
                self.deadline = now + self.frozen_remaining
                self.update_anchor_remaining = self.frozen_remaining
                self.state = 'running'
            elif action == 'stop' and self.state in ('running', 'paused'):
                self.state = 'stopped'
            else:
                return 409, {'error': 'The session has changed. Refresh its status and try again.'}
            self.revision += 1
            snapshot = self._snapshot(now)[0]
        self.wake.set()
        return 200, snapshot

    def tick(self):
        """Send only the latest frame; never replay missed updates or queued controls."""
        with self.lock:
            snapshot, key = self._snapshot(self.clock())
            if self.state == 'idle' or key == self.last_attempt:
                return
        # Manual notes still use this same gateway independently. Its cooldown
        # serializes physical writes without reserving the board for the timer.
        if self.gateway.status()['retryAfter']:
            return
        status, result = self.gateway.send(snapshot['characters'])
        with self.lock:
            if status == 429:
                # Definitely rejected: keep only the latest frame pending.
                return
            self.last_attempt = key
            self.delivery = ({'status': 'accepted'} if status == 200 else
                             {'status': 'error', 'error': result.get('error', 'Board update failed.')})
            # An ambiguous timeout is never retried for this frame. The next
            # scheduled update or explicit control may send a new, current frame.

    def start_worker(self):
        def run():
            while not self.shutdown.is_set():
                self.wake.clear()
                self.tick()
                self.wake.wait(0.5)
        self.worker = threading.Thread(target=run, name='pomodoro', daemon=True)
        self.worker.start()

    def close(self):
        self.shutdown.set()
        self.wake.set()
        if self.worker:
            self.worker.join(timeout=12)
