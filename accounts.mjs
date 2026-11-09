import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
export const hour = 3600000;
export const validLimit = n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000;
export const sameSecret = (a,b) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));

export function accounts(db, defaultLimit) {
  if (!validLimit(defaultLimit)) throw Error('Invalid DEFAULT_REQUESTS_PER_HOUR');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password TEXT NOT NULL, quota INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
      key_hash TEXT UNIQUE, suffix TEXT, total INTEGER NOT NULL DEFAULT 0,
      input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, uid INTEGER, admin_tag TEXT, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (uid INTEGER NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS requests_window ON requests(uid,at);
    CREATE INDEX IF NOT EXISTS requests_expiry ON requests(at);
  `);
  const query = sql => db.prepare(sql);
  const lookup = query('SELECT id, disabled, quota FROM users WHERE key_hash=? AND disabled=0');
  const view = `SELECT id,username,quota,disabled,suffix,total,input,output,
    (SELECT count(*) FROM requests r WHERE r.uid=u.id AND r.at>?) AS used FROM users u`;
  const summary = row => ({...row, remaining: Math.max(0,row.quota-row.used)});
  const adminTag = () => process.env.ADMIN_PASSWORD ? digest(process.env.ADMIN_PASSWORD) : '';
  return {
    async register(username,password) {
      const salt=secret();
      const hash=(await derive(password,salt,64)).toString('hex');
      return query('INSERT INTO users(username,password,quota) VALUES(?,?,?) ON CONFLICT(username) DO NOTHING')
        .run(username,salt+'.'+hash,defaultLimit).changes;
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
    user(id) { const row=query(view+' WHERE id=?').get(Date.now()-hour,id); return row && summary(row); },
    list() { return query(view+' ORDER BY username').all(Date.now()-hour).map(summary); },
    setQuota(id,n) { query('UPDATE users SET quota=? WHERE id=?').run(n,id); },
    revoke(id) {
      db.exec('BEGIN IMMEDIATE');
      try {
        query('UPDATE users SET disabled=1,key_hash=NULL,suffix=NULL WHERE id=?').run(id);
        query('DELETE FROM sessions WHERE uid=?').run(id);
        db.exec('COMMIT');
      } catch(e) { db.exec('ROLLBACK'); throw e; }
    },
    enable(id) { query('UPDATE users SET disabled=0 WHERE id=?').run(id); },
    issue(id) {
      const key='kb_'+secret();
      return query('UPDATE users SET key_hash=?,suffix=? WHERE id=? AND disabled=0')
        .run(digest(key),key.slice(-6),id).changes ? key : null;
    },
    byKey(key) { return lookup.get(digest(key)); },
    reserve(key,now=Date.now()) {
      db.exec('BEGIN IMMEDIATE');
      try {
        query('DELETE FROM requests WHERE at<=?').run(now-hour);
        const user=lookup.get(digest(key));
        let status=401;
        if(user) {
          const {used}=query('SELECT count(*) AS used FROM requests WHERE uid=?').get(user.id);
          status=used>=user.quota ? 429 : 200;
          if(status===200) {
            query('INSERT INTO requests VALUES(?,?)').run(user.id,now);
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
