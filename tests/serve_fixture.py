"""Isolated two-account UI test fixture. Never used by the distributed server."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from server import Ladder, make_server

parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--port', type=int, default=8766)
args = parser.parse_args()
root = Path(args.root)

class FixtureLadder(Ladder):
    def dispatch(self, method, path, token='', data=None):
        result = super().dispatch(method, path, token, data)
        if method == 'POST' and path == '/matches':
            result['duration'], result['seed'] = 45, 12345
            with self.connect() as db:
                db.execute('UPDATE matches SET ticket=? WHERE id=?', (json.dumps(result), result['id']))
        return result

store = FixtureLadder(root / 'fixture.sqlite3')
actor = store.dispatch('POST', '/accounts', data={'name': 'Test Captain'})
opponent = store.dispatch('POST', '/accounts', data={'name': 'Test Opponent'})
store.dispatch('POST', '/blueprint', opponent['token'], {'blueprint': (root / 'Corsair.blueprint').read_text(encoding='utf-8-sig')})
server = f'http://127.0.0.1:{args.port}'
mod = root / 'SaveData' / 'From The Depths' / 'Mods' / 'RankedBattles'
(mod / 'client.json').write_text(json.dumps({'Server': server, 'Name': 'Test Captain', 'Connections': {server: {'Token': actor['token'], 'AccountId': actor['account']['id']}}}), encoding='utf-8')
(root / 'fixture-ids.json').write_text(json.dumps({'actor': actor['account']['id'], 'opponent': opponent['account']['id']}), encoding='utf-8')
(root / 'fixture-ready').touch()
make_server(store, port=args.port).serve_forever()
