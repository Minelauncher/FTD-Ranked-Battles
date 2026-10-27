import { storageAdminHtml, storageAdmin } from './storage-admin-ui.js';
import { activityAdminHtml, activityAdmin } from './activity-admin-ui.js';
import { chatAdminHtml, chatAdmin } from './chat-admin-ui.js';
import { opponentAdminHtml, opponentAdmin } from './opponent-admin.js';
import { inspectBlueprint } from './blueprint-inspector.js';
import { battlefieldMaps } from './battlefield-maps.js';
import { mapCoordinates, mapPoint, mapViewport } from './map-picker.js';
export function adminPage() {
  return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } });
}
const page = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FTD 서버 관리</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101820;color:#e4eef4}body{max-width:1080px;margin:32px auto;padding:0 20px}h1{margin-bottom:8px}p{color:#b9cad5;line-height:1.6}section{background:#1a2732;padding:20px;margin:20px 0;border:1px solid #344b5b;border-radius:10px}label{display:flex;flex-direction:column;gap:6px;margin:10px 0}input,select,textarea,button{font:inherit;padding:10px;border:1px solid #536b7c;border-radius:5px;background:#10202c;color:inherit}button{background:#245873;cursor:pointer;margin:6px 6px 6px 0}button:disabled{opacity:.4;cursor:wait}input[type=checkbox]{width:22px;height:22px}#rules{display:grid;grid-template-columns:repeat(auto-fit,minmax(245px,1fr));gap:0 20px}#message{white-space:pre-wrap;position:sticky;top:0;padding:12px;background:#142d3d;border-left:4px solid #5bc9e8;z-index:1;min-height:24px}.row{display:flex;gap:12px;flex-wrap:wrap}.row>label{flex:1;min-width:180px}#editor{display:none}small{color:#a9bcc9}</style>
<style>
.map-panel{max-width:720px;margin:18px auto}.map-compass{display:flex;justify-content:space-between;gap:10px;font-size:.9rem;color:#b9cad5;margin:6px 0}.map-frame{border:1px solid #648395;border-radius:6px;overflow:hidden;background:#0c243b}#battlefieldMap{display:block;width:100%;aspect-ratio:1;cursor:crosshair;outline-offset:-4px;touch-action:manipulation}#battlefieldMap:focus-visible{outline:3px solid #ffcd72}.map-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.map-toolbar label{flex-direction:row;align-items:center}.map-toolbar button{margin:0}.map-legend{font-size:.9rem;display:flex;gap:16px;flex-wrap:wrap;color:#c9d7df}.map-legend i{display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:6px}#mapSelection{color:#ffcf84;font-variant-numeric:tabular-nums;min-height:1.6em}#mapHover{font-variant-numeric:tabular-nums;min-height:1.3em;display:block}@media(max-width:600px){body{margin:16px auto;padding:0 12px}section{padding:12px}.map-compass{font-size:.8rem}}
</style>
<style>.account-table{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #344b5b}td{overflow-wrap:anywhere}th{white-space:nowrap}.account-id{font-family:monospace;font-size:.85em}#accountDetails{white-space:pre-wrap;overflow-wrap:anywhere}#resetResult{border-color:#66c5ad}#temporaryPassword{font-family:monospace;min-width:0;width:100%;box-sizing:border-box}#resetPassword{background:#884633}[hidden]{display:none!important}</style>
<h1>FTD 서버 관리</h1><p>참가자 계정과 대회를 관리합니다. 대회 규칙 변경은 모드 업데이트 없이 참가자의 대회 목록에 반영됩니다.</p>
<div id="message" role="status">관리자 키를 입력하고 불러오세요.</div>
<section><label>관리자 키<input id="token" type="password" autocomplete="off" spellcheck="false"></label><button id="load">관리자 정보 불러오기</button><small>키는 이 페이지의 메모리에서만 사용하며 저장하지 않습니다.</small></section>
${activityAdminHtml}
${storageAdminHtml}
${chatAdminHtml}
<section aria-labelledby="accountsTitle"><h2 id="accountsTitle">계정 조회 · 비밀번호 초기화</h2>
<label>계정 검색<input id="accountQuery" maxlength="100" placeholder="로그인 아이디, 표시 이름 또는 계정 ID" autocomplete="off" spellcheck="false"></label>
<button id="accountSearch">계정 검색</button><button id="accountNext" disabled>다음 25개</button><small>검색어를 비우면 전체 계정을 25개씩 조회합니다.</small>
<p id="accountSummary" role="status">관리자 키를 입력한 뒤 검색하세요.</p>
<div class="account-table"><table id="accountTable" hidden><thead><tr><th>로그인 아이디 / 표시 이름</th><th>계정 ID</th><th>작업</th></tr></thead><tbody id="accountRows"></tbody></table></div>
<section id="accountSelected" hidden><h3>선택한 계정</h3><p id="accountDetails"></p>
<p id="resetHelp">초기화하면 기존 비밀번호와 로그인이 무효가 됩니다. 레이팅·전적·제출한 함대·진행 중인 경기는 유지됩니다.</p>
<label>확인용 로그인 아이디<input id="confirmUsername" autocomplete="off" spellcheck="false" placeholder="선택한 계정의 로그인 아이디를 그대로 입력"></label>
<button id="resetPassword" disabled>비밀번호 초기화</button><button id="cancelReset">선택 취소</button></section>
<section id="resetResult" hidden role="status"><h3>비밀번호 초기화 완료</h3><p id="resetIdentity"></p>
<label>새 임시 비밀번호<input id="temporaryPassword" type="text" readonly autocomplete="off" spellcheck="false" aria-describedby="temporaryHelp"></label>
<p id="temporaryHelp">이 화면에서만 확인할 수 있습니다. 비밀번호를 눌러 전체 선택한 뒤 복사해 본인 확인한 사용자에게 전달하세요. 사용자는 로그인 후 계정 화면에서 비밀번호를 변경하면 됩니다. 임시 비밀번호는 변경하거나 다시 초기화할 때까지 유효합니다.</p>
<button id="dismissPassword">확인 후 화면에서 지우기</button></section></section>
<section id="editor"><div class="row"><label>기존 대회<select id="list"></select></label><button id="clone">선택 대회 복사하여 새로 만들기</button></div>
<div class="row"><label>대회 ID<input id="id" pattern="[a-z0-9][a-z0-9-]{0,63}" maxlength="64"></label><label>이름<input id="name" maxlength="100"></label><label>상태<select id="status"><option value="open">접수 중 · 경기 가능</option><option value="locked">제출 마감 · 경기 가능</option><option value="closed">종료 · 신규 매칭 중지</option></select></label></div>
<label>설명<textarea id="description" maxlength="1000" rows="2"></textarea></label><p id="revision"></p>
<section><h2>전장</h2><div class="row"><label>월드<select id="world"></select></label><label>동쪽 좌표 (칸)<input id="rule-boardEast" type="number" min="0" step="0.001"></label><label>북쪽 좌표 (칸)<input id="rule-boardNorth" type="number" min="0" step="0.001"></label></div><p id="worldHint"></p>
<div class="map-panel"><div class="map-toolbar"><label>확대<select id="mapZoom"><option value="1">전체 지도</option><option value="2">2배</option><option value="4">4배</option><option value="8">8배</option></select></label><button id="mapCenter" type="button">선택 위치로 이동</button><button id="mapReset" type="button">전체 보기</button></div>
<div class="map-compass"><span id="mapTitle"></span><span>↑ 북쪽 · 동쪽 →</span></div>
<div class="map-frame"><svg id="battlefieldMap" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" tabindex="0" role="group" aria-label="전장 위치 선택 지도" aria-describedby="mapHelp mapSelection">
<image id="terrainImage" x="0" y="0" width="1000" height="1000" preserveAspectRatio="none"/>
<g id="mapGrid" pointer-events="none"></g>
<g id="mapMarker" pointer-events="none"><circle r="13" fill="#10202c" stroke="white" stroke-width="5"/><circle r="10" fill="#ffbf60" stroke="#10202c" stroke-width="2"/><path d="M-24 0H-15 M15 0H24 M0-24V-15 M0 15V24" fill="none" stroke="#ffcf84" stroke-width="3"/></g>
</svg></div><div class="map-compass"><span>서쪽 ←</span><span>↓ 남쪽</span></div>
<div class="map-legend"><span><i style="background:#14435b"></i>바다</span><span><i style="background:#408f9b"></i>얕은 물</span><span><i style="background:#638455"></i>육지</span><span><i style="background:#c9c5ae"></i>높은 지형</span></div>
<p id="mapSelection" role="status"></p><small id="mapHover"></small>
<p id="mapHelp">지도를 클릭하거나 터치해 전장 중심을 고르세요. 숫자를 입력해 미세 조정할 수도 있습니다. 지도에 초점을 두고 방향키로 0.01칸, Shift+방향키로 0.1칸 이동합니다. 변경한 위치는 대회 저장을 눌러야 적용됩니다.</p>
<small>FTD 4.3.4.1 지형 자료로 만든 개요도입니다. 해안선과 고도 표현은 근사치이며 세력·기지 표시는 포함하지 않습니다.</small></div>
<small>게임 커스텀 배틀의 동쪽/북쪽 칸 좌표와 같습니다. 소수 입력 가능. 경기 시작 시 선택한 월드를 자동으로 불러옵니다. 배치 고도는 해수면 기준입니다. 일반 기체가 지형에 묻히면 게임이 위로 보정하지만, 공중 기체를 지면까지 내려주지는 않습니다.</small></section>
<div id="rules"></div>
<section><h2>금지 블록</h2><p>블록 이름 또는 GUID로 검색해서 추가하세요. 목록에 없는 모드 블록은 GUID와 이름을 직접 입력할 수 있습니다. 본체·포탑·하위 구조물·BP에 포함된 드론을 모두 검사합니다.</p>
<label>블록 검색<input id="blockSearch" placeholder="예: Lua, repair, shield 또는 GUID"></label><div id="blockResults"></div>
<div class="row"><label>블록 GUID<input id="blockGuid" maxlength="36"></label><label>표시 이름<input id="blockName" maxlength="100"></label><button id="blockAdd">금지 목록에 추가</button></div>
<div id="bans"></div><small>이 목록은 아래의 대회 저장 버튼을 눌러야 서버에 반영됩니다. 128종까지 지정할 수 있습니다.</small>
<details><summary>BP 파일의 블록 검사</summary><label>검사할 BP<input id="inspectFile" type="file" accept=".blueprint,application/json"></label><p>여기서 고른 파일은 브라우저 안에서만 읽습니다. 참가자 제출 시에는 서버가 보관된 BP 원본을 매번 다시 검사합니다.</p><div id="inspection"></div></details></section>
<p>소환비를 제외한 남은 예산이 팀 보급 자원입니다. 전장·전투 시간·교체 대기만 바꾸면 기존 제출 함대가 유지됩니다. 교체 대기는 마지막 BP·수량 변경 시각부터 계산합니다. 함대 제한을 바꾸면 재제출이 필요하며, 이미 발급된 경기는 기존 규칙을 유지합니다.</p>
<button id="save">대회 저장</button>
${opponentAdminHtml}
<section><h2>모드 접속 제한</h2><div class="row"><label>최소 모드 버전<input id="minimumVersion" placeholder="0.5.1"></label><label>최소 통신 규격<input id="minimumProtocol" type="number" min="1" max="99999"></label></div><p>버전 정보가 없거나 최소 버전보다 낮으면 계정 생성·조회·제출·매칭을 거부합니다. 업데이트 안내와 관리자 화면은 열 수 있습니다. 현재 모드의 통신 규격은 1입니다.</p><button id="policySave">접속 정책 저장</button></section></section>
<script>
const el=id=>document.getElementById(id);let state,current,policyRevision,catalog=[],busy=false;
let storageUi=null,activityUi=null,chatUi=null;
let selectedAccount=null,accountNext=null,accountQuery='';
function syncAccountControls(){
  el('accountNext').disabled=busy||!accountNext;
  el('resetPassword').disabled=busy||!selectedAccount?.canResetPassword||el('confirmUsername').value!==selectedAccount.username;
  for(const id of ['token','accountQuery'])el(id).disabled=busy;
  el('confirmUsername').disabled=busy||!selectedAccount?.canResetPassword;
}
function clearPassword(){el('temporaryPassword').value='';el('resetIdentity').textContent='';el('resetResult').hidden=true;}
function clearAccountSelection(){selectedAccount=null;el('accountSelected').hidden=true;el('accountDetails').textContent='';el('confirmUsername').value='';clearPassword();syncAccountControls();}
function clearAccounts(){clearAccountSelection();accountNext=null;el('accountRows').replaceChildren();el('accountTable').hidden=true;syncAccountControls();}
function chooseAccount(a){
  clearAccountSelection();selectedAccount=a;el('accountSelected').hidden=false;
  el('accountDetails').textContent=['로그인 아이디: '+(a.username||'미등록')+' · 표시 이름: '+a.name,'계정 ID: '+a.id].join(String.fromCharCode(10));
  el('resetHelp').textContent=a.canResetPassword?'초기화하면 기존 비밀번호와 로그인이 무효가 됩니다. 레이팅·전적·제출한 함대·진행 중인 경기는 유지됩니다.':'아이디를 아직 등록하지 않은 이전 계정입니다. 기존 로그인으로 아이디를 먼저 등록해야 합니다.';
  syncAccountControls();if(a.canResetPassword)el('confirmUsername').focus();
}
async function searchAccounts(next=false){
  const cursor=next?accountNext:null;accountQuery=next?accountQuery:el('accountQuery').value.trim();clearAccounts();
  el('accountSummary').textContent='계정 조회 중…';
  let data;
  try{data=await api('/admin/accounts?q='+encodeURIComponent(accountQuery)+(cursor?'&after='+encodeURIComponent(cursor):''));}
  catch(error){el('accountSummary').textContent='계정을 불러오지 못했습니다.';throw error;}
  accountNext=data.next;el('accountTable').hidden=!data.accounts.length;
  for(const a of data.accounts){
    const row=document.createElement('tr');
    for(const [value,style] of [[(a.username||'아이디 미등록')+' / '+a.name,''],[a.id,'account-id']]){const cell=document.createElement('td');cell.textContent=value;cell.className=style;row.append(cell);}
    const cell=document.createElement('td'),button=document.createElement('button');button.textContent='계정 선택';button.setAttribute('aria-label',(a.username||a.name)+' 계정 선택');button.onclick=()=>chooseAccount(a);cell.append(button);row.append(cell);el('accountRows').append(row);
  }
  el('accountSummary').textContent=data.accounts.length?data.accounts.length+'개 계정 표시'+(data.next?' · 다음 페이지가 있습니다.':' · 마지막 페이지입니다.'):'일치하는 계정이 없습니다.';
  el('message').textContent='조회한 계정의 아이디와 계정 ID를 확인한 뒤 선택하세요.';
}
el('accountSearch').onclick=()=>run(()=>searchAccounts());el('accountNext').onclick=()=>run(()=>searchAccounts(true));
el('accountQuery').oninput=()=>{clearAccounts();el('accountSummary').textContent='검색 버튼을 눌러 조회하세요.';};
el('accountQuery').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();run(()=>searchAccounts());}};
el('confirmUsername').oninput=syncAccountControls;el('cancelReset').onclick=clearAccountSelection;
el('temporaryPassword').onclick=()=>el('temporaryPassword').select();el('dismissPassword').onclick=clearPassword;
el('token').oninput=()=>{clearAccounts();el('accountSummary').textContent='관리자 키를 입력한 뒤 검색하세요.';el('editor').style.display='none';};
window.addEventListener('pagehide',()=>{clearAccounts();el('token').value='';});
el('resetPassword').onclick=()=>run(async()=>{
  const a=selectedAccount;if(!a?.canResetPassword||el('confirmUsername').value!==a.username)throw Error('확인용 아이디를 정확하게 입력하세요.');
  let data;
  try{data=await api('/admin/accounts/'+encodeURIComponent(a.id)+'/password-reset','POST',{confirmUsername:a.username,expectedRevision:a.authRevision});}
  catch(error){clearAccounts();el('accountSummary').textContent='계정을 다시 검색하세요. 응답을 받지 못한 경우에도 초기화가 완료되었을 수 있습니다. 새 비밀번호를 받지 못했다면 다시 조회 후 초기화하세요.';throw error;}
  clearAccounts();el('resetResult').hidden=false;el('resetIdentity').textContent='로그인 아이디: '+data.account.username+' · 계정 ID: '+data.account.id;
  el('temporaryPassword').value=data.temporaryPassword;el('accountSummary').textContent='초기화를 완료했습니다. 기존 로그인은 해제되었습니다.';
  el('message').textContent='새 임시 비밀번호를 전달한 뒤 화면에서 지우세요.';el('temporaryPassword').focus();el('temporaryPassword').select();
});
const battlefieldMaps=${JSON.stringify(battlefieldMaps)};
const mapCoordinates=${mapCoordinates.toString()},mapPoint=${mapPoint.toString()},mapViewport=${mapViewport.toString()};
let mapView={x:0,y:0,size:1000};
const selectedMap=()=>state?.battlefields.find(m=>m.id===el('world').value);
const selectedCoords=()=>({east:el('rule-boardEast').valueAsNumber,north:el('rule-boardNorth').valueAsNumber});
function drawMapSelection(recenter=false){
  const map=selectedMap();if(!map)return;const {east,north}=selectedCoords(),point=mapPoint(map,east,north);
  if(recenter){mapView=mapViewport(map,east,north,Number(el('mapZoom').value));el('battlefieldMap').setAttribute('viewBox',[mapView.x,mapView.y,mapView.size,mapView.size].join(' '));}
  el('mapMarker').style.display=point?'':'none';
  if(point)el('mapMarker').setAttribute('transform','translate('+point.x+' '+point.y+') scale('+(mapView.size/1000)+')');
  el('mapSelection').textContent=point?'선택 위치: 동 '+east.toFixed(3)+' / 북 '+north.toFixed(3)+'칸':'좌표가 비어 있거나 이 월드 범위를 벗어났습니다. 지도에서 위치를 다시 선택하세요.';
}
function worldBounds(){
  const map=selectedMap();if(!map)return;
  el('rule-boardEast').max=map.eastMax;el('rule-boardNorth').max=map.northMax;
  el('worldHint').textContent=map.name+' · 동쪽 0~'+map.eastMax+'칸 / 북쪽 0~'+map.northMax+'칸 · 1칸 = '+map.tileSize.toLocaleString()+'m. 입력 좌표가 전장 중심입니다.';
  el('mapTitle').textContent=map.name;el('terrainImage').setAttribute('href',battlefieldMaps[map.id].image);el('mapZoom').value='1';el('mapHover').textContent='격자 간격: 1칸';el('mapGrid').replaceChildren();
  const svgNS='http://www.w3.org/2000/svg';
  for(const [count,vertical] of [[map.eastMax,true],[map.northMax,false]])for(let i=0;i<=count;i++){
    const line=document.createElementNS(svgNS,'line'),p=i/count*1000;
    for(const [key,value] of Object.entries(vertical?{x1:p,x2:p,y1:0,y2:1000}:{x1:0,x2:1000,y1:p,y2:p}))line.setAttribute(key,value);
    line.setAttribute('stroke','#e2eef5');line.setAttribute('stroke-opacity','.24');line.setAttribute('stroke-width','1');line.setAttribute('vector-effect','non-scaling-stroke');el('mapGrid').append(line);
  }
  drawMapSelection(true);
}
el('world').onchange=worldBounds;
el('rule-boardEast').oninput=el('rule-boardNorth').oninput=()=>drawMapSelection(true);
el('mapZoom').onchange=()=>drawMapSelection(true);
el('mapCenter').onclick=()=>drawMapSelection(true);
el('mapReset').onclick=()=>{el('mapZoom').value='1';drawMapSelection(true);};
function pointerCoords(event){const map=selectedMap(),matrix=el('battlefieldMap').getScreenCTM();if(!map||!matrix)return null;const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());return mapCoordinates(map,point.x,point.y);}
function chooseMapPoint(point,recenter=false){if(!point)return;el('rule-boardEast').value=point.east.toFixed(3);el('rule-boardNorth').value=point.north.toFixed(3);drawMapSelection(recenter);}
el('battlefieldMap').onclick=event=>{chooseMapPoint(pointerCoords(event));el('battlefieldMap').focus({preventScroll:true});};
el('battlefieldMap').onpointermove=event=>{const point=pointerCoords(event);if(point)el('mapHover').textContent='커서: 동 '+point.east.toFixed(3)+' / 북 '+point.north.toFixed(3)+'칸';};
el('battlefieldMap').onpointerleave=()=>{el('mapHover').textContent='격자 간격: 1칸';};
el('battlefieldMap').onkeydown=event=>{
  const move={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,1],ArrowDown:[0,-1]}[event.key],map=selectedMap();if(!move||!map)return;event.preventDefault();
  let {east,north}=selectedCoords();if(!mapPoint(map,east,north)){east=map.eastMax/2;north=map.northMax/2;}const step=event.shiftKey?.1:.01;
  chooseMapPoint({east:Math.max(0,Math.min(map.eastMax,east+move[0]*step)),north:Math.max(0,Math.min(map.northMax,north+move[1]*step))},true);
};
const inspectBlueprint=${inspectBlueprint.toString()};
function renderBans(){el('bans').replaceChildren();const bans=current.rules.bannedBlocks||[];if(!bans.length){el('bans').textContent='금지된 블록 없음';return;}for(const b of bans){const row=document.createElement('div'),remove=document.createElement('button');row.textContent=b.name+' · '+b.guid+' ';remove.textContent='제거';remove.onclick=()=>{current.rules.bannedBlocks=current.rules.bannedBlocks.filter(x=>x.guid!==b.guid);renderBans();};row.append(remove);el('bans').append(row);}}
function addBan(guid,name){guid=guid.trim().toLowerCase();name=name.trim();if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(guid)||!name||name.length>100)throw Error('GUID와 표시 이름을 확인하세요.');const bans=current.rules.bannedBlocks||(current.rules.bannedBlocks=[]);if(bans.some(b=>b.guid===guid))return;if(bans.length>=128)throw Error('금지 블록은 최대 128종입니다.');bans.push({guid,name});renderBans();el('message').textContent='금지 목록에 추가했습니다. 대회 저장을 눌러 적용하세요.';}
function searchBlocks(){const term=el('blockSearch').value.trim().toLowerCase();el('blockResults').replaceChildren();if(!term)return;for(const b of catalog.filter(b=>(b.name+' '+b.guid).toLowerCase().includes(term)).slice(0,30)){const button=document.createElement('button');button.textContent=b.name;button.title=b.guid;button.onclick=()=>run(async()=>addBan(b.guid,b.name));el('blockResults').append(button);}}
el('blockSearch').oninput=searchBlocks;el('blockAdd').onclick=()=>run(async()=>addBan(el('blockGuid').value,el('blockName').value));
el('inspectFile').onchange=()=>run(async()=>{const file=el('inspectFile').files[0];if(!file)return;if(file.size>8*1024*1024)throw Error('BP 파일은 최대 8 MiB입니다.');el('inspection').replaceChildren();const report=inspectBlueprint(JSON.parse(await file.text())),summary=document.createElement('p');summary.textContent=report.blockCount+'개 블록 / 본체 포함 '+report.constructCount+'개 구조물';el('inspection').append(summary);const names=new Map(catalog.map(b=>[b.guid,b.name]));for(const [guid,count] of Object.entries(report.counts)){const row=document.createElement('div'),button=document.createElement('button'),name=names.get(guid)||guid;row.textContent=name+' · '+count+'개 · '+guid+' ';button.textContent='금지 추가';button.onclick=()=>run(async()=>addBan(guid,name));row.append(button);el('inspection').append(row);}});
const labels={teamBudget:'팀 전체 예산',maxUnits:'최대 BP 배치 수',maxBlueprints:'최대 BP 종류 수',duration:'전투 제한 시간 (초)',distance:'팀 사이 거리 (m)',boardEast:'전장 동쪽 좌표',boardNorth:'전장 북쪽 좌표',formationHalfWidth:'진형 좌우 반폭 (m)',formationDepth:'진형 뒤쪽 깊이 (m)',minAltitude:'최저 배치 고도 (m)',maxAltitude:'최고 배치 고도 (m)',replacementSeconds:'BP·수량 교체 대기 (초, 진형 제외)',k:'레이팅 K 값',resourceDrop:'파괴 블록 자원 반환 비율',tooDamagedEnabled:'과도한 손상 시 퇴장',tooDamagedFraction:'과도한 손상 잔존 비율',sinkingEnabled:'손상 후 침몰 시 퇴장',sinkingFraction:'침몰 판정 잔존 비율',sustainedEnabled:'수리 후 생존 유예',sustainedSeconds:'수리 후 유예 (초)'};
async function api(path,method='GET',body){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
    const r=await fetch(path,{method,headers:{Authorization:'Bearer '+el('token').value,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
    const data=await r.json();if(!r.ok)throw Error(data.error||r.status);return data;
  }catch(e){
    if(controller.signal.aborted)throw Error(method==='GET'?'서버 응답이 15초를 넘었습니다. 다시 불러오세요.':'서버 응답이 15초를 넘었습니다. 변경이 반영되었는지 조회한 뒤 다시 시도하세요.');
    throw e;
  }finally{clearTimeout(timer);}
}
async function run(fn){
  if(busy)return;busy=true;
  try{
    document.querySelectorAll('button').forEach(b=>b.disabled=true);syncAccountControls();activityUi?.sync();chatUi?.sync();
    document.querySelectorAll('#opEditor input,#opEditor select,#opList,#opNewName,#list').forEach(i=>i.disabled=true);
    await fn();
  }catch(e){el('message').textContent=e.message;}
  finally{
    busy=false;document.querySelectorAll('#opEditor input,#opEditor select,#opList,#opNewName,#list').forEach(i=>i.disabled=false);
    document.querySelectorAll('button').forEach(b=>b.disabled=false);syncAccountControls();storageUi?.sync();activityUi?.sync();chatUi?.sync();
  }
}
function select(t){document.dispatchEvent(new Event('tournament-selected'));current=structuredClone(t);renderBans();el('inspection').replaceChildren();el('inspectFile').value='';el('id').value=t.id;el('id').disabled=t.revision>0;el('name').value=t.name;el('description').value=t.description;el('status').value=t.status;el('revision').textContent=t.revision?'규칙 버전 '+t.revision:'새 대회';el('world').replaceChildren();for(const map of state.battlefields){const option=document.createElement('option');option.value=map.id;option.textContent=map.name;el('world').append(option);}el('world').value=t.rules.world||'neter';el('rule-boardEast').value=t.rules.boardEast;el('rule-boardNorth').value=t.rules.boardNorth;worldBounds();el('rules').replaceChildren();for(const [key,bounds] of Object.entries(state.numericRules)){if(key==='boardEast'||key==='boardNorth')continue;const label=document.createElement('label'),input=document.createElement('input');label.textContent=labels[key]||key;input.type='number';input.min=bounds[0];input.max=bounds[1];input.step=['maxUnits','maxBlueprints','replacementSeconds'].includes(key)?'1':'0.001';input.value=t.rules[key];input.id='rule-'+key;label.append(input);el('rules').append(label);}for(const key of state.booleanRules){const label=document.createElement('label'),input=document.createElement('input');label.textContent=labels[key]||key;input.type='checkbox';input.checked=t.rules[key];input.id='rule-'+key;label.append(input);el('rules').append(label);}}
async function load(selected){state=await api('/admin/tournaments');el('editor').style.display='block';el('list').replaceChildren();for(const t of state.tournaments){const o=document.createElement('option');o.value=t.id;o.textContent=t.name+' ['+t.id+']';el('list').append(o);}const t=state.tournaments.find(t=>t.id===selected)||state.tournaments[0];if(t){el('list').value=t.id;select(t);}policyRevision=state.clientPolicy.revision;el('minimumVersion').value=state.clientPolicy.minimumVersion;el('minimumProtocol').value=state.clientPolicy.minimumProtocol;}
el('load').onclick=()=>run(async()=>{
  el('message').textContent='대회 정보를 불러오는 중…';await load();
  el('message').textContent='접속 현황과 최근 경기를 불러오는 중…';await activityUi.load();
  el('message').textContent='DB 사용량을 불러오는 중…';await storageUi.loadOverview();
  el('message').textContent='BP 목록을 불러오는 중…';await storageUi.loadBlueprints();
  el('message').textContent='블록 목록을 불러오는 중…';catalog=(await api('/admin/block-catalog')).blocks;searchBlocks();
  el('message').textContent='채팅을 연결하는 중…';await chatUi.open();
  el('message').textContent='관리자 정보를 불러왔습니다.';
});
el('list').onchange=()=>select(state.tournaments.find(t=>t.id===el('list').value));
el('clone').onclick=()=>{if(!current)return;select({...current,id:'',name:current.name+' 복사',status:'open',revision:0});el('id').focus();el('message').textContent='새 대회 ID를 영문 소문자·숫자·하이픈으로 입력하세요.';};
el('save').onclick=()=>run(async()=>{const id=el('id').value.trim();if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))throw Error('대회 ID 형식을 확인하세요.');const rules={world:el('world').value,bannedBlocks:current.rules.bannedBlocks||[]};for(const key of Object.keys(state.numericRules)){const input=el('rule-'+key);if(!input.value.trim()||!input.checkValidity())throw Error((labels[key]||key)+' 범위를 확인하세요.');rules[key]=Number(input.value);}for(const key of state.booleanRules)rules[key]=el('rule-'+key).checked;const r=await api('/admin/tournaments/'+id,'PUT',{name:el('name').value,description:el('description').value,status:el('status').value,expectedRevision:current.revision,rules});await load(id);el('message').textContent='저장했습니다. '+r.tournament.name+' / 규칙 v'+r.tournament.revision;});
el('policySave').onclick=()=>run(async()=>{const r=await api('/admin/client-policy','PUT',{minimumVersion:el('minimumVersion').value.trim(),minimumProtocol:Number(el('minimumProtocol').value),expectedRevision:policyRevision});policyRevision=r.clientPolicy.revision;el('message').textContent='접속 정책을 저장했습니다. 최소 버전 '+r.clientPolicy.minimumVersion;});
${opponentAdmin.toString()}
opponentAdmin();
${storageAdmin.toString()}
storageUi=storageAdmin();
${activityAdmin.toString()}
activityUi=activityAdmin();
${chatAdmin.toString()}
chatUi=chatAdmin();
</script></html>`;
