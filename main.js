'use strict';
const utils = require('@iobroker/adapter-core');
const { normalizeConfig, catalog, resolveRows, buildModel, mergeDevices, assignRooms, nameOf } = require('./lib/model');
const { LightCore } = require('./lib/core');
const configio = require('./lib/configio');

const OBJECT_TYPES = ['device', 'channel', 'folder', 'state'];

// Was aus einer Meldung der Quelle wurde (für das Log); ALWAYS = immer als info, sonst nur bei "Schaltvorgänge im Log"
const RESULT_TEXT = {
    switched: 'Gruppe geschaltet',
    'other-button': 'andere Taste desselben Geräts, ignoriert',
    unsupported: 'Aktion (double/hold/…) wird nicht unterstützt, ignoriert – nur "single" schaltet',
    unchanged: 'keine Aktion: Gruppe und Lampen stehen schon auf diesem Zustand',
    mirror: 'keine Aktion: Zustand nur gespiegelt, der Taster-Datenpunkt (PRESS) entscheidet',
    invalid: 'ungültiger Wert, ignoriert',
    'no-dimmable': 'keine dimmbare Lampe in der Gruppe',
    echo: 'Bestätigung eines eigenen Befehls',
    command: 'Befehl (ack=false), keine Meldung des Geräts – ignoriert',
    feedback: 'Lampe geschaltet: Gruppe und Schalter nachgeführt',
    lamp: 'Lampe gemeldet',
    level: 'Helligkeit gemeldet',
    'press-wait': 'kurzer Druck, wartet auf möglichen Lang-Druck',
    'dim-start': 'Dimmen gestartet',
    'dim-stop': 'Dimmen beendet',
    release: 'Taste losgelassen',
};
const ALWAYS = new Set(['unchanged', 'mirror', 'invalid', 'no-dimmable', 'unsupported']);

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

    /** Alle installierten Instanzen als Auswahlliste (ohne diesen Adapter und reine Infrastruktur). */
    async listInstances() {
        const view = await this.getObjectViewAsync('system', 'instance', { startkey: 'system.adapter.', endkey: 'system.adapter.\u9999' });
        const skip = new Set([this.name, 'admin', 'discovery']);
        const out = [];
        for (const row of (view && view.rows) || []) {
            const id = String(row.id || '').replace(/^system\.adapter\./, '');
            const adapter = id.replace(/\.\d+$/, '');
            const common = (row.value && row.value.common) || {};
            if (!/\.\d+$/.test(id) || skip.has(adapter) || ['storage', 'visualization'].includes(common.type)) continue;
            const title = nameOf({ common: { name: common.titleLang || common.title || '' } }, '');
            out.push({ value: id, label: title && title.toLowerCase() !== adapter ? `${id} (${title})` : id });
        }
        return out.sort((a, b) => a.value.localeCompare(b.value, 'de', { numeric: true }));
    }

    /** ioBroker-Räume (enum.rooms.*) mit ihren Mitgliedern. */
    async loadRooms() {
        const objs = (await this.getForeignObjectsAsync('enum.rooms.*', 'enum')) || {};
        return Object.values(objs).map((o) => ({ name: nameOf(o, String(o._id || '').split('.').pop()), members: (o.common && o.common.members) || [] }));
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
        const expected = new Set(['info', 'info.connection', 'info.missing', 'info.offline']);
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
        if (!cfg.switchAdapters.length || !cfg.lampAdapters.length) this.log.warn('Es ist keine Schalter- bzw. keine Lampen-Instanz ausgewählt – bitte in den Einstellungen wählen');
        for (const inst of [...cfg.switchAdapters, ...cfg.lampAdapters]) {
            if (!(await this.getForeignObjectAsync(`system.adapter.${inst}`))) this.log.warn(`Instanz ${inst} existiert nicht – bitte in den Einstellungen eine vorhandene Instanz wählen`);
        }
        if (!cfg.rows.length) this.log.warn('Keine Zuordnungen konfiguriert – bitte die Tabelle in der Instanz ausfüllen');

        const entries = await this.scan(cfg);
        this.log.info(`Erkannt: ${entries.filter((e) => e.kind === 'switch').length} Schalter, ${entries.filter((e) => e.kind === 'lamp').length} Lampen`);
        for (const e of entries) {
            const extra = [e.pressId && `kurz: ${e.pressId}`, e.longId && `lang: ${e.longId}`, e.actionId && `Taste: ${e.actionId}`, e.levelId && `Helligkeit: ${e.levelId}`].filter(Boolean).join(', ');
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
        await this.watchAlive(devices);
        await this.setStateAsync('info.connection', devices.length > 0, true);
        for (const [group, list] of Object.entries(model.groups)) {
            const part = (kind) => list.filter((d) => d.kind === kind).map((d) => `${d.label} [${d.onId || d.pressId || d.actionId || d.id}]`).join(', ') || '-';
            this.log.info(`Gruppe ${group}: Schalter/Taster: ${part('switch')} | Lampen: ${part('lamp')}`);
            if (!list.some((d) => d.kind === 'switch') || !list.some((d) => d.kind === 'lamp')) this.log.warn(`Gruppe ${group} hat ${list.some((d) => d.kind === 'switch') ? 'keine Lampe' : 'keinen Schalter'} – es passiert nichts`);
        }
        this.log.info(`Adapter gestartet: ${Object.keys(model.groups).length} Gruppe(n), ${devices.length} Gerät(e), Modus ${cfg.switchMode === 'toggle' ? 'Taster' : 'Schalter'}`);
    }

    /** Meldet Geräte, die nicht erreichbar sind (defekt, ausgesteckt, kein WLAN). Die Gruppen arbeiten mit den übrigen Geräten weiter. */
    async watchAlive(devices) {
        this.alive = new Map(); // Datenpunkt -> { labels: [Gruppe/Gerät], val }
        for (const d of devices) {
            if (!d.aliveId) continue;
            const e = this.alive.get(d.aliveId) || { labels: [], val: null };
            e.labels.push(`${d.group}/${d.label}`);
            this.alive.set(d.aliveId, e);
        }
        for (const [id, e] of this.alive) {
            this.subscribeForeignStates(id);
            const st = await this.getForeignStateAsync(id);
            e.val = st ? st.val === true || st.val === 1 || st.val === 'true' : null;
            if (e.val === false) this.log.warn(`Nicht erreichbar: ${e.labels.join(', ')} (${id}) – die Gruppe arbeitet mit den übrigen Geräten weiter. Bei dauerhaftem Ausfall die Zeile in der Tabelle entfernen`);
        }
        await this.publishOffline();
    }

    async publishOffline() {
        const list = [...this.alive.values()].filter((e) => e.val === false).flatMap((e) => e.labels);
        await this.setStateChangedAsync('info.offline', { val: list.join('\n'), ack: true });
    }

    onAliveChange(id, state) {
        const e = this.alive && this.alive.get(id);
        if (!e || !state) return false;
        const val = state.val === true || state.val === 1 || state.val === 'true';
        if (val !== e.val) {
            e.val = val;
            if (val) this.log.info(`Wieder erreichbar: ${e.labels.join(', ')}`);
            else this.log.warn(`Nicht erreichbar: ${e.labels.join(', ')} (${id}) – die Gruppe arbeitet mit den übrigen Geräten weiter`);
            this.publishOffline().catch(() => {});
        }
        return !this.core.bySource.has(id);
    }

    onStateChange(id, state) {
        if (!this.core || !state) return;
        if (this.onAliveChange(id, state)) return;
        const prefix = `${this.namespace}.`;
        if (id.startsWith(prefix)) {
            const rel = id.slice(prefix.length);
            if (state.ack === false && this.core.targets.has(rel)) {
                this.core.writeBack(rel, state).catch((e) => this.log.error(`Schreiben von ${rel}: ${e.message}`));
            }
            return;
        }
        const meta = (this.core.bySource.get(id) || [])[0];
        this.core.handle(id, state).then(
            (result) => {
                if (result === 'ignored') return;
                const text = `${meta ? `${meta.dev.group}/${meta.dev.label}` : id}: ${id} = ${state.val} (ack=${state.ack}) -> ${RESULT_TEXT[result] || result}`;
                (ALWAYS.has(result) || this.cfg.logActions ? this.log.info : this.log.debug).call(this.log, text);
            },
            (e) => this.log.error(`Fehler bei ${id}: ${e.message}`),
        );
    }

    /** Nachrichten der Admin-Oberfläche: Geräteliste (Dropdown), Geräte einlesen, JSON-Export/-Import. */
    async onMessage(obj) {
        if (!obj || !obj.command || !obj.callback) return;
        let reply;
        try {
            const msg = obj.message || {};
            if (obj.command === 'exportConfig') reply = configio.exportConfig(msg.config);
            else if (obj.command === 'importConfig') reply = configio.importConfig(msg.json);
            else if (obj.command === 'listInstances') reply = await this.listInstances();
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
                        assignRooms(entries, await this.loadRooms());
                        const { rows, added, filled, open, rooms } = mergeDevices(c.devices, entries);
                        const byEnum = entries.filter((e) => e.roomSource === 'enum').length;
                        reply = {
                            native: { devices: rows },
                            result: entries.length
                                ? `${entries.length} Gerät(e) gefunden, ${added.length} neu in die Tabelle übernommen. Gruppe aus dem Raum vorbelegt bei ${filled.length} Gerät(en) (${byEnum} aus ioBroker-Räumen, ${entries.filter((e) => e.roomSource === 'name').length} aus dem Gerätenamen)${rooms.length ? `: ${rooms.join(', ')}` : ''}. ${open ? `${open} Zeile(n) ohne Gruppe: bitte eintragen, sonst werden sie ignoriert. ` : ''}Danach "Speichern und schließen" drücken.`
                                : `In ${[...cfg.switchAdapters, ...cfg.lampAdapters].join(', ') || 'den gewählten Instanzen'} wurden keine schaltbaren Geräte gefunden.`,
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
