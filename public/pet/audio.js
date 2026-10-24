const Context = window.AudioContext || window.webkitAudioContext;
export class PetAudio {
  constructor(onLevel = () => {}) { this.onLevel = onLevel; this.sources = new Set(); this.nextTime = 0; this.volume = 0.85; }
  async resume() {
    if (this.closing) await this.closing;
    if (!Context) throw new Error('当前浏览器不支持音频，请使用 Chrome。');
    if (!this.context || this.context.state === 'closed') {
      this.context = new Context({ sampleRate: 16000 });
      this.gain = this.context.createGain(); this.gain.gain.value = this.volume; this.gain.connect(this.context.destination);
    }
    await this.context.resume();
  }
  setMuted(muted) { this.volume = muted ? 0 : 0.85; if (this.gain) this.gain.gain.value = this.volume; }
  play(pcm) {
    if (!this.context || this.context.state === 'closed' || !pcm.byteLength || pcm.byteLength % 2) return;
    const input = new Int16Array(pcm);
    const buffer = this.context.createBuffer(1, input.length, 16000), data = buffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) { data[i] = input[i] / 32768; sum += data[i] ** 2; }
    if (this.nextTime - this.context.currentTime > 25) throw new Error('播报缓冲过长，请打断后重试。');
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
    this.sources.add(source); source.onended = () => this.sources.delete(source);
    const at = Math.max(this.context.currentTime + 0.04, this.nextTime);
    source.start(at); this.nextTime = at + buffer.duration;
    this.onLevel(Math.sqrt(sum / Math.max(1, input.length)));
  }
  silence() {
    for (const source of this.sources) { try { source.stop(); } catch {} }
    this.sources.clear(); this.nextTime = 0; this.onLevel(0);
  }
  async finished() {
    const remaining = this.context ? Math.max(0, this.nextTime - this.context.currentTime) * 1000 : 0;
    await new Promise(r => setTimeout(r, remaining + 60));
  }
  async startCapture(send) {
    if (this.capture) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('无法打开麦克风，请使用本机 Chrome，或先用文字提问。');
    this.silence();
    await this.resume();
    let timer;
    const pending = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    let stream;
    try {
      stream = await Promise.race([pending, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('麦克风授权等待过久，可允许权限后重试，或使用文字模式。')), 15000); })]);
    } catch (error) { pending.then(s => s.getTracks().forEach(t => t.stop()), () => {}); throw error; }
    finally { clearTimeout(timer); }
    const context = this.context;
    if (!context || context.state === 'closed') { stream.getTracks().forEach(t => t.stop()); throw new Error('连接已结束，麦克风未继续开启。'); }
    try {
      if (context.sampleRate !== 16000) throw new Error('麦克风采样率不兼容，可使用文字模式。');
      await context.audioWorklet.addModule(new URL('./capture.worklet.js', import.meta.url));
      const source = context.createMediaStreamSource(stream), worklet = new AudioWorkletNode(context, 'pet-capture');
      const mute = context.createGain(); mute.gain.value = 0;
      source.connect(worklet); worklet.connect(mute); mute.connect(context.destination);
      let stopped;
      const stoppedPromise = new Promise(r => { stopped = r; });
      this.capture = { context, stream, source, worklet, stoppedPromise, stopped };
      worklet.port.onmessage = event => {
        if (event.data.type === 'audio') { send(event.data.pcm); this.onLevel(event.data.level); }
        else if (event.data.type === 'stopped') stopped();
      };
    } catch (error) { stream.getTracks().forEach(t => t.stop()); throw error; }
  }
  async stopCapture() {
    const current = this.capture;
    if (!current) return;
    current.worklet.port.postMessage('stop');
    await Promise.race([current.stoppedPromise, new Promise(r => setTimeout(r, 400))]);
    current.stream.getTracks().forEach(t => t.stop());
    current.source.disconnect(); current.worklet.disconnect();
    if (this.capture === current) this.capture = null;
    this.onLevel(0);
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.stopCapture(); this.silence();
      const context = this.context;
      if (context && context.state !== 'closed') await context.close().catch(() => {});
      if (this.context === context) this.context = null;
    })();
    try { await this.closing; } finally { this.closing = null; }
  }
}
