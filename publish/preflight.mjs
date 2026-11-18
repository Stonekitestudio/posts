// Rehearses the next queued post without publishing anything, so a problem shows up before
// posting time. Instagram: creates a media container from the first image and waits until
// Instagram has fetched and processed it. The container is never published and expires on its
// own within 24 hours. Facebook: uploads the image as an unpublished photo, then deletes it.
// Runs in the check workflow. Env as post.mjs: IG_USER_ID, PAGE_ID, PAGE_TOKEN, RAW_BASE.
import { readdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const env = process.env;
const G = `https://graph.facebook.com/${env.GRAPH_VERSION || 'v23.0'}`;
const QUEUE = 'queue';
async function api(method, path, params = {}) {
  const body = new URLSearchParams({ ...params, access_token: env.PAGE_TOKEN });
  const res = method === 'GET' ? await fetch(`${G}${path}?${body}`) : await fetch(`${G}${path}`, { method, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`${method} ${path.replace(/\d{6,}/g, '…')}: ${json.error?.message || res.status}`);
  return json;
}

const folders = (await readdir(QUEUE, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => d.name).sort();
let next;
for (const f of folders) if (!(await access(join(QUEUE, f, 'posted.json')).then(() => true, () => false))) { next = f; break; }
if (!next) { console.log('Nothing queued to rehearse.'); process.exit(0); }
const p = JSON.parse(await readFile(join(QUEUE, next, 'post.json'), 'utf8'));
const url = `${env.RAW_BASE.replace(/\/$/, '')}/${QUEUE}/${encodeURIComponent(next)}/${p.files[0]}`;
console.log(`Rehearsing ${next} (${p.files.length} image${p.files.length > 1 ? 's' : ''}, due ${p.date} ${p.time} ${p.timezone})`);

let ok = true;
try {
  const head = await fetch(url, { method: 'HEAD' });
  console.log(`Image address: ${head.status} ${head.headers.get('content-type')}`);
  const c = await api('POST', `/${env.IG_USER_ID}/media`, { image_url: url, ...(p.files.length > 1 ? { is_carousel_item: 'true' } : { caption: '' }) });
  let status = '';
  for (let i = 0; i < 20 && status !== 'FINISHED'; i++) {
    status = (await api('GET', `/${c.id}`, { fields: 'status_code' })).status_code;
    if (status === 'ERROR' || status === 'EXPIRED') break;
    if (status !== 'FINISHED') await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`Instagram fetched and prepared the image: ${status} (not published)`);
  if (status !== 'FINISHED') ok = false;
} catch (e) { ok = false; console.log(`Instagram rehearsal failed: ${e.message}`); }
try {
  const ph = await api('POST', `/${env.PAGE_ID}/photos`, { url, published: 'false' });
  await api('DELETE', `/${ph.id}`);
  console.log('Facebook fetched the image as an unpublished photo, then it was deleted');
} catch (e) { ok = false; console.log(`Facebook rehearsal failed: ${e.message}`); }
console.log(ok ? 'REHEARSAL PASSED' : 'REHEARSAL FAILED');
process.exit(ok ? 0 : 1);
