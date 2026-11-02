'use strict';
const utils = require('@iobroker/adapter-core');
const { normalizeConfig, catalog, resolveRows, buildModel, mergeDevices } = require('./lib/model');
const { LightCore } = require('./lib/core');
const configio = require('./lib/configio');

const OBJECT_TYPES = ['device', 'channel', 'folder', 'state'];

class LichtGruppen extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'licht-gruppen' });
        this.cache = new Map();
        this.queue = Promise.resolve();
        this.core = null;
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /** Schreibt geänderte Werte nacheinander in den Namensraum der Instanz (licht-gruppen.<N>). */
    write(id, val) {
        this.queue = this.queue
            .then(async () => {
                if (this.cache.get(id) === val) return;
                this.cache.set(id, val);
                await this.setStateAsync(id, { val, ack: true });
            })
            .catch((e) => this.log.error(`Schreiben von ${id} fehlgeschlagen: ${e.message}`));
        return this.queue;
    }

    /** Liest Geräte, Kanäle und Datenpunkte einer Instanz. */
    async loadObjects(instance) {
        const out = {};
        for (const t of OBJECT_TYPES) Object.assign(out, (await this.getForeignObjectsAsync(`${instance}.*`, t)) || {});
        return out;
    }

    async scan(cfg) {
        const objs = {};
        for (const inst of [...cfg.switchAdapters, ...cfg.lampAdapters]) {
            objs[inst] = await this.loadObjects(inst);
            if (!Object.keys(objs[inst]).length) this.log.warn(`Instanz ${inst} hat keine Objekte – Instanzname prüfen`);
        }
        return catalog(cfg, objs);
    }

    /** Ergänzt Lampen um die IP-Adresse (govee-smart: <gerät>.info.ip), nur zur Anzeige im Dropdown. */
    async withIp(entries) {
        for (const e of entries) {
            if (e.kind !== 'lamp') continue;
            try {
                const s = await this.getForeignStateAsync(`${e.deviceId}.info.ip`);
                if (s && s.val) e.ip = String(s.val);
            } catch {
                /* kein info.ip vorhanden */
            }
        }
        return entries;
    }

    /** Legt Kanäle und Datenpunkte an und entfernt Altlasten. */
    async ensureStructure(model, prune) {
        const expected = new Set(['info', 'info.connection', 'info.missing']);
        for (const ch of model.channels) {
            expected.add(ch.id);
            await this.extendObjectAsync(ch.id, { type: 'channel', common: { name: ch.name }, native: {} });
        }
        for (const st of model.states) {
            expected.add(st.id);
            await this.extendObjectAsync(st.id, { type: 'state', common: st.common, native: {} });
            const cur = await this.getStateAsync(st.id);
            if (!cur || cur.val === null) await this.setStateAsync(st.id, { val: st.common.def, ack: true });
        }
        if (prune) {
            const all = await this.getAdapterObjectsAsync();
            for (const full of Object.keys(all)) {
                const rel = full.slice(this.namespace.length + 1);
                if (rel && !expected.has(rel) && !rel.startsWith('info.')) {
                    await this.delObjectAsync(rel);
                    this.log.info(`Veralteten Datenpunkt entfernt: ${rel}`);
                }
            }
        }
        for (const [group, list] of Object.entries(model.groups)) await this.setStateChangedAsync(`${group}.info.Count`, { val: list.length, ack: true });
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        const { cfg, errors } = normalizeConfig(this.config, this.log);
        this.cfg = cfg;
        if (errors.length) {
            for (const e of errors) this.log.error(e);
            this.log.error('Konfiguration fehlerhaft – Adapter bleibt inaktiv. Bitte in der Instanz korrigieren');
            return;
        }
        if (!cfg.rows.length) this.log.warn('Keine Zuordnungen konfiguriert – bitte die Tabelle in der Instanz ausfüllen');

        const entries = await this.scan(cfg);
        this.log.info(`Erkannt: ${entries.filter((e) => e.kind === 'switch').length} Schalter, ${entries.filter((e) => e.kind === 'lamp').length} Lampen`);
        for (const e of entries) {
            const extra = [e.pressId && `kurz: ${e.pressId}`, e.longId && `lang: ${e.longId}`, e.levelId && `Helligkeit: ${e.levelId}`].filter(Boolean).join(', ');
            this.log.debug(`${e.kind === 'switch' ? 'Schalter' : 'Lampe'} "${e.label}"${e.renamed ? ` (Quelle: ${e.sourceLabel})` : ''} -> ${e.onId || e.id}${extra ? ` (${extra})` : ''}`);
        }
        const { devices, missing } = resolveRows(cfg.rows, entries);
        for (const m of missing) this.log.warn(`Gruppe ${m.group}: Gerät "${m.device}" nicht gefunden (umbenannt oder Instanz offline?) – übersprungen`);
        await this.setStateAsync('info.missing', { val: missing.map((m) => `${m.group}: ${m.device}`).join('\n'), ack: true });

        const sw = devices.filter((d) => d.kind === 'switch');
        const withLong = sw.filter((d) => d.longId);
        if (sw.length && !withLong.length) this.log.info('Lang-Druck/Dimmen: keiner der zugeordneten Schalter meldet ein Halte-Signal (PRESS_LONG) – nur Ein/Aus möglich');
        else if (withLong.length) this.log.info(`Lang-Druck/Dimmen aktiv für: ${[...new Set(withLong.map((d) => d.label))].join(', ')}`);
        for (const d of devices) if (d.kind === 'lamp' && !d.levelId) this.log.info(`Lampe "${d.label}": kein Helligkeits-Datenpunkt gefunden – wird nur ein-/ausgeschaltet`);

        const model = buildModel(devices);
        await this.ensureStructure(model, cfg.pruneOnStart);

        this.core = new LightCore({
            cfg,
            devices,
            log: this.log,
            io: {
                write: (id, val) => this.write(id, val),
                setSource: (id, val) => this.setForeignStateAsync(id, { val, ack: false }),
            },
        });

        for (const rel of this.core.targets.keys()) this.subscribeStates(rel);
        for (const id of this.core.sourceIds) {
            this.subscribeForeignStates(id);
            await this.core.init(id, await this.getForeignStateAsync(id));
        }
        await this.core.afterInit();
        await this.setStateAsync('info.connection', devices.length > 0, true);
        this.log.info(`Adapter gestartet: ${Object.keys(model.groups).length} Gruppe(n), ${devices.length} Gerät(e), Modus ${cfg.switchMode === 'toggle' ? 'Taster' : 'Schalter'}`);
    }

    onStateChange(id, state) {
        if (!this.core || !state) return;
        const prefix = `${this.namespace}.`;
        if (id.startsWith(prefix)) {
            const rel = id.slice(prefix.length);
            if (state.ack === false && this.core.targets.has(rel)) {
                this.core.writeBack(rel, state).catch((e) => this.log.error(`Schreiben von ${rel}: ${e.message}`));
            }
            return;
        }
        this.core.handle(id, state).catch((e) => this.log.error(`Fehler bei ${id}: ${e.message}`));
    }

    /** Nachrichten der Admin-Oberfläche: Geräteliste (Dropdown), Geräte einlesen, JSON-Export/-Import. */
    async onMessage(obj) {
        if (!obj || !obj.command || !obj.callback) return;
        let reply;
        try {
            const msg = obj.message || {};
            if (obj.command === 'exportConfig') reply = configio.exportConfig(msg.config);
            else if (obj.command === 'importConfig') reply = configio.importConfig(msg.json);
            else if (obj.command === 'listSources') {
                const { cfg, errors } = normalizeConfig(msg.config || this.config);
                const entries = errors.length ? [] : await this.withIp(await this.scan(cfg));
                reply = entries.map((e) => ({
                    value: e.id,
                    label: `${e.kind === 'switch' ? 'Schalter' : 'Lampe'}: ${e.sourceLabel}${e.ip ? ` · ${e.ip}` : ''}${e.renamed ? ` → ${e.label}` : ''}`,
                }));
            } else if (obj.command === 'listDevices' || obj.command === 'discoverDevices') {
                const c = msg.config || this.config;
                const { cfg, errors } = normalizeConfig(c);
                if (errors.length) reply = obj.command === 'listDevices' ? [] : { error: errors.join('; ') };
                else {
                    const entries = await this.scan(cfg);
                    if (obj.command === 'listDevices') {
                        reply = entries.map((e) => ({ value: e.label, label: `${e.kind === 'switch' ? 'Schalter' : 'Lampe'}: ${e.label}` }));
                    } else {
                        const { rows, added } = mergeDevices(c.devices, entries);
                        reply = {
                            native: { devices: rows },
                            result: entries.length
                                ? `${entries.length} Gerät(e) gefunden, ${added.length} neu in die Tabelle übernommen. Bei neuen Zeilen die Gruppe eintragen (Zeilen ohne Gruppe werden ignoriert), danach "Speichern und schließen" drücken.`
                                : `In ${[...cfg.switchAdapters, ...cfg.lampAdapters].join(', ')} wurden keine schaltbaren Geräte gefunden.`,
                        };
                    }
                }
            } else return;
        } catch (e) {
            reply = { error: `Fehler: ${e.message}` };
        }
        this.sendTo(obj.from, obj.command, reply, obj.callback);
    }

    onUnload(callback) {
        try {
            if (this.core) this.core.stop();
            this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }
}

if (require.main !== module) module.exports = (options) => new LichtGruppen(options);
else new LichtGruppen();
