'use strict';
/**
 * illustration.js - the particulate filter, drawn as a cut-away (in place of the rendered parts in BMW's
 * own screens): inlet pipe and cone, the can with a window onto the filter's channels, outlet.
 * The window fills with soot, ash collects at the end of the channels, and during a regeneration the
 * filter glows. Leader lines name the temperature before the DPF, the soot, the ash and the pressure
 * difference across the filter.
 *
 *   drawDpf(cv, P, x, y, s)   box 740 x 342; s = { soot, sootMax, ash, tDpf, dp, regen, tUnit, T (deg C -> shown) }
 */
const G = require('./kit/gauges');
const { withAlpha, mix } = require('./kit/canvas');

const W = 740, H = 342, CY = 190;
const PIPE = 20, CAN = 88;                           // half heights
const X_IN = 20, X_CONE1 = 120, X_CAN = 185, X_CAN2 = 555, X_CONE2 = 620, X_OUT = 720;
const WIN = { x: 215, y: CY - 64, w: 310, h: 128 };  // the window onto the channels
const METAL = [[0, '#5a5a5a'], [0.18, '#d8d8d8'], [0.32, '#f4f4f4'], [0.55, '#9a9a9a'], [0.85, '#3e3e3e'], [1, '#2a2a2a']];

/** The metal colour at height f (0 top .. 1 bottom) of a cylinder. */
function metalAt(f) {
    let k = 0;
    while (k < METAL.length - 2 && f > METAL[k + 1][0]) k++;
    const a = METAL[k], b = METAL[k + 1];
    return mix(a[1], b[1], G.clamp((f - a[0]) / (b[0] - a[0]), 0, 1));
}

/** A cone between half heights h0 (at xa) and h1 (at xb), shaded like the cylinders. */
function cone(c, xa, xb, h0, h1) {
    const n = 14;
    for (let i = 0; i < n; i++) {
        const f0 = i / n, f1 = (i + 1) / n + 0.01;
        const ya0 = CY - h0 + 2 * h0 * f0, ya1 = CY - h0 + 2 * h0 * f1, yb0 = CY - h1 + 2 * h1 * f0, yb1 = CY - h1 + 2 * h1 * f1;
        c.quad([[xa, ya0], [xb, yb0], [xb, yb1], [xa, ya1]], metalAt((f0 + f1) / 2));
    }
}

/** The parts that never change: pipes, cones, can, window and channels (one GPU layer). */
function body(c) {
    c.card(X_IN, CY - PIPE, X_CONE1 - X_IN + 4, 2 * PIPE, 6, METAL);
    c.card(X_CONE2 - 4, CY - PIPE, X_OUT - X_CONE2 + 4, 2 * PIPE, 6, METAL);
    cone(c, X_CONE1, X_CAN + 2, PIPE, CAN);
    cone(c, X_CAN2 - 2, X_CONE2, CAN, PIPE);
    c.card(X_CAN, CY - CAN, X_CAN2 - X_CAN, 2 * CAN, 14, METAL);
    // clamps at the can's ends, pipe flanges
    [X_CAN + 14, X_CAN2 - 20].forEach((x) => { c.card(x, CY - CAN - 2, 6, 2 * CAN + 4, 2, [[0, '#3a3a3a'], [0.3, '#bdbdbd'], [1, '#202020']]); });
    [X_CONE1 - 8, X_CONE2].forEach((x) => { c.card(x, CY - PIPE - 5, 8, 2 * PIPE + 10, 2, [[0, '#444'], [0.3, '#d0d0d0'], [1, '#222']]); });
    // the window: frame, ceramic, channels with their plugs (inlet channels closed at the back, outlet ones at the front)
    c.roundRect(WIN.x - 5, WIN.y - 5, WIN.w + 10, WIN.h + 10, 8, '#161616');
    c.card(WIN.x, WIN.y, WIN.w, WIN.h, 4, [[0, '#a8a8a8'], [1, '#7c7c7c']]);
    const pitch = WIN.h / 12;
    for (let k = 1; k < 12; k++) c.fillRect(WIN.x, WIN.y + k * pitch - 1, WIN.w, 2, '#646464');
    for (let k = 0; k < 12; k++) {
        const y = WIN.y + k * pitch + 2, h = pitch - 3;
        c.fillRect(k % 2 ? WIN.x : WIN.x + WIN.w - 9, y, 9, h, '#555555');
    }
    // sensors: temperature before the filter (on the inlet cone), pressure taps before and after it
    c.card(X_CONE1 + 36, CY - 66 - 22, 8, 26, 2, [[0, '#e0e0e0'], [1, '#7a7a7a']]);
    [X_CAN + 34, X_CAN2 - 40].forEach((x) => c.card(x, CY + CAN - 2, 6, 18, 2, [[0, '#9a9a9a'], [1, '#e0e0e0']]));
}

/** Soot specks: the same places every frame (a fixed sequence), as many as the load asks for. */
const SPECKS = (() => {
    let s = 7;
    const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    const out = [];
    for (let i = 0; i < 220; i++) out.push([r(), Math.floor(r() * 12), r()]);
    return out;
})();

function leader(cv, P, x, y0, y1) {
    cv.line(x, y0, x, y1, 1.5, '#7c7c7c');
    cv.circle(x, y0, 3.5, '#d0d0d0');
}
function caption(cv, P, x, label, val, unit, align, decimals) {
    cv.text(label, x, 22, 19, P.dim, { align });
    const s = G.isNum(val) ? val.toFixed(decimals || 0) : '--', us = ' ' + unit;
    const vw = cv.textWidth(s, 34, { font: 'light' }), uw = cv.textWidth(us, 18);
    const left = align === 'right' ? x - vw - uw : align === 'center' ? x - (vw + uw) / 2 : x;
    cv.text(s, left, 56, 34, G.isNum(val) ? P.text : P.dim, { font: 'light' });
    cv.text(us, left + vw, 56, 18, P.dim);
}

function drawDpf(cv, P, x0, y0, s) {
    const now = Date.now();
    cv.blit(G.layer('dpf-body', W, H, body, cv.textScale), x0, y0);
    const ox = (x) => x0 + x, oy = (y) => y0 + y;
    // soot: the ceramic darkens and specks gather in the inlet channels
    const f = G.isNum(s.soot) ? G.clamp(s.soot / Math.max(1, s.sootMax), 0, 1.25) : 0;
    if (f > 0) {
        cv.fillRect(ox(WIN.x), oy(WIN.y), WIN.w - 9, WIN.h, withAlpha('#000000', 0.12 + 0.45 * Math.min(1, f)));
        const n = Math.round(SPECKS.length * Math.min(1, f / 1.1)), pitch = WIN.h / 12;
        for (let i = 0; i < n; i++) {
            const [u, ch, v] = SPECKS[i];
            if (ch % 2 === 1) continue;                    // inlet channels only
            cv.circle(ox(WIN.x + 12 + u * (WIN.w - 30)), oy(WIN.y + ch * pitch + pitch / 2 + (v - 0.5) * 4), 2 + v * 1.4, '#141414');
        }
    }
    // ash: at the back of the inlet channels
    const aw = G.isNum(s.ash) ? 6 + 34 * G.clamp(s.ash / 80, 0, 1) : 0;
    if (aw) {
        const pitch = WIN.h / 12;
        for (let k = 0; k < 12; k += 2) cv.fillRect(ox(WIN.x + WIN.w - 9 - aw), oy(WIN.y + k * pitch + 2), aw, pitch - 3, withAlpha('#ece6da', 0.85));
    }
    // heat: a glow while regenerating, a faint one when the exhaust is hot anyway
    const hot = G.isNum(s.tDpf) ? G.clamp((s.tDpf - 420) / 200, 0, 1) : 0;
    const glow = s.regen ? 0.55 + 0.25 * Math.sin(now / 420) : hot * 0.45;
    if (glow > 0.02) {
        cv.card(ox(WIN.x), oy(WIN.y), WIN.w, WIN.h, 4, [[0, withAlpha('#ff3b14', 0.25 * glow)], [0.5, withAlpha('#ff7a1a', 0.55 * glow)], [1, withAlpha('#ff3b14', 0.3 * glow)]]);
        for (let k = 3; k >= 1; k--) cv.strokeRoundRect(ox(X_CAN - 2 * k), oy(CY - CAN - 2 * k), X_CAN2 - X_CAN + 4 * k, 2 * CAN + 4 * k, 14 + 2 * k, 2.5, withAlpha(P.heat, 0.16 * glow * (4 - k)));
    }
    // leader lines and their values
    const tx = X_CONE1 + 40, sx = WIN.x + 90, ax = WIN.x + WIN.w - 9 - aw / 2;
    leader(cv, P, ox(tx), oy(CY - 66 - 22), oy(66));
    caption(cv, P, ox(tx - 12), 'Before DPF', s.T(s.tDpf), s.tUnit, 'left');
    leader(cv, P, ox(sx), oy(WIN.y + 18), oy(66));
    caption(cv, P, ox(sx + 12), 'Soot', s.soot, 'g', 'left', 1);
    if (aw) { leader(cv, P, ox(ax), oy(WIN.y + 10), oy(66)); caption(cv, P, ox(ax + 30), 'Ash', s.ash, 'g', 'right', 1); }
    // pressure difference: the two taps joined under the can
    const t1 = X_CAN + 37, t2 = X_CAN2 - 37, ly = CY + CAN + 26;
    cv.line(ox(t1), oy(CY + CAN + 16), ox(t1), oy(ly), 1.5, '#7c7c7c');
    cv.line(ox(t2), oy(CY + CAN + 16), ox(t2), oy(ly), 1.5, '#7c7c7c');
    cv.line(ox(t1), oy(ly), ox(t2), oy(ly), 1.5, '#7c7c7c');
    const mid = (t1 + t2) / 2, dps = G.isNum(s.dp) ? s.dp.toFixed(0) : '--';
    cv.text('Pressure difference', ox(mid - 10), oy(ly + 34), 19, P.dim, { align: 'right' });
    const vw = cv.text(dps, ox(mid + 6), oy(ly + 36), 30, G.isNum(s.dp) ? P.text : P.dim, { font: 'light' });
    cv.text(' mbar', ox(mid + 6 + vw), oy(ly + 36), 18, P.dim);
    // flow
    [[X_IN + 24, 1], [X_OUT - 50, 1]].forEach(([x]) => {
        for (let k = 0; k < 2; k++) cv.polyline([[ox(x + k * 12), oy(CY - 8)], [ox(x + k * 12 + 8), oy(CY)], [ox(x + k * 12), oy(CY + 8)]], 2.5, withAlpha('#222222', 0.9));
    });
}

module.exports = { drawDpf, W, H };
