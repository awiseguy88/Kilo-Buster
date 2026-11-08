import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
test('API key persists across launches and accepts an explicit override',()=>{
  const dir=mkdtempSync(join(tmpdir(),'kilo-key-'));
  const env={...process.env,KILO_BUSTER_CONFIG_DIR:dir}; delete env.API_AUTH_TOKEN;
  const run=variables=>execFileSync(process.execPath,[resolve('api-key.mjs')],{env:variables,encoding:'utf8'}).trim();
  try { const first=run(env); assert.match(first,/^[0-9a-f]{64}$/); assert.equal(run(env),first); assert.equal(run({...env,API_AUTH_TOKEN:'custom-key'}),'custom-key'); assert.equal(run(env),first); }
  finally { rmSync(dir,{recursive:true,force:true}); }
});
