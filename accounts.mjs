import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
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
    if (!query("SELECT 1 FROM pragma_table_info('users') WHERE name='joined_at'").get()) db.exec('ALTER TABLE users ADD COLUMN joined_at INTEGER');
    if (!query("SELECT 1 FROM pragma_table_info('users') WHERE name='temporary'").get()) db.exec('ALTER TABLE users ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0');
    if (!query("SELECT 1 FROM pragma_table_info('users') WHERE name='email'").get()) db.exec('ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE');
    db.exec('CREATE TABLE IF NOT EXISTS password_resets (hash TEXT PRIMARY KEY, uid INTEGER NOT NULL, expires INTEGER NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS email_verifications (hash TEXT PRIMARY KEY, uid INTEGER NOT NULL, email TEXT NOT NULL, expires INTEGER NOT NULL)');
    if (!query("SELECT 1 FROM pragma_table_info('api_keys') WHERE name='expires'").get()) db.exec('ALTER TABLE api_keys ADD COLUMN expires INTEGER');
    db.exec('CREATE TABLE IF NOT EXISTS trial_claims (claim_hash TEXT PRIMARY KEY, key_id INTEGER NOT NULL, expires INTEGER NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS operational_events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS account_trials (uid INTEGER PRIMARY KEY, created INTEGER NOT NULL)');
    if (!query("SELECT 1 FROM pragma_table_info('requests') WHERE name='key_id'").get()) {
      db.exec(`ALTER TABLE requests ADD COLUMN key_id INTEGER;
        INSERT INTO api_keys(uid,hash,suffix,quota) SELECT id,key_hash,suffix,quota FROM users WHERE key_hash IS NOT NULL AND disabled=0;
        UPDATE requests SET key_id=(SELECT id FROM api_keys WHERE uid=requests.uid);
        UPDATE users SET key_hash=NULL,suffix=NULL;`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS key_window ON requests(key_id,at)');
    db.exec(`CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, uid INTEGER NOT NULL,
      quota INTEGER NOT NULL, amount INTEGER, currency TEXT, status TEXT NOT NULL DEFAULT 'pending',
      created INTEGER NOT NULL, approved INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS subscriptions(sub TEXT PRIMARY KEY,uid INTEGER,customer TEXT,key_id INTEGER,paid_until INTEGER DEFAULT 0,ended INTEGER DEFAULT 0,live INTEGER,last_paid INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS invoices(invoice TEXT PRIMARY KEY,sub TEXT NOT NULL,uid INTEGER NOT NULL,quota INTEGER NOT NULL,amount INTEGER NOT NULL,paid INTEGER NOT NULL,url TEXT,live INTEGER NOT NULL,renewal INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS invoices_owner ON invoices(uid,paid);
      CREATE TABLE IF NOT EXISTS guest_orders(id TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, session_id TEXT UNIQUE, quota INTEGER NOT NULL, created INTEGER NOT NULL, uid INTEGER, sub TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS welcome_mail(sub TEXT PRIMARY KEY, payload TEXT, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, sent INTEGER);
      COMMIT`);
  } catch(e) { db.exec('ROLLBACK'); throw e; }
  const mode=()=>Number(/^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY||''));
  const lookup = query('SELECT u.id,k.id AS key_id,k.quota FROM api_keys k JOIN users u ON u.id=k.uid LEFT JOIN subscriptions s ON s.key_id=k.id WHERE k.hash=? AND u.disabled=0 AND (k.expires IS NULL OR k.expires>?) AND (s.sub IS NULL OR s.live=? AND s.ended=0)');
  const view = `SELECT id,username,disabled,trial_until,total,input,output,
    (SELECT count(*) FROM requests r WHERE r.uid=u.id AND r.at>?) AS used FROM users u`;
  const keyRows=query(`SELECT k.id,k.suffix,k.quota,k.expires,count(r.at) AS used FROM api_keys k LEFT JOIN subscriptions s ON s.key_id=k.id
    LEFT JOIN requests r ON r.key_id=k.id AND r.at>? WHERE k.uid=? AND (k.expires IS NULL OR k.expires>?) AND (s.sub IS NULL OR s.live=? AND s.ended=0) GROUP BY k.id ORDER BY k.id`);
  const summary = (row,revealKeys=false) => {
    const keys=keyRows.all(Date.now()-hour,row.id,Date.now(),mode()).map(k=>({...k,remaining:Math.max(0,k.quota-k.used)}));
    return {...row,keys,quota:keys.reduce((n,k)=>n+k.quota,0),remaining:keys.reduce((n,k)=>n+k.remaining,0)};
  };
  const adminTag = () => process.env.ADMIN_PASSWORD ? digest(process.env.ADMIN_PASSWORD) : '';
  async function passwordHash(password) {
    const salt=secret();
    return salt+'.'+(await derive(password,salt,64)).toString('hex');
  }
  const insertUser=query("INSERT INTO users(username,password,quota,joined_at) VALUES(?,?,?,COALESCE(?,unixepoch()*1000)) ON CONFLICT(username) DO NOTHING");
  function issue(id,quota) {
    const key='kb_'+secret();
    return query('INSERT INTO api_keys(uid,hash,suffix,quota,secret,expires) SELECT id,?,?,?, ?,NULL FROM users WHERE id=? AND disabled=0')
      .run(digest(key),key.slice(-6),quota,protect(key),id).changes ? key : null;
  }
  return {
    operationalEvent(kind){query('INSERT INTO operational_events(at,kind) VALUES(?,?)').run(Date.now(),kind);query('DELETE FROM operational_events WHERE at<?').run(Date.now()-7*24*hour)},
    operationalStatus(){return {welcomePending:query('SELECT count(*) AS n FROM welcome_mail WHERE sent IS NULL').get().n,welcomeFailed:query('SELECT count(*) AS n FROM welcome_mail WHERE sent IS NULL AND attempts>0').get().n,webhookFailures:query("SELECT count(*) AS n FROM operational_events WHERE kind='webhook_processing_failed' AND at>?").get(Date.now()-24*hour).n}},
    recoveryEmail(uid){return query('SELECT email FROM users WHERE id=? AND disabled=0').get(uid)?.email||null},
    async requestRecoveryEmail(uid,email,password){
      const u=query('SELECT username FROM users WHERE id=? AND disabled=0').get(uid);
      if(!u||!await this.login(u.username,password))return null;
      const token=secret();query('DELETE FROM email_verifications WHERE uid=? OR expires<?').run(uid,Date.now());
      query('INSERT INTO email_verifications VALUES(?,?,?,?)').run(digest(token),uid,email,Date.now()+30*60*1000);return token;
    },
    confirmRecoveryEmail(uid,token){
      db.exec('BEGIN IMMEDIATE');try{const row=query('SELECT email FROM email_verifications WHERE hash=? AND uid=? AND expires>?').get(digest(token),uid,Date.now());if(!row){db.exec('ROLLBACK');return false;}
        query('UPDATE users SET email=? WHERE id=? AND disabled=0').run(row.email,uid);query('DELETE FROM email_verifications WHERE uid=?').run(uid);query('DELETE FROM password_resets WHERE uid=?').run(uid);db.exec('COMMIT');return true;
      }catch(e){db.exec('ROLLBACK');throw e;}
    },
    rotateKey(uid,id){
      const key='kb_'+secret();
      const changed=query('UPDATE api_keys SET hash=?,suffix=?,secret=? WHERE id=? AND uid=? AND (expires IS NULL OR expires>?) AND EXISTS(SELECT 1 FROM users WHERE id=? AND disabled=0)').run(digest(key),key.slice(-6),protect(key),id,uid,Date.now(),uid).changes;
      return changed?key:null;
    },
    audit(action,target,detail=''){query('INSERT INTO admin_audit(at,action,target,detail) VALUES(?,?,?,?)').run(Date.now(),action,String(target),String(detail));},
    auditLog(){return query('SELECT at,action,target,detail FROM admin_audit ORDER BY id DESC LIMIT 200').all()},
    createAccountTrial(uid){
      const now=Date.now();db.exec('BEGIN IMMEDIATE');
      try {
        if(!query('SELECT id FROM users WHERE id=? AND disabled=0').get(uid)||query('SELECT 1 FROM account_trials WHERE uid=?').get(uid)){db.exec('ROLLBACK');return null;}
        const key=issue(uid,750);
        query('UPDATE api_keys SET expires=? WHERE hash=?').run(now+72*hour,digest(key));
        query('INSERT INTO account_trials VALUES(?,?)').run(uid,now);
        db.exec('COMMIT');return {key,expires:now+72*hour};
      }catch(e){db.exec('ROLLBACK');throw e;}
    },
    startGuestOrder(browser,quota) {
      query('DELETE FROM guest_orders WHERE uid IS NULL AND created<?').run(Date.now()-30*24*hour);
      const id=secret();
      query('INSERT INTO guest_orders(id,browser_hash,quota,created) VALUES(?,?,?,?)').run(id,digest(browser),quota,Date.now());
      return id;
    },
    bindCheckout(id,checkout) {
      query('UPDATE guest_orders SET session_id=? WHERE id=?').run(checkout,id);
    },
    claimCheckout(browser,checkout) {
      const order=query('SELECT o.id,o.uid,u.disabled,u.temporary FROM guest_orders o LEFT JOIN users u ON u.id=o.uid WHERE o.browser_hash=? AND o.session_id=? AND o.created>?').get(digest(browser),checkout,Date.now()-2*24*hour);
      if(!order||order.disabled)return {status:'unavailable'};
      if(!order.uid)return {status:'pending'};
      if(!order.temporary)return {status:'unavailable'};
      const token=this.newSession(order.uid);
      query("UPDATE guest_orders SET browser_hash='' WHERE id=?").run(order.id);
      return {status:'ready',token};
    },
    async setFirstPassword(uid,password){
      const hash=await passwordHash(password);
      db.exec('BEGIN IMMEDIATE');
      try {
        const changed=query('UPDATE users SET password=?,temporary=0 WHERE id=? AND temporary=1 AND disabled=0').run(hash,uid).changes;
        if(changed) query('DELETE FROM sessions WHERE uid=?').run(uid);
        const token=changed?this.newSession(uid):null;
        db.exec('COMMIT');return token;
      } catch(e){db.exec('ROLLBACK');throw e;}
    },
    async changePassword(uid,current,password){
      const user=query('SELECT username FROM users WHERE id=? AND disabled=0').get(uid);
      if(!user || !await this.login(user.username,current)) return null;
      const hash=await passwordHash(password);
      db.exec('BEGIN IMMEDIATE');
      try {
        query('UPDATE users SET password=?,temporary=0 WHERE id=? AND disabled=0').run(hash,uid);
        query('DELETE FROM sessions WHERE uid=?').run(uid);
        const token=this.newSession(uid); db.exec('COMMIT'); return token;
      } catch(e){db.exec('ROLLBACK');throw e;}
    },
    nextWelcome(){
      const row=query('SELECT sub,payload,attempts FROM welcome_mail WHERE sent IS NULL AND retry_at<=? ORDER BY retry_at LIMIT 1').get(Date.now());
      if(!row)return null;
      return {sub:row.sub,attempts:row.attempts,message:JSON.parse(reveal(row.payload))};
    },
    welcomeSent(sub){query('UPDATE welcome_mail SET payload=NULL,sent=? WHERE sub=?').run(Date.now(),sub);},
    welcomeFailed(sub,attempts){query('UPDATE welcome_mail SET attempts=attempts+1,retry_at=? WHERE sub=?').run(Date.now()+Math.min(hour,30000*2**Math.min(attempts,7)),sub);},
    async register(username,password,email) {
      const result=insertUser.run(username,await passwordHash(password),defaultLimit,Date.now());
      if(result.changes&&email)query('UPDATE users SET email=? WHERE id=?').run(email,result.lastInsertRowid);
      return result.changes;
    },
    createReset(email,username){
      const user=query('SELECT id FROM users WHERE email=? AND username=? AND disabled=0').get(email,username);
      if(!user)return null;
      const token=secret();query('DELETE FROM password_resets WHERE uid=? OR expires<?').run(user.id,Date.now());
      query('INSERT INTO password_resets VALUES(?,?,?)').run(digest(token),user.id,Date.now()+30*60*1000);return token;
    },
    async resetPassword(token,password){
      const hash=await passwordHash(password);db.exec('BEGIN IMMEDIATE');
      try{const row=query('SELECT uid FROM password_resets WHERE hash=? AND expires>?').get(digest(token),Date.now());
        if(!row){db.exec('ROLLBACK');return false;}
        query('UPDATE users SET password=?,temporary=0 WHERE id=? AND disabled=0').run(hash,row.uid);
        query('DELETE FROM password_resets WHERE uid=?').run(row.uid);query('DELETE FROM sessions WHERE uid=?').run(row.uid);
        db.exec('COMMIT');return true;
      }catch(e){db.exec('ROLLBACK');throw e;}
    },
    async createWithKey(username,password,quota) {
      const hash=await passwordHash(password);
      db.exec('BEGIN IMMEDIATE');
      try {
        const user=insertUser.run(username,hash,defaultLimit,Date.now());
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
      const row=query(`SELECT s.uid,s.admin_tag,u.temporary FROM sessions s LEFT JOIN users u ON s.uid=u.id
        WHERE s.hash=? AND s.expires>? AND (s.uid IS NULL OR u.disabled=0)`).get(digest(token),Date.now());
      if (!row || (row.uid===null && (!adminTag() || row.admin_tag!==adminTag()))) return null;
      return {uid:row.uid,admin:row.uid===null,temporary:Boolean(row.temporary)};
    },
    logout(token) { query('DELETE FROM sessions WHERE hash=?').run(digest(token)); },
    user(id) { const row=query(view+' WHERE id=?').get(Date.now()-hour,id); if(!row) return null; const result=summary(row); result.keys=result.keys.map(k=>({...k,key:reveal(query('SELECT secret FROM api_keys WHERE id=?').get(k.id)?.secret)})); return result; },
    list() { return query(view+' ORDER BY username').all(Date.now()-hour).map(summary); },
    defaultLimit,
    paidInvoice(p){
      db.exec('BEGIN IMMEDIATE');
      try {
        const old=query('SELECT * FROM subscriptions WHERE sub=?').get(p.sub);
        let temporaryPassword;
        if(p.guest){
          const order=query('SELECT * FROM guest_orders WHERE id=?').get(p.guest);
          if(!order || (order.sub && order.sub!==p.sub))throw Error('Unknown guest order');
          if(!order.uid){
            if(old?.ended || p.end<=Date.now()){db.exec('COMMIT');return;}
            if(order.quota!==p.quota||!p.email)throw Error('Incomplete guest invoice');
            const username='member_'+randomBytes(6).toString('hex');
            temporaryPassword=randomBytes(18).toString('base64url');
            const salt=secret(), hash=salt+'.'+scryptSync(temporaryPassword,salt,64).toString('hex');
            p.uid=Number(insertUser.run(username,hash,defaultLimit,Date.now()).lastInsertRowid);
            query('UPDATE users SET email=? WHERE id=?').run(p.email,p.uid);
            query('UPDATE users SET temporary=1 WHERE id=?').run(p.uid);
            query('UPDATE guest_orders SET uid=?,sub=? WHERE id=?').run(p.uid,p.sub,p.guest);
          } else p.uid=order.uid;
        }
        const u=query('SELECT username,disabled FROM users WHERE id=?').get(p.uid);
        if(!u||(old?.uid&&old.uid!==p.uid))throw Error('Invoice account mismatch');
        const added=query('INSERT OR IGNORE INTO invoices VALUES(?,?,?,?,?,?,?,?,?)')
          .run(p.invoice,p.sub,p.uid,p.quota,p.amount,p.paid,p.url,p.live,p.renewal).changes;
        const current=!old || p.end>old.paid_until || (p.end===old.paid_until&&p.paid>=old.last_paid);
        if(added&&!old?.ended&&!u.disabled&&current&&p.end>Date.now()){
          let keyId=old?.key_id;
          if(!old){
            const key=issue(p.uid,p.quota);
            keyId=query('SELECT id FROM api_keys WHERE hash=?').get(digest(key)).id;
            if(p.email){
              const payload=protect(JSON.stringify({email:p.email,username:u.username,temporaryPassword,key,quota:p.quota}));
              query('INSERT INTO welcome_mail(sub,payload) VALUES(?,?)').run(p.sub,payload);
            }
          }
          query('UPDATE api_keys SET expires=?,quota=? WHERE id=? AND uid=?').run(p.end,p.quota,keyId,p.uid);
          query('INSERT INTO subscriptions(sub,uid,customer,key_id,paid_until,live,last_paid) VALUES(?,?,?,?,?,?,?) ON CONFLICT(sub) DO UPDATE SET paid_until=excluded.paid_until,last_paid=excluded.last_paid')
            .run(p.sub,p.uid,p.customer,keyId,p.end,p.live,p.paid);
        }
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
    },
    endSubscription(sub){
      db.exec('BEGIN IMMEDIATE');
      try {
        query('DELETE FROM api_keys WHERE id=(SELECT key_id FROM subscriptions WHERE sub=?)').run(sub);
        query('INSERT INTO subscriptions(sub,ended) VALUES(?,1) ON CONFLICT(sub) DO UPDATE SET ended=1').run(sub);
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
    },
    billing(uid,live){
      return {subscription:query('SELECT customer,paid_until FROM subscriptions WHERE uid=? AND live=? AND ended=0 ORDER BY paid_until DESC LIMIT 1').get(uid,live),
        invoices:query('SELECT amount,paid,url,quota,renewal FROM invoices WHERE uid=? AND live=? ORDER BY paid DESC').all(uid,live)};
    },
    async createTrial(claim) {
      const claimHash=digest(claim), now=Date.now(), expires=now+3*24*hour;
      const hash=await passwordHash(secret());
      db.exec('BEGIN IMMEDIATE');
      try {
        query('DELETE FROM trial_claims WHERE expires<=?').run(now);
        if(query('SELECT 1 FROM trial_claims WHERE claim_hash=?').get(claimHash)) { db.exec('ROLLBACK'); return null; }
        const username='trial_'+randomBytes(10).toString('hex');
        const user=insertUser.run(username,hash,defaultLimit,Date.now());
        const key='kb_'+secret();
        const result=query('INSERT INTO api_keys(uid,hash,suffix,quota,secret,expires) VALUES(?,?,?,?,?,?)').run(user.lastInsertRowid,digest(key),key.slice(-6),750,protect(key),expires);
        query('UPDATE users SET trial_until=? WHERE id=?').run(expires,user.lastInsertRowid);
        query('INSERT INTO trial_claims VALUES(?,?,?)').run(claimHash,result.lastInsertRowid,expires);
        db.exec('COMMIT'); return {key,expires};
      } catch(e) { db.exec('ROLLBACK'); throw e; }
    },
    moveTrial(old,fresh){query('UPDATE trial_claims SET claim_hash=? WHERE claim_hash=?').run(digest(fresh),digest(old));},
    getTrial(claim) {
      const row=query('SELECT a.secret,c.expires FROM trial_claims c JOIN api_keys a ON a.id=c.key_id WHERE c.claim_hash=? AND c.expires>?').get(digest(claim),Date.now());
      const key=reveal(row?.secret); return row&&key?{key,expires:row.expires}:null;
    },
    recordPayment(eventId,uid,quota,amount,currency) { return query('INSERT OR IGNORE INTO payments(event_id,uid,quota,amount,currency,created) VALUES(?,?,?,?,?,?)').run(eventId,uid,quota,amount||null,currency||'usd',Date.now()).changes; },
    payments() { return query('SELECT p.*,u.username FROM payments p LEFT JOIN users u ON u.id=p.uid ORDER BY p.created DESC').all(); },
    salesStats() {
      const live=Number(/^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY||''));
      const d=new Date(), day=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate());
      const sum=since=>query('SELECT COALESCE(SUM(amount),0) AS cents,COUNT(*) AS count FROM invoices WHERE live=? AND paid>=?').get(live,since);
      const customers=query('SELECT u.username,u.joined_at,MIN(i.paid) AS first_paid,SUM(i.renewal) AS renewals,SUM(i.amount) AS cents FROM invoices i JOIN users u ON i.uid=u.id WHERE i.live=? GROUP BY u.id ORDER BY first_paid DESC').all(live);
      return {live,today:sum(day),week:sum(day-((d.getUTCDay()+6)%7)*86400000),month:sum(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)),total:sum(0),customers};
    },
    approvePayment(id) { const p=query('SELECT uid,quota,status FROM payments WHERE id=?').get(id); if(!p)return null; const changed=query('UPDATE api_keys SET quota=? WHERE uid=?').run(p.quota,p.uid).changes; if(!changed) issue(p.uid,p.quota); query('UPDATE payments SET status=\'approved\',approved=1 WHERE id=?').run(id); return p; },
    assigned() { return query('SELECT COALESCE(SUM(k.quota),0) AS n FROM api_keys k JOIN users u ON u.id=k.uid LEFT JOIN subscriptions s ON s.key_id=k.id WHERE u.disabled=0 AND (k.expires IS NULL OR k.expires>?) AND (s.sub IS NULL OR s.live=? AND s.ended=0)').get(Date.now(),mode()).n; },
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
    byKey(key) { return lookup.get(digest(key),Date.now(),mode()); },
    reserve(key,now=Date.now()) {
      db.exec('BEGIN IMMEDIATE');
      try {
        query('DELETE FROM requests WHERE at<=?').run(now-hour);
        const user=lookup.get(digest(key),now,mode());
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
