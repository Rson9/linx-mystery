"""通过 ctypes 调用 libopus；不复制第三方 SDK，不保存录音。"""
import ctypes as C
from ctypes.util import find_library


def load_opus():
    candidates = [find_library('opus'), '/opt/homebrew/opt/opus/lib/libopus.dylib',
                  '/usr/local/opt/opus/lib/libopus.dylib']
    for name in filter(None, candidates):
        try:
            return C.CDLL(name)
        except OSError:
            pass
    raise RuntimeError('找不到 libopus。macOS 请运行 brew install opus')


class OpusCodec:
    def __init__(self, playback_rate=16000):
        self.lib = lib = load_opus()
        lib.opus_encoder_create.argtypes = [C.c_int32, C.c_int, C.c_int, C.POINTER(C.c_int)]
        lib.opus_encoder_create.restype = C.c_void_p
        lib.opus_decoder_create.argtypes = [C.c_int32, C.c_int, C.POINTER(C.c_int)]
        lib.opus_decoder_create.restype = C.c_void_p
        lib.opus_encode.argtypes = [C.c_void_p, C.POINTER(C.c_int16), C.c_int, C.POINTER(C.c_ubyte), C.c_int32]
        lib.opus_encode.restype = C.c_int
        lib.opus_decode.argtypes = [C.c_void_p, C.POINTER(C.c_ubyte), C.c_int32, C.POINTER(C.c_int16), C.c_int, C.c_int]
        lib.opus_decode.restype = C.c_int
        lib.opus_encoder_destroy.argtypes = [C.c_void_p]
        lib.opus_decoder_destroy.argtypes = [C.c_void_p]
        self.encoder = self.decoder = None
        self.rate = playback_rate
        error = C.c_int()
        self.encoder = lib.opus_encoder_create(16000, 1, 2048, C.byref(error))
        if error.value or not self.encoder:
            self.close()
            raise RuntimeError('Opus 编码器初始化失败')
        self.decoder = lib.opus_decoder_create(playback_rate, 1, C.byref(error))
        if error.value or not self.decoder:
            self.close()
            raise RuntimeError('Opus 解码器初始化失败')

    def encode(self, pcm):
        if len(pcm) != 960 * 2:
            raise ValueError('录音帧必须为 16kHz / 单声道 / 60ms / int16')
        samples = (C.c_int16 * 960).from_buffer_copy(pcm)
        output = (C.c_ubyte * 4000)()
        size = self.lib.opus_encode(self.encoder, samples, 960, output, len(output))
        if size < 0:
            raise ValueError('Opus 编码失败')
        return bytes(output[:size])

    def decode(self, packet):
        if not packet or len(packet) > 65536:
            raise ValueError('音频包大小异常')
        data = (C.c_ubyte * len(packet)).from_buffer_copy(packet)
        capacity = self.rate * 120 // 1000  # Opus 最大 120ms 帧
        pcm = (C.c_int16 * capacity)()
        size = self.lib.opus_decode(self.decoder, data, len(packet), pcm, capacity, 0)
        if size < 0:
            raise ValueError('Opus 解码失败')
        return C.string_at(pcm, size * 2)

    def close(self):
        if self.encoder:
            self.lib.opus_encoder_destroy(self.encoder)
            self.encoder = None
        if self.decoder:
            self.lib.opus_decoder_destroy(self.decoder)
            self.decoder = None
