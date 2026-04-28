# MineVoyager — Time-Efficient Minecraft Decision Flow

Universal decision tree the agent should follow for **any** modded instance, with notes tailored to our Forge 1.18.2 + bridge-proxy setup.

The core principle: **walk the prerequisite chain BACKWARDS from the target until every leaf is something you already have or can hand-pick, then execute FORWARDS, satisfying each prereq as a step.** Skip steps whose result is already in inventory.

---

## 1. Top-level rollout decision

```mermaid
flowchart TD
    Start([New task: VERB N TARGET]) --> Preempt{"Inventory already<br/>has ≥ N TARGET<br/>(or alias drop)?"}
    Preempt -- yes --> Done([✓ DONE — skip action agent])
    Preempt -- no --> Survival{"HP &gt; 6<br/>AND food &gt; 6<br/>AND no hostile &lt; 4 blocks?"}
    Survival -- no --> Survive[Resolve survival<br/>see §4]
    Survive --> Survival
    Survival -- yes --> Verb{What VERB?}

    Verb -- mine --> Mine[Mine flow §2]
    Verb -- craft --> Craft[Craft flow §3]
    Verb -- smelt --> Smelt[Smelt flow §3b]
    Verb -- explore/find --> Explore[Move + scan voxels]

    Mine --> Verify{Inventory delta<br/>OR absolute count<br/>≥ N TARGET<br/>using alias map?}
    Craft --> Verify
    Smelt --> Verify
    Explore --> Verify
    Verify -- yes --> Done
    Verify -- no --> Critique[Record critique;<br/>retry up to N_max]
```

---

## 2. Mine-flow: backward prerequisite walk

```mermaid
flowchart TD
    M([Mine N TARGET]) --> HandMine{"Hand-minable?<br/>wood/soil/sand/gravel/<br/>clay/leaves/snow"}
    HandMine -- yes --> EquipPref[Equip preferred tool<br/>if available<br/>axe→wood, shovel→soil<br/>else proceed bare-handed]
    HandMine -- no --> ToolReq{"Pickaxe-tier block?<br/>(stone, ore, deepslate,<br/>obsidian…)"}
    ToolReq -- yes --> HasTool{Have required<br/>pickaxe tier?}
    HasTool -- yes --> EquipTool[Equip best pickaxe]
    HasTool -- no --> CraftTool[Craft missing pickaxe §3a]
    CraftTool --> HasTool
    EquipTool --> Find
    EquipPref --> Find
    ToolReq -- no --> EquipAny[Equip any best tool] --> Find

    Find{findBlock TARGET<br/>within 32?} -- not found --> Expand{Range &lt; 96?}
    Expand -- yes --> Expand1[Expand search to 96] --> Find
    Expand -- no --> CaveCheck{Underground /<br/>cave-trapped?}
    CaveCheck -- yes --> Escape["escapeToSurface(bot)<br/>① pathfinder+tower 45 s<br/>② pillar-jump in place<br/>③ diagonal staircase"]
    Escape --> Find
    CaveCheck -- no --> Travel[Travel toward biome<br/>likely to contain TARGET]
    Travel --> Find

    Find -- found --> Reach{Reachable<br/>line-of-sight<br/>+ pathfinder OK?}
    Reach -- no --> Dig[Dig staircase OR<br/>place scaffolding OR<br/>escapeToSurface]
    Dig --> Find
    Reach -- yes --> Break["mineBlock:<br/>auto flood-fills whole tree<br/>(logs) or whole vein (ores);<br/>break → walk → pickup"]

    Break --> Bridge{"Block name returned<br/>by proxy is **barrier**?"}
    Bridge -- yes --> Skip[SKIP — modded decoration<br/>placeholder. Don't waste<br/>cycles trying to mine.]
    Skip --> Find
    Bridge -- no --> Drop{Drop = TARGET<br/>OR known alias<br/>e.g. stone→cobblestone?}
    Drop -- alias --> Count[Count alias toward<br/>delta and absolute total]
    Drop -- exact --> Count
    Count --> EnoughM{Have N total?}
    EnoughM -- no --> Find
    EnoughM -- yes --> RetM([✓ return])
```

---

## 3a. Craft-flow: recipe walk

```mermaid
flowchart TD
    C([Craft N TARGET]) --> Recipe{Lookup recipe<br/>for TARGET}
    Recipe -- table needed --> HasTable{Have crafting_table<br/>in inventory or<br/>adjacent?}
    HasTable -- no, but have ≥4 planks --> MakeTable[craftItem crafting_table]
    HasTable -- no planks --> NeedPlanks[Recurse: craft ≥4 planks<br/>→ recurse: mine ≥1 log §2]
    MakeTable --> Place[Place table adjacent]
    HasTable -- yes --> Place

    Recipe -- no table --> Inputs

    Place --> Inputs{All ingredient counts<br/>satisfied in inventory?}
    Inputs -- no --> Sub[For each missing input:<br/>recurse craft/mine/smelt §1]
    Sub --> Inputs
    Inputs -- yes --> Run[craftItem TARGET, N]
    Run --> RetC([✓ return])
```

## 3b. Smelt-flow

```mermaid
flowchart TD
    S([Smelt N TARGET]) --> HasFurnace{Have placed furnace<br/>nearby?}
    HasFurnace -- no, in inventory --> PF[Place furnace adjacent]
    HasFurnace -- not at all --> CraftFur[Recurse: craft 1 furnace<br/>= 8 cobblestone §3a]
    CraftFur --> PF
    PF --> HasInput{Have raw input<br/>≥ N?}
    HasFurnace -- yes --> HasInput
    HasInput -- no --> Mine[Recurse: mine raw §2]
    Mine --> HasInput
    HasInput -- yes --> HasFuel{Have fuel<br/>≥ ⌈N/8⌉ coal<br/>OR equivalent?}
    HasFuel -- no --> GetFuel[Recurse: mine coal_ore<br/>or chop logs for charcoal]
    GetFuel --> HasFuel
    HasFuel -- yes --> Smelt[smeltItem input,<br/>fuel, N]
    Smelt --> RetS([✓ return])
```

---

## 4. Survival interrupts (always preempt mining)

```mermaid
flowchart TD
    Su([Each tick / pre-action]) --> H{HP &lt; 8?}
    H -- yes --> Heal[Eat food → HP regens<br/>retreat from threat]
    H -- no --> F{food &lt; 14?}
    F -- yes --> Eat[Equip best food → consume]
    F -- no --> N{Hostile &lt; 8 blocks?}
    N -- creeper --> Retreat[Open distance &gt; 4<br/>break LOS]
    N -- skeleton --> Close[Close gap or wall up]
    N -- zombie/spider --> Fight{Have sword<br/>+ food &gt; 16?}
    Fight -- yes --> Attack
    Fight -- no --> Retreat
    N -- none --> Night{Night &<br/>no shelter?}
    Night -- yes --> Sleep[Place sleeping_bag<br/>OR dig 1×2 hole + seal]
    Night -- no --> InvFull{Inventory full?}
    InvFull -- yes --> Toss[tossStack junk:<br/>dirt, gravel, sand,<br/>excess cobble, rotten_flesh]
    InvFull -- no --> OK([continue task])
```

---

## 5. Tool-tier ladder (mine requirements)

```mermaid
flowchart LR
    Hand([bare hand / shovel]) --> WP[wooden_pickaxe]
    WP --> SP[stone_pickaxe]
    SP --> IP[iron_pickaxe]
    IP --> DP[diamond_pickaxe]
    DP --> NP[netherite_pickaxe]

    Hand -.always drops-.-> SoilGroup["dirt · sand · gravel · clay<br/>snow · podzol · coarse_dirt<br/>⚡ shovel ≈ 2× faster, but bare hands ALWAYS drop"]
    Hand -.always drops-.-> Wood["any *_log / *_wood / stem / hyphae<br/>⚡ axe ≈ 2× faster, but bare hands ALWAYS drop"]
    Hand -.always drops-.-> Soft["leaves (shears for self-drop)<br/>wool (shears for self-drop)"]
    WP -."⚠ zero drop without"-.-> WP_set["stone · cobblestone · coal_ore<br/>granite/andesite/diorite<br/>tuff · deepslate variants"]
    SP -."⚠ zero drop without"-.-> SP_set["iron_ore · copper_ore · lapis_ore<br/>blackstone · basalt"]
    IP -."⚠ zero drop without"-.-> IP_set["diamond_ore · emerald_ore<br/>gold_ore · redstone_ore"]
    DP -."⚠ zero drop without"-.-> DP_set["obsidian · ancient_debris<br/>respawn_anchor"]
```

**Drop aliases (counts toward target):**

| Block target | Counts these drops |
|---|---|
| `stone` | `cobblestone`, `stone` (Silk Touch) |
| `coal_ore`, `deepslate_coal_ore` | `coal` |
| `iron_ore`, `deepslate_iron_ore` | `raw_iron` |
| `copper_ore`, `deepslate_copper_ore` | `raw_copper` |
| `gold_ore`, `deepslate_gold_ore` | `raw_gold` |
| `nether_gold_ore` | `gold_nugget` |
| `diamond_ore` | `diamond` |
| `emerald_ore` | `emerald` |
| `lapis_ore` | `lapis_lazuli` |
| `redstone_ore` | `redstone` |
| `nether_quartz_ore` | `quartz` |
| `gravel` | `gravel` or `flint` |
| `grass_block` | `dirt`, `grass_block` |
| `clay` | `clay_ball` |
| `snow`, `snow_block` | `snowball` |
| `glowstone` | `glowstone_dust` |
| `melon` | `melon_slice` |
| `sweet_berry_bush` | `sweet_berries` |
| `cocoa` | `cocoa_beans` |

---

## 6. Strategic progression (Stone Age → Diamond Age)

The curriculum should respect this DAG; never propose a node whose ancestors aren't done.

```mermaid
flowchart TD
    Logs[≥3 wood logs] --> Planks[≥12 planks]
    Planks --> Sticks[≥4 sticks]
    Planks --> Table[1 crafting_table]
    Table --> WPick[1 wooden_pickaxe]
    Sticks --> WPick
    Planks --> WShovel[1 wooden_shovel]
    Sticks --> WShovel
    Planks --> WAxe[1 wooden_axe]
    Sticks --> WAxe

    WPick --> Cobble[≥11 cobblestone]
    Cobble --> Furnace[1 furnace = 8 cobble]
    Cobble --> SPick[1 stone_pickaxe]
    Cobble --> SAxe[1 stone_axe]
    Cobble --> SShovel[1 stone_shovel]
    Cobble --> SSword[1 stone_sword<br/>defense]

    WPick --> Coal[≥4 coal_ore → coal]
    Logs --> Charcoal[smelt logs → charcoal<br/>backup fuel]
    Coal --> Torches[torches: 1 stick+1 coal]
    Charcoal --> Torches

    SPick --> Iron[≥3 iron_ore → raw_iron]
    Furnace --> SmeltIron[smelt raw_iron → iron_ingot]
    Iron --> SmeltIron
    Coal --> SmeltIron
    SmeltIron --> IPick[1 iron_pickaxe]
    SmeltIron --> IShovel[1 iron_shovel]
    SmeltIron --> ISword[1 iron_sword]
    SmeltIron --> Bucket[1 bucket = 3 iron]
    SmeltIron --> Shield[1 shield]

    IPick --> Diamond[≥3 diamond_ore]
    Diamond --> DPick[1 diamond_pickaxe]
    Diamond --> DSword[1 diamond_sword]
    DPick --> Obsidian[≥10 obsidian]
    Bucket --> Water[water bucket]
    Bucket --> Lava[lava → obsidian via water]
    Obsidian --> Portal[Nether portal]
    Portal --> Netherite[Nether: ancient_debris<br/>→ netherite_ingot]
```

---

## 7. Modded-instance robustness rules

These are the lessons our bridge-proxy setup taught us — they generalize to any modded server:

1. **Trust the bridge, not block names.** When the proxy returns `barrier`, that's an unmappable modded decoration. Skip it; never plan around it.
2. **Always check drops, not block IDs.** Use the alias table (§5). A successful mine of `stone` will NEVER add `stone` to inventory — only `cobblestone`.
3. **Inventory is the only source of truth.** Don't trust `bot.chat("Done")` from skill code; verify with absolute inventory count.
4. **Preempt before planning.** Before each task, check whether the inventory already satisfies the target. If yes, return success without LLM call.
5. **Distinguish required vs preferred tools.**
   - *Pickaxe-tier blocks* (stone, cobblestone, any `*_ore`, deepslate variants, obsidian, basalt, etc.): bare-hand mining destroys the block with **zero drops**. Always craft the required pickaxe tier first — never attempt bare-handed.
   - *Wood-class blocks* (any `*_log`, `*_wood`, `*_stem`, `*_hyphae`, planks): drops are **guaranteed bare-handed**. An axe only adds speed. **Never abort or demand an axe** just because the bot is empty-handed.
   - *Soil-class blocks* (dirt, sand, gravel, clay, coarse_dirt, podzol, snow, soul_sand, soul_soil): drops are **guaranteed bare-handed**. A shovel only adds speed.
6. **Mine whole trees and whole veins.** `mineBlock` automatically BFS flood-fills connected matching blocks — it will mine the entire tree trunk when targeting any log, and the entire ore vein when targeting an ore block. Request only the minimum you need; the primitive collects any extras automatically.
7. **Escape cave before surface tasks.** If pathfinding to a surface goal fails, call `escapeToSurface(bot)`, which tries three strategies in order: (1) pathfinder with `canDig + allow1by1towers` for 45 s, (2) manual **pillar-jump** — digs ceiling shaft, places scaffold block underfoot while airborne, rises 1 block per step (works in 1×1 crevices), (3) ascending diagonal staircase. Call this before smelting, crafting, or any task that requires reaching a surface structure.
8. **Modded `_ore` blocks may not match vanilla regex.** The proxy substitutes per-ore-type (`*_iron_ore` → `iron_ore`); trust the substitution.
9. **Hunger is a hidden timer.** food=0 ⇒ no sprint, slow regen, eventual HP loss. Always interrupt for food when food < 14.
10. **Curriculum must reject already-done tasks.** Otherwise the LLM loops on "Mine N X" forever when N of X already in inventory.

---

## 8. Pseudocode summary (matches §1)

```
def execute(task):                       # task = "VERB N TARGET"
    if deterministic_check(task, inventory):    # §1 preempt
        return SUCCESS
    while not survival_ok():                    # §4
        handle_survival()
    plan = walk_back(task)                      # §2/§3
    for step in plan:                           # forward execution
        if deterministic_check(step, inventory):
            continue                            # already done
        execute(step)                           # recurse
    if deterministic_check(task, inventory):
        return SUCCESS
    return RETRY
```
