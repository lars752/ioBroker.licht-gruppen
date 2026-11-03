'use strict';
const assert = require('assert');
const { normalizeConfig, discover, catalog, resolveRows, buildModel, mergeDevices, roomFromName, groupId, assignRooms } = require('../lib/model');
const { LightCore } = require('../lib/core');
const { exportConfig, importConfig } = require('../lib/configio');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };
const silent = { debug() {}, info() {}, warn() {}, error() {} };

// Objektbaum ähnlich matter.0 (Controller) und eines Govee-Adapters
const dev = (name) => ({ type: 'device', common: { name } });
const ch = (name) => ({ type: 'channel', common: { name } });
const st = (name, role, extra = {}) => ({ type: 'state', common: { name, type: 'boolean', role, read: true, write: true, ...extra } });
const MATTER = {
    'matter.0.controller': { type: 'folder', common: { name: 'Controller' } },
    'matter.0.controller.111': dev('Wohnzimmer Schalter'),
    'matter.0.controller.111.1': ch('OnOff Light'),
    'matter.0.controller.111.1.power': st('Power', 'switch.light'),
    'matter.0.controller.111.1.powerAck': st('Power ack', 'indicator', { write: false }),
    'matter.0.controller.222': dev('Flur Doppelschalter'),
    'matter.0.controller.222.1': ch('Kanal 1'),
    'matter.0.controller.222.1.power': st('Power', 'switch.light'),
    'matter.0.controller.222.2': ch('Kanal 2'),
    'matter.0.controller.222.2.power': st('Power', 'switch.light'),
    'matter.0.controller.333': dev({ de: 'Küche Schalter', en: 'Kitchen switch' }),
    'matter.0.controller.333.1.onOff': st('OnOff', 'switch'),
    'matter.0.controller.333.1.identify': st('Identify', 'button'),
    'matter.0.info.connection': st('connected', 'indicator.connected'),
    // Taster als Matter Generic Switch (momentary, mit Lang-Druck)
    'matter.0.controller.444': dev('Bad Taster'),
    'matter.0.controller.444.1': ch('Generic Switch'),
    'matter.0.controller.444.1.PRESS': st('Press', 'button.press', { write: false }),
    'matter.0.controller.444.1.PRESS_LONG': st('Press long', 'button.long', { write: false }),
    // Schalter mit Relais-Endpunkt und eigenem Taster-Endpunkt -> ein Gerät
    'matter.0.controller.555': dev('Schlafzimmer Schalter'),
    'matter.0.controller.555.1.power': st('Power', 'switch.light'),
    'matter.0.controller.555.2.PRESS': st('Press', 'button.press', { write: false }),
    'matter.0.controller.555.2.PRESS_LONG': st('Press long', 'button.long', { write: false }),
};
// govee-smart im reinen LAN-Betrieb: Name = <SKU>_<letzte 4 Zeichen>, An/Aus = control.power
const lanLamp = (id, name) => ({
    [`govee-smart.0.devices.${id}`]: dev(name),
    [`govee-smart.0.devices.${id}.control`]: ch({ de: 'Steuerung', en: 'Control' }),
    [`govee-smart.0.devices.${id}.control.power`]: st({ de: 'Ein/Aus', en: 'Power' }, 'switch'),
    [`govee-smart.0.devices.${id}.control.brightness`]: { type: 'state', common: { name: 'Helligkeit', type: 'number', role: 'level.brightness', write: true } },
    [`govee-smart.0.devices.${id}.info`]: ch('Geräteinformationen'),
    [`govee-smart.0.devices.${id}.info.online`]: st('Online', 'indicator.reachable', { write: false }),
    [`govee-smart.0.devices.${id}.info.name`]: { type: 'state', common: { name: 'Name', type: 'string', role: 'info.name', write: false } },
});
const GOVEE = {
    'govee-smart.0.devices': { type: 'folder', common: { name: { de: 'Geräte', en: 'Devices' } } },
    'govee-smart.0.info.connection': st('connected', 'indicator.connected', { write: false }),
    ...lanLamp('h60a4-1a2b', 'H60A4_1a2b'),
    ...lanLamp('h60a4-77c0', 'H60A4_77c0'),
    ...lanLamp('h1250-0f3e', 'H1250_0f3e'),
};
const L_WZ = 'govee-smart.0.devices.h60a4-1a2b.control.power';
const L_F = 'govee-smart.0.devices.h60a4-77c0.control.power';
const L_K = 'govee-smart.0.devices.h1250-0f3e.control.power';
// Eigene Klartext-Namen: per Datenpunkt-ID oder per Name der Quelle
const NAMES = [
    { source: L_WZ, name: 'Wohnzimmer Decke' },
    { source: 'h60a4_77C0', name: 'Flur Decke' },
    { source: L_K, name: 'Küche Decke' },
];

const ROWS = [
    { group: 'Wohnzimmer', device: 'Wohnzimmer Schalter' },
    { group: 'Wohnzimmer', device: 'Wohnzimmer Decke' },
    { group: 'Flur', device: 'Flur Doppelschalter – Kanal 1' },
    { group: 'Flur', device: 'flur  decke' }, // Groß-/Kleinschreibung und Leerzeichen egal
    { group: 'Kueche', device: 'Küche Schalter' },
    { group: 'Kueche', device: 'Flur Doppelschalter – Kanal 2' },
    { group: 'Kueche', device: 'Küche Decke' },
];

// Simulierte Timer: tick(ms) lässt die Zeit laufen und führt fällige Timer aus
function fakeTimers(t) {
    let seq = 0;
    const jobs = new Map();
    const timers = {
        setTimeout: (fn, ms) => { const id = ++seq; jobs.set(id, { fn, at: t.now + ms }); return id; },
        clearTimeout: (id) => jobs.delete(id),
        setInterval: (fn, ms) => { const id = ++seq; jobs.set(id, { fn, at: t.now + ms, every: ms }); return id; },
        clearInterval: (id) => jobs.delete(id),
    };
    const tick = async (ms, core) => {
        const end = t.now + ms;
        for (;;) {
            let next = null;
            for (const [id, j] of jobs) if (j.at <= end && (!next || j.at < next[1].at)) next = [id, j];
            if (!next) break;
            const [id, j] = next;
            t.now = j.at;
            if (j.every) j.at += j.every; else jobs.delete(id);
            j.fn();
            for (const g of Object.values(core.groups)) await g.chain;
        }
        t.now = end;
    };
    return { timers, tick, jobs };
}

function setup(over = {}) {
    const { cfg, errors } = normalizeConfig({ devices: ROWS, names: NAMES, ...over }, silent);
    assert.deepStrictEqual(errors, []);
    const entries = catalog(cfg, { 'matter.0': MATTER, 'govee-smart.0': GOVEE });
    const { devices, missing } = resolveRows(cfg.rows, entries);
    const t = { now: 1_000_000 };
    const w = {};
    const sets = [];
    const ft = fakeTimers(t);
    const core = new LightCore({
        cfg, devices, log: silent, now: () => t.now, timers: ft.timers,
        io: { write: async (id, v) => { w[id] = v; }, setSource: async (id, v) => { sets.push([id, v]); } },
    });
    return { cfg, entries, devices, missing, core, w, sets, t, tick: (ms) => ft.tick(ms, core), jobs: ft.jobs };
}
const ack = (val) => ({ val, ack: true });
const SW_WZ = 'matter.0.controller.111.1.power';
const SW_F1 = 'matter.0.controller.222.1.power';
const SW_F2 = 'matter.0.controller.222.2.power';

(async () => {
    await test('Konfiguration: Standardwerte gültig', () => {
        const r = normalizeConfig({}, silent);
        assert.deepStrictEqual(r.errors, []);
        assert.deepStrictEqual(r.cfg.switchAdapters, ['matter.0']);
        assert.deepStrictEqual(r.cfg.lampAdapters, ['govee-smart.0']);
        assert.strictEqual(r.cfg.switchMode, 'state');
        assert.strictEqual(r.cfg.lampFeedback, true);
    });
    await test('Konfiguration: Fehler und ungültige Zeilen', () => {
        assert.strictEqual(normalizeConfig({ switchAdapters: 'matter', lampAdapters: 'matter.0,x.1', lockMs: -1 }, silent).errors.length, 2);
        assert.strictEqual(normalizeConfig({ switchAdapters: 'a.0', lampAdapters: 'a.0' }, silent).errors.length, 1);
        const warn = [];
        const r = normalizeConfig({ devices: [
            { group: 'a', device: 'X' }, { group: 'a', device: ' x ' }, { group: 'a b', device: 'Y' },
            { group: 'info', device: 'Y' }, { group: 'a', device: '' }, { group: '', device: '' }, null,
        ] }, { ...silent, warn: (m) => warn.push(m) });
        assert.strictEqual(r.cfg.rows.length, 1);
        assert.strictEqual(warn.length, 4);
    });
    await test('Erkennung: Klartext, Doppelschalter mit Kanal, info und Nicht-Schalter ausgeschlossen', () => {
        const m = discover('matter.0', MATTER);
        assert.deepStrictEqual(m.map((e) => e.label), ['Bad Taster', 'Flur Doppelschalter – Kanal 1', 'Flur Doppelschalter – Kanal 2', 'Küche Schalter', 'Schlafzimmer Schalter', 'Wohnzimmer Schalter']);
        assert.strictEqual(m.find((e) => e.label === 'Wohnzimmer Schalter').id, SW_WZ);
        assert.strictEqual(m.find((e) => e.label === 'Küche Schalter').id, 'matter.0.controller.333.1.onOff');
        const g = discover('govee-smart.0', GOVEE);
        assert.deepStrictEqual(g.map((e) => e.label), ['H1250_0f3e', 'H60A4_1a2b', 'H60A4_77c0']);
        assert.deepStrictEqual(g.map((e) => e.id).sort(), [L_K, L_WZ, L_F].sort());
    });
    await test('Erkennung: gleiche Namen in zwei Instanzen werden eindeutig', () => {
        const { cfg } = normalizeConfig({}, silent);
        const e = catalog(cfg, { 'matter.0': { 'matter.0.a': dev('Decke'), 'matter.0.a.on': st('on', 'switch') }, 'govee-smart.0': { 'govee-smart.0.b': dev('Decke'), 'govee-smart.0.b.on': st('on', 'switch') } });
        assert.deepStrictEqual(e.map((x) => x.label), ['Decke (matter.0)', 'Decke (govee-smart.0)']);
    });
    await test('Zuordnung und Modell: Namen Schalter1/Lampe1, fehlende Geräte', () => {
        const { devices, missing } = setup({ devices: [...ROWS, { group: 'Bad', device: 'Gibt es nicht' }] });
        assert.deepStrictEqual(missing, [{ group: 'Bad', device: 'Gibt es nicht' }]);
        assert.deepStrictEqual(devices.filter((d) => d.group === 'Kueche').map((d) => d.name), ['Schalter1', 'Schalter2', 'Lampe1']);
        const m = buildModel(devices);
        assert.ok(m.states.find((s) => s.id === 'Flur.on').common.write);
        assert.strictEqual(m.channels.find((c) => c.id === 'Flur.Lampe1').name, 'Flur Decke');
        assert.strictEqual(m.states.find((s) => s.id === 'Kueche.info.Count').common.def, 3);
    });
    await test('Geräte einlesen ergänzt nur neue Zeilen', () => {
        const { entries } = setup();
        const r = mergeDevices([{ group: 'Wohnzimmer', device: 'wohnzimmer schalter' }], entries);
        assert.strictEqual(r.added.length, entries.length - 1);
        assert.ok(r.rows.every((x, i) => i === 0 || x.group === ''));
    });
    await test('Schalter an -> Lampen der Gruppe an, Echo löst nichts aus', async () => {
        const { core, sets, w } = setup();
        await core.init(SW_WZ, ack(false)); await core.init(L_WZ, ack(false)); await core.afterInit();
        assert.strictEqual(await core.handle(SW_WZ, ack(true)), 'switched');
        assert.deepStrictEqual(sets, [[L_WZ, true]]);
        assert.strictEqual(w['Wohnzimmer.on'], true);
        assert.strictEqual(await core.handle(L_WZ, ack(true)), 'echo');
        assert.strictEqual(w['Wohnzimmer.info.LampsOn'], 1);
        assert.strictEqual(await core.handle(SW_WZ, { val: true, ack: false }), 'command');
        assert.strictEqual(sets.length, 1);
    });
    await test('Mehrere Schalter: andere Schalter werden nachgeführt', async () => {
        const { core, sets } = setup();
        for (const id of [SW_F2, L_K, 'matter.0.controller.333.1.onOff']) await core.init(id, ack(false));
        await core.afterInit();
        await core.handle('matter.0.controller.333.1.onOff', ack(true));
        assert.deepStrictEqual(sets, [[L_K, true], [SW_F2, true]]);
        assert.strictEqual(await core.handle(SW_F2, ack(true)), 'echo');
        await core.handle(SW_F2, ack(false));
        assert.deepStrictEqual(sets.slice(2), [[L_K, false], ['matter.0.controller.333.1.onOff', false]]);
    });
    await test('Rückmeldung: Lampe per App aus -> Schalter folgt, Sperrzeit wirkt', async () => {
        const { core, sets, t, w } = setup();
        await core.init(SW_WZ, ack(true)); await core.init(L_WZ, ack(true)); await core.afterInit();
        assert.strictEqual(w['Wohnzimmer.on'], true);
        assert.strictEqual(await core.handle(L_WZ, ack(false)), 'feedback');
        assert.deepStrictEqual(sets, [[SW_WZ, false]]);
        assert.strictEqual(w['Wohnzimmer.on'], false);
        // Innerhalb der Sperrzeit nach eigenem Befehl keine Rückmeldung
        await core.writeBack('Wohnzimmer.on', { val: true, ack: false });
        assert.deepStrictEqual(sets.slice(1), [[L_WZ, true], [SW_WZ, true]]);
        t.now += 1000;
        assert.strictEqual(await core.handle(L_WZ, ack(false)), 'lamp');
        t.now += 5000;
        assert.strictEqual(await core.handle(L_WZ, ack(false)), 'feedback');
    });
    await test('Rückmeldung abschaltbar', async () => {
        const { core, sets } = setup({ lampFeedback: false });
        await core.init(SW_WZ, ack(true)); await core.init(L_WZ, ack(true)); await core.afterInit();
        assert.strictEqual(await core.handle(L_WZ, ack(false)), 'lamp');
        assert.deepStrictEqual(sets, []);
    });
    await test('Taster-Modus: jede Änderung schaltet um, Schalter werden nicht nachgeführt', async () => {
        const { core, sets } = setup({ switchMode: 'toggle' });
        await core.init(SW_F1, ack(false)); await core.init(L_F, ack(false)); await core.afterInit();
        await core.handle(SW_F1, ack(true));
        assert.deepStrictEqual(sets, [[L_F, true]]);
        await core.handle(L_F, ack(true));
        await core.handle(SW_F1, ack(false));
        assert.deepStrictEqual(sets.slice(1), [[L_F, false]]);
        assert.strictEqual(await core.handle(SW_F1, ack(false)), 'unchanged');
    });
    await test('Einzelgerät schreiben und ungültige Werte', async () => {
        const { core, sets } = setup();
        assert.strictEqual(await core.writeBack('Flur.Lampe1.on', { val: 'on', ack: false }), 'device');
        assert.deepStrictEqual(sets, [[L_F, true]]);
        assert.strictEqual(await core.writeBack('Flur.on', { val: 'abc', ack: false }), 'invalid');
        assert.strictEqual(await core.handle(L_F, ack('xyz')), 'invalid');
        assert.strictEqual(await core.handle('foo.0.bar', ack(true)), 'ignored');
    });
    await test('Abgelaufenes Echo wird als echte Meldung behandelt', async () => {
        const { core, sets, t } = setup();
        await core.init(SW_WZ, ack(false)); await core.init(L_WZ, ack(false)); await core.afterInit();
        await core.writeBack('Wohnzimmer.Schalter1.on', { val: true, ack: false });
        t.now += 60000;
        assert.strictEqual(await core.handle(SW_WZ, ack(true)), 'switched');
        assert.deepStrictEqual(sets, [[SW_WZ, true], [L_WZ, true]]);
    });
    await test('Start: Schalter optional an Lampen angleichen', async () => {
        const { core, sets } = setup({ syncOnStart: true });
        await core.init(SW_WZ, ack(false)); await core.init(L_WZ, ack(true)); await core.afterInit();
        assert.deepStrictEqual(sets, [[SW_WZ, true]]);
    });
    await test('Gerätenamen: LAN-Namen werden durch Klartext ersetzt, Quelle bleibt erhalten', () => {
        const { entries } = setup();
        const wz = entries.find((e) => e.id === L_WZ);
        assert.strictEqual(wz.label, 'Wohnzimmer Decke');
        assert.strictEqual(wz.sourceLabel, 'H60A4_1a2b');
        assert.strictEqual(entries.find((e) => e.id === L_F).label, 'Flur Decke');
        const raw = setup({ names: [] }).entries;
        assert.ok(raw.some((e) => e.label === 'H60A4_1a2b'));
        assert.strictEqual(resolveRows([{ group: 'X', device: 'H60A4_1a2b' }], raw).devices[0].id, L_WZ);
    });
    await test('Gerätenamen: ungültige und doppelte Einträge', () => {
        const warn = [];
        const r = normalizeConfig({ names: [
            { source: L_WZ, name: 'A' }, { source: L_WZ.toUpperCase(), name: 'B' }, { source: L_F, name: 'a' },
            { source: '', name: 'C' }, { source: L_K, name: '' }, {}, null,
        ] }, { ...silent, warn: (m) => warn.push(m) });
        assert.deepStrictEqual(r.cfg.names, [{ source: L_WZ, name: 'A' }]);
        assert.strictEqual(warn.length, 4);
    });
    await test('Gerätenamen: Klartext gleich einem anderen Gerätenamen wird eindeutig gemacht', () => {
        const { entries } = setup({ names: [{ source: L_WZ, name: 'Wohnzimmer Schalter' }] });
        assert.ok(entries.some((e) => e.label === 'Wohnzimmer Schalter (H60A4_1a2b)'));
    });
    await test('Erkennung: Taster (PRESS/PRESS_LONG), Zusammenfassen mit Relais, Helligkeit der Lampen', () => {
        const m = discover('matter.0', MATTER);
        const bad = m.find((e) => e.label === 'Bad Taster');
        assert.strictEqual(bad.onId, null);
        assert.strictEqual(bad.pressId, 'matter.0.controller.444.1.PRESS');
        assert.strictEqual(bad.longId, 'matter.0.controller.444.1.PRESS_LONG');
        const sz = m.find((e) => e.label === 'Schlafzimmer Schalter');
        assert.strictEqual(sz.onId, 'matter.0.controller.555.1.power');
        assert.strictEqual(sz.longId, 'matter.0.controller.555.2.PRESS_LONG');
        assert.strictEqual(m.find((e) => e.label === 'Küche Schalter').pressId, null); // Rolle "button" (identify) ist kein Taster
        const g = discover('govee-smart.0', GOVEE, 'lamp');
        assert.strictEqual(g.find((e) => e.id === L_WZ).levelId, 'govee-smart.0.devices.h60a4-1a2b.control.brightness');
        const { devices } = setup({ devices: [{ group: 'Bad', device: 'Bad Taster' }, { group: 'Bad', device: 'Wohnzimmer Decke' }] });
        assert.deepStrictEqual(devices.map((d) => d.name), ['Taster1', 'Lampe1']);
        const ids = buildModel(devices).states.map((x) => x.id);
        assert.ok(ids.includes('Bad.brightness') && ids.includes('Bad.Lampe1.brightness') && ids.includes('Bad.Taster1.pressLong'));
        assert.ok(!ids.includes('Bad.Taster1.on'));
    });

    const BAD = [{ group: 'Bad', device: 'Bad Taster' }, { group: 'Bad', device: 'Wohnzimmer Decke' }, { group: 'Bad', device: 'Flur Decke' }];
    const PRESS = 'matter.0.controller.444.1.PRESS';
    const LONG = 'matter.0.controller.444.1.PRESS_LONG';
    const LVL_WZ = 'govee-smart.0.devices.h60a4-1a2b.control.brightness';
    const LVL_F = 'govee-smart.0.devices.h60a4-77c0.control.brightness';
    const badSetup = async (over = {}, lampsOn = false, level = 60) => {
        const x = setup({ devices: BAD, ...over });
        for (const id of [L_WZ, L_F]) await x.core.init(id, ack(lampsOn));
        for (const id of [LVL_WZ, LVL_F]) await x.core.init(id, ack(level));
        await x.core.afterInit();
        return x;
    };

    await test('Taster kurz: schaltet nach der Wartezeit um', async () => {
        const { core, sets, tick, w } = await badSetup();
        assert.strictEqual(await core.handle(PRESS, ack(true)), 'press-wait');
        assert.deepStrictEqual(sets, []);
        await tick(800);
        assert.deepStrictEqual(sets, [[L_WZ, true], [L_F, true]]);
        assert.strictEqual(w['Bad.on'], true);
        await core.handle(L_WZ, ack(true)); await core.handle(L_F, ack(true));
        await core.handle(PRESS, ack(true)); await tick(800);
        assert.deepStrictEqual(sets.slice(2), [[L_WZ, false], [L_F, false]]);
    });
    await test('Taster lang bei ausgeschalteter Gruppe: 1 % einschalten, hochdimmen, Loslassen hält den Wert', async () => {
        const { core, sets, tick, w } = await badSetup();
        await core.handle(PRESS, ack(true));
        assert.strictEqual(await core.handle(LONG, ack(true)), 'dim-start');
        await tick(2000); // Wartezeit für kurz verstrichen: darf NICHT umschalten
        // erst Helligkeit 1 %, dann einschalten
        assert.deepStrictEqual(sets.slice(0, 4), [[LVL_WZ, 1], [LVL_F, 1], [L_WZ, true], [L_F, true]]);
        const levels = sets.filter(([id]) => id === LVL_WZ).map(([, v]) => v);
        assert.ok(levels.length > 3 && levels.every((v, i) => i === 0 || v > levels[i - 1]), `steigend: ${levels}`);
        assert.ok(!sets.some(([id, v]) => id === L_WZ && v === false), 'kein Ausschalten durch den kurzen Druck');
        assert.strictEqual(await core.handle(LONG, ack(false)), 'dim-stop');
        const reached = w['Bad.brightness'];
        assert.ok(reached > 1 && reached < 100, `erreicht: ${reached}`);
        const n = sets.length;
        await tick(5000);
        assert.strictEqual(sets.length, n, 'nach dem Loslassen keine weiteren Befehle');
        assert.strictEqual(w['Bad.Taster1.pressLong'], false);
    });
    await test('Taster lang bei eingeschalteter Gruppe: ab aktueller Helligkeit heller, endet bei 100 %', async () => {
        const { core, sets, tick, w } = await badSetup({}, true, 60);
        await core.handle(LONG, ack(true));
        assert.ok(!sets.some(([id]) => id === L_WZ), 'kein erneutes Einschalten');
        await tick(20000);
        const levels = sets.filter(([id]) => id === LVL_WZ).map(([, v]) => v);
        assert.ok(levels[0] > 60);
        assert.strictEqual(levels[levels.length - 1], 100);
        assert.strictEqual(w['Bad.brightness'], 100);
        assert.strictEqual(core.groups.Bad.dim, null);
    });
    await test('Dimmdauer: 1 % -> 100 % in ca. der eingestellten Zeit', async () => {
        const { core, sets, tick } = await badSetup({ dimTimeMs: 3000, dimStepMs: 300 });
        await core.handle(LONG, ack(true));
        await tick(2900);
        assert.ok(sets.filter(([id]) => id === LVL_WZ).pop()[1] < 100);
        await tick(400);
        assert.strictEqual(sets.filter(([id]) => id === LVL_WZ).pop()[1], 100);
    });
    await test('Sicherung: fehlendes Loslassen beendet das Dimmen', async () => {
        const { core, tick } = await badSetup({ dimTimeMs: 60000, dimStepMs: 1000 });
        await core.handle(LONG, ack(true));
        await tick(126000);
        assert.strictEqual(core.groups.Bad.dim, null);
    });
    await test('Gruppenhelligkeit schreiben: setzt alle Lampen, 0 schaltet aus, schaltet ein, wenn aus', async () => {
        const { core, sets } = await badSetup();
        assert.strictEqual(await core.writeBack('Bad.brightness', { val: 40, ack: false }), 'group-level');
        assert.deepStrictEqual(sets, [[LVL_WZ, 40], [LVL_F, 40], [L_WZ, true], [L_F, true]]);
        assert.strictEqual(await core.writeBack('Bad.brightness', { val: 0, ack: false }), 'group-off');
        assert.strictEqual(await core.writeBack('Bad.Lampe2.brightness', { val: '250', ack: false }), 'device-level');
        assert.deepStrictEqual(sets.pop(), [LVL_F, 100]);
        assert.strictEqual(await core.writeBack('Bad.brightness', { val: 'x', ack: false }), 'invalid');
    });
    await test('Schalter mit Taster-Endpunkt: Relais-Zustand wird nur gespiegelt, Taster entscheidet', async () => {
        const x = setup({ devices: [{ group: 'SZ', device: 'Schlafzimmer Schalter' }, { group: 'SZ', device: 'Küche Decke' }] });
        await x.core.init('matter.0.controller.555.1.power', ack(false)); await x.core.init(L_K, ack(false)); await x.core.afterInit();
        assert.strictEqual(await x.core.handle('matter.0.controller.555.1.power', ack(true)), 'mirror');
        assert.deepStrictEqual(x.sets, []);
        await x.core.handle('matter.0.controller.555.2.PRESS', ack(true)); await x.tick(800);
        assert.deepStrictEqual(x.sets, [[L_K, true]]);
    });
    await test('Lang-Druck ohne dimmbare Lampe wird ignoriert', async () => {
        const x = setup({ devices: [{ group: 'B', device: 'Bad Taster' }] });
        await x.core.afterInit();
        assert.strictEqual(await x.core.handle(LONG, ack(true)), 'no-dimmable');
    });
    await test('Instanzen: Liste aus der Auswahl oder kommagetrennter Text, leer erlaubt, Fehler bei ungültigem Namen', () => {
        const a = normalizeConfig({ switchAdapters: ['matter.0', 'matter.1'], lampAdapters: ['govee-smart.0'] }, silent);
        assert.deepStrictEqual(a.errors, []);
        assert.deepStrictEqual(a.cfg.switchAdapters, ['matter.0', 'matter.1']);
        const b = normalizeConfig({ switchAdapters: 'matter.0, matter.1', lampAdapters: '' }, silent);
        assert.deepStrictEqual(b.errors, []);
        assert.deepStrictEqual(b.cfg.switchAdapters, ['matter.0', 'matter.1']);
        assert.deepStrictEqual(b.cfg.lampAdapters, []);
        assert.strictEqual(normalizeConfig({ switchAdapters: ['matter'] }, silent).errors.length, 1);
        assert.strictEqual(normalizeConfig({ switchAdapters: ['a.0'], lampAdapters: ['a.0'] }, silent).errors.length, 1);
    });
    await test('Räume: Erkennung im Gerätenamen und Gruppen-ID', () => {
        const cases = { 'Flur Decke': 'Flur', 'Badezimmerlicht': 'Badezimmer', 'Bad Taster': 'Badezimmer', 'Küche Schalter': 'Kueche', Esszimmer: 'Esszimmer',
            'Flurlicht': 'Flur', 'Treppenhaus oben': 'Treppe', 'Gäste-WC Spiegel': 'WC', 'H60A4_1a2b': '', Kindergarten: '', 'Sonoff M5': '' };
        for (const [name, room] of Object.entries(cases)) assert.strictEqual(roomFromName(name), room, name);
        assert.strictEqual(groupId('Küche & Esszimmer'), 'Kueche_Esszimmer');
        assert.strictEqual(groupId('Info'), '');
        assert.strictEqual(groupId('Wohn Zimmer'), 'Wohn_Zimmer');
    });
    await test('Räume: ioBroker-Räume haben Vorrang vor dem Namen, Mitglied darf auch Gerät oder Kanal sein', () => {
        const { entries } = setup();
        assignRooms(entries, [
            { name: { de: 'Arbeitszimmer', en: 'Office' }.de, members: ['matter.0.controller.111'] },       // Gerät des Wohnzimmer-Schalters
            { name: 'Gäste Bad', members: [L_K] },                                                                  // Datenpunkt der Küchen-Lampe
        ]);
        const by = (label) => entries.find((e) => e.label === label);
        assert.deepStrictEqual([by('Wohnzimmer Schalter').room, by('Wohnzimmer Schalter').roomSource], ['Arbeitszimmer', 'enum']);
        assert.deepStrictEqual([by('Küche Decke').room, by('Küche Decke').roomSource], ['Gaeste_Bad', 'enum']);
        assert.deepStrictEqual([by('Flur Decke').room, by('Flur Decke').roomSource], ['Flur', 'name']);
        assert.deepStrictEqual([by('Bad Taster').room, by('Bad Taster').roomSource], ['Badezimmer', 'name']);
        assert.strictEqual(by('Flur Doppelschalter – Kanal 2').room, 'Flur');
    });
    await test('Einlesen: Gruppen vorbelegt, vorhandene Gruppen bleiben, leere Zeilen werden gefüllt', () => {
        const { entries } = setup();
        assignRooms(entries, []);
        const r = mergeDevices([{ group: 'Meine', device: 'Küche Schalter' }, { group: '', device: 'Flur Decke' }], entries);
        const g = (d) => r.rows.find((x) => x.device === d).group;
        assert.strictEqual(g('Küche Schalter'), 'Meine');
        assert.strictEqual(g('Flur Decke'), 'Flur');
        assert.strictEqual(g('Bad Taster'), 'Badezimmer');
        assert.strictEqual(g('Wohnzimmer Decke'), 'Wohnzimmer');
        assert.ok(r.rooms.includes('Flur') && r.rooms.includes('Badezimmer') && !r.rooms.includes(''));
        assert.ok(r.open === r.rows.filter((x) => !x.group).length);
        assert.ok(r.filled.includes('Flur Decke') && !r.filled.includes('Küche Schalter'));
    });
    await test('Export / Import', () => {
        const ex = exportConfig({ devices: ROWS, names: NAMES, switchMode: 'toggle', lampAdapters: 'govee.0' });
        const imp = importConfig(ex.native.configJson);
        assert.strictEqual(imp.native.devices.length, ROWS.length);
        assert.deepStrictEqual(imp.native.names, NAMES);
        assert.ok(importConfig('{"names": {}}').error);
        assert.strictEqual(imp.native.switchMode, 'toggle');
        assert.deepStrictEqual(imp.native.lampAdapters, ['govee.0']);
        assert.ok(importConfig('{"adapter":"ecoflow-gruppen"}').error);
        assert.ok(importConfig('nope').error);
        assert.ok(importConfig('').error);
        assert.ok(importConfig('{"devices": 3}').error);
    });
    console.log(`\n${passed} Tests bestanden`);
})().catch((e) => { console.error(e); process.exit(1); });
