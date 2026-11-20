// Posts approved Stonekite posts to Instagram and the Facebook Page when they're due.
// Runs in GitHub Actions every 15 minutes (see post.yml) inside the poster repo. It only ever
// publishes folders in queue/, which only social/export.mjs writes, and only for posts carrying
// the owner's recorded yes. No other path to publishing exists.
//
// Uses the Instagram API with Facebook Login (graph.facebook.com): one Page token covers the
// Page and the Instagram professional account linked to it. Instagram can only fetch images
// from a public address, so images are read from this repo's public raw URLs (RAW_BASE).
//
// Env: IG_USER_ID, PAGE_ID, PAGE_TOKEN (GitHub secrets), RAW_BASE, GRAPH_VERSION (default v23.0),
//      DRY_RUN=1 (print the requests, publish nothing), NOW (ISO time, for tests), ALT_TEXT=1
//      (send alt text on Instagram images; off until the first live test confirms the field),
//      WAIT_AHEAD_MIN (if an approved post is due within this many minutes, wait for it and post
//      it on time; GitHub's schedule only ran about every 6 hours in Nov 2026, so post.yml sets 330).
// Usage: node publish/post.mjs [queueDir]
import { readdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const env = process.env;
const DRY = !!env.DRY_RUN;
const G = `https://graph.facebook.com/${env.GRAPH_VERSION || 'v23.0'}`;
let NOW = env.NOW ? new Date(env.NOW) : new Date();
const WAIT_MS = (Number(env.WAIT_AHEAD_MIN) || 0) * 60e3;
const LATE_MS = 6 * 3600e3; // a post more than 6 hours late is held and reported, never posted silently
const QUEUE = process.argv[2] || 'queue';

// Keys are only required once a post is actually due, so an empty queue never fails a run.
const missingKeys = () => ['IG_USER_ID', 'PAGE_ID', 'PAGE_TOKEN', 'RAW_BASE'].filter((k) => !env[k]);

// A local date and time in a time zone → the real moment (UTC).
export function zoned(date, time, tz) {
  const guess = Date.parse(`${date}T${time}:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asIfUtc = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
  return new Date(guess - (asIfUtc - guess));
}

let fake = 0;
async function api(method, path, params = {}) {
  if (DRY) {
    const shown = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, k === 'caption' || k === 'message' ? `${String(v).slice(0, 40)}…` : v]));
    console.log(`    [dry run] ${method} ${path} ${JSON.stringify(shown)}`);
    return { id: `dry${++fake}`, status_code: 'FINISHED', permalink: 'https://instagram.com/p/dry' };
  }
  const body = new URLSearchParams({ ...params, access_token: env.PAGE_TOKEN });
  const res = method === 'GET' ? await fetch(`${G}${path}?${body}`) : await fetch(`${G}${path}`, { method, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`${method} ${path}: ${json.error?.message || res.status}`);
  return json;
}

async function ready(container) {
  for (let i = 0; i < 30; i++) {
    const { status_code } = await api('GET', `/${container}`, { fields: 'status_code' });
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Error(`Instagram could not process container ${container} (${status_code})`);
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`container ${container} still not ready after 2 minutes`);
}

async function toInstagram(p, urls) {
  const ig = env.IG_USER_ID || 'IG_USER_ID';
  const alt = (i) => (env.ALT_TEXT && p.alt?.[i] ? { alt_text: p.alt[i] } : {});
  let creation;
  if (urls.length === 1) {
    creation = (await api('POST', `/${ig}/media`, { image_url: urls[0], caption: p.caption, ...alt(0) })).id;
  } else {
    const children = [];
    for (const [i, u] of urls.entries()) children.push((await api('POST', `/${ig}/media`, { image_url: u, is_carousel_item: 'true', ...alt(i) })).id);
    for (const c of children) await ready(c);
    creation = (await api('POST', `/${ig}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: p.caption })).id;
  }
  await ready(creation);
  const { id } = await api('POST', `/${ig}/media_publish`, { creation_id: creation });
  const { permalink } = await api('GET', `/${id}`, { fields: 'permalink' });
  return { id, permalink };
}

async function toFacebook(p, urls) {
  const page = env.PAGE_ID || 'PAGE_ID';
  if (urls.length === 1) {
    const r = await api('POST', `/${page}/photos`, { url: urls[0], message: p.caption });
    return { id: r.post_id || r.id };
  }
  const media = [];
  for (const u of urls) media.push({ media_fbid: (await api('POST', `/${page}/photos`, { url: u, published: 'false' })).id });
  return { id: (await api('POST', `/${page}/feed`, { message: p.caption, attached_media: JSON.stringify(media) })).id };
}

// Sleep until the next approved, unposted post if it's due within WAIT_AHEAD_MIN.
async function waitForNext(folders) {
  let next = null;
  for (const f of folders) {
    const dir = join(QUEUE, f);
    const p = JSON.parse(await readFile(join(dir, 'post.json'), 'utf8'));
    const done = await access(join(dir, 'posted.json')).then(async () => JSON.parse(await readFile(join(dir, 'posted.json'), 'utf8')), () => ({}));
    if (!p.approved || done.held || (done.instagram && done.facebook)) continue;
    const due = zoned(p.date, p.time, p.timezone || 'America/New_York');
    if (due > NOW && due - NOW <= WAIT_MS && (!next || due < next.due)) next = { f, due };
  }
  if (!next) return;
  console.log(`waiting for ${next.f} (due ${next.due.toISOString()}, ${Math.round((next.due - NOW) / 60e3)} min)`);
  await new Promise((r) => setTimeout(r, next.due - NOW + 5e3));
  NOW = new Date();
}

if (process.argv[1]?.endsWith('post.mjs')) await main();

async function main() {
const folders = (await readdir(QUEUE, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name).sort();
let failures = 0;
if (WAIT_MS && !DRY) await waitForNext(folders);
for (const f of folders) {
  const dir = join(QUEUE, f);
  const p = JSON.parse(await readFile(join(dir, 'post.json'), 'utf8'));
  const donePath = join(dir, 'posted.json');
  const done = await access(donePath).then(async () => JSON.parse(await readFile(donePath, 'utf8')), () => ({}));
  if (done.instagram && done.facebook) continue;
  if (!p.approved) { console.log(`skip ${f}: no record of the owner's yes`); continue; }
  const due = zoned(p.date, p.time, p.timezone || 'America/New_York');
  if (due > NOW) continue;
  if (NOW - due > LATE_MS && !done.instagram && !done.facebook) { if (!done.held) { done.held = `more than 6 hours late at ${NOW.toISOString()}: not posted, ask the owner`; if (!DRY) await writeFile(donePath, JSON.stringify(done, null, 2)); } console.log(`HELD ${f}: ${done.held}`); continue; }

  if (!DRY && missingKeys().length) { failures++; console.log(`NOT POSTED ${f}: missing ${missingKeys().join(', ')} (GitHub secrets)`); continue; }
  console.log(`posting ${f} (due ${due.toISOString()})`);
  const urls = p.files.map((file) => `${(env.RAW_BASE || 'RAW_BASE').replace(/\/$/, '')}/${QUEUE}/${encodeURIComponent(f)}/${file}`);
  for (const [name, fn] of [['instagram', toInstagram], ['facebook', toFacebook]]) {
    if (done[name]) continue;
    try {
      done[name] = { ...(await fn(p, urls)), at: new Date().toISOString() };
      console.log(`  ${name}: ${done[name].permalink || done[name].id}`);
    } catch (e) {
      failures++;
      done[`${name}Error`] = `${new Date().toISOString()} ${e.message}`;
      console.log(`  ${name} FAILED: ${e.message}`);
    }
  }
  if (!DRY) await writeFile(donePath, JSON.stringify(done, null, 2));
}
process.exit(failures ? 1 : 0); // a failed run shows red in GitHub and emails the owner
}
