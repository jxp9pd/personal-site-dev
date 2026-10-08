import threading
import unittest
from unittest.mock import Mock

from board import text_row, valid_characters
from pomodoro import BREAK_MESSAGE, FOCUS_MESSAGES, Pomodoro, board_frame


class PomodoroTest(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.choose = Mock(return_value='YOU GOT THIS')
        # Transport, token handling, and cooldown implementation are tested once
        # in test_board. These tests exercise the scheduler's delivery policy.
        self.gateway = Mock(token='test-token')
        self.gateway.status.return_value = {'retryAfter': 0}
        self.gateway.send.return_value = (200, {'accepted': True})
        self.timer = Pomodoro(self.gateway, lambda: self.now, self.choose)

    @property
    def frames(self):
        return [call.args[0] for call in self.gateway.send.call_args_list]

    def start(self, focus=2, rest=1):
        return self.timer.command({'action': 'start', 'focusMinutes': focus, 'breakMinutes': rest})

    def tick_at(self, now):
        self.now = now
        self.timer.tick()

    def test_minutes_and_actions_are_strictly_validated(self):
        for value in (0, 181, True, 1.5, '25', None):
            self.assertEqual(self.start(focus=value)[0], 400, repr(value))
            self.assertEqual(self.start(rest=value)[0], 400, repr(value))
        for value in ([], None, {}, {'action': 'skip'}):
            self.assertEqual(self.timer.command(value)[0], 400)
        self.assertEqual(self.start(180, 180)[0], 200)
        self.assertEqual(self.frames, [])  # Commands queue; only the worker sends.

    def test_unconfigured_start_never_schedules_a_session(self):
        self.gateway.token = ''
        self.assertEqual(self.start()[0], 503)
        self.timer.tick()
        self.assertEqual(self.timer.status()['state'], 'idle')
        self.assertEqual(self.frames, [])

    def test_focus_updates_every_five_minutes_break_every_minute_and_transitions_on_time(self):
        self.start(focus=12, rest=3)
        updates = []
        for second in range(961):
            count = len(self.frames)
            self.tick_at(second)
            if len(self.frames) != count:
                updates.append(second)
        self.assertEqual(updates, [0, 300, 600, 720, 780, 840, 900])
        self.assertEqual(self.frames[0][0], text_row('YOU GOT THIS'))
        self.assertEqual(self.frames[1][0], self.frames[0][0])
        self.assertEqual(self.frames[2][0], self.frames[0][0])
        self.assertEqual([frame[1][1:-1] for frame in self.frames[:3]],
                         [text_row(f'FOCUS {minutes} MIN', 13) for minutes in (12, 7, 2)])
        self.assertEqual(self.frames[0][2], [68] * 15)
        self.assertEqual(self.frames[1][2], [68] * 9 + [0] * 6)
        self.assertEqual(self.frames[3][0], text_row(BREAK_MESSAGE))
        self.assertEqual(self.frames[3][2], [66] * 15)
        self.assertEqual(self.frames[4][2], [66] * 10 + [0] * 5)
        self.assertEqual(self.frames[6][0], text_row('ALL DONE'))
        self.assertEqual(self.timer.status()['state'], 'completed')
        self.assertTrue(all(valid_characters(frame) for frame in self.frames))
        self.choose.assert_called_once_with(FOCUS_MESSAGES)

    def test_resume_displays_current_time_then_waits_five_minutes_for_next_focus_update(self):
        self.start(focus=12)
        self.tick_at(0)
        self.now = 61
        self.timer.command({'action': 'pause'})
        self.timer.tick()
        self.now = 1000
        self.timer.command({'action': 'resume'})
        self.timer.tick()
        self.assertEqual(self.frames[-1][1][1:-1], text_row('FOCUS 11 MIN', 13))
        self.tick_at(1299)
        self.assertEqual(len(self.frames), 3)  # Start, pause, resume only.
        self.tick_at(1300)
        self.assertEqual(len(self.frames), 4)
        self.assertEqual(self.frames[-1][1][1:-1], text_row('FOCUS 6 MIN', 13))

    def test_curated_messages_fit_with_the_largest_supported_duration(self):
        # Content regression: one overlong phrase would otherwise kill the worker.
        for message in FOCUS_MESSAGES:
            with self.subTest(message=message):
                self.assertTrue(valid_characters(board_frame('running', 'focus', 10800, 10800, message)))
        self.assertTrue(valid_characters(board_frame('running', 'break', 10800, 10800, FOCUS_MESSAGES[0])))

    def test_pause_resume_preserves_time_and_message_in_both_phases(self):
        self.start()
        self.tick_at(0)
        self.now = 17
        self.timer.command({'action': 'pause'})
        self.timer.tick()
        self.assertEqual(self.frames[-1][0], text_row('PAUSED'))
        self.tick_at(1000)
        self.assertEqual(len(self.frames), 2)
        self.assertEqual(self.timer.status()['remainingSeconds'], 103)
        self.timer.command({'action': 'resume'})
        self.timer.tick()
        self.assertEqual(self.frames[-1][0], text_row('YOU GOT THIS'))
        self.tick_at(1103)
        self.assertEqual(self.timer.status()['phase'], 'break')
        self.now = 1123
        self.timer.command({'action': 'pause'})
        self.now = 2000
        self.timer.command({'action': 'resume'})
        self.assertEqual(self.timer.status()['phase'], 'break')
        self.assertEqual(self.timer.status()['remainingSeconds'], 40)
        self.tick_at(2040)
        self.assertEqual(self.timer.status()['state'], 'completed')
        self.choose.assert_called_once()

    def test_stop_coalesces_controls_during_cooldown_and_requires_a_fresh_start(self):
        self.assertEqual(self.timer.command({'action': 'pause'})[0], 409)
        self.start()
        self.tick_at(0)
        self.gateway.status.return_value = {'retryAfter': 15}
        self.now = 1
        self.timer.command({'action': 'pause'})
        self.timer.tick()
        self.now = 2
        self.timer.command({'action': 'stop'})
        self.timer.tick()
        self.assertEqual(len(self.frames), 1)
        self.assertEqual(self.timer.status()['delivery']['status'], 'pending')
        self.gateway.status.return_value = {'retryAfter': 0}
        self.tick_at(15)
        self.assertEqual(self.frames[-1][0], text_row('TIMER STOPPED'))
        self.tick_at(10000)
        self.assertEqual(len(self.frames), 2)
        self.assertEqual(self.timer.command({'action': 'resume'})[0], 409)
        self.start(3, 2)
        self.assertEqual(self.timer.status()['remainingSeconds'], 180)
        self.assertEqual(self.choose.call_count, 2)

    def test_ambiguous_failure_is_visible_and_never_retried_for_the_same_frame(self):
        self.start(focus=6)
        self.gateway.send.return_value = (504, {'error': 'Delivery unconfirmed.'})
        for second in range(300):
            self.tick_at(second)
        self.gateway.send.assert_called_once()
        self.assertEqual(self.timer.status()['delivery'], {'status': 'error', 'error': 'Delivery unconfirmed.'})
        self.gateway.send.return_value = (200, {'accepted': True})
        self.tick_at(300)
        self.assertEqual(self.timer.status()['delivery']['status'], 'accepted')

    def test_deferred_updates_skip_old_frames_without_extending_phase_deadlines(self):
        self.start()
        self.gateway.send.return_value = (429, {'retryAfter': 130})
        self.tick_at(0)
        self.assertEqual(self.timer.status()['delivery']['status'], 'pending')
        self.gateway.status.return_value = {'retryAfter': 1}
        self.tick_at(129)
        self.gateway.send.assert_called_once()
        self.gateway.status.return_value = {'retryAfter': 0}
        self.gateway.send.return_value = (200, {'accepted': True})
        self.tick_at(130)
        self.assertEqual(self.frames[-1][0], text_row(BREAK_MESSAGE))
        self.assertEqual(self.timer.status()['remainingSeconds'], 50)
        self.tick_at(10000)
        self.assertEqual(len(self.frames), 3)
        self.assertEqual(self.frames[-1][0], text_row('ALL DONE'))

    def test_actual_background_worker_sends_without_status_requests(self):
        sent = threading.Event()
        def send(characters):
            sent.set()
            return 200, {'accepted': True}
        self.gateway.send.side_effect = send
        self.timer.start_worker()
        try:
            self.start()
            self.assertTrue(sent.wait(2))
        finally:
            self.timer.close()
        self.assertFalse(self.timer.worker.is_alive())
