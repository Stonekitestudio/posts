// Confirms the Page key works, printing only names and IDs, never the key itself.
// Reads PAGE_TOKEN from the environment or ~/.config/stonekite/social.env.
// Usage (through the symlink): node social/publish/check-connection.mjs
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const G = `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v23.0'}`;
let token = process.env.PAGE_TOKEN;
if (!token) token = (await readFile(join(homedir(), '.config/stonekite/social.env'), 'utf8').catch(() => '')).match(/^PAGE_TOKEN=(.*)$/m)?.[1]?.trim();
if (!token) { console.log('No key yet: paste the Page access_token after PAGE_TOKEN= in ~/.config/stonekite/social.env'); process.exit(1); }

const get = async (path, params = {}) => {
  const q = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${G}${path}?${q}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error?.message || String(res.status));
  return json;
};

try {
  const me = await get('/me', { fields: 'id,name,instagram_business_account{id,username}' });
  const ig = me.instagram_business_account;
  console.log(`Page: ${me.name} (PAGE_ID ${me.id})`);
  console.log(ig ? `Instagram: @${ig.username} (IG_USER_ID ${ig.id})` : 'Instagram: none linked to this Page, or the key lacks instagram_basic');
  // when the saved IDs are present too (GitHub secrets), confirm they match the key
  if (process.env.PAGE_ID) console.log(`Saved PAGE_ID ${process.env.PAGE_ID === me.id ? 'matches' : 'DOES NOT MATCH'} the key's Page`);
  if (process.env.IG_USER_ID) console.log(`Saved IG_USER_ID ${process.env.IG_USER_ID === ig?.id ? 'matches' : 'DOES NOT MATCH'} the Page's Instagram`);
  const dbg = await get('/debug_token', { input_token: token }).catch(() => null);
  if (dbg?.data) {
    const d = dbg.data;
    console.log(`Key type: ${d.type}; expires: ${d.expires_at ? new Date(d.expires_at * 1000).toISOString() : 'never'}`);
    console.log(`Permissions: ${(d.scopes || []).join(', ')}`);
  }
} catch (e) {
  console.log(`The key didn't work: ${e.message}`);
  process.exit(1);
}
