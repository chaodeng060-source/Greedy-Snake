# Room API v1

Standalone BASE `http://127.0.0.1:PORT` (also supports `/api/ai-snake` prefix); host application BASE `/api/ai-snake`.
JSON errors `{error}`; all mutations use POST. No credentials in public snapshots or replays.

## Routes

- GET `/health` → `{ok:true}`
- GET `/catalog` → `{models:[{provider,model,name,skin}]}`
- GET `/rooms` → `{rooms:[snapshot]}`
- POST `/rooms` → `{room,hostToken,playerId?,token?}`. Body:
  `{mode:'ai'|'mixed', victory?:'survival'|'score', world?:'arena'|'roam', durationSeconds?:number,
  humans:[{name,skin,skinCode?}], ais:[{name,provider:'opencode'|'ollama'|'manual',model,skin}], seed?,tickMs?,maxTurns?,wrap?}`.
  Defaults: survival, arena, durationSeconds60, maxTurns600, wraptrue, tickMs350.
  durationSeconds must be a JSON integer1–3600; it controls the real score deadline only.
  Roam forces wrapfalse. Score raises maxTurns to at least `durationSeconds*25+1` (AI-only moves at most once per40ms),
  so a short requested turn cap cannot end a score match early. Survival retains the1–1200 turn safety limit.
  First human belongs to creator, second joins separately. Manual AI must join before start. No automatic start or model calls on create.
- POST `/rooms/:id/join` `{name?,kind:'human'|'ai',playerId?}` → `{room,playerId,token}`.
  Claims a reserved seat. Auto model seats cannot be claimed.
- POST `/rooms/:id/start` `{hostToken}` → `{room}`. Initial AI plans warm up before movement and before the score clock starts.
- GET `/rooms/:id` → snapshot
- GET `/rooms/:id/look?as=ID` → `{room,board,viewport:{x,y,width,height},remaining,queuedMoves,turn,tickMs}`.
  Board describes CURRENT position; queuedMoves execute before new moves. Remaining is own queue length.
  Viewport x/y are GLOBAL origin coordinates; width/height are finite view dimensions. Arena origin is0,0.
- POST `/rooms/:id/plan` `{playerId,token,moves:'URDL...',requestId?,usage?:{calls,promptTokens,completionTokens},error?,errorCode?}`
  → `{room,remaining}`. AI plans append to queue, each nonempty plan6–128 steps, total128.
  Current implementation requires6 even for the final partial plan; terminal game truncates unused moves.
  Humans append one direction per request, ordered queue capacity4. Engine ignores opposite turns.
  Duplicate requestId is ignored. Usage is an additive delta; bot admits `calls:1` with empty moves BEFORE its request,
  then sends tokens and moves with `calls:0` using a different requestId.
  After seat authorization, plan checks the score deadline before accepting moves or usage; an expired room returns finished with no admission count.
  Safe errorCode matches `[A-Z_]{1,32}`. Errors send empty moves; straight fallback belongs only to server.
- GET `/rooms/:id/replay` → original `ai-snake/1` config+moves plus players/usage/timing/settlement,
  mode/victory/world/durationSeconds/startedAt/deadlineAt and optional `ended:{turn,reason:'time'}`.
- GET `/rooms/:id/settlement` → `{settlement}`
- GET `/leaderboard` → `{players:[entry], boards:{'survival:arena':[entry], 'survival:roam':[entry], 'score:arena':[entry], 'score:roam':[entry]}, matches:[history]}`.
  Entry: `{identity,name,kind,best,games,wins,totalEaten}`. `players` remains the legacy aggregate; use boards for comparable scores.
  History includes roomId, pacing mode, victory, world, durationSeconds, winner, turns, startedAt and finishedAt.
  Pre-mode history imports into survival:arena; unavailable old timestamps/mode remain null or absent, never guessed.

## Snapshot and clock

Snapshot includes `{id,status:'lobby'|'warming'|'running'|'finished',mode,config,state,
players:[{id,kind,name,identity,provider,model,skin,skinCode?,joined,testBot}],
plans:{ID:{remaining}},usage:{ID:{calls,promptTokens,completionTokens,errors}},settlement,tickMs,createdAt,
victory,world,durationSeconds,startedAt,deadlineAt,remainingMs}`.

startedAt/deadlineAt are numeric milliseconds (null before actual play); createdAt retains its ISO string.
Score countdown starts AFTER warmup. remainingMs is computed from the service clock, includes all later AI/inference waits,
and is0 once finished; before warmup ends it shows the full duration. Survival remainingMs/deadlineAt are null.
Persisted score deadlines include restart downtime. Deadline is checked BEFORE readiness and next-tick waits.
At expiry service calls shared engine `finishGame(state,config,'time')`, writes `game.ended={turn,reason:'time'}`
BEFORE settlement/replay persistence, and stops bot processes. Shared engine replay applies that marker at the recorded turn.

## Victory, world and pacing are independent

- `mode` selects pacing: ai waits for all living AI queues (up to60sec); mixed runs every tickMs after warmup without midgame waits.
  After an AI errors or times out its first queue wait, server continues it straight until another plan arrives.
- `victory:'survival'`: last living snake wins; simultaneous final deaths draw. At the safety turn cap, survival then score decide;
  equal highest scores draw, without a length tiebreaker. A singleplayer room may run to its turn cap.
- `victory:'score'`: highest cumulative score across ALL entrants, including dead snakes, wins at the real deadline.
  Collisions eliminate permanently; no respawn. One survivor continues; all dead may end early. Highest-score ties draw; length does not break ties.
- `world:'arena'`: finite board, configured wrap or walls. `world:'roam'`: unbounded GLOBAL coordinate plane, finite viewport,
  no walls or wrapping. config width/height remain view/spawn size `15+4*(seats-1)`, not world boundaries.
  Full bodies remain authoritative for collisions outside the visible viewport. Resident chunks/food/rewards are bounded around living heads;
  deterministic consumed-food deltas survive unload/reload. Camera follows the selected snake; world chunk x/y are CHUNK coordinates.

## Bots and limits

Server spawns one runner per automatic AI on start:
`node bots/run.mjs --url BASE --room ID --player ID --provider opencode|ollama --model MODEL --max-calls N`,
where `N = callBudget(config, tickMs)`: enough 32-move plans for the expected turns plus 4 retries, clamped to 8–40
(score games use durationSeconds/tickMs; AI-only score games assume the 40ms fastest tick).
Seat token is only in AI_SNAKE_PLAYER_TOKEN. Existing local auth/environment only; never log keys or provider response bodies.
Runner exports resolveProvider() and runBot(), guarded CLI entry. CLI supports manual create/join/look/plan/start/replay/leaderboard.

Prefill32 moves; request more at `remaining <= max(18,ceil(lastLatencyMs/tickMs)+4)`, poll100ms, model timeout≤55sec.
Prompt includes current board, own position, queuedMoves, projected own start and viewport origin in GLOBAL coordinates.
Roam projection never applies modulo, even when old raw config.wrap is true. No movement algorithm generates actions.
Per-seat call cap (8–40, see above) persists across restarts; global automatic AI limit4; each room≤4AI/2human, total1–6 snakes.
Rewards only in room games. New rooms set `config.powerups` (POST body `powerups:false` opts out): & crown +10,
% cherries double the eater's points for 10 turns, ~ snowflake freezes every other living snake for 3 turns
(frozen: no move, no eat, no death, whole body incl. head is a wall; their queued moves wait). Replays without the flag are unchanged.
Rooms created from 2026-10-31 also set `config.guard` (POST `guard:false` opts out): ! golden shield makes the eater immune to other
snakes for 8 turns — it passes through other bodies (frozen heads too) and survives head collisions while the other dies ("撞上金身");
walls and self-bites still kill, and others hitting its body still die. Two shielded heads in one cell both survive and nobody eats there.
Powerup rooms without `guard` keep their original reward draw.
In `mode:'ai'` rooms (which wait for AI plans), an AI seat that eats a shield has its queue cleared and the room waits for a
fresh plan (skipped once the seat's call budget is spent; mixed rooms keep the queue because they run in real time).
Plans may carry `basedOnTurn` (the `look.turn` they were built from); a plan built before the shield turn is dropped
(`stale:true`, usage still counted). Plans without `basedOnTurn` are accepted as before.
A runner tolerates up to 3 consecutive model failures (each posts an error and counts a call); longer plans are truncated to the requested steps. Tests may set testBot; labelled test seats are excluded from aggregate AND grouped boards.
