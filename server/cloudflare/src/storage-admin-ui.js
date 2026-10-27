export const storageAdminHtml=`<style>
.storage-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.storage-heading h2{margin:0}.storage-summary{font-size:1.15rem;font-weight:600}.storage-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}.storage-card{background:#10202c;border:1px solid #405c6c;border-radius:8px;padding:16px}.storage-card h3{margin:0 0 12px}.storage-card .capacity{font-size:1.4rem;font-weight:650;font-variant-numeric:tabular-nums}.storage-card .remaining{color:#8ce0c2;margin:8px 0}.storage-card meter{display:block;width:100%;height:18px;margin:12px 0}.storage-warn{color:#ffd18a}.storage-bad{color:#ff9c9c}.storage-good{color:#91dec8}.storage-muted{color:#adc2cf}.storage-policy{font-size:.9rem}.storage-history{max-height:460px;overflow:auto}.storage-history td{vertical-align:top}.storage-history details{max-width:340px}.storage-history li{margin:8px 0}.storage-history code,.bp-hash{font-size:.75rem;overflow-wrap:anywhere;color:#adc2cf}.storage-bp td{vertical-align:top}.storage-bp .bp-name{display:block;font-weight:600}.storage-bp small{display:block;margin:4px 0}.storage-toolbar{display:flex;gap:8px;align-items:end;flex-wrap:wrap}.storage-toolbar label{flex:1;min-width:220px}.storage-toolbar button{margin-bottom:10px}#storageContent h3{margin-top:24px}#storageContent .storage-card h3{margin-top:0}
</style>
<section aria-labelledby="storageTitle">
<div class="storage-heading"><h2 id="storageTitle">DB 사용량 · BP 관리</h2><button id="storageRefresh">저장소 새로고침</button></div>
<p id="storageStatus" role="status">관리자 키를 입력한 뒤 불러오세요.</p>
<div id="storageContent" hidden><p id="storageSummary" class="storage-summary"></p><div id="storageDatabases" class="storage-grid"></div>
<p class="storage-policy">연결된 DB 기준 · DB당 무료 한도 500 MB · 사용량에는 BP 외의 계정·전적·인덱스도 포함됩니다.</p>
<h3>BP 자동 정리</h3><p id="cleanupStatus"></p><p id="cleanupCounts"></p>
<p class="storage-policy">사용 중인 함대·진행 경기는 보존합니다. 미사용 BP는 24시간 유예 후 15분마다 최대 20개씩 정리합니다.</p>
<details id="cleanupDetails"><summary>최근 정리 내역 <span id="cleanupHistoryCount"></span></summary>
<p id="cleanupHistoryHelp" class="storage-policy"></p><div class="storage-history"><table><thead><tr><th>실행 시각 (한국)</th><th>결과</th><th>대상 / 완료</th><th>확인된 삭제량</th><th>대상 BP</th></tr></thead><tbody id="cleanupRows"></tbody></table></div></details></div>
<h3>BP 원본 다운로드</h3><div class="storage-toolbar"><label>보관 BP 검색<input id="storageBpQuery" maxlength="100" placeholder="BP 이름 · 참가자 닉네임 · 해시" autocomplete="off"></label><button id="storageBpSearch">BP 검색</button><button id="storageBpNext" disabled>다음 25개</button></div>
<p id="storageBpStatus" role="status">관리자 키를 입력한 뒤 검색하세요.</p>
<div class="account-table storage-bp"><table id="storageBpTable" hidden><thead><tr><th>BP / 참가자</th><th>원본 크기 · DB</th><th>사용 현황</th><th>다운로드</th></tr></thead><tbody id="storageBpRows"></tbody></table></div>
<small>원본 .blueprint 파일을 받습니다. 이미 자동 정리된 BP는 다운로드할 수 없습니다.</small>
</section>`;

// Serialized into the self-contained admin page. Server strings are always text,
// and download authorization stays in headers, never URLs or browser storage.
export function storageAdmin() {
  let next=null,query='';
  const disabledDownloads=new Set();
  const count=n=>Number(n??0).toLocaleString('ko-KR');
  const size=n=>n==null?'조회 불가':n<1000?count(n)+' B':n<1000000?(n/1000).toFixed(1)+' KB':n<1000000000?(n/1000000).toFixed(2)+' MB':(n/1000000000).toFixed(2)+' GB';
  const date=n=>n==null?'아직 없음':new Date(n*1000).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false});
  function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
  function sync(){el('storageBpNext').disabled=busy||!next;for(const b of disabledDownloads)b.disabled=true;}
  function clear(){next=null;disabledDownloads.clear();el('storageContent').hidden=true;el('storageDatabases').replaceChildren();el('cleanupRows').replaceChildren();el('storageBpRows').replaceChildren();el('storageBpTable').hidden=true;el('storageStatus').textContent='관리자 키를 입력한 뒤 불러오세요.';el('storageBpStatus').textContent='관리자 키를 입력한 뒤 검색하세요.';sync();}
  async function loadOverview(){
    el('storageStatus').textContent='저장소 조회 중…';
    let data;
    try{data=await api('/admin/storage');}catch(e){el('storageContent').hidden=true;el('storageStatus').textContent='조회 실패 · 다시 시도하세요.';throw e;}
    el('storageContent').hidden=false;el('storageDatabases').replaceChildren();
    el('storageSummary').textContent='연결 DB '+data.databases.length+'개 · 사용 '+size(data.total.bytes)+' · 남음 '+size(data.total.remaining);
    for(const d of data.databases){
      const card=node('div',undefined,'storage-card');card.append(node('h3',d.binding+' · '+(d.role==='main'?'계정·전적·BP':'BP 저장소')));
      if(d.bytes===null)card.append(node('p','사용량 조회 실패','storage-bad'));
      else{
        card.append(node('div',size(d.bytes)+' / '+size(d.limit),'capacity'));
        const meter=node('meter');meter.min=0;meter.max=d.limit;meter.value=d.bytes;meter.low=d.limit*.7;meter.high=d.limit*.9;meter.optimum=0;meter.setAttribute('aria-label',d.binding+' 사용량');card.append(meter);
        card.append(node('div','남은 용량 '+size(d.remaining),'remaining'));
        if(d.bytes>=d.limit*.9)card.append(node('p','용량이 거의 찼습니다.','storage-warn'));
      }
      card.append(node('small',(d.objects===null?'BP 개수 조회 불가':'BP 원본 '+count(d.objects)+'개')+(d.writer?' · 신규 업로드 저장소':'')));el('storageDatabases').append(card);
    }
    const c=data.cleanup,locked=c.lease_until>data.serverTime;
    el('cleanupStatus').textContent=(c.enabled?'자동 정리 켜짐':'자동 정리 꺼짐')+' · 최근 검사 '+date(c.last_finished)+(locked?' · 작업 중 또는 재시도 대기 (잠금 해제 '+date(c.lease_until)+')':'');
    el('cleanupCounts').textContent='사용 중 '+count(c.inUse)+'개 · 정리 가능 '+count(c.eligible)+'개 · 정리 중 '+count(c.deleting)+'개';
    el('cleanupHistoryCount').textContent='('+count(c.history.length)+'건)';el('cleanupRows').replaceChildren();
    el('cleanupHistoryHelp').textContent='최근 100건의 삭제 작업·실패 기록입니다. 삭제 대상이 없는 검사는 위 최근 시각에만 반영됩니다. 삭제량은 확인된 압축 BP 데이터로, DB 전체 용량 감소량과 다를 수 있습니다.'+(c.history.length?'':' 기록 기능 적용 이후 아직 내역이 없습니다.');
    const labels={running:'진행 중',completed:'완료',failed:'실패 · 재시도 대기',interrupted:'중단 · 재시도'},errors={start:'기록 시작',claim:'대상 선택',inspect:'저장소 확인',delete:'원본 삭제',finalize:'상태 저장',interrupted:'이전 실행 중단'};
    for(const h of c.history){
      const tr=node('tr');tr.append(node('td',date(h.started)));
      const state=node('td',labels[h.status]||h.status,h.status==='completed'?'storage-good':h.status==='running'?'storage-warn':'storage-bad');
      if(h.error)state.append(node('small',' · '+(errors[h.error]||'처리 오류')));tr.append(state);
      tr.append(node('td',count(h.selected_count)+' / '+count(h.deleted_count)));
      tr.append(node('td',size(h.confirmed_bytes)+' · '+count(h.confirmed_copies)+'개 복사본'));
      const td=node('td');if(h.items.length){const detail=node('details'),ul=node('ul');detail.append(node('summary','BP '+h.items.length+'개 보기'));for(const bp of h.items){const li=node('li',bp.name);li.append(node('br'),node('code',bp.hash));ul.append(li);}detail.append(ul);td.append(detail);}else td.textContent='대상 선택 전';tr.append(td);el('cleanupRows').append(tr);
    }
    el('storageStatus').textContent='조회 시각 '+date(data.serverTime)+(data.databases.some(d=>!d.available||d.bytes===null)?' · 일부 DB 조회 실패':'');
  }
  async function download(bp){
    el('storageBpStatus').textContent=bp.name+' 다운로드 중…';
    const response=await fetch('/admin/blueprints/'+bp.hash+'/download',{headers:{Authorization:'Bearer '+el('token').value}});
    if(!response.ok){const result=await response.json();el('storageBpStatus').textContent='다운로드 실패';throw Error(result.error||response.status);}
    const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=bp.name.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g,'_').replace(/\.blueprint$/i,'').slice(0,100)+'.blueprint';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
    el('storageBpStatus').textContent=bp.name+' · 다운로드를 시작했습니다. ('+size(blob.size)+')';
  }
  async function loadBlueprints(more=false){
    const cursor=more?next:null;query=more?query:el('storageBpQuery').value.trim();next=null;disabledDownloads.clear();el('storageBpRows').replaceChildren();el('storageBpTable').hidden=true;el('storageBpStatus').textContent='BP 조회 중…';
    let data;
    try{data=await api('/admin/blueprints?q='+encodeURIComponent(query)+(cursor?'&after='+cursor:''));}catch(e){el('storageBpStatus').textContent='BP 조회 실패';throw e;}
    next=data.next;el('storageBpTable').hidden=!data.blueprints.length;
    for(const bp of data.blueprints){
      const tr=node('tr'),identity=node('td');identity.append(node('span',bp.name,'bp-name'),node('small',(bp.ownerName??'참가자 정보 없음')+(bp.owners>1?' 외 '+(bp.owners-1)+'명':'')),node('code',bp.hash,'bp-hash'));tr.append(identity);
      tr.append(node('td',size(bp.size)+' · '+bp.storage));
      tr.append(node('td',bp.state==='deleting'?'정리 중':bp.fleets||bp.matches?'제출 함대 '+count(bp.fleets)+' · 진행 경기 '+count(bp.matches):'미사용 · 정리 유예'));
      const td=node('td'),button=node('button',bp.downloadable?'BP 다운로드':'다운로드 불가');button.onclick=()=>run(()=>download(bp));if(!bp.downloadable){button.disabled=true;disabledDownloads.add(button);}td.append(button);tr.append(td);el('storageBpRows').append(tr);
    }
    el('storageBpStatus').textContent=data.blueprints.length?data.blueprints.length+'개 표시'+(next?' · 다음 페이지가 있습니다.':' · 마지막 페이지입니다.'):'보관 중인 BP가 없습니다.';
    sync();
  }
  el('storageRefresh').onclick=()=>run(loadOverview);el('storageBpSearch').onclick=()=>run(()=>loadBlueprints());el('storageBpNext').onclick=()=>run(()=>loadBlueprints(true));
  el('storageBpQuery').oninput=()=>{next=null;sync();};el('storageBpQuery').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();run(()=>loadBlueprints());}};
  el('token').addEventListener('input',clear);window.addEventListener('pagehide',clear);
  return {sync,clear,loadOverview,loadBlueprints};
}
