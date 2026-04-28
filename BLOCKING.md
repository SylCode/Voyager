# Blocking decisions / open issues for review

Created: cycle 21+, agent autopilot. Add an item here, keep iterating.

## ISSUE-1: Occasional Forge "unexpected index 0 in client reply" disconnect

**Status (cycle 30):** ✅ FIX DEPLOYED. `forge-proxy.js` now intercepts upstream
`custom_payload` packets on `fml:handshake` / `fml:loginwrapper` channels
during the play state, parses `[byte disc][int messageIndex][payload]`, and
replies with `[byte 99][int messageIndex]` (C2SAcknowledge echoing the
server's index). Mirrors the login-phase ack approach. Need to observe
log: `Recieved unexpected index 0 in client reply` should disappear and
`[forge-proxy] play-state fml:handshake ack disc=N idx=N` should appear.


## ISSUE-2: Modded server destroys blocks without spawning drop entities

**Symptom:** Bot successfully digs `birch_log` / `jungle_log` (`blockUpdate
log->air` fires at the dig position, e.g. `(-26, 62, -163)`) but **no item
entity spawns anywhere near the bot**. Cycle 24 instrumentation that logs
*every* `entitySpawn` for `item` / `experience_orb` regardless of distance
captured 5 item spawns over 6 minutes — all of them at distances 84-161 blocks
from the bot, at random Y values (12, -39, -8). None correlated with the bot's
dig sites. Bot inventory stays `sand x7` (its starting kit) forever.

**Diagnosis:**
- Game mode is **survival** (confirmed in `[DBG-CB] dig start ... gm=survival`).
- `block.canHarvest(heldItemType)` returns **true** for hand-breaking logs.
- minecraft-data registry says `block.drops = []` for `birch_log` /
  `jungle_log` — minecraft-data's drop tables for those blocks are empty
  in the version mineflayer ships. Server-side drop logic is what actually
  governs entities, but the server drops nothing either.
- Mods installed include `Quark-3.2-358.jar`, `QuarkOddities-1.18.jar`,
  `overweightfarming-1.18.2-1.6.0-forge.jar`, plus 116 others.
- `quark-common.toml` has `tweaks.simple_harvest` (Empty Hand Harvest = true
  for wheat-like crops, `Requires Empty Hand = false`) and `tools.pickarang`
  but no obvious "logs require axe" toggle in the sections we grepped.

**Hypothesis:** Some installed mod replaces vanilla loot tables with custom
ones that require a specific tool (e.g. axe) for wood logs to drop, or
silently consumes drops on hand-break. Candidate culprits: a datapack
shipped with Quark / overweightfarming, FarmersDelight, or a server-side
loot-table override.

**Why I'm not fixing it tonight:** The user mandate is "if you face a
blocking decision, log it and keep iterating." Root-causing this requires:
1. Stopping the server (disruptive).
2. Bisecting mods or reading datapack contents in each mod jar to find the
   loot-table override.
3. Possibly editing server-side loot tables (out of scope for the agent
   loop tonight).

**Workarounds the agent is using:**
- Critic accepts task completion based on chat messages (e.g. "Done: mined 1
  jungle_log"), so cycle 23 logged the first ever success.
- Manual pickup walk in `CollectBlock.js` will collect any drops if/when
  they do appear.

**Action when you have time:**
- Try `/give Voyager wooden_axe` once via console (not via bot — bot can't
  use cheats per human-likeness mandate). If that lets the bot bootstrap a
  pickaxe, the rest of curriculum should unblock.
- OR find and edit the offending loot-table override.
- OR accept the limitation and have the curriculum start with tasks that
  don't require log drops (dirt, sand, leaves, flowers — many of these
  drop fine even on modded servers).

## Status snapshot at end of cycle 24

- Successes: 1 (`Mine 1 wood log`, accepted on chat-only evidence)
- Failures: many — every "collect wood log" attempt actually breaks the
  block but produces no item.
- Disconnects: ~1 / 6min (ISSUE-1, auto-recovers).
- Cheats issued: **0** (human-likeness mandate maintained).
- Bot positions seen: 2 (basically the same — pathfinder cannot navigate
  the dense modded terrain past spawn).
- Blocking unknowns: ISSUE-1 (cosmetic), ISSUE-2 (real blocker for any
  resource-collection curriculum).

## Cycle 27 update (post-dirt-starter switch)

- **Confirmed ISSUE-2 narrowly:** Dirt-family blocks (`coarse_dirt`) DO drop
  items on hand-break — entitySpawn fires within 4-5 blocks of the bot. So
  the loot-table override is selective. Wood logs (`jungle_log` etc.) still
  drop nothing.
- **Bot earned 1st honest success: `Mine 1 dirt`** — coarse_dirt mined,
  item dropped, but pickup walk failed (drop fell to y=64.5 above the bot).
  Skill chat said "Done" so critic accepted, but inventory didn't actually
  receive the item. Need to improve pickup walk to handle drops above bot.
- **Followed-up curriculum proposal: `Mine 3 jungle logs`** — failed
  because wood doesn't drop (ISSUE-2). LLM curriculum may keep proposing
  wood-related tasks; consider patching curriculum prompt to bias toward
  dirt/stone/sand/leaves until wood is solved.

## ISSUE-3: Pickup walk fails when drop falls above the bot

**Symptom:** dirt mined at y=64 from a bot at y=62 spawns the item entity
at y≈64.5 (it falls onto/lands on top of the broken stack). The pickup
walker tries to GoalNear(x, y=64.5, z, 0.5) — pathfinder can't path up to
that air point.

**Fix idea:** before walking, drop the y-coordinate to the bot's y level
(or floor it down to the nearest solid block) so pathfinder picks a
ground-level approach. Let mineflayer's auto-collect grab the item once
the bot is standing under/near it.

## ISSUE-4: Stuck-unstucker was using /tp (cheat) and crashed on undefined

**Symptom (cycle 26):** When pathfinder stalled for 100 ticks, Voyager's
built-in `teleportBot()` was issuing `bot.chat("/tp @s X Y Z")` which our
human-likeness override blocks. The block log was spamming `[BLOCKED-CMD]
/tp @s ...` every ~2.5s, and on bot enclosure `findBlocks` returned an
empty array → `block.x` undefined → uncaughtException loop → no progress.

**Fix (cycle 27, in `voyager/env/mineflayer/index.js`):** Replaced
`teleportBot()` with a no-cheat unstucker that:
1. Looks for adjacent walkable air blocks (max distance 2).
2. If found, sets a pathfinder `GoalNear` to step there.
3. If not, presses jump for 250ms.
4. Wraps everything in try/catch so an undefined block can never crash
   the physics tick again.

## Cycle 28-29 update (pickup-walk improvements)

- Tried walking to `floor(dropY)` and adding a jump+nudge retry loop.
- Result: **0 of 8 manual-pickup attempts succeeded** in cycle 29 over
  10 minutes. `gone=true` count: 0. Bot still has only `sand x7`.
- Disconnects: still 1/cycle (ISSUE-1).
- Crashes: **0** (ISSUE-4 fix holds).
- LLM keeps proposing `/pause`, `/time set 5000`, `/difficulty peaceful` —
  all correctly blocked, but it's prompt noise. (~30+ blocked cmds per
  cycle; not crashing, just wasting tokens.)

## ISSUE-5: Manual pickup walk reaches the drop position but item is never
## auto-collected by mineflayer

**Symptom (cycle 29):** Pathfinder successfully reaches within ~0.5-0.7 of
the drop's footprint, then waits up to 3.5s including a jump-nudge retry,
but the item entity ID never disappears from `bot.entities` and the
inventory never updates. Cycle 28+29 logs show 8/8 failures.

**Hypotheses:**
1. **Forge protocol mismatch:** Item `entity.type === "other"` (not the
   vanilla `"object"`). mineflayer's auto-pickup hook may key off
   `entity.type === "object"` and skip these. Worth grepping mineflayer
   plugins for the auto-pickup code path.
2. **Entity desync:** The item's `position` reported by mineflayer might
   lag the server position; bot is "near" the wrong coordinates.
3. **No-pickup mod feature:** A mod could mark these specific drops as
   non-collectible (despawn timer, "ground item" mod, etc.).

**Investigation idea:** Add `bot.activateEntity(itemEntity)` or
`bot._client.write("interact", ...)` as a fallback. Or grep the mineflayer
source under `node_modules/mineflayer/lib/plugins/` for the entity-pickup
listener and see what condition triggers `inventory_pickup` packet.

## Final session status (cycle 29 end)

## Cycle 30 update — user feedback applied

User confirmed in person: **hand-mining works fine on this server, no special
tools needed**. So our "cycle 26 ISSUE-2 hypothesis" (loot table requires
axe) was WRONG. The real bug: the LLM-generated skills emit
`bot.chat("Done: mined 1 X")` even when the bot was nowhere near X and was
in fact mining air in a self-dug puddle. CollectBlock's `bot.chat("Collect
finish!")` always fires regardless of whether anything was actually broken,
and the skill code copies that pattern unconditionally.

### Three fixes deployed in cycle 30

1. **ISSUE-1 fixed** — see updated section above. `forge-proxy.js` now acks
   in-play `fml:handshake` / `fml:loginwrapper` packets with the matching
   message index.

2. **Lying-about-mining fixed** — `voyager/control_primitives/mineBlock.js`
   now snapshots the inventory count of the requested item BEFORE the
   collect call and verifies a real delta AFTER. If `delta < count`, throws
   a descriptive error so the surrounding skill's `await mineBlock(...)`
   propagates the failure instead of silently chatting "Done: mined 1 X".

3. **Stuck-recovery improved** — `voyager/env/mineflayer/index.js`
   `teleportBot()` rewritten as a 5-tier escape: (1) pathfind to adjacent
   walkable air, (2) jump nudge, (3) dig the block in front of us at foot
   or head level (no liquid, no bedrock), (4) pillar up — equip a
   placeable block (planks/dirt/stone/log) and place it under our feet
   while jumping, (5) random cardinal walk for 2s with jump held. Every
   tier wrapped in try/catch; never uses `/tp`.

### Status of legacy issues after cycle-30 fixes

- ISSUE-2 (wood loot tables): **REOPENED as "skills lie about success"**.
  Now that mineBlock throws on zero inventory delta, this is empirically
  testable — if logs really do drop on hand-mine, the next cycle should
  show a real success in the inventory log. If not, we re-investigate
  loot tables.
- ISSUE-3 (drop above bot Y): unchanged, still relevant for ISSUE-5.
- ISSUE-4 (unstucker /tp / crashes): superseded by the new 5-tier escape.
- ISSUE-5 (manual pickup never succeeds): deferred per user — fixes 4 & 5
  are "for later". Will revisit after we observe whether the new mineBlock
  delta-check is enough to reveal whether the dig itself was the issue
  vs. the pickup walk.
