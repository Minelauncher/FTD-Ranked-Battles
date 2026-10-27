export const activityAdminHtml=`<style>
.activity-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.activity-head h2{margin:0}.activity-head label{flex-direction:row;align-items:center;font-size:.9rem}.activity-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.activity-card{background:#10202c;border:1px solid #405c6c;border-radius:8px;padding:16px}.activity-card h3{margin:0;font-size:.95rem;color:#b9cad5}.activity-number{display:block;margin:8px 0;font-size:2rem;font-weight:700;color:#8ce0c2;font-variant-numeric:tabular-nums}.activity-card small{display:block;line-height:1.5}.activity-table{overflow:auto;max-height:560px}.activity-table th{position:sticky;top:0;background:#1a2732;z-index:1}.activity-table table{min-width:720px}.activity-table tbody tr:nth-child(odd){background:#142430}.activity-table td{vertical-align:top}.activity-table small{display:block;margin-top:5px}.activity-badge{display:inline-block;border-radius:5px;padding:4px 8px;background:#2d4454;white-space:nowrap}.activity-win{background:#174b40;color:#a7f1d5}.activity-loss{background:#59323a;color:#ffd0d6}.activity-pending{background:#52452b;color:#ffe0a0}.activity-muted{color:#a9bcc9}.activity-toolbar{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.activity-toolbar label{flex:1;min-width:180px}.activity-toolbar button{margin-bottom:10px}.activity-id{font-family:monospace;font-size:.75rem}.activity-table th:nth-child(1){width:20%}.activity-table th:nth-child(2){width:18%}.activity-table th:nth-child(3){width:32%}@media(max-width:760px){.activity-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:380px){.activity-grid{grid-template-columns:1fr}}
</style>
<section id="activityAdmin" aria-labelledby="activityTitle">
<div class="activity-head"><h2 id="activityTitle">접속 현황 · 최근 경기</h2><label><input id="activityAuto" type="checkbox" checked>30초마다 자동 갱신</label></div>
<p id="activityStatus" role="status">관리자 키를 입력한 뒤 불러오세요.</p>
<div class="activity-grid">
<div class="activity-card"><h3>접속 계정 · 채팅 기준</h3><strong id="activityOnline" class="activity-number">—</strong><small id="activityConnections">같은 계정의 중복 연결 제외</small></div>
<div class="activity-card"><h3>진행 중인 매칭</h3><strong id="activityPending" class="activity-number">—</strong><small id="activityPendingHelp">다운로드·전투·결과 제출 대기 포함</small></div>
<div class="activity-card"><h3>최근 24시간 경기</h3><strong id="activityMatches24h" class="activity-number">—</strong><small id="activityPlayers24h">매칭을 시작한 계정 수</small></div>
<div class="activity-card"><h3>가입 계정</h3><strong id="activityAccounts" class="activity-number">—</strong><small>관리자 포함 · 기본 상대 제외</small></div>
</div>
<p class="activity-muted">채팅 연결이 유지되는 계정만 집계합니다. 채팅을 열지 않은 사용자나 게임만 켜둔 사용자는 확인되지 않습니다.</p>
<div class="activity-toolbar"><label>경기 대회<select id="activityEvent"><option value="">전체 대회</option></select></label><button id="activityRefresh">최신 기록</button><button id="activityNext" disabled>이전 25경기</button></div>
<p id="activityMatchesStatus" role="status">아직 조회하지 않았습니다.</p>
<div class="activity-table"><table id="activityTable" hidden><thead><tr><th>매칭 / 종료 시각 (한국)</th><th>대회</th><th>실행자 → 상대</th><th>실행자 결과 / 사유</th><th>레이팅 변화</th></tr></thead><tbody id="activityRows"></tbody></table></div>
<small>매칭 시각 최신순 · 레이팅 변화는 실행자 / 상대 순서입니다. 이전 기록을 보는 동안 자동 갱신은 위 현황만 갱신합니다.</small>
</section>`;

export function activityAdmin(){
  let next=null,pageCursor=null,loaded=false,epoch=0;
  const count=n=>Number(n).toLocaleString('ko-KR');
  const date=n=>n==null?'—':new Date(n*1000).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false});
  const delta=n=>n==null?'—':(n>0?'+':'')+Number(n).toFixed(1);
  const reasons={elimination:'전멸','mutual-elimination':'양쪽 전멸',judgment:'시간 종료 · 판정','timeout-draw':'시간 종료 · 동률',surrender:'항복','submission-expired':'결과 제출 기한 초과'};
  function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
  function sync(){el('activityNext').disabled=busy||!next;el('activityEvent').disabled=busy;}
  function unknown(){for(const id of ['activityOnline','activityPending','activityMatches24h','activityAccounts'])el(id).textContent='—';el('activityConnections').textContent='조회 불가';el('activityPlayers24h').textContent='조회 불가';el('activityPendingHelp').textContent='조회 불가';}
  function clear(){epoch++;loaded=false;next=pageCursor=null;unknown();el('activityEvent').replaceChildren(node('option','전체 대회'));el('activityEvent').firstChild.value='';el('activityRows').replaceChildren();el('activityTable').hidden=true;el('activityStatus').textContent='관리자 키를 입력한 뒤 불러오세요.';el('activityMatchesStatus').textContent='아직 조회하지 않았습니다.';sync();}
  async function overview(){
    const turn=epoch;
    try{
      const data=await api('/admin/activity');if(turn!==epoch)return false;
      const s=data.summary,p=data.presence;
      el('activityOnline').textContent=p.available?count(p.accounts):'—';
      el('activityConnections').textContent=p.available?'유효한 연결 '+count(p.connections)+'개 · 중복 계정 제외':'채팅 접속 현황 조회 불가';
      el('activityPending').textContent=count(s.pendingMatches);
      el('activityPendingHelp').textContent=s.overdueMatches?'기한 초과 · 정산 대기 '+count(s.overdueMatches)+'건':'다운로드·전투·결과 제출 대기 포함';
      el('activityMatches24h').textContent=count(s.matches24h);el('activityPlayers24h').textContent=count(s.players24h)+'개 계정이 매칭 시작';
      el('activityAccounts').textContent=count(s.accounts);el('activityStatus').textContent='조회 시각 '+date(data.serverTime);return true;
    }catch(e){if(turn===epoch){unknown();el('activityStatus').textContent='현황 조회 실패 · '+e.message;}return false;}
  }
  async function matches(cursor=null){
    const turn=epoch,event=el('activityEvent').value;
    next=null;sync();el('activityMatchesStatus').textContent='경기 기록 조회 중…';
    try{
      const query=new URLSearchParams();if(event)query.set('tournament',event);if(cursor)query.set('before',cursor);
      const data=await api('/admin/activity/matches?'+query);if(turn!==epoch)return;
      pageCursor=cursor;next=data.next;el('activityRows').replaceChildren();
      for(const m of data.matches){
        const tr=node('tr'),time=node('td',date(m.created));time.append(node('small',m.completed==null?'종료 —':'종료 '+date(m.completed)));tr.append(time);
        tr.append(node('td',m.tournamentName));const who=node('td');who.append(node('strong',m.playerName),node('small','→ '+m.opponentName+(m.systemOpponent?' · 기본 상대':'')));
        const detail=node('details');detail.append(node('summary','경기 ID'),node('span',m.id,'activity-id'));who.append(detail);tr.append(who);
        const pending=m.status==='pending',overdue=pending&&m.deadline<=data.serverTime;
        const label=pending?(overdue?'정산 대기':'진행 중'):m.status==='cancelled'?'취소':m.score===1?'승리':m.score===0?'패배':'무승부';
        const result=node('td');result.append(node('span',label,'activity-badge '+(pending?'activity-pending':m.status!=='completed'?'':m.score===1?'activity-win':m.score===0?'activity-loss':'')));
        result.append(node('small',pending?'제출 기한 '+date(m.deadline):reasons[m.outcome]||m.outcome||'—'));tr.append(result);
        const rating=node('td',delta(m.ratingChange));rating.append(node('small','상대 '+delta(m.opponentRatingChange)));tr.append(rating);el('activityRows').append(tr);
      }
      el('activityTable').hidden=!data.matches.length;
      el('activityMatchesStatus').textContent=(data.matches.length?count(data.matches.length)+'경기 · '+(cursor?'이전 기록':'최신 기록'):'경기 기록이 없습니다.')+' · 조회 '+date(data.serverTime);sync();
    }catch(e){if(turn===epoch){next=null;el('activityTable').hidden=true;el('activityRows').replaceChildren();el('activityMatchesStatus').textContent='경기 조회 실패 · '+e.message;sync();}}
  }
  async function load(){
    const selected=el('activityEvent').value;el('activityEvent').replaceChildren(node('option','전체 대회'));el('activityEvent').firstChild.value='';
    for(const event of state?.tournaments||[]){const option=node('option',event.name);option.value=event.id;el('activityEvent').append(option);}
    if((state?.tournaments||[]).some(e=>e.id===selected))el('activityEvent').value=selected;
    loaded=await overview();await matches();
  }
  el('activityRefresh').onclick=()=>run(load);el('activityNext').onclick=()=>run(()=>matches(next));
  el('activityEvent').onchange=()=>run(()=>matches());
  el('token').addEventListener('input',clear);window.addEventListener('pagehide',clear);
  setInterval(()=>{if(loaded&&el('activityAuto').checked&&!document.hidden&&!busy)run(async()=>{await overview();if(pageCursor===null)await matches();});},30000);
  return {sync,load,clear};
}
