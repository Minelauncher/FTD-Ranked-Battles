import json, pathlib, re
root = pathlib.Path(__file__).resolve().parents[2]
keys = json.loads((pathlib.Path(__file__).parent / 'strings.json').read_text(encoding='utf-8'))
rows = {}
for line in (pathlib.Path(__file__).parent / 'translations.tsv').read_text(encoding='utf-8').splitlines():
    n, en, ja = line.split('\t')
    rows[int(n)] = (en.replace('\\n', '\n'), ja.replace('\\n', '\n'))
assert len(rows) == len(keys)
ko_overrides = {
20:'게임 기본 카메라로 궤도 회전·줌·기체 기준 이동을 조절합니다.\nF6 자유 · F7 이전 · F8 다음 · F9 위',
21:'내 편대 · ',22:'상대 · ',24:' · 파괴',36:' · 전장을 준비하는 중…',51:'전체 지도 · 북 ↑',52:'전장 주변 · 8배',
53:'+ 전장 중심 · 파랑: 물 · 초록·갈색: 육지',78:'% / 상대 ',97:'BP 다운로드 완료 · ',98:'BP 다운로드 · 완료 ',99:' · 검증',
162:'↑ 적 방향 · H: 고도 · °: 방향',163:'가로 ',164:'깊이\n',165:'m · 격자 ',166:'m · 고도 ',
178:'{0} · 예산 {1:N0} · {2:0.#}분',183:'{0}\n예산 {1:N0} · 기체 {2} · BP {3}\n시간 {4}초 · 거리 {5}m',
193:'미제출 변경 있음 · 매칭은 제출본 사용',194:'기체 {0:N0} + 보급 {1:N0} = 예산 {2:N0}\n기체 {3}/{4} · BP {5}/{6}',
195:'드래그 배치 · Shift: 10m · Alt: 자유 · Esc: 취소',196:'확인 필요: ',198:'BP·수량 교체까지 ',
211:'X {0} / Z {1} / 고도 {2} / 방향 {3}°',212:'기체 {0}',214:'좌우 {0}m',215:'앞뒤 {0}m',216:'고도 {0}m',217:'방향 {0}°',228:'열 {0}',230:'열 1',
231:'좌우 간격 {0}m',233:'행 간격 {0}m',241:'레이팅 {0:0.0} → {1:0.0}',242:'\n체력 {0:0.0}% : {1:0.0}%',
245:'레이팅 · {0}전',247:'내 함대 · ',250:'기체 {0} · 소환 {1:N0} · 보급 {2:N0}',257:'관전 중 · ',
265:'기체 {0} · 제한 {1:0.#}분',266:'제출 마감: ',288:'닉네임: ',289:'로그인 아이디: ',
305:'아이디·비밀번호 8~32자\n아이디: A–Z, 0–9, _ . -\n공개 닉네임 2~24자',
324:' · ESC 시점 메뉴\nF6 자유 · F7/F8 기체 · F9 위'
}
catalog = {}
for i, key in enumerate(keys):
    en, ja = rows[i]
    ko = ko_overrides.get(i, key.split(' / ')[0])
    catalog[key] = dict(ko=ko, en=en, ja=ja)
    for value in (ko, en, ja):
        assert sorted(re.findall(r'\{\d+[^}]*\}', key)) == sorted(re.findall(r'\{\d+[^}]*\}', value)), (i,value)
catalog['Language'] = dict(ko='모드 언어', en='Mod language', ja='MODの言語')
catalog['Language scope'] = dict(ko='랭크 모드에만 적용', en='Ranked mod only', ja='ランク戦MODのみに適用')
for line in (pathlib.Path(__file__).parent / 'server-errors.tsv').read_text(encoding='utf-8').splitlines():
    ko, en, ja = line.split('\t')
    catalog[ko] = dict(ko=ko, en=en, ja=ja)
# Preserve the named key/chat/profile entries added after the original extraction.
existing = json.loads((root/'assets'/'languages.json').read_text(encoding='utf-8'))
for key, value in existing.items():
    catalog.setdefault(key, value)
catalog.update(json.loads((pathlib.Path(__file__).parent / 'result-status.json').read_text(encoding='utf-8')))
catalog.update(json.loads((pathlib.Path(__file__).parent / 'version-policy.json').read_text(encoding='utf-8')))
catalog.update(json.loads((pathlib.Path(__file__).parent / 'ranking-pages.json').read_text(encoding='utf-8')))
(root/'assets'/'languages.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'Wrote {len(catalog)} complete Korean / English / Japanese translations')
