import { ApiError, json, readJson, sha256 } from './shared.js';
import { atLeast, policy } from './client-policy.js';

const seconds=()=>Math.floor(Date.now()/1000), encoder=new TextEncoder();
const fail=(status,message)=>{throw new ApiError(status,message);};
const validId=value=>typeof value==='string' && /^[a-z0-9][a-z0-9:_-]{0,95}$/.test(value);
function text(value,max=300){
  if(typeof value!=='string')fail(400,'Enter a message.');
  const clean=value.normalize('NFC').trim();
  if(!clean || [...clean].length>max || encoder.encode(clean).length>max*4 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(clean))fail(400,`Use 1–${max} characters on one line.`);
  return clean;
}
function number(value,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)fail(400,'Invalid numeric setting.');return value;}
// One hibernating object multiplexes all logical channels. It keeps logs out of the BP D1.
export class RankedChat {
  constructor(ctx,env){
    this.ctx=ctx;this.env=env;this.sql=ctx.storage.sql;this.pending=new WeakMap();this.queued=new WeakMap();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY,slow INTEGER NOT NULL,daily_limit INTEGER NOT NULL,capacity INTEGER NOT NULL,revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO settings VALUES(1,30,10000,800000000,1);
      CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,active INTEGER NOT NULL,members TEXT NOT NULL);
      INSERT OR IGNORE INTO channels VALUES('general','General','public',1,'[]');
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,owner TEXT NOT NULL,name TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL,nonce TEXT NOT NULL,hidden INTEGER NOT NULL DEFAULT 0,UNIQUE(owner,nonce));
      CREATE INDEX IF NOT EXISTS chat_channel_cursor ON messages(channel,id);
      CREATE INDEX IF NOT EXISTS chat_owner_cursor ON messages(owner,id);
      CREATE TABLE IF NOT EXISTS daily(day INTEGER PRIMARY KEY,count INTEGER NOT NULL,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mutes(owner TEXT PRIMARY KEY,until_time INTEGER NOT NULL,reason TEXT NOT NULL);`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS profiles(owner TEXT PRIMARY KEY,nicknameColor TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS viewer_tickets(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL,credential TEXT NOT NULL)');
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));
  }
  rows(query,...args){return this.sql.exec(query,...args).toArray();}
  async viewerCredential(){if(!this.env.ADMIN_TOKEN)fail(401,'Administrator access unavailable.');return sha256(encoder.encode(this.env.ADMIN_TOKEN));}
  viewerChannels(){return this.rows('SELECT id,name,kind,active FROM channels ORDER BY id');}
  async viewerSocket(url){
    const token=url.searchParams.get('ticket')||'';
    if(!/^[a-f0-9]{64}$/.test(token))fail(401,'Open administrator chat again.');
    const hash=await sha256(encoder.encode(token)),credential=await this.viewerCredential();
    // Consume atomically: simultaneous upgrades cannot reuse a ticket.
    const ticket=this.rows('DELETE FROM viewer_tickets WHERE hash=? RETURNING expires,credential',hash)[0];
    if(!ticket||ticket.expires<=seconds()||ticket.credential!==credential)fail(401,'Open administrator chat again.');
    if(this.ctx.getWebSockets().filter(ws=>ws.deserializeAttachment()?.viewer).length>=8)fail(429,'Too many administrator chat windows.');
    const pair=new WebSocketPair(),server=pair[1];
    this.ctx.acceptWebSocket(server);
    const a={viewer:true,credential,expires:seconds()+3600,channel:'general',checked:seconds(),lastAction:Date.now(),tokens:8,strikes:0};
    server.serializeAttachment(a);
    this.send(server,{type:'hello',channel:a.channel,channels:this.viewerChannels(),messages:this.history(a.channel,Number.MAX_SAFE_INTEGER,100,true),expires:a.expires});
    return new Response(null,{status:101,webSocket:pair[0]});
  }
  settings(){const r=this.rows('SELECT * FROM settings WHERE id=1')[0];return {slowSeconds:r.slow,dailyLimit:r.daily_limit,capacityBytes:r.capacity,revision:r.revision};}
  size(){return this.sql.databaseSize;}
  today(){return this.rows('SELECT * FROM daily WHERE day=?',Math.floor(seconds()/86400))[0]??{count:0,bytes:0};}
  channels(id){return this.rows('SELECT * FROM channels ORDER BY id').filter(c=>c.active && (!['members','event'].includes(c.kind)||JSON.parse(c.members).includes(id))).map(c=>({id:c.id,name:c.name,kind:c.kind}));}
  channel(channel,id){const c=this.rows('SELECT * FROM channels WHERE id=?',channel)[0];if(!c?.active || (['members','event'].includes(c.kind)&&!JSON.parse(c.members).includes(id)))fail(403,'This channel is unavailable.');return c;}
  latest(owner){return this.rows('SELECT created FROM messages WHERE owner=? ORDER BY id DESC LIMIT 1',owner)[0]?.created??0;}
  history(channel,before=Number.MAX_SAFE_INTEGER,limit=50,admin=false){return this.rows('SELECT id,channel,messages.owner AS owner,name,body,created,hidden,p.nicknameColor FROM messages LEFT JOIN profiles p ON p.owner=messages.owner WHERE channel=? AND id<? ORDER BY id DESC LIMIT ?',channel,before,limit).reverse().map(m=>!admin&&m.hidden?{...m,body:'',hidden:true}:m);}
  async syncProfile(a){
    const color=a.nicknameColor??null, old=this.rows('SELECT nicknameColor FROM profiles WHERE owner=?',a.id)[0];
    if((old?.nicknameColor??null)===color)return;
    this.sql.exec('INSERT INTO profiles VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET nicknameColor=excluded.nicknameColor',a.id,color);
    for(const ws of this.ctx.getWebSockets()){
      const current=ws.deserializeAttachment();
      if(current?.id===a.id)ws.serializeAttachment({...current,nicknameColor:color});
    }
    await this.broadcast(null,{type:'profile',owner:a.id,nicknameColor:color});
  }
  send(ws,value){try{ws.send(JSON.stringify(value));}catch{try{ws.close(1011,'Connection lost');}catch{}}}
  async authenticationSnapshot(peers,force=false){
    const attachments=peers.map(ws=>ws.deserializeAttachment()).filter(a=>a&&!a.viewer);
    if(!attachments.length||(!force&&!attachments.some(a=>seconds()-a.checked>=60)))return null;
    const ids=[...new Set(attachments.map(a=>a.id))];
    const db=this.env.DB.withSession('first-primary'), users=new Map();
    // Broadcasts can reach 200 sockets. Revalidate accounts in bounded batches,
    // not two D1 requests per socket in a single Free-plan invocation.
    const currentPolicy=await policy(db);
    for(let i=0;i<ids.length;i+=80){
      const part=ids.slice(i,i+80);
      const rows=await db.prepare(`SELECT id,name,nickname_color,auth_revision,token_expires FROM accounts WHERE id IN (${part.map(()=>'?').join(',')})`).bind(...part).all();
      for(const row of rows.results)users.set(row.id,row);
    }
    return {users,policy:currentPolicy};
  }
  async deliver(ws,value,channel=null,snapshot=null){
    try{
      const a=ws.deserializeAttachment();if(!a || (channel && a.channel!==channel))return;
      await this.authenticate(a,snapshot);
      const current=ws.deserializeAttachment();if(!current || (channel && current.channel!==channel))return;
      if(channel&&!current.viewer)this.channel(channel,current.id);
      ws.serializeAttachment({...current,name:a.name,nicknameColor:a.nicknameColor??null,checked:a.checked});this.send(ws,value);
    }catch{try{ws.close(1008,'Sign in or update');}catch{}}
  }
  async broadcast(channel,value,viewerValue=null){
    if(channel?.startsWith('event:'))await this.syncEvents();
    const peers=this.ctx.getWebSockets().filter(ws=>!channel||ws.deserializeAttachment()?.channel===channel);
    const snapshot=await this.authenticationSnapshot(peers);
    await Promise.all(peers.map(ws=>this.deliver(ws,ws.deserializeAttachment()?.viewer&&viewerValue?viewerValue:value,channel,snapshot)));
  }
  async syncEvents(){
    const events=await this.env.DB.prepare(`SELECT id,name,status,(SELECT json_group_array(owner) FROM tournament_entries WHERE tournament=id) AS members FROM tournaments ORDER BY id`).all();
    for(const event of events.results){const id='event:'+event.id, active=event.status==='closed'?0:1;
      const old=this.rows('SELECT name,active,members FROM channels WHERE id=?',id)[0];
      if(!old || old.name!==event.name || old.active!==active || old.members!==event.members)this.sql.exec("INSERT INTO channels VALUES(?,?,'event',?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=excluded.active,members=excluded.members",id,event.name,active,event.members);
    }
  }
  async fetch(request){
    try{
      const url=new URL(request.url);
      // This route is reached only through the Worker binding, after account authentication.
      if(url.pathname==='/profile'&&request.method==='PUT'){await this.syncProfile(await readJson(request,1024));return json({updated:true});}
      if(url.pathname.startsWith('/admin/'))return await this.admin(request,url);
      if(url.pathname==='/viewer/socket'&&request.headers.get('Upgrade')?.toLowerCase()==='websocket')return await this.viewerSocket(url);
      if(url.pathname!=='/socket' || request.headers.get('Upgrade')?.toLowerCase()!=='websocket')fail(404,'Unknown chat route.');
      const a=JSON.parse(decodeURIComponent(request.headers.get('X-Chat-Identity')||'null'));
      if(!a?.id || !a.name || !a.expires || a.expires<=seconds())fail(401,'Sign in again.');
      await this.syncProfile(a);
      await this.syncEvents();
      const peers=this.ctx.getWebSockets().filter(ws=>!ws.deserializeAttachment()?.viewer);
      if(peers.filter(ws=>ws.deserializeAttachment()?.id===a.id).length>=2)fail(429,'At most two chat connections per account.');
      if(peers.length>=200)fail(503,'Chat is full. Try later.');
      const pair=new WebSocketPair(), client=pair[0], server=pair[1];
      a.channel='general';a.checked=seconds();a.lastAction=Date.now();a.tokens=8;a.strikes=0;a.lastSearch=0;
      this.ctx.acceptWebSocket(server);server.serializeAttachment(a);
      this.send(server,{type:'hello',channels:this.channels(a.id),channel:a.channel,messages:this.history(a.channel),
        settings:this.settings(),serverTime:seconds(),nextSend:this.latest(a.id)+this.settings().slowSeconds});
      return new Response(null,{status:101,webSocket:client});
    }catch(e){if(e instanceof ApiError)return json({error:e.message},e.status);throw e;}
  }
  async authenticate(a,snapshot=null){
    if(a.expires<=seconds())fail(401,'Sign in again.');
    if(a.viewer){if(a.credential!==await this.viewerCredential())fail(401,'Open administrator chat again.');return;}
    if(seconds()-a.checked<60)return;
    const db=this.env.DB.withSession('first-primary');
    const user=snapshot?snapshot.users.get(a.id):await db.prepare('SELECT name,nickname_color,auth_revision,token_expires FROM accounts WHERE id=?').bind(a.id).first();
    if(!user || user.auth_revision!==a.revision || user.token_expires<=seconds())fail(401,'Sign in again.');
    const p=snapshot?.policy??await policy(db);if(!atLeast(a.version,p.minimumVersion))fail(426,'Update the mod to '+p.minimumVersion+'.');
    a.name=user.name;a.nicknameColor=user.nickname_color??null;a.checked=seconds();
  }
  webSocketMessage(ws,raw){
    const count=this.queued.get(ws)??0;if(count>=16){ws.close(1008,'Too many requests');return;}
    this.queued.set(ws,count+1);
    const task=(this.pending.get(ws)??Promise.resolve()).catch(()=>{}).then(()=>this.handleMessage(ws,raw)).finally(()=>this.queued.set(ws,(this.queued.get(ws)??1)-1));
    this.pending.set(ws,task);return task;
  }
  async handleMessage(ws,raw){
    let a=ws.deserializeAttachment();
    try{
      if(typeof raw!=='string' || encoder.encode(raw).length>4096)fail(400,'Message is too large.');
      if(!a)fail(401,'Sign in again.');
      // Bound rejected commands and history requests too; no SQL writes for rejected spam.
      const nowMs=Date.now();a.tokens=Math.min(8,(a.tokens??8)+(nowMs-a.lastAction)/500);a.lastAction=nowMs;
      if(a.tokens<1){a.strikes++;ws.serializeAttachment(a);if(a.strikes>=3)ws.close(1008,'Too many requests');fail(429,'Too many chat commands. Try shortly.');}
      a.tokens--;ws.serializeAttachment(a);
      const msg=JSON.parse(raw);await this.authenticate(a);
      a={...ws.deserializeAttachment(),name:a.name,nicknameColor:a.nicknameColor??null,checked:a.checked};ws.serializeAttachment(a);
      if(a.viewer){
        // Read-only subscription. Notices/moderation still require authenticated HTTP.
        if(msg.type!=='join')fail(403,'Administrator chat connections are read-only.');
        if(!validId(msg.channel)||!this.rows('SELECT id FROM channels WHERE id=?',msg.channel)[0])fail(404,'Unknown channel.');
        a.channel=msg.channel;ws.serializeAttachment({...a,strikes:0});
        this.send(ws,{type:'history',channel:a.channel,messages:this.history(a.channel,Number.MAX_SAFE_INTEGER,100,true)});return;
      }
      // Event channels require an actual submitted fleet, including for guessed IDs.
      const requested=msg.type==='join'?msg.channel:a.channel;
      if(typeof requested==='string' && requested.startsWith('event:')) {
        const entry=await this.env.DB.prepare(`SELECT 1 FROM tournament_entries e JOIN tournaments t ON t.id=e.tournament WHERE e.tournament=? AND e.owner=? AND t.status<>'closed'`).bind(requested.slice(6),a.id).first();
        if(!entry)fail(403,'Submit a fleet to this event to join its chat.');
        if(msg.type==='join')await this.syncEvents();
      }
      if(msg.type==='join'){
        if(!validId(msg.channel))fail(400,'Invalid channel.');this.channel(msg.channel,a.id);a.channel=msg.channel;
        ws.serializeAttachment(a);this.send(ws,{type:'history',channel:a.channel,messages:this.history(a.channel),settings:this.settings(),serverTime:seconds(),nextSend:this.latest(a.id)+this.settings().slowSeconds});
      }else if(msg.type==='history'){
        this.channel(a.channel,a.id);const before=number(msg.before,1,Number.MAX_SAFE_INTEGER);
        this.send(ws,{type:'older',channel:a.channel,messages:this.history(a.channel,before)});
      }else if(msg.type==='search'){
        this.channel(a.channel,a.id);
        const query=text(msg.query,50);if([...query].length<2)fail(400,'Enter at least two characters.');
        if(Date.now()-a.lastSearch<3000)fail(429,'Wait three seconds between searches.');
        a.lastSearch=Date.now();ws.serializeAttachment(a);
        const before=number(msg.before??Number.MAX_SAFE_INTEGER,1,Number.MAX_SAFE_INTEGER);
        const rows=this.rows('SELECT id,channel,messages.owner AS owner,name,body,created,hidden,p.nicknameColor FROM messages LEFT JOIN profiles p ON p.owner=messages.owner WHERE channel=? AND id<? ORDER BY id DESC LIMIT 1000',a.channel,before);
        const needle=query.toLocaleLowerCase('en-US'),matches=[];let scanned=0;
        for(const m of rows){scanned++;if(!m.hidden && (m.body.toLocaleLowerCase('en-US').includes(needle)||m.name.toLocaleLowerCase('en-US').includes(needle)))matches.push(m);if(matches.length===50)break;}
        const more=scanned<rows.length || rows.length===1000;
        this.send(ws,{type:'search',channel:a.channel,query,messages:matches.reverse(),scanned,nextBefore:more?rows[scanned-1].id:null});
      }else if(msg.type==='send'){
        if(!validId(msg.channel))fail(400,'Select a channel before sending.');
        if(msg.channel!==a.channel)fail(409,'The channel changed. Check the selected channel and try again.');
        this.channel(a.channel,a.id);const body=text(msg.body);
        if(typeof msg.nonce!=='string'||!/^[a-f0-9]{32}$/.test(msg.nonce))fail(400,'Invalid message identifier.');
        await this.syncProfile(a);
        if(ws.deserializeAttachment()?.channel!==a.channel)fail(409,'The channel changed. Check the selected channel and try again.');
        this.channel(a.channel,a.id);
        // No await between duplicate/limit checks and the synchronous insert.
        // Separate sockets and senders must share the same cooldown/daily budget.
        const duplicate=this.rows('SELECT id,channel,body FROM messages WHERE owner=? AND nonce=?',a.id,msg.nonce)[0];
        if(duplicate){if(duplicate.channel!==a.channel || duplicate.body!==body)fail(409,'Message identifier was reused.');this.send(ws,{type:'ack',nonce:msg.nonce,id:duplicate.id});return;}
        const settings=this.settings(), now=seconds(), next=this.latest(a.id)+settings.slowSeconds;
        const mute=this.rows('SELECT * FROM mutes WHERE owner=?',a.id)[0];
        if(mute && mute.until_time>now)fail(403,'Chat is muted until '+new Date(mute.until_time*1000).toISOString()+'.');
        if(now<next){this.send(ws,{type:'error',status:429,error:'Please wait before sending another message.',nextSend:next,serverTime:now});return;}
        if(this.today().count>=settings.dailyLimit)fail(429,'The daily chat allowance is full. Try after 09:00 KST / 00:00 UTC.');
        if(this.size()>=settings.capacityBytes)fail(507,'Chat storage is full. Existing logs are preserved.');
        const result={...this.append(a.channel,a.id,a.name,body,now,msg.nonce),nicknameColor:a.nicknameColor??null};
        await this.broadcast(a.channel,{type:'message',message:result,serverTime:now});
        this.send(ws,{type:'ack',nonce:msg.nonce,id:result.id,nextSend:now+settings.slowSeconds,serverTime:now});
      }else fail(400,'Unknown chat command.');
      const current=ws.deserializeAttachment();if(current)ws.serializeAttachment({...current,strikes:0});
    }catch(e){this.send(ws,{type:'error',status:e instanceof ApiError?e.status:400,error:e instanceof ApiError?e.message:'Invalid chat request.'});if(e.status===401||e.status===426)ws.close(1008,'Sign in or update');}
  }
  append(channel,owner,name,body,created,nonce){
    let result;
    this.ctx.storage.transactionSync(()=>{
      result=this.rows('INSERT INTO messages(channel,owner,name,body,created,nonce) VALUES(?,?,?,?,?,?) RETURNING id,channel,owner,name,body,created,hidden',channel,owner,name,body,created,nonce)[0];
      this.sql.exec('INSERT INTO daily VALUES(?,1,?) ON CONFLICT(day) DO UPDATE SET count=count+1,bytes=bytes+excluded.bytes',Math.floor(created/86400),encoder.encode(body).length);
    });return result;
  }
  webSocketClose(ws,code,reason){try{ws.close(code===1005||code===1006?1000:code,reason);}catch{}}
  webSocketError(ws){try{ws.close(1011,'Connection error');}catch{}}
  async admin(request,url){
    const route=url.pathname.slice('/admin'.length), method=request.method;
    if(route==='/presence'&&method==='GET'){
      const peers=this.ctx.getWebSockets().filter(ws=>ws.readyState===1&&!ws.deserializeAttachment()?.viewer);
      const snapshot=await this.authenticationSnapshot(peers,true),accounts=new Set();let connections=0;
      for(const ws of peers){
        const a=ws.deserializeAttachment();if(!a)continue;
        try{await this.authenticate({...a,checked:0},snapshot);}catch(e){if(e instanceof ApiError)continue;throw e;}
        if(ws.readyState!==1)continue;
        accounts.add(a.id);connections++;
      }
      return json({accounts:accounts.size,connections,serverTime:seconds()});
    }
    if(route==='/status'&&method==='GET'){
      await this.syncEvents();const usage=this.rows('SELECT COALESCE(SUM(count),0) AS messages,COALESCE(SUM(bytes),0) AS textBytes FROM daily')[0];
      const viewers=this.ctx.getWebSockets().filter(ws=>ws.deserializeAttachment()?.viewer).length;
      return json({settings:this.settings(),usage:{...usage,databaseBytes:this.size(),today:this.today(),connections:this.ctx.getWebSockets().length-viewers,viewers},
        channels:this.rows('SELECT * FROM channels ORDER BY id').map(c=>({...c,members:JSON.parse(c.members)})),mutes:this.rows('SELECT * FROM mutes WHERE until_time>?',seconds()),retention:'indefinite'});
    }
    if(route==='/logs'&&method==='GET'){
      const channel=url.searchParams.get('channel')||'general';if(!validId(channel))fail(400,'Invalid channel.');
      const before=number(Number(url.searchParams.get('before')||Number.MAX_SAFE_INTEGER),1,Number.MAX_SAFE_INTEGER);
      const limit=number(Number(url.searchParams.get('limit')||100),1,1000), messages=this.history(channel,before,limit,true);
      return json({channel,messages,nextBefore:messages.length===limit?messages[0].id:null});
    }
    if(method!=='PUT'&&method!=='POST')fail(404,'Unknown chat action.');
    const data=await readJson(request,16384);
    if(route==='/ticket'&&method==='POST'){
      await this.syncEvents();
      const token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
      const hash=await sha256(encoder.encode(token)),credential=await this.viewerCredential();
      this.sql.exec('DELETE FROM viewer_tickets WHERE expires<=?',seconds());
      if(this.rows('SELECT COUNT(*) AS n FROM viewer_tickets')[0].n>=32)fail(429,'Wait a minute before opening more administrator chat windows.');
      const expires=seconds()+60;this.sql.exec('INSERT INTO viewer_tickets VALUES(?,?,?)',hash,expires,credential);
      return json({ticket:token,expires});
    }
    if(route==='/settings'&&method==='PUT'){
      const s=this.settings();if(data.expectedRevision!==s.revision)fail(409,'Refresh chat settings first.');
      number(data.slowSeconds,0,3600);number(data.dailyLimit,1,15000);
      this.sql.exec('UPDATE settings SET slow=?,daily_limit=?,revision=revision+1 WHERE id=1',data.slowSeconds,data.dailyLimit);
      const peers=this.ctx.getWebSockets(),snapshot=await this.authenticationSnapshot(peers);
      await Promise.all(peers.map(ws=>{const a=ws.deserializeAttachment();return this.deliver(ws,{type:'settings',settings:this.settings(),serverTime:seconds(),nextSend:a.viewer?undefined:this.latest(a.id)+data.slowSeconds},null,snapshot);}));
      return json({settings:this.settings()});
    }
    if(route==='/channels'&&method==='PUT'){
      if(!validId(data.id)||!data.id.startsWith('room:'))fail(400,'Custom channel IDs start with room:.');
      const name=text(data.name,80);if(!['public','members'].includes(data.kind)||typeof data.active!=='boolean'||!Array.isArray(data.members)||data.members.length>256||data.members.some(x=>typeof x!=='string'||!/^[a-f0-9]{32}$/.test(x)))fail(400,'Invalid channel membership.');
      this.sql.exec('INSERT INTO channels VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,active=excluded.active,members=excluded.members',data.id,name,data.kind,data.active?1:0,JSON.stringify([...new Set(data.members)]));
      const peers=this.ctx.getWebSockets(),snapshot=await this.authenticationSnapshot(peers);
      for(const ws of peers){const a=ws.deserializeAttachment();
        if(a.viewer){await this.deliver(ws,{type:'channels',channels:this.viewerChannels()},null,snapshot);continue;}
        const channels=this.channels(a.id);if(!channels.some(c=>c.id===a.channel)){a.channel='general';ws.serializeAttachment(a);await this.deliver(ws,{type:'history',channel:'general',messages:this.history('general')},'general',snapshot);}await this.deliver(ws,{type:'channels',channels:this.channels(a.id)},null,snapshot);}
      return json({saved:true});
    }
    if(route==='/mute'&&method==='PUT'){
      if(typeof data.owner!=='string'||!/^[a-f0-9]{32}$/.test(data.owner))fail(400,'Invalid account.');number(data.until,0,seconds()+366*86400);
      this.sql.exec('INSERT INTO mutes VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET until_time=excluded.until_time,reason=excluded.reason',data.owner,data.until,text(data.reason||'Administrator action',200));
      return json({saved:true});
    }
    if(route==='/hide'&&method==='PUT'){
      number(data.id,1,Number.MAX_SAFE_INTEGER);if(typeof data.hidden!=='boolean')fail(400,'Invalid visibility.');
      const m=this.rows('UPDATE messages SET hidden=? WHERE id=? RETURNING channel',data.hidden?1:0,data.id)[0];if(!m)fail(404,'Message not found.');
      await this.broadcast(m.channel,{type:'history',channel:m.channel,messages:this.history(m.channel)},{type:'moderation',channel:m.channel,id:data.id,hidden:data.hidden});
      return json({saved:true});
    }
    if(route==='/notice'&&method==='POST'){
      const channel=data.channel||'general';if(!validId(channel)||!this.rows('SELECT active FROM channels WHERE id=?',channel)[0]?.active)fail(403,'This channel is unavailable.');
      if(this.size()>=this.settings().capacityBytes)fail(507,'Chat storage is full.');
      if(this.today().count>=this.settings().dailyLimit)fail(429,'The daily chat allowance is full.');
      const message=this.append(channel,'administrator','Announcement',text(data.body),seconds(),crypto.randomUUID().replaceAll('-',''));
      await this.broadcast(channel,{type:'message',message});return json({message});
    }
    fail(404,'Unknown chat action.');
  }
}
