/* Audio.js - THE WENDIGO sound engine. Every sound is synthesised live with the
   Web Audio API; there are no audio files.

   Signal flow
     player one-shots ─ sfx ──────────────────────────────────────────┐
     positional one-shots ─ inp ─[delay d/343]─[lowpass: distance, cave muffle]─ HRTF panner ─ out ─┤
                                     ├─ wet ─ revIn   (more when far)  │
                                     └─ farWet ─ revFar (valley tail)  │
     ambient events (birds, insects, frogs...) ─ same chain ─ natBus ─┤  natBus/natRev duck with env.silence
     beds (wind, rain, creek, surf, fire, menace, cave, insects...) ─ amb ─┤
     revIn ─┬─ convolver 'small' ─ revS ─┐                              │
            └─ convolver 'large' ─ revL ─┼──────────────────────────────┤
     revFar ── convolver 'valley' (7 s) ─ revH ─────────────────────────┤
                                                                         mix ─ hp ─ uw (underwater lowpass) ─ mfilt (hurt/death muffle) ─┐
     music (tension drone, chase, styles, stingers) ────────────────────────────────────────────────────────────────── comp ─ cut ─ out(volume) ─ limiter ─ clip ─ speakers
   The impulse responses are generated noise tails. setSpace() crossfades the small/large
   returns. The final clip is a WaveShaper, so the output can never exceed 0.97.

   3D: every positional one-shot gets its own chain with an HRTF PannerNode (rolloff 0: the
   engine does distance itself). The AudioListener follows `listener` every update(). Far
   sounds are quieter, darker, wetter and arrive late (distance / 343 m/s, capped at 12 s).
   A source in a different space than the listener (cave vs outside) is heavily muffled.
   Which space a pos is in: pos.cave (boolean) if present, else audio.caveTest(pos) if set,
   else "the same space as the listener". The listener is "in a cave" when setSpace('cave')
   or env.cave > 0.5.

   Voices: positional one-shots are tracked; at most 48 live at once (the oldest is faded
   out), ambient generators stop adding events above 36. Chains are disconnected in update()
   once their sound has ended. Ambient generators fire discrete events from timers (never
   per-frame node creation); continuous beds are built lazily and only re-automated when
   their level changes.

   Everything is silent (and harmless) before unlock(): every public method returns early
   when there is no AudioContext. pilotRadio() still returns its duration.

   PUBLIC API   (pos = any {x,y,z}, a THREE.Vector3 works; omitted/null pos = at the listener, unpanned)
   core     unlock(ctx?)                 create/resume the AudioContext on a user gesture; ctx: an existing
                                         (Offline)AudioContext (test page)
            setVolume(master, music)     0..1 each
            listener = {x,y,z,yaw,pitch} mutate every frame (camera rotation.y / rotation.x; yaw 0 looks to -Z)
            update(dt)                   EVERY FRAME
            setSpace(name)               'outdoor' | 'cave' | 'interior'
            reset()                      after death/respawn: un-muffle, clear heartbeat/breath/chase/alarm
            strict                       true rethrows synthesis errors (tests); default false swallows them
            caveTest                     optional (pos) => bool, is that point underground
            roomTone                     0..1 multiplier of the near-inaudible room tone (default 1)
   env      setEnv({daylight, dusk, night, wind, rain, storm, water, ocean, cave, fire, silence, menace,
                    underwater, height})    all 0..1, missing keys keep their value
   player   step(surface, speed, pos?)   surface 'grass'|'forest'|'dirt'|'rock'|'sand'|'mud'|'wood'|'water'|
                                         'snow'|'cave'|'leaves'; speed 0 sneak..1 sprint; pos = another player
            jump(), land(force01), hurt(amount01), death(), eat(), drink(), swim()
            breath(stamina01)            EVERY FRAME (panting below ~0.55; calm breathing audible in silence)
            heartbeat(intensity01)       EVERY FRAME (0 = none)
   tools    axeSwing(), axeHit(pos, power01, material 'wood'|'flesh'|'stone'|'metal'), woodChips(pos),
            treeCreak(pos, size01), treeFall(pos, size01), treeImpact(pos, size01), chopLog(pos),
            spearThrust(), bowDraw(), bowRelease(), arrowHit(pos, material), rifleShot(pos), flareGun(pos),
            lighter(), torchIgnite(pos), flashlightClick(), pickup(kind 'wood'|'stone'|'item'|'food'|'relic'|
            'note'), drop(), craft(), build(pos), buildDeny(), doorOpen(pos), doorClose(pos), chestOpen(pos),
            fireIgnite(pos), structureHit(pos), structureBreak(pos), splash(pos, size01)
   animals  animal(kind, sound, pos, corrupt01=0)
                kind  'wolf'|'rabbit'|'deer'|'bear'|'bird'|'crawler'|'owl'|'crow'
                sound 'idle'|'alert'|'attack'|'hurt'|'die'|'howl'|'call'|'flee'|'growl'
                corrupt01: pitch/formant drop, ring modulation, stutter, a lagging detuned double,
                reversed swells, longer.
            birdFlock(pos, n), birdMimic(pos), birdSong(species, pos)  species 'thrush'|'chickadee'|
                'finch'|'warbler'|'dove' (the ambient generator uses these too)
   humans   cannibal(sound, pos, variant)  'idle'|'alert'|'attack'|'hurt'|'die'|'ritual'|'fear'|'call'
            mimicName(pos, name), pilotRadio(text) -> seconds
   wendigo  wendigo(sound, pos, power01=1)  'step'|'breath'|'growl'|'clicks'|'scream'|'roar'|'screech'|'hurt'|
                'snap'|'rustle'|'death'|'disintegrate'
   world    thunder(distance01), branchSnap(pos), bushRustle(pos), rockFall(pos), rockSlide(pos), knock(pos),
            footstepsFake(pos, n), distantScream(pos), creak(pos), stoneGrind(pos), deadfall(pos),
            helicopter(on, pos, level01), heliAlarm(on), crash(), radioStatic(dur), beacon()
   music    setTension(0..1), setChase(bool), stinger('dread'|'reveal'|'jump'|'safe'|'discovery'|'relic'),
            setMusic('none'|'menu'|'calm'|'finale'|'rescue'|'credits')
   ui       uiClick(), uiOpen(), uiClose(), deny(), objective(), journal(), discovery()
   helpers  tone(freq, dur, type, vol, att, slide, delay, dest), noise(dur, vol, type, freq, q, sweep, delay,
            dest, buf 'white'|'brown'|'pink'|'crackle', att)   low level, usable by game code */
let ctx = null;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const F = (f) => clamp(fin(f, 440), 8, 20000);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const NOTE = (m) => 440 * Math.pow(2, (m - 69) / 12);
const hashStr = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

const ENV_DEFAULT = { daylight: 1, dusk: 0, night: 0, wind: 0.3, rain: 0, storm: 0, water: 0, ocean: 0, cave: 0, fire: 0, silence: 0, menace: 0, underwater: 0, height: 0 };
/** env key -> smoothing rate per second [up, down] */
const ENV_RATE = { silence: [1.6, 0.25], underwater: [4, 4], cave: [1, 1] };
/** reverb returns [small, large] per space */
const SPACES = { outdoor: [0.04, 0.16], cave: [0.2, 0.95], interior: [0.45, 0.05] };
/** bed -> output scale at level 1 */
const BEDS = { wind: 0.3, leaves: 0.12, rain: 0.22, creek: 0.22, ocean: 0.4, fire: 0.25, menace: 0.55, cave: 0.16, underwater: 0.3, insects: 0.035, room: 0.012 };
const MAX_VOICES = 48, AMB_VOICES = 36;
/** vowel formants F1..F3 (Hz) */
const VOWELS = { a: [730, 1090, 2440], e: [530, 1840, 2480], i: [300, 2250, 3000], o: [570, 840, 2410], u: [320, 870, 2240], y: [300, 2000, 2700], x: [500, 1500, 2500] };
const NONE = { d: null, a: 0, dist: 0, dl: 0 };

/** text -> [{v vowel, c consonant class 'f'|'p'|'n'|'', pause, end}] one per vowel group */
function syllables(text) {
  const out = [];
  const words = String(text == null ? '' : text).split(/\s+/).filter(Boolean);
  for (const w of words) {
    const lw = w.toLowerCase(), re = /([^aeiouyåäöéü]*)([aeiouyåäöéü]+)/g;
    let m, any = false;
    while ((m = re.exec(lw))) {
      any = true;
      const cons = m[1].replace(/[^a-z]/g, '');
      let v = m[2][0];
      if (v === 'å') v = 'o'; else if (v === 'ä' || v === 'é') v = 'e'; else if (v === 'ö') v = 'u'; else if (v === 'ü') v = 'y';
      const c = /[szfvhcjx]/.test(cons) ? 'f' : /[ptkbdgq]/.test(cons) ? 'p' : /[mnlrw]/.test(cons) ? 'n' : '';
      out.push({ v: VOWELS[v] ? v : 'x', c, pause: 0, end: '' });
    }
    if (!any && /[a-z0-9]/.test(lw)) out.push({ v: 'x', c: 'n', pause: 0, end: '' });
    if (!out.length) continue;
    const last = out[out.length - 1];
    if (/[.!?…]["')]*$/.test(w)) { last.pause = 0.28; last.end = (w.match(/[.!?]/g) || ['.']).pop(); }
    else if (/[,;:—-]$/.test(w)) last.pause = 0.14;
    else last.pause = Math.max(last.pause, 0.035);
  }
  return out;
}

const PUBLIC = ['unlock', 'setVolume', 'update', 'setSpace', 'reset', 'setEnv', 'step', 'jump', 'land', 'hurt', 'death', 'breath', 'heartbeat', 'eat', 'drink', 'swim',
  'axeSwing', 'axeHit', 'woodChips', 'treeCreak', 'treeFall', 'treeImpact', 'chopLog', 'spearThrust', 'bowDraw', 'bowRelease', 'arrowHit', 'rifleShot', 'flareGun', 'lighter',
  'torchIgnite', 'flashlightClick', 'pickup', 'drop', 'craft', 'build', 'buildDeny', 'doorOpen', 'doorClose', 'chestOpen', 'fireIgnite', 'structureHit', 'structureBreak', 'splash',
  'animal', 'birdFlock', 'birdMimic', 'birdSong', 'cannibal', 'mimicName', 'pilotRadio', 'wendigo', 'thunder', 'branchSnap', 'bushRustle', 'rockFall', 'rockSlide', 'knock',
  'footstepsFake', 'distantScream', 'creak', 'stoneGrind', 'deadfall', 'helicopter', 'heliAlarm', 'crash', 'radioStatic', 'beacon', 'setTension', 'setChase', 'stinger', 'setMusic',
  'uiClick', 'uiOpen', 'uiClose', 'deny', 'objective', 'journal', 'discovery'];

export class Audio {
  constructor() {
    this.enabled = false; this.strict = false;
    this.vol = 0.8; this.musicVol = 0.6;
    this.listener = { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 };
    this.space = 'outdoor'; this.caveTest = null; this.roomTone = 1;
    this.envT = { ...ENV_DEFAULT }; this.envL = { ...ENV_DEFAULT };
    this.tension = 0; this.tensionLvl = 0; this.chase = false; this.chaseLvl = 0;
    this.musicName = 'none';
    this.hb = 0; this.hbAt = -99; this.stam = 1; this.brAt = -99; this.dead = false;
    this.timers = {}; this.clock = 0; this.gust = 0.4; this.gustT = 0.4; this.gustNext = 0;
    this.lastBird = null; this.birds = []; this.crickets = []; this.heliAl = false;
    this._reset0();
    // every public method: errors are swallowed unless strict
    for (const k of PUBLIC) {
      const f = this[k];
      if (typeof f !== 'function') continue;
      this[k] = (...a) => { try { return f.apply(this, a); } catch (e) { if (this.strict) throw e; return k === 'pilotRadio' ? 3 : undefined; } };
    }
  }
  _reset0() { this.beds = {}; this.voices = []; this.nLive = 0; this.heli = null; this.dr = null; this.cBus = null; this.sBus = null; this.natSent = -1; this.uwSent = -1; this.alBus = null; }

  /* =========================================================== setup */
  unlock(useCtx) {
    if (useCtx) { ctx = useCtx; this._build(); return true; }
    if (ctx) { if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {}); return true; }
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; return false; }
    try { this._build(); } catch (e) { ctx = null; this.enabled = false; if (this.strict) throw e; return false; }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return true;
  }
  _build() {
    this.enabled = true; this._reset0();
    const sr = ctx.sampleRate, n = Math.floor(sr * 3);
    const mk = (fill, seam) => {
      const b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0); fill(d);
      if (seam) { const e = d[n - 1] - d[0]; for (let i = 0; i < n; i++) d[i] -= e * i / (n - 1); } // loop without a click
      return b;
    };
    this.bufs = {
      white: mk((d) => { for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; }),
      brown: mk((d) => { let l = 0; for (let i = 0; i < n; i++) { l = (l + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = l * 3.5; } }, true),
      pink: mk((d) => { let b0 = 0, b1 = 0, b2 = 0; for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22; } }, true),
      crackle: mk((d) => { let v = 0; for (let i = 0; i < n; i++) { if (Math.random() < 0.0016) v = Math.random() * 2 - 1; else v *= 0.62; d[i] = v; } }),
    };
    const curve = (k) => { const c = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); } return c; };
    this.cSoft = curve(2); this.cHard = curve(7);
    // a pulse train for the rotor (blade slap)
    const re = new Float32Array(32), im = new Float32Array(32);
    for (let h = 1; h < 32; h++) re[h] = (1 - h / 34);
    this.pulseWave = ctx.createPeriodicWave(re, im);

    const G = (v, to) => this._G(v, to);
    this.clip = ctx.createWaveShaper(); // hard ceiling: identity below 0.82, smooth knee up to 0.97
    { const c = new Float32Array(2048); for (let i = 0; i < 2048; i++) { const x = i / 1023.5 - 1, a = Math.abs(x); c[i] = Math.sign(x) * (a < 0.82 ? a : 0.82 + 0.15 * Math.tanh((a - 0.82) / 0.15)); } this.clip.curve = c; }
    this.clip.connect(ctx.destination);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3; this.limiter.knee.value = 0; this.limiter.ratio.value = 20; this.limiter.attack.value = 0.002; this.limiter.release.value = 0.15;
    this.limiter.connect(this.clip);
    this.out = G(this.vol, this.limiter);
    this.cut = G(1, this.out);
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18; this.comp.knee.value = 10; this.comp.ratio.value = 4; this.comp.attack.value = 0.004; this.comp.release.value = 0.25;
    this.comp.connect(this.cut);
    this.mfilt = this._filt('lowpass', 20000, 0.5); this.mfilt.connect(this.comp);
    this.uw = this._filt('lowpass', 20000, 0.6); this.uw.connect(this.mfilt);
    this.hp = this._filt('highpass', 24, 0.7); this.hp.connect(this.uw);
    this.mix = G(0.7, this.hp);
    this.revIn = G(1); this.revFar = G(1);
    this.convS = ctx.createConvolver(); this.convS.buffer = this._ir(0.9, 3.4, 0.55, 0);
    this.convL = ctx.createConvolver(); this.convL.buffer = this._ir(3.6, 2.2, 0.85, 0.03);
    this.convH = ctx.createConvolver(); this.convH.buffer = this._ir(7, 1.5, 0.92, 0.09);
    this.revS = G(0, this.mix); this.revL = G(0, this.mix); this.revH = G(0.45, this.mix);
    this.revIn.connect(this.convS); this.convS.connect(this.revS);
    this.revIn.connect(this.convL); this.convL.connect(this.revL);
    this.revFar.connect(this.convH); this.convH.connect(this.revH);
    this.sfx = G(1, this.mix); this.sfx.connect(G(0.16, this.revIn));
    this.amb = G(1, this.mix); this.amb.connect(G(0.12, this.revIn));
    this.natBus = G(1, this.mix); this.natRev = G(1, this.revIn);
    this.music = G(this.musicVol * 0.5, this.comp); this.music.connect(G(0.3, this.revIn));
    this.pulseNext = 0; this.hbNext = 0; this.brNext = 0; this.alNext = 0;
    this.setSpace(this.space, true);
    this._syncListener();
    if (this.musicName !== 'none') this._styleSwitch();
  }
  _ir(sec, decay, damp, pre) {
    const sr = ctx.sampleRate, n = Math.max(2, Math.floor(sr * sec)), p = Math.floor(sr * pre);
    const b = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch); let lp = 0;
      for (let i = p; i < n; i++) {
        const x = (i - p) / (n - p), a = clamp(1 - damp * Math.pow(x, 0.7), 0.04, 1);
        lp += a * ((Math.random() * 2 - 1) - lp); d[i] = lp * Math.pow(1 - x, decay);
      }
      const er = Math.floor(sr * 0.07);
      for (let j = 0; j < 10; j++) { const k = p + Math.floor(Math.random() * er); if (k < n) d[k] += (Math.random() * 2 - 1) * 0.5 * (1 - (k - p) / er); }
    }
    return b;
  }
  setVolume(master, music) {
    this.vol = clamp(fin(master, this.vol), 0, 1); this.musicVol = clamp(fin(music, this.musicVol), 0, 1);
    if (!ctx) return; const t = ctx.currentTime;
    this.out.gain.setTargetAtTime(this.vol, t, 0.03); this.music.gain.setTargetAtTime(this.musicVol * 0.5, t, 0.03);
  }
  setSpace(name, now) {
    if (name === 'room') name = 'interior';
    if (!SPACES[name]) name = 'outdoor';
    this.space = name; if (!ctx) return;
    const [s, l] = SPACES[name], t = ctx.currentTime, tc = now ? 0.005 : 0.6;
    this.revS.gain.setTargetAtTime(s, t, tc); this.revL.gain.setTargetAtTime(l, t, tc);
  }
  reset() {
    this.dead = false; this.hb = 0; this.stam = 1; this.chase = false; this.heliAl = false;
    if (!ctx) return; const t = ctx.currentTime;
    for (const p of [this.mfilt.frequency, this.cut.gain]) { p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); }
    this.mfilt.frequency.setTargetAtTime(20000, t, 0.3); this.cut.gain.setTargetAtTime(1, t, 0.2);
  }
  setEnv(o) {
    if (!o) return;
    for (const k in o) if (k in ENV_DEFAULT) this.envT[k] = clamp(fin(o[k], this.envT[k]), 0, 1);
  }
  _syncListener() {
    const L = this.listener || {}, l = ctx.listener;
    const x = fin(L.x), y = fin(L.y), z = fin(L.z), yw = fin(L.yaw), p = fin(L.pitch);
    const cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(yw), sy = Math.sin(yw);
    const fx = -sy * cp, fy = sp, fz = -cy * cp, ux = sy * sp, uy = cp, uz = cy * sp;
    if (l.positionX) {
      l.positionX.value = x; l.positionY.value = y; l.positionZ.value = z;
      l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
      l.upX.value = ux; l.upY.value = uy; l.upZ.value = uz;
    } else { l.setPosition(x, y, z); l.setOrientation(fx, fy, fz, ux, uy, uz); }
  }

  /* =========================================================== low-level helpers */
  _G(v, to) { const g = ctx.createGain(); g.gain.value = v; if (to) g.connect(to); return g; }
  _t(dl) { return ctx.currentTime + Math.max(0, fin(dl, 0)); }
  /** one oscillator with an exponential envelope; returns the OscillatorNode (or null) */
  tone(freq, dur, type = 'sine', vol = 0.2, att = 0.005, slide = 0, delay = 0, dest = null) {
    if (!ctx || !(vol >= 0.0003)) return null;
    dur = Math.max(0.01, fin(dur, 0.1)); att = clamp(fin(att, 0.005), 0.0005, dur * 0.9);
    const t = this._t(delay), f0 = F(freq);
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t);
    if (slide && slide !== 1) o.frequency.exponentialRampToValueAtTime(F(f0 * slide), t + dur);
    const g = ctx.createGain(); g.gain.value = 0; g.gain.setValueAtTime(0.0001, t); // value 0 first: no full-gain sample before t
    g.gain.exponentialRampToValueAtTime(Math.min(vol, 1), t + att); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest || this.sfx); o.start(t); o.stop(t + dur + 0.05);
    o.onended = () => { o.disconnect(); g.disconnect(); };
    return o;
  }
  /** filtered noise burst. buf: 'white'|'brown'|'pink'|'crackle' */
  noise(dur, vol, type = 'lowpass', freq = 1000, q = 1, sweep = 0, delay = 0, dest = null, buf = 'white', att = 0.002) {
    if (!ctx || !(vol >= 0.0003)) return null;
    dur = Math.max(0.01, fin(dur, 0.1)); att = clamp(fin(att, 0.002), 0.0005, dur * 0.9);
    const t = this._t(delay);
    const s = ctx.createBufferSource(); s.buffer = this.bufs[buf] || this.bufs.white; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(F(freq), t); f.Q.value = clamp(fin(q, 1), 0.0001, 40);
    if (sweep && sweep !== 1) f.frequency.exponentialRampToValueAtTime(F(freq * sweep), t + dur);
    const g = ctx.createGain(); g.gain.value = 0; g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.min(vol, 1.5), t + att); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(dest || this.sfx); s.start(t, Math.random() * 2.5); s.stop(t + dur + 0.05);
    s.onended = () => { s.disconnect(); f.disconnect(); g.disconnect(); };
    return f;
  }
  /** gain node with an attack/hold/exp-release envelope, already connected to dest */
  _env(dest, t, peak, att, dur, hold = 0) {
    const g = ctx.createGain(); peak = clamp(fin(peak, 0.1), 0.0002, 1.5);
    dur = Math.max(0.02, dur); att = clamp(att, 0.001, dur * 0.9); hold = clamp(hold, 0, Math.max(0, dur - att - 0.01));
    g.gain.value = 0; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + att);
    if (hold > 0) g.gain.setValueAtTime(peak, t + att + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(dest); return g;
  }
  _osc(type, f, t, dur) { const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(F(f), t); o.start(t); o.stop(t + dur + 0.06); return o; }
  _src(buf, t, dur) { const s = ctx.createBufferSource(); s.buffer = this.bufs[buf] || this.bufs.white; s.loop = true; s.start(t, Math.random() * 2.5); s.stop(t + dur + 0.06); return s; }
  _filt(type, f, q = 1) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = F(f); b.Q.value = q; return b; }
  _shaper(hard) { const w = ctx.createWaveShaper(); w.curve = hard ? this.cHard : this.cSoft; return w; }
  _lfo(param, rate, depth, t, dur, type = 'sine') {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = clamp(fin(rate, 1), 0.01, 2000);
    const g = ctx.createGain(); g.gain.value = fin(depth, 0); o.connect(g); g.connect(param);
    o.start(t); if (dur) o.stop(t + dur + 0.1); return o;
  }
  /** a point around the listener: random azimuth, distance rMin..rMax, height offset hMin..hMax */
  _around(rMin, rMax, hMin = 0, hMax = 0) {
    const L = this.listener, a = Math.random() * Math.PI * 2, r = rnd(rMin, rMax);
    return { x: fin(L.x) + Math.cos(a) * r, y: fin(L.y) + rnd(hMin, hMax), z: fin(L.z) + Math.sin(a) * r };
  }
  _inCave(pos) {
    if (!pos) return this.space === 'cave' || this.envT.cave > 0.5;
    if (pos.cave !== undefined) return !!pos.cave;
    if (typeof this.caveTest === 'function') { try { return !!this.caveTest(pos); } catch (e) { /* game bug: ignore */ } }
    return this._inCave(null);
  }
  /** where a sound at pos lands for the listener.
      o: {life seconds the chain lives, nat (ambient bus), wet extra reverb, far extra valley send, noDelay, a (attenuation override)}
      returns {d: input node, a: attenuation 0..1, dist, dl: arrival delay} (a = 0: inaudible, play nothing) */
  _place(pos, range = 60, o = {}) {
    if (!pos) return { d: o.nat ? this.natBus : this.sfx, a: 1, dist: 0, dl: 0 };
    const L = this.listener || {};
    const px = fin(pos.x), py = fin(pos.y), pz = fin(pos.z);
    const dist = Math.hypot(px - fin(L.x), py - fin(L.y), pz - fin(L.z));
    range = Math.max(2, fin(range, 60));
    if (dist > range && o.a == null) return NONE;
    const ref = 0.6 + range * 0.05;
    let a = o.a != null ? clamp(fin(o.a, 1), 0, 1) : ref / (ref + dist) * (1 - sstep(range * 0.65, range, dist));
    const muff = this._inCave(null) !== this._inCave(pos);
    if (muff) a *= 0.4;
    if (a < 0.0015) return NONE;
    const t = ctx.currentTime, dl = o.noDelay || dist < 40 ? 0 : Math.min(dist / 343, 12);
    const nodes = [], inp = ctx.createGain(); nodes.push(inp);
    let node = inp;
    if (dl > 0) { const de = ctx.createDelay(dl + 0.2); de.delayTime.value = dl; node.connect(de); node = de; nodes.push(de); }
    let cut = clamp(19000 / (1 + dist / 45), 250, 19000); if (muff) cut = Math.min(cut, 380);
    if (cut < 17000) { const lp = this._filt('lowpass', cut, 0.5); node.connect(lp); node = lp; nodes.push(lp); }
    if (muff) { const lp2 = this._filt('lowpass', cut * 1.3, 0.6); node.connect(lp2); node = lp2; nodes.push(lp2); }
    const out = ctx.createGain(); nodes.push(out);
    if (dist > 0.25) {
      const p = ctx.createPanner(); p.panningModel = 'HRTF'; p.distanceModel = 'inverse'; p.refDistance = 1; p.maxDistance = 100000; p.rolloffFactor = 0;
      if (p.positionX) { p.positionX.value = px; p.positionY.value = py; p.positionZ.value = pz; } else p.setPosition(px, py, pz);
      node.connect(p); p.connect(out); nodes.push(p);
    } else node.connect(out);
    out.connect(o.nat ? this.natBus : this.mix);
    const w = ctx.createGain(); w.gain.value = clamp((0.06 + 0.5 * (1 - a) + (o.wet || 0)) * (muff ? 1.4 : 1), 0, 1.2);
    node.connect(w); w.connect(o.nat ? this.natRev : this.revIn); nodes.push(w);
    const far = sstep(50, 500, dist) * 0.7 + (o.far || 0);
    if (far > 0.02) { const fw = ctx.createGain(); fw.gain.value = far; node.connect(fw); fw.connect(this.revFar); nodes.push(fw); }
    this._addVoice({ nodes, out, end: t + dl + (o.life || 5) + 1, killed: false });
    return { d: inp, a, dist, dl };
  }
  /** _place for a sound method: null when there is nothing to play */
  _at(pos, range, life, o = {}) { if (!ctx) return null; o.life = life; const P = this._place(pos, range, o); return P.a > 0 ? P : null; }
  _addVoice(v) {
    while (this.nLive >= MAX_VOICES) {
      const old = this.voices.find((x) => !x.killed); if (!old) break;
      const t = ctx.currentTime; old.out.gain.setTargetAtTime(0, t, 0.02); old.killed = true; old.end = t + 0.25; this.nLive--;
    }
    this.voices.push(v); if (!v.killed) this.nLive++;
  }
  _voiceTick(t) {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.end > t) continue;
      for (const n of v.nodes) { try { n.disconnect(); } catch (e) { /* already gone */ } }
      if (!v.killed) this.nLive--;
      this.voices.splice(i, 1);
    }
  }
  /** cheap non-positional placement with a random stereo position (diffuse ambience) */
  _rpan(dest, spread = 0.85) {
    const p = ctx.createStereoPanner(); p.pan.value = rnd(-spread, spread); p.connect(dest || this.natBus);
    return p;
  }

  /* =========================================================== instruments */
  _tick(vol, d, dl = 0, f = 4000) { this.noise(0.01, vol, 'highpass', f, 1, 0, dl, d); this.tone(f * 0.55, 0.012, 'square', vol * 0.25, 0.0008, 0, dl, d); }
  /** wooden knock: resonant body + a short click */
  _knockW(f, vol, d, dl = 0, dur = 0.18) {
    this.tone(f, dur, 'sine', vol, 0.002, 0.92, dl, d); this.tone(f * 2.3, dur * 0.5, 'sine', vol * 0.35, 0.002, 0.95, dl, d);
    this.noise(0.03, vol * 0.7, 'bandpass', f * 4, 3, 0, dl, d);
  }
  _clack(f, vol, d, dl = 0) { this.noise(0.025, vol, 'bandpass', f, 4, 0, dl, d); this.tone(f * 0.6, 0.04, 'triangle', vol * 0.3, 0.001, 0.8, dl, d); }
  _clank(f, vol, d, dl = 0, dur = 0.3) {
    for (const [r, a] of [[1, 1], [2.76, 0.6], [5.4, 0.35], [8.9, 0.2]]) this.tone(f * r * rnd(0.985, 1.015), dur * (1.1 - r * 0.08), 'sine', vol * a * 0.5, 0.001, 0, dl, d);
    this.noise(0.03, vol * 0.8, 'bandpass', Math.min(f * 4, 9000), 1.2, 0, dl, d);
  }
  _thud(f, vol, d, dl = 0, dur = 0.35) { this.tone(f, dur, 'sine', vol, 0.003, 0.45, dl, d); this.noise(dur * 0.6, vol * 0.5, 'lowpass', 220, 0.7, 0.5, dl, d, 'brown'); }
  _twig(vol, d, dl = 0) {
    this.noise(0.012, vol, 'highpass', 2500, 1, 0, dl, d); this.noise(0.05, vol * 0.6, 'bandpass', rnd(1100, 1800), 3, 0.7, dl, d);
    this._tick(vol * 0.5, d, dl + rnd(0.01, 0.03), rnd(2500, 4000));
  }
  _crackle(dur, vol, d, dl = 0) {
    this.noise(dur, vol, 'bandpass', 3200, 0.6, 0, dl, d, 'crackle');
    for (let i = 0; i < 3; i++) this._tick(vol * 0.35, d, dl + Math.random() * dur * 0.7, rnd(2500, 6000));
  }
  /** a burst of leafy noise with an irregular amplitude (bush, branches) */
  _leafy(dur, vol, d, dl = 0, f = 2600) {
    if (!(vol >= 0.0003)) return; const t = this._t(dl);
    const s = this._src('pink', t, dur), bp = this._filt('bandpass', f, 0.8), g = ctx.createGain(); g.gain.value = 0; g.gain.setValueAtTime(0, t);
    for (let k = 0; k < dur; k += rnd(0.03, 0.09)) g.gain.setTargetAtTime(rnd(0.1, 1) * (1 - 0.6 * k / dur), t + k, 0.02);
    g.gain.setTargetAtTime(0, t + dur, 0.03);
    s.connect(bp); bp.connect(g); g.connect(this._env(d, t, vol, 0.02, dur + 0.15, dur * 0.8));
    this.noise(dur, vol * 0.8, 'highpass', 2000, 0.7, 0, dl, d, 'crackle', 0.02);
  }
  /** wing flaps: noise gated by a square LFO */
  _flap(dl, dur, rate, vol, d) {
    if (!(vol >= 0.0003)) return; const t = this._t(dl);
    const s = this._src('pink', t, dur), bp = this._filt('bandpass', rnd(700, 1200), 0.9), am = ctx.createGain(); am.gain.value = 0.5;
    const l = this._lfo(am.gain, rate, 0.5, t, dur, 'square'); l.frequency.linearRampToValueAtTime(rate * 1.3, t + dur);
    s.connect(bp); bp.connect(am); am.connect(this._env(d, t, vol, 0.02, dur, dur * 0.4));
  }
  _hiss(dur, vol, d, dl = 0, f = 3500) { this.noise(dur, vol, 'highpass', f, 0.7, 0.7, dl, d, 'white', Math.min(0.04, dur * 0.2)); }
  _creak(dur, vol, d, dl = 0, f = 800) {
    if (!(vol >= 0.0003)) return; const t = this._t(dl);
    const o = this._osc('sawtooth', rnd(16, 28), t, dur);
    o.frequency.linearRampToValueAtTime(rnd(30, 70), t + dur * 0.5); o.frequency.linearRampToValueAtTime(rnd(10, 22), t + dur);
    const g = this._env(d, t, vol * 4, dur * 0.2, dur, dur * 0.5);
    for (const [m, q] of [[1, 12], [2.3, 14]]) { const b = this._filt('bandpass', f * m, q); o.connect(b); b.connect(g); }
  }
  _whisper(dur, vol, d, dl = 0, inhale = false) {
    if (!(vol >= 0.0003)) return; const t = this._t(dl);
    const s = this._src('white', t, dur), hp = this._filt('highpass', 700, 0.7), ws = this._shaper(false);
    const g = this._env(d, t, vol, dur * (inhale ? 0.7 : 0.35), dur, dur * 0.2);
    s.connect(hp);
    for (const [lo, hi, q] of [[1100, 2400, 6], [2400, 4500, 8]]) {
      const f = this._filt('bandpass', rnd(lo, hi), q); hp.connect(f); f.connect(ws);
      for (let k = 0; k < dur; k += 0.08) f.frequency.setTargetAtTime(F(inhale ? lo + (hi - lo) * (k / dur) : rnd(lo, hi)), t + k, 0.03);
    }
    const pre = ctx.createGain(); pre.gain.value = 3; ws.connect(pre); pre.connect(g);
  }
  _roar(base, dur, vol, d, dl = 0, fall = 1) {
    if (!(vol >= 0.0003)) return; const t = this._t(dl);
    const g = this._env(d, t, vol, 0.15, dur, dur * 0.45), ws = this._shaper(true);
    const lp = this._filt('lowpass', base * 6, 3);
    lp.frequency.setValueAtTime(F(base * 5), t); lp.frequency.linearRampToValueAtTime(F(base * 14), t + dur * 0.3); lp.frequency.exponentialRampToValueAtTime(F(base * 4), t + dur);
    ws.connect(lp); lp.connect(g);
    [1, 1.51, 2.02].forEach((m, i) => {
      const o = this._osc('sawtooth', base * m, t, dur); if (fall !== 1) o.frequency.exponentialRampToValueAtTime(F(base * m * fall), t + dur);
      if (i === 0) this._lfo(o.frequency, 23, base * 0.15, t, dur);
      const og = ctx.createGain(); og.gain.value = 0.35; o.connect(og); og.connect(ws);
    });
    const ns = this._src('brown', t, dur), nf = this._filt('bandpass', base * 10, 3);
    nf.frequency.setValueAtTime(F(base * 9), t); nf.frequency.linearRampToValueAtTime(F(base * 18), t + dur * 0.3); nf.frequency.exponentialRampToValueAtTime(F(base * 7), t + dur);
    const ng = ctx.createGain(); ng.gain.value = 2; ns.connect(nf); nf.connect(ng); ng.connect(g);
  }
  _shriek(f0, f1, dur, vol, d, dl = 0) {
    if (!(vol >= 0.0003)) return; const t = this._t(dl);
    const g = this._env(d, t, vol, 0.03, dur, dur * 0.3), ws = this._shaper(false);
    const bp = this._filt('bandpass', (f0 + f1) * 0.8, 2); bp.frequency.setValueAtTime(F(f0 * 1.5), t); bp.frequency.exponentialRampToValueAtTime(F(f1 * 1.5), t + dur * 0.7);
    ws.connect(bp); bp.connect(g);
    for (const m of [1, 1.06, 0.5]) {
      const o = this._osc('sawtooth', f0 * m, t, dur); o.frequency.exponentialRampToValueAtTime(F(f1 * m), t + dur * 0.7);
      this._lfo(o.frequency, 9 + m * 3, f0 * m * 0.03, t, dur); const og = ctx.createGain(); og.gain.value = m === 0.5 ? 0.4 : 0.5; o.connect(og); og.connect(ws);
    }
    this.noise(dur, vol * 0.5, 'bandpass', f0 * 2, 3, f1 / f0, dl, d);
  }
  /** a growl: saws through distortion, a lowpass and a rough amplitude flutter */
  _growl(dl, dur, f, vol, d, rough = 22) {
    if (!(vol >= 0.0003)) return; const t = this._t(dl);
    const ws = this._shaper(true), lp = this._filt('lowpass', f * 9, 1.2), am = ctx.createGain(); am.gain.value = 0.6;
    this._lfo(am.gain, rough * rnd(0.85, 1.15), 0.4, t, dur);
    for (const [m, v] of [[1, 0.5], [1.49, 0.25], [0.5, 0.35]]) { const o = this._osc('sawtooth', f * m * rnd(0.98, 1.02), t, dur); o.frequency.linearRampToValueAtTime(F(f * m * rnd(0.85, 1.1)), t + dur); const og = this._G(v, ws); o.connect(og); }
    ws.connect(lp); lp.connect(am); am.connect(this._env(d, t, vol, Math.min(0.15, dur * 0.2), dur, dur * 0.5));
    this.noise(dur, vol * 0.3, 'bandpass', f * 6, 2, 0.8, dl, d, 'brown', dur * 0.2);
  }
  /** a sustained voiced cry. pts [[sec, Hz]...] pitch path; vw [[sec, vowel]...] formant path.
      o: {vib (fraction), vibRate, rough 0..1, breath, fs formant scale, det [cents], type, att, hold} */
  _cry(dl, dur, pts, vw, vol, d, o = {}) {
    if (!(vol >= 0.0003)) return; const t = this._t(dl);
    dur = Math.max(0.05, dur);
    const g = this._env(d, t, vol, Math.min(o.att ?? 0.05, dur * 0.5), dur, dur * (o.hold ?? 0.55));
    const pre = ctx.createGain(); pre.gain.value = 1;
    let node = pre;
    if (o.rough) { const ws = this._shaper(o.rough > 0.5), pg = this._G(1 + 3 * o.rough); pre.connect(pg); pg.connect(ws); node = ws; }
    const fs = o.fs || 1, v0 = VOWELS[vw[0][1]] || VOWELS.a;
    const fl = [[8, 2.6], [10, 1.7], [12, 1.0]].map(([q, gg], j) => { const f = this._filt('bandpass', v0[j] * fs, q), fg = this._G(gg, g); node.connect(f); f.connect(fg); return f; });
    const body = this._filt('lowpass', 900, 0.7); node.connect(body); body.connect(this._G(0.12, g));
    for (const [tt, vk] of vw.slice(1)) { const v = VOWELS[vk] || VOWELS.a; fl.forEach((f, j) => f.frequency.setTargetAtTime(F(v[j] * fs), t + Math.min(tt, dur), 0.08)); }
    const dets = o.det || [0, 8];
    for (const c of dets) {
      const os = this._osc(o.type || 'sawtooth', pts[0][1], t, dur); os.detune.value = c;
      let last = 0;
      for (const [tt, f] of pts.slice(1)) { const at = Math.max(last + 0.01, Math.min(tt, dur)); os.frequency.exponentialRampToValueAtTime(F(f), t + at); last = at; }
      if (o.vib) this._lfo(os.frequency, (o.vibRate || 5.5) * rnd(0.95, 1.05), pts[0][1] * o.vib, t, dur);
      os.connect(this._G(1 / dets.length, pre));
    }
    if (o.breath) { const s = this._src('white', t, dur), bp = this._filt('bandpass', 2500, 0.7); s.connect(bp); bp.connect(this._G(o.breath, pre)); }
  }
  /** formant voice speaking syllables. o: {syl, lens?, sd, base, dest, delay, vol, fs, breath, rough, whisper, vib, vibRate, contour(i,n,s)->mult, pauseK}
      returns the duration */
  _voice(o) {
    const syl = o.syl, n = syl.length; if (!n) return 0;
    const lens = o.lens || syl.map(() => (o.sd || 0.18) * rnd(0.85, 1.2)), pk = o.pauseK || 1;
    let total = 0; syl.forEach((s, i) => { total += lens[i] + s.pause * pk; }); total += 0.1;
    if (!ctx) return total;
    const t0 = this._t(o.delay || 0) + 0.005, T = total + 0.25;
    const out = this._G(o.vol || 0.1, o.dest || this.sfx);
    const env = ctx.createGain(); env.gain.value = 0; env.gain.setValueAtTime(0, t0); env.connect(out);
    const pre = ctx.createGain(); pre.gain.value = 1; let node = pre;
    if (o.rough) { const ws = this._shaper(o.rough > 0.5), pg = this._G(1 + 3 * o.rough); pre.connect(pg); pg.connect(ws); node = ws; }
    const fs = o.fs || 1;
    const fl = [[7, 2.4], [10, 1.5], [12, 0.8]].map(([q, gg]) => { const f = this._filt('bandpass', 800, q), fg = this._G(gg * (o.whisper ? 2.5 : 1), env); node.connect(f); f.connect(fg); return f; });
    let osc = [];
    if (!o.whisper) {
      osc = [this._osc('sawtooth', o.base, t0, T), this._osc('sawtooth', o.base * 1.004, t0, T)];
      osc.forEach((os, i) => { os.connect(this._G(i ? 0.35 : 0.65, pre)); if (o.vib) this._lfo(os.frequency, o.vibRate || 5, o.base * o.vib, t0, T, o.vibType || 'sine'); });
    }
    const nz = this._src('white', t0, T), nh = this._filt('highpass', o.whisper ? 400 : 1200, 0.7);
    nz.connect(nh); nh.connect(this._G(o.whisper ? 1 : (o.breath || 0.08), pre));
    let ts = t0;
    syl.forEach((s, i) => {
      const sd = lens[i], v = VOWELS[s.v] || VOWELS.x;
      fl.forEach((f, j) => f.frequency.setTargetAtTime(F(v[j] * fs), ts, 0.02));
      const p0 = o.base * (o.contour ? o.contour(i, n, s) : 1) * rnd(0.97, 1.03), p1 = p0 * (s.end === '?' ? 1.25 : rnd(0.93, 1.03));
      for (const [os, m] of osc.map((x, k) => [x, k ? 1.004 : 1])) { os.frequency.setValueAtTime(F(p0 * m), ts); os.frequency.exponentialRampToValueAtTime(F(p1 * m), ts + sd * 0.85); }
      let on = ts;
      if (s.c === 'f') { this.noise(0.07, (o.vol || 0.1) * (o.whisper ? 1.6 : 0.8), 'highpass', 3200, 0.8, 0, ts - ctx.currentTime, o.dest || this.sfx); on += 0.05; }
      else if (s.c === 'p') { this.noise(0.015, (o.vol || 0.1) * 1.2, 'bandpass', 1800, 1, 0, ts - ctx.currentTime, o.dest || this.sfx); on += 0.02; }
      env.gain.setTargetAtTime(s.end === '!' ? 1.3 : 1, on, 0.012); env.gain.setTargetAtTime(0, ts + sd * 0.78, 0.02);
      ts += sd + s.pause * pk;
    });
    setTimeout(() => { try { out.disconnect(); } catch (e) { /* gone */ } }, (T + 25) * 1000);
    return total;
  }
  _bowed(f, dur, vol, d, dl = 0) {
    if (!(vol >= 0.0003)) return; const t = this._t(dl);
    const g = this._env(d, t, vol * 2.2, dur * 0.35, dur, dur * 0.25), lp = this._filt('lowpass', f * 5, 0.8), bp = this._filt('peaking', f * 3, 2); bp.gain.value = 6; lp.connect(bp); bp.connect(g);
    for (const m of [1, 1.004]) { const o = this._osc('sawtooth', f * m, t, dur); this._lfo(o.frequency, 4.8, f * 0.006, t, dur); o.connect(lp); }
  }
  /** string section: detuned saws, optional tremolo */
  _strings(midis, dur, vol, dl, dest, trem = 0, att = 0.4) {
    if (!(vol >= 0.0003)) return; const t = this._t(dl);
    const g = this._env(dest, t, vol, att, dur, dur * 0.5), lp = this._filt('lowpass', 1800, 0.7);
    let node = lp; if (trem) { const am = this._G(0.6); this._lfo(am.gain, trem, 0.4, t, dur); lp.connect(am); node = am; } node.connect(g);
    for (const m of midis) for (const c of [-9, 9]) { const o = this._osc('sawtooth', NOTE(m), t, dur); o.detune.value = c; o.connect(lp); }
  }
  _bass(f, dur, vol, dl, dest) {
    if (!(vol >= 0.0003)) return; const t = this._t(dl);
    const o = this._osc('sawtooth', f, t, dur), ws = this._shaper(true), lp = this._filt('lowpass', 900, 3);
    lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(200, t + dur);
    o.connect(ws); ws.connect(lp); lp.connect(this._env(dest, t, vol, 0.004, dur, dur * 0.3));
  }
  _tom(f, vol, dl, dest) {
    this.tone(f * 1.6, 0.5, 'sine', vol, 0.003, 0.5, dl, dest); this.tone(f * 2.6, 0.08, 'triangle', vol * 0.15, 0.002, 0.6, dl, dest);
    this.noise(0.14, vol * 0.4, 'lowpass', 500, 0.7, 0.5, dl, dest, 'brown');
  }
  _brass(midis, dur, vol, dl, dest, att = 0.25) {
    if (!(vol >= 0.0003)) return; const t = this._t(dl);
    const lp = this._filt('lowpass', 200, 1); lp.frequency.setValueAtTime(200, t); lp.frequency.linearRampToValueAtTime(1800, t + att); lp.frequency.exponentialRampToValueAtTime(380, t + dur);
    lp.connect(this._env(dest, t, vol, att, dur, dur * 0.35));
    for (const m of midis) for (const c of [-7, 7]) { const o = this._osc('sawtooth', NOTE(m), t, dur); o.detune.value = c; o.connect(lp); }
  }
  _boom(vol, d, dl = 0) {
    this.tone(60, 1.6, 'sine', vol * 0.8, 0.005, 0.4, dl, d);
    this.noise(1.9, vol, 'lowpass', 700, 0.7, 0.15, dl, d, 'brown');
    this.noise(0.45, vol * 0.5, 'bandpass', 1500, 0.8, 0.3, dl, d);
  }
  _bell(f, dur, vol, dl = 0, dest = null, parts = null) {
    for (const [r, a, k] of parts || [[1, 1, 1], [2.76, 0.45, 0.55], [5.4, 0.22, 0.3], [8.93, 0.1, 0.18]]) this.tone(f * r, dur * k, 'sine', vol * a, 0.002, 0, dl, dest);
  }
  _glass(f, dur, vol, dl = 0, dest = null, att = 0.12) {
    for (const [r, a, k] of [[1, 1, 1], [2.32, 0.32, 0.7], [4.25, 0.12, 0.45]]) this.tone(f * r, dur * k, 'sine', vol * a, att * k, 0, dl, dest);
    this.tone(f * 1.0025, dur, 'sine', vol * 0.5, att, 0, dl, dest);
  }
  _piano(f, dur, vol, dl = 0, dest = null) {
    this.tone(f, dur, 'triangle', vol * 0.7, 0.004, 0, dl, dest); this.tone(f * 2.003, dur * 0.5, 'sine', vol * 0.3, 0.003, 0, dl, dest);
    this.tone(f * 3.01, dur * 0.25, 'sine', vol * 0.12, 0.002, 0, dl, dest); this.noise(0.03, vol * 0.12, 'bandpass', Math.min(f * 4, 8000), 1, 0, dl, dest);
  }
  /** a tone that swells and cuts off, like a note played backwards */
  _rev(f, dur, vol, dl = 0, dest = null, type = 'sine') {
    if (!ctx || !(vol >= 0.0003)) return; const t = this._t(dl);
    const g = ctx.createGain(); g.gain.value = 0; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.min(vol, 1), t + dur); g.gain.linearRampToValueAtTime(0, t + dur + 0.025);
    g.connect(dest || this.sfx);
    const o = this._osc(type, f, t, dur), o2 = this._osc('sine', f * 2, t, dur), g2 = this._G(0.3, g);
    o.connect(g); o2.connect(g2);
  }
  _pad(freq, dur, vol, dl = 0, dest = null, o = {}) {
    if (!ctx || !(vol > 0.0003)) return; const t = this._t(dl);
    dur = Math.max(0.1, dur); const att = clamp(o.att ?? 1, 0.01, dur * 0.8), rel = clamp(o.rel ?? 1.5, 0.01, dur - att), v = Math.min(vol, 1);
    const lp = this._filt('lowpass', o.cut || 1200, 0.6), g = ctx.createGain();
    g.gain.value = 0; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + att); g.gain.setValueAtTime(v, t + dur - rel); g.gain.linearRampToValueAtTime(0, t + dur);
    lp.connect(g); g.connect(dest || this.music);
    const det = o.det ?? 7;
    for (const c of [-det, det]) { const s = this._osc(o.type || 'triangle', freq, t, dur); s.detune.value = c; s.connect(lp); }
  }
  /** corruption insert for animal sounds: ring modulation, a gated stutter delay, grit. returns the input node */
  _corrupt(dest, c, life) {
    if (c < 0.02) return dest;
    const t = ctx.currentTime, inp = ctx.createGain();
    inp.connect(this._G(1 - 0.45 * c, dest));
    const rm = ctx.createGain(); rm.gain.value = 0; const car = this._osc('sine', rnd(30, 70) * (1 + c), t, life); car.connect(rm.gain);
    inp.connect(rm); rm.connect(this._G(1.1 * c, dest));
    if (c > 0.25) {
      const gate = this._G(0.5), de = ctx.createDelay(1), fb = this._G(0.25 + 0.35 * c);
      this._lfo(gate.gain, rnd(3, 7), 0.5, t, life, 'square');
      de.delayTime.value = rnd(0.07, 0.16); inp.connect(gate); gate.connect(de); de.connect(fb); fb.connect(de); de.connect(this._G(0.7 * c, dest));
    }
    if (c > 0.5) { const ws = this._shaper(true); inp.connect(ws); ws.connect(this._G(0.3 * (c - 0.4), dest)); }
    return inp;
  }

  /* =========================================================== beds (continuous layers) */
  _buildBed(name) {
    const t = ctx.currentTime, out = ctx.createGain(); out.gain.value = 0; out.connect(this.amb);
    const N = (buf, type, f, q, g, to = out) => {
      const s = ctx.createBufferSource(); s.buffer = this.bufs[buf]; s.loop = true;
      const fl = this._filt(type, f, q), gg = this._G(g, to);
      s.connect(fl); fl.connect(gg); s.start(t, Math.random() * 2.5); return { s, fl, gg };
    };
    const O = (type, f, g, to = out) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; const gg = this._G(g, to); o.connect(gg); o.start(t); return { o, gg }; };
    const b = { out, sent: -1 };
    switch (name) {
      case 'wind': b.body = N('brown', 'bandpass', 380, 0.8, 2.2); b.pines = N('pink', 'bandpass', 1200, 0.7, 0.7); b.whistle = N('white', 'bandpass', 900, 9, 0.25); break;
      case 'leaves': b.a = N('crackle', 'highpass', 2200, 0.6, 1.4); b.b = N('pink', 'bandpass', 3800, 1.2, 0.3); break;
      case 'rain': N('white', 'highpass', 2200, 0.5, 0.35); N('white', 'bandpass', 5500, 0.8, 0.25); N('brown', 'lowpass', 350, 0.6, 0.5); N('crackle', 'highpass', 1500, 0.5, 0.9); break;
      case 'creek':
        b.pan = [-0.75, 0, 0.75].map((p) => { const sp = ctx.createStereoPanner(); sp.pan.value = p; sp.connect(out); return sp; });
        b.l = [N('pink', 'bandpass', 500, 1.2, 0.8, b.pan[0]), N('white', 'bandpass', 1400, 2, 0.3, b.pan[1]), N('white', 'bandpass', 3200, 1.5, 0.12, b.pan[2])]; break;
      case 'ocean': b.low = N('brown', 'lowpass', 300, 0.7, 0.3); b.wash = N('white', 'bandpass', 1400, 0.5, 0.06); break;
      case 'fire': b.crk = N('crackle', 'bandpass', 2600, 0.7, 1.6); b.roar = N('brown', 'lowpass', 220, 0.7, 0.8); N('white', 'highpass', 4000, 0.5, 0.03); break;
      case 'menace': { O('sine', 34.6, 0.5); O('sine', 35.3, 0.5); const lp = this._filt('lowpass', 160, 0.7); lp.connect(out); O('triangle', 51.9, 0.15, lp); b.rum = N('brown', 'lowpass', 70, 0.7, 1.2); break; }
      case 'cave': N('brown', 'lowpass', 90, 0.7, 1.4); b.air = N('pink', 'bandpass', 260, 2, 0.3); break;
      case 'underwater': N('brown', 'lowpass', 220, 0.7, 1.6); b.air = N('pink', 'lowpass', 600, 0.7, 0.2); break;
      case 'insects':
        for (const [f, r1, r2] of [[4400, 27, 2.1], [5300, 33, 1.3], [3900, 19, 0.7]]) {
          const slow = this._G(0.5, out); this._lfo(slow.gain, r2 * rnd(0.9, 1.1), 0.5, t, 0, 'square');
          const x = N('white', 'bandpass', f, 14, 1.1, slow); this._lfo(x.gg.gain, r1, 1.1, t, 0);
        }
        break;
      case 'room': N('brown', 'lowpass', 110, 0.7, 1); break;
    }
    return b;
  }
  /** desired level 0..1 of every bed from the smoothed environment */
  _bedLevels() {
    const E = this.envL, S = E.silence, open = (1 - E.cave) * (1 - E.underwater);
    const windAmt = clamp(E.wind * (0.5 + 0.5 * this.gust) + E.storm * 0.5 + E.height * 0.3, 0, 1.3);
    return {
      wind: windAmt * (1 - 0.95 * S) * (1 - 0.8 * E.cave) * (1 - 0.7 * E.underwater),
      leaves: E.wind * (0.3 + 0.7 * this.gust) * (1 - E.height) * open * (1 - S),
      rain: Math.max(E.rain, E.storm) * (1 - 0.6 * S) * (1 - 0.8 * E.cave) * (1 - 0.7 * E.underwater),
      creek: E.water * (1 - 0.5 * S) * (1 - 0.6 * E.underwater),
      ocean: E.ocean * (1 - 0.4 * S),
      fire: E.fire,
      menace: E.menace,
      cave: E.cave,
      underwater: E.underwater,
      insects: clamp((E.dusk * 0.7 + E.night) * open * (1 - S) * (1 - 0.8 * Math.max(E.rain, E.storm)) * (1 - 0.8 * E.height), 0, 1),
      room: clamp(fin(this.roomTone, 1), 0, 1),
    };
  }
  _bedTick(t, dt) {
    const lv = this._bedLevels();
    for (const k in lv) {
      const v = lv[k]; let b = this.beds[k];
      if (!b) { if (v < 0.001) continue; b = this.beds[k] = this._buildBed(k); }
      if (Math.abs(v - b.sent) > 0.004 || (v === 0 && b.sent !== 0)) { b.out.gain.setTargetAtTime(v * BEDS[k], t, k === 'insects' ? 0.3 : 0.12); b.sent = v; }
    }
    // slow modulation of the bed colours, ten times a second
    this._every('bedmod', dt, () => 0.1, () => {
      const E = this.envL, g = this.gust, dark = clamp(E.dusk * 0.6 + E.night, 0, 1), B = this.beds;
      if (B.wind) {
        const w = B.wind;
        w.body.fl.frequency.setTargetAtTime((320 + 160 * g) * (1 - 0.3 * dark) * (1 - 0.3 * E.height), t, 0.6);
        w.pines.fl.frequency.setTargetAtTime(1000 + 700 * g - 350 * dark, t, 0.6);
        w.pines.gg.gain.setTargetAtTime(0.7 * (1 - 0.7 * E.height) * (0.35 + 0.65 * g) * (1 - 0.4 * dark), t, 0.5);
        w.body.gg.gain.setTargetAtTime(2.2 * (1 - 0.5 * E.height), t, 0.5);
        w.whistle.gg.gain.setTargetAtTime((0.04 + 0.9 * E.height + 0.4 * E.storm + 0.15 * dark) * (0.3 + 0.7 * g) * 0.25, t, 0.5);
        w.whistle.fl.frequency.setTargetAtTime(500 + 900 * E.height + 500 * g - 150 * dark, t, 0.8);
      }
      if (B.creek && Math.random() < 0.6) B.creek.l.forEach((x, i) => { x.gg.gain.setTargetAtTime([0.8, 0.3, 0.12][i] * rnd(0.5, 1.4), t, 0.08); x.fl.frequency.setTargetAtTime([500, 1400, 3200][i] * rnd(0.8, 1.25), t, 0.1); });
      if (B.fire) { B.fire.roar.gg.gain.setTargetAtTime(rnd(0.4, 1.1), t, 0.1); B.fire.crk.gg.gain.setTargetAtTime(rnd(0.8, 2.2), t, 0.05); }
      if (B.cave && Math.random() < 0.2) B.cave.air.gg.gain.setTargetAtTime(rnd(0.1, 0.45), t, 1.5);
      if (B.menace && Math.random() < 0.15) B.menace.rum.gg.gain.setTargetAtTime(rnd(0.5, 1.8), t, 2);
      if (B.underwater && Math.random() < 0.2) B.underwater.air.gg.gain.setTargetAtTime(rnd(0.05, 0.35), t, 0.8);
    });
  }
  /** one surf wave on the ocean bed: swell, break, recede */
  _wave(lvl) {
    const b = this.beds.ocean; if (!b) return;
    const t = ctx.currentTime, rise = rnd(2, 3.5), fall = rnd(3, 5), pk = rnd(0.6, 1);
    b.low.gg.gain.setTargetAtTime(0.4 + 1.2 * pk, t, rise * 0.45); b.low.gg.gain.setTargetAtTime(0.25, t + rise, fall * 0.4);
    b.wash.gg.gain.setTargetAtTime(0.05, t, 0.5); b.wash.gg.gain.setTargetAtTime(0.35 * pk, t + rise - 0.3, 0.15); b.wash.gg.gain.setTargetAtTime(0.03, t + rise + 0.6, fall * 0.35);
    b.wash.fl.frequency.setTargetAtTime(900, t, 1); b.wash.fl.frequency.setTargetAtTime(2200, t + rise - 0.3, 0.2); b.wash.fl.frequency.setTargetAtTime(1200, t + rise + 0.5, 1.5);
    this.noise(fall, 0.05 * lvl, 'highpass', 3000, 0.7, 0.6, rise + 0.3, this._rpan(this.amb, 0.6), 'crackle', 0.4); // foam fizz
  }

  /* =========================================================== per frame */
  update(dt) {
    dt = clamp(fin(dt, 0.016), 0, 0.25);
    this.clock += dt;
    if (!ctx) return;
    const t = ctx.currentTime;
    this._syncListener();
    // environment smoothing + gusts
    for (const k in this.envT) {
      const r = ENV_RATE[k] || [0.5, 0.5], d = this.envT[k] - this.envL[k];
      this.envL[k] = clamp(this.envL[k] + clamp(d, -r[1] * dt, r[0] * dt), 0, 1);
    }
    if (this.clock > this.gustNext) { this.gustT = Math.random() < 0.15 ? rnd(0.8, 1) : Math.pow(Math.random(), 1.5) * 0.8; this.gustNext = this.clock + rnd(1.5, 7); }
    this.gust += (this.gustT - this.gust) * Math.min(1, dt * 0.7);
    const E = this.envL;
    const nat = (1 - E.silence) * (1 - 0.8 * E.underwater);
    if (Math.abs(nat - this.natSent) > 0.005) { this.natBus.gain.setTargetAtTime(nat, t, 0.15); this.natRev.gain.setTargetAtTime(nat, t, 0.15); this.natSent = nat; }
    const uwf = E.underwater > 0.002 ? lerp(20000, 360, Math.sqrt(E.underwater)) : 20000;
    if (Math.abs(uwf - this.uwSent) > 5) { this.uw.frequency.setTargetAtTime(uwf, t, 0.08); this.uwSent = uwf; }
    this._bedTick(t, dt);
    this._ambience(dt);
    // music
    const up = this.tension > this.tensionLvl ? 0.6 : 0.15;
    this.tensionLvl = clamp(this.tensionLvl + clamp(this.tension - this.tensionLvl, -up * dt, up * dt), 0, 1);
    this.chaseLvl = clamp(this.chaseLvl + (this.chase ? dt * 2 : -dt * 0.4), 0, 1);
    this._tensionTick(t, dt); this._chaseTick(t); this._styleTick(t);
    // body: heartbeat, panting, calm breathing in silence
    const hbI = this.clock - this.hbAt < 0.5 ? this.hb : 0;
    if (hbI > 0.04 && !this.dead) {
      if (!this.hbNext || this.hbNext < t - 0.5) this.hbNext = t + 0.05;
      while (this.hbNext < t + 0.12) { this._beat(hbI, this.hbNext - t); this.hbNext += 60 / (55 + 95 * hbI); }
    } else this.hbNext = 0;
    const live = this.clock - this.brAt < 0.5 && !this.dead;
    const ex = live ? clamp((0.55 - this.stam) / 0.55, 0, 1) : 0, calm = live && ex <= 0.03 ? E.silence : 0;
    if (ex > 0.03 || calm > 0.3) {
      if (!this.brNext || this.brNext < t - 0.5) this.brNext = t + 0.05;
      while (this.brNext < t + 0.12) { const p = ex > 0.03 ? 1.9 - 1.15 * ex : 3.8; this._breathCycle(ex > 0.03 ? ex : 0, p, this.brNext - t, calm); this.brNext += p; }
    } else this.brNext = 0;
    // helicopter + cockpit alarm
    if (this.heli) this._heliTick(t);
    if (this.heliAl) {
      if (!this.alNext || this.alNext < t - 0.5) this.alNext = t + 0.02;
      while (this.alNext < t + 0.15) { const dl = this.alNext - t; for (let i = 0; i < 4; i++) this.tone(i % 2 ? 1250 : 940, 0.12, 'square', 0.035, 0.004, 1, dl + i * 0.13, this._alarmBus()); this.alNext += 1.2; }
    } else this.alNext = 0;
    this._voiceTick(t);
  }
  _alarmBus() { if (!this.alBus) { this.alBus = this._filt('lowpass', 2400, 0.7); this.alBus.connect(this.sfx); } return this.alBus; }
  _every(key, dt, interval, fn) {
    if (this.timers[key] === undefined) this.timers[key] = Math.random() * interval();
    this.timers[key] -= dt;
    if (this.timers[key] <= 0) { this.timers[key] = Math.max(0.05, interval()); fn(); }
  }
  _beat(i, dl) {
    const d = this.mix;
    this.tone(52, 0.14, 'sine', 0.06 + 0.3 * i, 0.004, 0.6, dl, d); this.noise(0.08, 0.1 * i, 'lowpass', 150, 0.7, 0, dl, d, 'brown');
    this.tone(46, 0.16, 'sine', 0.04 + 0.22 * i, 0.004, 0.6, dl + 0.22 - 0.06 * i, d);
  }
  _breathCycle(ex, p, dl, calm = 0) {
    const d = this.mix, v = ex > 0 ? 0.025 + 0.1 * ex : 0.012 * calm;
    this.noise(p * 0.38, v, 'bandpass', 1300, 1.4, 1.25, dl, d, 'pink', p * 0.2);
    this.noise(p * 0.45, v * 1.2, 'bandpass', 900, 1.2, 0.7, dl + p * 0.42, d, 'pink', 0.05);
    if (ex > 0.6) this.noise(p * 0.3, v * 0.6, 'bandpass', 480, 5, 0.9, dl + p * 0.46, d, 'pink', 0.03);
  }

  /* =========================================================== ambience generators */
  _ambience(dt) {
    const E = this.envL, S = E.silence, open = (1 - E.cave) * (1 - S) * (1 - E.underwater), busy = this.nLive > AMB_VOICES;
    const wet = Math.max(E.rain, E.storm);
    const birds = clamp(E.daylight * (1 - 0.75 * E.dusk) * (1 - E.night) * (1 - 0.7 * wet) * (1 - 0.6 * E.height) * open, 0, 1);
    this._every('bird', dt, () => rnd(0.5, 3) / Math.max(0.08, birds), () => { if (birds > 0.05 && !busy) this._ambientBird(birds); });
    this._every('crow', dt, () => rnd(18, 50), () => { if (birds > 0.1 && !busy && Math.random() < 0.6) { const P = this._place(this._around(90, 260, 10, 30), 400, { nat: true, life: 3 }); if (P.a > 0) this._crowCaws(0, (2 + Math.random() * 3) | 0, 0.25 * P.a, P.d, { p: rnd(0.9, 1.1), fs: 1, len: 1 }); } });
    this._every('woodpecker', dt, () => rnd(25, 70), () => { if (birds > 0.2 && !busy && Math.random() < 0.6) this._woodpecker(this._around(80, 220, 4, 12)); });
    const owl = clamp((E.dusk * 0.8 + E.night * 0.6) * open * (1 - 0.5 * wet), 0, 1);
    this._every('owl', dt, () => rnd(14, 40), () => { if (owl > 0.1 && !busy && Math.random() < owl) { const P = this._place(this._around(40, 140, 6, 16), 400, { nat: true, life: 4 }); if (P.a > 0) this._hoot(0, 0.22 * P.a, P.d, { p: rnd(0.9, 1.1), fs: 1, len: 1 }); } });
    const crick = clamp((E.dusk * 0.7 + E.night) * open * (1 - 0.8 * wet) * (1 - 0.8 * E.height), 0, 1);
    this._every('cricket', dt, () => rnd(0.3, 0.9) / Math.max(0.1, crick), () => { if (crick > 0.05 && !busy) this._cricket(crick); });
    const frog = clamp(E.water * (E.dusk * 0.6 + E.night) * open, 0, 1);
    this._every('frog', dt, () => rnd(0.4, 1.8) / Math.max(0.1, frog), () => { if (frog > 0.05 && !busy) this._frog(frog); });
    this._every('distant', dt, () => rnd(35, 110), () => { if (E.night * open > 0.3 && !busy && Math.random() < 0.75) this._distantThing(); });
    this._every('trunk', dt, () => rnd(8, 25), () => { const w = E.wind * open * (1 - E.height); if (w > 0.15 && !busy && Math.random() < w + 0.2) { const P = this._place(this._around(10, 45, 3, 9), 90, { nat: true, life: 3 }); if (P.a > 0) this._creak(rnd(0.8, 2), 0.05 * P.a, P.d, 0, rnd(250, 600)); } });
    this._every('critter', dt, () => rnd(8, 25), () => { if (E.daylight * open > 0.3 && !busy && Math.random() < 0.6) { const P = this._place(this._around(5, 20, -1.4, -1), 40, { nat: true, life: 2 }); if (P.a > 0) this._leafy(rnd(0.15, 0.6), 0.06 * P.a, P.d, 0, rnd(2000, 3500)); } });
    this._every('twig', dt, () => rnd(20, 60), () => { if (open > 0.5 && !busy && Math.random() < 0.5) { const P = this._place(this._around(25, 90, -1, 6), 160, { nat: true, life: 2 }); if (P.a > 0) this._twig(0.15 * P.a, P.d); } });
    this._every('babble', dt, () => rnd(0.04, 0.3) / Math.max(0.1, E.water), () => {
      const b = this.beds.creek; if (E.water < 0.05 || !b) return; const v = 0.035 * E.water * (1 - 0.5 * S);
      this.tone(rnd(300, 1300), rnd(0.03, 0.09), 'sine', v, 0.004, rnd(1.4, 2.6), 0, pick(b.pan));
    });
    this._every('drip', dt, () => rnd(0.1, 1.2), () => {
      if (wet > 0.15 && E.cave < 0.5)this.tone(rnd(1800, 4000), 0.03, 'sine', 0.02 * wet, 0.001, rnd(0.6, 0.9), 0, this._rpan(this.amb));
      if (E.cave > 0.3 && Math.random() < 0.35 && !busy) { const p = this._around(3, 25, 1, 5); p.cave = this._inCave(null); const P = this._place(p, 60, { life: 3, wet: 0.5 }); if (P.a > 0) { const f = rnd(900, 2400); this.tone(f, 0.1, 'sine', 0.06 * P.a, 0.001, rnd(1.3, 1.8), 0, P.d); this.noise(0.01, 0.03 * P.a, 'highpass', 4000, 1, 0, 0, P.d); } }
    });
    this._every('thunder', dt, () => rnd(14, 45) / Math.max(0.2, E.storm), () => { if (E.storm > 0.3) this.thunder(rnd(0.15, 1)); });
    this._every('pebble', dt, () => rnd(15, 45), () => { if (E.cave > 0.5 && Math.random() < 0.5) { const p = this._around(15, 60, -3, 6); p.cave = this._inCave(null); this.rockFall(p); } });
    this._every('pop', dt, () => rnd(0.3, 2.2) / Math.max(0.1, E.fire), () => { if (E.fire > 0.05) { const d = this._rpan(this.amb, 0.3); this._tick(0.12 * E.fire, d, 0, rnd(1500, 4000)); if (Math.random() < 0.3) this.noise(0.25, 0.03 * E.fire, 'highpass', 3000, 0.7, 0.5, 0.01, d, 'crackle'); } });
    this._every('bubble', dt, () => rnd(0.3, 1.5), () => { if (E.underwater > 0.3) for (let i = 0, n = 1 + (Math.random() * 4 | 0); i < n; i++) this.tone(rnd(200, 600), 0.06, 'sine', 0.05 * E.underwater, 0.005, rnd(1.5, 2.5), i * rnd(0.03, 0.08), this._rpan(this.amb)); });
    this._every('wave', dt, () => rnd(6, 11), () => { if (E.ocean > 0.02) this._wave(E.ocean); });
    this._every('menace', dt, () => rnd(6, 16), () => { if (E.menace > 0.2) this.tone(rnd(24, 32), rnd(4, 7), 'sine', 0.12 * E.menace, rnd(2, 3), rnd(0.9, 1.05), 0, this.amb); });
  }

  /* ---- birds ---- */
  /** a song spec: {sp, len, notes:[{t, f0, fm?, f1, dur, v, h, am, a}]} */
  _song(species) {
    const notes = []; let t = 0;
    const N = (f0, f1, dur, v = 1, o = {}) => { notes.push({ t, f0, f1, dur, v, h: 0.12, am: 0, a: Math.min(0.015, dur * 0.3), ...o }); t += dur; };
    switch (species) {
      case 'chickadee': {
        const k = rnd(0.92, 1.06);
        if (Math.random() < 0.65) { N(3950 * k, 3880 * k, 0.33, 1, { h: 0.04 }); t += 0.09; N(3450 * k, 3400 * k, 0.38, 0.9, { h: 0.04 }); }
        else { N(7000 * k, 5800 * k, 0.04, 0.6); t += 0.03; N(6500 * k, 5600 * k, 0.04, 0.6); t += 0.06; for (let i = 0; i < 3 + (Math.random() * 2 | 0); i++) { N(3300 * k, 3250 * k, 0.17, 0.8, { am: 70, h: 0.3 }); t += 0.05; } }
        break;
      }
      case 'finch': {
        const n = 10 + (Math.random() * 12 | 0), rate = rnd(14, 20), hi = rnd(5000, 6200);
        for (let i = 0; i < n; i++) { const f = hi * (1 - 0.3 * i / n); N(f, f * 0.7, 0.04, 0.8); t += 1 / rate - 0.04; }
        N(rnd(3200, 3800), rnd(2600, 3000), 0.12, 1); t += 0.03; N(rnd(4200, 4800), rnd(2800, 3200), 0.16, 0.9);
        break;
      }
      case 'warbler': {
        for (let i = 0, n = 8 + (Math.random() * 7 | 0); i < n; i++) { const f = rnd(2600, 5600); N(f, f * rnd(0.75, 1.3), rnd(0.05, 0.11), rnd(0.6, 1), { fm: f * rnd(0.9, 1.2) }); t += rnd(0, 0.02); }
        break;
      }
      case 'dove': {
        const f = rnd(500, 600);
        N(f, f * 1.1, 0.4, 0.7, { a: 0.1, h: 0.05 }); t += 0.12; N(f * 1.15, f * 0.95, 0.6, 1, { a: 0.12, h: 0.05 }); t += 0.25;
        for (let i = 0; i < 3; i++) { N(f * 0.95, f * 0.9, 0.45, 0.8, { a: 0.1, h: 0.05 }); t += 0.2; }
        break;
      }
      default: { // thrush: a short flute motif repeated 2-3 times
        const motif = []; for (let i = 0, n = 3 + (Math.random() * 3 | 0); i < n; i++) { const f = rnd(1800, 4300); motif.push([f, f * rnd(0.8, 1.25), rnd(0.07, 0.26), Math.random() < 0.2 ? rnd(28, 45) : 0, rnd(0.02, 0.07)]); }
        for (let r = 0, reps = 2 + (Math.random() * 2 | 0); r < reps; r++) { for (const [f0, f1, d, am, gap] of motif) { N(f0, f1, d, 1, { am, h: 0.18 }); t += gap; } t += rnd(0.12, 0.25); }
        species = 'thrush';
      }
    }
    return { sp: species, notes, len: t };
  }
  /** play a song spec. k: {time stretch, pitch, wobble} */
  _birdPlay(spec, d, A, k = {}, dl = 0) {
    if (!spec || !spec.notes.length || !(A >= 0.0003)) return;
    const ts = k.time || 1, ps = k.pitch || 1, t0 = this._t(dl), T = spec.len * ts + 0.2;
    const o = this._osc('sine', spec.notes[0].f0 * ps, t0, T), o2 = this._osc('sine', spec.notes[0].f0 * ps * 2, t0, T);
    const g = ctx.createGain(); g.gain.value = 0; g.gain.setValueAtTime(0, t0);
    const g2 = this._G(0, g), am = this._G(1); g.connect(am); am.connect(d);
    o.connect(g); o2.connect(g2);
    // amplitude buzz only on the notes that ask for it
    let lfo = null, dg = null;
    if (spec.notes.some((n) => n.am)) { lfo = this._osc('sine', 40, t0, T); dg = ctx.createGain(); dg.gain.value = 0; lfo.connect(dg); dg.connect(am.gain); }
    if (k.wobble) { this._lfo(o.frequency, rnd(4, 7), spec.notes[0].f0 * ps * k.wobble, t0, T); }
    for (const n of spec.notes) {
      const t = t0 + n.t * ts, dur = n.dur * ts, f0 = F(n.f0 * ps), f1 = F(n.f1 * ps), v = A * n.v;
      o.frequency.setValueAtTime(f0, t); o2.frequency.setValueAtTime(F(f0 * 2), t);
      if (n.fm) { o.frequency.exponentialRampToValueAtTime(F(n.fm * ps), t + dur * 0.4); o2.frequency.exponentialRampToValueAtTime(F(n.fm * ps * 2), t + dur * 0.4); }
      o.frequency.exponentialRampToValueAtTime(f1, t + dur); o2.frequency.exponentialRampToValueAtTime(F(f1 * 2), t + dur);
      const a = Math.min(n.a * ts, dur * 0.45);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + a); g.gain.setValueAtTime(v * 0.85, t + dur - Math.min(0.02, dur * 0.3)); g.gain.linearRampToValueAtTime(0, t + dur);
      g2.gain.setValueAtTime(n.h, t);
      if (dg) { dg.gain.setValueAtTime(n.am ? 0.9 : 0, t); if (n.am) lfo.frequency.setValueAtTime(n.am / ts, t); }
    }
  }
  _newBird() {
    const sp = pick(['thrush', 'thrush', 'chickadee', 'finch', 'finch', 'warbler', 'dove']);
    const p = this._around(12, 90, 3, 14);
    return { x: p.x, y: p.y, z: p.z, sp, songs: [this._song(sp), this._song(sp), this._song(sp)], vol: rnd(0.6, 1) };
  }
  _ambientBird(lvl) {
    const L = this.listener;
    this.birds = this.birds.filter((b) => Math.hypot(b.x - fin(L.x), b.z - fin(L.z)) < 110);
    while (this.birds.length < 7) this.birds.push(this._newBird());
    const b = pick(this.birds);
    if (Math.random() < 0.08) { const p = this._around(12, 90, 3, 14); b.x = p.x; b.y = p.y; b.z = p.z; } // it flew to another tree
    const spec = Math.random() < 0.7 ? b.songs[0] : pick(b.songs);
    const P = this._place(b, 140, { nat: true, life: spec.len * 2 + 1 });
    if (P.a <= 0) return;
    const v = (b.sp === 'dove' ? 0.12 : 0.09) * P.a * b.vol * Math.sqrt(lvl);
    this._birdPlay(spec, P.d, v);
    if (b.sp === 'thrush' && Math.random() < 0.4) this._birdPlay(spec, P.d, v * 0.9, {}, spec.len + rnd(0.15, 0.4));
    this.lastBird = spec;
  }
  birdSong(species = 'thrush', pos = null) {
    if (!ctx) return; const spec = this._song(species);
    const P = this._at(pos, 140, spec.len + 1); if (!P) return;
    this._birdPlay(spec, P.d, 0.1 * P.a); this.lastBird = spec;
  }
  birdMimic(pos) {
    if (!ctx) return;
    const spec = this.lastBird || this._song('thrush'), life = spec.len * 1.8 + 2;
    const P = this._at(pos, 120, life, { wet: 0.2 }); if (!P) return;
    const d = this._corrupt(P.d, 0.45, life);
    this._birdPlay(spec, d, 0.11 * P.a, { time: 1.7, pitch: 0.72, wobble: 0.025 });
    this._birdPlay(spec, d, 0.045 * P.a, { time: 1.72, pitch: 0.745, wobble: 0.04 }, 0.05);
    this._rev(spec.notes[0].f0 * 0.5, 0.6, 0.02 * P.a, Math.max(0, spec.len * 1.7 - 0.2), d);
  }
  birdFlock(pos, n = 12) {
    if (!ctx) return; n = clamp(fin(n, 12) | 0, 2, 40);
    const base = pos || this._around(10, 20, 2, 4);
    [[0, 0], [7, 0.35], [15, 0.8]].forEach(([up, dl], i) => {
      const P = this._at({ x: fin(base.x) + rnd(-3, 3), y: fin(base.y) + up, z: fin(base.z) + rnd(-3, 3) }, 140, 4); if (!P) return;
      const k = Math.ceil(n / 3);
      for (let j = 0; j < Math.min(k, 8); j++) this._flap(dl + rnd(0, 0.4), rnd(0.5, 1.2), rnd(9, 15), 0.08 * P.a * (i ? 0.8 : 1), P.d);
      for (let j = 0; j < Math.min(k, 6); j++) { const f = rnd(3500, 6000); this.tone(f, 0.05, 'sine', 0.05 * P.a, 0.003, 0.75, dl + rnd(0, 1.2), P.d); }
    });
  }
  _woodpecker(pos) {
    const P = this._place(pos, 400, { nat: true, life: 3 }); if (P.a <= 0) return;
    const n = 14 + (Math.random() * 9 | 0), rate = rnd(15, 19), f = rnd(900, 1400);
    for (let i = 0; i < n; i++) { const v = 0.25 * P.a * (1 - 0.5 * i / n); this.noise(0.012, v, 'bandpass', f, 4, 0, i / rate * (1 + i * 0.004), P.d); this.tone(f * 0.6, 0.015, 'sine', v * 0.4, 0.001, 0.9, i / rate, P.d); }
  }
  _cricket(lvl) {
    const L = this.listener;
    this.crickets = this.crickets.filter((c) => Math.hypot(c.x - fin(L.x), c.z - fin(L.z)) < 40);
    while (this.crickets.length < 6) { const p = this._around(2, 28, -1.5, -1); this.crickets.push({ ...p, f: rnd(4200, 5600), pulses: 2 + (Math.random() * 3 | 0), per: rnd(0.35, 0.9) }); }
    const c = pick(this.crickets), span = rnd(1.5, 3);
    const P = this._place(c, 50, { nat: true, life: span + 0.5 }); if (P.a <= 0) return;
    const t0 = this._t(rnd(0, 0.2)), o = this._osc('sine', c.f, t0, span), g = ctx.createGain(); g.gain.value = 0; g.gain.setValueAtTime(0, t0);
    o.connect(g); g.connect(P.d);
    const v = 0.07 * P.a * lvl;
    for (let k = 0; k < span - 0.2; k += c.per * rnd(0.95, 1.05)) for (let i = 0; i < c.pulses; i++) {
      const t = t0 + k + i * 0.035; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.004); g.gain.setValueAtTime(v, t + 0.014); g.gain.linearRampToValueAtTime(0, t + 0.02);
    }
  }
  _frog(lvl) {
    const P = this._place(this._around(6, 40, -1.5, -1), 90, { nat: true, life: 3 }); if (P.a <= 0) return; const d = P.d;
    if (Math.random() < 0.55) { // croak: pulsed saw through a nasal formant
      for (let c = 0, n = 1 + (Math.random() * 3 | 0); c < n; c++) {
        const t = this._t(c * rnd(0.35, 0.6)), dur = rnd(0.2, 0.5), o = this._osc('sawtooth', rnd(110, 220), t, dur), am = this._G(0.5);
        this._lfo(am.gain, rnd(25, 40), 0.5, t, dur, 'square'); const bp = this._filt('bandpass', rnd(500, 900), 3);
        o.connect(bp); bp.connect(am); am.connect(this._env(d, t, 0.25 * P.a * lvl, 0.02, dur, dur * 0.6));
      }
    } else { const f = rnd(2700, 3000); for (let i = 0, n = 2 + (Math.random() * 4 | 0); i < n; i++) this.tone(f, 0.12, 'sine', 0.06 * P.a * lvl, 0.03, 1.12, i * rnd(0.6, 1.1), d); }
  }
  /** a far, unidentifiable sound at night */
  _distantThing() {
    const k = Math.random(), pos = this._around(150, 600, 0, 20);
    if (k < 0.25) this.animal('wolf', 'howl', pos, rnd(0, 0.35));
    else if (k < 0.45) this.knock(pos);
    else if (k < 0.65) { const P = this._place(pos, 800, { nat: true, life: 2 }); if (P.a > 0) this._twig(0.5 * P.a, P.d); }
    else if (k < 0.85) { const P = this._place(pos, 900, { nat: true, life: 5 }); if (P.a > 0) this._cry(0, rnd(1.8, 3), [[0, rnd(80, 110)], [1, rnd(90, 130)], [2.8, rnd(60, 80)]], [[0, 'o'], [1.5, 'u']], 0.3 * P.a, P.d, { rough: 0.4, vib: 0.02 }); }
    else { const P = this._place(pos, 900, { nat: true, life: 3 }); if (P.a > 0) this._cry(0, 0.9, [[0, 900], [0.3, 1100], [0.9, 700]], [[0, 'a'], [0.5, 'e']], 0.25 * P.a, P.d, { rough: 0.6 }); }
  }

  /* =========================================================== player */
  step(surface = 'forest', speed = 0.5, pos = null) {
    if (!ctx) return;
    let s = fin(speed, 0.5); if (s > 1.5) s /= 6; s = clamp(s, 0, 1.2);
    const P = this._at(pos, 30, 1); if (!P) return;
    this._stepSound(surface, (0.04 + 0.12 * s) * P.a * (pos ? 1.2 : 0.85), P.d, 0);
  }
  _stepSound(surface, v, d, dl) {
    const r = rnd(0.9, 1.1);
    switch (surface) {
      case 'grass': this.noise(0.14, v * 0.5, 'bandpass', 2600 * r, 0.8, 0.7, dl, d, 'pink', 0.02); this.noise(0.08, v * 0.8, 'lowpass', 500 * r, 0.7, 0.6, dl, d, 'brown'); this.noise(0.18, v * 0.2, 'highpass', 4500, 0.7, 1, dl + 0.03, d, 'white', 0.05); break;
      case 'leaves': this.noise(0.22, v * 1.6, 'bandpass', 3200 * r, 0.6, 0.8, dl, d, 'crackle', 0.02); this.noise(0.15, v * 0.4, 'bandpass', 1800, 0.8, 0.7, dl, d, 'pink', 0.02); this.noise(0.08, v * 0.6, 'lowpass', 500, 0.7, 0.6, dl, d, 'brown'); break;
      case 'forest': this.noise(0.1, v * 0.9, 'lowpass', 600 * r, 0.7, 0.6, dl, d, 'brown'); this.noise(0.12, v * 0.9, 'bandpass', 2000, 0.8, 0.8, dl, d, 'crackle'); if (Math.random() < 0.12) this._twig(v * 0.6, d, dl + 0.03); break;
      case 'rock': case 'cave':
        this.noise(0.03, v * 0.9, 'bandpass', 2400 * r, 1.2, 0, dl, d); this.tone(rnd(260, 340), 0.05, 'triangle', v * 0.3, 0.001, 0.7, dl, d); this.noise(0.06, v * 0.6, 'lowpass', 400, 0.7, 0, dl, d, 'brown');
        for (let i = 0, n = surface === 'cave' ? 3 : 1; i < n; i++) this._tick(v * 0.2, d, dl + rnd(0.02, 0.12), rnd(3000, 5000)); break;
      case 'sand': this.noise(0.16, v * 0.7, 'bandpass', 1400 * r, 0.6, 0.6, dl, d, 'pink', 0.03); this.noise(0.12, v * 0.4, 'highpass', 3500, 0.7, 0.8, dl + 0.02, d, 'white', 0.03); break;
      case 'mud': this.noise(0.25, v * 1.1, 'bandpass', 500 * r, 3, 2.2, dl, d, 'brown', 0.03); this.noise(0.2, v * 0.6, 'bandpass', 900, 4, 0.5, dl + 0.12, d, 'pink', 0.02); this.tone(rnd(180, 260), 0.12, 'sine', v * 0.3, 0.01, 1.8, dl + 0.15, d); break;
      case 'wood': this.noise(0.07, v * 0.9, 'bandpass', 320 * r, 3, 0.8, dl, d); this.tone(150 * r, 0.12, 'sine', v * 0.5, 0.003, 0.85, dl, d); if (Math.random() < 0.15) this._creak(0.3, v * 0.4, d, dl + 0.05, rnd(500, 800)); break;
      case 'water': this.noise(0.22, v * 1.1, 'bandpass', 1300 * r, 0.9, 0.5, dl, d); this.noise(0.12, v * 0.6, 'highpass', 3500, 0.7, 0, dl + 0.04, d);
        this.tone(rnd(500, 900), 0.08, 'sine', v * 0.25, 0.005, 1.8, dl + 0.05, d); this.noise(0.1, v * 0.6, 'lowpass', 400, 0.7, 0.5, dl, d, 'brown'); break;
      case 'snow': this.noise(0.2, v * 1.3, 'bandpass', 1800 * r, 0.7, 0.6, dl, d, 'crackle', 0.04); this.noise(0.18, v * 0.6, 'lowpass', 900, 0.7, 0.6, dl, d, 'brown', 0.04); break;
      default: this.noise(0.08, v, 'lowpass', 700 * r, 0.8, 0.5, dl, d, 'brown'); this.noise(0.06, v * 0.5, 'bandpass', 1500 * r, 0.8, 0, dl + 0.005, d, 'crackle'); this.tone(85 * r, 0.08, 'sine', v * 0.4, 0.003, 0.7, dl, d);
    }
  }
  jump() { if (!ctx) return; this.noise(0.18, 0.05, 'bandpass', 700, 1, 1.8); this.noise(0.14, 0.03, 'bandpass', 1400, 2, 0.8, 0.02, this.sfx, 'pink'); }
  land(force = 0.5) {
    if (!ctx) return; const f = clamp(fin(force, 0.5), 0, 1);
    this.tone(60, 0.25 + 0.2 * f, 'sine', 0.15 + 0.3 * f, 0.003, 0.5); this.noise(0.2, 0.12 + 0.25 * f, 'lowpass', 500, 0.7, 0.5, 0, this.sfx, 'brown');
    this.noise(0.2, 0.05 + 0.05 * f, 'bandpass', 2500, 0.7, 0.6, 0, this.sfx, 'crackle');
    if (f > 0.5) { for (let i = 0; i < 4; i++) this._tick(0.03 * f, this.sfx, rnd(0.03, 0.2), rnd(2000, 4000)); this._grunt(0.08 * f, 0.02); }
  }
  _grunt(vol, dl = 0, pitch = 1, d = this.sfx) {
    if (!(vol >= 0.0003)) return; const t = this._t(dl);
    const o = this._osc('sawtooth', 125 * pitch, t, 0.28); o.frequency.exponentialRampToValueAtTime(F(85 * pitch), t + 0.22);
    const lp = this._filt('lowpass', 1100, 0.7), bp = this._filt('bandpass', 620, 2);
    o.connect(lp); lp.connect(bp); bp.connect(this._env(d, t, vol * 2.5, 0.015, 0.26, 0.06));
    this.noise(0.2, vol * 0.5, 'bandpass', 700, 2, 0.8, dl, d, 'pink');
  }
  hurt(amount = 0.3) {
    if (!ctx) return; const a = clamp(fin(amount, 0.3), 0, 1), t = ctx.currentTime;
    this.noise(0.25, 0.2 + 0.3 * a, 'lowpass', 1200, 0.7, 0.4); this.tone(70, 0.3, 'sine', 0.2 + 0.2 * a, 0.003, 0.5);
    this._grunt(0.08 + 0.12 * a, 0.01, 1.15);
    if (a > 0.35) this.tone(rnd(3800, 4300), 1.5 + 2 * a, 'sine', 0.012 + 0.018 * a, 0.05, 0.99, 0.05, this.comp);
    if (!this.dead) {
      const p = this.mfilt.frequency; p.cancelScheduledValues(t); p.setValueAtTime(clamp(p.value, 20, 20000), t);
      p.setTargetAtTime(500 + (1 - a) * 2500, t, 0.02); p.setTargetAtTime(20000, t + 0.15, 0.3 + a * 0.6);
    }
  }
  breath(stamina) { this.stam = clamp(fin(stamina, 1), 0, 1); this.brAt = this.clock; }
  heartbeat(intensity) { this.hb = clamp(fin(intensity, 0), 0, 1); this.hbAt = this.clock; }
  death() {
    if (!ctx) return; this.dead = true; this.chase = false; const t = ctx.currentTime;
    this._thud(55, 0.5, this.mix); this.noise(0.6, 0.3, 'lowpass', 600, 0.7, 0.3, 0, this.sfx, 'brown'); this._grunt(0.12, 0, 0.7);
    [0.5, 1.5, 2.9].forEach((dl, i) => { this.tone(50, 0.16, 'sine', 0.3 - i * 0.08, 0.004, 0.6, dl, this.mix); this.tone(44, 0.18, 'sine', 0.2 - i * 0.05, 0.004, 0.6, dl + 0.24, this.mix); });
    this.tone(4100, 5, 'sine', 0.02, 0.3, 0.97, 0.2, this.comp);
    this._pad(NOTE(28), 6, 0.08, 0.3, this.mix, { type: 'sawtooth', cut: 200, att: 2, rel: 3 });
    const p = this.mfilt.frequency; p.cancelScheduledValues(t); p.setValueAtTime(clamp(p.value, 20, 20000), t); p.setTargetAtTime(280, t, 0.8);
  }
  eat() {
    if (!ctx) return;
    for (let i = 0; i < 4; i++) { const dl = i * rnd(0.22, 0.3); this.noise(0.08, 0.07, 'bandpass', rnd(1200, 2000), 0.8, 0.7, dl, this.sfx, 'crackle', 0.01); this.noise(0.1, 0.06, 'lowpass', 350, 0.7, 0.6, dl, this.sfx, 'brown'); }
    this.tone(220, 0.14, 'sine', 0.05, 0.02, 0.55, 1.2); this.noise(0.12, 0.03, 'lowpass', 500, 0.7, 0.5, 1.2, this.sfx, 'brown');
  }
  drink() {
    if (!ctx) return;
    this.noise(0.25, 0.04, 'bandpass', 900, 1, 0.7, 0, this.sfx, 'pink', 0.05);
    for (let i = 0; i < 3; i++) { const dl = 0.2 + i * 0.45; this.tone(rnd(280, 340), 0.12, 'sine', 0.08, 0.01, 0.6, dl); this.noise(0.1, 0.05, 'lowpass', 500, 0.7, 0.5, dl, this.sfx, 'brown'); this.tone(rnd(600, 900), 0.05, 'sine', 0.02, 0.004, 1.8, dl + 0.06); }
    this.noise(0.45, 0.04, 'bandpass', 1200, 0.8, 0.7, 1.65, this.sfx, 'pink', 0.05);
  }
  swim() {
    if (!ctx) return;
    this.noise(0.5, 0.09, 'bandpass', 900, 1, 0.45, 0, this.sfx, 'pink', 0.12); this.noise(0.25, 0.05, 'highpass', 3000, 0.7, 0.6, 0.05);
    for (let i = 0; i < 4; i++) this.tone(rnd(400, 900), 0.06, 'sine', 0.025, 0.004, rnd(1.5, 2.2), rnd(0.1, 0.5));
  }

  /* =========================================================== tools */
  axeSwing() { if (!ctx) return; this.noise(0.3, 0.1, 'bandpass', 500, 1.5, 3.5, 0, this.sfx, 'pink', 0.18); this.noise(0.2, 0.03, 'highpass', 3000, 0.7, 0.6, 0.12); }
  axeHit(pos = null, power = 1, material = 'wood') {
    if (!ctx) return; const P = this._at(pos, 120, 2); if (!P) return; const d = P.d, A = P.a * (0.4 + 0.6 * clamp(fin(power, 1), 0, 1));
    this._hit(material, A, d);
  }
  _hit(material, A, d) {
    switch (material) {
      case 'flesh': this.noise(0.18, 0.4 * A, 'lowpass', 500, 0.8, 0.5, 0, d, 'brown'); this.noise(0.25, 0.15 * A, 'bandpass', 900, 3, 0.4, 0.02, d, 'pink'); this.tone(90, 0.15, 'sine', 0.3 * A, 0.002, 0.5, 0, d); this._tick(0.06 * A, d, 0.01, 2500); break;
      case 'stone': this._clack(rnd(2500, 3500), 0.45 * A, d); this._clank(rnd(1100, 1500), 0.15 * A, d, 0, 0.3); this.noise(0.12, 0.1 * A, 'highpass', 4000, 0.7, 0, 0, d); for (let i = 0; i < 3; i++) this._tick(0.05 * A, d, rnd(0.05, 0.3), rnd(3000, 6000)); break;
      case 'metal': this._clank(rnd(400, 600), 0.4 * A, d, 0, 0.9); this.noise(0.05, 0.2 * A, 'highpass', 3000, 1, 0, 0, d); break;
      default: this.tone(rnd(170, 210), 0.12, 'sine', 0.45 * A, 0.001, 0.6, 0, d); this.noise(0.1, 0.5 * A, 'bandpass', rnd(800, 1100), 2, 0.6, 0, d); this.noise(0.03, 0.3 * A, 'highpass', 2500, 1, 0, 0, d);
        this._chips(d, A);
    }
  }
  _chips(d, A) { for (let i = 0, n = 3 + (Math.random() * 4 | 0); i < n; i++) this._clack(rnd(2000, 4000), 0.05 * A, d, rnd(0.08, 0.45)); }
  woodChips(pos) { if (!ctx) return; const P = this._at(pos, 40, 1.5); if (!P) return; this._chips(P.d, P.a * 1.5); }
  treeCreak(pos, size = 0.6) {
    if (!ctx) return; const s = clamp(fin(size, 0.6), 0, 1), P = this._at(pos, 200 + 200 * s, 5); if (!P) return; const d = P.d, A = P.a;
    const dur = 1.5 + 1.5 * s;
    this._creak(dur, 0.1 * A, d, 0, 520 - 280 * s); this._creak(dur * 0.7, 0.06 * A, d, dur * 0.3, 380 - 150 * s);
    for (let i = 0; i < 6; i++) this._tick(0.06 * A, d, rnd(0.2, dur), rnd(1500, 3000));
    this.noise(dur, 0.06 * A, 'bandpass', 1500, 1, 0.7, 0, d, 'crackle', dur * 0.5);
  }
  treeFall(pos, size = 0.6) {
    if (!ctx) return; const s = clamp(fin(size, 0.6), 0, 1), P = this._at(pos, 250 + 250 * s, 5); if (!P) return; const d = P.d, A = P.a;
    const dur = 1.4 + 1.6 * s;
    this.noise(dur, (0.15 + 0.15 * s) * A, 'bandpass', 500, 0.9, 3, 0, d, 'pink', dur * 0.85);
    this.noise(dur, 0.1 * A, 'highpass', 2200, 0.7, 1.4, 0, d, 'white', dur * 0.8);
    this._leafy(dur, 0.2 * A, d, 0.2, 2400);
    for (let i = 0; i < 5; i++) this._twig(0.15 * A, d, rnd(0.3, dur));
  }
  treeImpact(pos, size = 0.7) {
    if (!ctx) return; const s = clamp(fin(size, 0.7), 0, 1), P = this._at(pos, 400 + 300 * s, 6, { wet: 0.15 }); if (!P) return; const d = P.d, A = P.a * (0.5 + 0.5 * s);
    this.tone(42, 1.3, 'sine', 0.9 * A, 0.004, 0.5, 0, d); this.tone(28, 1.6, 'sine', 0.6 * A, 0.02, 0.8, 0.02, d);
    this.noise(1.4, 0.7 * A, 'lowpass', 380, 0.7, 0.4, 0, d, 'brown'); this.noise(0.2, 0.4 * A, 'bandpass', 900, 1, 0.5, 0, d);
    for (let i = 0; i < 10; i++) this._twig(rnd(0.1, 0.3) * A, d, rnd(0, 1.2));
    this._leafy(1.6, 0.3 * A, d, 0.02, 2000);
    for (let i = 0; i < 5; i++) this._thud(rnd(70, 120), 0.12 * A, d, rnd(0.3, 2), 0.2);
  }
  chopLog(pos) {
    if (!ctx) return; const P = this._at(pos, 120, 2); if (!P) return; const d = P.d, A = P.a;
    this._hit('wood', A, d);
    this.noise(0.04, 0.4 * A, 'highpass', 1800, 1, 0, 0.02, d); this.noise(0.15, 0.2 * A, 'bandpass', 1300, 2, 0.6, 0.03, d, 'crackle');
    this._knockW(rnd(240, 280), 0.2 * A, d, 0.28); this._knockW(rnd(300, 340), 0.15 * A, d, 0.4);
  }
  spearThrust() { if (!ctx) return; this.noise(0.16, 0.1, 'bandpass', 700, 1.5, 3, 0, this.sfx, 'pink', 0.08); this.noise(0.08, 0.03, 'highpass', 3500, 0.7, 0, 0.06); }
  bowDraw() { if (!ctx) return; this._creak(0.7, 0.03, this.sfx, 0, 1300); this.noise(0.6, 0.02, 'bandpass', 2500, 2, 1.3, 0, this.sfx, 'pink', 0.4); }
  bowRelease() {
    if (!ctx) return;
    this.tone(110, 0.35, 'triangle', 0.12, 0.001, 0.98); this.tone(220, 0.2, 'sine', 0.05, 0.001); this.noise(0.02, 0.12, 'bandpass', 1500, 1);
    this.noise(0.35, 0.05, 'highpass', 3000, 0.7, 0.4, 0.02);
  }
  arrowHit(pos, material = 'wood') {
    if (!ctx) return; const P = this._at(pos, 80, 2); if (!P) return; const d = P.d, A = P.a;
    if (material === 'wood') { this.tone(rnd(180, 220), 0.1, 'sine', 0.3 * A, 0.001, 0.6, 0, d); this.noise(0.04, 0.3 * A, 'bandpass', 1500, 2, 0, 0, d); const o = this.tone(150, 0.5, 'sawtooth', 0.04 * A, 0.002, 1, 0.01, d); if (o) this._lfo(o.frequency, 28, 15, ctx.currentTime, 0.5); }
    else this._hit(material, A * 0.7, d);
  }
  rifleShot(pos = null) {
    if (!ctx) return; const P = this._at(pos, 1500, 5, { far: 0.3 }); if (!P) return; const d = P.d, A = P.a;
    this.noise(0.03, 0.9 * A, 'highpass', 1200, 0.7, 0, 0, d); this.noise(0.35, 0.6 * A, 'lowpass', 1500, 0.7, 0.3, 0, d, 'brown');
    this.tone(70, 0.45, 'sine', 0.6 * A, 0.001, 0.5, 0, d);
    for (let i = 0; i < 4; i++) this.noise(rnd(0.5, 1.2), 0.12 * A * (1 - i * 0.2), 'lowpass', 500 - i * 80, 0.7, 0.6, 0.35 + i * rnd(0.3, 0.6), d, 'brown', 0.08); // echoes off the hills
  }
  flareGun(pos = null) {
    if (!ctx) return; const P = this._at(pos, 600, 4); if (!P) return; const d = P.d, A = P.a;
    this._thud(110, 0.35 * A, d, 0, 0.2); this.noise(0.1, 0.4 * A, 'bandpass', 1200, 1, 0.5, 0, d);
    this.noise(2.2, 0.12 * A, 'bandpass', 900, 1.2, 3, 0.05, d, 'white', 0.3); this.noise(2.2, 0.1 * A, 'bandpass', 2500, 0.7, 1, 0.1, d, 'crackle', 0.2);
  }
  lighter() { if (!ctx) return; this.noise(0.08, 0.1, 'bandpass', 3000, 1, 0.6, 0, this.sfx, 'crackle'); this._tick(0.05, this.sfx, 0.01, 3500); this.noise(0.25, 0.05, 'lowpass', 600, 0.7, 1.5, 0.06, this.sfx, 'brown', 0.08); this.noise(0.5, 0.012, 'bandpass', 2000, 0.6, 1, 0.1, this.sfx, 'white', 0.1); }
  torchIgnite(pos = null) {
    if (!ctx) return; const P = this._at(pos, 40, 2); if (!P) return; const d = P.d, A = P.a;
    this.noise(0.5, 0.15 * A, 'lowpass', 400, 0.8, 4, 0, d, 'brown', 0.15); this._crackle(1.2, 0.12 * A, d, 0.1); this.noise(1.2, 0.08 * A, 'lowpass', 250, 0.7, 1, 0.2, d, 'brown', 0.3);
  }
  flashlightClick() { if (!ctx) return; this._tick(0.08, this.sfx, 0, 3000); this.tone(1400, 0.015, 'square', 0.02, 0.001); this._tick(0.05, this.sfx, 0.035, 2200); }
  pickup(kind = 'item') {
    if (!ctx) return; const d = this.sfx;
    switch (kind) {
      case 'wood': this._knockW(rnd(220, 260), 0.12, d); this._knockW(rnd(300, 340), 0.08, d, 0.09); this.noise(0.15, 0.04, 'bandpass', 2000, 1, 0.6, 0, d, 'crackle'); break;
      case 'stone': this._clack(rnd(1800, 2400), 0.15, d); this._clack(rnd(1500, 2000), 0.08, d, 0.08); this.noise(0.08, 0.05, 'lowpass', 400, 0.7, 0, 0, d, 'brown'); break;
      case 'food': this.noise(0.2, 0.05, 'bandpass', 1500, 0.8, 0.7, 0, d, 'pink', 0.03); this.noise(0.12, 0.04, 'lowpass', 600, 0.7, 0.5, 0.05, d, 'brown'); this.tone(660, 0.15, 'triangle', 0.025, 0.004, 1, 0.1); break;
      case 'relic': this.tone(98, 3, 'sine', 0.1, 0.05, 1, 0, d); this.tone(147, 2.5, 'sine', 0.05, 0.1, 1, 0.05, d); this._glass(NOTE(81), 2.5, 0.02, 0.15, d, 0.3); this._rev(NOTE(69), 0.8, 0.02, 0, d); break;
      case 'note': this.noise(0.3, 0.06, 'bandpass', 2500, 0.7, 0.6, 0, d, 'white', 0.03); this.noise(0.15, 0.04, 'bandpass', 3500, 0.7, 1.4, 0.18); break;
      default: this.noise(0.15, 0.05, 'bandpass', 1800, 0.8, 0.7, 0, d, 'pink', 0.02); this._tick(0.05, d, 0.05, 2500); this.tone(520, 0.12, 'triangle', 0.03, 0.003, 1, 0.06);
    }
  }
  drop() { if (!ctx) return; this.noise(0.12, 0.05, 'bandpass', 1500, 0.8, 0.7, 0, this.sfx, 'pink'); this._thud(110, 0.12, this.sfx, 0.12, 0.15); }
  craft() {
    if (!ctx) return; const d = this.sfx;
    for (let i = 0; i < 4; i++) this.noise(0.15, 0.04, 'bandpass', rnd(1200, 2500), 0.8, 0.7, i * 0.14, d, 'pink', 0.03);
    this._knockW(260, 0.1, d, 0.25); this._knockW(300, 0.1, d, 0.42); this._knockW(230, 0.14, d, 0.62);
    this.tone(NOTE(62), 0.6, 'triangle', 0.03, 0.01, 1, 0.75); this.tone(NOTE(69), 0.8, 'triangle', 0.025, 0.01, 1, 0.85);
  }
  build(pos = null) {
    if (!ctx) return; const P = this._at(pos, 80, 3); if (!P) return; const d = P.d, A = P.a;
    for (let i = 0; i < 3; i++) this._knockW(rnd(200, 260), 0.2 * A, d, i * 0.22);
    this._thud(90, 0.25 * A, d, 0.75, 0.25); this.noise(0.2, 0.08 * A, 'bandpass', 1500, 1, 0.6, 0.75, d, 'crackle');
  }
  buildDeny() { if (!ctx) return; this._thud(80, 0.1, this.sfx, 0, 0.15); this.tone(160, 0.16, 'triangle', 0.05, 0.005, 0.9, 0.02); this.tone(120, 0.2, 'triangle', 0.045, 0.005, 0.9, 0.14); }
  doorOpen(pos = null) { if (!ctx) return; const P = this._at(pos, 40, 3); if (!P) return; this._tick(0.08 * P.a, P.d, 0, 1800); this._creak(1.1, 0.07 * P.a, P.d, 0.05, rnd(500, 700)); }
  doorClose(pos = null) { if (!ctx) return; const P = this._at(pos, 50, 2); if (!P) return; this._creak(0.4, 0.04 * P.a, P.d, 0, 600); this._knockW(110, 0.3 * P.a, P.d, 0.35, 0.3); this._tick(0.08 * P.a, P.d, 0.42, 2000); }
  chestOpen(pos = null) { if (!ctx) return; const P = this._at(pos, 30, 2); if (!P) return; this._tick(0.08 * P.a, P.d, 0, 2200); this._creak(0.7, 0.06 * P.a, P.d, 0.05, 750); this._knockW(180, 0.1 * P.a, P.d, 0.75); }
  fireIgnite(pos = null) {
    if (!ctx) return; const P = this._at(pos, 50, 3); if (!P) return; const d = P.d, A = P.a;
    this._crackle(1.4, 0.15 * A, d); this.noise(1.2, 0.2 * A, 'lowpass', 300, 0.8, 3, 0.2, d, 'brown', 0.7); this.noise(0.8, 0.05 * A, 'highpass', 3000, 0.7, 0.6, 0.4, d, 'white', 0.4);
  }
  structureHit(pos = null) {
    if (!ctx) return; const P = this._at(pos, 120, 2); if (!P) return; const d = P.d, A = P.a;
    this._knockW(rnd(90, 120), 0.5 * A, d, 0, 0.35); this.noise(0.2, 0.3 * A, 'lowpass', 600, 0.7, 0.5, 0, d, 'brown'); this.noise(0.15, 0.15 * A, 'bandpass', 1800, 1, 0.5, 0.01, d, 'crackle');
  }
  structureBreak(pos = null) {
    if (!ctx) return; const P = this._at(pos, 200, 4); if (!P) return; const d = P.d, A = P.a;
    this.noise(0.05, 0.6 * A, 'highpass', 1500, 1, 0, 0, d); this._thud(70, 0.6 * A, d, 0, 0.6); this._crackle(0.8, 0.3 * A, d, 0.02);
    for (let i = 0; i < 7; i++) this._knockW(rnd(150, 350), rnd(0.08, 0.2) * A, d, rnd(0.15, 1.3), 0.15);
  }
  splash(pos = null, size = 0.5) {
    if (!ctx) return; const s = clamp(fin(size, 0.5), 0, 1), P = this._at(pos, 60 + 100 * s, 2); if (!P) return; const d = P.d, A = P.a;
    this.noise(0.3 + 0.5 * s, (0.15 + 0.3 * s) * A, 'bandpass', 1500, 0.7, 0.6, 0, d, 'white', 0.02); this.noise(0.3 + 0.4 * s, (0.1 + 0.3 * s) * A, 'lowpass', 400, 0.7, 0.5, 0, d, 'brown');
    for (let i = 0; i < 4 + 6 * s; i++) this.tone(rnd(400, 1400), 0.06, 'sine', 0.04 * A, 0.004, rnd(1.5, 2.4), rnd(0.05, 0.6 + 0.4 * s), d);
    if (s > 0.6) this.tone(70, 0.4, 'sine', 0.3 * A, 0.01, 0.5, 0, d);
  }

  /* =========================================================== animals */
  animal(kind, sound = 'idle', pos = null, corrupt01 = 0) {
    if (!ctx) return;
    const fn = this['_a_' + kind]; if (typeof fn !== 'function') return;
    let c = clamp(fin(corrupt01, 0), 0, 1); if (kind === 'crawler') c = Math.max(c, 0.3);
    const loud = { howl: 4, call: 2.5, alert: 1.5, attack: 1.3, die: 1.3, hurt: 1.2 }[sound] || 1;
    const range = ({ wolf: 250, rabbit: 30, deer: 120, bear: 200, bird: 120, crawler: 60, owl: 250, crow: 300 }[kind] || 80) * loud;
    const life = 4 + 4 * c + (sound === 'howl' || sound === 'die' ? 4 : 0);
    const P = this._at(pos, range, life, { wet: c * 0.25 }); if (!P) return;
    const d = this._corrupt(P.d, c, life);
    const k = { c, p: 1 - 0.42 * c, fs: 1 - 0.22 * c, len: 1 + 1.1 * c };
    fn.call(this, sound, d, P.a, k, 0);
    if (c > 0.35) { // a detuned double lagging behind and a reversed swell: recognisable, but wrong
      fn.call(this, sound, d, P.a * 0.45 * c, { ...k, p: k.p * (0.93 - 0.05 * c), fs: k.fs * 1.08 }, 0.04 + 0.2 * c);
      const f = ({ wolf: 400, rabbit: 1500, deer: 400, bear: 150, bird: 3000, crawler: 600, owl: 300, crow: 600 }[kind] || 400) * k.p;
      this._rev(f, 0.5 + 0.4 * c, 0.05 * P.a * c, 0, d, 'sawtooth');
      this.noise(0.6, 0.06 * P.a * c, 'bandpass', 900, 2, 1.6, 0.1, d, 'pink', 0.55);
    }
  }
  _howl(dl, dur, f0, fpk, f1, vol, d, k) {
    const t = this._t(dl); dur *= k.len; const p = k.p;
    const g = this._env(d, t, vol, dur * 0.18, dur, dur * 0.55);
    const lp = this._filt('lowpass', 2200 * k.fs, 0.7); lp.connect(g);
    const o = this._osc('sine', f0 * p, t, dur), o2 = this._osc('triangle', f0 * p * 2, t, dur);
    for (const [os, m] of [[o, 1], [o2, 2]]) {
      os.frequency.exponentialRampToValueAtTime(F(fpk * p * m), t + dur * 0.25);
      os.frequency.exponentialRampToValueAtTime(F(fpk * p * m * 0.97), t + dur * 0.7);
      os.frequency.exponentialRampToValueAtTime(F(f1 * p * m), t + dur);
      this._lfo(os.frequency, 5 + Math.random(), fpk * p * m * 0.012, t, dur);
    }
    o.connect(lp); o2.connect(this._G(0.18, lp));
    this.noise(dur, vol * 0.12, 'bandpass', fpk * p * 2, 4, 1, dl, d, 'pink', dur * 0.2);
  }
  _bark(dl, vol, d, k, f = 420) {
    const t = this._t(dl), dur = 0.16 * k.len;
    const o = this._osc('sawtooth', f * k.p, t, dur); o.frequency.exponentialRampToValueAtTime(F(f * 0.55 * k.p), t + dur);
    const ws = this._shaper(false), bp = this._filt('bandpass', 900 * k.fs, 1.6); o.connect(ws); ws.connect(bp); bp.connect(this._env(d, t, vol * 2, 0.006, dur, dur * 0.3));
    this.noise(dur * 0.8, vol * 0.6, 'bandpass', 1300 * k.fs, 1.2, 0.6, dl, d, 'pink');
  }
  _yelp(dl, f0, f1, dur, vol, d, k) { this._cry(dl, dur * k.len, [[0, f0 * k.p], [dur * k.len, f1 * k.p]], [[0, 'i'], [dur, 'e']], vol, d, { fs: k.fs * 1.3, rough: 0.2, att: 0.01 }); }
  _sniff(dl, vol, d) { for (let i = 0; i < 3; i++) this.noise(0.06, vol, 'bandpass', rnd(2000, 3000), 1.5, 1.3, dl + i * 0.11, d, 'pink', 0.02); }
  _patter(dl, n, gap, vol, d, f = 500) { for (let i = 0; i < n; i++) { this.noise(0.05, vol, 'lowpass', f, 0.8, 0.6, dl + i * gap * rnd(0.85, 1.15), d, 'brown'); this.noise(0.04, vol * 0.4, 'bandpass', 2200, 1, 0, dl + i * gap, d, 'crackle'); } }
  _a_wolf(s, d, A, k, dl) {
    switch (s) {
      case 'howl': this._howl(dl, rnd(2.6, 3.4), rnd(330, 380), rnd(520, 600), rnd(380, 430), 0.28 * A, d, k); break;
      case 'call': this._howl(dl, rnd(1.3, 1.8), rnd(380, 420), rnd(560, 640), rnd(450, 500), 0.25 * A, d, k); break;
      case 'alert': this._bark(dl, 0.2 * A, d, k); this._bark(dl + 0.3 * k.len, 0.18 * A, d, k, 380); break;
      case 'growl': this._growl(dl, 1.4 * k.len, 85 * k.p, 0.25 * A, d, 24); break;
      case 'attack': this._growl(dl, 0.6 * k.len, 110 * k.p, 0.3 * A, d, 30); this._bark(dl + 0.45, 0.22 * A, d, k, 500); this._tick(0.3 * A, d, dl + 0.62, 2500); this._thud(140, 0.15 * A, d, dl + 0.62, 0.08); break;
      case 'hurt': this._yelp(dl, 1100, 700, 0.22, 0.2 * A, d, k); this._yelp(dl + 0.3, 1000, 650, 0.18, 0.14 * A, d, k); break;
      case 'die': for (let i = 0; i < 3; i++) this._yelp(dl + i * 0.5 * k.len, 900 - i * 120, 500 - i * 60, 0.35, 0.12 * A * (1 - i * 0.25), d, k); this.noise(1.2, 0.05 * A, 'bandpass', 600, 1, 0.6, dl + 1.6, d, 'pink', 0.3); break;
      case 'flee': for (let i = 0; i < 3; i++) this._yelp(dl + i * 0.18, 1200, 900, 0.1, 0.12 * A, d, k); this._patter(dl, 8, 0.11, 0.08 * A, d); break;
      default: if (Math.random() < 0.5) this._sniff(dl, 0.06 * A, d); else this._yelp(dl, 750, 950, 0.4, 0.06 * A, d, k); this.noise(0.25, 0.05 * A, 'bandpass', 500, 1, 0.6, dl + 0.4, d, 'pink');
    }
  }
  _a_rabbit(s, d, A, k, dl) {
    switch (s) {
      case 'hurt': case 'die': case 'attack':
        this._cry(dl, (s === 'die' ? 1.1 : 0.6) * k.len, [[0, 1500 * k.p], [0.2, 1900 * k.p], [0.7, 1400 * k.p]], [[0, 'i'], [0.4, 'e']], 0.18 * A, d, { rough: 0.6, breath: 0.3, fs: k.fs * 1.4, det: [0, 14] }); break;
      case 'alert': this._thud(90, 0.25 * A, d, dl, 0.1); this._thud(85, 0.25 * A, d, dl + 0.18, 0.1); break;
      case 'flee': this._patter(dl, 6, 0.16, 0.1 * A, d, 400); this._leafy(0.6, 0.06 * A, d, dl); break;
      case 'growl': case 'call': case 'howl': for (let i = 0; i < 3; i++) this.noise(0.06, 0.08 * A, 'bandpass', 1200 * k.fs, 3, 0.8, dl + i * 0.09, d, 'pink'); this.tone(900 * k.p, 0.08, 'sine', 0.04 * A, 0.005, 0.8, dl, d); break;
      default: this._sniff(dl, 0.04 * A, d); for (let i = 0; i < 4; i++) this._tick(0.03 * A, d, dl + 0.4 + i * 0.09, 3500);
    }
  }
  _a_deer(s, d, A, k, dl) {
    switch (s) {
      case 'alert': case 'attack': this.noise(0.35 * k.len, 0.35 * A, 'bandpass', 700 * k.fs, 1.2, 0.7, dl, d, 'pink', 0.01); this.noise(0.3, 0.2 * A, 'lowpass', 300, 0.7, 0.5, dl, d, 'brown'); if (s === 'attack') this._thud(90, 0.3 * A, d, dl + 0.4, 0.12); break;
      case 'call': case 'hurt': this._cry(dl, (s === 'hurt' ? 0.4 : 0.55) * k.len, [[0, (s === 'hurt' ? 520 : 380) * k.p], [0.15, 420 * k.p], [0.5, 300 * k.p]], [[0, 'e'], [0.3, 'a']], 0.15 * A, d, { rough: 0.3, vib: 0.03, vibRate: 9, fs: k.fs }); break;
      case 'howl': case 'growl': this._cry(dl, 1.8 * k.len, [[0, 140 * k.p], [0.5, 220 * k.p], [1.8, 110 * k.p]], [[0, 'o'], [0.6, 'a'], [1.4, 'u']], 0.2 * A, d, { rough: 0.6, fs: k.fs }); break;
      case 'die': this._cry(dl, 1.5 * k.len, [[0, 420 * k.p], [1.5, 160 * k.p]], [[0, 'e'], [1, 'o']], 0.15 * A, d, { rough: 0.4, vib: 0.04 }); this._thud(70, 0.3 * A, d, dl + 1.2, 0.3); break;
      case 'flee': for (let i = 0; i < 4; i++) { const b = dl + i * 0.36; this._patter(b, 3, 0.07, 0.12 * A, d, 600); } this._leafy(1.2, 0.08 * A, d, dl); break;
      default: this.noise(0.15, 0.08 * A, 'bandpass', 800, 1.2, 0.6, dl, d, 'pink'); for (let i = 0; i < 5; i++) this._tick(0.02 * A, d, dl + 0.3 + i * 0.15, 2000);
    }
  }
  _a_bear(s, d, A, k, dl) {
    switch (s) {
      case 'attack': this._roar(70 * k.p, 1.6 * k.len, 0.4 * A, d, dl); this._growl(dl, 1.2 * k.len, 55 * k.p, 0.2 * A, d, 18); break;
      case 'growl': this._growl(dl, 1.8 * k.len, 55 * k.p, 0.35 * A, d, 18); break;
      case 'alert': for (let i = 0; i < 4; i++) this._tick(0.12 * A, d, dl + i * 0.1, 1200); for (let i = 0; i < 2; i++) this.noise(0.25, 0.25 * A, 'bandpass', 350 * k.fs, 1, 0.6, dl + 0.5 + i * 0.35, d, 'brown', 0.01); break;
      case 'hurt': this._cry(dl, 0.8 * k.len, [[0, 260 * k.p], [0.2, 300 * k.p], [0.8, 180 * k.p]], [[0, 'a'], [0.5, 'o']], 0.25 * A, d, { rough: 0.8 }); break;
      case 'die': this._cry(dl, 3 * k.len, [[0, 220 * k.p], [3, 90 * k.p]], [[0, 'a'], [1.5, 'o'], [2.6, 'u']], 0.22 * A, d, { rough: 0.5, breath: 0.2 }); break;
      case 'call': case 'howl': this._cry(dl, 1.1 * k.len, [[0, 300 * k.p], [1.1, 220 * k.p]], [[0, 'a'], [0.7, 'o']], 0.22 * A, d, { rough: 0.6 }); break;
      case 'flee': this._patter(dl, 8, 0.2, 0.2 * A, d, 300); break;
      default: for (let i = 0; i < 3; i++) this.noise(0.18, 0.15 * A, 'bandpass', 320 * k.fs, 1, 0.6, dl + i * 0.3, d, 'brown', 0.01);
    }
  }
  _a_bird(s, d, A, k, dl) {
    const play = (sp, v) => this._birdPlay(this._song(sp), d, v * A, { time: k.len, pitch: k.p }, dl);
    switch (s) {
      case 'call': case 'howl': play(pick(['thrush', 'chickadee', 'finch', 'warbler']), 0.12); break;
      case 'alert': for (let i = 0, n = 5 + (Math.random() * 4 | 0); i < n; i++) this.tone(6000 * k.p, 0.025, 'sine', 0.1 * A, 0.002, 0.8, dl + i * 0.12 * k.len, d); break;
      case 'flee': this._flap(dl, 0.7, rnd(10, 14), 0.15 * A, d); play('chickadee', 0.06); break;
      case 'hurt': case 'attack': this._cry(dl, 0.18 * k.len, [[0, 1800 * k.p], [0.18, 1400 * k.p]], [[0, 'a']], 0.12 * A, d, { rough: 0.8, fs: 1.6 * k.fs }); break;
      case 'die': this._cry(dl, 0.3 * k.len, [[0, 1700 * k.p], [0.3, 900 * k.p]], [[0, 'a'], [0.2, 'e']], 0.1 * A, d, { rough: 0.6, fs: 1.6 }); this._flap(dl + 0.2, 0.5, 8, 0.08 * A, d); break;
      case 'growl': this.noise(0.5, 0.06 * A, 'highpass', 3000, 0.7, 0.8, dl, d, 'white', 0.05); break;
      default: play('warbler', 0.06);
    }
  }
  _hoot(dl, vol, d, k) {
    const f = rnd(270, 330) * k.p, pat = [[0, 0.32], [0.55, 0.13], [0.74, 0.13], [1.05, 0.42], [1.75, 0.45]];
    this._birdPlay({ notes: pat.map(([t, du]) => ({ t, f0: f * 1.02, f1: f * 0.96, dur: du, v: 1, h: 0.08, am: 0, a: 0.06 })), len: 2.2 }, d, vol, { time: k.len });
  }
  _a_owl(s, d, A, k, dl) {
    switch (s) {
      case 'alert': case 'attack': this._cry(dl, 1.2 * k.len, [[0, 2400 * k.p], [1.2, 1900 * k.p]], [[0, 'i'], [0.8, 'e']], 0.15 * A, d, { breath: 1.5, rough: 0.5, fs: 1.5 }); if (s === 'attack') this.noise(0.4, 0.1 * A, 'bandpass', 600, 1, 1.5, dl, d, 'pink', 0.2); break;
      case 'hurt': case 'die': this._cry(dl, 0.5 * k.len, [[0, 1500 * k.p], [0.5, 700 * k.p]], [[0, 'a'], [0.3, 'u']], 0.12 * A, d, { rough: 0.7, breath: 0.6 }); break;
      case 'flee': this.noise(0.6, 0.05 * A, 'bandpass', 500, 0.8, 1.2, dl, d, 'pink', 0.2); break;
      case 'growl': for (let i = 0; i < 4; i++) this._clack(2600, 0.1 * A, d, dl + i * 0.08); this.noise(0.6, 0.05 * A, 'highpass', 2500, 0.7, 0.8, dl + 0.35, d); break;
      default: this._hoot(dl, 0.25 * A, d, k);
    }
  }
  _caw(dl, f, dur, vol, d, k) {
    const t = this._t(dl); dur *= k.len;
    const o = this._osc('sawtooth', f * k.p, t, dur); o.frequency.exponentialRampToValueAtTime(F(f * 0.8 * k.p), t + dur);
    const ws = this._shaper(false), g = this._env(d, t, vol, 0.012, dur, dur * 0.5);
    o.connect(ws); for (const [ff, q] of [[1200, 2], [2300, 3]]) { const b = this._filt('bandpass', ff * k.fs, q); ws.connect(b); b.connect(g); }
    this.noise(dur, vol * 0.3, 'bandpass', 1500 * k.fs, 1.5, 0.8, dl, d, 'pink');
  }
  _crowCaws(dl, n, vol, d, k) { for (let i = 0; i < n; i++) this._caw(dl + i * rnd(0.38, 0.5) * k.len, rnd(560, 700), rnd(0.22, 0.32), vol, d, k); }
  _a_crow(s, d, A, k, dl) {
    switch (s) {
      case 'alert': this._crowCaws(dl, 5, 0.25 * A, d, { ...k, len: k.len * 0.6 }); break;
      case 'hurt': case 'die': case 'attack': this._caw(dl, 900, 0.3, 0.25 * A, d, k); if (s !== 'attack') this._flap(dl + 0.3, 0.5, 9, 0.08 * A, d); break;
      case 'flee': this._flap(dl, 0.9, 7, 0.15 * A, d); this._caw(dl + 0.2, 650, 0.25, 0.18 * A, d, k); break;
      case 'growl': case 'idle': this._growl(dl, 0.5 * k.len, 180 * k.p, 0.06 * A, d, 30); for (let i = 0; i < 6; i++) this._tick(0.03 * A, d, dl + 0.1 + i * 0.05, 1800); break;
      default: this._crowCaws(dl, 3, 0.25 * A, d, k);
    }
  }
  _chitter(dur, vol, d, dl = 0, n = 14, lo = 1500, hi = 4000) { for (let i = 0; i < n; i++) this._clack(rnd(lo, hi), vol * rnd(0.5, 1), d, dl + Math.random() * dur); }
  _gurgle(dl, dur, vol, d) {
    const t = this._t(dl), s = this._src('brown', t, dur), bp = this._filt('bandpass', 400, 4), am = this._G(0.5);
    this._lfo(am.gain, rnd(8, 12), 0.5, t, dur, 'square'); this._lfo(bp.frequency, 3, 150, t, dur);
    s.connect(bp); bp.connect(am); am.connect(this._env(d, t, vol * 3, 0.05, dur, dur * 0.5));
  }
  _a_crawler(s, d, A, k, dl) {
    switch (s) {
      case 'alert': this._chitter(0.6, 0.15 * A, d, dl, 18); this._shriek(600 * k.p, 1800 * k.p, 0.7 * k.len, 0.18 * A, d, dl + 0.3); break;
      case 'attack': this._shriek(1200 * k.p, 2400 * k.p, 0.4 * k.len, 0.22 * A, d, dl); this._tick(0.3 * A, d, dl + 0.3, 2000); break;
      case 'hurt': this._cry(dl, 0.4 * k.len, [[0, 900 * k.p], [0.4, 1400 * k.p]], [[0, 'i']], 0.15 * A, d, { rough: 0.9 }); break;
      case 'die': this._gurgle(dl, 1.6 * k.len, 0.12 * A, d); { let t = 0; for (let i = 0; i < 10; i++) { this._clack(rnd(1500, 3000), 0.1 * A, d, dl + t); t += 0.05 + i * 0.03; } } break;
      case 'growl': this._growl(dl, 1.2 * k.len, 70 * k.p, 0.22 * A, d, 14); this._gurgle(dl + 0.2, 0.8, 0.06 * A, d); break;
      case 'call': case 'howl': this._cry(dl, 2 * k.len, [[0, 400 * k.p], [0.8, 700 * k.p], [2, 350 * k.p]], [[0, 'u'], [1, 'i'], [1.7, 'o']], 0.15 * A, d, { vib: 0.05, vibRate: 7, rough: 0.5 }); break;
      case 'flee': this._chitter(0.6, 0.12 * A, d, dl, 24, 2500, 5000); break;
      default: this._chitter(0.6, 0.08 * A, d, dl, 10); this._gurgle(dl + 0.1, 0.6, 0.05 * A, d);
    }
  }

  /* =========================================================== humans */
  _vid(variant) { const h = typeof variant === 'number' ? Math.abs(variant | 0) : hashStr(variant ?? 0); return { base: [112, 128, 98, 142, 186, 120][h % 6], fs: [1, 1.05, 0.94, 1.1, 1.18, 0.98][(h >> 3) % 6] }; }
  cannibal(sound = 'idle', pos = null, variant = 0) {
    if (!ctx) return;
    const range = { idle: 30, alert: 160, attack: 160, hurt: 80, die: 100, ritual: 200, fear: 45, call: 1200 }[sound] || 60;
    const P = this._at(pos, range, sound === 'ritual' ? 7 : sound === 'call' ? 6 : 4, { wet: sound === 'call' ? 0.3 : 0 }); if (!P) return;
    const d = P.d, A = P.a, V = this._vid(variant), b = V.base, fs = V.fs;
    switch (sound) {
      case 'alert': this._voice({ syl: syllables(pick(['HAH!', 'HEY!', 'HO!'])), base: b * 1.7, sd: 0.32, dest: d, vol: 0.3 * A, fs, rough: 0.6, breath: 0.2 }); break;
      case 'attack': this._cry(0, 1.1, [[0, b * 2], [0.3, b * 3], [1.1, b * 2.2]], [[0, 'a'], [0.6, 'e']], 0.3 * A, d, { rough: 0.85, vib: 0.03, vibRate: 7, breath: 0.4, fs }); break;
      case 'hurt': this._voice({ syl: syllables('uh'), base: b * 1.2, sd: 0.15, dest: d, vol: 0.2 * A, fs, rough: 0.5 }); this._cry(0.18, 0.45, [[0, b * 1.6], [0.45, b * 2.2]], [[0, 'a']], 0.2 * A, d, { rough: 0.6, fs }); break;
      case 'die': this._cry(0, 2, [[0, b * 1.5], [2, b * 0.6]], [[0, 'a'], [1.2, 'o']], 0.25 * A, d, { rough: 0.5, breath: 0.3, vib: 0.02, fs }); this._gurgle(1.8, 1.2, 0.05 * A, d); break;
      case 'ritual': {
        const syl = syllables('ha ya ho ya ha ya hoo ya'), lens = syl.map(() => 0.5);
        this._voice({ syl, lens, base: b, dest: d, vol: 0.18 * A, fs, rough: 0.3, contour: (i) => (i % 4 === 2 ? 1.335 : 1), pauseK: 0 });
        this._voice({ syl, lens, base: b * 0.5, dest: d, vol: 0.1 * A, fs: fs * 0.9, delay: 0.02, contour: (i) => (i % 4 === 2 ? 1.335 : 1), pauseK: 0 });
        for (let i = 0; i < 8; i++) { this._tom(i % 2 ? 60 : 48, (i % 2 ? 0.2 : 0.3) * A, i * 0.5, d); if (i % 2) this.noise(0.03, 0.12 * A, 'bandpass', 1800, 1.5, 0, i * 0.5 + 0.25, d); }
        break;
      }
      case 'fear':
        for (let i = 0; i < 4; i++) this._cry(i * rnd(0.45, 0.6), 0.22, [[0, b * 2.3], [0.22, b * 1.8]], [[0, 'i']], 0.08 * A, d, { breath: 0.8, fs });
        for (let i = 0; i < 6; i++) this.noise(rnd(0.15, 0.3), 0.06 * A, 'bandpass', i % 2 ? 1300 : 900, 1.4, i % 2 ? 1.25 : 0.7, 0.2 + i * rnd(0.3, 0.42), d, 'pink', 0.04);
        break;
      case 'call': this._cry(0, 2.4, [[0, b * 2.4], [0.4, b * 2.8], [2.4, b * 2.5]], [[0, 'a'], [1.2, 'u'], [2, 'a']], 0.3 * A, d, { vib: 0.15, vibRate: 7, rough: 0.2, fs }); break;
      default: {
        const k = Math.random();
        if (k < 0.4) this._voice({ syl: syllables(pick(['mm hm ka da', 'ah so ke ya', 'nn ta ko', 'he he he ma'])), base: b, sd: 0.12, dest: d, vol: 0.08 * A, fs, breath: 0.2 });
        else if (k < 0.7) for (let i = 0, n = 3 + (Math.random() * 4 | 0); i < n; i++) { const dl = i * rnd(0.12, 0.3); this.noise(0.012, 0.15 * A, 'bandpass', rnd(1400, 2000), 5, 0, dl, d); this.tone(rnd(800, 1100), 0.02, 'sine', 0.05 * A, 0.001, 0.8, dl, d); }
        else this._cry(0, 1.6, [[0, b], [0.6, b * 1.12], [1.6, b * 0.95]], [[0, 'u']], 0.1 * A, d, { type: 'triangle', det: [0], fs: fs * 0.8 });
      }
    }
  }
  mimicName(pos, name = '') {
    if (!ctx) return;
    const syl = syllables(String(name || 'hey').slice(0, 40)); if (!syl.length) syl.push({ v: 'e', c: 'f', pause: 0, end: '' });
    const lens = syl.map(() => rnd(0.3, 0.38)), P = this._at(pos, 45, syl.length * 0.5 + 3, { wet: 0.15 }); if (!P) return;
    this.noise(0.6, 0.04 * P.a, 'bandpass', 1500, 2, 2.2, 0, P.d, 'white', 0.57); // a reversed inhale
    this._voice({ syl, lens, base: 95, dest: P.d, vol: 0.2 * P.a, whisper: true, fs: 0.82, delay: 0.6 });
    this._voice({ syl, lens, base: 58, dest: P.d, vol: 0.05 * P.a, fs: 1.2, delay: 0.69, rough: 0.6, breath: 0.2, contour: (i, n) => 1 - 0.2 * i / n });
  }
  pilotRadio(text = '') {
    const syl = syllables(String(text).slice(0, 400)).slice(0, 140); if (!syl.length) syl.push({ v: 'x', c: '', pause: 0, end: '' });
    const lens = syl.map(() => 0.15 * rnd(0.85, 1.15)); let vd = 0.1; syl.forEach((s, i) => { vd += lens[i] + s.pause; });
    const intro = 0.3, dur = intro + vd + 0.45;
    if (!ctx) return dur;
    const t = this._t(0), rin = ctx.createGain(), hp = this._filt('highpass', 380, 0.7), ws = this._shaper(true), bp = this._filt('bandpass', 1600, 0.8), lp = this._filt('lowpass', 3000, 0.7);
    const rout = this._G(0.55, this.sfx); rin.connect(hp); hp.connect(ws); ws.connect(bp); bp.connect(lp); lp.connect(rout);
    setTimeout(() => { try { rout.disconnect(); } catch (e) { /* gone */ } }, (dur + 20) * 1000);
    const s = this._src('white', t, dur), sb = this._filt('bandpass', 2200, 0.5), sg = ctx.createGain(); sg.gain.value = 0; sg.gain.setValueAtTime(0, t);
    for (let k = 0; k < dur; k += 0.04) sg.gain.setValueAtTime(Math.random() < 0.1 ? 0.12 : rnd(0.02, 0.05), t + k);
    sg.gain.setValueAtTime(0, t + dur); s.connect(sb); sb.connect(sg); sg.connect(rout);
    this.noise(dur, 0.06, 'highpass', 1500, 0.7, 0, 0, rout, 'crackle', 0.01);
    this.noise(0.08, 0.3, 'bandpass', 2000, 0.7, 0, 0, rout); this.tone(1200, 0.03, 'square', 0.05, 0.001, 1, 0.02, rout); // key-up click
    this._voice({ syl, lens, base: 118, dest: rin, vol: 0.35, delay: intro, breath: 0.1, contour: (i, n) => 1.05 - 0.15 * i / n });
    this.noise(0.25, 0.25, 'bandpass', 2400, 0.6, 0.7, dur - 0.4, rout, 'white', 0.005); // squelch tail
    return dur;
  }

  /* =========================================================== the Wendigo */
  wendigo(sound = 'growl', pos = null, power01 = 1) {
    if (!ctx) return;
    const p = clamp(fin(power01, 1), 0, 1), V = 0.35 + 0.65 * p;
    const R = { step: 700, breath: 30, growl: 140, clicks: 45, scream: 3000, roar: 450, screech: 260, hurt: 260, snap: 600, rustle: 80, death: 4000, disintegrate: 250 }[sound] || 150;
    const life = { scream: 10, death: 16, roar: 6, disintegrate: 6, breath: 5 }[sound] || 4;
    const P = this._at(pos, R, life, { far: sound === 'scream' || sound === 'death' ? 0.6 : 0, wet: sound === 'death' ? 0.3 : 0 }); if (!P) return;
    const d = P.d, A = P.a * V;
    switch (sound) {
      case 'step': {
        const f = rnd(30, 36) * (1.1 - 0.15 * p);
        this.tone(f * 1.7, 0.9, 'sine', 0.85 * A, 0.004, 0.45, 0, d); this.tone(f, 1.5, 'sine', 0.6 * A, 0.02, 0.8, 0.02, d);
        this.noise(1.7, 0.75 * A, 'lowpass', 120, 0.7, 0.5, 0.01, d, 'brown', 0.03); this.noise(0.25, 0.2 * A, 'lowpass', 500, 0.7, 0.4, 0, d, 'brown');
        for (let i = 0; i < 4; i++) this._tick(0.012 * A, d, rnd(0.15, 0.9), rnd(1500, 3000));
        if (Math.random() < 0.3) this._twig(0.04 * A, d, rnd(0.05, 0.2));
        break;
      }
      case 'breath': {
        this.noise(1.6, 0.25 * A, 'bandpass', 500, 1.2, 1.8, 0, d, 'pink', 1.2); this.noise(1.6, 0.06 * A, 'bandpass', 900, 1, 1, 0.2, d, 'crackle', 0.8);
        this._growl(0, 1.6, 38, 0.06 * A, d, 22);
        this.noise(2.2, 0.35 * A, 'bandpass', 420, 1, 0.55, 1.8, d, 'brown', 0.15); this.noise(2, 0.08 * A, 'bandpass', 1100, 1.5, 0.6, 1.85, d, 'crackle', 0.1);
        this._growl(1.8, 2.1, 34, 0.12 * A, d, 18);
        break;
      }
      case 'growl': this._growl(0, 2.6, 44, 0.45 * A, d, 16); this._growl(0.1, 2.4, 66, 0.15 * A, d, 21); this.tone(28, 2.6, 'sine', 0.3 * A, 0.3, 0.9, 0, d); break;
      case 'clicks': {
        let t = 0; for (let i = 0, n = 14 + (Math.random() * 14 | 0); i < n; i++) { this._clack(rnd(1800, 4200), rnd(0.12, 0.25) * A, d, t); t += Math.random() < 0.12 ? rnd(0.15, 0.3) : rnd(0.025, 0.09); }
        this.noise(0.4, 0.05 * A, 'bandpass', 2500, 3, 1, rnd(0.2, 0.6), d, 'crackle'); break;
      }
      case 'scream': this._screamLayers(0, A, d, 1); break;
      case 'roar': {
        const b = 52 * (1.1 - 0.2 * p);
        this._roar(b, 3, 0.55 * A, d); this.tone(30, 3, 'sine', 0.4 * A, 0.1, 0.8, 0, d);
        this._cry(0.1, 2.8, [[0, 180], [0.6, 250], [2.8, 140]], [[0, 'a'], [1.8, 'o']], 0.2 * A, d, { rough: 1, breath: 0.6, det: [0, 25, -30] });
        break;
      }
      case 'screech': this._shriek(900, 2600, 0.8, 0.35 * A, d); this._cry(0.02, 0.7, [[0, 1400], [0.2, 2200], [0.7, 1600]], [[0, 'i']], 0.2 * A, d, { rough: 0.9, att: 0.01 }); break;
      case 'hurt': this._cry(0, 1.2, [[0, 300], [0.3, 700], [1.2, 250]], [[0, 'a'], [0.7, 'o']], 0.35 * A, d, { rough: 0.8, breath: 0.4, det: [0, 30] }); this._growl(0.5, 1.2, 50, 0.2 * A, d); break;
      case 'snap': {
        this.noise(0.035, 0.9 * A, 'highpass', 1500, 1, 0, 0, d); this.noise(0.3, 0.5 * A, 'bandpass', 900, 1, 0.4, 0, d); this.tone(95, 0.45, 'sine', 0.5 * A, 0.002, 0.5, 0, d);
        for (let i = 0; i < 8; i++) this._twig(0.15 * A, d, rnd(0.02, 0.5)); this.noise(0.6, 0.2 * A, 'bandpass', 1400, 1.5, 0.6, 0.08, d, 'crackle');
        break;
      }
      case 'rustle': this._leafy(1.6, 0.3 * A, d, 0, 2200); this.noise(1.4, 0.15 * A, 'lowpass', 350, 0.7, 0.7, 0.1, d, 'brown', 0.3); for (let i = 0; i < 3; i++) this._twig(0.2 * A, d, rnd(0.1, 1.4)); break;
      case 'death': this._death(A, d); break;
      case 'disintegrate':
        this.noise(1.7, 0.35 * A, 'bandpass', 200, 1.2, 22, 0, d, 'white', 1.5);
        this.tone(300, 1.6, 'sine', 0.05 * A, 1.4, 8, 0, d);
        this.noise(2.6, 0.25 * A, 'bandpass', 2800, 0.6, 0.7, 1.2, d, 'crackle', 0.05); for (let i = 0; i < 12; i++) this._tick(0.08 * A, d, rnd(1.3, 3.5), rnd(2000, 6000));
        this.tone(42, 1.8, 'sine', 0.7 * A, 0.005, 0.6, 1.6, d); this.noise(1.6, 0.5 * A, 'lowpass', 280, 0.7, 0.4, 1.6, d, 'brown');
        break;
    }
  }
  /** a feedback echo across the valley; returns the input */
  _echo(d, time, fb, life) {
    const inp = ctx.createGain(), de = ctx.createDelay(2), g = this._G(fb), lp = this._filt('lowpass', 1400, 0.7);
    de.delayTime.value = time; inp.connect(d); inp.connect(de); de.connect(lp); lp.connect(g); g.connect(de); lp.connect(d);
    setTimeout(() => { try { inp.disconnect(); g.disconnect(); } catch (e) { /* gone */ } }, (life + 20) * 1000);
    return inp;
  }
  _screamLayers(dl, A, d0, s) {
    const d = this._echo(d0, rnd(0.45, 0.7), 0.35, 10);
    this._cry(dl, 3 * s, [[0, 260], [0.6, 820], [2, 600], [3, 380]], [[0, 'a'], [1.2, 'i'], [2.4, 'e']], 0.3 * A, d, { rough: 0.7, vib: 0.05, vibRate: 7, det: [0, 18] });
    this._cry(dl + 0.15, 2.7 * s, [[0, 340], [0.8, 520], [2.7, 300]], [[0, 'a'], [1.4, 'o'], [2.2, 'u']], 0.2 * A, d, { vib: 0.03, vibRate: 5.5, breath: 0.3, fs: 1.05 });
    this._growl(dl, 2.2 * s, 70, 0.12 * A, d, 20);
    this.noise(2.8 * s, 0.08 * A, 'highpass', 2500, 0.7, 0.7, dl, d, 'white', 0.3);
  }
  /** THE death scream: roar -> almost human wail -> overlapping detuned voices, echoing across the island */
  _death(A, d0) {
    const d = this._echo(d0, 0.75, 0.42, 16);
    this._roar(48, 2.4, 0.5 * A, d, 0, 1.3);
    this.tone(60, 6.5, 'sine', 0.35 * A, 0.05, 0.37, 0, d); // sub drop under everything
    this._cry(1.2, 3.6, [[0, 180], [1.2, 520], [2.4, 610], [3.6, 560]], [[0, 'a'], [1.4, 'o'], [2.8, 'u']], 0.32 * A, d, { rough: 0.3, vib: 0.04, vibRate: 5, breath: 0.25, det: [0, 6] });
    const rm = this._corrupt(d, 0.6, 9);
    for (let i = 0; i < 5; i++) {
      const f0 = 560 * rnd(0.75, 1.3), dl = 3.6 + i * 0.12;
      this._cry(dl, 3.4, [[0, f0], [1.5, f0 * rnd(0.7, 1.4)], [3.4, f0 * rnd(0.35, 0.8)]], [[0, pick(['a', 'o', 'u'])], [1.6, pick(['o', 'u', 'e'])]], 0.11 * A, i % 2 ? rm : d, { vib: rnd(0.02, 0.06), vibRate: rnd(3, 8), det: [0, rnd(15, 40)], rough: 0.2 });
    }
    this.noise(4, 0.06 * A, 'bandpass', 1200, 0.8, 0.5, 3.5, d, 'pink', 1);
  }

  /* =========================================================== world */
  thunder(distance01 = 0.5) {
    if (!ctx) return; const k = clamp(fin(distance01, 0.5), 0, 1), L = this.listener, az = Math.random() * Math.PI * 2;
    const pos = { x: fin(L.x) + Math.cos(az) * (80 + 900 * k), y: fin(L.y) + 150 + 250 * k, z: fin(L.z) + Math.sin(az) * (80 + 900 * k) };
    const P = this._place(pos, 5000, { noDelay: true, a: 1 - 0.65 * k, life: 10, wet: 0.2 }); if (P.a <= 0) return; const d = P.d, A = P.a;
    const dl = k * rnd(0.5, 2.5);
    if (k < 0.45) { // sharp crack, then the roll
      this.noise(0.08, 0.8 * A, 'highpass', 1500, 0.7, 0, dl, d); this.noise(0.5, 0.5 * A, 'bandpass', 2500, 0.6, 0.4, dl, d, 'crackle'); this.noise(0.4, 0.4 * A, 'bandpass', 1500, 0.8, 0.3, dl, d);
      this.tone(50, 1, 'sine', 0.5 * A, 0.005, 0.6, dl, d);
    }
    const t = this._t(dl + 0.1), dur = rnd(4, 6) + 2.5 * k, s = this._src('brown', t, dur), lp = this._filt('lowpass', k < 0.45 ? 420 : 170, 0.7), g = ctx.createGain();
    lp.frequency.setValueAtTime(k < 0.45 ? 420 : 170, t); lp.frequency.exponentialRampToValueAtTime(110, t + dur);
    g.gain.value = 0; g.gain.setValueAtTime(0, t);
    for (let x = 0; x < dur; x += rnd(0.15, 0.4)) g.gain.linearRampToValueAtTime(rnd(0.3, 1) * Math.pow(1 - x / dur, 1.3) * (x < 0.4 + k ? x / (0.4 + k) : 1), t + x);
    g.gain.linearRampToValueAtTime(0, t + dur);
    s.connect(lp); lp.connect(g); g.connect(this._G(0.9 * A, d));
  }
  branchSnap(pos) { if (!ctx) return; const P = this._at(pos, 150, 2); if (!P) return; this._twig(0.4 * P.a, P.d); this.tone(140, 0.1, 'sine', 0.15 * P.a, 0.001, 0.6, 0, P.d); }
  bushRustle(pos) { if (!ctx) return; const P = this._at(pos, 50, 2.5); if (!P) return; this._leafy(rnd(0.6, 1.2), 0.18 * P.a, P.d, 0, rnd(2000, 3000)); }
  rockFall(pos) {
    if (!ctx) return; const P = this._at(pos, 120, 3, { wet: 0.3 }); if (!P) return; const d = P.d, A = P.a;
    let t = 0, gap = rnd(0.25, 0.4); for (let i = 0, n = 3 + (Math.random() * 3 | 0); i < n; i++) { this._clack(rnd(1800, 3200), 0.3 * A * (1 - i * 0.15), d, t); this.tone(rnd(700, 1400), 0.05, 'sine', 0.05 * A, 0.001, 0.9, t, d); t += gap; gap *= rnd(0.5, 0.75); }
  }
  rockSlide(pos) {
    if (!ctx) return; const P = this._at(pos, 400, 5); if (!P) return; const d = P.d, A = P.a;
    this.noise(2.8, 0.5 * A, 'lowpass', 260, 0.7, 0.6, 0, d, 'brown', 0.3); this.tone(38, 2.5, 'sine', 0.3 * A, 0.3, 0.8, 0, d);
    for (let i = 0; i < 24; i++) this._clack(rnd(900, 3000), rnd(0.08, 0.25) * A, d, rnd(0, 2.6));
  }
  knock(pos) {
    if (!ctx) return; const P = this._at(pos, 500, 4, { wet: 0.35 }); if (!P) return;
    const f = rnd(170, 220), gap = rnd(0.35, 0.6);
    this._knockW(f, 0.45 * P.a, P.d, 0, 0.25); this._knockW(f * rnd(0.97, 1.03), 0.42 * P.a, P.d, gap, 0.25);
  }
  footstepsFake(pos, n = 4) {
    if (!ctx) return; n = clamp(fin(n, 4) | 0, 1, 20); const gap = rnd(0.5, 0.62), P = this._at(pos, 30, n * gap + 2); if (!P) return;
    for (let i = 0; i < n; i++) this._stepSound('leaves', 0.12 * P.a, P.d, i * gap + rnd(-0.03, 0.03));
  }
  distantScream(pos) {
    if (!ctx) return; const P = this._at(pos, 1500, 5, { far: 0.3 }); if (!P) return; const f = rnd(420, 560);
    this._cry(0, 1.6, [[0, f * 0.8], [0.2, f * 1.3], [1.1, f * 1.2], [1.6, f * 0.7]], [[0, 'a'], [1, 'e']], 0.4 * P.a, P.d, { rough: 0.5, vib: 0.03, vibRate: 6, breath: 0.4, fs: 1.15 });
  }
  creak(pos) { if (!ctx) return; const P = this._at(pos, 50, 3); if (!P) return; this._creak(rnd(0.8, 1.5), 0.08 * P.a, P.d, 0, rnd(400, 900)); }
  stoneGrind(pos) {
    if (!ctx) return; const P = this._at(pos, 200, 5, { wet: 0.2 }); if (!P) return; const d = P.d, A = P.a, t = this._t(0), dur = 3;
    const s = this._src('brown', t, dur), lp = this._filt('lowpass', 320, 0.8), am = this._G(0.6); this._lfo(am.gain, rnd(15, 25), 0.4, t, dur, 'square');
    s.connect(lp); lp.connect(am); am.connect(this._env(d, t, 0.6 * A, 0.3, dur, dur * 0.6));
    this.tone(36, dur, 'sine', 0.3 * A, 0.4, 0.9, 0, d); this.noise(dur, 0.1 * A, 'highpass', 2500, 0.7, 0.8, 0, d, 'crackle', 0.3);
  }
  deadfall(pos) {
    if (!ctx) return; const P = this._at(pos, 250, 4); if (!P) return; const d = P.d, A = P.a;
    this._tick(0.2 * A, d, 0, 1500); this._creak(0.2, 0.06 * A, d, 0, 500); this.noise(0.3, 0.2 * A, 'bandpass', 500, 1, 2.5, 0.15, d, 'pink', 0.25);
    this._thud(55, 0.9 * A, d, 0.45, 0.8); this._knockW(110, 0.5 * A, d, 0.45, 0.4); this.noise(0.04, 0.5 * A, 'highpass', 1500, 1, 0, 0.45, d);
    for (let i = 0; i < 6; i++) this._clack(rnd(1000, 2500), 0.08 * A, d, rnd(0.55, 1.4));
  }

  /* ---- helicopter ---- */
  helicopter(on, pos = null, level01 = 1) {
    if (!ctx) return;
    if (!on) { if (this.heli) this._heliStop(2.5); return; }
    if (!this.heli) this._heliBuild();
    this.heli.pos = pos || null; this.heli.level = clamp(fin(level01, 1), 0, 1);
    this._heliTick(ctx.currentTime);
  }
  _heliBuild() {
    const t = ctx.currentTime, h = { srcs: [], nodes: [] };
    const reg = (n) => { h.nodes.push(n); return n; };
    h.inG = reg(this._G(0));
    h.blade = this._osc('sine', 9, t, 1e5); h.blade.setPeriodicWave(this.pulseWave); h.srcs.push(h.blade);
    // rotor: noise slapped by the blade pulse
    const ns = ctx.createBufferSource(); ns.buffer = this.bufs.pink; ns.loop = true; ns.start(t); h.srcs.push(ns);
    const nb = reg(this._filt('bandpass', 420, 0.9)), am = reg(this._G(0.15)); ns.connect(nb); nb.connect(am); am.connect(h.inG);
    const bg = reg(this._G(0.08)); h.blade.connect(bg); bg.connect(am.gain);
    // body thump on every blade pass
    h.thump = this._osc('sine', 58, t, 1e5); h.srcs.push(h.thump);
    const am2 = reg(this._G(0)), bg2 = reg(this._G(0.05)); h.blade.connect(bg2); bg2.connect(am2.gain); h.thump.connect(am2); am2.connect(reg(this._G(1.2, h.inG)));
    // turbine whine + hiss, engine rumble
    h.turb = this._osc('sine', 1900, t, 1e5); h.srcs.push(h.turb); h.turb.connect(reg(this._G(0.025, h.inG)));
    h.turb2 = this._osc('sine', 3820, t, 1e5); h.srcs.push(h.turb2); h.turb2.connect(reg(this._G(0.008, h.inG)));
    const ws = ctx.createBufferSource(); ws.buffer = this.bufs.white; ws.loop = true; ws.start(t); h.srcs.push(ws);
    const wb = reg(this._filt('bandpass', 3200, 2)); ws.connect(wb); wb.connect(reg(this._G(0.04, h.inG)));
    const rs = ctx.createBufferSource(); rs.buffer = this.bufs.brown; rs.loop = true; rs.start(t); h.srcs.push(rs);
    const rl = reg(this._filt('lowpass', 140, 0.7)); rs.connect(rl); rl.connect(reg(this._G(0.5, h.inG)));
    // placement chain (persistent): delay (Doppler) -> distance lowpass -> HRTF panner
    h.de = reg(ctx.createDelay(6)); h.lp = reg(this._filt('lowpass', 18000, 0.5));
    h.pan = reg(ctx.createPanner()); h.pan.panningModel = 'HRTF'; h.pan.distanceModel = 'inverse'; h.pan.rolloffFactor = 0;
    h.inG.connect(h.de); h.de.connect(h.lp); h.lp.connect(h.pan); h.pan.connect(this.mix);
    h.wet = reg(this._G(0.1, this.revIn)); h.lp.connect(h.wet); h.far = reg(this._G(0, this.revFar)); h.lp.connect(h.far);
    this.heli = h;
  }
  _heliTick(t) {
    const h = this.heli, L = this.listener, lvl = h.level ?? 1;
    let px, py, pz, a = 1, dist = 0;
    if (h.pos) {
      px = fin(h.pos.x); py = fin(h.pos.y); pz = fin(h.pos.z);
      dist = Math.hypot(px - fin(L.x), py - fin(L.y), pz - fin(L.z)); a = 40 / (40 + dist) * (1 - sstep(2500, 4000, dist));
      if (this._inCave(null) !== this._inCave(h.pos)) a *= 0.4;
    } else { px = fin(L.x); py = fin(L.y) + 1.5; pz = fin(L.z); }
    const p = h.pan; if (p.positionX) { p.positionX.setTargetAtTime(px, t, 0.05); p.positionY.setTargetAtTime(py, t, 0.05); p.positionZ.setTargetAtTime(pz, t, 0.05); } else p.setPosition(px, py, pz);
    h.inG.gain.setTargetAtTime((0.15 + 0.85 * lvl) * a * 0.6, t, 0.15);
    h.lp.frequency.setTargetAtTime(clamp(19000 / (1 + dist / 45), 250, 19000), t, 0.15);
    h.de.delayTime.setTargetAtTime(Math.min(dist / 343, 5.5), t, 0.3);
    h.far.gain.setTargetAtTime(sstep(80, 800, dist) * 0.5, t, 0.3);
    h.blade.frequency.setTargetAtTime(3 + 7 * lvl, t, 0.4);
    h.turb.frequency.setTargetAtTime(900 + 1100 * lvl, t, 0.4); h.turb2.frequency.setTargetAtTime((900 + 1100 * lvl) * 2.01, t, 0.4);
  }
  _heliStop(fade, at = 0) {
    const h = this.heli; if (!h) return; this.heli = null;
    const t = ctx.currentTime + at; h.inG.gain.cancelScheduledValues(t); h.inG.gain.setValueAtTime(h.inG.gain.value, t); h.inG.gain.linearRampToValueAtTime(0, t + fade);
    for (const s of h.srcs) { try { s.stop(t + fade + 0.1); } catch (e) { /* stopped */ } }
    this.voices.push({ nodes: h.nodes, out: h.inG, end: t + fade + 1, killed: true });
  }
  heliAlarm(on) { this.heliAl = !!on; }
  crash() {
    if (!ctx) return; const d = this.sfx, t = ctx.currentTime;
    this._tear(1.4, 0.25, d, 0); this._tear(1.0, 0.2, d, 1.3);
    let k = 0.3; for (let i = 0; i < 12; i++) { this._clank(rnd(300, 900) * (1 - i * 0.04), 0.12, d, k, 0.3); k += rnd(0.04, 0.1); } // rotor shatters
    this.noise(1.2, 0.2, 'bandpass', 800, 1, 0.3, 0.3, d, 'pink', 0.05);
    [0.9, 1.7, 2.5].forEach((x, i) => { this._thud(48 - i * 4, 0.8, d, x, 0.8); this.noise(0.6, 0.45, 'lowpass', 900, 0.7, 0.4, x, d, 'brown'); this._crackle(0.4, 0.2, d, x); });
    for (let i = 0; i < 10; i++) this.tone(rnd(2500, 7000), rnd(0.03, 0.12), 'sine', 0.04, 0.001, rnd(0.95, 1.02), 2.5 + Math.random() * 0.5, d);
    this.heliAl = false; if (this.heli) this._heliStop(0.05, 3.5);
    // cut to silence, then let the world fade back in
    const c = this.cut.gain; c.cancelScheduledValues(t); c.setValueAtTime(1, t); c.setValueAtTime(1, t + 3.55); c.linearRampToValueAtTime(0, t + 3.6);
    c.setValueAtTime(0, t + 7.5); c.linearRampToValueAtTime(1, t + 10.5);
  }
  /** metal tearing: random-pitched saw through a ringing resonance + gritty noise */
  _tear(dur, vol, d, dl) {
    const t = this._t(dl), g = this._env(d, t, vol, 0.03, dur, dur * 0.6);
    const o = this._osc('sawtooth', rnd(150, 300), t, dur), bp = this._filt('bandpass', 2000, 9), s = this._src('white', t, dur), bp2 = this._filt('bandpass', 3000, 2), ng = this._G(0.6);
    for (let x = 0; x < dur; x += 0.05) { o.frequency.setTargetAtTime(rnd(100, 400), t + x, 0.02); bp.frequency.setTargetAtTime(rnd(1200, 3500), t + x, 0.03); ng.gain.setTargetAtTime(rnd(0.2, 1), t + x, 0.02); }
    o.connect(bp); bp.connect(this._G(3, g)); s.connect(bp2); bp2.connect(ng); ng.connect(g);
  }
  radioStatic(dur = 2) {
    if (!ctx) return; dur = clamp(fin(dur, 2), 0.1, 20); const d = this.sfx, t = this._t(0);
    const s = this._src('white', t, dur), bp = this._filt('bandpass', 2200, 0.6), g = ctx.createGain(); g.gain.value = 0; g.gain.setValueAtTime(0, t);
    for (let k = 0; k < dur; k += 0.03) g.gain.setValueAtTime(Math.random() < 0.15 ? 0.1 : rnd(0.4, 1), t + k);
    s.connect(bp); bp.connect(g); g.connect(this._env(d, t, 0.1, 0.01, dur, dur * 0.85));
    this.noise(dur, 0.2, 'highpass', 1500, 0.7, 0, 0, d, 'crackle', 0.01);
    for (let k = rnd(0.1, 0.6); k < dur - 0.3; k += rnd(0.5, 1.5)) this.tone(rnd(900, 1500), rnd(0.2, 0.5), 'sine', 0.008, 0.05, rnd(0.6, 1.6), k, d);
  }
  beacon() { if (!ctx) return; for (const k of [0, 0.25]) { this.tone(1050, 0.15, 'sine', 0.07, 0.004, 1, k); this.tone(2100, 0.12, 'sine', 0.02, 0.004, 1, k); } }

  /* =========================================================== music */
  setTension(v) { this.tension = clamp(fin(v, 0), 0, 1); }
  setChase(on) { this.chase = !!on; }
  setMusic(name) {
    if (!['none', 'menu', 'calm', 'finale', 'rescue', 'credits'].includes(name)) name = 'none';
    if (name === this.musicName) return; this.musicName = name;
    if (ctx) this._styleSwitch();
  }
  stinger(kind) {
    if (!ctx) return; const M = this.music;
    switch (kind) {
      case 'jump': {
        this.noise(0.6, 0.3, 'highpass', 1200, 0.7, 0.5, 0, M);
        const g = this._env(M, this._t(0), 0.12, 0.003, 1.3, 0.1), ws = this._shaper(true), lp = this._filt('lowpass', 3000, 1); ws.connect(lp); lp.connect(g);
        for (const m of [52, 53, 58, 59, 64]) { const t = this._t(0), o = this._osc('sawtooth', NOTE(m), t, 1.3); o.frequency.exponentialRampToValueAtTime(NOTE(m) * 0.94, t + 1.3); o.connect(ws); }
        this.tone(55, 0.8, 'sine', 0.35, 0.002, 0.5, 0, M); break;
      }
      case 'reveal': this._pad(NOTE(28), 4, 0.08, 0, M, { type: 'sawtooth', cut: 300, att: 1, rel: 2 }); this._strings([40, 41, 47], 3.5, 0.05, 0.1, M, 0, 0.8); this._bell(NOTE(64), 3, 0.03, 0.2, M); this._thud(55, 0.3, M, 0.2, 1); break;
      case 'safe': for (const m of [50, 57, 62, 66]) this._pad(NOTE(m), 5, 0.025, 0, M, { att: 1.2, rel: 3, cut: 1400 }); this._piano(NOTE(74), 3, 0.05, 1, M); this._piano(NOTE(78), 3, 0.04, 1.6, M); break;
      case 'discovery': [57, 64, 69, 72].forEach((m, i) => this._bell(NOTE(m), 2, 0.035, i * 0.18, M)); this._pad(NOTE(45), 4, 0.04, 0.3, M, { att: 0.8, rel: 2, cut: 900 }); break;
      case 'relic':
        this.tone(NOTE(31), 5, 'sine', 0.2, 0.4, 1, 0, M); this.tone(NOTE(38), 4.5, 'sine', 0.08, 0.8, 1, 0.2, M);
        this._rev(NOTE(69), 1.4, 0.04, 0, M); this._glass(NOTE(81), 3.5, 0.02, 1.4, M, 0.4); this._glass(NOTE(80.6), 3.5, 0.015, 1.5, M, 0.4);
        this._cry(1.2, 3.5, [[0, NOTE(57)], [3.5, NOTE(57)]], [[0, 'o'], [2, 'u']], 0.04, M, { type: 'triangle', vib: 0.008, vibRate: 5, att: 1.2, det: [-6, 6] });
        break;
      default: // dread
        for (const m of [40, 41, 47]) this._pad(NOTE(m), 5.5, 0.06, 0, M, { type: 'sawtooth', cut: 400, att: 3, rel: 1.5, det: 10 });
        this.noise(5, 0.15, 'lowpass', 300, 0.7, 2, 0, M, 'brown', 3.5);
        this.tone(NOTE(95), 5, 'sine', 0.012, 4, 1, 0, M); this.tone(NOTE(96), 5, 'sine', 0.01, 4, 1, 0, M);
    }
  }
  _tensionTick(t, dt) {
    const T = this.tensionLvl;
    if (T > 0.005 && !this.dr) {
      const G = (to) => this._G(0, to);
      const gD = G(this.music), lp = this._filt('lowpass', 150, 0.8); lp.connect(gD); this._lfo(lp.frequency, 0.05, 40, t, 0);
      for (const f of [41.2, 41.2 * 1.007]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(lp); o.start(t); }
      const gX = G(this.music), lx = this._filt('lowpass', 320, 0.7); lx.connect(gX);
      for (const [type, f] of [['triangle', 43.65], ['sine', 87.3]]) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.connect(lx); o.start(t); }
      const gH = G(this.music);
      for (const f of [1318.5, 1396.9]) { const o = ctx.createOscillator(); o.frequency.value = f; const g = this._G(0.5, gH); this._lfo(g.gain, rnd(0.1, 0.3), 0.4, t, 0); o.connect(g); o.start(t); }
      this.dr = { gD, lp, gX, gH, sent: -1 };
    }
    if (this.dr && Math.abs(T - this.dr.sent) > 0.003) {
      const r = this.dr; r.sent = T;
      r.gD.gain.setTargetAtTime(0.2 * sstep(0, 0.5, T), t, 0.1); r.lp.frequency.setTargetAtTime(110 + 800 * T * T, t, 0.2);
      r.gX.gain.setTargetAtTime(0.08 * sstep(0.35, 0.85, T), t, 0.1); r.gH.gain.setTargetAtTime(0.015 * sstep(0.6, 1, T), t, 0.1);
    }
    this._every('moan', dt, () => rnd(8, 20), () => {
      if (T < 0.15 || Math.random() > 0.75) return;
      if (T > 0.6) this._strings(pick([[40, 41], [45, 46, 52], [38, 39, 44]]), rnd(4, 6), 0.02 + 0.03 * T, 0, this.music, rnd(0, 1) < 0.4 ? 9 : 0, 2);
      else this._bowed(rnd(70, 140), rnd(3, 6), 0.02 + 0.02 * T, this.music);
    });
  }
  _chaseTick(t) {
    if (this.chaseLvl <= 0.005 && !this.chase) { if (this.cBus && this.cBus.sent !== 0) { this.cBus.gain.setTargetAtTime(0, t, 0.1); this.cBus.sent = 0; } return; }
    if (!this.cBus) { this.cBus = this._G(0, this.music); this.cBus.sent = 0; this.cNext = 0; this.cStep = 0; }
    if (Math.abs(this.cBus.sent - this.chaseLvl) > 0.01) { this.cBus.gain.setTargetAtTime(this.chaseLvl * 0.9, t, 0.05); this.cBus.sent = this.chaseLvl; }
    const sp = 60 / 140 / 4;
    if (!this.cNext || this.cNext < t - 0.5) this.cNext = t + 0.05;
    while (this.cNext < t + 0.2) { this._chaseStep(this.cStep++, this.cNext - t); this.cNext += sp; }
  }
  _chaseStep(i, dl) {
    const B = this.cBus, s = i % 16, bar = ((i / 16) | 0) % 4;
    if (s === 0 || s === 3 || s === 6 || s === 8 || s === 11 || (s === 14 && bar % 2)) this._tom(s % 8 === 0 ? 46 : 60, s % 8 === 0 ? 0.5 : 0.3, dl, B);
    if (s === 4 || s === 12) this._tom(92, 0.2, dl, B);
    if (s % 2 === 1) this.noise(0.02, 0.025, 'bandpass', 2500, 2, 0, dl, B);
    if (s % 4 === 0) this._bass(NOTE([26, 26, 27, 25][bar] + (s === 8 ? 12 : 0)), 0.3, 0.06, dl, B);
    if (s === 0 && bar % 2 === 0) this._strings(bar ? [52, 53, 58] : [50, 51, 57], 3.3, 0.045, dl, B, 11, 0.2);
    if (s === 8 && bar === 3) this._cry(dl, 1.6, [[0, NOTE(76)], [1.6, NOTE(83)]], [[0, 'i']], 0.025, B, { det: [-12, 12], vib: 0.01, vibRate: 7, att: 1.2 });
  }
  _styleSwitch() {
    const t = ctx.currentTime;
    if (this.sBus) {
      const old = this.sBus; old.gain.cancelScheduledValues(t); old.gain.setValueAtTime(old.gain.value, t); old.gain.linearRampToValueAtTime(0, t + 3);
      setTimeout(() => { try { old.disconnect(); } catch (e) { /* gone */ } }, 3500);
    }
    this.sBus = null; if (this.musicName === 'none') return;
    const g = this._G(0, this.music); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 2.5);
    this.sBus = g; this.sNext = t + 0.3; this.sStep = 0; this.sName = this.musicName;
  }
  _styleTick(t) {
    if (!this.sBus) return; const B = this.sBus, name = this.sName;
    const len = { menu: 1, calm: 1.5, finale: 60 / 104 / 2, rescue: 0.5, credits: 0.5 }[name] || 1;
    if (this.sNext < t - 1) this.sNext = t + 0.1;
    while (this.sNext < t + 0.3) {
      const dl = this.sNext - t, s = this.sStep++;
      if (name === 'menu') { // wind, a low drone, a distant bell
        if (s % 16 === 0) { this._pad(NOTE(26), 17, 0.05, dl, B, { type: 'sawtooth', cut: 220, att: 4, rel: 5 }); this._pad(NOTE(33), 17, 0.025, dl, B, { cut: 300, att: 5, rel: 5 }); }
        if (s % 8 === 3) this.noise(rnd(5, 7), 0.05, 'bandpass', rnd(400, 900), 3, rnd(0.6, 1.6), dl, B, 'pink', 2.5);
        if (s % 8 === 5 && Math.random() < 0.6) this._bell(NOTE(pick([57, 55, 52])), 6, 0.02, dl, B);
        if (s % 16 === 10 && Math.random() < 0.4) this._bowed(NOTE(pick([38, 41, 43])), 5, 0.025, B, dl);
      } else if (name === 'calm') { // lonely piano and cello notes with lots of space
        const scale = [57, 60, 62, 64, 67, 69, 72, 74, 76];
        if (Math.random() < 0.16) { let m = pick(scale); for (let j = 0, n = 1 + (Math.random() * 3 | 0); j < n; j++) { this._piano(NOTE(m), 4, 0.045, dl + j * rnd(0.5, 0.9), B); m = scale[clamp(scale.indexOf(m) - 1 - (Math.random() * 2 | 0), 0, scale.length - 1)]; } }
        else if (Math.random() < 0.05) this._bowed(NOTE(pick([45, 48, 50, 52])), 5, 0.03, B, dl);
        if (s % 24 === 0) for (const m of [45, 52, 57]) this._pad(NOTE(m), 10, 0.012, dl, B, { att: 3, rel: 4, cut: 800 });
      } else if (name === 'finale') { // driving low percussion, brass swells
        const st = s % 16, bar = (s / 16) | 0;
        if ([0, 3, 6, 8, 10, 13].includes(st)) this._tom(st === 0 || st === 8 ? 44 : 58, st === 0 || st === 8 ? 0.45 : 0.28, dl, B);
        if (st % 2) this.noise(0.03, 0.02, 'bandpass', 3000, 2, 0, dl, B);
        if (st % 2 === 0) this._bass(NOTE(26 + [0, 0, 3, 0, 5, 3, 0, -2][st / 2]), len * 1.8, 0.05, dl, B);
        if (st === 0 && bar % 2 === 0) this._brass([[38, 45, 50], [36, 43, 48], [41, 48, 53], [40, 47, 52]][(bar / 2 | 0) % 4], len * 30, 0.05, dl, B, 1.2);
      } else if (name === 'rescue') { // a warm swelling progression
        const ch = [[50, 57, 62, 66], [45, 52, 61, 64], [47, 54, 59, 62], [43, 50, 59, 62]][((s / 12) | 0) % 4];
        if (s % 12 === 0) { for (const m of ch) this._pad(NOTE(m), 6.6, 0.03, dl, B, { att: 2.5, rel: 2.5, cut: 1600 }); this._pad(NOTE(ch[0] - 12), 6.6, 0.05, dl, B, { type: 'sine', att: 2, rel: 2.5 }); this._brass(ch.slice(1), 6, 0.018, dl + 0.5, B, 2.5); }
        if (s % 2 === 0) this._piano(NOTE(ch[(s / 2) % 4] + 12), 2.5, 0.035, dl, B);
      } else if (name === 'credits') { // gentle and melancholic
        const ch = [[45, 52, 60, 64], [41, 48, 57, 60], [48, 55, 64, 67], [43, 50, 59, 62]][((s / 8) | 0) % 4];
        if (s % 8 === 0) { for (const m of ch.slice(0, 3)) this._pad(NOTE(m), 4.4, 0.02, dl, B, { att: 1, rel: 1.5, cut: 900 }); }
        this._piano(NOTE([ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[1] + 12][s % 4]), 2, 0.035, dl, B);
        if (s % 8 === 6 && Math.random() < 0.5) this._piano(NOTE(ch[3] + 12), 3, 0.04, dl, B);
      }
      this.sNext += len;
    }
  }

  /* =========================================================== UI */
  uiClick() { if (!ctx) return; this.tone(1200, 0.03, 'triangle', 0.035); this.noise(0.012, 0.03, 'bandpass', 2500, 1.5); }
  uiOpen() { if (!ctx) return; this.noise(0.2, 0.04, 'bandpass', 1600, 0.8, 1.4, 0, this.sfx, 'pink', 0.05); this.tone(220, 0.3, 'sine', 0.04, 0.02, 1.2); }
  uiClose() { if (!ctx) return; this.noise(0.18, 0.035, 'bandpass', 1800, 0.8, 0.7, 0, this.sfx, 'pink', 0.03); this.tone(260, 0.25, 'sine', 0.035, 0.01, 0.8); }
  deny() { if (!ctx) return; this.tone(150, 0.18, 'triangle', 0.05, 0.005, 0.9); this.tone(110, 0.22, 'triangle', 0.045, 0.005, 0.9, 0.12); }
  objective() { if (!ctx) return; this.tone(NOTE(38), 1.4, 'sine', 0.08, 0.02); this._bell(NOTE(62), 1.6, 0.03, 0.1); this._bell(NOTE(69), 2, 0.025, 0.3); }
  journal() {
    if (!ctx) return;
    this.noise(0.35, 0.06, 'bandpass', 2200, 0.7, 1.6, 0, this.sfx, 'white', 0.12); this.noise(0.3, 0.04, 'bandpass', 1500, 0.8, 0.8, 0.05, this.sfx, 'crackle', 0.1);
    this.noise(0.08, 0.04, 'lowpass', 600, 0.7, 0, 0.32, this.sfx, 'brown');
  }
  discovery() {
    if (!ctx) return;
    this.tone(NOTE(31), 4, 'sine', 0.18, 0.05, 1); this.tone(NOTE(43), 3.5, 'sine', 0.06, 0.1, 1, 0.05); this.tone(NOTE(50), 3, 'sine', 0.03, 0.2, 1, 0.1);
    this._bell(NOTE(67), 3, 0.02, 0.3); this._glass(NOTE(86), 2.5, 0.008, 0.5, this.sfx, 0.3);
  }
}
