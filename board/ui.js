// Helpers shared by both views: text, team colors, and change-only DOM writes.

export const other = (side) => (side === 'home' ? 'away' : 'home');
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function periodName(p) {
  return ['', '1ST', '2ND', '3RD', '4TH'][p] ?? (p === 5 ? 'OT' : `${p - 4}OT`);
}

// Drop formation tags and injury notes so the play itself fits.
export function tidyPlay(text) {
  return (text ?? '')
    .replace(/^\((?:Shotgun|No Huddle|No Huddle, Shotgun)\)\s*/i, '')
    .replace(/\s*\*\*.*$/, '')
    .trim();
}

// Fourth quarter, five minutes or less (or overtime), one score apart.
export function closeAndLate(g) {
  if (g.period < 4) return false;
  const [m, sec] = g.clock.split(':').map(Number);
  const left = m * 60 + (sec || 0);
  return (g.period > 4 || left <= 300) && Math.abs((g.home.score ?? 0) - (g.away.score ?? 0)) <= 8;
}

// 4th down past midfield, or 4th and 2 or less anywhere: a kick or a go-for-it.
export const fourthDown = (s) => s?.down === 4 && (s.toGo <= 40 || s.distance <= 2);

export const SHORT = {
  TOUCHDOWN: 'TD',
  'FIELD GOAL': 'FG',
  SAFETY: 'SAFETY',
  INTERCEPTION: 'INT',
  FUMBLE: 'FUMBLE',
  'MUFFED PUNT': 'MUFF',
  'BLOCKED KICK': 'BLOCK',
  'TURNOVER ON DOWNS': 'DOWNS',
};

// "BACK IN ~1:20" on the typical clock, "BACK ANY MOMENT" once overdue, "" if
// the break began before the board was watching.
export function breakLeftText(ms) {
  if (ms == null) return '';
  if (ms <= 0) return 'BACK ANY MOMENT';
  if (ms > 3 * 60_000) return `BACK IN ~${Math.round(ms / 60_000)} MIN`;
  return `BACK IN ~${fmtClock(ms)}`;
}

export function kickoffText(g, t) {
  const m = Math.round((g.kickoff - t) / 60_000);
  if (m <= 0) return 'KICKING OFF';
  return m <= 60 ? `KICKOFF IN ${m} MIN` : 'KICKOFF';
}

export function feedText(board) {
  const { state, age } = board.feed();
  const delay = board.delayMs ? ` +${board.delayMs / 1000}s` : '';
  switch (state) {
    case 'sim': return `SIM ${board.speed}×`;
    case 'ok': return `LIVE${delay}`;
    case 'stale': return `STALE ${Math.round(age / 1000)}s`;
    case 'dead': return `NO DATA ${Math.max(1, Math.round(age / 60_000))}m`;
    default: return 'CONNECTING';
  }
}

export function railHTML(later, finals, t) {
  const parts = [];
  if (finals.length) {
    parts.push('<span class="rl">FINAL</span>');
    const side = (team) => {
      const text = `${esc(team.abbr)} ${team.score ?? ''}`;
      return team.winner ? `<b>${text}</b>` : `<span class="lose">${text}</span>`;
    };
    for (const g of finals) parts.push(`<span class="ri">${side(g.away)}${side(g.home)}</span>`);
  }
  if (later.length) {
    parts.push('<span class="rl">LATER</span>');
    for (const g of later) {
      const when = sameDay(g.kickoff, t) ? fmtTime(g.kickoff) : `${fmtDay(g.kickoff)} ${fmtTime(g.kickoff)}`;
      parts.push(`<span class="ri"><b>${esc(when)}</b>${esc(g.away.abbr)} @ ${esc(g.home.abbr)}<i>${esc(g.network)}</i></span>`);
    }
  }
  return parts.join('');
}

// ---- team colors on the dark surface ----

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const SURFACE_LUM = luminance('#1a1a19');
const isHex = (c) => /^#[0-9a-f]{6}$/i.test(c ?? '');
const visible = (c) => isHex(c) && (luminance(c) + 0.05) / (SURFACE_LUM + 0.05) >= 2;

function mixWhite(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.round(v + (255 - v) * k).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

// A team's mark on the dark surface: its primary color if it shows up, else
// its alternate (unless that's white), else the primary lightened until it
// does, so navy and purple stay blue and purple rather than turning gray.
// Used for flashes too: black (PIT, LV) would vanish into the board.
const marks = new Map();
export function markColor(team) {
  const key = `${team.color}/${team.alt}`;
  if (!marks.has(key)) {
    let c = '#8a897f';
    if (visible(team.color)) c = team.color;
    else if (visible(team.alt) && luminance(team.alt) < 0.8) c = team.alt;
    else if (isHex(team.color)) {
      for (let k = 0.1; k < 1; k += 0.1) {
        if (visible(mixWhite(team.color, k))) {
          c = mixWhite(team.color, k);
          break;
        }
      }
    }
    marks.set(key, c);
  }
  return marks.get(key);
}

export function readableOn(bg) {
  return isHex(bg) && luminance(bg) > 0.35 ? '#111110' : '#ffffff';
}

// Flash and event colors: the scorer's mark, or amber for a turnover.
export function eventColors(e) {
  const bg = e.kind === 'TURNOVER' ? '#fab219' : e.team ? markColor(e.team) : '#555555';
  return { bg, fg: readableOn(bg) };
}

// The scoreboard's logo URLs are for light backgrounds.
export const darkLogo = (url) => (url ?? '').replace('/teamlogos/nfl/500/', '/teamlogos/nfl/500-dark/');

// ---- formatting ----

export const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short' });
export const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

export function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const ago = (ms) => (ms < 60_000 ? 'NOW' : `${Math.floor(ms / 60_000)} MIN`);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---- DOM writes only when something changed, so a 500 ms render loop stays
// cheap and running animations aren't restarted ----

export function setText(el, v) {
  if (el.textContent !== v) el.textContent = v;
}
export function setHTML(el, v) {
  if (el._html !== v) el.innerHTML = el._html = v;
}
export function setAttr(el, k, v) {
  if (el.getAttribute(k) !== v) el.setAttribute(k, v);
}
export function setStyle(el, k, v) {
  if (el.style[k] !== v) el.style[k] = v;
}
export function setVar(el, k, v) {
  if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v);
}
