// Rebuilds a past slate as a live-looking scoreboard at any instant, from each
// game's play-by-play, so the board can be checked against real games. The
// output has the live scoreboard's shape, so it runs through the same
// normalizer as live data.

import { SCOREBOARD_URL, SUMMARY_URL } from './feed.js';

// `saved` is an optional URL path to saved ESPN responses, named
// sb_<YYYYMMDD>.json and sum_<event id>.json, for when ESPN can't be reached
// (it turns away headless browsers).
export async function loadSlate(atMs, saved = null) {
  const day = easternDay(atMs);
  const sb = await getJSON(saved ? `${saved}/sb_${day}.json` : `${SCOREBOARD_URL}?dates=${day}`);
  const games = await Promise.all(
    sb.events.map(async (ev) =>
      prepare(ev, await getJSON(saved ? `${saved}/sum_${ev.id}.json` : `${SUMMARY_URL}?event=${ev.id}`)),
    ),
  );
  return (t) => ({ events: games.map((at) => at(t)) });
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// ESPN's ?dates= is a US Eastern calendar day.
function easternDay(ms) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(ms).replaceAll('-', '');
}

// One game: returns t -> scoreboard event as it would have looked at time t.
export function prepare(ev, summary) {
  const comp = ev.competitions[0];
  const sideOfAbbr = Object.fromEntries(comp.competitors.map((c) => [c.team.abbreviation, c.homeAway]));
  const homeWin = new Map((summary.winprobability ?? []).map((w) => [w.playId, w.homeWinPercentage]));
  const finalDetail = summary.header?.competitions?.[0]?.status?.type?.shortDetail ?? 'Final';
  const kickoff = Date.parse(ev.date);

  const drives = [...(summary.drives?.previous ?? []), ...(summary.drives?.current ? [summary.drives.current] : [])];
  const plays = drives
    .flatMap((d) => d.plays.map((p) => ({ p, d, t: Date.parse(p.wallclock) })))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t);

  // A few play rows carry a wrong score (a 6-20-6 spike, a 0-0 two-minute
  // warning). Taking the score only from scoring plays reproduces every
  // 2026-10-18 final.
  let score = { home: 0, away: 0 };
  for (const x of plays) {
    if (x.p.scoringPlay) score = { home: x.p.homeScore, away: x.p.awayScore };
    x.score = score;
  }

  return (t) => {
    const i = lastAtOrBefore(plays, t);
    if (i < 0) {
      return t < kickoff
        ? withState(ev, status('STATUS_SCHEDULED', 'pre', 0, '0:00', ''), null, { home: 0, away: 0 })
        : withState(ev, status('STATUS_IN_PROGRESS', 'in', 1, '15:00', '15:00 - 1st'), null, { home: 0, away: 0 });
    }

    const { p, d, score: scores } = plays[i];
    const period = p.period.number;
    const clock = p.clock.displayValue;
    const type = p.type.text;

    if (type === 'End of Game') {
      return withState(ev, status('STATUS_FINAL', 'post', period, '0:00', finalDetail), null, scores);
    }
    let st;
    if (type === 'End of Half') st = status('STATUS_HALFTIME', 'in', period, '0:00', 'Halftime');
    else if (type === 'End Period' || type === 'End of Regulation') {
      st = status('STATUS_END_PERIOD', 'in', period, '0:00', `End of ${periodName(period)}`);
    } else st = status('STATUS_IN_PROGRESS', 'in', period, clock, `${clock} - ${periodName(period)}`);

    const e = p.end ?? {};
    const situation = {
      down: e.down,
      distance: e.distance,
      yardLine: e.yardLine,
      downDistanceText: e.downDistanceText,
      shortDownDistanceText: e.shortDownDistanceText,
      possessionText: e.possessionText,
      possession: e.team?.id,
      homeTimeouts: timeoutsLeft(plays, i, 'home', sideOfAbbr),
      awayTimeouts: timeoutsLeft(plays, i, 'away', sideOfAbbr),
      lastPlay: {
        id: p.id,
        type: p.type,
        text: p.text,
        start: p.start,
        end: p.end,
        probability: homeWin.has(p.id) ? { homeWinPercentage: homeWin.get(p.id) } : undefined,
        drive: { start: { yardLine: d.start?.yardLine } },
      },
    };
    return withState(ev, st, situation, scores);
  };
}

function lastAtOrBefore(plays, t) {
  let lo = 0;
  let hi = plays.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (plays[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function status(name, state, period, displayClock, shortDetail) {
  return { period, displayClock, type: { name, state, completed: state === 'post', shortDetail } };
}

function periodName(p) {
  return ['', '1st', '2nd', '3rd', '4th'][p] ?? (p === 5 ? 'OT' : `${p - 4}OT`);
}

// Team timeouts are logged as "Timeout #2 by KC at 08:37."; three per half,
// two in overtime.
function timeoutsLeft(plays, i, side, sideOfAbbr) {
  const period = plays[i].p.period.number;
  const half = period <= 2 ? 1 : period <= 4 ? 2 : period;
  const halfOf = (q) => (q <= 2 ? 1 : q <= 4 ? 2 : q);
  let used = 0;
  for (let j = i; j >= 0; j--) {
    const q = plays[j].p;
    if (halfOf(q.period.number) !== half) break;
    if (q.type.text !== 'Timeout') continue;
    const m = /by ([A-Z]+)/.exec(q.text);
    if (m && sideOfAbbr[m[1]] === side) used++;
  }
  return Math.max(0, (period <= 4 ? 3 : 2) - used);
}

function withState(ev, st, situation, scores) {
  const comp = ev.competitions[0];
  const final = st.type.state === 'post';
  return {
    ...ev,
    competitions: [
      {
        ...comp,
        status: st,
        situation: situation ?? undefined,
        competitors: comp.competitors.map((c) => {
          const other = c.homeAway === 'home' ? 'away' : 'home';
          return { ...c, score: String(scores[c.homeAway]), winner: final && scores[c.homeAway] > scores[other] };
        }),
      },
    ],
  };
}
