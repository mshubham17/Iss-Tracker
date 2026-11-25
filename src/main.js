import Globe from 'globe.gl';
import * as THREE from 'three';
import * as sat from 'satellite.js';

const API = 'https://api.wheretheiss.at/v1/satellites/25544';
const R = 6371;
const $ = id => document.getElementById(id);

let iss = null;          // latest live reading
let satrec = null;       // from a current TLE, used for the orbit path
let follow = true, showOrbit = true;
let me = null;           // { lat, lng, name } once the user shares a location

/* ---------- globe ---------- */
const sunLight = new THREE.DirectionalLight(0xffffff, 2.4);
const world = Globe()($('globe'))
  .globeImageUrl('/img/earth-blue-marble.jpg')
  .bumpImageUrl('/img/earth-topology.png')
  .backgroundColor('#05070a')
  .atmosphereColor('#9db4c8').atmosphereAltitude(0.12)
  .lights([new THREE.AmbientLight(0x2a3340, 1.2), sunLight])
  // orbit path
  .pathPointLat(p => p[0]).pathPointLng(p => p[1]).pathPointAlt(p => p[2])
  .pathColor(p => p.past ? ['rgba(255,255,255,0)', 'rgba(255,255,255,0.55)'] : ['rgba(255,255,255,0.55)', 'rgba(255,255,255,0)'])
  .pathStroke(0.25).pathTransitionDuration(0)
  // footprint
  .polygonCapColor(() => 'rgba(255,255,255,0.05)').polygonSideColor(() => 'rgba(0,0,0,0)')
  .polygonStrokeColor(() => 'rgba(255,255,255,0.35)').polygonAltitude(0.002)
  // pulse at ISS
  .ringColor(d => t => `rgba(255,255,255,${0.6 * (1 - t)})`).ringMaxRadius(4).ringPropagationSpeed(3).ringRepeatPeriod(1400)
  // user marker + line to ISS
  .pointLat('lat').pointLng('lng').pointColor(() => '#ffffff').pointAltitude(0.005).pointRadius(0.25)
  .pointLabel(d => d.name)
  .arcColor(() => ['rgba(255,255,255,0.1)', 'rgba(255,255,255,0.7)']).arcStroke(0.2).arcDashLength(0.4).arcDashGap(0.2).arcDashAnimateTime(2000)
  .arcAltitudeAutoScale(0.4)
  // ISS model
  .objectLat('lat').objectLng('lng').objectAltitude('alt').objectFacesSurface(true)
  .objectThreeObject(() => makeISS())
  .objectLabel(() => 'ISS · click to follow')
  .onObjectClick(() => { follow = true; $('follow').setAttribute('aria-pressed', true); if (iss) update(); });

world.controls().autoRotateSpeed = 0.6;
world.pointOfView({ lat: 20, lng: 78, altitude: 2.4 });
window.addEventListener('resize', () => world.width(innerWidth).height(innerHeight));

function makeISS() {
  const g = new THREE.Group();
  const gold = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const panel = new THREE.MeshBasicMaterial({ color: 0xaab4c0 });
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 2.6), gold));                       // truss
  for (const s of [-1, 1]) for (const z of [0.9, -0.9]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.04, 0.8), panel);
    p.position.set(s * 1.3, 0, z); g.add(p);
  }
  g.scale.setScalar(1.5);
  return g;
}

/* ---------- live position ---------- */
async function poll() {
  try {
    const r = await fetch(API);
    iss = await r.json();
    $('live').classList.add('on'); $('status').textContent = '';
    update();
  } catch (e) {
    $('live').classList.remove('on');
    $('status').textContent = 'Live feed unavailable, retrying…';
  }
}

function update() {
  const { latitude: lat, longitude: lng, altitude, velocity, visibility, footprint, solar_lat, solar_lon } = iss;
  const alt = altitude / R;
  world.objectsData([{ lat, lng, alt }]);
  world.ringsData([{ lat, lng }, ...(me ? [{ lat: me.lat, lng: me.lng, user: true }] : [])]);
  world.polygonsData([circle(lat, lng, footprint / 2 / R)]);

  const c = world.getCoords(solar_lat, solar_lon, 5);
  sunLight.position.set(c.x, c.y, c.z);

  if (follow) world.pointOfView({ lat, lng, altitude: Math.max(world.pointOfView().altitude, 1.4) }, 1500);

  $('lat').textContent = fmt(lat, 'N', 'S'); $('lon').textContent = fmt(lng, 'E', 'W');
  $('alt').textContent = altitude.toFixed(0) + ' km';
  $('spd').textContent = Math.round(velocity).toLocaleString('en-US') + ' km/h';
  $('vis').textContent = visibility === 'daylight' ? 'Daylight' : visibility === 'eclipsed' ? 'Earth shadow' : 'Twilight';
  $('fp').textContent = Math.round(footprint).toLocaleString('en-US') + ' km wide';
  maybeGeocode(lat, lng);
  updateYou();
}
const fmt = (v, p, n) => Math.abs(v).toFixed(2) + '° ' + (v >= 0 ? p : n);

function circle(lat, lng, ang) {            // GeoJSON polygon on the sphere, ang in radians
  const pts = [], la = lat * Math.PI / 180, lo = lng * Math.PI / 180;
  for (let b = 0; b <= 360; b += 6) {
    const br = b * Math.PI / 180;
    const la2 = Math.asin(Math.sin(la) * Math.cos(ang) + Math.cos(la) * Math.sin(ang) * Math.cos(br));
    const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(ang) * Math.cos(la), Math.cos(ang) - Math.sin(la) * Math.sin(la2));
    pts.push([((lo2 * 180 / Math.PI + 540) % 360) - 180, la2 * 180 / Math.PI]);
  }
  return { type: 'Polygon', coordinates: [pts] };
}

/* ---------- "what is it over?" ---------- */
let lastGeo = 0;
async function maybeGeocode(lat, lng) {
  if (Date.now() - lastGeo < 8000) return;
  lastGeo = Date.now();
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`);
    const d = await r.json();
    const place = [d.locality || d.city, d.principalSubdivision, d.countryName].filter(Boolean);
    $('over').textContent = place.length ? 'Over ' + [...new Set(place)].join(', ') : 'Over open ocean';
  } catch { /* keep previous text */ }
}

/* ---------- orbit path from a current TLE ---------- */
async function loadTLE() {
  try {
    const t = await (await fetch(API + '/tles?format=text')).text();
    const [l1, l2] = t.split(/\r?\n/).map(s => s.trim()).filter(l => /^[12] /.test(l));
    satrec = sat.twoline2satrec(l1, l2);
  } catch { $('status').textContent = 'Could not load orbit data; orbit path hidden.'; }
}
function drawOrbit() {
  if (!satrec || !showOrbit) { world.pathsData([]); return; }
  const now = Date.now(), past = [], future = [];
  for (let m = -45; m <= 95; m += 1) {
    const d = new Date(now + m * 60000), p = sat.propagate(satrec, d);
    if (!p.position) continue;
    const g = sat.eciToGeodetic(p.position, sat.gstime(d));
    const pt = [sat.degreesLat(g.latitude), sat.degreesLong(g.longitude), g.height / R];
    (m <= 0 ? past : future).push(pt);
  }
  if (past.length && future.length) future.unshift(past[past.length - 1]);
  world.pathsData([{ pts: past, past: true }, { pts: future }]).pathPoints('pts');
}

/* ---------- crew ---------- */
async function loadCrew() {
  try {
    const d = await (await fetch('http://api.open-notify.org/astros.json')).json();
    const names = d.people.filter(p => p.craft === 'ISS').map(p => p.name);
    if (names.length) $('crew').textContent = names.join(' · ');
  } catch { /* crew list is optional (the API is http-only) */ }
}

/* ---------- your location ---------- */
const DIRS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
const deg = r => r * 180 / Math.PI, rad = d => d * Math.PI / 180;
const observer = () => ({ latitude: rad(me.lat), longitude: rad(me.lng), height: 0 });

function haversine(lat1, lng1, lat2, lng2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function lookAt(date, gd) {                 // gd: {latitude, longitude (rad), height (km)}
  const ecf = sat.geodeticToEcf(gd);
  return sat.ecfToLookAngles(observer(), ecf);   // azimuth, elevation (rad), rangeSat km
}
const compass = az => DIRS[Math.round(az / 22.5) % 16];
const fmtTime = d => d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

let lastPass = 0, pass = null;
function nextPass() {
  if (!satrec || !me) return null;
  const start = Date.now();
  let rise = null, max = 0, riseAz = 0, maxAz = 0;
  for (let s = 0; s <= 36 * 3600; s += 30) {
    const d = new Date(start + s * 1000), p = sat.propagate(satrec, d);
    if (!p.position) continue;
    const la = sat.ecfToLookAngles(observer(), sat.eciToEcf(p.position, sat.gstime(d)));
    const el = deg(la.elevation), az = (deg(la.azimuth) + 360) % 360;
    if (el > 0) { if (!rise) { rise = d; riseAz = az; } if (el > max) { max = el; maxAz = az; } }
    else if (rise) return { rise, set: d, max, riseAz, maxAz, now: rise.getTime() <= start + 30000 };
  }
  return null;
}

function updateYou() {
  if (!me || !iss) return;
  const gd = { latitude: rad(iss.latitude), longitude: rad(iss.longitude), height: iss.altitude };
  const la = lookAt(new Date(), gd);
  const el = deg(la.elevation), az = (deg(la.azimuth) + 360) % 360;
  const dist = haversine(me.lat, me.lng, iss.latitude, iss.longitude);
  $('u-dist').textContent = Math.round(dist).toLocaleString('en-US') + ' km';
  $('u-dir').textContent = DIRS[Math.round(az / 22.5) % 16] + ' ' + Math.round(az) + '°';
  $('u-el').textContent = el.toFixed(0) + '°';
  const st = $('you-state');
  if (el > 0) {
    const dark = iss.visibility !== 'daylight';
    st.textContent = dark ? 'Above your horizon, look up' : 'Above your horizon (too bright to see)';
    st.className = 'state up';
  } else { st.textContent = 'Below your horizon'; st.className = 'state down'; }
  world.arcsData([{ startLat: me.lat, startLng: me.lng, endLat: iss.latitude, endLng: iss.longitude }]);
  if (Date.now() - lastPass > 60000) { lastPass = Date.now(); pass = nextPass(); }
  if (pass) {
    const mins = Math.round((pass.rise - Date.now()) / 60000);
    $('u-pass').textContent = pass.now || mins <= 0 ? 'Now' : mins < 60 ? 'in ' + mins + ' min' : fmtTime(pass.rise);
    $('u-pass-detail').textContent = `Rises ${fmtTime(pass.rise)}, peaks ${pass.max.toFixed(0)}° high, lasts ~${Math.max(1, Math.round((pass.set - pass.rise) / 60000))} min.`;
  } else { $('u-pass').textContent = satrec ? '>36 h' : '--'; $('u-pass-detail').textContent = ''; }
  updateBanner(el);
}

function updateBanner(el) {
  const b = $('banner');
  if (!pass) { b.hidden = true; return; }
  const mins = (pass.rise - Date.now()) / 60000;
  if (el > 0) {
    b.textContent = `Overhead now. Go outside and wave.`;
    b.className = 'now';
  } else if (mins <= 15 && mins > 0) {
    b.textContent = `Arriving in ${Math.max(1, Math.round(mins))} min`;
    b.className = 'soon';
  } else {
    b.textContent = `Next pass over ${me.name || 'you'}: ${fmtTime(pass.rise)}`;
    b.className = '';
  }
  b.hidden = false;
  if (mins <= 10 && mins > 0 && notifiedFor !== +pass.rise) {
    notifiedFor = +pass.rise;
    if ('Notification' in window && Notification.permission === 'granted')
      new Notification('ISS overhead', { body: b.textContent });
  }
}
let notifiedFor = 0;

function setLocation(loc, save = true) {
  me = loc;
  if (save) localStorage.setItem('iss-loc', JSON.stringify(loc));
  $('welcome').hidden = true; $('you').hidden = false; $('change').textContent = 'Change location';
  $('you-name').textContent = loc.name || 'you';
  world.pointsData([{ lat: loc.lat, lng: loc.lng, name: loc.name || 'You' }]);
  lastPass = 0; pass = null;
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  follow = false; $('follow').setAttribute('aria-pressed', false);
  world.pointOfView({ lat: loc.lat, lng: loc.lng, altitude: 1.8 }, 1200);
  if (iss) update();
}
const wmsg = t => { $('w-msg').textContent = t; };

$('w-geo').addEventListener('click', () => {
  if (!navigator.geolocation) return wmsg('Geolocation is not supported here. Try searching for a city.');
  wmsg('Waiting for permission…');
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lng } = pos.coords;
    let name = 'your location';
    try {
      const d = await (await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`)).json();
      name = d.locality || d.city || d.countryName || name;
    } catch {}
    setLocation({ lat, lng, name });
  }, err => wmsg(err.code === 1 ? 'Permission denied. Search for a city instead.' : 'Could not get your location. Search for a city instead.'),
  { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
});

$('w-card').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('w-q').value.trim(), list = $('w-results');
  if (!q) return;
  list.replaceChildren(); wmsg('Searching…');
  try {
    const d = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&name=${encodeURIComponent(q)}`)).json();
    if (!d.results?.length) return wmsg('No matches. Try another spelling.');
    wmsg('Pick one:');
    for (const r of d.results) {
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button';
      b.textContent = [r.name, r.admin1, r.country].filter(Boolean).join(', ');
      b.addEventListener('click', () => setLocation({ lat: r.latitude, lng: r.longitude, name: r.name }));
      li.append(b); list.append(li);
    }
  } catch { wmsg('Search failed. Check your connection and retry.'); }
});
const closeWelcome = () => { $('welcome').hidden = true; };
$('w-skip').addEventListener('click', closeWelcome);
$('welcome').addEventListener('click', e => { if (e.target === $('welcome')) closeWelcome(); });
addEventListener('keydown', e => { if (e.key === 'Escape') closeWelcome(); });
$('change').addEventListener('click', () => { $('welcome').hidden = false; $('w-q').focus(); });

try { const saved = JSON.parse(localStorage.getItem('iss-loc')); if (saved) setLocation(saved, false); } catch {}

/* ---------- controls ---------- */
function toggle(id, get, set) {
  const b = $(id);
  b.addEventListener('click', () => { const v = !get(); set(v); b.setAttribute('aria-pressed', v); });
}
toggle('follow', () => follow, v => { follow = v; if (v && iss) update(); });
toggle('orbit', () => showOrbit, v => { showOrbit = v; drawOrbit(); });
toggle('spin', () => world.controls().autoRotate, v => { world.controls().autoRotate = v; if (v) { follow = false; $('follow').setAttribute('aria-pressed', false); } });
// dragging the globe hands control back to the user
world.controls().addEventListener('start', () => { follow = false; $('follow').setAttribute('aria-pressed', false); });

/* ---------- go ---------- */
poll(); setInterval(poll, 3000);
loadTLE().then(() => { drawOrbit(); lastPass = 0; updateYou(); }); setInterval(drawOrbit, 30000); setInterval(loadTLE, 6 * 3600 * 1000);
loadCrew();
