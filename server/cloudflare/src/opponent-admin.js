export const opponentAdminHtml = `<section aria-labelledby="opTitle"><h2 id="opTitle">기본 상대 함대</h2>
<p>선택한 대회의 기본 상대입니다. 참가자와의 승패에 따라 공통 레이팅이 변합니다. 아래에서 현재 레이팅을 직접 조정할 수도 있습니다.</p>
<button id="opLoad">기본 상대 불러오기</button><button id="opDefaults">캠페인 항공 편대 추가</button>
<p id="opStatus" role="status">대회를 선택한 뒤 불러오세요.</p>
<label>기본 상대<select id="opList"><option value="">선택하세요</option></select></label>
<div class="row"><label>새 상대 이름<input id="opNewName" maxlength="80" placeholder="예: 순양함 편대"></label><button id="opCreate">빈 상대 추가</button></div>
<div id="opEditor" hidden>
<div class="row"><label>함대 이름<input id="opName" maxlength="80"></label><label>현재 레이팅<input id="opRating" type="number" min="0" max="10000" step="0.001"></label><label>매칭에 사용<input id="opEnabled" type="checkbox"></label></div>
<p id="opBudget"></p><p>기체 소환비 + 남은 보급 자원 = 대회 팀 예산. 아래 변경은 ‘기본 상대 저장’을 눌러 적용합니다.</p>
<div class="row"><label>추가할 BP 파일<input id="opFile" type="file" accept=".blueprint,application/json"></label><label>기체 1척 소환비<input id="opCost" type="number" min="0" step="0.001"></label><button id="opUpload">BP 업로드</button></div>
<small>FTD 커스텀 배틀에 표시되는 소환비를 입력하세요. 서버는 BP 원본·금지 블록·예산을 검사하며, 게임은 전투 시작 전 실제 비용을 다시 확인합니다. BP 업로드만으로 배치가 바뀌지는 않습니다.</small>
<div class="row"><label>보관 BP<select id="opBlueprint"></select></label><label>추가 수량<input id="opAddCount" type="number" min="1" value="1" step="1"></label><button id="opAdd">함대에 추가</button></div>
<div class="account-table"><table><thead><tr><th>BP</th><th>수량</th><th>BP 교체 · 위치 유지</th></tr></thead><tbody id="opGroups"></tbody></table></div>
<p>위쪽이 적 방향입니다. 번호를 끌어서 위치를 바꾸거나 아래 수치를 입력하세요. 방향 0도는 적을 향합니다.</p>
<svg id="opMap" viewBox="0 0 700 400" style="display:block;width:100%;height:360px;background:#10202c;border:1px solid #648395;touch-action:none" aria-label="기본 상대 진형 편집" role="group"></svg>
<div class="account-table"><table><thead><tr><th>기체</th><th>X (m)</th><th>Z (m)</th><th>고도 (m)</th><th>방향 (도)</th><th></th></tr></thead><tbody id="opUnits"></tbody></table></div>
<button id="opSave">기본 상대 저장</button><button id="opDisable">즉시 비활성화</button>
<small>예산·금지 블록·배치 제한을 바꾸면 다시 검사하여 저장해야 합니다. 맵·좌표·제한시간·교전 거리만 바꾸면 기존 함대를 계속 사용합니다. 이미 발급된 경기의 BP·진형·레이팅은 보존됩니다.</small>
</div></section>`;

// Embedded into the existing self-contained admin page; uses its authenticated api/run helpers.
export function opponentAdmin() {
  let selected = null, opponents = [], library = [], units = [], rules = null, revision = null, tournamentId = null, drag = null;
  const map = el('opMap'), ns = 'http://www.w3.org/2000/svg';
  const message = text => { el('opStatus').textContent = text; };
  const bpByHash = hash => library.find(b => b.hash === hash);
  function reset() { selected = null; opponents = []; library = []; units = []; rules = null; tournamentId = null; drag = null; el('opEditor').hidden = true; el('opList').replaceChildren(); message('대회를 선택한 뒤 불러오세요.'); }
  document.addEventListener('tournament-selected', reset);
  function persistedTournament() { if (!current?.revision) throw Error('새 대회는 먼저 저장하세요.'); return current.id; }
  function options(select, value) {
    select.replaceChildren();
    for (const bp of library) { const o = document.createElement('option'); o.value = bp.hash; o.textContent = bp.name + ' · ' + bp.cost.toLocaleString() + ' · ' + bp.hash.slice(0, 8); select.append(o); }
    select.value = value || library[0]?.hash || '';
  }
  async function loadOpponents(id) {
    const t = persistedTournament(), data = await api('/admin/tournaments/' + t + '/opponents');
    tournamentId = t; rules = data.rules; revision = data.tournamentRevision; opponents = data.opponents;
    el('opList').replaceChildren();
    for (const p of opponents) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name + ' · ' + p.rating + (p.enabled && p.current ? ' · 사용 중' : ' · 비활성/재검사 필요'); el('opList').append(o); }
    const p = opponents.find(p => p.id === id) || opponents[0];
    if (p) await choose(p.id); else { selected = null; el('opEditor').hidden = true; message('기본 상대가 없습니다. 캠페인 편대 또는 빈 상대를 추가하세요.'); }
  }
  async function choose(id) {
    selected = null; el('opEditor').hidden = true;
    const p = opponents.find(p => p.id === id);
    library = (await api('/admin/opponents/' + id + '/blueprints')).blueprints;
    selected = p; units = structuredClone(p.fleet?.units || []); el('opList').value = id;
    el('opName').value = p.name; el('opRating').value = p.rating; el('opEnabled').checked = p.enabled;
    options(el('opBlueprint')); el('opFile').value = ''; el('opCost').value = ''; el('opEditor').hidden = false;
    message(p.current ? '저장된 함대를 불러왔습니다. 편집 버전 ' + p.revision : '현재 대회 규칙으로 함대를 검사하여 저장하세요.'); render();
  }
  function control(action) { if (!busy && selected) { try { action(); render(); message('편집 중입니다. 저장 버튼으로 적용하세요.'); } catch (e) { message(e.message); } } }
  function qty(hash, count) {
    if (!Number.isInteger(count) || count < 0 || count > rules.maxUnits) throw Error('수량은 0~' + rules.maxUnits + ' 정수여야 합니다.');
    const existing = units.filter(u => u.hash === hash).length;
    if (units.length - existing + count > rules.maxUnits) throw Error('최대 배치 수를 초과합니다.');
    if (count > existing && !existing && new Set(units.map(u => u.hash)).size >= rules.maxBlueprints) throw Error('최대 BP 종류 수를 초과합니다.');
    while (units.filter(u => u.hash === hash).length > count) units.splice(units.findLastIndex(u => u.hash === hash), 1);
    while (units.filter(u => u.hash === hash).length < count) {
      const i = units.length, x = Math.min(rules.formationHalfWidth, Math.max(-rules.formationHalfWidth, (i % 3 - 1) * 160));
      units.push({ ...bpByHash(hash), x, z: Math.max(-rules.formationDepth, -Math.floor(i / 3) * 180), altitude: Math.max(rules.minAltitude, Math.min(rules.maxAltitude, 10)), yaw: 0 });
    }
  }
  function project(u) {
    const w = rules.formationHalfWidth * 2, d = rules.formationDepth, scale = Math.min(640 / Math.max(w, 1), 340 / Math.max(d, 1));
    return { x: 350 + u.x * scale, y: 30 + (-u.z) * scale, scale };
  }
  function draw() {
    map.replaceChildren();
    const top = project({ x: -rules.formationHalfWidth, z: 0 }), bottom = project({ x: rules.formationHalfWidth, z: -rules.formationDepth });
    const box = document.createElementNS(ns, 'rect'); box.setAttribute('x', top.x); box.setAttribute('y', top.y); box.setAttribute('width', Math.max(1, bottom.x - top.x)); box.setAttribute('height', Math.max(1, bottom.y - top.y)); box.setAttribute('fill', 'none'); box.setAttribute('stroke', '#648395'); map.append(box);
    units.forEach((u, i) => {
      const p = project(u), g = document.createElementNS(ns, 'g'); g.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')'); g.dataset.index = i; g.style.cursor = 'grab';
      const circle = document.createElementNS(ns, 'circle'); circle.setAttribute('r', 15); circle.setAttribute('fill', '#245873'); circle.setAttribute('stroke', '#ffcd72'); g.append(circle);
      const arrow = document.createElementNS(ns, 'path'); arrow.setAttribute('d', 'M0 -25 L-5 -17 L0 -19 L5 -17 Z'); arrow.setAttribute('fill', '#ffcd72'); arrow.setAttribute('transform', 'rotate(' + u.yaw + ')'); g.append(arrow);
      const text = document.createElementNS(ns, 'text'); text.setAttribute('text-anchor', 'middle'); text.setAttribute('y', '5'); text.setAttribute('fill', 'white'); text.textContent = i + 1; g.append(text); map.append(g);
    });
  }
  function render() {
    const cost = units.reduce((sum, u) => sum + Number(u.cost), 0), supply = rules.teamBudget - cost;
    el('opBudget').textContent = '소환비 ' + cost.toFixed(3) + ' + 보급 ' + supply.toFixed(3) + ' = ' + rules.teamBudget.toLocaleString() + ' / ' + units.length + '척' + (supply < 0 ? ' · 예산 초과' : '');
    el('opGroups').replaceChildren(); el('opUnits').replaceChildren();
    for (const hash of new Set(units.map(u => u.hash))) {
      const group = units.filter(u => u.hash === hash), tr = document.createElement('tr');
      const name = document.createElement('td'); name.textContent = group[0].name + ' · ' + hash.slice(0, 8); tr.append(name);
      const qCell = document.createElement('td'), input = document.createElement('input'); input.type = 'number'; input.min = 0; input.max = rules.maxUnits; input.step = 1; input.value = group.length; input.style.width = '80px'; input.setAttribute('aria-label', group[0].name + ' 수량');
      input.onchange = () => control(() => { if (input.value === '') throw Error('수량을 입력하세요.'); qty(hash, Number(input.value)); }); qCell.append(input); tr.append(qCell);
      const swapCell = document.createElement('td'), select = document.createElement('select'); options(select, hash); select.setAttribute('aria-label', group[0].name + ' BP 교체');
      select.onchange = () => control(() => { const bp = bpByHash(select.value); units = units.map(u => u.hash === hash ? { ...u, ...bp } : u); }); swapCell.append(select); tr.append(swapCell); el('opGroups').append(tr);
    }
    units.forEach((u, i) => {
      const tr = document.createElement('tr'), name = document.createElement('td'); name.textContent = (i + 1) + '. ' + u.name; tr.append(name);
      for (const [key, min, max] of [['x', -rules.formationHalfWidth, rules.formationHalfWidth], ['z', -rules.formationDepth, 0], ['altitude', rules.minAltitude, rules.maxAltitude], ['yaw', -180, 180]]) {
        const td = document.createElement('td'), input = document.createElement('input'); input.type = 'number'; input.min = min; input.max = max; input.step = '.001'; input.value = u[key]; input.style.width = '85px'; input.setAttribute('aria-label', (i + 1) + '번 ' + key);
        input.onchange = () => control(() => { if (!input.value.trim() || !input.checkValidity()) throw Error(key + ' 범위를 확인하세요.'); u[key] = Number(input.value); }); td.append(input); tr.append(td);
      }
      const td = document.createElement('td'), remove = document.createElement('button'); remove.textContent = '삭제'; remove.onclick = () => control(() => units.splice(i, 1)); td.append(remove); tr.append(td); el('opUnits').append(tr);
    }); draw();
  }
  map.onpointerdown = e => {
    if (busy || !selected) return;
    const marker = e.target.closest('[data-index]'); if (!marker) return;
    drag = { index: Number(marker.dataset.index), pointer: e.pointerId, before: structuredClone(units[Number(marker.dataset.index)]) }; map.setPointerCapture(e.pointerId); e.preventDefault();
  };
  map.onpointermove = e => {
    if (!drag || busy || drag.pointer !== e.pointerId) return;
    const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(map.getScreenCTM().inverse()), scale = project(units[drag.index]).scale;
    units[drag.index].x = Math.round(Math.max(-rules.formationHalfWidth, Math.min(rules.formationHalfWidth, (point.x - 350) / scale)) * 1000) / 1000;
    units[drag.index].z = Math.round(Math.max(-rules.formationDepth, Math.min(0, -(point.y - 30) / scale)) * 1000) / 1000; draw();
  };
  map.onpointerup = e => { if (drag?.pointer === e.pointerId) { drag = null; map.releasePointerCapture(e.pointerId); render(); message('진형을 수정했습니다. 저장 버튼으로 적용하세요.'); } };
  map.onpointercancel = () => { if (drag) { units[drag.index] = drag.before; drag = null; render(); } };
  el('opLoad').onclick = () => run(() => loadOpponents(selected?.id));
  el('opList').onchange = () => run(() => choose(el('opList').value));
  el('opDefaults').onclick = () => run(async () => { const id = persistedTournament(); await api('/admin/tournaments/' + id + '/opponents/defaults', 'POST', {}); await loadOpponents(); message('캠페인 편대를 확인했습니다. 기존 편대의 편집/비활성 상태는 보존됩니다.'); });
  el('opCreate').onclick = () => run(async () => { const r = await api('/admin/tournaments/' + persistedTournament() + '/opponents', 'POST', { name: el('opNewName').value, rating: 1000 }); await loadOpponents(r.opponent.id); message('빈 상대를 추가했습니다. BP를 배치하고 활성 상태로 저장하세요.'); });
  el('opUpload').onclick = () => run(async () => {
    if (!selected) return;
    const file = el('opFile').files[0], input = el('opCost');
    if (!file || file.size < 1 || file.size > 8388608) throw Error('8 MiB 이하의 BP 파일을 선택하세요.');
    if (!input.value.trim() || !input.checkValidity()) throw Error('FTD 소환비를 입력하세요.');
    const bytes = await file.arrayBuffer(), parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); inspectBlueprint(parsed);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
    const response = await fetch('/admin/opponents/' + selected.id + '/blueprints/raw', { method: 'POST', headers: { Authorization: 'Bearer ' + el('token').value, 'X-Blueprint-Sha256': hash, 'X-Blueprint-Name': encodeURIComponent(parsed.Name || file.name), 'X-Blueprint-Cost': input.value }, body: bytes });
    const data = await response.json(); if (!response.ok) throw Error(data.error || response.status);
    library = (await api('/admin/opponents/' + selected.id + '/blueprints')).blueprints; options(el('opBlueprint'), hash);
    units = units.map(u => u.hash === hash ? { ...u, ...data.blueprint } : u); render(); message('BP를 보관했습니다. 수량을 추가하거나 기존 BP를 교체한 뒤 저장하세요.');
  });
  el('opAdd').onclick = () => control(() => { const hash = el('opBlueprint').value, count = Number(el('opAddCount').value); if (!bpByHash(hash) || !Number.isInteger(count) || count < 1) throw Error('BP와 추가 수량을 확인하세요.'); qty(hash, units.filter(u => u.hash === hash).length + count); });
  el('opSave').onclick = () => run(async () => {
    if (!selected || tournamentId !== persistedTournament()) throw Error('기본 상대를 다시 불러오세요.');
    if (!el('opRating').value.trim() || !el('opRating').checkValidity()) throw Error('현재 레이팅 범위를 확인하세요.');
    const r = await api('/admin/opponents/' + selected.id, 'PUT', { name: el('opName').value, rating: Number(el('opRating').value), enabled: el('opEnabled').checked, expectedRevision: selected.revision, tournamentRevision: revision, units });
    await loadOpponents(r.opponent.id); message('기본 상대를 저장했습니다. 이후 새 매칭부터 반영됩니다.');
  });
  el('opDisable').onclick = () => run(async () => { if (!selected) return; const id = selected.id; await api('/admin/opponents/' + id + '/enabled', 'PUT', { enabled: false, expectedRevision: selected.revision }); await loadOpponents(id); message('비활성화했습니다. 기존 경기는 그대로 완료할 수 있습니다.'); });
}
