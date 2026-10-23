import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from protocol import load_identity, ota_request, websocket_config, hello, validate_hello, control, fetch_ota, NoRedirect


class ProtocolTests(unittest.TestCase):
    def test_identity_persists_and_is_private(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'device.json'
            first = load_identity(path)
            self.assertEqual(first, load_identity(path))
            self.assertEqual(first['device_id'].split(':')[0], '02')
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertNotIn('token', path.read_text())

    def test_invalid_identity_is_not_silently_replaced(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'device.json'
            path.write_text(json.dumps({'device_id': 'invalid', 'client_id': 'd9d5d5b8-6f8b-4266-ab77-65f4d608c630'}))
            with self.assertRaises(ValueError):
                load_identity(path)

    def test_ota_ids_and_required_fields(self):
        headers, body = ota_request({'device_id': '02:11:22:33:44:55', 'client_id': 'test-uuid'})
        self.assertEqual(headers['Device-Id'], body['mac_address'])
        self.assertEqual(headers['Client-Id'], body['uuid'])
        self.assertEqual(headers['Activation-Version'], '1')
        self.assertIn('elf_sha256', body['application'])
        self.assertIn('type', body['board'])

    def test_unbound_device_has_no_websocket_config(self):
        self.assertIsNone(websocket_config({'activation': {'code': '123456'}, 'websocket': {'url': 'ws://example.com/v1/ws/'}}))

    def test_ws_is_upgraded_and_bad_schemes_rejected(self):
        self.assertEqual(websocket_config({'websocket': {'url': 'ws://example.com/v1/ws/', 'token': 'secret'}}), ('wss://example.com/v1/ws/', 'secret'))
        for url in ['http://example.com/', 'file:///etc/passwd', 'wss://user:pass@example.com/', 'wss://example.com/#fragment']:
            with self.assertRaises(ValueError):
                websocket_config({'websocket': {'url': url, 'token': 'secret'}})

    def test_ota_https_and_no_redirects(self):
        with self.assertRaises(ValueError):
            fetch_ota({}, 'http://example.com/')
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.example'))

    def test_hello_audio_and_no_edge_mcp_claim(self):
        msg = hello()
        self.assertFalse(msg['features']['mcp'])
        self.assertEqual(msg['audio_params']['frame_duration'], 60)
        self.assertEqual(validate_hello(msg), 16000)
        msg['audio_params']['sample_rate'] = 24000
        self.assertEqual(validate_hello(msg), 24000)
        msg['audio_params']['format'] = 'pcm'
        with self.assertRaises(ValueError):
            validate_hello(msg)

    def test_manual_control_has_session(self):
        msg = control('session-abc', 'listen', state='stop', mode='manual')
        self.assertEqual(msg, {'session_id': 'session-abc', 'type': 'listen', 'state': 'stop', 'mode': 'manual'})

    def test_ota_error_body_rejected(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, _): return b'{"error":"Invalid OTA request"}'
        with patch('protocol.build_opener') as opener:
            opener.return_value.open.return_value = Response()
            with self.assertRaises(ValueError):
                fetch_ota({'device_id': '02:11:22:33:44:55', 'client_id': 'id'})


class CodecTests(unittest.TestCase):
    def test_native_opus_roundtrip_and_frame_size(self):
        from codec import OpusCodec
        try:
            codec = OpusCodec()
        except RuntimeError as e:
            self.skipTest(str(e))
        try:
            packet = codec.encode(bytes(1920))
            self.assertGreater(len(packet), 0)
            self.assertEqual(len(codec.decode(packet)), 1920)
            with self.assertRaises(ValueError): codec.encode(b'bad')
            with self.assertRaises(ValueError): codec.decode(b'')
        finally:
            codec.close()
            codec.close()


if __name__ == '__main__':
    unittest.main()
