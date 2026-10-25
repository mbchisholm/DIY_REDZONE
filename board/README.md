# Redzone board

A wall display of every NFL game in the current window, for deciding when to
change channels. It polls ESPN's public scoreboard every 5 seconds. Every game
is a lane on one shared field, so the game closest to scoring is the ball
furthest right.

It's a static page with no backend and nothing to install. The browser calls
ESPN directly; ESPN allows that.

This sits beside the paused commercial auto-mute experiment in
`../automute/`. The two share nothing yet.

## Run

```sh
cd board
python3 -m http.server 8083      # or: npm run serve
```

Open <http://localhost:8083/>. On a kiosk, point the browser at that URL in
full-screen mode.

## Views

- **Field** (default): one lane per game on a shared axis. Every offense drives
  left to right, and the red zone is one column down the whole board.
- **Grid** (`?view=grid`): one tile per game. It's the fallback if the field
  doesn't read well from the couch.

Both views run on the same data, events and timers.

## URL parameters

| Parameter | Effect |
|---|---|
| `view=grid` | Use the grid view. |
| `delay=40` | Hold everything back 40 s. The feed may run ahead of the YouTube TV stream; this keeps flashes from spoiling the TV. |
| `sim=2026-10-18T18:26:20Z` | Rebuild a past slate from ESPN play-by-play, starting at that instant. |
| `speed=2` | Sim playback rate. `0` freezes it. |
| `saved=/espn` | Sim from saved responses (`sb_<YYYYMMDD>.json`, `sum_<id>.json`) instead of ESPN, which turns away headless browsers. |
| `fill=9` | Test aid: clone live games until nine are live. |
| `director=1` | Mock RedZone strip: what the TV would show (field view only). |

Good sim moments from 2026-10-18 (times UTC):

- `19:21:30Z` — 7 games live, 4 in the red zone at once
- `18:26:20Z` with `speed=2` — three touchdowns inside 90 seconds, then a TV break countdown
- `21:10:44Z` with `speed=2` — an interception in LAC @ KC
- `19:50:00Z` with `speed=10` — the 1pm games finishing as the 4pm games come in
- `16:45:00Z` — 1pm pregame lanes beside the London game

## Reading the field view

- **The ball** is the offense's logo, on the line of scrimmage.
  - The bar behind it is this drive.
  - The yellow line is the line to gain.
  - The column under RED ZONE lights when a ball is in it.
- **Down and distance** rides on the ball.
- **The scoreboard** on the left shows:
  - a football next to the team with the ball
  - pips for timeouts left
  - a team-colored bar under a score made in the last 5 minutes
- **Chips under the clock:**
  - `TV BREAK`
  - `BACK` (green, for 90 s after a break ends)
  - `4TH DOWN` (past midfield, or 4th and 2 or less)
  - `TIMEOUT`
  - `CLOSE & LATE` (4th quarter, 5:00 or less, one score)
  - `NO UPDATES` (a live game whose feed hasn't moved in 6 minutes)
- **A hatched, dimmed lane** is a commercial. The field shows `BACK IN ~1:48`, counted from when the board saw the break begin. The typical lengths come from the 2026-10-18 play-by-play: 2:32 for a TV timeout, 3:22 for a quarter break, 2:46 for the two-minute warning, 14 min for halftime. A break already running when the board loads gets no countdown.
- **The end-zone column** on the right holds the latest score or turnover for 5 minutes, dimmed after 2.
- **Flashes:** a touchdown for 15 s, a field goal or safety for 8 s, a turnover for 10 s. Scores flash in the scorer's color, turnovers in amber.
- **Compact rows** are pregame, halftime and final games. Finals stay for 10 minutes, then move to the rail at the bottom with the rest of the day's slate.

## Mock RedZone (`?director=1`)

A strip above the rail shows what a RedZone-style director would put on the
TV: one game **FULL**, a **SPLIT** of two, or a **QUAD**. It controls nothing.
It says what it would switch to and why, so a Sunday can test the rules before
Home Assistant can act on them. The games it picked are outlined in white on
the field. A switch lights the strip yellow for 6 s, which is the cue to change
channels by hand. Each switch is also logged to the console as `[director]`.

The rules are in `director.js`:

- Every live game outside a break gets a heat score:
  - goal to go +6, red zone +4.5, scoring range (inside the 40) +1.5
  - 4th down +2.5
  - close and late +4 (+5.5 in the last two minutes or OT)
  - a turnover or score in the last 45 s, BACK from a break
- **Blowouts are discounted, not dropped.**
  - Competitiveness comes from ESPN's live win probability. Without one, it
    comes from the margin against time left.
  - Past about 85/15, every reason to watch counts for less, down to 35% for
    a decided game.
  - A goal-to-go drive in a blowout still shows when nothing else is on.
  - A close-and-late game where the leader is running out the clock stops
    counting as a key game.
- **Key games** are the ones at heat 5 or more, plus any close-and-late game
  still in doubt.
  - One key game goes full screen.
  - Two go to a split, even when one is in the red zone.
  - Three or more go to a quad.
  - With no key game, the quad holds the four best live games.
- **Conservative switching**, until we know how slow a real switch is:
  - Never within 3 minutes of the last switch, even for a red-zone trip.
  - An ordinary change waits 5 minutes, and the pick has to hold for 30 s.
  - A game already on screen gets +1.5.
  - A quad tile sits through its own TV break.
  - The cost: a full-screen game can sit on a commercial for up to 3 minutes.

Score it against a past slate:

```sh
node director-replay.js 2026-10-18 --from 17:00 [--log]
```

It replays the day in 5 s steps. `--dwell`, `--urgent` and `--settle` (in
seconds) try other timings. It reports:

- switches per hour
- time spent in each layout
- how many TDs, FGs and turnovers were on screen (full or tiled) when they
  happened, and how many in competitive games were missed
- red-zone and close-and-late coverage

The 2026-10-18 1pm window (17:00–20:25Z) at each timing:

| Hold / floor | Switches/hr | TDs in competitive games missed | Close-and-late in doubt, off screen |
|---|---|---|---|
| 45 s / 15 s | 40 | 1 of 24 | 18% |
| 5 min / 3 min (default) | 13 | 4 of 24 | 15% |

## Data

ESPN's `site.api.espn.com/.../nfl/scoreboard` is unofficial and undocumented,
so fields can change without notice. Responses are cached for 10 s at the CDN,
so the board's data is at most about 15 s old.

- **TV breaks:** ESPN logs TV timeouts as "Official Timeout" plays. That's where
  the commercial state comes from.
- **When a new score is believed:** ESPN sometimes posts a wrong score for a
  moment. Its play-by-play has a 6 → 20 → 6 spike and a 0–0 dip. A new score is
  believed in one of two cases:
  - the newest play is a scoring play
  - the same value arrives twice in a row
- **When a score fires:** only when it passes the best believed score. A score
  that stays lowered counts as overturned and clears its trace.

## Files

| File | Holds |
|---|---|
| `feed.js` | ESPN JSON → game model; play types, breaks, scores and turnovers. Pure functions. |
| `board.js` | Memory between polls: events, break timers, BACK, which games are shown. |
| `sim.js` | Past slates rebuilt from play-by-play. |
| `field.js`, `grid.js` | The two views. |
| `ui.js` | Shared text, team colors and DOM helpers. |
| `director.js`, `tv.js` | Mock RedZone: the director's rules, and its strip. |
| `director-replay.js` | Scores the director against a past slate (Node). |
| `app.js` | Entry: reads URL parameters, starts the board, renders twice a second. |

## Tests

```sh
npm test        # Node 22+, no dependencies
```

## Not built yet

- Player watchlist (a hand-written list, highlighted in play text)
- Home Assistant channel switching on the main TV
- Delaying spoilers only for the game on the TV (needs to know what's on it)
