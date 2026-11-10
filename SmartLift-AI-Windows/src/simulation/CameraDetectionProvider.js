/**
 * CameraDetectionProvider — real-camera twin of SimulationDetectionProvider.
 *
 * Both emit the same detection format:
 *   { passenger_type, weight, luggage_detected, luggage_weight, floor }
 * so SmartLift Core never knows the source. Drag-drop keeps working as
 * fallback; when the camera confirms a track, the passenger is created
 * through the normal PassengerManager path (boarding = camera floor,
 * destination = user dropdown default, editable in PEOPLE).
 *
 * Track lifecycle (debounced so YOLO flicker never spams passengers):
 *   unseen --(seen)--> CANDIDATE --(CONFIRM_FRAMES in a row)--> CONFIRMED
 *   CONFIRMED --(DROP_FRAMES missed in a row)--> lost --> removePassenger
 * Losing a confirmed track IS a real ghost call: the same CANCELLED /
 * pickup-invalidated / route-reevaluated path as walking away in the sim.
 */
export class CameraDetectionProvider {
  constructor({ url = 'ws://localhost:8000/ws/detect', floor = 0, passengerManager, eventManager, onUpdate = null, onGhost = null } = {}) {
    this.url = url;
    this.floor = floor;
    this.passengers = passengerManager;
    this.events = eventManager;
    this.onUpdate = onUpdate;
    this.onGhost = onGhost;
    this.ws = null;
    this.connected = false;
    this.pending = new Map();   // track_id -> {type, typeConfidence, luggage, seen, missed, box, ageYears, seatedHint}
    this.confirmed = new Map(); // track_id -> passengerId
    this.CONFIRM_FRAMES = 5;
    this.DROP_FRAMES = 10;
    this.DEFAULT_WEIGHTS = { adult: 75, child: 30, senior: 70, wheelchair: 80, luggage: 15 };
  }

  connect() {
    if (this.ws) this.disconnect();
    this.events?.log?.('[CAMERA] Connecting to detection backend…', 'info');
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (!settled) { settled = true; reject(err); }
      };
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        this.connected = true;
        this.events?.log?.('[CAMERA] Backend connected — streaming frames', 'success');
        this.setFloor(this.floor);
        this._notify();
        if (!settled) { settled = true; resolve(); }
      };
      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.ack) return;
          this.ingest(msg.tracks || []);
        } catch (e) { /* ignore malformed frame */ }
      };
      this.ws.onclose = () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.events?.log?.('[CAMERA] Backend disconnected — drag-drop still works', 'warn');
        this._notify();
        if (!wasConnected) fail(new Error('websocket closed before open'));
      };
      this.ws.onerror = () => {
        this.events?.log?.('[CAMERA] Backend unreachable at ' + this.url, 'error');
        // onerror is followed by onclose; onclose settles the promise.
      };
    });
  }

  disconnect() {
    try { this.ws?.close(); } catch (e) {}
    this.ws = null;
    this.connected = false;
    this.pending.clear();
    // Confirmed passengers stay — they are real waiting people now.
    this.confirmed.clear();
    this._notify();
  }

  setUrl(url) {
    const clean = (url || '').trim();
    if (!clean || clean === this.url) return;
    const wasConnected = this.connected;
    if (this.ws) this.disconnect();
    this.url = clean;
    if (wasConnected) this.connect();
  }

  setFloor(floor) {
    this.floor = Number(floor);
    try { this.ws?.readyState === 1 && this.ws.send(JSON.stringify({ floor: this.floor })); } catch (e) {}
    this._notify();
  }

  /** Feed one frame of backend tracks into the lifecycle. Testable without a camera. */
  ingest(tracks) {
    const seen = new Set();
    for (const t of tracks) {
      if (t.label !== 'person') continue;
      seen.add(t.track_id);
      // Already boarding/waiting — just refresh the miss counter.
      if (this.confirmed.has(t.track_id)) {
        const p = this.pending.get(t.track_id);
        if (p) { p.missed = 0; p.box = t.box; }
        continue;
      }
      let p = this.pending.get(t.track_id);
      if (!p) {
        p = { seen: 0, missed: 0 };
        this.pending.set(t.track_id, p);
      }
      p.seen += 1;
      p.missed = 0;
      p.box = t.box;
      p.type = t.passenger_type || 'adult';
      p.typeConfidence = t.type_confidence ?? 0.5;
      p.luggage = !!t.luggage_detected;
      p.luggageWeight = t.luggage_detected ? (t.luggage_weight || 15) : 0;
      p.ageYears = t.age_years ?? null;
      p.seatedHint = !!t.seated_hint;
      if (p.seen >= this.CONFIRM_FRAMES) this._confirm(t.track_id, p);
    }
    // Miss handling: candidates fade fast, confirmed tracks get DROP_FRAMES.
    for (const [id, p] of [...this.pending]) {
      if (seen.has(id)) continue;
      p.missed += 1;
      const limit = this.confirmed.has(id) ? this.DROP_FRAMES : this.CONFIRM_FRAMES;
      if (p.missed >= limit) {
        this.pending.delete(id);
        if (this.confirmed.has(id)) this._lost(id);
      }
    }
    this._notify();
  }

  _confirm(trackId, p) {
    const type = p.seatedHint && p.type === 'adult' ? 'wheelchair' : p.type;
    const { passenger } = this.passengers.createPassenger({
      floor: this.floor,
      destination: null, // user picks in PEOPLE / modal flow
      type,
      weight: this.DEFAULT_WEIGHTS[type] ?? 75,
      luggage: p.luggage,
      luggageWeight: p.luggageWeight,
    });
    this.confirmed.set(trackId, passenger.id);
    this.events?.log?.(
      `[CAMERA] Track ${trackId} confirmed as ${type} (conf ${p.typeConfidence}) → ${passenger.id} at Floor ${this.floor === 0 ? 'G' : this.floor}`,
      'success',
    );
  }

  _lost(trackId) {
    const pid = this.confirmed.get(trackId);
    this.confirmed.delete(trackId);
    if (pid) {
      // Same ghost path as manual removal: CANCELLED + invalidated + re-routed.
      this.passengers.removePassenger(pid);
      this.events?.log?.(`[CAMERA] Track ${trackId} lost — ${pid} walked out of frame (real ghost call)`, 'warn');
      if (this.onGhost) this.onGhost(trackId, pid);
    }
  }

  snapshot() {
    return {
      connected: this.connected,
      floor: this.floor,
      pending: [...this.pending].filter(([id]) => !this.confirmed.has(id))
        .map(([id, p]) => ({ track_id: id, ...p })),
      confirmed: [...this.confirmed].map(([trackId, passengerId]) => ({ track_id: trackId, passengerId })),
    };
  }

  _notify() { if (this.onUpdate) this.onUpdate(this.snapshot()); }
}
