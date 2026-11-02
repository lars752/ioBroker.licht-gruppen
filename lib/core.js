'use strict';
/**
 * Kernlogik: verbindet Schalter, Taster und Lampen einer Gruppe.
 *
 * - Ein Schalter meldet (ack=true) eine Änderung -> alle Lampen der Gruppe folgen, andere Schalter werden nachgeführt.
 *   Modus "state":  Zustand des Schalters = Zustand der Gruppe.
 *   Modus "toggle": jede Meldung des Schalters schaltet die Gruppe um (Taster-Verhalten).
 * - Taster mit Ereignissen (z. B. Matter Generic Switch: PRESS / PRESS_LONG):
 *   kurz drücken  -> Gruppe umschalten (bei Tastern mit Lang-Druck erst nach der Wartezeit, falls kein Lang-Druck folgt)
 *   lang drücken  -> Dimmen: Gruppe aus -> Lampen auf Start-Helligkeit (1 %) einschalten und hochdimmen,
 *                    Gruppe an -> ab aktueller Helligkeit hochdimmen; Loslassen hält die erreichte Helligkeit.
 * - Eine Lampe meldet eine Änderung (z. B. über die Govee-App) -> optional werden die Schalter auf
 *   "mindestens eine Lampe an" nachgeführt (Rückmeldung). Innerhalb der Sperrzeit nach einem eigenen Befehl
 *   werden Lampenmeldungen ignoriert, damit nacheinander eintreffende Rückmeldungen nicht flackern.
 * - Eigene Befehle erzeugen ein Echo der Quelle; das Echo wird erkannt und löst keine weitere Aktion aus.
 *
 * io.write(rel, val)       -> Promise   eigene Zustände (ack=true)
 * io.setSource(id, val)    -> Promise   Quelle beschreiben (ack=false)
 */
const TIMERS = { setTimeout, clearTimeout, setInterval, clearInterval };

class LightCore {
    constructor({ cfg, devices, io, log, now, timers }) {
        this.cfg = cfg;
        this.io = io;
        this.log = log;
        this.now = now || Date.now;
        this.timers = timers || TIMERS;
        this.groups = {};
        this.bySource = new Map(); // Quell-ID -> [{ dev, role: on|press|long|level }]
        this.targets = new Map();  // eigene ID (relativ) -> { group, what } | { device, what }
        for (const d of devices) {
            const dev = { ...d, onId: d.onId === undefined ? d.id : d.onId, val: null, level: null, pending: null, pendingUntil: 0 };
            const g = (this.groups[d.group] = this.groups[d.group] || {
                name: d.group, switches: [], lamps: [], state: null, lockUntil: 0, dim: null, pressTimer: null, chain: Promise.resolve(),
            });
            (dev.kind === 'lamp' ? g.lamps : g.switches).push(dev);
            for (const [role, id] of [['on', dev.onId], ['press', dev.pressId], ['long', dev.longId], ['level', dev.levelId]]) {
                if (!id) continue;
                const list = this.bySource.get(id) || [];
                list.push({ dev, role });
                this.bySource.set(id, list);
            }
            if (dev.onId) this.targets.set(`${d.group}.${d.name}.on`, { device: dev, what: 'on' });
            if (dev.kind === 'lamp' && dev.levelId) this.targets.set(`${d.group}.${d.name}.brightness`, { device: dev, what: 'level' });
        }
        for (const g of Object.values(this.groups)) {
            this.targets.set(`${g.name}.on`, { group: g, what: 'on' });
            if (this.dimmable(g).length) this.targets.set(`${g.name}.brightness`, { group: g, what: 'level' });
        }
    }

    get sourceIds() { return [...this.bySource.keys()]; }

    act(msg) { (this.cfg.logActions ? this.log.info : this.log.debug).call(this.log, msg); }

    dimmable(g) { return g.lamps.filter((l) => l.levelId); }

    /** Lampe ist an oder hat einen noch unbestätigten Einschaltbefehl. */
    lampOn(l) { return l.val === true || (l.pending === true && this.now() <= l.pendingUntil); }

    static bool(v) {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v !== 0;
        if (typeof v === 'string') {
            const s = v.trim().toLowerCase();
            if (['true', 'on', 'an', '1', 'ein'].includes(s)) return true;
            if (['false', 'off', 'aus', '0'].includes(s)) return false;
        }
        return null;
    }

    static level(v) {
        const n = Number(v);
        if (v === null || v === '' || typeof v === 'boolean' || !Number.isFinite(n)) return null;
        return Math.min(100, Math.max(0, Math.round(n)));
    }

    /** Läuft nacheinander je Gruppe (Timer-Callbacks und Meldungen überholen sich nicht). */
    serial(g, fn) {
        g.chain = g.chain.then(fn).catch((e) => this.log.error(`Gruppe ${g.name}: ${e.message}`));
        return g.chain;
    }

    async send(dev, val) {
        if (!dev.onId) return;
        dev.pending = val;
        dev.pendingUntil = this.now() + Math.max(this.cfg.lockMs * 3, 10000);
        await this.io.setSource(dev.onId, val);
    }

    async updateLampsOn(g) {
        await this.io.write(`${g.name}.info.LampsOn`, g.lamps.filter((l) => l.val === true).length);
    }

    /** Gruppenhelligkeit = höchste Helligkeit der eingeschalteten Lampen (beim Dimmen der aktuelle Dimmwert). */
    async updateGroupLevel(g) {
        if (!this.dimmable(g).length) return;
        let lvl = 0;
        if (g.dim) lvl = g.dim.level;
        else for (const l of this.dimmable(g)) if (this.lampOn(l) && l.level !== null) lvl = Math.max(lvl, l.level);
        await this.io.write(`${g.name}.brightness`, lvl);
    }

    /** Startwerte übernehmen, ohne zu schalten (optional Schalter an Lampen angleichen). */
    async init(id, state) {
        for (const { dev, role } of this.bySource.get(id) || []) {
            if (role === 'on') {
                const v = state ? LightCore.bool(state.val) : null;
                dev.val = v;
                if (v !== null) await this.io.write(`${dev.group}.${dev.name}.on`, v);
            } else if (role === 'level' && dev.kind === 'lamp') {
                const v = state ? LightCore.level(state.val) : null;
                dev.level = v;
                if (v !== null) await this.io.write(`${dev.group}.${dev.name}.brightness`, v);
            }
        }
    }

    async afterInit() {
        for (const g of Object.values(this.groups)) {
            const lampVals = g.lamps.map((l) => l.val).filter((v) => v !== null);
            const swVals = g.switches.filter((s) => s.onId).map((s) => s.val).filter((v) => v !== null);
            g.state = lampVals.length ? lampVals.includes(true) : swVals.length ? swVals.includes(true) : false;
            await this.io.write(`${g.name}.on`, g.state);
            await this.updateLampsOn(g);
            await this.updateGroupLevel(g);
            if (this.cfg.syncOnStart && this.cfg.switchMode === 'state') {
                for (const s of g.switches) if (s.onId && !s.pressId && s.val !== null && s.val !== g.state) await this.send(s, g.state);
            }
        }
    }

    /** Meldung einer Quelle (Schalter, Taster, Lampe, Helligkeit). */
    async handle(id, state) {
        const entries = this.bySource.get(id);
        if (!entries) return 'ignored';
        if (!state || !state.ack) return 'command';
        let result = 'ok';
        for (const { dev, role } of entries) {
            const g = this.groups[dev.group];
            if (role === 'on') result = await this.onState(g, dev, state);
            else if (role === 'level') result = await this.onLevel(g, dev, state);
            else if (role === 'press') result = await this.onPress(g, dev, state);
            else if (role === 'long') result = await this.onLong(g, dev, state);
        }
        return result;
    }

    async onState(g, dev, state) {
        const v = LightCore.bool(state.val);
        if (v === null) return 'invalid';
        const prev = dev.val;
        dev.val = v;
        await this.io.write(`${dev.group}.${dev.name}.on`, v);
        if (dev.pending !== null && this.now() <= dev.pendingUntil && v === dev.pending) {
            dev.pending = null;
            if (dev.kind === 'lamp') await this.updateLampsOn(g);
            return 'echo';
        }
        dev.pending = null;
        if (dev.kind === 'lamp') return this.onLamp(g, dev);
        if (dev.pressId) return 'mirror'; // Taster-Ereignisse entscheiden, der Zustand wird nur gespiegelt
        return this.onSwitch(g, dev, v, prev);
    }

    async onLevel(g, dev, state) {
        if (dev.kind !== 'lamp') return 'ignored';
        const v = LightCore.level(state.val);
        if (v === null) return 'invalid';
        dev.level = v;
        await this.io.write(`${dev.group}.${dev.name}.brightness`, v);
        await this.updateGroupLevel(g);
        return 'level';
    }

    async onPress(g, dev, state) {
        if (LightCore.bool(state.val) !== true) return 'release';
        if (dev.longId && this.cfg.longPressWaitMs > 0) {
            if (g.pressTimer) this.timers.clearTimeout(g.pressTimer);
            g.pressTimer = this.timers.setTimeout(() => {
                g.pressTimer = null;
                this.serial(g, () => this.toggle(g, dev));
            }, this.cfg.longPressWaitMs);
            return 'press-wait';
        }
        await this.toggle(g, dev);
        return 'switched';
    }

    async onLong(g, dev, state) {
        const v = LightCore.bool(state.val);
        if (v === null) return 'invalid';
        await this.io.write(`${dev.group}.${dev.name}.pressLong`, v);
        if (v) {
            if (g.pressTimer) { this.timers.clearTimeout(g.pressTimer); g.pressTimer = null; }
            return this.startDim(g, dev);
        }
        return this.stopDim(g);
    }

    async toggle(g, dev) {
        const target = !g.state;
        this.act(`${dev.label} kurz gedrückt -> Gruppe ${g.name} ${target ? 'an' : 'aus'}`);
        await this.apply(g, target, null);
    }

    async onSwitch(g, dev, v, prev) {
        let target;
        if (this.cfg.switchMode === 'toggle') {
            if (prev === v) return 'unchanged';
            target = !g.state;
        } else {
            target = v;
            if (target === g.state && g.lamps.every((l) => l.val === null || l.val === target)) return 'unchanged';
        }
        this.act(`${dev.label} -> Gruppe ${g.name} ${target ? 'an' : 'aus'}`);
        await this.apply(g, target, dev);
        return 'switched';
    }

    async onLamp(g, dev) {
        await this.updateLampsOn(g);
        await this.updateGroupLevel(g);
        if (!this.cfg.lampFeedback || this.now() < g.lockUntil || g.dim) return 'lamp';
        const any = g.lamps.some((l) => l.val === true);
        if (any === g.state) return 'lamp';
        g.state = any;
        this.act(`${dev.label} gemeldet -> Gruppe ${g.name} gilt als ${any ? 'an' : 'aus'}`);
        await this.io.write(`${g.name}.on`, any);
        if (this.cfg.switchMode === 'state') {
            for (const s of g.switches) if (s.onId && !s.pressId && s.val !== any) await this.send(s, any);
        }
        return 'feedback';
    }

    /** Gerät weicht ab oder hat noch einen unbestätigten Befehl. */
    differs(dev, val) { return dev.val !== val || (dev.pending !== null && dev.pending !== val && this.now() <= dev.pendingUntil); }

    /** Gruppe schalten: alle Lampen, andere Schalter nachführen (nur Modus "state"). */
    async apply(g, val, origin) {
        g.state = val;
        g.lockUntil = this.now() + this.cfg.lockMs;
        await this.io.write(`${g.name}.on`, val);
        for (const l of g.lamps) if (this.differs(l, val)) await this.send(l, val);
        if (this.cfg.switchMode === 'state') {
            for (const s of g.switches) if (s !== origin && s.onId && this.differs(s, val)) await this.send(s, val);
        }
        await this.updateGroupLevel(g);
    }

    /** Helligkeit aller dimmbaren Lampen der Gruppe setzen. */
    async setLevels(g, level) {
        for (const l of this.dimmable(g)) {
            l.level = level;
            await this.io.setSource(l.levelId, level);
            await this.io.write(`${g.name}.${l.name}.brightness`, level);
        }
        await this.updateGroupLevel(g);
    }

    /** Lang-Druck beginnt: hochdimmen, bis losgelassen wird oder 100 % erreicht sind. */
    async startDim(g, dev) {
        if (g.dim) return 'dimming';
        if (!this.dimmable(g).length) {
            this.log.warn(`Gruppe ${g.name}: keine dimmbare Lampe (Helligkeits-Datenpunkt fehlt) – Lang-Druck ignoriert`);
            return 'no-dimmable';
        }
        const on = g.state === true && g.lamps.some((l) => this.lampOn(l));
        let level;
        if (!on) {
            level = this.cfg.dimStart;
            this.act(`${dev.label} lang gedrückt -> Gruppe ${g.name} ab ${level} % hochdimmen`);
            await this.setLevels(g, level); // erst Helligkeit, dann einschalten: kein Aufblitzen mit alter Helligkeit
            await this.apply(g, true, null);
        } else {
            level = Math.max(this.cfg.dimStart, ...this.dimmable(g).filter((l) => this.lampOn(l)).map((l) => l.level || 0));
            this.act(`${dev.label} lang gedrückt -> Gruppe ${g.name} ab ${level} % heller`);
        }
        if (level >= 100) return 'max';
        const step = Math.max(1, Math.ceil(((100 - this.cfg.dimStart) * this.cfg.dimStepMs) / this.cfg.dimTimeMs));
        const dim = { level, step };
        g.dim = dim;
        dim.timer = this.timers.setInterval(() => this.serial(g, async () => {
            if (g.dim !== dim) return;
            dim.level = Math.min(100, dim.level + dim.step);
            await this.setLevels(g, dim.level);
            if (dim.level >= 100) await this.stopDim(g);
        }), this.cfg.dimStepMs);
        // Sicherung, falls das Loslassen nie gemeldet wird
        dim.guard = this.timers.setTimeout(() => this.serial(g, () => this.stopDim(g)), this.cfg.dimTimeMs * 2 + 5000);
        await this.updateGroupLevel(g);
        return 'dim-start';
    }

    /** Loslassen: Dimmen beenden, erreichte Helligkeit bleibt. */
    async stopDim(g) {
        const dim = g.dim;
        if (!dim) return 'not-dimming';
        this.timers.clearInterval(dim.timer);
        this.timers.clearTimeout(dim.guard);
        g.dim = null;
        g.lockUntil = this.now() + this.cfg.lockMs;
        this.act(`Gruppe ${g.name}: Dimmen beendet bei ${dim.level} %`);
        await this.updateGroupLevel(g);
        return 'dim-stop';
    }

    /** Schreibzugriff (ack=false) auf einen eigenen Datenpunkt. */
    async writeBack(rel, state) {
        const t = this.targets.get(rel);
        if (!t || !state || state.ack) return 'ignored';
        if (t.what === 'level') {
            const n = LightCore.level(state.val);
            if (n === null) { this.log.warn(`Ungültiger Wert für ${rel}: ${state.val}`); return 'invalid'; }
            if (t.device) {
                this.act(`${rel} = ${n} % -> ${t.device.levelId}`);
                t.device.level = n;
                await this.io.setSource(t.device.levelId, n);
                return 'device-level';
            }
            const g = t.group;
            this.act(`${rel} = ${n} % -> Gruppe ${g.name}`);
            if (n === 0) { await this.apply(g, false, null); return 'group-off'; }
            await this.setLevels(g, n);
            if (!g.state) await this.apply(g, true, null);
            return 'group-level';
        }
        const v = LightCore.bool(state.val);
        if (v === null) { this.log.warn(`Ungültiger Wert für ${rel}: ${state.val}`); return 'invalid'; }
        if (t.group) {
            this.act(`${rel} = ${v} -> Gruppe ${t.group.name}`);
            await this.apply(t.group, v, null);
            return 'group';
        }
        this.act(`${rel} = ${v} -> ${t.device.onId}`);
        await this.send(t.device, v);
        return 'device';
    }

    /** Alle Timer beenden (Adapter-Stopp). */
    stop() {
        for (const g of Object.values(this.groups)) {
            if (g.pressTimer) this.timers.clearTimeout(g.pressTimer);
            if (g.dim) { this.timers.clearInterval(g.dim.timer); this.timers.clearTimeout(g.dim.guard); g.dim = null; }
        }
    }
}

module.exports = { LightCore };
