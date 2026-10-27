"""Fit order-independent Elo ratings from frozen, side-swapped FTD results."""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path


def solve(matrix, vector):
    rows = [list(a) + [b] for a, b in zip(matrix, vector)]
    n = len(rows)
    for i in range(n):
        pivot = max(range(i, n), key=lambda j: abs(rows[j][i]))
        rows[i], rows[pivot] = rows[pivot], rows[i]
        d = rows[i][i]
        if abs(d) < 1e-12:
            raise ValueError('Disconnected comparison graph')
        rows[i] = [x / d for x in rows[i]]
        for j in range(n):
            if j != i:
                d = rows[j][i]
                rows[j] = [x - d * y for x, y in zip(rows[j], rows[i])]
    return [r[-1] for r in rows]


def fit_ratings(n, pairs, pseudo=1.0):
    """Elo logistic likelihood, one virtual win/loss per pair, mean 1000.

    pairs contains (i,j,games,points_for_i). Draws contribute 0.5 points.
    The symmetric pseudocount gives finite estimates even after a sweep.
    """
    strength = [0.0] * n  # Last coordinate anchored during Newton iterations.
    for _ in range(100):
        g = [0.0] * (n - 1)
        info = [[0.0] * (n - 1) for _ in range(n - 1)]
        for i, j, games, points in pairs:
            p = 1 / (1 + math.exp(-(strength[i] - strength[j])))
            total = games + 2 * pseudo
            error = points + pseudo - total * p
            curvature = total * p * (1 - p)
            for a, sign in [(i, 1), (j, -1)]:
                if a < n - 1:
                    g[a] += sign * error
                    info[a][a] += curvature
            if i < n - 1 and j < n - 1:
                info[i][j] -= curvature
                info[j][i] -= curvature
        step = solve(info, g)
        if max(map(abs, step), default=0) < 1e-10:
            break
        scale = min(1, 2 / max(map(abs, step)))
        for i, d in enumerate(step):
            strength[i] += scale * d
    else:
        raise ValueError('Rating fit did not converge')
    mean = sum(strength) / n
    return [1000 + (s - mean) * 400 / math.log(10) for s in strength]


def analyze(directory, partial=False):
    manifest_path = directory / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
    presets = manifest['presets']
    indices = {p['key']: i for i, p in enumerate(presets)}
    counts = {(i, j): {'wins': 0, 'draws': 0, 'losses': 0, 'timeouts': 0}
              for i in range(len(presets)) for j in range(i + 1, len(presets))}
    games = []
    for case in manifest['games']:
        file = directory / 'games' / f"{case['index']:02d}" / 'calibration-result.json'
        if not file.exists():
            continue
        report = json.loads(file.read_text(encoding='utf-8-sig'))
        if not report['passed'] or report['game'] != case or report['result']['matchId'] != case['id']:
            raise ValueError(f'Invalid case identity: {file}')
        result = report['result']
        score = result['score']
        if score not in (0, 0.5, 1):
            raise ValueError('Invalid score')
        if not report['muted'] or not 0 < result['seconds'] <= manifest['rules']['duration'] + 1:
            raise ValueError(f'Invalid runtime settings: {file}')
        for key in ('world', 'boardEast', 'boardNorth'):
            if result[key] != manifest['rules'][key]:
                raise ValueError(f'Battlefield mismatch: {file}')
        expected_winner = None if score == .5 else 0 if score == 1 else 1
        if result['winner'] != expected_winner:
            raise ValueError(f'Winner/score mismatch: {file}')
        eliminated = [team['disqualified'] for team in report['final']]
        if expected_winner is not None and (eliminated[expected_winner] or not eliminated[1 - expected_winner]):
            raise ValueError(f'Winner/remaining fleet mismatch: {file}')
        if score == .5 and not result['timeout'] and not all(eliminated):
            raise ValueError(f'Draw without timeout or mutual elimination: {file}')
        for team in report['initial']:
            if abs(team['spawnCost'] + team['supply'] - manifest['rules']['teamBudget']) > .05:
                raise ValueError(f'Budget mismatch: {file}')
        i, j = indices[case['owner']], indices[case['opponent']]
        if i > j:
            i, j, score = j, i, 1 - score
        c = counts[i, j]
        c['wins' if score == 1 else 'losses' if score == 0 else 'draws'] += 1
        c['timeouts'] += int(result['timeout'])
        games.append({**case, 'score': result['score'], 'seconds': result['seconds'],
                      'wallSeconds': report['wallSeconds'], 'timeout': result['timeout'],
                      'fixedDeltaMin': report['fixedDeltaMin'], 'fixedDeltaMax': report['fixedDeltaMax'],
                      'timeScaleMin': report['timeScaleMin'], 'timeScaleMax': report['timeScaleMax'],
                      'resultSha256': hashlib.sha256(file.read_bytes()).hexdigest()})
    pairs = []
    for (i, j), c in counts.items():
        total = c['wins'] + c['draws'] + c['losses']
        pairs.append({'a': presets[i]['key'], 'b': presets[j]['key'], **c, 'games': total})
    print(f"Completed {len(games)}/{len(manifest['games'])}")
    for p in pairs:
        print(f"{p['a']} vs {p['b']}: {p['wins']} W / {p['draws']} D / {p['losses']} L")
    if partial:
        return {'games': games, 'pairs': pairs}
    if len(games) != len(manifest['games']):
        raise ValueError('Calibration is incomplete; refusing to assign ratings')
    fitted = fit_ratings(len(presets), [(i, j, c['wins'] + c['draws'] + c['losses'], c['wins'] + .5 * c['draws'])
                                      for (i, j), c in counts.items()])
    rounded = [round(r / 10) * 10 for r in fitted]
    middle = sorted(range(len(fitted)), key=lambda i: fitted[i])[len(fitted) // 2]
    rounded[middle] += 1000 * len(fitted) - sum(rounded)
    ratings = [{ 'key': p['key'], 'name': p['name'], 'previous': p['initialRating'],
                 'fitted': fitted[i], 'rating': rounded[i] } for i, p in enumerate(presets)]
    summary = {'method': 'Elo logistic fit; draws=0.5; one virtual win and loss per pair; mean=1000; rounded to tens',
               'manifestSha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
               'rules': manifest['rules'], 'rankDllSha256': manifest['rankDllSha256'],
               'presetsSourceSha256': manifest['presetsSourceSha256'], 'seeds': manifest['seeds'],
               'ratings': ratings, 'pairs': pairs, 'games': games}
    (directory / 'rating-report.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    with (directory / 'games.csv').open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(games[0])); writer.writeheader(); writer.writerows(games)
    for r in ratings:
        print(f"{r['key']}: {r['rating']} (fit {r['fitted']:.3f})")
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    parser.add_argument('--partial', action='store_true')
    args = parser.parse_args()
    analyze(args.directory, args.partial)
