// ESPN scoreboard JSON -> the board's game model, plus play classification and
// event detection. Pure functions only, so they run under `node --test`.

export const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
export const SUMMARY_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary';

export function normalizeScoreboard(json) {
  return (json.events ?? []).map(normalizeEvent).filter(Boolean);
}

export function normalizeEvent(ev) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const status = comp.status ?? ev.status;
  const side = {};
  for (const c of comp.competitors ?? []) side[c.homeAway] = normalizeTeam(c);
  if (!side.home || !side.away) return null;

  const game = {
    id: String(ev.id),
    kickoff: Date.parse(ev.date),
    state: status.type.state, // 'pre' | 'in' | 'post'
    status: status.type.name, // e.g. STATUS_HALFTIME
    detail: status.type.shortDetail ?? '',
    period: status.period ?? 0,
    clock: status.displayClock ?? '',
    network: networkOf(comp),
    home: side.home,
    away: side.away,
    situation: null,
    lastPlay: null,
  };
  if (comp.situation && game.state === 'in') {
    game.situation = normalizeSituation(comp.situation, game);
    game.lastPlay = normalizePlay(comp.situation.lastPlay);
  }
  return game;
}

function normalizeTeam(c) {
  const t = c.team ?? {};
  return {
    id: String(t.id),
    abbr: t.abbreviation ?? '',
    name: t.shortDisplayName ?? t.name ?? '',
    color: hex(t.color),
    alt: hex(t.alternateColor),
    logo: t.logo ?? '',
    score: c.score === undefined || c.score === '' ? null : Number(c.score),
    record: c.records?.[0]?.summary ?? '',
    winner: c.winner === true,
  };
}

const hex = (s) => (s ? `#${String(s).replace(/^#/, '')}` : null);

function networkOf(comp) {
  const names = (comp.broadcasts ?? []).flatMap((b) => b.names ?? []);
  return names[0] ?? comp.broadcast ?? '';
}

function normalizeSituation(s, g) {
  const possession = s.possession == null ? null : String(s.possession);
  const offense = possession === g.home.id ? 'home' : possession === g.away.id ? 'away' : null;
  const toGo = yardsToEndzone(s, g, offense);
  const down = s.down >= 1 ? s.down : null;
  return {
    offense,
    down,
    distance: down ? s.distance : null,
    text: down ? (s.downDistanceText ?? '') : '',
    spot: s.possessionText ?? '',
    toGo,
    redZone: s.isRedZone ?? (down !== null && toGo !== null && toGo <= 20),
    timeouts: { home: s.homeTimeouts ?? null, away: s.awayTimeouts ?? null },
    driveStart: driveStart(s.lastPlay, possession, offense),
  };
}

// Yards from the ball to the end zone the offense is attacking.
// ESPN's yardLine counts from the home goal line (0) to the away goal line
// (100); possessionText ("NO 10") names the side of the field, so prefer it.
export function yardsToEndzone(s, g, offense) {
  if (!offense) return null;
  const defense = offense === 'home' ? 'away' : 'home';
  const spot = s.possessionText ?? '';
  const m = /^([A-Z]+)\s+(\d+)$/.exec(spot);
  if (m) {
    const n = Number(m[2]);
    if (m[1] === g[offense].abbr) return 100 - n;
    if (m[1] === g[defense].abbr) return n;
  }
  if (spot === '50') return 50;
  if (typeof s.yardLine !== 'number') return null;
  return offense === 'home' ? 100 - s.yardLine : s.yardLine;
}

// Where the current drive began, as yards from the offense's own goal line.
// The last play's drive is the current one only if possession didn't change on
// that play (a punt or kickoff belongs to the other team's drive).
function driveStart(lp, possession, offense) {
  const y = lp?.drive?.start?.yardLine;
  if (!offense || typeof y !== 'number') return null;
  if (String(lp.start?.team?.id) !== possession || String(lp.end?.team?.id) !== possession) return null;
  return offense === 'home' ? y : 100 - y;
}

function normalizePlay(lp) {
  if (!lp) return null;
  const type = lp.type?.text ?? '';
  return {
    id: String(lp.id ?? ''),
    type,
    text: lp.text ?? '',
    ...classifyPlay(type),
    homeWin: lp.probability?.homeWinPercentage ?? null,
  };
}

// ESPN play-type text -> what the board cares about. Type names are the ones
// seen in the 2026-10-18 play-by-play.
export function classifyPlay(type) {
  const t = type.toLowerCase();

  let score = null;
  if (t.includes('touchdown')) score = 'TD';
  else if (t === 'field goal good') score = 'FG';
  else if (t.includes('safety')) score = 'SAFETY';

  let turnover = null;
  if (t.includes('interception')) turnover = 'INTERCEPTION';
  else if (t.includes('fumble recovery (opponent)') || t.includes('opp fumble') || t.includes('fumble return')) turnover = 'FUMBLE';
  else if (t.includes('muffed punt recovery (opponent)')) turnover = 'MUFFED PUNT';
  else if (t.includes('blocked')) turnover = 'BLOCKED KICK';

  let stoppage = null;
  if (t === 'official timeout') stoppage = 'TV TIMEOUT';
  else if (t === 'timeout') stoppage = 'TIMEOUT';
  else if (t === 'two-minute warning') stoppage = '2-MIN WARNING';
  else if (t === 'end period') stoppage = 'END OF QUARTER';
  else if (t === 'end of half') stoppage = 'HALFTIME';
  else if (t === 'end of regulation') stoppage = 'END OF REGULATION';

  return { score, turnover, stoppage };
}

// Which kind of commercial a game is in, or null. Team timeouts don't count:
// they last a median 47 s and are often played straight through.
export function breakKind(g) {
  if (g.state !== 'in') return null;
  if (g.status === 'STATUS_HALFTIME') return 'HALF';
  if (g.status === 'STATUS_END_PERIOD') return 'QUARTER';
  switch (g.lastPlay?.stoppage) {
    case 'TV TIMEOUT': return 'TV';
    case '2-MIN WARNING': return 'TWO_MIN';
    case 'END OF QUARTER':
    case 'END OF REGULATION': return 'QUARTER';
    case 'HALFTIME': return 'HALF';
    default: return null;
  }
}

export const inBreak = (g) => breakKind(g) !== null;

// Median time from the stoppage to the next snap in the 2026-10-18
// play-by-play: 168 TV timeouts (80% within 106-172 s), 24 quarter breaks,
// 25 two-minute warnings, 12 halftimes.
export const BREAK_TYPICAL_MS = { TV: 152_000, QUARTER: 202_000, TWO_MIN: 166_000, HALF: 844_000 };

const SCORE_LABEL = { TD: 'TOUCHDOWN', FG: 'FIELD GOAL', SAFETY: 'SAFETY' };

// Scores as the board believes them, per game. ESPN sometimes posts a wrong
// score for a moment (its play-by-play has a 6 -> 20 -> 6 spike and a
// 10-7 -> 0-0 -> 10-7 dip) and lowers a score when a touchdown is overturned.
// So a new score is believed when the newest play says something scored, or
// when the same value arrives twice in a row; and only a score above the best
// believed one counts as scoring, so a dip and its recovery never fire.
export class ScoreWatch {
  constructor(game) {
    this.high = { home: game.home.score ?? 0, away: game.away.score ?? 0 };
    this.pending = { home: null, away: null };
  }

  // -> { events: [{ kind, label, side, text }], reversed: sides whose score was taken back }
  update(prev, next) {
    const events = [];
    const reversed = [];
    const lp = next.lastPlay;
    const newPlay = Boolean(lp?.id) && lp.id !== prev?.lastPlay?.id;
    const typed = newPlay ? lp.score : null;
    const live = prev?.state === 'in' || next.state === 'in'; // a walk-off still flashes

    for (const side of ['home', 'away']) {
      const cur = next[side].score ?? 0;
      const high = this.high[side];
      if (cur === high) {
        this.pending[side] = null;
        continue;
      }
      if (this.pending[side] !== cur && !(cur > high && typed)) {
        this.pending[side] = cur; // wait for a second look
        continue;
      }
      this.pending[side] = null;
      this.high[side] = cur;
      if (cur < high) {
        reversed.push(side);
        continue;
      }
      // Extra points and two-point tries never fire on their own.
      const gain = cur - high;
      const kind = gain >= 6 ? 'TD' : gain >= 3 ? 'FG' : gain === 2 && typed === 'SAFETY' ? 'SAFETY' : null;
      if (kind && live) events.push({ kind, label: SCORE_LABEL[kind], side, text: newPlay ? lp.text : '' });
    }
    return { events, reversed };
  }
}

// Turnovers from consecutive snapshots of one game. `side` is the team that
// gained the ball. A pick-six is left to the touchdown.
export function playEvents(prev, next) {
  if (!prev || next.state !== 'in') return [];
  const lp = next.lastPlay;
  if (!lp?.id || lp.id === prev.lastPlay?.id || lp.score) return [];
  if (lp.turnover) return [{ kind: 'TURNOVER', label: lp.turnover, side: next.situation?.offense ?? null, text: lp.text }];
  const was = prev.situation;
  const now = next.situation;
  if (
    was?.down === 4 &&
    was.offense &&
    now?.offense &&
    now.offense !== was.offense &&
    !/punt|field goal|kickoff/i.test(lp.type)
  ) {
    return [{ kind: 'TURNOVER', label: 'TURNOVER ON DOWNS', side: now.offense, text: lp.text }];
  }
  return [];
}
