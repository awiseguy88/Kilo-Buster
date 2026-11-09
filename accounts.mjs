import { createHash, randomBytes, scrypt, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const keyMaterial = () => createHash('sha256').update(process.env.KEY_ENCRYPTION_SECRET || process.env.ADMIN_PASSWORD || 'missing-key-secret').digest();
function protect(value) {
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',keyMaterial(),iv);
  const body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return [iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),body.toString('base64url')].join('.');
}
function reveal(value) {
  if(!value) return null;
  try { const [iv,tag,body]=value.split('.'); const decipher=createDecipheriv('aes-256-gcm',keyMaterial(),Buffer.from(iv,'base64url')); decipher.setAuthTag(Buffer.from(tag,'base64url')); return Buffer.concat([decipher.update(Buffer.from(body,'base64url')),decipher.final()]).toString('utf8'); } catch { return null; }
}
export const hour = 3600000;
export const validLimit = n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000;
export const sameSecret = (a,b) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));

export function accounts(db, defaultLimit) {
  if (!validLimit(defaultLimit)) throw Error('Invalid DEFAULT_REQUESTS_PER_HOUR');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password TEXT NOT NULL, quota INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, trial_until INTEGER,
      key_hash TEXT UNIQUE, suffix TEXT, total INTEGER NOT NULL DEFAULT 0,
      input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, uid INTEGER, admin_tag TEXT, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (uid INTEGER NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS requests_window ON requests(uid,at);
    CREATE INDEX IF NOT EXISTS requests_expiry ON requests(at);
  `);
  const query = sql => db.prepare(sql);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL REFERENCES users(id),
      hash TEXT NOT NULL UNIQUE, suffix TEXT NOT NULL, quota INTEGER NOT NULL CHECK(quota>=0), secret TEXT);
      CREATE INDEX IF NOT EXISTS keys_owner ON api_keys(uid);`);
    if (!query("SELECT 1 FROM pragma_table_info('api_keys') WHERE name='secret'").get()) db.exec('ALTER TABLE api_keys ADD COLUMN secret TEXT');
    if (!query("SELECT 1 FROM pragma_table_info('users') WHERE name='trial_until'").get()) db.exec('ALTER TABLE users ADD COLUMN trial_until INTEGER');
    if (!query("SELECT 1 FROM pragma_table_info('api_keys') WHERE name='expires'").get()) db.exec('ALTER TABLE api_keys ADD COLUMN expires INTEGER');
    db.exec('CREATE TABLE IF NOT EXISTS trial_claims (claim_hash TEXT PRIMARY KEY, key_id INTEGER NOT NULL, expires INTEGER NOT NULL)');
    if (!query("SELECT 1 FROM pragma_table_info('requests') WHERE name='key_id'").get()) {
      db.exec(`ALTER TABLE requests ADD COLUMN key_id INTEGER;
        INSERT INTO api_keys(uid,hash,suffix,quota) SELECT id,key_hash,suffix,quota FROM users WHERE key_hash IS NOT NULL AND disabled=0;
        UPDATE requests SET key_id=(SELECT id FROM api_keys WHERE uid=requests.uid);
        UPDATE users SET key_hash=NULL,suffix=NULL;`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS key_window ON requests(key_id,at); COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
  const lookup = query('SELECT u.id,k.id AS key_id,k.quota FROM api_keys k JOIN users u ON u.id=k.uid WHERE k.hash=? AND u.disabled=0 AND (k.expires IS NULL OR k.expires>?)');
  const view = `SELECT id,username,disabled,trial_until,total,input,output,
    (SELECT count(*) FROM requests r WHERE r.uid=u.id AND r.at>?) AS used FROM users u`;
  const keyRows=query(`SELECT k.id,k.suffix,k.quota,k.expires,count(r.at) AS used FROM api_keys k
    LEFT JOIN requests r ON r.key_id=k.id AND r.at>? WHERE k.uid=? GROUP BY k.id ORDER BY k.id`);
  const summary = (row,revealKeys=false) => {
    const keys=keyRows.all(Date.now()-hour,row.id).map(k=>({...k,remaining:Math.max(0,k.quota-k.used)}));
    return {...row,keys,quota:keys.reduce((n,k)=>n+k.quota,0),remaining:keys.reduce((n,k)=>n+k.remaining,0)};
  };
  const adminTag = () => process.env.ADMIN_PASSWORD ? digest(process.env.ADMIN_PASSWORD) : '';
  async function passwordHash(password) {
    const salt=secret();
    return salt+'.'+(await derive(password,salt,64)).toString('hex');
  }
  const insertUser=query('INSERT INTO users(username,password,quota) VALUES(?,?,?) ON CONFLICT(username) DO NOTHING');
  function issue(id,quota) {
    const key='kb_'+secret();
    return query('INSERT INTO api_keys(uid,hash,suffix,quota,secret,expires) SELECT id,?,?,?, ?,NULL FROM users WHERE id=? AND disabled=0')
      .run(digest(key),key.slice(-6),quota,protect(key),id).changes ? key : null;
  }
  return {
    async register(username,password) {
      return insertUser.run(username,await passwordHash(password),defaultLimit).changes;
    },
    async createWithKey(username,password,quota) {
      const hash=await passwordHash(password);
      db.exec('BEGIN IMMEDIATE');
      try {
        const user=insertUser.run(username,hash,defaultLimit);
        const key=user.changes ? issue(user.lastInsertRowid,quota) : null;
        db.exec('COMMIT');return key;
      } catch(e) {db.exec('ROLLBACK');throw e;}
    },
    async login(username,password) {
      const user=query('SELECT id,password,disabled FROM users WHERE username=?').get(username);
      const [salt,hash]=user?.password.split('.') || ['dummy-account', '00'.repeat(64)];
      const actual=await derive(password,salt,64);
      return timingSafeEqual(actual,Buffer.from(hash,'hex')) && user && !user.disabled ? user.id : null;
    },
    newSession(uid) {
      const token=secret(), now=Date.now();
      query('DELETE FROM sessions WHERE expires<=?').run(now);
      query('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token),uid,uid===null?adminTag():null,now+12*hour);
      return token;
    },
    session(token) {
      const row=query(`SELECT s.uid,s.admin_tag FROM sessions s LEFT JOIN users u ON s.uid=u.id
        WHERE s.hash=? AND s.expires>? AND (s.uid IS NULL OR u.disabled=0)`).get(digest(token),Date.now());
      if (!row || (row.uid===null && (!adminTag() || row.admin_tag!==adminTag()))) return null;
      return {uid:row.uid,admin:row.uid===null};
    },
    logout(token) { query('DELETE FROM sessions WHERE hash=?').run(digest(token)); },
    user(id) { const row=query(view+' WHERE id=?').get(Date.now()-hour,id); if(!row) return null; const result=summary(row); result.keys=result.keys.map(k=>({...k,key:reveal(query('SELECT secret FROM api_keys WHERE id=?').get(k.id)?.secret)})); return result; },
    list() { return query(view+' ORDER BY username').all(Date.now()-hour).map(summary); },
    defaultLimit,
    async createTrial(claim) {
      const claimHash=digest(claim), now=Date.now(), expires=now+3*24*hour;
      db.exec('BEGIN IMMEDIATE');
      try {
        query('DELETE FROM trial_claims WHERE expires<=?').run(now);
        if(query('SELECT 1 FROM trial_claims WHERE claim_hash=?').get(claimHash)) { db.exec('ROLLBACK'); return null; }
        const username='trial_'+randomBytes(10).toString('hex');
        const password=secret(), user=insertUser.run(username,await passwordHash(password),defaultLimit);
        const key='kb_'+secret();
        const result=query('INSERT INTO api_keys(uid,hash,suffix,quota,secret,expires) VALUES(?,?,?,?,?,?)').run(user.lastInsertRowid,digest(key),key.slice(-6),750,protect(key),expires);
        query('UPDATE users SET trial_until=? WHERE id=?').run(expires,user.lastInsertRowid);
        query('INSERT INTO trial_claims VALUES(?,?,?)').run(claimHash,result.lastInsertRowid,expires);
        db.exec('COMMIT'); return {key,expires};
      } catch(e) { db.exec('ROLLBACK'); throw e; }
    },
    getTrial(claim) {
      const row=query('SELECT a.secret,c.expires FROM trial_claims c JOIN api_keys a ON a.id=c.key_id WHERE c.claim_hash=? AND c.expires>?').get(digest(claim),Date.now());
      const key=reveal(row?.secret); return row&&key?{key,expires:row.expires}:null;
    },
    assigned() { return query('SELECT COALESCE(SUM(k.quota),0) AS n FROM api_keys k JOIN users u ON u.id=k.uid WHERE u.disabled=0').get().n; },
    setKeyQuota(id,n) { return query('UPDATE api_keys SET quota=? WHERE id=?').run(n,id).changes; },
    setUserQuota(id,n) { const changed=query('UPDATE api_keys SET quota=? WHERE uid=?').run(n,id).changes; return changed || (issue(id,n)?1:0); },
    deleteKey(id) { return query('DELETE FROM api_keys WHERE id=?').run(id).changes; },
    revoke(id) {
      db.exec('BEGIN IMMEDIATE');
      try {
        query('UPDATE users SET disabled=1 WHERE id=?').run(id);
        query('DELETE FROM api_keys WHERE uid=?').run(id);
        query('DELETE FROM sessions WHERE uid=?').run(id);
        db.exec('COMMIT');
      } catch(e) { db.exec('ROLLBACK'); throw e; }
    },
    enable(id) { query('UPDATE users SET disabled=0 WHERE id=?').run(id); },
    issue,
    byKey(key) { return lookup.get(digest(key),Date.now()); },
    reserve(key,now=Date.now()) {
      db.exec('BEGIN IMMEDIATE');
      try {
        query('DELETE FROM requests WHERE at<=?').run(now-hour);
        const user=lookup.get(digest(key),now);
        let status=401;
        if(user) {
          const {used}=query('SELECT count(*) AS used FROM requests WHERE key_id=?').get(user.key_id);
          status=used>=user.quota ? 429 : 200;
          if(status===200) {
            query('INSERT INTO requests(uid,at,key_id) VALUES(?,?,?)').run(user.id,now,user.key_id);
            query('UPDATE users SET total=total+1 WHERE id=?').run(user.id);
          }
        }
        db.exec('COMMIT'); return status;
      } catch(e) { db.exec('ROLLBACK'); throw e; }
    },
    recordTokens(id,input,output) {
      query('UPDATE users SET input=input+?,output=output+? WHERE id=?').run(input,output,id);
    }
  };
}
