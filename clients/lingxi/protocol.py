"""独立实现灵矽公开 OTA / WebSocket v1 协议，不依赖平台管理账号。"""
import json
import os
from pathlib import Path
import secrets
import uuid
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_STATE = ROOT / '.local' / 'lingxi-device.json'
OTA_URL = 'https://xrobo.qiniuapi.com/v1/ota/'


def load_identity(path=DEFAULT_STATE):
    path = Path(path)
    if path.exists():
        state = json.loads(path.read_text())
        uuid.UUID(state['client_id'])
        parts = state['device_id'].split(':')
        if len(parts) != 6 or any(len(p) != 2 or any(c not in '0123456789abcdefABCDEF' for c in p) for p in parts):
            raise ValueError('本地设备标识格式错误，请检查 .local/lingxi-device.json')
        return state
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    mac = bytes([0x02]) + secrets.token_bytes(5)  # 本地管理的伪 MAC，不读取真实网卡
    state = {'device_id': ':'.join(f'{b:02X}' for b in mac), 'client_id': str(uuid.uuid4())}
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as f:
        json.dump(state, f)
    return state


def ota_request(identity):
    device, client = identity['device_id'], identity['client_id']
    headers = {'Content-Type': 'application/json', 'Activation-Version': '1',
               'Device-Id': device, 'Client-Id': client, 'User-Agent': 'misheng-mac/0.1.0', 'Accept-Language': 'zh-CN'}
    body = {'version': 0, 'uuid': client, 'mac_address': device,
            'application': {'name': 'misheng-mac', 'version': '1.0.0', 'elf_sha256': '0' * 64},
            'board': {'type': 'xiaoling-web-test', 'ssid': 'desktop', 'rssi': 0, 'mac': device}}
    return headers, body


class NoRedirect(HTTPRedirectHandler):
    # 不将设备标识随重定向转发到未知地址。
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_ota(identity, url=OTA_URL):
    if urlsplit(url).scheme != 'https':
        raise ValueError('OTA 必须使用 HTTPS')
    headers, body = ota_request(identity)
    req = Request(url, data=json.dumps(body).encode(), headers=headers, method='POST')
    with build_opener(NoRedirect()).open(req, timeout=15) as res:
        raw = res.read(65537)
    if len(raw) > 65536:
        raise ValueError('OTA 响应过大')
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get('error'):
        raise ValueError('平台拒绝 OTA 请求，请检查设备注册状态')
    return data


def websocket_config(data):
    ws = data.get('websocket', {})
    if not ws.get('token'):
        return None
    parts = urlsplit(ws.get('url', ''))
    if parts.scheme not in ('ws', 'wss') or not parts.hostname or parts.username or parts.password or parts.fragment:
        raise ValueError('平台返回了无效的 WebSocket 地址')
    # 官方 OTA 示例可能返回 ws，默认强制同主机 WSS，不允许明文令牌传输。
    url = urlunsplit(('wss', parts.netloc, parts.path, parts.query, ''))
    return url, ws['token']


def hello():
    # 不宣告端侧 MCP 能力；游戏使用绑定在 Agent 上的云端 MCP。
    return {'type': 'hello', 'version': 1, 'transport': 'websocket',
            'features': {'mcp': False},
            'audio_params': {'format': 'opus', 'sample_rate': 16000, 'channels': 1,
                             'frame_duration': 60, 'play_buffer_duration': 1000}}


def validate_hello(msg):
    if msg.get('type') != 'hello' or msg.get('transport') != 'websocket':
        raise ValueError('平台没有返回有效的 hello')
    p = msg.get('audio_params', {})
    rate = p.get('sample_rate', 16000)
    if p.get('format') != 'opus' or p.get('channels', 1) != 1 or rate not in (8000, 12000, 16000, 24000, 48000):
        raise ValueError('当前客户端只支持单声道 Opus，请检查平台音频配置')
    return rate


def control(session, kind, **fields):
    return {'session_id': session, 'type': kind, **fields}
