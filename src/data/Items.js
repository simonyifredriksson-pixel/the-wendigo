/* Items.js - every item, what it does, and how to make it.

   kind     'tool' (held, has an action) | 'food' | 'res' (resource) | 'relic' | 'note' | 'med' | 'ammo'
   stack    how many fit in one slot
   tool     { dmg, chop, reach, rate (s per swing), stamina, hold: 'two'|'right' }
   food     { hunger, health, warmth, raw: chance of sickness }
   weight   logs are heavy: max 4 carried, slowing you down */

export const ITEMS = {
  // tools & weapons
  axe:        { label: 'Fire Axe', kind: 'tool', stack: 1, tool: { dmg: 26, chop: 1.0, reach: 2.4, rate: 0.85, stamina: 7, hold: 'two' }, desc: 'From the helicopter\'s emergency kit. Chops trees, and anything else.' },
  axeCrafted: { label: 'Stone Axe', kind: 'tool', stack: 1, tool: { dmg: 18, chop: 0.6, reach: 2.2, rate: 0.9, stamina: 7, hold: 'two' }, desc: 'A sharp stone lashed to a stick.' },
  spear:      { label: 'Spear', kind: 'tool', stack: 1, tool: { dmg: 30, chop: 0, reach: 3.1, rate: 0.75, stamina: 6, hold: 'two', thrust: true, fish: true }, desc: 'Fire-hardened point. Long reach. Spears fish.' },
  club:       { label: 'Club', kind: 'tool', stack: 1, tool: { dmg: 34, chop: 0.1, reach: 2.2, rate: 1.0, stamina: 9, hold: 'right' }, desc: 'Heavy and simple.' },
  boneClub:   { label: 'Bone Club', kind: 'tool', stack: 1, tool: { dmg: 42, chop: 0.1, reach: 2.3, rate: 1.05, stamina: 10, hold: 'right' }, desc: 'Taken from one of them.' },
  bow:        { label: 'Bow', kind: 'tool', stack: 1, tool: { ranged: 'arrow', dmg: 45, rate: 0.9, hold: 'two' }, desc: 'Hold to draw, release to shoot. Needs arrows.' },
  rifle:      { label: 'Hunting Rifle', kind: 'tool', stack: 1, tool: { ranged: 'ammo', dmg: 120, rate: 1.4, hold: 'two', loud: 1 }, desc: 'Found in the hunter\'s cabin. Loud. Everything on the island hears it.' },
  flaregun:   { label: 'Flare Gun', kind: 'tool', stack: 1, tool: { ranged: 'flare', dmg: 40, rate: 1.2, hold: 'right', fire: true }, desc: 'Fires a burning flare. Fire is the one thing it hates.' },
  torch:      { label: 'Torch', kind: 'tool', stack: 1, tool: { dmg: 14, chop: 0, reach: 2.0, rate: 0.8, stamina: 5, hold: 'right', light: 'torch', burn: true }, desc: 'Light and warmth. Creatures keep their distance from it.' },
  flashlight: { label: 'Flashlight', kind: 'tool', stack: 1, tool: { light: 'flashlight', hold: 'right' }, desc: 'Runs on batteries.' },
  lighter:    { label: 'Lighter', kind: 'tool', stack: 1, tool: { light: 'lighter', hold: 'right' }, desc: 'A small flame. Lights fires and torches.' },
  emberSpear: { label: 'Ember Spear', kind: 'tool', stack: 1, tool: { dmg: 60, chop: 0, reach: 3.3, rate: 0.9, stamina: 8, hold: 'two', thrust: true, ember: true }, desc: 'The spear from the stones. The ember in it never cools.' },
  boneHorn:   { label: 'Bone Horn', kind: 'relic', stack: 1, tool: { horn: true, hold: 'right' }, desc: 'Blow it inside the stone circle at night. It will come.' },
  // relics
  emberStone:   { label: 'Ember Stone', kind: 'relic', stack: 1, desc: 'Warm to the touch. Red light moves inside the cracks.' },
  ashSpearhead: { label: 'Ash Spearhead', kind: 'relic', stack: 1, desc: 'Black glass, older than anything on the island.' },
  // resources
  log:   { label: 'Log', kind: 'res', stack: 4, heavy: true, desc: 'Building material. Heavy: carry up to four.' },
  stick: { label: 'Stick', kind: 'res', stack: 30 },
  stone: { label: 'Stone', kind: 'res', stack: 20 },
  rope:  { label: 'Rope', kind: 'res', stack: 10 },
  cloth: { label: 'Cloth', kind: 'res', stack: 10 },
  fiber: { label: 'Plant Fibre', kind: 'res', stack: 20 },
  leaves:{ label: 'Leaves', kind: 'res', stack: 30 },
  resin: { label: 'Resin', kind: 'res', stack: 10 },
  feather: { label: 'Feather', kind: 'res', stack: 30 },
  bone:  { label: 'Bone', kind: 'res', stack: 20 },
  hide:  { label: 'Hide', kind: 'res', stack: 6 },
  arrow: { label: 'Arrow', kind: 'ammo', stack: 30 },
  ammo:  { label: 'Rifle Rounds', kind: 'ammo', stack: 30 },
  flare: { label: 'Flare', kind: 'ammo', stack: 10 },
  batteries: { label: 'Batteries', kind: 'res', stack: 10 },
  // food & medicine
  berries:    { label: 'Berries', kind: 'food', stack: 10, food: { hunger: 8, health: 1 } },
  mushroom:   { label: 'Mushrooms', kind: 'food', stack: 10, food: { hunger: 6, health: -2, raw: 0.15 } },
  meatRaw:    { label: 'Raw Meat', kind: 'food', stack: 6, food: { hunger: 10, health: -6, raw: 0.5 }, cook: 'meatCooked' },
  meatCooked: { label: 'Cooked Meat', kind: 'food', stack: 6, food: { hunger: 35, health: 6, warmth: 8 } },
  fishRaw:    { label: 'Raw Fish', kind: 'food', stack: 6, food: { hunger: 8, health: -4, raw: 0.4 }, cook: 'fishCooked' },
  fishCooked: { label: 'Cooked Fish', kind: 'food', stack: 6, food: { hunger: 25, health: 5, warmth: 5 } },
  can:        { label: 'Canned Beans', kind: 'food', stack: 6, food: { hunger: 30, health: 3 } },
  waterBottle:{ label: 'Water', kind: 'food', stack: 4, food: { hunger: 3, health: 4 } },
  herbs:      { label: 'Herbs', kind: 'med', stack: 10, food: { health: 18 } },
  medkit:     { label: 'First Aid', kind: 'med', stack: 4, food: { health: 55 } },
  hideCoat:   { label: 'Hide Coat', kind: 'wear', stack: 1, warmth: 1, desc: 'Worn automatically. Keeps the cold out.' },
  // story
  journal: { label: 'Journal', kind: 'note', stack: 99 },
  note:    { label: 'Note', kind: 'note', stack: 99 },
};

/** recipes: hand crafting (anywhere) or at a workbench */
export const RECIPES = [
  { out: 'torch', n: 1, need: { stick: 1, cloth: 1 }, alt: { stick: 1, resin: 1 }, where: 'hand', desc: 'Light and warmth.' },
  { out: 'axeCrafted', n: 1, need: { stick: 1, stone: 1, rope: 1 }, where: 'hand' },
  { out: 'spear', n: 1, need: { stick: 2, rope: 1 }, where: 'hand' },
  { out: 'club', n: 1, need: { log: 1 }, where: 'hand' },
  { out: 'rope', n: 1, need: { fiber: 3 }, where: 'hand' },
  { out: 'cloth', n: 1, need: { fiber: 2, leaves: 2 }, where: 'hand' },
  { out: 'bow', n: 1, need: { stick: 2, rope: 2 }, where: 'bench' },
  { out: 'arrow', n: 5, need: { stick: 3, feather: 3, stone: 1 }, where: 'bench' },
  { out: 'hideCoat', n: 1, need: { hide: 3, rope: 2 }, where: 'bench' },
  { out: 'emberSpear', n: 1, need: { ashSpearhead: 1, emberStone: 1, stick: 2, rope: 2 }, where: 'bench', story: true, desc: 'What the stones showed. What killed it once.' },
];

/** shelter pieces: what they cost (see ItemArt.createPiece for the models) */
export const PIECES = {
  foundation: { label: 'Foundation', cost: { log: 3 }, hp: 400, grid: true },
  floor:      { label: 'Floor', cost: { log: 2 }, hp: 250, grid: true },
  wall:       { label: 'Wall', cost: { log: 3 }, hp: 300, grid: true, edge: true },
  wallWindow: { label: 'Window Wall', cost: { log: 3 }, hp: 260, grid: true, edge: true },
  wallDoor:   { label: 'Door Wall', cost: { log: 3, rope: 1 }, hp: 260, grid: true, edge: true, door: true },
  roof:       { label: 'Roof', cost: { log: 2, leaves: 4 }, hp: 200, grid: true, roof: true },
  roofFlat:   { label: 'Flat Roof', cost: { log: 2 }, hp: 200, grid: true, roof: true },
  stairs:     { label: 'Stairs', cost: { log: 2 }, hp: 200, grid: true },
  campfire:   { label: 'Campfire', cost: { stick: 4, stone: 4 }, hp: 100, fire: 6 },
  firePit:    { label: 'Fire Pit', cost: { log: 1, stone: 8, stick: 4 }, hp: 200, fire: 9, cook: true },
  bed:        { label: 'Bed', cost: { log: 2, leaves: 8 }, hp: 120, bed: true },
  storage:    { label: 'Storage Box', cost: { log: 3 }, hp: 200, store: true },
  workbench:  { label: 'Workbench', cost: { log: 3, stick: 4 }, hp: 200, bench: true },
  rack:       { label: 'Drying Rack', cost: { stick: 8, rope: 2 }, hp: 100, cook: true },
  spikes:     { label: 'Spike Wall', cost: { log: 2, stick: 6 }, hp: 350, spikes: true, edge: true },
  torchStand: { label: 'Torch Stand', cost: { stick: 2, cloth: 1 }, hp: 60, fire: 4 },
  logPile:    { label: 'Log Pile', cost: { log: 1 }, hp: 200, logStore: true },
  signal:     { label: 'Signal Pyre', cost: { log: 6, stick: 6 }, hp: 200, fire: 14 },
};
export const BUILD_ORDER = ['foundation', 'floor', 'wall', 'wallWindow', 'wallDoor', 'roof', 'roofFlat', 'stairs', 'campfire', 'firePit', 'bed', 'storage', 'workbench', 'rack', 'spikes', 'torchStand', 'logPile'];

export const label = (n) => ITEMS[n]?.label || n;
