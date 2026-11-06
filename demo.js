'use strict';
/**
 * demo.js - a made-up DPF for the PC preview, the emulator and a bench unit (nothing answers UDS there).
 *
 * Driving at ~100 km/h: soot builds up, at the threshold the engine unit asks for a regeneration,
 * the exhaust heats up to ~620 deg C, the soot burns off, and "distance since regeneration" starts
 * again from 0. Sped up so a whole cycle takes about two minutes.
 */
const SPEED_KMS = 100 / 3600 * 6;     // km per second, 6x real time
const SOOT_PER_KM = 0.22;             // g per km (sped up as well)

class DemoDpf {
    constructor(threshold) {
        this.thr = threshold || 24;
        this.t = Date.now();
        this.soot = this.thr * 0.62;
        this.km = 168;                // since the last regeneration
        this.fuel = 9.4;              // l since the last regeneration
        this.odo = 48210;             // km
        this.regen = 0;               // s into the running regeneration, 0 = none
        this.tExh = 290;
        this.hist = [this.odo - this.km, this.odo - this.km - 402, this.odo - this.km - 811, this.odo - this.km - 1168, this.odo - this.km - 1603];
    }

    /** Advance to now and return the values as the engine unit would (in real units). */
    sample() {
        const now = Date.now(), dt = Math.min(2, (now - this.t) / 1000);
        this.t = now;
        const dkm = SPEED_KMS * dt;
        this.km += dkm; this.odo += dkm; this.fuel += dkm * 0.055;
        if (!this.regen && this.soot >= this.thr) this.regen = 0.001;
        let target = 280 + 40 * Math.sin(now / 9000);
        if (this.regen) {
            this.regen += dt;
            target = 625;
            if (this.tExh > 540) this.soot = Math.max(0.6, this.soot - dt * 0.55);
            if (this.regen > 70 || this.soot <= 0.6) {
                this.regen = 0;
                this.hist.unshift(this.odo); this.hist.length = 5;
                this.km = 0; this.fuel = 0;
            }
        } else {
            this.soot += dkm * SOOT_PER_KM * (0.8 + 0.4 * Math.random());
        }
        this.tExh += (target - this.tExh) * Math.min(1, dt * 0.12);
        const noise = (a) => (Math.random() - 0.5) * a;
        return {
            soot: this.soot,
            sootSim: this.soot * 1.06 + 0.3,
            ash: 41.7,
            distSince: this.km,
            avgInterval: 412,
            fuelSince: this.fuel,
            regenReq: this.regen ? 2 : 0,
            interrupted: 0,
            lock: 0,
            dp: 18 + this.soot * 1.4 + noise(3),
            tDpf: this.tExh + noise(4),
            tOxi: this.tExh * (this.regen ? 0.93 : 1.05) + noise(4),
            flowRes: 0.02 + this.soot * 0.0012,
            timeSince: this.km / 100 * 3600,
            history: this.hist.slice(),
        };
    }
}

module.exports = { DemoDpf };
