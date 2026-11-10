/**
 * EventManager — central log with reasoning trace
 * Emits to UI and console.
 */
export class EventManager {
  constructor() {
    this.logs = [];
    this.listeners = [];
  }
  on(cb) { this.listeners.push(cb); }
  _emit(entry) {
    this.logs.push(entry);
    this.listeners.forEach(cb => cb(entry));
    if (this.logs.length > 500) this.logs.shift();
  }
  log(message, level='info', meta={}) {
    const ts = new Date();
    const time = ts.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(ts.getMilliseconds()).padStart(3,'0');
    const entry = { time, message, level, meta, ts: Date.now() };
    this._emit(entry);
    // also console for debug
    // console.log(`[${time}] ${message}`);
  }
  reasoning(lines) {
    lines.forEach(l => this.log(l, 'reason'));
  }
  clear() {
    this.logs = [];
    this.listeners.forEach(cb=>cb({ clear: true }));
  }
}
export const eventManager = new EventManager();
