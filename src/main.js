/* main.js - boot: renderer, world, title screen, the frame loop. */
import * as THREE from '../lib/three.module.js';
import { Input } from './core/Input.js';
import { Audio } from './core/Audio.js';
import { PostFX } from './core/PostFX.js';
import { setAniso } from './core/Textures.js';
import { Net } from './net/Net.js';
import { Game } from './game/Game.js';
import { loadProfile, saveProfile, loadWorld, wipeWorld } from './game/State.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
window.__log = (m) => {
  (window.__logs ||= []).push(String(m)); console.log(m);
  const L = $('loading');
  if (L && !L.classList.contains('gone') && /^(ERR|REJ)/.test(m)) { window.__shotReady = true; L.insertAdjacentHTML('beforeend', '<div class="lerr">' + String(m).replace(/</g, '&lt;').slice(0, 600) + '</div>'); }
  const E = $('errlog'); if (E && /^(ERR|REJ|UPDATE)/.test(m)) { E.style.display = 'block'; E.textContent += m + '\n'; }
};
addEventListener('error', e => window.__log('ERR ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno));
addEventListener('unhandledrejection', e => window.__log('REJ ' + (e.reason?.stack || e.reason)));

async function boot() {
  const step = (t, f) => { $('loadtxt').textContent = t; if (f !== undefined) $('lfill').style.width = (f * 100) + '%'; return new Promise(r => setTimeout(r, 16)); };
  try { await Promise.race([document.fonts.load('40px "Cormorant Garamond"'), new Promise(r => setTimeout(r, 2500))]); } catch (e) { /* */ }
  const canvas = $('game');
  const profile = loadProfile();
  if (params.get('q')) profile.quality = params.get('q');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  setAniso(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(profile.fov || 72, innerWidth / innerHeight, 0.06, 4000);
  scene.add(camera);
  const post = new PostFX(renderer);
  if (params.has('nopost')) post.enabled = false;
  const input = new Input(canvas);
  input.sensitivity = profile.sens; input.invertY = profile.invert; input.requireLock = true;
  const audio = new Audio(); audio.setVolume?.(profile.vol, profile.music);
  const net = new Net();
  const game = new Game({ renderer, scene, camera, input, audio, net, profile, post, params });
  window.__game = game;
  await game.load(step);
  const applyQuality = (q) => {
    const pr = Math.min(devicePixelRatio, q === 'high' ? 1.25 : q === 'medium' ? 1 : 0.8);
    renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight);
    post.scale = q === 'low' ? 0.85 : 1; post.setSize(innerWidth, innerHeight);
    game.setQuality(q);
  };
  game.applyQuality = applyQuality; applyQuality(profile.quality);
  input.canLock = () => game.phase === 'play' && !game.ui.modal && !game.chatOpen;
  input.onLockChange = (locked) => { if (!locked && game.phase === 'play' && !game.ui.modal && !game.chatOpen && !game.cutscene) game.ui.open('pause'); };
  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); post.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); game.view?.resize(); });
  addEventListener('beforeunload', () => { if (game.isHost && game.phase === 'play') game.saveNow(); });

  /* ---------------- title */
  game.ui.title(profile, {
    cont: () => game.start(loadWorld()),
    fresh: () => { wipeWorld(); game.start(null); },
    host: async (msg) => { const code = await net.host({ name: profile.name, look: profile.look, key: profile.key }); game.start(loadWorld()); game.hud.toast('ROOM CODE: ' + code + ' - friends press JOIN on the title screen and type it.', 12); return code; },
    join: async (codeIn) => { const d = await net.join(codeIn, { name: profile.name, look: profile.look, key: profile.key }); game.me = d.id; game.startClient(d); },
    hasSave: !!loadWorld(),
    unlock: () => audio.unlock?.(),
  });

  // test hooks
  const testing = params.has('shot') || params.has('script') || params.has('play');
  $('loading').classList.add('gone');
  if (testing) {
    $('title').classList.add('gone');
    if (!params.has('keep')) wipeWorld();
    const T = await import('./debug/Tests.js');
    try { if (params.has('shot')) await T.shot(game, params.get('shot'), params); else if (params.has('script')) T.run(game, params.get('script'), params); else game.start(null, { skipIntro: !params.has('intro') }); }
    catch (e) { window.__log('UPDATE test failed: ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 5).join(' | ')); window.__shotReady = true; }
  } else game.toTitle();

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    try { if (!game.paused) game.update(dt * (game.timeScale ?? 1)); } catch (e) { if (!game._errN || game._errN < 6) { game._errN = (game._errN || 0) + 1; window.__log('UPDATE ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 4).join(' | ')); } }
    if (!game.noRender || now - (game._lastDraw || 0) > 1000) { game.render(dt); game._lastDraw = now; }
    input.endFrame();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.__tick = (dt) => { game.update(dt); input.endFrame(); };
  window.__render = () => game.render(0.016);
}
boot();
