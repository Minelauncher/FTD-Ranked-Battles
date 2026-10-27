import { ApiError, now, randomId } from './shared.js';
import { checkedResult, sameResult } from './battle-outcome.js';

export const submissionDeadline = (created, duration) => created + Math.max(1800, duration * 3);
const isForfeit = receipt => ['surrender', 'submission-expired'].includes(receipt?.outcome?.kind);
function forfeited(kind) { return { score: 0, outcome: { kind } }; }

async function commit(db, match, decision) {
  if (match.status === 'completed') return JSON.parse(match.receipt);
  if (match.status !== 'pending') throw new ApiError(409, '이미 종료된 경기입니다.');
  const event = match.tournament;
  if (!event) throw new ApiError(409, '대회가 지정되지 않은 경기입니다.');
  const ticket = JSON.parse(match.ticket), before = ticket.owner.rating, other = ticket.opponent.rating;
  const expected = 1 / (1 + 10 ** Math.max(-20, Math.min(20, (other - before) / 400)));
  const rawDelta = ticket.k * (decision.score - expected);
  const settlementId = randomId();
  const receipt = { matchId: match.id, tournamentId: event, tournamentName: ticket.tournament.name,
    opponentId: match.opponent, opponentName: ticket.opponent.name, opponentNicknameColor: ticket.opponent.nicknameColor ?? null, opponentRating: other,
    ownerMatchRating: before, expected, systemOpponent: ticket.opponent.system === true, initiated: true, settlementId,
    ...decision, completed: now() };
  // Capture both CURRENT ledgers and claim the match in the same transaction.
  // A unique settlement ID guards every later write: retries cannot apply it twice.
  // Elo uses the issued matchup; its transfer is added to current ratings, never
  // replacing them with an old ticket snapshot. Clamp the transfer to keep both
  // ratings non-negative while preserving their sum.
  const transfer = 'max(-a.rating,min(b.rating,?))';
  const guard = "EXISTS(SELECT 1 FROM matches WHERE id=? AND status='completed' AND json_extract(receipt,'$.settlementId')=?)";
  const statements = [
    db.prepare(`UPDATE matches SET status='completed',score=?,receipt=json_set(?,
      '$.before',a.rating,'$.after',a.rating+${transfer},'$.delta',${transfer},'$.games',a.games+1,
      '$.opponentBefore',b.rating,'$.opponentAfter',b.rating-${transfer},'$.opponentDelta',-${transfer},'$.opponentGames',b.games+1)
      FROM tournament_ratings a,tournament_ratings b
      WHERE matches.id=? AND matches.owner=? AND matches.status='pending'
      AND a.owner=matches.owner AND a.tournament=matches.tournament
      AND b.owner=matches.opponent AND b.tournament=matches.tournament`)
      .bind(decision.score,JSON.stringify(receipt),rawDelta,rawDelta,rawDelta,rawDelta,match.id,match.owner),
    db.prepare(`UPDATE tournament_ratings SET rating=(SELECT json_extract(receipt,'$.after') FROM matches WHERE id=?),games=games+1
      WHERE owner=? AND tournament=? AND ${guard}`).bind(match.id,match.owner,event,match.id,settlementId),
    db.prepare(`UPDATE tournament_ratings SET rating=(SELECT json_extract(receipt,'$.opponentAfter') FROM matches WHERE id=?),games=games+1
      WHERE owner=? AND tournament=? AND ${guard}`).bind(match.id,match.opponent,event,match.id,settlementId),
  ];
  if (receipt.systemOpponent) statements.push(db.prepare(`UPDATE system_opponents SET revision=revision+1 WHERE owner=? AND ${guard}`)
    .bind(match.opponent,match.id,settlementId));
  statements.push(
    db.prepare('SELECT status,receipt FROM matches WHERE id=? AND owner=?').bind(match.id, match.owner),
  );
  const results = await db.batch(statements);
  const saved = results[results.length - 1].results[0];
  if (saved.status !== 'completed') throw new ApiError(409, '이미 종료된 경기입니다.');
  return JSON.parse(saved.receipt);
}

export async function submitResult(db, match, data, timestamp = now()) {
  if (match.status === 'completed' && isForfeit(JSON.parse(match.receipt))) return JSON.parse(match.receipt);
  const ticket = JSON.parse(match.ticket);
  if (match.status === 'pending' && ticket.expiresAt <= timestamp)
    return commit(db, match, forfeited('submission-expired'));
  const decision = checkedResult(ticket, data), receipt = await commit(db, match, decision);
  if (!isForfeit(receipt) && !sameResult(receipt, decision)) throw new ApiError(409, '이미 다른 결과로 완료된 경기입니다.');
  return receipt;
}
export const surrenderMatch = (db, match) => commit(db, match, forfeited('surrender'));

export async function expireOwner(db, owner, timestamp = now()) {
  const match = await db.prepare(`SELECT * FROM matches WHERE owner=? AND status='pending'
    AND json_extract(ticket,'$.expiresAt')<=?`).bind(owner, timestamp).first();
  if (!match) return false;
  await commit(db, match, forfeited('submission-expired'));
  return true;
}

export async function expireMatches(db, timestamp = now()) {
  // 1 indexed scan + 9 * at most 5 statements stays below Free's 50-query ceiling.
  const matches = (await db.prepare(`SELECT * FROM matches WHERE status='pending'
    AND json_extract(ticket,'$.expiresAt')<=? ORDER BY json_extract(ticket,'$.expiresAt') LIMIT 9`)
    .bind(timestamp).all()).results;
  for (const match of matches) await commit(db, match, forfeited('submission-expired'));
  return matches.length;
}
