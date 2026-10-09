/* Tests.js - headless checks and staged screenshots.

   ?shot=at&x=&z=&yaw=&pitch=&h=(height above ground)&hour=&weather=
       frames any spot of the island at any time of day
   ?shot=<name>   named scenes (see SHOTS)
   ?script=<suite>  logic tests; results go to window.__logs and the page */
export async function shot(game, name, P) {
  const num = (k, d) => (P.has(k) ? +P.get(k) : d);
  game.start(null, { skipIntro: true });
  game.ui.close?.(); game.input.unlock?.();
  const A = game.atmos;
  if (P.has('hour')) A.hour = num('hour', 12);
  if (P.has('weather')) { A.setWeather(P.get('weather')); A.w = { ...A.wTarget }; }
  game.freezeTime = true;
  const S = SHOTS[name];
  if (S) await S(game, P, num);
  else if (name === 'at') {
    const x = num('x', 0), z = num('z', 0);
    game.player.spawn(x, z, num('yaw', 0));
    game.player.pitch = num('pitch', 0);
    game.player.pos.y += num('h', 0);
    game.player.noclip = P.has('h') && num('h', 0) > 0.5;
  }
  // run the world for a moment so streaming, shadows and env maps settle
  for (let i = 0; i < 8; i++) { game.update(0.05); }
  game.world.forest.dirty = true; game.world.cover._last.set(1e9, 0, 0);
  for (let i = 0; i < 3; i++) game.update(0.016);
  await new Promise(r => setTimeout(r, 300));
  game.render(0.016);
  const info = game.renderer.info.render;
  window.__log(`tris ${info.triangles} calls ${info.calls} pos ${game.player.pos.x.toFixed(0)},${game.player.pos.y.toFixed(0)},${game.player.pos.z.toFixed(0)} hour ${A.hour.toFixed(1)}`);
  game.paused = !P.has('live');
  window.__shotReady = true;
}

const SHOTS = {
  // the landmark views
  crash: (g) => { const c = g.island.landmark('crash'); g.player.spawn(c.x + 12, c.z + 9, 0.9); },
  circle: (g) => { const c = g.island.landmark('circle'); g.player.spawn(c.x, c.z + 40, 0); },
  map: (g, P, num) => { g.player.noclip = true; g.player.spawn(0, 900, 0); g.player.pos.y = num('h', 900); g.player.pitch = -1.0; },
};

export function run(game, suite, P) {
  window.__log('no suite ' + suite);
  window.__shotReady = true;
}
