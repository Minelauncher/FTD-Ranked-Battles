export const chatAdminHtml=`<section id="chatAdmin"><h2>실시간 채팅</h2>
<style>
.chat-live-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.chat-live-toolbar button{margin:0}
#chatLiveState{font-size:14px;color:#9ecbe0}.chat-feed{height:420px;overflow-y:auto;background:#0b1620;border:1px solid #365369;border-radius:10px;padding:16px;overscroll-behavior:contain}
.chat-message{display:flex;gap:12px;margin:0 0 18px}.chat-avatar{flex:0 0 34px;height:34px;display:grid;place-items:center;border-radius:9px;background:#234255;color:#d5edff;font-weight:700}
.chat-message-main{min-width:0;flex:1}.chat-message-header{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.chat-message-name{font-weight:700}.chat-message-time{color:#95a9ba;font-size:12px}
.chat-message-body{margin-top:5px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55}.chat-hidden{opacity:.65}.chat-badge{font-size:12px;color:#efbe85}.chat-empty{color:#95a9ba;text-align:center;padding:40px 8px}
#chatJump{display:block;margin:8px auto}#chatJump[hidden]{display:none}.chat-help{color:#95a9ba;font-size:13px}
</style>
<label>채널<select id="chatChannel"><option value="general">General</option></select></label>
<div class="chat-live-toolbar"><button id="chatLoad">채널 새로고침</button><button id="chatLive">채팅 연결</button><button id="chatPause">연결 끊기</button><span id="chatLiveState" role="status">관리자 정보를 불러오면 연결됩니다.</span></div>
<p class="chat-help">선택 채널의 대화가 자동으로 표시됩니다. 위로 스크롤하면 읽던 위치를 유지합니다.</p>
<div id="chatLiveMessages" class="chat-feed" role="region" aria-label="실시간 채팅 메시지" tabindex="0"><p class="chat-empty">연결 후 최근 대화를 불러옵니다.</p></div>
<button id="chatJump" hidden>새 메시지 ↓</button>
<label>관리자 공지<input id="chatNotice" maxlength="300" placeholder="선택한 채널에 공지로 전송됩니다."></label><button id="chatPost">선택 채널에 공지</button>
<details><summary>과거 로그 · 내려받기</summary><p class="chat-help">화면에는 최근 200개까지 표시합니다. 전체 로그는 자동 삭제 없이 보관하며 숨긴 메시지도 기록에 남습니다.</p>
<button id="chatRecent">최근 로그</button><button id="chatOlder">이전 로그</button><button id="chatExport">로그 내려받기 (JSONL, 최대 1만 개씩)</button><button id="chatResetExport">최신부터 내려받기</button><button id="chatStopExport">내려받기 중지</button>
<p id="chatExportState"></p><div id="chatLogs" style="max-height:420px;overflow:auto"></div>
</details>
<details><summary>사용량 · 전송 간격</summary><p id="chatUsage"></p>
<div class="row"><label>계정당 전송 간격 (초)<input id="chatSlow" type="number" min="0" max="3600" value="30"></label><label>전체 채널 일일 메시지 한도<input id="chatDaily" type="number" min="1" max="15000" value="10000"></label></div><button id="chatSave">속도·한도 저장</button></details>
<details><summary>채팅 금지 및 채널 관리</summary>
<div class="row"><label>계정 ID<input id="chatMuteOwner"></label><label>금지 시간 (분, 0은 해제)<input id="chatMuteMinutes" type="number" min="0" max="527040" value="60"></label></div>
<label>사유<input id="chatMuteReason" maxlength="200"></label><button id="chatMute">채팅 금지 적용</button><div id="chatMutes"></div>
<label>채널 ID (room:로 시작)<input id="chatRoomId" placeholder="room:tournament-32"></label><label>채널 이름<input id="chatRoomName" maxlength="80"></label>
<label>접근<select id="chatRoomKind"><option value="public">전체 계정</option><option value="members">지정 참가자만</option></select></label>
<label>참가자 계정 ID (줄마다 하나, 지정 참가자 채널용)<textarea id="chatMembers" rows="3"></textarea></label>
<label>활성<input id="chatRoomActive" type="checkbox" checked></label><button id="chatRoomSave">채널 저장</button>
<small>대회 채널은 자동 생성됩니다. 토너먼트 전용 채널은 참가자 계정 ID로 접근을 제한할 수 있습니다.</small></details></section>`;
export function chatAdmin(){
  let revision=0,before=null,stop=false,exportCursor=null,exportDone=false,exporting=false;
  let socket=null,wanted=false,generation=0,retryTimer=null,heartbeat=null,handshake=null,renewal=null,retries=0,lastPong=0,unread=0;
  const messages=new Map();
  const get=id=>document.getElementById(id), mb=n=>(n/1000000).toFixed(2)+' MB';
  const channel=()=>get('chatChannel').value;
  const state=message=>{get('chatLiveState').textContent=message;};
  const nearBottom=()=>{const feed=get('chatLiveMessages');return feed.scrollHeight-feed.scrollTop-feed.clientHeight<60;};
  function sync(){
    get('chatLive').disabled=busy||wanted;get('chatPause').disabled=!wanted;
    get('chatChannel').disabled=busy||exporting;get('chatLoad').disabled=busy||exporting;
    get('chatExport').disabled=busy||exporting;get('chatResetExport').disabled=busy||exporting;
    get('chatOlder').disabled=busy||!before;get('chatStopExport').disabled=!exporting;
  }
  function clearTimers(){clearTimeout(retryTimer);clearTimeout(handshake);clearTimeout(renewal);clearInterval(heartbeat);retryTimer=handshake=renewal=heartbeat=null;}
  function disconnect(clear=false){
    wanted=false;generation++;clearTimers();const old=socket;socket=null;
    if(old)old.close(1000,'Viewer closed');
    if(clear){messages.clear();render(true);get('chatLogs').replaceChildren();before=null;}
    state('연결 끊김 · 다시 연결하면 최근 대화를 불러옵니다.');sync();
  }
  function channels(items){
    const selected=channel();get('chatChannel').replaceChildren();
    for(const c of items){const o=document.createElement('option');o.value=c.id;o.textContent=c.name+(c.active===0?' (비활성)':'');get('chatChannel').append(o);}
    if(items.some(c=>c.id===selected))get('chatChannel').value=selected;
  }
  function render(bottom=false){
    const feed=get('chatLiveMessages'),position=feed.scrollTop;feed.replaceChildren();
    for(const m of [...messages.values()].sort((a,b)=>a.id-b.id)){
      const row=document.createElement('div');row.className='chat-message'+(m.hidden?' chat-hidden':'');row.dataset.messageId=m.id;
      const avatar=document.createElement('div');avatar.className='chat-avatar';avatar.textContent=[...(m.name||'?')][0];avatar.setAttribute('aria-hidden','true');
      const main=document.createElement('div');main.className='chat-message-main';
      const header=document.createElement('div');header.className='chat-message-header';
      const name=document.createElement('span');name.className='chat-message-name';name.textContent=m.name;name.title=m.owner;
      if(/^#[0-9a-f]{6}$/i.test(m.nicknameColor||''))name.style.color=m.nicknameColor;
      const time=document.createElement('time');time.className='chat-message-time';time.dateTime=new Date(m.created*1000).toISOString();time.textContent=new Date(m.created*1000).toLocaleString();
      header.append(name,time);
      if(m.hidden){const badge=document.createElement('span');badge.className='chat-badge';badge.textContent='숨김 · 관리자에게만 표시';header.append(badge);}
      const body=document.createElement('div');body.className='chat-message-body';body.textContent=m.body;main.append(header,body);row.append(avatar,main);feed.append(row);
    }
    if(!messages.size){const empty=document.createElement('p');empty.className='chat-empty';empty.textContent='아직 표시할 메시지가 없습니다.';feed.append(empty);}
    feed.scrollTop=bottom?feed.scrollHeight:position;
    if(bottom)unread=0;get('chatJump').hidden=unread===0;get('chatJump').textContent='새 메시지 '+unread+'개 ↓';
  }
  function receive(data){
    if(data.type==='hello'||data.type==='channels')channels(data.channels);
    if(data.type==='hello'){
      retries=0;clearTimeout(handshake);clearTimeout(renewal);
      renewal=setTimeout(()=>{if(wanted){const old=socket;socket=null;old?.close(1000,'Renew viewer');connect();}},Math.max(1000,(data.expires-Date.now()/1000-60)*1000));
      if(channel()!==data.channel){socket.send(JSON.stringify({type:'join',channel:channel()}));return;}
    }
    if((data.type==='hello'||data.type==='history')&&data.channel===channel()){
      messages.clear();for(const m of data.messages)messages.set(m.id,m);render(true);state('● 실시간 연결됨');
    }else if(data.type==='message'&&data.message.channel===channel()){
      const bottom=nearBottom(),m=data.message,isNew=!messages.has(m.id);messages.set(m.id,m);
      while(messages.size>200)messages.delete(Math.min(...messages.keys()));
      if(isNew&&!bottom)unread++;render(bottom);
    }else if(data.type==='profile'){
      for(const m of messages.values())if(m.owner===data.owner)m.nicknameColor=data.nicknameColor;render(nearBottom());
    }else if(data.type==='moderation'&&data.channel===channel()){
      const m=messages.get(data.id);if(m){m.hidden=data.hidden;render(nearBottom());}
    }else if(data.type==='settings'){
      revision=data.settings.revision;get('chatSlow').value=data.settings.slowSeconds;get('chatDaily').value=data.settings.dailyLimit;
    }else if(data.type==='error'){
      if(data.status===401){disconnect();state('관리자 인증이 만료되었습니다. 다시 연결하세요.');}else state(data.error);
    }
  }
  function retry(){
    if(!wanted)return;
    if(++retries>5){disconnect();state('연결하지 못했습니다. 관리자 키와 인터넷 연결을 확인한 뒤 다시 연결하세요.');return;}
    const delay=Math.min(30000,1000*2**retries);state('연결 끊김 · '+delay/1000+'초 뒤 재연결');retryTimer=setTimeout(connect,delay);
  }
  async function connect(){
    if(!wanted)return;clearTimers();const attempt=++generation;state('채팅 연결 중…');
    try{
      const ticket=await api('/admin/chat/ticket','POST',{});if(!wanted||attempt!==generation)return;
      const url=new URL('/admin/chat/socket',window.location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('ticket',ticket.ticket);
      const ws=new WebSocket(url);socket=ws;handshake=setTimeout(()=>{if(socket===ws){ws.close();}},15000);
      ws.onopen=()=>{if(socket!==ws)return;lastPong=Date.now();heartbeat=setInterval(()=>{
        if(socket!==ws||ws.readyState!==1)return;
        if(Date.now()-lastPong>75000){ws.close();return;}ws.send('ping');
      },25000);};
      ws.onmessage=event=>{if(socket!==ws||attempt!==generation)return;if(event.data==='pong'){lastPong=Date.now();return;}try{receive(JSON.parse(event.data));}catch{state('채팅 데이터를 읽지 못했습니다. 다시 연결합니다.');ws.close();}};
      ws.onerror=()=>{if(socket===ws)state('채팅 연결을 확인하는 중…');};
      ws.onclose=()=>{if(socket!==ws||attempt!==generation)return;socket=null;clearTimers();retry();};
    }catch(e){if(!wanted||attempt!==generation)return;disconnect();state(e.message);}
    sync();
  }
  async function start(){if(wanted)return;wanted=true;retries=0;sync();await connect();}
  async function open(){try{await load();await start();}catch(e){state(e.message);}}
  async function load(){
    const s=await api('/admin/chat/status');revision=s.settings.revision;
    get('chatSlow').value=s.settings.slowSeconds;get('chatDaily').value=s.settings.dailyLimit;
    const u=s.usage, days=u.today.count>0?Math.floor((s.settings.capacityBytes-u.databaseBytes)/Math.max(1,u.databaseBytes/Math.max(1,u.messages)*u.today.count)):null;
    get('chatUsage').textContent='누적 '+u.messages.toLocaleString()+'개 · 저장 '+mb(u.databaseBytes)+' / '+mb(s.settings.capacityBytes)+' · 오늘 '+u.today.count+' / '+s.settings.dailyLimit+'개 · 연결 '+u.connections+'개'+(days!==null?' · 오늘 메시지 수 기준 잔여 약 '+days+'일 (추정)':'');
    channels(s.channels);
    get('chatMutes').textContent=s.mutes.map(m=>m.owner+' · '+new Date(m.until_time*1000).toLocaleString()+' · '+m.reason).join('\n');
  }
  async function logs(older=false){
    const data=await api('/admin/chat/logs?channel='+encodeURIComponent(channel())+(older&&before?'&before='+before:''));before=data.nextBefore;
    get('chatLogs').replaceChildren();
    for(const m of data.messages){
      const row=document.createElement('div');row.style.cssText='padding:10px;margin:5px 0;background:#10202c;white-space:pre-wrap';
      const content=document.createElement('div');content.textContent=new Date(m.created*1000).toLocaleString()+' · '+m.name+' · '+m.owner+'\n'+m.body+(m.hidden?' [숨김]':'');
      const hide=document.createElement('button');hide.textContent=m.hidden?'다시 표시':'숨기기';hide.onclick=()=>run(async()=>{await api('/admin/chat/hide','PUT',{id:m.id,hidden:!m.hidden});await logs();});
      row.append(content,hide);get('chatLogs').append(row);
    }
  }
  get('chatLoad').onclick=()=>run(open);get('chatLive').onclick=()=>run(open);get('chatPause').onclick=()=>disconnect();
  get('chatJump').onclick=()=>render(true);
  get('chatLiveMessages').onscroll=()=>{if(nearBottom()){unread=0;get('chatJump').hidden=true;}};
  get('chatSave').onclick=()=>run(async()=>{if(!revision)throw Error('채팅 상태를 먼저 조회하세요.');await api('/admin/chat/settings','PUT',{slowSeconds:Number(get('chatSlow').value),dailyLimit:Number(get('chatDaily').value),expectedRevision:revision});await load();});
  get('chatRecent').onclick=()=>run(()=>logs());get('chatOlder').onclick=()=>run(async()=>{if(before)await logs(true);});
  get('chatChannel').onchange=()=>{before=null;exportCursor=null;exportDone=false;get('chatLogs').replaceChildren();get('chatExportState').textContent='';messages.clear();render(true);sync();
    if(socket?.readyState===1){state('채널 대화 불러오는 중…');socket.send(JSON.stringify({type:'join',channel:channel()}));}
  };
  get('chatPost').onclick=()=>run(async()=>{await api('/admin/chat/notice','POST',{channel:channel(),body:get('chatNotice').value});get('chatNotice').value='';});
  get('chatMute').onclick=()=>run(async()=>{const minutes=Number(get('chatMuteMinutes').value);if(!Number.isInteger(minutes)||minutes<0||minutes>527040)throw Error('시간을 확인하세요.');await api('/admin/chat/mute','PUT',{owner:get('chatMuteOwner').value.trim(),until:minutes?Math.floor(Date.now()/1000)+minutes*60:0,reason:get('chatMuteReason').value});await load();});
  get('chatRoomSave').onclick=()=>run(async()=>{await api('/admin/chat/channels','PUT',{id:get('chatRoomId').value.trim(),name:get('chatRoomName').value,kind:get('chatRoomKind').value,active:get('chatRoomActive').checked,members:get('chatMembers').value.split(/\s+/).filter(Boolean)});await load();});
  get('chatStopExport').onclick=()=>{stop=true;};
  get('chatResetExport').onclick=()=>{if(exporting)return;exportCursor=null;exportDone=false;get('chatExportState').textContent='다음 내려받기는 최신 기록부터 시작합니다.';};
  get('chatExport').onclick=async()=>{
    if(busy||exporting)return;if(exportDone){get('chatExportState').textContent='이 채널의 마지막 기록까지 내려받았습니다. 최신부터 다시 시작할 수 있습니다.';return;}
    stop=false;exporting=true;sync();
    const selected=channel(),chunks=[],start=exportCursor;let cursor=start,count=0;
    try{do{const page=await api('/admin/chat/logs?channel='+encodeURIComponent(selected)+'&limit=1000'+(cursor?'&before='+cursor:''));chunks.push(page.messages.map(m=>JSON.stringify(m)+'\n').join(''));count+=page.messages.length;cursor=page.nextBefore;get('chatExportState').textContent=count.toLocaleString()+'개 읽음';}while(cursor&&!stop&&count<10000);
      const blob=new Blob(chunks,{type:'application/x-ndjson;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=selected.replaceAll(':','-')+'-chat-before-'+(start??'latest')+'.jsonl';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      exportCursor=cursor;exportDone=!cursor;get('chatExportState').textContent=count.toLocaleString()+'개 내려받음. '+(cursor?'다시 누르면 이전 기록을 이어서 받습니다. 다음 커서: '+cursor:'마지막 기록입니다.');
    }catch(e){get('chatExportState').textContent=e.message;}finally{exporting=false;sync();}
  };
  get('token').addEventListener('input',()=>{stop=true;disconnect(true);});
  window.addEventListener('pagehide',()=>{stop=true;disconnect(true);});
  sync();return {open,sync,disconnect};
}
