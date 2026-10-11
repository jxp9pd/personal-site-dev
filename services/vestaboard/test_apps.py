"""Ownership, cancellation, and races use fake board and sports sources."""
import threading
import unittest
from unittest.mock import Mock

from apps import BoardApp, BoardController
from fantasy import DEFAULT_LEAGUES, Fantasy
from nfl import NFL
from pomodoro import Pomodoro
from test_fantasy import STATE, matchup, play, player
from test_helpers import message
from test_nfl import game


class OwnershipTest(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.gateway = Mock(token='test-token')
        self.gateway.status.return_value = {'retryAfter': 0}
        self.gateway.send.return_value = (200, {'accepted': True})
        self.controller = BoardController(self.gateway)
        self.timer = Pomodoro(self.controller, lambda: self.now)
        self.fetch_games = Mock(return_value=[game()])
        self.nfl = NFL(self.controller, self.fetch_games, lambda: self.now)
        self.source = Mock()
        self.source.state.return_value = STATE
        self.source.matchup.return_value = matchup()
        self.source.plays.return_value = [play()]
        self.source.player.side_effect = player
        self.fantasy = Fantasy(self.controller, self.source, lambda: self.now, lambda: 1000)
        self.nfl.status()
        self.nfl.tick()
        self.apps = [self.timer, self.nfl, self.fantasy]

    def start(self, app):
        body = ({'action': 'start', 'focusMinutes': 25, 'breakMinutes': 5} if app is self.timer else
                {'action': 'track', 'gameId': '401000001'} if app is self.nfl else
                {'action': 'start', 'leagues': DEFAULT_LEAGUES})
        self.assertEqual(app.command(body)[0], 200)

    def test_every_app_switch_stops_the_previous_worker_and_cancels_pending_writes(self):
        for previous in self.apps:
            for next_app in self.apps:
                if previous is next_app:
                    continue
                with self.subTest(previous=type(previous).__name__, next=type(next_app).__name__):
                    self.controller.send_note(message())
                    self.start(previous)
                    self.start(next_app)
                    self.assertEqual(previous.status()['state'], 'stopped')
                    self.assertEqual(previous.status()['delivery']['status'], 'idle')
                    self.gateway.send.reset_mock()
                    self.now += 10000
                    previous.tick()
                    self.gateway.send.assert_not_called()
                    next_app.tick()
                    self.gateway.send.assert_called_once()

    def test_notes_cancel_running_paused_and_terminal_timer_frames(self):
        for state in ('running', 'paused', 'completed', 'stopped'):
            with self.subTest(state=state):
                self.start(self.timer)
                if state == 'paused':
                    self.timer.command({'action': 'pause'})
                elif state == 'stopped':
                    self.timer.command({'action': 'stop'})
                elif state == 'completed':
                    self.now += 1800
                self.assertEqual(self.timer.status()['state'], state)
                self.assertEqual(self.controller.send_note(message())[0], 200)
                self.gateway.send.reset_mock()
                self.now += 10000
                self.timer.tick()
                self.gateway.send.assert_not_called()
                self.assertEqual(self.timer.status()['delivery']['status'], 'idle')

    def test_note_cancels_pending_nfl_final_and_fantasy_alerts(self):
        self.start(self.nfl)
        self.fetch_games.return_value = [game(state='final')]
        self.gateway.status.return_value = {'retryAfter': 1}
        self.now = 180
        self.nfl.tick()
        self.assertEqual(self.nfl.status()['state'], 'completed')
        self.controller.send_note(message())
        self.gateway.status.return_value = {'retryAfter': 0}
        self.gateway.send.reset_mock()
        self.nfl.tick()
        self.gateway.send.assert_not_called()

        self.start(self.fantasy)
        self.fantasy.tick()
        self.assertIsNotNone(self.fantasy.status()['alert'])
        self.fantasy.queue.append({'id': 'another'})
        self.controller.send_note(message())
        self.assertIsNone(self.fantasy.status()['alert'])
        self.assertEqual(self.fantasy.status()['queuedAlerts'], 0)
        self.gateway.send.reset_mock()
        self.now += 10000
        self.fantasy.tick()
        self.gateway.send.assert_not_called()

    def test_preview_reads_and_rejected_commands_do_not_displace_tracking(self):
        self.start(self.nfl)
        for app in self.apps:
            app.status()
            self.assertEqual(app.command({'action': 'invalid'})[0], 400)
        self.assertEqual(self.timer.command({'action': 'pause'})[0], 409)
        self.assertEqual(self.fantasy.command({'action': 'preview', 'leagues': DEFAULT_LEAGUES})[0], 200)
        self.fantasy.tick()
        self.assertIs(self.controller.owner, self.nfl)
        self.assertEqual(self.nfl.status()['state'], 'tracking')
        self.gateway.send.assert_not_called()

    def test_old_frame_is_rejected_even_after_the_same_app_restarts(self):
        for app in self.apps:
            with self.subTest(app=type(app).__name__):
                self.start(app)
                revision = app.revision
                self.controller.send_note(message())
                self.start(app)
                self.gateway.send.reset_mock()
                self.assertEqual(app.deliver(revision, message())[0], 409)
                self.gateway.send.assert_not_called()

    def test_rejected_notes_keep_ownership_but_uncertain_delivery_cancels_tracking(self):
        self.start(self.nfl)
        for status in (400, 429, 503):
            with self.subTest(status=status):
                self.gateway.send.return_value = (status, {'error': 'Rejected.'})
                self.assertEqual(self.controller.send_note(message())[0], status)
                self.assertIs(self.controller.owner, self.nfl)
                self.assertEqual(self.nfl.status()['state'], 'tracking')
        self.gateway.send.return_value = (504, {'error': 'May have been sent.'})
        self.assertEqual(self.controller.send_note(message())[0], 504)
        self.assertEqual(self.nfl.status()['state'], 'stopped')

    def test_sports_response_inflight_cannot_restore_tracking_after_a_note(self):
        for app in (self.nfl, self.fantasy):
            with self.subTest(app=type(app).__name__):
                self.start(app)
                fetching, release = threading.Event(), threading.Event()
                def fetch(*args):
                    fetching.set()
                    if not release.wait(2):
                        raise AssertionError('UI takeover did not finish.')
                    return [game()] if app is self.nfl else STATE
                source = self.fetch_games if app is self.nfl else self.source.state
                source.side_effect = fetch
                self.now += 10000
                worker = threading.Thread(target=app.tick)
                worker.start()
                try:
                    self.assertTrue(fetching.wait(2))
                    self.controller.send_note(message())
                    attempts = self.gateway.send.call_count
                finally:
                    release.set()
                    worker.join(2)
                    source.side_effect = None
                self.assertFalse(worker.is_alive())
                self.assertEqual(app.status()['state'], 'stopped')
                self.assertEqual(self.gateway.send.call_count, attempts)
                self.assertEqual(self.fantasy.status()['queuedAlerts'], 0)

    def test_new_app_inherits_precedence_without_coordinator_changes(self):
        class NewApp(BoardApp):
            revision = 0
            def _command(self, body):
                self.revision += 1
                return 200, {}
            def deactivate(self):
                self.revision += 1

        app = NewApp(self.controller)
        self.start(self.nfl)
        self.assertEqual(app.command({'action': 'show'})[0], 200)
        self.assertEqual(self.nfl.status()['state'], 'stopped')
        self.assertEqual(app.deliver(app.revision, message())[0], 200)
        self.start(self.timer)
        self.assertEqual(app.deliver(app.revision, message())[0], 409)

    def test_takeover_rejects_a_worker_frame_prepared_before_the_ui_command(self):
        for app in self.apps:
            with self.subTest(app=type(app).__name__):
                self.start(app)
                prepared, release = threading.Event(), threading.Event()
                original = app.deliver
                def delayed(revision, characters):
                    prepared.set()
                    if not release.wait(2):
                        raise AssertionError('UI takeover did not finish.')
                    return original(revision, characters)
                app.deliver = delayed
                worker = threading.Thread(target=app.tick)
                worker.start()
                try:
                    self.assertTrue(prepared.wait(2))
                    self.assertEqual(self.controller.send_note(message())[0], 200)
                    attempts = self.gateway.send.call_count
                finally:
                    release.set()
                    worker.join(2)
                    app.deliver = original
                self.assertFalse(worker.is_alive())
                self.assertEqual(self.gateway.send.call_count, attempts)
                self.assertEqual(app.status()['delivery']['status'], 'idle')

    def test_inflight_cloud_write_finishes_before_ui_takeover(self):
        self.start(self.nfl)
        sending, release, requested, finished = [threading.Event() for _ in range(4)]
        def slow_send(characters):
            sending.set()
            if not release.wait(2):
                raise AssertionError('Cloud send did not finish.')
            return 200, {'accepted': True}
        self.gateway.send.side_effect = slow_send
        worker = threading.Thread(target=self.nfl.tick)
        results = []
        def ui():
            requested.set()
            results.append(self.timer.command({'action': 'start', 'focusMinutes': 25, 'breakMinutes': 5}))
            finished.set()
        control = threading.Thread(target=ui)
        worker.start()
        try:
            self.assertTrue(sending.wait(2))
            control.start()
            self.assertTrue(requested.wait(2))
            self.assertFalse(finished.wait(.05))
        finally:
            release.set()
            worker.join(2)
            if control.ident:
                control.join(2)
        self.assertFalse(worker.is_alive())
        self.assertFalse(control.is_alive())
        self.assertEqual(results[0][0], 200)
        self.assertEqual(self.nfl.status()['state'], 'stopped')
        self.assertEqual(self.timer.status()['state'], 'running')


if __name__ == '__main__':
    unittest.main()
