import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function getApiKey() {
  if (process.env.API_AUTH_TOKEN) return process.env.API_AUTH_TOKEN;
  const directory = process.env.KILO_BUSTER_CONFIG_DIR || join(homedir(), '.kilo-buster');
  const file = join(directory, 'api-key');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await writeFile(file, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const key = (await readFile(file, 'utf8')).trim();
  if (!key || /[\r\n]/.test(key)) throw new Error('The saved API key is empty or invalid.');
  return key;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(await getApiKey()); } catch (error) { console.error('Could not load API key:', error.message); process.exitCode = 1; }
}
