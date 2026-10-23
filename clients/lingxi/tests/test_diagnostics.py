import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from diagnostics import smoke


class FakeCodec:
    def __init__(self, rate): self.closed = False
    def encode(self, pcm): return b'encoded'
    def decode(self, packet): return bytes(1920)
    def close(self): self.closed = True


class FakeSocket:
    def __init__(self, messages):
        self.messages = iter(messages)
        self.sent = []
    def recv(self, **kwargs): return next(self.messages)
    def send(self, data): self.sent.append(data)


class SmokeTests(unittest.TestCase):
    def run_smoke(self, messages):
        ws = FakeSocket(messages)
        output = []
        with patch('codec.OpusCodec', FakeCodec), patch('diagnostics.synthetic_pcm', return_value=bytes(1920)), patch('diagnostics.time.sleep'):
            code = smoke(ws, 'test-session', 16000, output.append)
        return code, ws, output

    def test_generic_agent_reports_configuration_gap(self):
        code, ws, output = self.run_smoke([
            json.dumps({'type': 'stt', 'text': '开始游戏。'}),
            json.dumps({'type': 'tts', 'state': 'sentence_start', 'text': '我们玩什么游戏呢？'}),
            b'packet', json.dumps({'type': 'tts', 'state': 'stop'})])
        self.assertEqual(code, 3)
        self.assertTrue(any('MCP' in line for line in output))
        self.assertEqual(json.loads(ws.sent[0])['state'], 'start')
        self.assertEqual(json.loads(ws.sent[-1])['state'], 'stop')

    def test_game_reply_with_audio_passes(self):
        code, _, _ = self.run_smoke([
            json.dumps({'type': 'stt', 'text': '开始游戏。'}),
            json.dumps({'type': 'tts', 'state': 'sentence_start', 'text': '欢迎来到谜声，没有响的门铃。'}),
            b'packet', json.dumps({'type': 'tts', 'state': 'stop'})])
        self.assertEqual(code, 0)

    def test_text_without_audio_does_not_pass(self):
        code, _, _ = self.run_smoke([
            json.dumps({'type': 'stt', 'text': '开始游戏'}),
            json.dumps({'type': 'tts', 'state': 'sentence_start', 'text': '没有响的门铃'}),
            json.dumps({'type': 'tts', 'state': 'stop'})])
        self.assertEqual(code, 1)

    def test_aborted_tts_does_not_pass(self):
        code, _, _ = self.run_smoke([
            json.dumps({'type': 'stt', 'text': '开始游戏'}), b'packet',
            json.dumps({'type': 'tts', 'state': 'stop', 'is_aborted': True})])
        self.assertEqual(code, 1)


if __name__ == '__main__': unittest.main()
