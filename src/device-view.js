export const normalizeUtterance = text => String(text).toLowerCase().replace(/[\s，。？！、,.?!：:“”‘’"']/g, '');

// 将平台设备/会话映射到已认证 MCP 玩家；只用于本机桌宠读取公开游戏视图。
export class DeviceViews {
  constructor({ maxEntries = 256, ttlMs = 30 * 60 * 1000, now = Date.now } = {}) {
    this.entries = new Map(); this.inputs = new Map(); this.maxEntries = maxEntries; this.ttlMs = ttlMs; this.now = now;
  }
  key(device, session) { return JSON.stringify([device.toLowerCase(), session]); }
  remember(device, session, owner) {
    this.prune();
    const key = this.key(device, session), previous = this.entries.get(key);
    this.entries.set(key, { owner, ambiguous: Boolean(previous?.ambiguous || (previous && previous.owner !== owner)), expiresAt: this.now() + this.ttlMs });
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
  lookup(device, session) {
    const key = this.key(device, session), entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= this.now()) { this.entries.delete(key); return null; }
    if (entry.ambiguous) throw new Error('同一设备会话匹配到多个智能体，请重新连接');
    return entry.owner;
  }
  setInput(device, session, inputId, text) {
    this.prune();
    const key = this.key(device, session), previous = this.inputs.get(key);
    if (previous?.inputId === inputId && normalizeUtterance(previous.text) !== normalizeUtterance(text)) throw new Error('输入凭据不能改写原话');
    this.inputs.set(key, { inputId, text, expiresAt: this.now() + 120000 });
    if (this.inputs.size > this.maxEntries) this.inputs.delete(this.inputs.keys().next().value);
  }
  currentInput(device, session) {
    const key = this.key(device, session), value = this.inputs.get(key);
    if (!value || value.expiresAt <= this.now()) { this.inputs.delete(key); return null; }
    return value;
  }
  prune() {
    for (const map of [this.entries, this.inputs]) for (const [key, item] of map) if (item.expiresAt <= this.now()) map.delete(key);
  }
}
