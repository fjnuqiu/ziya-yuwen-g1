import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createAccountClient, AUTH_STORAGE_PREFIX } from '../public/assets/account-session.js';
import { makeSupabaseProgressFetcher } from '../public/assets/supabase-progress.js';
import { ProgressSync } from '../public/assets/cloud-sync.js';
import { initialState } from '../public/assets/sync-model.js';
import { recordAttempt, markStudied } from '../public/assets/learning-engine.js';

const parent='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const ids=['write:一','write:二','pinyin:a'];
const attempt=(state,id=ids[0],result='pass')=>recordAttempt(markStudied(state,id,'2026-10-23'),id,{date:'2026-10-23',result,id:crypto.randomUUID(),at:new Date().toISOString()});
class Storage {
  map=new Map();get length(){return this.map.size;}key(i){return [...this.map.keys()][i]??null;}
  getItem(key){return this.map.get(key)??null;}setItem(key,value){this.map.set(key,String(value));}removeItem(key){this.map.delete(key);}
}
async function database(t){
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users values('${parent}'),('${other}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth, public to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;`);
  await db.exec(await readFile(new URL('../supabase/001_ziya_progress.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/002_ziya_curriculum.sql',import.meta.url),'utf8'));
  async function query(sql,params=[],user=parent,role='authenticated'){
    return db.transaction(async tx=>{
      await tx.exec(`set local role ${role};`);
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user||'']);
      return (await tx.query(sql,params)).rows;
    });
  }
  function client(user=parent){return{
    from(table){assert.equal(table,'ziya_progress');return{select(){return{eq(key,value){assert.equal(key,'user_id');return{abortSignal(){return{async maybeSingle(){try{return{data:(await query('select state,revision,updated_at from public.ziya_progress where user_id=$1',[value],user))[0]||null};}catch(error){return{error};}}};}};}};}};},
    rpc(name,params){assert.equal(name,'ziya_commit_progress');assert.deepEqual(Object.keys(params).sort(),['p_account_id','p_expected_revision','p_request_id','p_state']);return{async abortSignal(){try{return{data:(await query('select public.ziya_commit_progress($1,$2,$3,$4) as value',[params.p_account_id,params.p_request_id,params.p_expected_revision,JSON.stringify(params.p_state)],user))[0].value};}catch(error){return{error};}}};},
  };}
  const sync=(user=parent,storage=new Storage(),extra={})=>new ProgressSync({storage,ownerId:user,namespace:'email:ziya-test.supabase.co',knownIds:ids,fetcher:makeSupabaseProgressFetcher({client:client(user),ownerId:user,knownIds:ids}),schedule:false,...extra});
  const commit=(state,revision=0,requestId=crypto.randomUUID(),user=parent,role='authenticated')=>query('select public.ziya_commit_progress($1,$2,$3,$4) as value',[user,requestId,revision,JSON.stringify(state)],user,role).then(rows=>rows[0].value);
  return{db,query,client,sync,commit};
}

test('ordinary login keeps a Chinese-only session and signs out only locally',async()=>{
  let config,logout,authEvent;
  const account=createAccountClient({url:'https://ziyatest.supabase.co',key:'sb_publishable_publictest',createClient:(url,key,options)=>{config={url,key,options};return{auth:{onAuthStateChange:callback=>{authEvent=callback;},signOut:async args=>{logout=args;return{};}}};}});
  assert.equal(config.options.auth.storageKey,AUTH_STORAGE_PREFIX+'ziyatest.supabase.co');
  assert.equal(account.namespace,'email:ziyatest.supabase.co');
  await account.signOut();assert.deepEqual(logout,{scope:'local'});
  authEvent('PASSWORD_RECOVERY',{});assert.equal(account.recovering,true);
  authEvent('SIGNED_OUT',null);assert.equal(account.recovering,false);
  assert.throws(()=>createAccountClient({url:'https://ziyatest.supabase.co',key:'sb_secret_forbidden'}),/publishable/);
});

test('Postgres authentication, RLS and permissions prevent anonymous and other-account access',async t=>{
  const h=await database(t);await h.commit(attempt(initialState()));
  assert.equal((await h.query('select * from public.ziya_progress')).length,1);
  assert.equal((await h.query('select * from public.ziya_progress',[],other)).length,0);
  await assert.rejects(h.query('select * from public.ziya_progress',[],null,'anon'),/permission denied/);
  await assert.rejects(h.commit(initialState(),0,crypto.randomUUID(),null,'anon'),/permission denied/);
  await assert.rejects(h.commit(initialState(),0,crypto.randomUUID(),null),/Authentication required/);
  await assert.rejects(h.query("update public.ziya_progress set state='{}'"),/permission denied/);
  await assert.rejects(h.query('delete from public.ziya_progress'),/permission denied/);
  await assert.rejects(h.query('select * from public.ziya_sync_receipts'),/permission denied/);
  await assert.rejects(h.query('select public.ziya_commit_progress($1,$2,$3,$4)',[parent,crypto.randomUUID(),0,JSON.stringify(initialState())],other),/Account changed/);
  assert.equal((await h.query('select * from public.ziya_progress',[],other)).length,0);
});

test('two devices merge concurrent grades and settings using the real Postgres RPC',async t=>{
  const h=await database(t),phone=h.sync(),computer=h.sync();
  phone.commit(attempt(phone.state),{teacherOrder:12});computer.commit(attempt(computer.state,ids[1],'fail'),{minutes:25});
  await Promise.all([phone.syncNow(),computer.syncNow()]);await phone.syncNow();await computer.syncNow();
  assert.equal(phone.status.phase,'synced');assert.equal(computer.status.phase,'synced');
  assert.deepEqual(phone.state,computer.state);assert.equal(Object.keys(phone.state.records).length,2);
  assert.equal(phone.state.settings.teacherOrder,12);assert.equal(phone.state.settings.minutes,25);
  const fresh=h.sync();await fresh.syncNow();assert.deepEqual(fresh.state,phone.state);
});

test('offline progress survives reopening; lost acknowledgements do not duplicate or undo later settings',async t=>{
  const h=await database(t),storage=new Storage();let online=false,loseReply=true;
  const remote=makeSupabaseProgressFetcher({client:h.client(),ownerId:parent,knownIds:ids});
  const phone=h.sync(parent,storage,{fetcher:async(...args)=>{
    if(!online)throw Error('offline');const response=await remote(...args);
    if(args[1]?.method==='POST'&&loseReply){loseReply=false;throw Error('lost reply');}return response;
  }});
  phone.commit(attempt(phone.state),{teacherOrder:8});await phone.syncNow();assert.equal(phone.status.phase,'offline');phone.close();
  online=true;
  const reopened=h.sync(parent,storage,{fetcher:phone.fetcher});await reopened.syncNow();assert.equal(reopened.pending().length,1);
  const computer=h.sync();await computer.syncNow();computer.commit(computer.state,{teacherOrder:15});await computer.syncNow();
  await reopened.syncNow();assert.equal(reopened.pending().length,0);assert.equal(reopened.state.settings.teacherOrder,15);
  assert.equal(reopened.state.records[ids[0]].attempts.length,1);
});

test('switching accounts or backend projects does not import another account cache',async t=>{
  const h=await database(t),storage=new Storage(),a=h.sync(parent,storage);a.commit(attempt(a.state));await a.syncNow();a.close();
  const b=h.sync(other,storage);await b.syncNow();assert.deepEqual(b.state.records,{});
  const separate=h.sync(parent,storage,{namespace:'email:different.supabase.co'});assert.deepEqual(separate.state.records,{});
  assert.equal([...storage.map.keys()].filter(key=>key.endsWith(':cache')).length,3);
});

test('a response arriving after logout cannot repopulate the old account UI or clear its outbox',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);let ui=0;
  const sync=new ProgressSync({storage:new Storage(),ownerId:parent,knownIds:ids,schedule:false,onState:()=>ui++,fetcher:async()=>{await gate;return new Response(JSON.stringify({app:'chinese-literacy-g1',userId:parent,state:initialState(),revision:0}),{headers:{'content-type':'application/json'}});}});
  sync.commit(attempt(sync.state));const pending=sync.syncNow();sync.close();release();await pending;
  assert.equal(ui,0);assert.equal(sync.pending().length,1);assert.throws(()=>sync.commit(initialState()),/已退出/);
});

test('server rejects foreign curriculum, malformed settings and attempts to rewrite a failed grade',async t=>{
  const h=await database(t),first=attempt(initialState(),ids[0],'fail');await h.commit(first);
  const rewritten=structuredClone(first);rewritten.records[ids[0]].attempts[0].result='pass';
  await assert.rejects(h.commit(rewritten,1),/cannot be removed or rewritten/);
  const foreign=initialState();foreign.records['english:hello']={studiedDates:[],attempts:[]};
  await assert.rejects(h.commit(foreign,1),/Unknown Ziya curriculum/);
  const invalid=structuredClone(first);invalid.settings.teacherOrder=41;
  await assert.rejects(h.commit(invalid,1),/Invalid Ziya settings/);
  const duplicate=structuredClone(first);duplicate.records[ids[0]].attempts.push(duplicate.records[ids[0]].attempts[0]);
  await assert.rejects(h.commit(duplicate,1),/Invalid Ziya attempt/);
  const invalidDay=structuredClone(first);invalidDay.records[ids[0]].studiedDates=['2026-02-30'];
  await assert.rejects(h.commit(invalidDay,1),/Invalid study date/);
  const row=(await h.query('select * from public.ziya_progress'))[0];assert.equal(Number(row.revision),1);assert.deepEqual(row.state,first);
});

test('CAS conflicts and duplicate receipts return current state without applying stale settings',async t=>{
  const h=await database(t),id=crypto.randomUUID(),a=attempt(initialState());a.settings.teacherOrder=8;
  const one=await h.commit(a,0,id);assert.equal(Number(one.revision),1);
  const stale=await h.commit(initialState(),0);assert.equal(stale.conflict,true);assert.deepEqual(stale.state,a);
  const b=structuredClone(a);b.settings.teacherOrder=15;await h.commit(b,1);
  const replay=await h.commit(a,0,id);assert.equal(Number(replay.revision),2);assert.equal(replay.state.settings.teacherOrder,15);
});
