# DIY_REDZONE

Home-built NFL Sunday tooling: a homemade RedZone for the living room.

| Folder | What | Status |
|---|---|---|
| [`board/`](board/README.md) | The Redzone board: every live NFL game as a lane on one field, so the game closest to scoring is easy to spot. A static page that polls ESPN. | **In use.** Runs on the `nova` wall display at `http://nova:8083/`. |
| [`automute/`](automute/INITIAL_HANDOFF.md) | Auto-mute the TV during commercial breaks by watching the broadcast. | **Paused** at the Phase 0 gate: screen capture of YouTube TV returns DRM-blank frames ([findings](automute/docs/capture-findings.md)). Next step is choosing optical capture, audio-only, or a different source. |

## The board on nova

nova serves a copy of `board/` from `~/redzone` (`redzone.service`, port 8083).
Its config, and the dashboard tile that opens the board, live in the
[`TrellisLabs/nova`](https://github.com/TrellisLabs/nova) repo. Deploy from
this repo, never by editing nova directly. A direct edit gets overwritten by
the next deploy.

```sh
cd board && npm test                  # 39 node tests, no dependencies
cd ..
COPYFILE_DISABLE=1 tar czf - --exclude=test --exclude=node_modules board | ssh mbc@nova '
  rm -rf ~/redzone.new && mkdir -p ~/redzone.new && tar xzf - -C ~/redzone.new &&
  rm -rf ~/redzone && mv ~/redzone.new/board ~/redzone && rmdir ~/redzone.new'
```

Before deploying, check that nova's copy still matches the last commit. If it
doesn't, someone edited it in place: fold that change in here first.
