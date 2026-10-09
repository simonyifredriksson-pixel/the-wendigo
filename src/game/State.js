/* State.js - what survives a page reload: the player's profile (name, look,
   settings) and the host's world save. Both live in localStorage. */
const PKEY = 'wendigo-profile-v1', WKEY = 'wendigo-world-v1';

export function loadProfile() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PKEY) || '{}') || {}; } catch (e) { p = {}; }
  return {
    name: p.name || 'Survivor', look: (p.look | 0) % 4, key: p.key || Math.random().toString(36).slice(2, 12),
    sens: p.sens || 1, invert: !!p.invert, fov: p.fov || 72, vol: p.vol ?? 0.85, music: p.music ?? 0.6,
    quality: p.quality || 'high', subtitles: p.subtitles ?? true, intro: p.intro ?? true,
  };
}
export function saveProfile(p) { try { localStorage.setItem(PKEY, JSON.stringify(p)); } catch (e) { /* private mode */ } }
export function loadWorld() { try { const s = localStorage.getItem(WKEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
export function saveWorld(w) { try { localStorage.setItem(WKEY, JSON.stringify(w)); return true; } catch (e) { return false; } }
export function wipeWorld() { try { localStorage.removeItem(WKEY); } catch (e) { /* */ } }

/** a fresh world save */
export function newWorld(seed) {
  return {
    v: 1, seed: seed >>> 0, day: 1, hour: 7.2, weather: 'clear',
    felled: {},            // tree id -> 2 (stump) | 3 (gone)
    built: [],             // { id, kind, x, y, z, rot, hp }
    drops: [],             // items lying in the world { id, name, x, y, z, n }
    taken: {},             // fixed pickups/loot already taken: id -> 1
    lore: {},              // discovered lore ids -> 1
    relics: {},            // 'emberStone' | 'boneHorn' | 'ashSpearhead' -> 1
    flags: {},             // story flags
    stash: {},             // storage boxes: id -> { item: n }
    menace: 0,             // how far the island's horror has escalated (0..1)
    memory: [],            // the Wendigo's memory of where players spend time (heat cells)
    stats: { days: 0, trees: 0, built: 0, kills: 0, deaths: 0, seen: 0 },
    players: {},           // profile key -> { x, y, z, inv, health, hunger, warmth }
    intro: false,          // the opening has played
    done: false,
  };
}
