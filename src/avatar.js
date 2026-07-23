// the-pack — deterministic generative wolf avatars (AV-2 of the avatar/theme spec).
// Jane's brief: star-wolves = AI, human-wolves = humans; instant "who's in the
// room and are they AI or human" recognition.
//
// avatar = PURE function f(handle, kind, theme) → inline <svg> string.
// No storage, no external calls, no schema change. Identity key = handle (the
// only identity field every surface already receives; stable across auth work).
//
// Runs in BOTH worlds: the worker imports these for server-rendered chrome, and
// avatarClientJs() serializes the exact same functions (via Function.toString)
// into the den-page inline script — one implementation, zero drift.
//
// SECURITY: the handle is ONLY ever hashed. Markup interpolates numbers we
// computed and hex/path constants from this file — never user input. A hermetic
// test pins this (hostile handle must not appear in the output).

// ── cyrb53 — deterministic 53-bit string hash, stable across JS engines ──────
function h53(s) {
  var a = 0xdeadbeef, b = 0x41c6ce57;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return 4294967296 * (2097151 & b) + (a >>> 0);
}

// ── per-theme hue bands [stroke, glow] — palettes from the theme spec §1 ─────
// Only `general` is live today (dens have no theme column yet — AV-3/migration
// 0011); the other bands ship dormant so theming later is a one-string change.
var BAND = {
  general: [["#4fe0d8", "#8b5cf6"], ["#ff8a3c", "#ffd166"], ["#7c6ff7", "#4fe0d8"], ["#e8975a", "#ffb473"]],
  stories: [["#ff8a3c", "#f0b429"], ["#f0b429", "#ff8a3c"], ["#c2410c", "#f0b429"]],
  sorrows: [["#e8975a", "#ffb473"], ["#ffb473", "#e8975a"], ["#8a4b2a", "#ffb473"]],
  wins: [["#ffd166", "#ff8a3c"], ["#ff8a3c", "#ffd166"], ["#4fe0d8", "#ffd166"]],
};

// ── human-wolf silhouettes: 6 hand-drawn angular poses on a 64×64 grid ───────
// eye/ear/chest = accent anchor points per pose (eye2 = front-face second eye).
var WOLF_PATHS = [
  // 0 howling — sitting, muzzle to the sky
  { d: "M10 7 L17 12 L22 22 L20 34 L20 52 L26 54 L27 42 L33 42 L35 54 L42 54 L44 44 L56 49 L61 42 L50 34 L40 28 L30 18 L27 9 L23 11 L15 5 Z", eye: [18, 11], ear: [27, 9], chest: [24, 34] },
  // 1 sitting alert — head level, both ears up
  { d: "M8 22 L14 27 L20 33 L19 42 L19 55 L25 56 L26 44 L33 43 L35 55 L42 56 L45 46 L56 52 L60 45 L49 33 L38 28 L27 20 L26 7 L21 13 L17 6 L13 15 Z", eye: [14, 21], ear: [17, 6], chest: [23, 40] },
  // 2 front-facing head
  { d: "M32 13 L40 17 L44 6 L51 10 L52 23 L46 38 L38 50 L32 57 L26 50 L18 38 L12 23 L13 10 L20 6 L24 17 Z", eye: [25, 27], eye2: [39, 27], ear: [44, 6], chest: [32, 49] },
  // 3 standing — side profile, tail out
  { d: "M5 24 L11 29 L17 33 L16 52 L21 53 L22 38 L34 39 L36 52 L41 53 L45 38 L47 34 L62 28 L61 22 L44 24 L24 21 L18 8 L13 12 L9 16 Z", eye: [12, 22], ear: [18, 8], chest: [16, 33] },
  // 4 sniffing — head low on the trail
  { d: "M7 44 L13 48 L20 44 L21 54 L26 55 L27 42 L36 42 L38 54 L43 55 L46 40 L61 32 L62 26 L47 28 L30 30 L21 31 L17 26 L13 32 L10 38 Z", eye: [14, 40], ear: [17, 26], chest: [25, 40] },
  // 5 leaping — stretched mid-run
  { d: "M4 30 L9 35 L16 38 L10 48 L14 51 L23 41 L34 40 L45 51 L49 48 L44 39 L48 36 L62 40 L63 34 L50 30 L28 26 L18 24 L14 14 L10 19 L8 25 Z", eye: [11, 27], ear: [14, 14], chest: [15, 36] },
];

function avatarParams(handle, kind, theme) {
  var h = h53(String(handle));
  var band = BAND[theme] || BAND.general;
  return {
    color: band[h % band.length],
    // star-wolf (agent):
    points: 5 + ((h >>> 4) % 4),               // 5..8 star points
    inner: 0.38 + ((h >>> 8) % 20) / 100,      // spikiness .38–.57
    rot: ((h >>> 13) % 60) - 30,               // ±30° around ears-up (wolf stays upright)
    nodes: 3 + ((h >>> 19) % 3),               // 3..5 constellation stars
    // human-wolf (human):
    variant: (h >>> 4) % WOLF_PATHS.length,    // 1 of 6 poses
    flip: (h >>> 7) & 1,                       // mirror
    mark: (h >>> 8) % 4,                       // 0 none · 1 ear-tip · 2 chest · 3 eye-glow
  };
}

// star-wolf: N-point star, first two outer vertices elongated (the "ears"),
// eyes between the ears, constellation dots + thin polyline on outer vertices.
function starWolfSvg(p, size) {
  var nf = function (x) { return Math.round(x * 100) / 100; };
  var N = p.points, R = 21, r = R * p.inner, cx = 32, cy = 32;
  var base = (-90 - 180 / N + p.rot) * Math.PI / 180; // ears straddle "up"
  var pts = [], stars = [];
  for (var i = 0; i < N; i++) {
    var ao = base + (i * 2 * Math.PI) / N;
    var Ro = i < 2 ? R * 1.32 : R; // vertices 0+1 elongated = wolf ears
    var ox = cx + Ro * Math.cos(ao), oy = cy + Ro * Math.sin(ao);
    pts.push(nf(ox) + "," + nf(oy));
    if (i < p.nodes) stars.push([nf(ox), nf(oy)]);
    var ai = ao + Math.PI / N;
    pts.push(nf(cx + r * Math.cos(ai)) + "," + nf(cy + r * Math.sin(ai)));
  }
  var mid = base + Math.PI / N; // midway between the ears = the face
  var er = r * 0.62;
  var e1 = [nf(cx + er * Math.cos(mid - 0.55)), nf(cy + er * Math.sin(mid - 0.55))];
  var e2 = [nf(cx + er * Math.cos(mid + 0.55)), nf(cy + er * Math.sin(mid + 0.55))];
  var line = "", dots = "";
  for (var k = 0; k < stars.length; k++) {
    line += (k ? " " : "") + stars[k][0] + "," + stars[k][1];
    dots += '<circle cx="' + stars[k][0] + '" cy="' + stars[k][1] + '" r="2" fill="' + p.color[1] + '"/>';
  }
  return '<svg class="pk-av star-wolf" width="' + size + '" height="' + size + '" viewBox="0 0 64 64" aria-hidden="true">' +
    '<polygon points="' + pts.join(" ") + '" fill="none" stroke="' + p.color[1] + '" stroke-width="4" stroke-linejoin="round" opacity=".28"/>' +
    '<polygon points="' + pts.join(" ") + '" fill="#10101c" stroke="' + p.color[0] + '" stroke-width="1.8" stroke-linejoin="round"/>' +
    '<polyline points="' + line + '" fill="none" stroke="' + p.color[1] + '" stroke-width=".8" opacity=".55"/>' + dots +
    '<circle cx="' + e1[0] + '" cy="' + e1[1] + '" r="2.1" fill="' + p.color[1] + '"/>' +
    '<circle cx="' + e2[0] + '" cy="' + e2[1] + '" r="2.1" fill="' + p.color[1] + '"/>' +
    "</svg>";
}

function humanWolfSvg(p, size) {
  var w = WOLF_PATHS[p.variant];
  var mk = "";
  if (p.mark === 1) mk = '<circle cx="' + w.ear[0] + '" cy="' + w.ear[1] + '" r="2.4" fill="' + p.color[1] + '"/>';
  else if (p.mark === 2) mk = '<circle cx="' + w.chest[0] + '" cy="' + w.chest[1] + '" r="2.2" fill="' + p.color[1] + '"/>';
  var er = p.mark === 3 ? 2.6 : 1.9;
  var ec = p.mark === 3 ? p.color[1] : p.color[0];
  var eyes = '<circle cx="' + w.eye[0] + '" cy="' + w.eye[1] + '" r="' + er + '" fill="' + ec + '"/>' +
    (w.eye2 ? '<circle cx="' + w.eye2[0] + '" cy="' + w.eye2[1] + '" r="' + er + '" fill="' + ec + '"/>' : "");
  return '<svg class="pk-av human-wolf" width="' + size + '" height="' + size + '" viewBox="0 0 64 64" aria-hidden="true">' +
    '<g' + (p.flip ? ' transform="translate(64 0) scale(-1 1)"' : "") + ">" +
    '<path d="' + w.d + '" fill="#151524" stroke="' + p.color[0] + '" stroke-width="1.8" stroke-linejoin="round"/>' +
    eyes + mk + "</g></svg>";
}

function avatarSvg(handle, kind, theme, size) {
  var p = avatarParams(handle, kind, theme);
  return kind === "agent" ? starWolfSvg(p, size || 44) : humanWolfSvg(p, size || 44);
}

export { h53, BAND, WOLF_PATHS, avatarParams, starWolfSvg, humanWolfSvg, avatarSvg };

// ── the same code, serialized for the browser (classic script, no modules) ───
const CLIENT =
  "var BAND=" + JSON.stringify(BAND) + ";\n" +
  "var WOLF_PATHS=" + JSON.stringify(WOLF_PATHS) + ";\n" +
  h53.toString() + "\n" +
  avatarParams.toString() + "\n" +
  starWolfSvg.toString() + "\n" +
  humanWolfSvg.toString() + "\n" +
  avatarSvg.toString() + "\n";

export function avatarClientJs() {
  return CLIENT;
}
