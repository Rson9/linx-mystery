#!/usr/bin/env python3
"""Mac/Linux 语音终端：OTA 绑定 → WSS → Opus → 本机音频。"""
import argparse
import json
import os
import queue
import select
import sys
import threading
import time
from urllib.error import URLError, HTTPError

from protocol import DEFAULT_STATE, OTA_URL, load_identity, fetch_ota, websocket_config, hello, validate_hello, control


def say(text):
    print(text, flush=True)


def clear(q):
    while True:
        try:
            q.get_nowait()
        except queue.Empty:
            return


def show_activation(data, identity):
    say('本机虚拟设备 ID：' + identity['device_id'])
    activation = data.get('activation', {})
    code = str(activation.get('code', ''))
    if code:
        say('\n绑定码：' + code)
        say('打开 https://xrobo.qiniu.com/ → 现有 Agent → 添加设备，输入绑定码。')
        say('绑定后重新运行 pnpm voice:start。绑定码可能过期，过期时重新获取。')
    else:
        say('平台尚未返回设备令牌或绑定码，请检查平台的设备接入状态。')


def check_audio():
    import sounddevice as sd
    from codec import OpusCodec
    codec = OpusCodec()
    try:
        packet = codec.encode(bytes(1920))
        if len(codec.decode(packet)) != 1920:
            raise RuntimeError('Opus 自检失败')
    finally:
        codec.close()
    say('Opus 16kHz / 60ms 编解码自检通过。')
    say('本机音频设备（未启动录音）：\n' + str(sd.query_devices()))


class Terminal:
    def __init__(self, ws, response, input_device=None, output_device=None):
        import sounddevice as sd
        from codec import OpusCodec
        self.sd = sd
        self.ws = ws
        self.session = response.get('session_id', '')
        self.rate = validate_hello(response)
        self.codec = OpusCodec(self.rate)
        self.input_device, self.output_device = input_device, output_device
        self.running = threading.Event()
        self.running.set()
        self.recording = threading.Event()
        self.lock = threading.Lock()
        self.mic = queue.Queue(maxsize=32)
        self.speaker = queue.Queue(maxsize=64)
        self.input = None
        self.output = None
        self.threads = []
        self.dropped = threading.Event()

    def send_control(self, kind, **fields):
        self.ws.send(json.dumps(control(self.session, kind, **fields)))

    def fail(self, text):
        if self.running.is_set():
            say('\n' + text + '；已停止会话，请重新运行客户端。')
        self.running.clear()
        self.recording.clear()
        self.ws.close()

    def capture(self, data, frames, _timing, status):
        if self.recording.is_set():
            try:
                self.mic.put_nowait(bytes(data))
            except queue.Full:
                self.dropped.set()
            if status:
                self.dropped.set()

    def send_audio(self):
        try:
            while self.running.is_set():
                with self.lock:
                    if self.recording.is_set():
                        try:
                            frame = self.mic.get_nowait()
                            self.ws.send(self.codec.encode(frame))
                        except queue.Empty:
                            pass
                time.sleep(0.005)
        except Exception:
            self.fail('音频发送失败')

    def play_audio(self):
        try:
            while self.running.is_set():
                try:
                    packet = self.speaker.get(timeout=0.2)
                except queue.Empty:
                    continue
                pcm = self.codec.decode(packet)
                if not self.recording.is_set():
                    self.output.write(pcm)
        except Exception:
            self.fail('音频播放或解码失败，请检查输出设备及平台音频格式')

    def receive(self):
        from websockets.exceptions import ConnectionClosed
        try:
            while self.running.is_set():
                try:
                    raw = self.ws.recv(timeout=1)
                except TimeoutError:
                    continue
                if isinstance(raw, bytes):
                    if not self.recording.is_set():
                        try:
                            self.speaker.put_nowait(raw)
                        except queue.Full:
                            self.fail('播放缓冲区已满，请检查扬声器是否可用')
                    continue
                msg = json.loads(raw)
                if msg.get('type') == 'stt':
                    say('\n你：' + str(msg.get('text', '')))
                elif msg.get('type') == 'tts':
                    if msg.get('state') == 'sentence_start':
                        say('\n灵矽：' + str(msg.get('text', '')))
                    if msg.get('is_aborted'):
                        clear(self.speaker)
                elif msg.get('type') == 'goodbye':
                    self.fail('平台已结束会话')
                elif msg.get('type') == 'error':
                    self.fail('平台报告会话错误，请检查 Agent 和设备绑定')
        except ConnectionClosed:
            self.fail('连接已断开')
        except Exception:
            self.fail('收到无法处理的平台消息')

    def start_recording(self):
        # 仅用户按回车后打开麦克风；默认手动半双工，不做常驻监听。
        clear(self.speaker)
        with self.lock:
            self.send_control('abort', reason='wake_word_detected')
            clear(self.mic)
            self.send_control('listen', state='start', mode='manual')
            self.recording.set()
        try:
            self.input = self.sd.RawInputStream(samplerate=16000, channels=1, dtype='int16',
                                                blocksize=960, device=self.input_device, callback=self.capture)
            self.input.start()
        except Exception:
            self.recording.clear()
            with self.lock:
                self.send_control('listen', state='stop', mode='manual')
            raise
        say('● 正在录音，再按回车结束这句话。')

    def stop_recording(self):
        if self.input:
            self.input.stop()
            self.input.close()
            self.input = None
        with self.lock:
            while not self.mic.empty():
                self.ws.send(self.codec.encode(self.mic.get_nowait()))
            self.recording.clear()
            self.send_control('listen', state='stop', mode='manual')
        say('○ 录音结束，等待灵矽回答。按回车可打断并开始下一句话。')
        if self.dropped.is_set():
            say('提示：本句话发生录音丢帧；可重试或检查音频设备/网络。')
            self.dropped.clear()

    def run(self):
        try:
            self.output = self.sd.RawOutputStream(samplerate=self.rate, channels=1, dtype='int16', device=self.output_device)
            self.output.start()
            for target in (self.receive, self.send_audio, self.play_audio):
                thread = threading.Thread(target=target, daemon=True)
                thread.start()
                self.threads.append(thread)
            say('\n已连接灵矽。按回车开始说话，再按回车发送；输入 q 后回车退出。')
            say('试说：“开始游戏”。麦克风不会自动打开。建议戴耳机。')
            while self.running.is_set():
                ready, _, _ = select.select([sys.stdin], [], [], 0.2)
                if not ready:
                    continue
                line = sys.stdin.readline()
                if not line or line.strip().lower() == 'q':
                    break
                if self.recording.is_set():
                    self.stop_recording()
                else:
                    self.start_recording()
        finally:
            self.running.clear()
            self.recording.clear()
            if self.input:
                self.input.abort()
                self.input.close()
            self.ws.close()
            for thread in self.threads:
                thread.join(timeout=3)
            if self.output:
                self.output.abort()
                self.output.close()
            # 防止线程尚未退出时释放 native codec，引发 use-after-free。
            if not any(t.is_alive() for t in self.threads):
                self.codec.close()
            say('会话已结束，麦克风已关闭。')


def main():
    parser = argparse.ArgumentParser(description='谜声 · 灵矽 Mac/Linux 语音终端')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--activate', action='store_true', help='获取绑定码或检查绑定状态，不打开麦克风')
    mode.add_argument('--check', action='store_true', help='本机音频和 Opus 自检，不访问平台、不录音')
    mode.add_argument('--probe', action='store_true', help='真实 WSS 握手测试，不采集或播放音频')
    mode.add_argument('--smoke', action='store_true', help='使用 macOS 系统合成语音测试 ASR/TTS，不打开麦克风')
    parser.add_argument('--input-device', type=int, help='输入设备编号，见 --check')
    parser.add_argument('--output-device', type=int, help='输出设备编号，见 --check')
    parser.add_argument('--state', default=str(DEFAULT_STATE), help='本地设备身份文件（不含令牌）')
    args = parser.parse_args()
    if args.check:
        check_audio()
        return 0
    identity = load_identity(args.state)
    data = fetch_ota(identity, os.environ.get('LINGXI_OTA_URL', OTA_URL))
    config = websocket_config(data)
    if not config:
        show_activation(data, identity)
        return 2
    if args.activate:
        say('虚拟设备已绑定，可运行 pnpm voice:start。设备 ID：' + identity['device_id'])
        return 0
    if not (args.probe or args.smoke) and not sys.stdin.isatty():
        raise ValueError('语音会话需要交互式终端，请在终端运行 pnpm voice:start')
    from websockets.sync.client import connect
    url, token = config
    headers = {'Authorization': 'Bearer ' + token, 'Device-Id': identity['device_id'],
               'Client-Id': identity['client_id'], 'Protocol-Version': '1'}
    # token 仅驻留内存，不写入文件或日志；禁止明文 WS，使用系统 TLS 校验。
    with connect(url, additional_headers=headers, open_timeout=15, close_timeout=3,
                 max_size=1024 * 1024, max_queue=32, proxy=None) as ws:
        ws.send(json.dumps(hello()))
        raw = ws.recv(timeout=10)
        if not isinstance(raw, str):
            raise ValueError('平台 hello 响应格式错误')
        response = json.loads(raw)
        rate = validate_hello(response)
        if args.probe:
            say(f'灵矽 WSS 握手通过：Opus / {rate}Hz，已分配会话：{bool(response.get("session_id"))}。未录音。')
            return 0
        if args.smoke:
            from diagnostics import smoke
            return smoke(ws, response.get('session_id', ''), rate, say)
        Terminal(ws, response, args.input_device, args.output_device).run()
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        say('\n已退出。')
        sys.exit(130)
    except (HTTPError, URLError):
        say('连接 OTA 失败，请检查网络和平台地址。响应详情未输出，以避免泄漏令牌。')
        sys.exit(1)
    except Exception as error:
        # 不输出含 token / 握手请求的第三方异常对象。
        if isinstance(error, (ValueError, RuntimeError, ImportError)):
            say('启动失败：' + str(error))
        else:
            say('启动失败（' + type(error).__name__ + '）。请检查麦克风权限、依赖、网络与设备绑定。')
        sys.exit(1)
