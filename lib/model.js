'use strict';
/**
 * Konfigurationsprüfung, Geräte-Erkennung (Klartext-Namen) und Datenmodell.
 *
 * Struktur:  <gruppe>.on                    Gruppe schalten (schreibbar)
 *            <gruppe>.Schalter<n>.on         Spiegel eines Schalters (schreibbar -> nur dieses Gerät)
 *            <gruppe>.Lampe<n>.on            Spiegel einer Lampe (schreibbar -> nur dieses Gerät)
 *            <gruppe>.info.Count | LampsOn
 *
 * Geräte werden über ihren Klartext-Namen aus dem Objektbaum der Quell-Instanzen angesprochen
 * (common.name des Geräts, bei mehreren Kanälen ergänzt um den Kanalnamen, z. B. "Flur Doppelschalter – Kanal 2").
 * Ob ein Gerät Schalter oder Lampe ist, ergibt sich aus der Instanz (Schalter-Instanzen / Lampen-Instanzen).
 * Liefert die Quelle keinen sprechenden Namen (z. B. govee-smart im reinen LAN-Betrieb: "H60A4_1a2b"), wird über die
 * Tabelle "Gerätenamen" ein eigener Klartext vergeben (Zuordnung über die stabile Datenpunkt-ID).
 */
const SEG = /^[A-Za-z0-9_-]+$/;
const INSTANCE = /^[A-Za-z0-9_-]+\.\d+$/;
const SEP = ' – ';

// Name des letzten ID-Abschnitts, der als An/Aus-Datenpunkt infrage kommt (klein geschrieben, ohne _ und -)
const ONOFF_NAMES = new Set(['on', 'onoff', 'power', 'powerstate', 'switch', 'state', 'turn', 'light', 'poweronoff', 'switchstate']);
const BAD_ROLE = /^(button|indicator|sensor|value)/i;

const DEFAULTS = {
    switchAdapters: 'matter.0',
    lampAdapters: 'govee-smart.0',
    switchMode: 'state',
    lampFeedback: true,
    syncOnStart: false,
    lockMs: 3000,
    dimTimeMs: 4000,
    dimStepMs: 300,
    dimStart: 1,
    longPressWaitMs: 800,
    pruneOnStart: true,
    logActions: false,
    devices: [],
    names: [],
};

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const keyOf = (label) => String(label || '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Klartext aus common.name (String oder Übersetzungsobjekt). */
function nameOf(obj, fallback = '') {
    const n = obj && obj.common && obj.common.name;
    if (typeof n === 'string' && n.trim()) return n.trim();
    if (n && typeof n === 'object') {
        for (const l of ['de', 'en']) if (typeof n[l] === 'string' && n[l].trim()) return n[l].trim();
        const any = Object.values(n).find((v) => typeof v === 'string' && v.trim());
        if (any) return any.trim();
    }
    return fallback;
}

/** Bewertet einen Datenpunkt als An/Aus-Kandidat; 0 = ungeeignet, höher = besser. */
function scoreState(id, obj) {
    if (!obj || obj.type !== 'state' || !obj.common) return 0;
    const c = obj.common;
    if (c.type !== 'boolean' || c.write === false) return 0;
    const role = String(c.role || '');
    const last = String(id).split('.').pop().toLowerCase().replace(/[_-]/g, '');
    if (BAD_ROLE.test(role) && !ONOFF_NAMES.has(last)) return 0;
    let s = 0;
    if (/^switch\.light/i.test(role)) s += 30;
    else if (/^switch\.power/i.test(role)) s += 25;
    else if (/^switch(\.|$)/i.test(role)) s += 20;
    if (ONOFF_NAMES.has(last)) s += 10;
    return s;
}

/** Taster-Ereignis kurz (PRESS) bzw. lang (PRESS_LONG, true = gehalten, false = losgelassen), z. B. Matter Generic Switch. */
function buttonKind(id, obj) {
    if (!obj || obj.type !== 'state' || !obj.common || obj.common.type !== 'boolean') return null;
    const role = String(obj.common.role || '');
    const last = String(id).split('.').pop().toLowerCase().replace(/[_-]/g, '');
    if (/^button\.long/i.test(role) || last === 'presslong' || last === 'longpress') return 'long';
    if (/^button\.press$/i.test(role) || last === 'press') return 'press';
    return null;
}

/** Helligkeit 0–100 % (beschreibbare Zahl, Rolle level.brightness/level.dimmer oder Name brightness/level/dimmer). */
function isLevel(id, obj) {
    if (!obj || obj.type !== 'state' || !obj.common) return false;
    const c = obj.common;
    if (c.type !== 'number' || c.write === false) return false;
    const role = String(c.role || '');
    const last = String(id).split('.').pop().toLowerCase().replace(/[_-]/g, '');
    if (/^level\.(color|temperature|volume|blind|tilt|valve)/i.test(role)) return false;
    return /^level\.(brightness|dimmer)$/i.test(role) || ['brightness', 'level', 'dimmer', 'bri'].includes(last);
}

/** Gerät und Kanal zu einem Ordner im Objektbaum. */
function ancestry(folder, objects) {
    const parts = folder.split('.');
    let device = null;
    let channel = null;
    for (let i = parts.length; i >= 3; i--) {
        const pid = parts.slice(0, i).join('.');
        const o = objects[pid];
        if (!o) continue;
        if (o.type === 'device' && !device) device = { id: pid, obj: o };
        else if ((o.type === 'channel' || o.type === 'folder') && !channel && !device) channel = { id: pid, obj: o };
    }
    if (!device) {
        const top = parts.slice(0, 3).join('.');
        device = { id: top, obj: objects[top] || null };
        if (channel && channel.id === top) channel = null;
    }
    return { device, channel };
}

/**
 * Erkennt in den Objekten einer Instanz alle schaltbaren Geräte.
 * objects: { id: obj } (States, Kanäle, Geräte der Instanz).
 * Liefert [{ id, onId, pressId, longId, levelId, instance, label, … }]; id = Haupt-Datenpunkt (An/Aus, sonst Taster).
 * Je Ordner (ID ohne letzten Abschnitt) höchstens ein Gerät; An/Aus = Datenpunkt mit der besten Bewertung.
 * Ein Gerät mit genau einem An/Aus-Ordner und genau einem Taster-Ordner wird zu einem Eintrag zusammengefasst.
 */
function discover(instance, objects, kind = 'switch') {
    const prefix = `${instance}.`;
    const folders = new Map(); // Ordner -> { on, onScore, press, long, level }
    const slot = (folder) => folders.get(folder) || folders.set(folder, {}).get(folder);
    for (const [id, obj] of Object.entries(objects || {})) {
        if (!id.startsWith(prefix) || id.startsWith(`${prefix}info.`)) continue;
        const folder = id.slice(0, id.lastIndexOf('.'));
        const score = scoreState(id, obj);
        if (score) {
            const f = slot(folder);
            if (!f.on || score > f.onScore || (score === f.onScore && id < f.on)) { f.on = id; f.onScore = score; }
            continue;
        }
        const b = kind === 'switch' ? buttonKind(id, obj) : null;
        if (b) { slot(folder)[b] = slot(folder)[b] || id; continue; }
        if (kind === 'lamp' && isLevel(id, obj)) slot(folder).level = slot(folder).level || id;
    }
    const found = [];
    for (const [folder, f] of folders) {
        if (!f.on && !f.press && !f.long) continue; // nur Helligkeit ohne An/Aus: kein eigenes Gerät
        const id = f.on || f.press || f.long;
        const parts = id.split('.');
        const { device, channel } = ancestry(folder, objects);
        found.push({
            id,
            onId: f.on || null,
            pressId: f.press || null,
            longId: f.long || null,
            levelId: f.level || null,
            instance,
            deviceId: device.id,
            deviceName: nameOf(device.obj, parts[2]),
            channelName: channel ? nameOf(channel.obj, channel.id.split('.').pop()) : '',
            stateName: nameOf(objects[id], parts[parts.length - 1]),
            rest: parts.slice(device.id.split('.').length).join('.'),
        });
    }
    // Zusammenfassen: ein An/Aus-Kanal + ein reiner Taster-Kanal im selben Gerät
    const perDevice = {};
    for (const f of found) (perDevice[f.deviceId] = perDevice[f.deviceId] || []).push(f);
    for (const [devId, list] of Object.entries(perDevice)) {
        const ons = list.filter((f) => f.onId);
        const btns = list.filter((f) => !f.onId);
        if (ons.length === 1 && btns.length === 1) {
            ons[0].pressId = ons[0].pressId || btns[0].pressId;
            ons[0].longId = ons[0].longId || btns[0].longId;
            perDevice[devId] = ons;
        }
    }
    const result = [];
    // Klartext: Gerätename, bei mehreren Kanälen je Gerät ergänzt um den Kanal
    for (const list of Object.values(perDevice)) {
        for (const f of list) {
            f.label = list.length === 1 ? f.deviceName : `${f.deviceName}${SEP}${f.channelName || f.stateName || f.rest}`;
        }
        dedupe(list, (f) => `${f.deviceName}${SEP}${f.rest}`);
        result.push(...list);
    }
    return result.sort((a, b) => a.label.localeCompare(b.label, 'de'));
}

/** Macht Klartext-Namen eindeutig (erst mit alternativer Bezeichnung, dann mit ID). */
function dedupe(list, alt) {
    const count = (arr) => arr.reduce((m, f) => m.set(keyOf(f.label), (m.get(keyOf(f.label)) || 0) + 1), new Map());
    let c = count(list);
    for (const f of list) if (c.get(keyOf(f.label)) > 1) f.label = alt(f);
    c = count(list);
    for (const f of list) if (c.get(keyOf(f.label)) > 1) f.label = `${f.label} [${f.id}]`;
}

/**
 * Erkennt Geräte aller Schalter- und Lampen-Instanzen und vergibt global eindeutige Klartext-Namen.
 * objectsByInstance: { 'matter.0': {...}, 'govee-smart.0': {...} }
 */
function catalog(cfg, objectsByInstance) {
    const all = [];
    for (const [kind, list] of [['switch', cfg.switchAdapters], ['lamp', cfg.lampAdapters]]) {
        for (const inst of list) for (const f of discover(inst, objectsByInstance[inst], kind)) all.push({ ...f, kind });
    }
    dedupe(all, (f) => `${f.label} (${f.instance})`);
    // Eigene Namen: Zuordnung über die Datenpunkt-ID (stabil) oder den Namen der Quelle
    const rename = new Map();
    for (const r of cfg.names || []) rename.set(keyOf(r.source), r.name);
    for (const f of all) {
        f.sourceLabel = f.label;
        const own = rename.get(keyOf(f.id)) || rename.get(keyOf(f.label));
        if (own) { f.label = own; f.renamed = true; }
    }
    dedupe(all, (f) => `${f.label} (${f.sourceLabel})`);
    return all.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label, 'de') : a.kind === 'switch' ? -1 : 1));
}

const listOf = (v, def) => String(v === undefined ? def : v).split(',').map((s) => s.trim()).filter(Boolean);

/** Prüft die Konfiguration: Fehler in globalen Werten -> errors, ungültige Zeilen -> Warnung + übersprungen. */
function normalizeConfig(native, log = silent) {
    const n = native || {};
    const errors = [];
    const warnings = [];
    const warn = (m) => { warnings.push(m); log.warn(m); };
    const cfg = {};

    for (const [key, label, ex] of [['switchAdapters', 'Schalter-Instanz', 'matter.0'], ['lampAdapters', 'Lampen-Instanz', 'govee-smart.0']]) {
        const list = listOf(n[key], DEFAULTS[key]);
        const bad = list.find((a) => !INSTANCE.test(a));
        if (!list.length || bad !== undefined) errors.push(`${label} „${bad || ''}“ ungültig (erwartet z. B. ${ex})`);
        cfg[key] = list;
    }
    const both = cfg.switchAdapters.find((a) => cfg.lampAdapters.includes(a));
    if (both) errors.push(`Instanz ${both} ist sowohl als Schalter- als auch als Lampen-Instanz eingetragen`);

    cfg.switchMode = n.switchMode === 'toggle' ? 'toggle' : 'state';
    cfg.lampFeedback = n.lampFeedback === undefined ? DEFAULTS.lampFeedback : n.lampFeedback === true || n.lampFeedback === 'true';
    cfg.syncOnStart = n.syncOnStart === true || n.syncOnStart === 'true';
    cfg.pruneOnStart = n.pruneOnStart !== false && n.pruneOnStart !== 'false';
    cfg.logActions = n.logActions === true || n.logActions === 'true';
    const number = (key, label, min, max) => {
        const raw = n[key] === undefined || n[key] === '' ? DEFAULTS[key] : n[key];
        const v = Number(raw);
        if (!Number.isFinite(v) || v < min || v > max) { errors.push(`${label} muss zwischen ${min} und ${max} liegen (ist: ${raw})`); cfg[key] = DEFAULTS[key]; return; }
        cfg[key] = v;
    };
    number('lockMs', 'Sperrzeit', 0, 60000);
    number('dimTimeMs', 'Dimmdauer', 500, 60000);
    number('dimStepMs', 'Dimm-Schrittweite', 100, 5000);
    number('dimStart', 'Start-Helligkeit', 1, 100);
    number('longPressWaitMs', 'Wartezeit kurz/lang', 0, 5000);

    cfg.rows = [];
    const seen = new Set();
    for (const [i, row] of (Array.isArray(n.devices) ? n.devices : []).entries()) {
        const group = String((row && row.group) || '').trim();
        const device = String((row && row.device) || '').trim().replace(/\s+/g, ' ');
        const where = `Zeile ${i + 1}`;
        if (!group && !device) continue;
        if (!SEG.test(group) || group.toLowerCase() === 'info') { warn(`${where}: Gruppe „${group}“ ungültig (erlaubt: A-Z, 0-9, _, -; „info“ ist reserviert) – übersprungen`); continue; }
        if (!device) { warn(`${where}: Gerät fehlt – übersprungen`); continue; }
        const k = `${group.toLowerCase()}|${keyOf(device)}`;
        if (seen.has(k)) { warn(`${where}: „${device}“ ist in Gruppe ${group} doppelt eingetragen – übersprungen`); continue; }
        seen.add(k);
        cfg.rows.push({ group, device });
    }

    cfg.names = [];
    const sources = new Set();
    const names = new Set();
    for (const [i, row] of (Array.isArray(n.names) ? n.names : []).entries()) {
        const source = String((row && row.source) || '').trim();
        const name = String((row && row.name) || '').trim().replace(/\s+/g, ' ');
        const where = `Gerätenamen Zeile ${i + 1}`;
        if (!source && !name) continue;
        if (!source || !name) { warn(`${where}: Gerät und Klartext-Name müssen beide ausgefüllt sein – übersprungen`); continue; }
        if (sources.has(keyOf(source))) { warn(`${where}: „${source}“ ist doppelt benannt – übersprungen`); continue; }
        if (names.has(keyOf(name))) { warn(`${where}: Name „${name}“ ist doppelt vergeben – übersprungen`); continue; }
        sources.add(keyOf(source));
        names.add(keyOf(name));
        cfg.names.push({ source, name });
    }
    return { cfg, errors, warnings };
}

/**
 * Verknüpft die Tabellenzeilen mit erkannten Geräten. Liefert { devices, missing }.
 * Namen je Gruppe: Schalter1, Schalter2 … / Lampe1, Lampe2 … in Tabellenreihenfolge.
 */
function resolveRows(rows, entries) {
    const byKey = new Map(entries.map((e) => [keyOf(e.label), e]));
    const devices = [];
    const missing = [];
    const counters = {};
    for (const r of rows) {
        const e = byKey.get(keyOf(r.device));
        if (!e) { missing.push(r); continue; }
        const base = e.kind === 'lamp' ? 'Lampe' : e.onId ? 'Schalter' : 'Taster';
        const ck = `${r.group}|${base}`;
        counters[ck] = (counters[ck] || 0) + 1;
        devices.push({
            group: r.group, kind: e.kind, label: e.label, id: e.id, name: `${base}${counters[ck]}`,
            onId: e.onId || null, pressId: e.pressId || null, longId: e.longId || null, levelId: e.levelId || null,
        });
    }
    return { devices, missing };
}

const rowsOf = (rows) => rows.map((r) => ({ group: r.group, device: r.device }));
const namesOf = (names) => names.map((r) => ({ source: r.source, name: r.name }));

/** Kanäle und Datenpunkte (IDs relativ zum Namensraum der Instanz). */
function buildModel(devices) {
    const channels = [];
    const states = [];
    const groups = {};
    for (const d of devices) (groups[d.group] = groups[d.group] || []).push(d);
    for (const [group, list] of Object.entries(groups)) {
        channels.push({ id: group, name: `Gruppe ${group}` }, { id: `${group}.info`, name: `Information ${group}` });
        states.push(
            { id: `${group}.on`, common: { name: `Gruppe ${group} an/aus`, type: 'boolean', role: 'switch.light', read: true, write: true, def: false } },
            { id: `${group}.info.Count`, common: { name: `Anzahl Geräte in ${group}`, type: 'number', role: 'value', read: true, write: false, def: list.length } },
            { id: `${group}.info.LampsOn`, common: { name: `Eingeschaltete Lampen in ${group}`, type: 'number', role: 'value', read: true, write: false, def: 0 } },
        );
        if (list.some((d) => d.kind === 'lamp' && d.levelId)) {
            states.push({ id: `${group}.brightness`, common: { name: `Helligkeit ${group}`, type: 'number', unit: '%', min: 0, max: 100, role: 'level.brightness', read: true, write: true, def: 0 } });
        }
        for (const d of list) {
            channels.push({ id: `${group}.${d.name}`, name: d.label });
            if (d.onId) states.push({ id: `${group}.${d.name}.on`, common: { name: `${d.label} an/aus`, type: 'boolean', role: d.kind === 'lamp' ? 'switch.light' : 'switch', read: true, write: true, def: false } });
            if (d.kind === 'lamp' && d.levelId) states.push({ id: `${group}.${d.name}.brightness`, common: { name: `${d.label} Helligkeit`, type: 'number', unit: '%', min: 0, max: 100, role: 'level.brightness', read: true, write: true, def: 0 } });
            if (d.longId) states.push({ id: `${group}.${d.name}.pressLong`, common: { name: `${d.label} lang gedrückt`, type: 'boolean', role: 'indicator', read: true, write: false, def: false } });
        }
    }
    return { channels, states, groups };
}

/** Ergänzt die Tabelle um erkannte, noch nicht eingetragene Geräte (Gruppe bleibt leer). */
function mergeDevices(rows, entries) {
    const out = (Array.isArray(rows) ? rows : []).map((r) => ({ ...r }));
    const have = new Set(out.map((r) => keyOf(r.device)).filter(Boolean));
    const added = [];
    for (const e of entries) {
        if (have.has(keyOf(e.label))) continue;
        out.push({ group: '', device: e.label });
        have.add(keyOf(e.label));
        added.push(e.label);
    }
    return { rows: out, added };
}

module.exports = { DEFAULTS, SEP, nameOf, scoreState, buttonKind, isLevel, discover, catalog, normalizeConfig, resolveRows, rowsOf, buildModel, mergeDevices, keyOf, namesOf };
