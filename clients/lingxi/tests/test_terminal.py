import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from client import Terminal
from protocol import hello


class FakeCodec:
    def __init__(self, rate): pass
    def encode(self, data): return b'opus-frame'
    def close(self): pass


class FakeStream:
    def __init__(self, **kwargs): self.started = False
    def start(self): self.started = True
    def stop(self): self.started = False
    def close(self): pass


class FakeSocket:
    def __init__(self): self.sent = []
    def send(self, data): self.sent.append(data)
    def close(self): pass


class TerminalTests(unittest.TestCase):
    def setUp(self):
        self.sd = types.SimpleNamespace(RawInputStream=FakeStream)
        self.p1 = patch.dict(sys.modules, {'sounddevice': self.sd})
        self.p2 = patch('codec.OpusCodec', FakeCodec)
        self.p1.start(); self.p2.start()
        self.addCleanup(self.p1.stop); self.addCleanup(self.p2.stop)
        self.ws = FakeSocket()
        self.terminal = Terminal(self.ws, {**hello(), 'session_id': 'test-session'})

    def test_mic_not_opened_until_user_starts(self):
        t = self.terminal
        self.assertIsNone(t.input)
        self.assertFalse(t.recording.is_set())
        t.capture(bytes(1920), 960, None, None)
        self.assertTrue(t.mic.empty())

    def test_start_audio_stop_order_and_session(self):
        t = self.terminal
        t.start_recording()
        self.assertTrue(t.input.started)
        t.capture(bytes(1920), 960, None, None)
        t.stop_recording()
        self.assertIsNone(t.input)
        self.assertFalse(t.recording.is_set())
        self.assertEqual(json.loads(self.ws.sent[0])['type'], 'abort')
        self.assertEqual(json.loads(self.ws.sent[1])['state'], 'start')
        self.assertEqual(self.ws.sent[2], b'opus-frame')
        self.assertEqual(json.loads(self.ws.sent[3])['state'], 'stop')
        self.assertTrue(all(json.loads(s)['session_id'] == 'test-session' for s in self.ws.sent if isinstance(s, str)))

    def test_capture_queue_is_bounded(self):
        t = self.terminal
        t.recording.set()
        for _ in range(100): t.capture(bytes(1920), 960, None, None)
        self.assertEqual(t.mic.qsize(), 32)
        self.assertTrue(t.dropped.is_set())

    def test_failed_mic_start_clears_recording_and_sends_stop(self):
        def fail(**kwargs): raise RuntimeError('mock microphone unavailable')
        self.sd.RawInputStream = fail
        with self.assertRaises(RuntimeError): self.terminal.start_recording()
        self.assertFalse(self.terminal.recording.is_set())
        self.assertEqual(json.loads(self.ws.sent[-1])['state'], 'stop')


if __name__ == '__main__': unittest.main()
