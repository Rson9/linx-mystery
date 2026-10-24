"""不访问麦克风的真实平台诊断：WSS 握手 / 合成语音上行与 TTS 解码。"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import wave

from protocol import control


def synthetic_pcm(text='开始游戏'):
    if sys.platform != 'darwin':
        raise ValueError('自动语音测试当前使用 macOS say；其他系统请手动 voice:start')
    with tempfile.TemporaryDirectory(prefix='misheng-smoke-') as folder:
        path = Path(folder) / 'start.wav'
        result = subprocess.run(['say', '-v', 'Tingting', '--file-format=WAVE',
                                 '--data-format=LEI16@16000', '-o', str(path), text],
                                capture_output=True, timeout=20)
        if result.returncode:
            raise ValueError('无法合成中文测试音频，请检查系统 Tingting 语音是否可用')
        with wave.open(str(path), 'rb') as source:
            if (source.getframerate(), source.getnchannels(), source.getsampwidth()) != (16000, 1, 2):
                raise ValueError('合成音频格式不是 16kHz 单声道 int16')
            if source.getnframes() > 160000:
                raise ValueError('测试音频超过 10 秒')
            return source.readframes(source.getnframes())


def smoke(ws, session, rate, emit=print):
    from codec import OpusCodec
    codec = OpusCodec(rate)
    try:
        audio = synthetic_pcm() + bytes(19200)  # 尾部静音，帮助 ASR 收尾
        emit('发送系统合成的“开始游戏”；不采集麦克风、不播放扬声器。')
        ws.send(json.dumps(control(session, 'listen', state='start', mode='manual')))
        for offset in range(0, len(audio), 1920):
            ws.send(codec.encode(audio[offset:offset + 1920].ljust(1920, b'\0')))
            time.sleep(0.06)
        ws.send(json.dumps(control(session, 'listen', state='stop', mode='manual')))
        deadline = time.monotonic() + 60
        transcript, sentences, packets, decoded_bytes, complete = [], [], 0, 0, False
        while time.monotonic() < deadline:
            try:
                raw = ws.recv(timeout=min(3, max(0.1, deadline - time.monotonic())))
            except TimeoutError:
                continue
            if isinstance(raw, bytes):
                decoded_bytes += len(codec.decode(raw))
                packets += 1
                continue
            msg = json.loads(raw)
            if msg.get('type') == 'stt':
                transcript.append(str(msg.get('text', '')))
                emit('识别：' + transcript[-1])
            elif msg.get('type') == 'tts' and msg.get('state') == 'sentence_start':
                sentences.append(str(msg.get('text', '')))
                emit('灵矽：' + sentences[-1])
            elif msg.get('type') == 'tts' and msg.get('state') == 'stop':
                complete = not msg.get('is_aborted', False)
                break
            elif msg.get('type') in ('error', 'goodbye'):
                break
        voice_ok = bool(transcript and packets and decoded_bytes and complete)
        # 仅是题面识别，不等于确认服务端工具一定被调用。
        titles = ['没有响的门铃', '雨天的十八楼', '空无一人的合照', '倒着走的钟', '没有湿的鞋']
        game_reply = any(title in ''.join(sentences) for title in titles)
        emit(f'TTS：{packets} 个音频包，解码 {decoded_bytes // 2} 个样本。')
        if not voice_ok:
            emit('语音链路尚未完整通过，请检查 ASR、TTS、音频格式及平台日志。')
            return 1
        if not game_reply:
            emit('ASR/TTS 通过，但未收到谜声题面。请检查 Agent 的 MCP 绑定、Function Call、提示词及整页保存。')
            return 3
        emit('ASR/TTS 通过，并收到谜声题面；工具调用是否命中仍需结合平台/游戏服务记录确认。')
        return 0
    finally:
        codec.close()
