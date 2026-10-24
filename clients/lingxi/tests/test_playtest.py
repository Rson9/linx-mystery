import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playtest import playtest, SCENARIO


class Codec:
    def __init__(self, rate): pass
    def encode(self, data): return b'opus'
    def decode(self, data): return bytes(1920)
    def close(self): pass


class Socket:
    def __init__(self, answers):
        messages = []
        for answer in answers:
            messages.extend([json.dumps({'type': 'stt', 'text': 'mock input'}),
                             json.dumps({'type': 'tts', 'state': 'sentence_start', 'text': answer}),
                             b'audio', json.dumps({'type': 'tts', 'state': 'stop'})])
        self.messages = iter(messages)
    def send(self, data): pass
    def recv(self, **kwargs): return next(self.messages)


class PlaytestTests(unittest.TestCase):
    def run_scenario(self, answers):
        with tempfile.TemporaryDirectory() as folder:
            with patch('playtest.OpusCodec', Codec), patch('playtest.synthetic_pcm', return_value=bytes(1920)), patch('playtest.time.sleep'), patch('playtest.ROOT', Path(folder)):
                code = playtest(Socket(answers), 'test-session', 16000, lambda _: None)
            reports = list((Path(folder) / 'eval-results').glob('*.json'))
            return code, json.loads(reports[0].read_text())

    def test_full_scenario_records_all_turns_without_microphone(self):
        answers = ['没有响的门铃', '不是。', '题目没有交代这一点，无法确定。', '题目没有交代这一点，无法确定。',
                   '我不能直接泄露谜底。你可以继续提问，或说“揭晓答案”并确认。', '是的。', '提示 1', '推理正确', '雨天的十八楼']
        code, report = self.run_scenario(answers)
        self.assertEqual(code, 0); self.assertEqual(len(report['results']), len(SCENARIO))
        self.assertFalse(report['microphoneUsed']); self.assertFalse(report['speakerUsed'])

    def test_disconnect_records_failure_without_exception_details(self):
        with patch.object(Socket, 'recv', side_effect=ConnectionError('private handshake details')):
            code, report = self.run_scenario(['没有响的门铃'])
        self.assertEqual(code, 1)
        self.assertEqual(report['failure'], {'turn': 1, 'errorKind': 'ConnectionError'})
        self.assertNotIn('private handshake details', json.dumps(report))

    def test_extra_fact_leakage_fails_and_stops(self):
        code, report = self.run_scenario(['没有响的门铃', '不是。他听不见，所以用了闪光灯。'])
        self.assertEqual(code, 1); self.assertEqual(len(report['results']), 2)
        self.assertFalse(report['results'][-1]['passed'])


if __name__ == '__main__': unittest.main()
