'use strict';
/**
 * Particulate filter - the DPF Monitor (apps/dpf) in the look of BMW's own iDrive 7 screens.
 *
 * The HMI draws the title and the button bar itself (setting "Screen layout" = iDrive, the default);
 * the app draws only the page between them, in BMW's style: black, thin lines, light type, the
 * slanted silver bars with the accent needle, and a drawing of the filter on the right.
 *
 * Pages (the HMI's buttons Overview / Live data / History; tabs in the full-screen layout):
 *   Overview    soot load and exhaust temperature as bars, the filter drawing with soot, ash, heat and
 *               the pressure difference, the status (filter OK / regeneration due / running) under it
 *   Live data   soot, pressure difference and both exhaust temperatures with their last 5 minutes,
 *               every other value as a list (with "show raw replies": every identifier and its reply)
 *   History     regenerations this app has watched, and the intervals from the engine unit's memory
 *
 * Reading and the regeneration logic are those of apps/dpf (read-only, UDS 0x22, app.json config.dpf).
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { ReadOnlyDiag } = require('./kit/readonly-diag');
const { DidReader } = require('./kit/dids');
const { DemoDpf } = require('./demo');
const ID7 = require('./id7');
const { drawDpf } = require('./illustration');

const W = 1600, H = 520;
const PAGES = ['Overview', 'Live data', 'History'];
const BUTTONS = ['BTN_OVERVIEW', 'BTN_LIVE', 'BTN_HISTORY'];
const FAST = ['soot', 'regenReq', 'dp', 'tDpf', 'tOxi'];                 // every round
const SLOW = ['sootSim', 'ash', 'distSince', 'avgInterval', 'fuelSince', 'interrupted', 'lock', 'flowRes', 'timeSince'];   // every 5th round
const ALL = FAST.concat(SLOW);
const NAMES = {
    soot: 'Soot mass (measured)', sootSim: 'Soot mass (calculated)', ash: 'Oil ash mass', distSince: 'Distance since regeneration',
    avgInterval: 'Average regeneration interval', fuelSince: 'Fuel since regeneration', regenReq: 'Regeneration request',
    interrupted: 'Regeneration interruption status', lock: 'Regeneration lock status', dp: 'Pressure difference',
    tDpf: 'Exhaust temperature before DPF', tOxi: 'Exhaust temperature before oxi cat', flowRes: 'Flow resistance (filtered)', timeSince: 'Engine time since regeneration',
};
const UNITS = { soot: 'g', sootSim: 'g', ash: 'g', distSince: 'km', avgInterval: 'km', fuelSince: 'l', dp: 'mbar', tDpf: '°C', tOxi: '°C', flowRes: 'hPa/(m3/h)', timeSince: 's' };
const DEFAULT_THRESHOLD = 24;      // g, until the app has watched a regeneration start (setting "Regeneration starts at")
const TRACE_S = 2, TRACE_N = 900;  // a trace point every 2 s, 30 min
const SPARK_N = 150;               // the history lines: the last 5 min

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const cfg = Object.assign({ ecu: 18, history: [] }, (ctx.spec.config && ctx.spec.config.dpf) || {});
        const mono = () => { const h = process.hrtime(); return h[0] * 1000 + h[1] / 1e6; };   // steady clock (the wall clock jumps at start-up)
        const t0 = mono();

        /* ---------- what the app remembers (data/dpf.json) ---------- */
        const FILE = path.join(ctx.dataDir, 'dpf.json');
        let store = { log: [], learned: [] };
        try { store = Object.assign(store, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* first start */ }
        const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(store)); } catch (e) { log.warn('saving ' + FILE + ': ' + e); } };

        /* ---------- reading the engine unit ---------- */
        const link = new ReadOnlyDiag(ctx.signals, log);
        link.init();                                   // in the background: the screen must not wait for it
        const rd = new DidReader(link, { ecu: cfg.ecu });
        const live = {}, at = {}, fail = {}, tryAt = {}, logged = {};
        let histOdo = [], histAt = 0, lastReal = 0;

        /** The reply bytes of a value go to the log the first time it answers and the first time it doesn't. */
        function logRaw(k, c, ok) {
            const key = k + (ok ? ':ok' : ':fail');
            if (logged[key] || !c) return;
            logged[key] = true;
            const r = rd.raws[rd.key(c)];
            log.info('DDE ' + k + ' 22 ' + DidReader.label(c) + ': ' + (r ? r.bytes || r.why : '?') + (ok ? ' -> ' + live[k] : ''));
        }

        async function readKey(k) {
            const list = cfg[k] || [];
            if (!list.length) return;
            // a value the engine unit refused three times in a row is only asked again once a minute
            if ((fail[k] || 0) >= 3 && mono() - (tryAt[k] || 0) < 60000) return;
            tryAt[k] = mono();
            const v = await rd.value(k, list), c = list[rd.pick[k] || 0];
            if (v === null) { fail[k] = (fail[k] || 0) + 1; logRaw(k, c, false); return; }
            fail[k] = 0; live[k] = v; at[k] = mono(); lastReal = mono();
            logRaw(k, c, true);
        }

        /** The engine unit's odometer readings at its last five regenerations (km, newest first). */
        async function readHistory() {
            const out = [];
            for (const did of cfg.history || []) {
                const v = await rd.value('hist' + did, [{ did, bytes: 4, factor: 0.001, min: 1, max: 2000000 }]);
                if (v !== null) out.push(v);
            }
            histAt = mono();
            if (out.length) histOdo = out;
        }

        let round = 0, pollTimer = null, wantHistory = true, wantSlow = false;
        async function poll() {
            round++;
            try {
                if (settings.get('demo') !== 'on' && link.ready && link.available) {
                    const keys = round % 5 === 1 || wantSlow ? ALL : FAST;
                    wantSlow = false;
                    for (const k of keys) await readKey(k);
                    if (wantHistory || mono() - histAt > 300000) { wantHistory = false; await readHistory(); }
                }
            } catch (e) { log.warn('engine unit poll: ' + e); }
            pollTimer = setTimeout(poll, Math.max(1, settings.get('rate') || 2) * 1000);
        }
        pollTimer = setTimeout(poll, 1500);

        /* ---------- demo (PC preview, emulator, bench unit) ---------- */
        let demo = null, demoVals = null;
        function demoOn() {
            const m = settings.get('demo');
            if (m === 'on') return true;
            if (m === 'off') return false;
            // auto: after 8 s at start without one real reply, or 20 s without one later on
            return lastReal ? mono() - lastReal > 20000 : mono() - t0 > 8000;
        }

        /** One snapshot of every value in real units (null = no recent reading). */
        function data() {
            if (demoOn()) {
                if (!demo) demo = new DemoDpf(threshold());
                if (!demoVals) demoVals = demo.sample();
                return Object.assign({ demo: true }, demoVals);
            }
            demo = null; demoVals = null;
            const out = { demo: false, history: histOdo };
            const fastMax = Math.max(15000, (settings.get('rate') || 2) * 5000);
            ALL.forEach((k) => { out[k] = at[k] && mono() - at[k] < (FAST.indexOf(k) >= 0 ? fastMax : 120000) ? live[k] : null; });
            return out;
        }

        /** Soot mass (g) at which the engine unit starts a regeneration: the setting, else learned, else a typical value. */
        function threshold() {
            const s = settings.get('sootMax');
            if (s > 0) return s;
            const L = (store.learned || []).filter(G.isNum);
            return L.length ? L.reduce((a, b) => a + b, 0) / L.length : DEFAULT_THRESHOLD;
        }
        const thresholdSource = () => (settings.get('sootMax') > 0 ? 'set' : (store.learned || []).length ? 'learned' : 'typical');

        /* ---------- regenerations, trace (once a second) ---------- */
        let regen = null, snap = data(), lastDist = null, lastTrace = 0;
        const running = () => !!regen && !regen.endedAt;
        const trace = [];                               // [mono, soot, tDpf, tOxi, dp, demo]
        function finish(r, d, how) {
            const entry = {
                date: r.date, sootStart: r.sootStart, sootEnd: d.soot, durS: Math.round(((r.endedAt || mono()) - r.t0) / 1000),
                peakT: r.peakT || null, result: how,
            };
            log.info('regeneration ' + how + ': ' + JSON.stringify(entry));
            if (r.demo) return;
            store.log.unshift(entry);
            store.log.length = Math.min(store.log.length, 30);
            if (how === 'completed' && G.isNum(r.sootStart) && r.sootStart > 5) {
                store.learned.unshift(r.sootStart);
                store.learned.length = Math.min(store.learned.length, 5);
            }
            save();
            wantHistory = true;
        }
        function tick() {
            if (demo) demoVals = demo.sample();
            const d = snap = data();
            const active = G.isNum(d.regenReq) && d.regenReq > 0;
            if (regen && regen.demo !== d.demo) regen = null;           // switched between demo and the car
            if (active && !regen) {
                regen = { t0: mono(), date: Date.now(), sootStart: d.soot, peakT: d.tDpf, demo: d.demo };
                log.info('regeneration started at ' + G.fmt(d.soot, 1) + ' g soot (request ' + d.regenReq + ')');
            } else if (regen && active) {
                delete regen.endedAt;                                   // (the request came back: the same one goes on)
                if (G.isNum(d.tDpf)) regen.peakT = Math.max(regen.peakT || 0, d.tDpf);
                if (!G.isNum(regen.sootStart) && G.isNum(d.soot)) regen.sootStart = d.soot;
            } else if (regen && !regen.endedAt && G.isNum(d.regenReq)) {
                // ended: completed or interrupted is decided on a distance read after the end (it is a slow value)
                regen.endedAt = mono();
                wantSlow = true;
            }
            if (regen && regen.endedAt) {
                const fresh = d.demo || (at.distSince && at.distSince > regen.endedAt);
                if (fresh || mono() - regen.endedAt > 30000) {
                    const reset = G.isNum(d.distSince) && d.distSince < 2;
                    const burnt = G.isNum(d.soot) && G.isNum(regen.sootStart) && d.soot < regen.sootStart * 0.4;
                    finish(regen, d, reset || burnt ? 'completed' : 'interrupted');
                    if (G.isNum(d.distSince)) lastDist = d.distSince;  // (not "a regeneration the app didn't see")
                    regen = null;
                }
            }
            // a regeneration the app didn't see (it ran while the app was closed or the head unit slept)
            if (!d.demo && G.isNum(d.distSince)) {
                const before = G.isNum(lastDist) ? lastDist : store.lastDist;
                if (!regen && G.isNum(before) && before > 10 && d.distSince < before - 5 && d.distSince < 5) {
                    store.log.unshift({ date: Date.now(), result: 'not watched', kmBefore: Math.round(before) });
                    store.log.length = Math.min(store.log.length, 30);
                    wantHistory = true;
                }
                lastDist = d.distSince;
                if (store.lastDist !== Math.round(d.distSince)) { store.lastDist = Math.round(d.distSince); if (Math.round(d.distSince) % 5 === 0) save(); }
            }
            if (mono() - lastTrace >= TRACE_S * 1000) {
                lastTrace = mono();
                trace.push([lastTrace, d.soot, d.tDpf, d.tOxi, d.dp, d.demo]);
                while (trace.length > TRACE_N) trace.shift();
            }
        }
        setInterval(tick, 1000);

        /* ---------- units and words ---------- */
        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');
        const pad2 = (n) => (n < 10 ? '0' : '') + n;
        const dur = (s) => (G.isNum(s) ? Math.floor(s / 60) + ':' + pad2(Math.floor(s % 60)) : '--');
        const date = (ms) => { const d = new Date(ms); return d.getFullYear() < 2020 ? '--' : pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() + '  ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
        const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
        const num = (v, d, unit) => (G.isNum(v) ? v.toFixed(d || 0) + (unit ? ' ' + unit : '') : '--');

        /** Why a value is missing: plain words (the reply codes are on Live data with raw replies, and in the log). */
        function why(k) {
            if (snap.demo) return '';
            if (!link.ready) return link.error ? 'No diagnostic link' : 'Connecting...';
            if (!link.available) return 'Diagnostic link down';
            const r = (cfg[k] || []).map((c) => rd.raws[rd.key(c)]).filter(Boolean);
            if (!r.length) return 'Reading...';
            if (r.every((x) => /NRC (31|11|12)/.test(x.why))) return 'Not available on this vehicle';
            if (r.every((x) => x.why === 'no reply')) return 'No reply - is the ignition on?';
            return 'No reading from the engine unit';
        }

        /** km until the soot reaches the threshold, from the soot built up since the last regeneration. */
        function kmLeft(d, thr) {
            if (!G.isNum(d.soot) || !G.isNum(d.distSince) || d.distSince < 10 || d.soot < 0.5) return null;
            return Math.max(0, (thr - d.soot) / (d.soot / d.distSince));
        }
        /** The last 5 minutes of trace column idx (this source: demo or car). */
        const recent = (idx, conv) => trace.slice(-SPARK_N).filter((p) => p[5] === snap.demo).map((p) => (conv ? conv(p[idx]) : p[idx]));

        /* ---------- pages ---------- */
        function drawOverview(cv, P, d) {
            const thr = threshold(), max = Math.max(10, Math.ceil(thr * 1.25 / 5) * 5);
            // soot load: the item in focus, framed as BMW's first gauge
            ID7.card(cv, P, 40, 46, 750, 196);
            cv.text('Soot load', 64, 84, 24, P.text2);
            cv.text(G.isNum(d.soot) ? 'Regeneration at approx. ' + G.fmt(thr, 0) + ' g (' + thresholdSource() + ')' : why('soot'), 766, 84, 20, P.dim, { align: 'right' });
            ID7.value(cv, P, 64, 136, d.soot, 'g', 46, { decimals: 1 });
            ID7.slantBar(cv, P, 64, 154, 702, 26, { value: d.soot, min: 0, max, mark: thr, zoneFrom: thr });

            // exhaust temperature before the filter
            const tMax = F() ? 1500 : 800;
            cv.text('Exhaust temperature before DPF', 64, 290, 24, P.text2);
            cv.text('Regeneration from approx. ' + Math.round(T(550)) + ' ' + tU(), 766, 290, 20, P.dim, { align: 'right' });
            ID7.value(cv, P, 64, 342, T(d.tDpf), tU(), 46);
            ID7.slantBar(cv, P, 64, 360, 702, 26, { value: T(d.tDpf), min: 0, max: tMax, zoneFrom: T(550), ticks: 4 });

            // a line under it, like BMW's "Recommended rev limit" (km and fuel since, the usual interval)
            let x = 64;
            const seg = (label, val) => { x += cv.text(label, x, 488, 22, P.dim) + 8; x += cv.text(val, x, 488, 22, P.text2) + 34; };
            seg('Since regeneration', num(d.distSince, 0, 'km'));
            seg('Fuel', num(d.fuelSince, 1, 'l'));
            seg('Average', num(d.avgInterval, 0, 'km'));

            // the filter drawing, its status under it
            drawDpf(cv, P, 830, 40, { soot: d.soot, sootMax: thr, ash: d.ash, tDpf: d.tDpf, dp: d.dp, regen: running(), T, tUnit: tU() });
            cv.fillRect(830, 404, 730, 1, '#3a3a3a');
            let title, sub, dot = null;
            if (running()) {
                title = 'Regeneration running'; dot = P.heat;
                sub = 'For ' + dur((mono() - regen.t0) / 1000) + ' min  -  please keep the engine running';
            } else if (!G.isNum(d.soot)) { title = 'No data'; sub = why('soot'); }
            else if (d.soot >= thr * 0.9) { title = 'Regeneration due'; dot = P.warn; sub = 'A longer drive at a steady speed helps the filter to clean itself'; }
            else {
                const left = kmLeft(d, thr);
                title = 'Particulate filter OK';
                sub = left === null ? 'Soot ' + num(d.soot, 1, 'g') + ' of approx. ' + G.fmt(thr, 0) + ' g' : 'Next regeneration in approximately ' + thousands(Math.round(left / 10) * 10) + ' km';
            }
            let tx = 846;
            if (dot) { cv.circle(856, 440, 8 + (running() ? 2 * Math.sin(Date.now() / 300) : 0), withAlpha(dot, 0.3)); cv.circle(856, 440, 6, dot); tx = 876; }
            cv.text(title, tx, 450, 28, P.text);
            cv.text(sub, 846, 488, 21, P.dim);
        }

        function drawLive(cv, P, d) {
            if (settings.get('raw')) return drawRaw(cv, P, d);
            const items = [
                { label: 'Soot load', value: d.soot, unit: 'g', decimals: 1, history: recent(1), k: 'soot' },
                { label: 'Pressure difference', value: d.dp, unit: 'mbar', history: recent(4), k: 'dp' },
                { label: 'Before DPF', value: T(d.tDpf), unit: tU(), history: recent(2, T), k: 'tDpf' },
                { label: 'Before oxidation catalyst', value: T(d.tOxi), unit: tU(), history: recent(3, T), k: 'tOxi' },
            ];
            items.forEach((g, i) => {
                const x = 40 + (i % 2) * 480, y = 52 + Math.floor(i / 2) * 230;
                ID7.stat(cv, P, x, y, 420, Object.assign({ caption: 'History  -  last 5 min', sub: G.isNum(g.value) ? null : why(g.k) }, g));
            });
            cv.fillRect(1004, 52, 1, 440, P.line);
            const rows = [
                ['Oil ash mass', num(d.ash, 1, 'g')],
                ['Soot mass (calculated)', num(d.sootSim, 1, 'g')],
                ['Since regeneration', num(d.distSince, 1, 'km')],
                ['Fuel since regeneration', num(d.fuelSince, 1, 'l')],
                ['Engine time since regeneration', G.isNum(d.timeSince) ? (d.timeSince / 3600).toFixed(1) + ' h' : '--'],
                ['Average interval', num(d.avgInterval, 0, 'km')],
                ['Flow resistance', num(d.flowRes, 4)],
                ['Regeneration request', num(d.regenReq, 0)],
                ['Interruption status', num(d.interrupted, 0)],
                ['Lock status', num(d.lock, 0)],
            ];
            rows.forEach((r, i) => ID7.row(cv, P, 1030, 46 + i * 46, 530, 46, r[0], r[1], { size: 21, valueSize: 23 }));
        }

        /** Live data with "show raw replies": every identifier, its reply bytes and the value. */
        function drawRaw(cv, P, d) {
            cv.text('Engine unit 0x' + Number(cfg.ecu).toString(16).toUpperCase() + '  -  UDS 22', 56, 72, 22, P.dim);
            const s = link.stats;
            cv.text((link.ready ? link.available ? 'Link up' : 'Link down' : link.error || 'Connecting') + '   Requests ' + s.sent + '   Replies ' + s.replies + '   No answer ' + s.missed,
                1544, 72, 20, P.dim, { align: 'right' });
            ALL.forEach((k, i) => {
                const c = (cfg[k] || [])[rd.pick[k] || 0], r = c && rd.raws[rd.key(c)], y = 84 + i * 30;
                const v = d[k];
                cv.text(NAMES[k], 56, y + 22, 20, P.text2);
                cv.text(c ? DidReader.label(c) : '--', 560, y + 22, 20, P.dim);
                cv.text(d.demo ? 'demo' : r ? (r.bytes ? r.bytes.split(' ').slice(0, 9).join(' ') : r.why) : 'not asked yet', 660, y + 22, 20, P.dim);
                cv.text(G.isNum(v) ? G.fmt(v, Math.abs(v) < 10 && v % 1 ? 3 : 1) + ' ' + (UNITS[k] || '') : '--', 1544, y + 22, 21, G.isNum(v) ? P.text : P.dim, { align: 'right' });
                cv.fillRect(40, y + 29, 1520, 1, P.line);
            });
        }

        function drawHistory(cv, P, d) {
            // what this app has watched, as a two-line list
            cv.text('Regenerations', 56, 72, 22, P.dim);
            const list = (store.log || []).slice();
            if (regen && !regen.demo) list.unshift({ date: regen.date, sootStart: regen.sootStart, durS: ((regen.endedAt || mono()) - regen.t0) / 1000, peakT: regen.peakT, result: regen.endedAt ? 'checking' : 'running' });
            const COL = { completed: P.good, interrupted: P.warn, running: P.heat, checking: P.dim };
            const WORD = { completed: 'Completed', interrupted: 'Interrupted', running: 'Running', checking: 'Ended, checking...', 'not watched': 'While the app was closed' };
            if (!list.length) {
                cv.text(d.demo ? 'Demo: nothing is saved' : 'No regeneration recorded yet', 56, 130, 26, P.text2);
                cv.text('Open this app while a regeneration is running to record it.', 56, 166, 21, P.dim);
            }
            list.slice(0, 6).forEach((e, i) => {
                const sub = e.result === 'not watched' ? 'Seen afterwards (distance since regeneration went back to 0)'
                    : 'Soot ' + num(e.sootStart, 1, 'g') + '   Duration ' + dur(e.durS) + ' min   Peak ' + (G.isNum(e.peakT) ? Math.round(T(e.peakT)) + ' ' + tU() : '--');
                ID7.row(cv, P, 40, 84 + i * 70, 880, 70, e.date ? date(e.date) : '--', WORD[e.result] || e.result, { sub, valueColor: COL[e.result] || P.dim, valueSize: 22, focus: i === 0 && e.result === 'running' });
            });

            // the engine unit's memory: the last intervals as bars, the current one growing
            cv.fillRect(950, 52, 1, 440, P.line);
            cv.text('Engine unit memory', 980, 72, 22, P.dim);
            const h = d.history || [];
            const bars = [];
            for (let i = Math.min(h.length - 1, 4) - 1; i >= 0; i--) bars.push({ km: h[i] - h[i + 1], at: h[i] });
            if (G.isNum(d.distSince)) bars.push({ km: d.distSince, now: true });
            const avg = d.avgInterval;
            const top = Math.max(100, ...bars.map((b) => b.km), G.isNum(avg) ? avg : 0) * 1.15;
            const bx = 990, bw = 560, by = 110, bh = 250, slot = bw / Math.max(1, bars.length), base = by + bh;
            cv.fillRect(bx, base, bw, 2, P.scale);
            if (!bars.length) cv.text(d.demo ? '' : why('distSince') || 'Reading...', bx, by + 120, 22, P.dim);
            bars.forEach((b, i) => {
                const cx = bx + slot * i + slot / 2, hh = Math.max(3, (b.km / top) * bh), w = Math.min(64, slot * 0.5);
                if (b.now) {
                    cv.strokeRoundRect(cx - w / 2, base - hh, w, hh, 2, 2, P.accent);
                    cv.fillRect(cx - w / 2 + 2, base - hh + 2, w - 4, hh - 2, withAlpha(P.accent, 0.18));
                } else cv.card(cx - w / 2, base - hh, w, hh, 2, [[0, P.silver[0]], [1, P.silver[3]]]);
                cv.text(thousands(b.km), cx, base - hh - 12, 22, P.text, { align: 'center' });
                cv.text(b.now ? 'Now' : thousands(b.at), cx, base + 30, 18, P.dim, { align: 'center' });
            });
            if (G.isNum(avg) && bars.length) {
                const ay = base - (avg / top) * bh;
                for (let k = bx; k < bx + bw; k += 18) cv.fillRect(k, ay, 10, 2, P.accent);
                cv.text('Average ' + thousands(avg) + ' km', bx + bw, ay - 10, 18, P.accent, { align: 'right' });
            }
            ID7.row(cv, P, 970, 410, 590, 44, 'Interval in km, odometer at its end', null, { size: 18 });
            ID7.row(cv, P, 970, 454, 590, 44, 'Oil ash in the filter', num(d.ash, 1, 'g'), { size: 21 });
        }

        /* ---------- screen ---------- */
        let page = 0;
        async function render() {
            const P = ID7.palette(settings.get('accent')), d = snap;
            const cv = ctx.canvas(W, H).clear(P.bg);
            [drawOverview, drawLive, drawHistory][page](cv, P, d);
            if (cv.chrome) {
                // full-screen layout: the kit's header with the pages as tabs
                G.frame(cv, P, PAGES, page, [d.demo && { text: 'DEMO' }, running() && { text: 'REGENERATING', color: P.heat }]);
            } else {
                // iDrive layout: the HMI's title is over the page; the badges go top right of the page
                // (a running regeneration: Overview says so in its status, the other pages here)
                let xr = 1560;
                if (running() && page !== 0) {
                    const s = 'Regeneration running  ' + dur((mono() - regen.t0) / 1000);
                    cv.text(s, xr, 30, 20, P.heat, { align: 'right' });
                    xr -= cv.textWidth(s, 20) + 18;
                    cv.circle(xr, 23, 5, P.heat);
                    xr -= 22;
                }
                if (d.demo) ID7.pill(cv, P, xr, 9, 'DEMO');
            }
            return ui.image('MAIN_GFX', cv);
        }
        const go = (i) => { page = i; return render(); };
        BUTTONS.forEach((b, i) => ui.onClick(b, () => go(i)));
        ctx.onTab(go);
        settings.onChange((k) => { if (k === 'sootMax' && demo) demo.thr = threshold(); if (k === 'demo') { regen = null; } });
        // every screen refresh (60 fps) with the GPU renderer; 4 fps in software (PNG frames)
        ctx.loop('MAIN', 4, render);
        tick();
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
        void pollTimer;
    },
});
