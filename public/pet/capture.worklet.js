class PetCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.frame = new Int16Array(320); this.used = 0; this.active = true;
    this.port.onmessage = event => {
      if (event.data === 'stop') {
        this.active = false;
        if (this.used) this.flush();
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }
  flush() {
    let sum = 0;
    for (const n of this.frame) sum += (n / 32768) ** 2;
    this.port.postMessage({ type: 'audio', pcm: this.frame.buffer, level: Math.sqrt(sum / 320) }, [this.frame.buffer]);
    this.frame = new Int16Array(320); this.used = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!this.active || !input) return true;
    for (const sample of input) {
      this.frame[this.used++] = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
      if (this.used === 320) this.flush();
    }
    return true;
  }
}
registerProcessor('pet-capture', PetCapture);
