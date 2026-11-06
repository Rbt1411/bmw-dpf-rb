'use strict';
/**
 * id7.js - drawing in the look of BMW's own iDrive 7 screens (Engine gauges, Warm-Up, Burbles):
 * black, thin lines, light type, no panels. Everything draws onto the kit's frame surface.
 *
 *   palette(accent)            colours; accent 'red' (as in Sport), 'blue', 'orange'
 *   value(cv, P, x, y, v, ...) big light number with its unit
 *   slantBar(cv, P, ...)       the slanted silver bar with the accent needle and a scale under it
 *   card(cv, P, ...)           thin accent-tinted frame (the item the controller is on, in BMW's screens)
 *   stat(cv, P, ...)           label, big value, a thin history line and its caption
 *   row(cv, P, ...)            a list row: label left, value right, a hairline under it
 *   pill(cv, P, ...)           small outlined badge
 */
const G = require('./kit/gauges');
const { withAlpha, mix } = require('./kit/canvas');

const ACCENTS = {
    red: { accent: '#e8291c', deep: '#3d0d09', border: '#5c2219' },
    blue: { accent: '#2f8dff', deep: '#0b2140', border: '#1f3f66' },
    orange: { accent: '#ff7a1a', deep: '#3d1c06', border: '#663816' },
};

function palette(name) {
    const a = ACCENTS[name] || ACCENTS.red;
    return Object.assign({
        name: 'id7-' + (ACCENTS[name] ? name : 'red'),
        bg: '#000000', text: '#ffffff', text2: '#d0d0d0', dim: '#8c8c8c', faint: '#555555',
        line: '#262626', track: '#3a3a3a', scale: '#c8c8c8',
        silver: ['#fdfdfd', '#e2e2e2', '#bdbdbd', '#9c9c9c'],
        good: '#62c97a', warn: '#ffb31a', heat: '#ff5a14',
        // for the kit's header in the full-screen layout (G.frame)
        sel: a.accent, selText: '#ffffff', tick: '#555555',
    }, a);
}

const isNum = G.isNum;
const fmt = (v, d) => (isNum(v) ? v.toFixed(d || 0) : '--');

/**
 * Big value + unit (light type). align 'left' | 'right' | 'center'. Returns the width drawn.
 * v: a number (decimals d) or a string.
 */
function value(cv, P, x, y, v, unit, size, opts) {
    opts = opts || {};
    const s = typeof v === 'string' ? v : fmt(v, opts.decimals), has = typeof v === 'string' || isNum(v);
    const us = unit ? ' ' + unit : '', uz = Math.max(16, Math.round(size * 0.46));
    const vw = cv.textWidth(s, size, { font: 'light' }), uw = us ? cv.textWidth(us, uz) : 0;
    const al = opts.align || 'left', left = al === 'right' ? x - vw - uw : al === 'center' ? x - (vw + uw) / 2 : x;
    cv.text(s, left, y, size, has ? opts.color || P.text : P.dim, { font: 'light' });
    if (us) cv.text(us, left + vw, y, uz, P.dim);
    return vw + uw;
}

/** A parallelogram slice of the bar between heights y0..y1 (left edge leaning like "/"). */
function slab(cv, xa, xb, y, h, s, y0, y1, c) {
    const L = (yy) => s * (1 - (yy - y) / h);
    cv.quad([[xa + L(y0), y0], [xb + L(y0), y0], [xb + L(y1), y1], [xa + L(y1), y1]], c);
}

/**
 * The slanted bar of BMW's gauges: dark track, silver fill (lighter at the top), the accent needle
 * at the value, and a scale line with numbers under it.
 * g = { value, min, max, ticks (intervals, default: picked so the steps are whole), mark (a value with
 * a small marker over the bar), zoneFrom (the track is tinted from there on), decimals (scale numbers) }.
 * Returns the y under the scale numbers.
 */
function slantBar(cv, P, x, y, w, h, g) {
    const min = g.min || 0, max = g.max, s = Math.round(h * 0.75), span = w - s;
    const X = (v) => x + G.clamp((v - min) / (max - min), 0, 1) * span;
    // track (and its zone)
    slab(cv, x, x + span, y, h, s, y, y + h, P.track);
    if (isNum(g.zoneFrom) && g.zoneFrom < max) slab(cv, X(g.zoneFrom), x + span, y, h, s, y, y + h, mix(P.track, P.accent, 0.22));
    // fill: silver bands, lighter at the top
    const v = G.smooth('id7bar|' + x + '|' + y, g.value);
    if (isNum(v) && v > min) {
        const xe = X(v), n = 8;
        for (let i = 0; i < n; i++) {
            const f = i / (n - 1), k = f * (P.silver.length - 1), j = Math.min(P.silver.length - 2, Math.floor(k));
            slab(cv, x, xe, y, h, s, y + (h * i) / n, y + (h * (i + 1)) / n + 0.6, mix(P.silver[j], P.silver[j + 1], k - j));
        }
        // the needle: a slanted accent line with a glow, a little longer than the bar
        const nx = xe, top = y - 7, bot = y + h + 7, sl = s * (h + 14) / h;
        cv.line(nx + s + (sl - s) / 2, top, nx - (sl - s) / 2, bot, 12, withAlpha(P.accent, 0.22));
        cv.line(nx + s + (sl - s) / 2, top, nx - (sl - s) / 2, bot, 4, P.accent);
    }
    // marker over the bar
    if (isNum(g.mark)) {
        const mx = X(g.mark) + s;
        cv.quad([[mx - 7, y - 16], [mx + 7, y - 16], [mx, y - 6], [mx, y - 6]], P.text2);
    }
    // scale: a line, ticks and numbers
    let n = g.ticks;
    if (!n) n = [5, 6, 4, 3].find((k) => Math.abs((max - min) / k - Math.round((max - min) / k)) < 1e-9) || 4;
    const ly = y + h + 12;
    cv.fillRect(x, ly, span, 2, P.scale);
    for (let i = 0; i <= n; i++) {
        const tv = min + (max - min) * i / n, tx = X(tv);
        cv.fillRect(tx - 1, ly - 7, 2, 9, P.scale);
        cv.text(fmt(tv, g.decimals || 0), tx, ly + 30, 21, P.text2, { align: i === 0 ? 'left' : i === n ? 'right' : 'center' });
    }
    return ly + 40;
}

/** Thin frame of the item the controller is on in BMW's screens (accent-tinted, square corners). */
function card(cv, P, x, y, w, h) {
    cv.card(x, y, w, h, 3, [[0, '#0d0d0d'], [1, '#050505']]);
    cv.strokeRoundRect(x, y, w, h, 3, 2, P.border);
}

/** A thin history line (no axes), scaled to its own range. */
function spark(cv, P, x, y, w, h, vals) {
    const pts = (vals || []).filter(isNum);
    if (pts.length < 2) { for (let k = 0; k < w; k += 14) cv.fillRect(x + k, y + h / 2, 7, 2, P.faint); return; }
    let lo = Math.min.apply(null, pts), hi = Math.max.apply(null, pts);
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const n = vals.length, line = [];
    vals.forEach((v, i) => { if (isNum(v)) line.push([x + (i / Math.max(1, n - 1)) * w, y + h - ((v - lo) / (hi - lo)) * h]); });
    cv.polyline(line, 2, '#a6a6a6');
}

/**
 * Stat: label, big value + unit, history line, caption (as BMW's Boost / Vehicle speed items).
 * g = { label, value, unit, decimals, history, caption, color, sub (text instead of the history) }
 */
function stat(cv, P, x, y, w, g) {
    cv.text(g.label, x, y + 24, 24, P.text2);
    value(cv, P, x, y + 84, g.value, g.unit, 58, { decimals: g.decimals, color: g.color });
    if (g.sub != null) { cv.text(g.sub, x, y + 130, 20, P.dim); return; }
    spark(cv, P, x, y + 102, w, 34, g.history);
    if (g.caption) cv.text(g.caption, x, y + 162, 16, P.dim);
}

/** List row: label (and a second line), value right, hairline under it. Returns its height. */
function row(cv, P, x, y, w, h, label, val, opts) {
    opts = opts || {};
    if (opts.focus) { cv.fillRect(x, y, w, h, P.deep); cv.strokeRoundRect(x, y, w, h, 2, 2, P.border); }
    const mid = y + h / 2;
    if (opts.sub) {
        cv.text(label, x + 16, mid - 6, opts.size || 24, opts.labelColor || P.text);
        cv.text(opts.sub, x + 16, mid + 22, 19, P.dim);
    } else cv.text(label, x + 16, mid + 8, opts.size || 23, opts.labelColor || P.text2);
    if (val != null) cv.text(String(val), x + w - 16, mid + (opts.sub ? -6 : 9), opts.valueSize || 25, opts.valueColor || P.text, { align: 'right' });
    if (opts.right2) cv.text(opts.right2, x + w - 16, mid + 22, 19, P.dim, { align: 'right' });
    if (!opts.focus) cv.fillRect(x, y + h - 1, w, 1, P.line);
    return h;
}

/** Small outlined badge, right-aligned at xr. Returns its left edge. */
function pill(cv, P, xr, y, text, color) {
    const w = cv.textWidth(text, 16, { font: 'bold', spacing: 1.5 }) + 20;
    cv.strokeRoundRect(xr - w, y, w, 24, 3, 1.5, color || P.dim);
    cv.text(text, xr - w / 2, y + 18, 16, color || P.dim, { align: 'center', font: 'bold', spacing: 1.5 });
    return xr - w;
}

module.exports = { palette, value, slantBar, card, spark, stat, row, pill, fmt };
