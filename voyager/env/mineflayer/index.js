const fs = require("fs");
const express = require("express");
const bodyParser = require("body-parser");
const mineflayer = require("mineflayer");

// On a heavily-modded Forge 1.18.2 server the bot frequently sees momentary
// gaps in physics ticks during chunk load / mod registry sync. Mineflayer
// plugins (pathfinder, pvp, collectBlock) call `bot.waitForTicks()` and the
// resulting rejection is unhandled, killing the Node process before the
// Voyager Python side can recover. Catch these so the run continues.
process.on("unhandledRejection", (reason) => {
    console.error("[mineflayer] unhandledRejection:", reason && reason.stack || reason);
});
process.on("uncaughtException", (err) => {
    console.error("[mineflayer] uncaughtException:", err && err.stack || err);
});

const skills = require("./lib/skillLoader");
const { initCounter, getNextTime } = require("./lib/utils");
const obs = require("./lib/observation/base");
const OnChat = require("./lib/observation/onChat");
const OnError = require("./lib/observation/onError");
const { Voxels, BlockRecords } = require("./lib/observation/voxels");
const Status = require("./lib/observation/status");
const Inventory = require("./lib/observation/inventory");
const OnSave = require("./lib/observation/onSave");
const Chests = require("./lib/observation/chests");
const { plugin: tool } = require("mineflayer-tool");

let bot = null;

const app = express();

app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: false }));

app.post("/start", (req, res) => {
    if (bot) onDisconnect("Restarting bot");
    bot = null;
    console.log(req.body);
    bot = mineflayer.createBot({
        host: process.env.MC_HOST || "localhost", // minecraft server ip
        port: req.body.port, // minecraft server port
        username: process.env.MC_USERNAME || "bot",
        // Pin protocol to the version of the user's modded server (Forge 1.18.2
        // via forge-proxy.js). Without this mineflayer auto-negotiates and
        // picks a 1.19+ protocol that the proxy can't speak.
        version: process.env.MC_VERSION || "1.18.2",
        auth: process.env.MC_AUTH || "offline",
        disableChatSigning: true,
        checkTimeoutInterval: 60 * 60 * 1000,
    });
    bot.once("error", onConnectionFailed);

    // Event subscriptions
    bot.waitTicks = req.body.waitTicks;
    bot.globalTickCounter = 0;
    bot.stuckTickCounter = 0;
    bot.stuckPosList = [];
    bot.iron_pickaxe = false;

    bot.on("kicked", onDisconnect);

    // ===== INSTRUMENTATION (cycle 10): diagnose collectBlock empty-inventory bug
    bot._dbgInvSize = () => {
        try { return bot.inventory.items().length; } catch (_) { return -1; }
    };
    bot.on("playerCollect", (collector, collected) => {
        try {
            if (collector && bot.entity && collector.id === bot.entity.id) {
                console.log(`[DBG] playerCollect entity=${collected && collected.name} (id=${collected && collected.id}) inv=${bot._dbgInvSize()}`);
            }
        } catch (e) { console.log("[DBG] playerCollect err " + e.message); }
    });
    bot.on("itemDrop", (entity) => {
        try {
            const _meta = entity && entity.metadata && entity.metadata.find && entity.metadata.find((m) => m && m.itemCount !== undefined);
            const _item = (entity && entity.getDroppedItem && entity.getDroppedItem()) || (entity && entity.metadata && entity.metadata[8]);
            const _itemName = _item && (_item.name || (_item.itemId !== undefined ? `id=${_item.itemId}` : ""));
            const _itemCount = _item && _item.count;
            console.log(`[DBG] itemDrop name=${entity && entity.name} item=${_itemName || "?"}x${_itemCount || "?"} pos=${entity && entity.position} dist=${bot.entity ? entity.position.distanceTo(bot.entity.position).toFixed(2) : "?"} inv=${bot._dbgInvSize()}`);
        } catch (e) { console.log("[DBG] itemDrop err " + e.message); }
    });
    bot.on("entitySpawn", (entity) => {
        try {
            if (!entity) return;
            const bp = bot.entity && bot.entity.position;
            const d = bp && entity.position ? entity.position.distanceTo(bp) : -1;
            // Only log items+experience (signal of dig drops); ignore mobs/players spam
            if (entity.name === "item" || entity.name === "experience_orb" || entity.type === "object" || entity.type === "other") {
                console.log(`[DBG] entitySpawn name=${entity.name} type=${entity.type} pos=${entity.position} dist=${d.toFixed(2)}`);
            }
        } catch (e) {}
    });
    // diagnose dig: log every block update from server within 4 blocks of bot
    bot.on("blockUpdate", (oldBlock, newBlock) => {
        try {
            const bp = bot.entity && bot.entity.position;
            if (!bp || !newBlock || !newBlock.position) return;
            const d = newBlock.position.distanceTo(bp);
            if (d > 5) return;
            const oldName = oldBlock && oldBlock.name;
            const newName = newBlock && newBlock.name;
            if (oldName !== newName) {
                console.log(`[DBG] blockUpdate ${oldName}->${newName} at ${newBlock.position} dist=${d.toFixed(2)}`);
            }
        } catch (e) {}
    });
    // ===== END INSTRUMENTATION

    // mounting will cause physicsTick to stop
    bot.on("mount", () => {
        bot.dismount();
    });

    // ===== Floating-physics resync (DISABLED in cycle 16) =====
    // Was needed to recover from /tp / /spreadplayers desync, but those are gone now.
    // Setting onGround=false every second was fighting pathfinder, freezing the bot
    // in place for minutes at a time (real players don't have this problem because
    // they actually walk and trigger physics naturally).
    // ===== END resync

    bot.once("spawn", async () => {
        bot.removeListener("error", onConnectionFailed);

        // HUMAN-LIKE BEHAVIOR ENFORCEMENT: real players cannot run server
        // commands. Override bot.chat to strip any leading "/" message — those
        // would be commands. Allow plain text chat (used for logging task
        // progress). The only exceptions are the two initial /gamerule calls
        // we issue right below from this very function (we mark them with a
        // private symbol so they pass through).
        const ALLOW = Symbol("allowCommand");
        const _origChat = bot.chat.bind(bot);
        // Allow /home, /spawn, /sethome — essential escape/reset commands on
        // adventure servers. All other slash commands remain blocked.
        const _ALLOWED_CMDS = ["/home", "/spawn", "/sethome"];
        bot.chat = function (msg, opts) {
            try {
                if (typeof msg === "string" && msg.startsWith("/") && opts !== ALLOW) {
                    const _cmd = _ALLOWED_CMDS.find((c) => msg.trimEnd().toLowerCase() === c || msg.toLowerCase().startsWith(c + " "));
                    if (!_cmd) {
                        console.log(`[BLOCKED-CMD] ${msg.slice(0, 80)}`);
                        return;
                    }
                    console.log(`[ALLOWED-CMD] ${msg.slice(0, 80)}`);
                }
            } catch (e) {}
            return _origChat(msg);
        };
        bot.chat.ALLOW = ALLOW;
        // Expose raw chat for emergency escapes so symbol is not needed.
        bot._rawChat = (msg) => _origChat(msg);

        let itemTicks = 1;
        // HUMAN-LIKE: hard reset no longer issues /clear, /kill, /give, /item.
        // A real player can't reset their inventory or position. If the agent
        // got into a bad state, it must dig/walk/craft its way out.
        // (Old code performed: bot.chat("/clear @s"); bot.chat("/kill @s");
        // and then /give for each saved item.)

        // HUMAN-LIKE: do NOT teleport the bot back on reset. A real player
        // continues from where they are. Position is informational only.
        // (Old code: bot.chat(`/tp @s ${x} ${y} ${z}`) when req.body.position present.)

        // if iron_pickaxe is in bot's inventory
        if (
            bot.inventory.items().find((item) => item.name === "iron_pickaxe")
        ) {
            bot.iron_pickaxe = true;
        }

        const { pathfinder } = require("mineflayer-pathfinder");
        const tool = require("mineflayer-tool").plugin;
        const collectBlock = require("mineflayer-collectblock").plugin;
        const pvp = require("mineflayer-pvp").plugin;
        // Newer minecrafthawkeye exports the plugin as `default` rather than
        // as the module itself.
        const hawkeyeModule = require("minecrafthawkeye");
        const minecraftHawkEye = hawkeyeModule.default || hawkeyeModule;
        bot.loadPlugin(pathfinder);
        bot.loadPlugin(tool);
        bot.loadPlugin(collectBlock);
        bot.loadPlugin(pvp);
        bot.loadPlugin(minecraftHawkEye);

        // bot.collectBlock.movements.digCost = 0;
        // bot.collectBlock.movements.placeCost = 0;

        obs.inject(bot, [
            OnChat,
            OnError,
            Voxels,
            Status,
            Inventory,
            OnSave,
            Chests,
            BlockRecords,
        ]);
        skills.inject(bot);

        // Patch bot.findBlock / bot.findBlocks so stripped_* wood variants are
        // never returned to LLM-generated code. These are player-placed blocks
        // that are never reachable on this server — returning them causes the
        // action agent to loop endlessly trying to mine them.
        const _origFindBlock = bot.findBlock.bind(bot);
        bot.findBlock = function(options) {
            const result = _origFindBlock(options);
            if (result && result.name && result.name.startsWith("stripped_")) {
                return null;
            }
            return result;
        };
        const _origFindBlocks = bot.findBlocks.bind(bot);
        bot.findBlocks = function(options) {
            const results = _origFindBlocks(options);
            if (!results) return results;
            return results.filter((pos) => {
                const b = bot.blockAt(pos);
                return !(b && b.name && b.name.startsWith("stripped_"));
            });
        };

        const _origBlockAt = bot.blockAt.bind(bot);
        bot.blockAt = function(position, extraInfos = true) {
            const block = _origBlockAt(position, extraInfos);
            if (
                block &&
                block.type !== 0 &&
                !block.name &&
                block.boundingBox === "block"
            ) {
                block.name = "unknown_modded_block";
                block.displayName = block.displayName || "Unknown Modded Block";
                if (!Array.isArray(block.shapes) || block.shapes.length === 0) {
                    block.shapes = [[0, 0, 0, 1, 1, 1]];
                }
            }
            return block;
        };

        // NOTE: bot.dig is NOT wrapped with ultimine here.
        // FTB Ultimine key_pressed is sent explicitly from mineBlock.js
        // only when the user intends to vein-mine a specific block type.
        // Wrapping ALL digs caused ultimine to fire during pathfinder
        // navigation digs (dirt, grass, etc.) and mine massive unwanted craters.

        const findSolidSupportBelow = () => {
            if (!bot.entity) return null;
            for (let depth = 0; depth <= 2; depth++) {
                const support = bot.blockAt(bot.entity.position.offset(0, -0.5 - depth, 0));
                if (
                    support &&
                    support.name !== "air" &&
                    support.name !== "water" &&
                    support.name !== "lava" &&
                    support.boundingBox === "block"
                ) {
                    return support;
                }
            }
            return null;
        };

        bot.on("physicsTick", () => {
            try {
                if (!bot.entity || bot.entity.onGround) return;
                if (bot.entity.isInWater || bot.entity.isInLava) return;
                if (bot.entity.velocity.y > 0.01) return;
                const support = findSolidSupportBelow();
                if (!support) return;
                const groundedY = support.position.y + 1;
                if (Math.abs(bot.entity.position.y - groundedY) > 0.2) return;
                bot.entity.onGround = true;
                if (bot.entity.velocity.y < 0) {
                    bot.entity.velocity.y = 0;
                }
            } catch {}
        });

        // a timeout because physicsTick events are delayed during world load.
        // Wrap in a Promise.race so the spawn handler always resolves and the
        // /start HTTP response is sent (otherwise Python hangs in env.reset).
        const safeWaitTicks = async (ticks) => {
            const tickWait = bot.waitForTicks(ticks).catch(() => {});
            const fallback = new Promise((resolve) =>
                setTimeout(resolve, ticks * 50 + 1000)
            );
            await Promise.race([tickWait, fallback]);
        };

        if (req.body.spread) {
            bot.chat(`/spreadplayers ~ ~ 0 300 false @s`);
            await safeWaitTicks(bot.waitTicks);
        }

        await safeWaitTicks(bot.waitTicks * itemTicks);
        await settleOnGround(bot);
        res.json(bot.observe());

        initCounter(bot);
        bot.chat("/gamerule keepInventory true");
        bot.chat("/gamerule doDaylightCycle false");
        // HUMAN-LIKE: no automatic /spreadplayers. Real players walk to find
        // resources. The physics-resync interval handles post-spawn floating.
    });

    // After a teleport / spreadplayers the bot frequently lands on water surface
    // or on top of leaves/air (Forge anti-cheat then kicks "floating too long").
    // settleOnGround raycasts down from the current position to find the first
    // SOLID block, then /tp's the bot onto it. Also dismounts any boat/raft.
    // settleOnGround: after a server-side teleport (/spreadplayers etc.), mineflayer's
    // local `onGround` state is stale. Forcing it to false makes the physics engine
    // emit a Position packet and gravity pulls the bot down naturally — no /tp needed.
    async function settleOnGround(bot) {
        try {
            if (!bot.entity) return;
            const isSolidGround = (block) =>
                !!block &&
                block.name !== "air" &&
                block.name !== "water" &&
                block.name !== "lava" &&
                block.boundingBox === "block";
            // Wait a few ticks for the chunk to load post-teleport.
            await bot.waitForTicks(20).catch(() => {});
            bot.entity.onGround = false;
            bot.entity.velocity.set(0, 0, 0);
            // Wait for the bot to actually land (max 5s).
            for (let i = 0; i < 100; i++) {
                await bot.waitForTicks(1).catch(() => {});
                if (bot.entity.onGround) break;
            }
            let forcedGround = false;
            if (!bot.entity.onGround) {
                for (let depth = 0; depth <= 6; depth++) {
                    const support = bot.blockAt(bot.entity.position.offset(0, -0.5 - depth, 0));
                    if (!isSolidGround(support)) continue;
                    bot.entity.position.set(
                        bot.entity.position.x,
                        support.position.y + 1,
                        bot.entity.position.z
                    );
                    bot.entity.velocity.set(0, 0, 0);
                    bot.entity.onGround = true;
                    forcedGround = true;
                    try {
                        bot._client.write("position", {
                            x: bot.entity.position.x,
                            y: bot.entity.position.y,
                            z: bot.entity.position.z,
                            onGround: true,
                            flags: {
                                onGround: true,
                                hasHorizontalCollision: undefined,
                            },
                        });
                    } catch {}
                    await bot.waitForTicks(2).catch(() => {});
                    break;
                }
            }
            console.log(`[DBG-SETTLE] settled at y=${bot.entity.position.y.toFixed(1)} onGround=${bot.entity.onGround} forced=${forcedGround}`);
        } catch (e) { console.log(`[DBG-SETTLE] err ${e.message}`); }
    }

    function onConnectionFailed(e) {
        console.log(e);
        bot = null;
        res.status(400).json({ error: e });
    }
    function onDisconnect(message) {
        const currentBot = bot;
        if (!currentBot) {
            console.log(message);
            return;
        }
        if (currentBot.viewer) {
            currentBot.viewer.close();
        }
        if (typeof currentBot.end === "function") {
            currentBot.end();
        }
        console.log(message);
        bot = null;
    }
});

// HUMAN-LIKE soft reset: do not disconnect/respawn the bot. Just return a
// fresh observation so the curriculum sees current state. Real players don't
// log out and back in between objectives.
app.post("/observe", (req, res) => {
    try {
        if (!bot || !bot.entity) return res.status(503).json({ error: "no bot" });
        return res.json(bot.observe());
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.post("/step", async (req, res) => {
    // import useful package
    let response_sent = false;
    function otherError(err) {
        console.log("Uncaught Error");
        bot.emit("error", handleError(err));
        bot.waitForTicks(bot.waitTicks).then(() => {
            if (!response_sent) {
                response_sent = true;
                res.json(bot.observe());
            }
        });
    }

    process.on("uncaughtException", otherError);

    const mcData = require("minecraft-data")(bot.version);
    mcData.itemsByName["leather_cap"] = mcData.itemsByName["leather_helmet"];
    mcData.itemsByName["leather_tunic"] =
        mcData.itemsByName["leather_chestplate"];
    mcData.itemsByName["leather_pants"] =
        mcData.itemsByName["leather_leggings"];
    mcData.itemsByName["leather_boots"] = mcData.itemsByName["leather_boots"];
    mcData.itemsByName["lapis_lazuli_ore"] = mcData.itemsByName["lapis_ore"];
    mcData.blocksByName["lapis_lazuli_ore"] = mcData.blocksByName["lapis_ore"];
    const {
        Movements,
        goals: {
            Goal,
            GoalBlock,
            GoalNear,
            GoalXZ,
            GoalNearXZ,
            GoalY,
            GoalGetToBlock,
            GoalLookAtBlock,
            GoalBreakBlock,
            GoalCompositeAny,
            GoalCompositeAll,
            GoalInvert,
            GoalFollow,
            GoalPlaceBlock,
        },
        pathfinder,
        Move,
        ComputedPath,
        PartiallyComputedPath,
        XZCoordinates,
        XYZCoordinates,
        SafeBlock,
        GoalPlaceBlockOptions,
    } = require("mineflayer-pathfinder");
    const { Vec3 } = require("vec3");

    // Set up pathfinder
    const movements = new Movements(bot, mcData);
    movements.canDig = true;
    movements.allow1by1towers = true;
    movements.allowParkour = true;
    movements.allowSprinting = true;
    // Don't voluntarily walk off drops >1 block — avoids crevasses/canyons during
    // normal surface travel.  Underground mining primitives can raise this locally.
    movements.maxDropDown = 1;
    // Don't drop into water holes either.
    movements.infiniteLiquidDropdownDistance = false;
    bot.pathfinder.setMovements(movements);
    // Expose movements so control primitives can temporarily relax limits.
    bot._movements = movements;
    // Default thinkTimeout=5000 ms is too short on this modded Forge server with many extra blocks; bump.
    bot.pathfinder.thinkTimeout = 30000;
    bot.pathfinder.tickTimeout = 100;
    console.log(`[DBG] pathfinder configured thinkTimeout=${bot.pathfinder.thinkTimeout} canDig=${movements.canDig}`);

    // ===== ADVENTUROUS PATHFINDER (cycle 19) =====
    // Real-player philosophy: assume the unknown is safe. Only what has actually
    // hurt us becomes "dangerous", and even then armor/a weapon make us brave again.
    //
    // Why: this is a 119-mod Forge server. Most surrounding blocks are not in
    // mineflayer's `minecraft-data` registry, so the stock `Movements.getBlock`
    // marks them unsafe/non-physical, and pathfinder finds zero walkable
    // neighbors -> bot is glued to spawn forever.

    // Load the modded block knowledge base (cycle 20).
    // Built by extracting `assets/<modid>/blockstates/*.json` from every mod jar
    // in the server's mods folder. ~2700 modded blocks classified into
    // categories: log, leaves, plant, planks, slab, stairs, fence_or_wall, door,
    // interactable, ore, liquid, hazard, decoration, block.
    let MODDED = { blocks: {} };
    try {
        const fs = require("fs");
        const path = require("path");
        const p = path.resolve(__dirname, "../../../ckpt/modded_blocks.json");
        MODDED = JSON.parse(fs.readFileSync(p, "utf8"));
        console.log(`[ADVENTURE] loaded modded block KB: ${Object.keys(MODDED.blocks).length} entries from ${p}`);
    } catch (e) {
        console.log(`[ADVENTURE] modded block KB not found (${e.message}); falling back to name-suffix heuristics only`);
    }
    // name -> categories (lookup by short name OR namespaced "ns:name")
    const _byShortName = {};
    for (const k in MODDED.blocks) {
        const v = MODDED.blocks[k];
        _byShortName[v.name] = v.categories;
        _byShortName[`${v.namespace}:${v.name}`] = v.categories;
    }
    function _categoriesOf(name) {
        if (!name) return [];
        const short = name.replace(/^minecraft:/, "");
        const c = _byShortName[short] || _byShortName[name];
        if (c) return c;
        // Suffix-based fallback for blocks not in KB
        const cats = [];
        if (/_log$|_wood$|_stem$|_hyphae$/.test(short)) cats.push("log");
        if (/_leaves$|_leaf$/.test(short)) cats.push("leaves");
        if (/_sapling$|_seeds$|_bush$|flower|_grass$|_fern$|_sprouts$/.test(short)) cats.push("plant");
        if (/_planks$/.test(short)) cats.push("planks");
        if (/_slab$/.test(short)) cats.push("slab");
        if (/_stairs$/.test(short)) cats.push("stairs");
        if (/_fence$|_fence_gate$|_wall$/.test(short)) cats.push("fence_or_wall");
        if (/_door$|_trapdoor$/.test(short)) cats.push("door");
        if (/_button$|_pressure_plate$|_sign$|lever/.test(short)) cats.push("interactable");
        if (/_ore$/.test(short)) cats.push("ore");
        if (/water|lava|fluid|liquid|brine/.test(short)) cats.push("liquid");
        if (/cobweb|cactus|bamboo_spike|fire_jet|brimstone_fumarole|spike_block|sourceberry_bush|wither_rose|poison/.test(short)) cats.push("hazard");
        return cats;
    }
    bot.moddedBlockInfo = { categoriesOf: _categoriesOf, kb: MODDED };

    // Pre-seed the dangerous set with KB-known hazards (vanilla + modded).
    bot.dangerousBlocks = new Set([
        "lava", "fire", "soul_fire", "magma_block", "cactus", "sweet_berry_bush",
        "wither_rose", "campfire", "soul_campfire", "powder_snow", "cobweb",
    ]);
    for (const k in MODDED.blocks) {
        const v = MODDED.blocks[k];
        if (v.categories.includes("hazard")) bot.dangerousBlocks.add(v.name);
    }
    bot.brushedWithDeath = [];
    bot._lastHealth = 20;
    // LAVA-ALWAYS-DANGEROUS set — these are never safe regardless of equipment.
    const ALWAYS_DANGEROUS = new Set(["lava", "fire", "soul_fire", "magma_block"]);
    function _hasProtection() {
        try {
            const slots = bot.inventory.slots;
            // mineflayer armor slots are 5..8
            for (let i = 5; i <= 8; i++) if (slots[i]) return true;
            // NOTE: pickaxe/axe are NOT counted as protection — having a tool
            // in hand must not make lava or fire look walkable to pathfinder.
            const held = bot.heldItem;
            if (held && /sword|shield|trident|bow|crossbow/i.test(held.name)) return true;
        } catch (_) {}
        return false;
    }
    bot._hasProtection = _hasProtection;
    bot.on("health", () => {
        try {
            if (bot.health < bot._lastHealth) {
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dz = -1; dz <= 1; dz++) {
                            const b = bot.blockAt(bot.entity.position.offset(dx, dy, dz));
                            if (b && b.name && b.name !== "air" && b.name !== "cave_air") {
                                bot.brushedWithDeath.push(b.name);
                            }
                        }
                    }
                }
                if (bot.brushedWithDeath.length > 200) {
                    bot.brushedWithDeath = bot.brushedWithDeath.slice(-100);
                }
            }
            bot._lastHealth = bot.health;
        } catch (_) {}
    });
    bot.on("death", () => {
        try {
            // Save death position so recoverDeathTotem can navigate back.
            if (bot.entity) {
                bot._deathPos = bot.entity.position.clone();
                console.log(`[DEATH] position saved: ${JSON.stringify(bot._deathPos)}`);
            }
            // Promote recent neighbours to permanent dangerous set
            const recent = bot.brushedWithDeath.slice(-20);
            for (const name of recent) {
                if (!bot.dangerousBlocks.has(name)) {
                    console.log(`[ADVENTURE] learned dangerous block: ${name}`);
                    bot.dangerousBlocks.add(name);
                }
            }
            bot.brushedWithDeath = [];
            bot._lastHealth = 20;
        } catch (_) {}
    });

    // Patch Movements.getBlock: unknown -> walkable air (curiosity); known-dangerous
    // blocks (without protection) keep their unsafe flag. Modded blocks get
    // category-based physical/safe inference from the KB.
    if (!Movements.prototype._curiousOriginalGetBlock) {
        Movements.prototype._curiousOriginalGetBlock = Movements.prototype.getBlock;
    }
    if (!Movements.prototype._curiousOriginalSafeToBreak) {
        Movements.prototype._curiousOriginalSafeToBreak = Movements.prototype.safeToBreak;
    }
    const _origGetBlock = Movements.prototype._curiousOriginalGetBlock;
    Movements.prototype.getBlock = function (pos, dx, dy, dz) {
        const Vec3Cls = require("vec3").Vec3;
        const raw = pos ? bot.blockAt(new Vec3Cls(pos.x + dx, pos.y + dy, pos.z + dz), false) : null;
        if (!raw) {
            // Unloaded chunk OR modded block prismarine doesn't know -> assume passable.
            return {
                replaceable: true,
                canFall: false,
                safe: true,
                physical: false,
                liquid: false,
                climbable: false,
                height: pos ? pos.y + dy : dy,
                openable: false,
            };
        }
        const b = _origGetBlock.call(this, pos, dx, dy, dz);
        const cats = _categoriesOf(raw.name);
        // KB-driven inference for blocks prismarine doesn't recognize correctly:
        if (cats.length) {
            if (cats.includes("plant") || cats.includes("leaves") || cats.includes("interactable")) {
                b.safe = true;            // walkable (sapling, flower, grass, sign...)
                b.physical = false;
            } else if (cats.includes("liquid")) {
                b.liquid = true; b.safe = true;
            } else if (cats.includes("log") || cats.includes("planks") || cats.includes("slab") || cats.includes("stairs") || cats.includes("ore") || cats.includes("block")) {
                b.physical = true;        // solid → walk on top of, can stand on
            }
            if (cats.includes("hazard")) b.safe = false;
        } else if (raw.boundingBox === "empty") {
            // Unknown modded block with no KB entry. Treat as physical/solid so
            // pathfinder can stand on Forge-modded platforms (e.g. the spawn
            // structure). Previously this was passable (physical=false), which
            // prevented A* from computing a valid start node when the bot stands
            // on a modded surface the vanilla bounding-box DB doesn't know about.
            b.physical = true;
            b.safe = true;
        }
        // Lava/fire/magma are ALWAYS dangerous — no equipment overrides this.
        if (ALWAYS_DANGEROUS.has(raw.name)) {
            b.safe = false;
            b.liquid = (raw.name === "lava");
        } else if (bot.dangerousBlocks.has(raw.name) && !_hasProtection()) {
            // Other learned dangers respect equipment (e.g. cactus with armour).
            b.safe = false;
        }
        return b;
    };

    // Patch safeToBreak: brave digger. Refuse only if (a) can't dig, (b) block is
    // in the learned-dangerous set without protection, or (c) game says we can't.
    Movements.prototype.safeToBreak = function (block) {
        if (!this.canDig) return false;
        if (block && block.name && bot.dangerousBlocks.has(block.name) && !_hasProtection()) {
            return false;
        }
        return !!(block && block.type) && !this.blocksCantBreak.has(block.type) && this.exclusionBreak(block) < 100;
    };
    console.log(`[ADVENTURE] curious-bot patches installed (dangerousBlocks=${bot.dangerousBlocks.size}, kb=${Object.keys(MODDED.blocks).length})`);
    // ===== END ADVENTUROUS PATHFINDER =====

    bot.globalTickCounter = 0;
    bot.stuckTickCounter = 0;
    bot.idleStuckTickCounter = 0;
    bot.stuckPosList = [];
    bot.idleStuckPosList = [];
    // Counts how many times the unstucker ran out of escape material in this
    // reset cycle without the bot moving free. After 2 failures we use /home.
    bot._noMaterialEscapeFailCount = 0;
    // Escalating obstacle-escape tier: increments each teleportBot() call,
    // resets when the bot makes meaningful progress.
    bot._stuckEscapeAttempts = 0;

    // Issue /sethome once on first spawn so /home always returns to the
    // starting surface area (useful if the bot later falls into a cave).
    if (!bot._homeSet) {
        bot._homeSet = true;
        setTimeout(() => {
            try {
                console.log(`[init] issuing /sethome at y=${bot.entity.position.y.toFixed(1)}`);
                bot.chat('/sethome');
            } catch (_) {}
            // Set FTB Ultimine mode to "shapeless" on first spawn.
            // Architectury multiplexes all mod packets through "architectury:network".
            // Payload = writeUtf(packetId) + packet data.
            // ModeChangedPacket: packetId = "ftbultimine:mode_changed", data = bool next.
            // Default FTB Ultimine mode order: vein_all → vein → shapeless → disabled.
            // Send mode_changed(next=true) 3 times to cycle to "shapeless" from default.
            try {
                const _mRl = Buffer.from('ftbultimine:mode_changed', 'utf8');  // 24 bytes
                const _mBuf = Buffer.concat([Buffer.from([_mRl.length]), _mRl]);
                const _mNext = Buffer.concat([_mBuf, Buffer.from([0x01])]);
                // Send 3 presses with 200 ms gaps to cycle to shapeless mode
                for (let _i = 0; _i < 3; _i++) {
                    setTimeout(() => {
                        try { bot._client.write('custom_payload', { channel: 'architectury:network', data: _mNext }); } catch (_) {}
                    }, 3000 + _i * 200);
                }
                console.log('[init] FTB Ultimine: cycling mode to shapeless (3x mode_changed)');
            } catch (_me) {
                console.log(`[init] FTB Ultimine mode_changed err: ${_me.message || _me}`);
            }
        }, 2000);
    }

    bot._waterEscapeTicks = 0;

    function onTick() {
        bot.globalTickCounter++;

        // ── Water / drowning escape ──────────────────────────────────────────
        // If the bot is submerged in water (not just touching the surface),
        // stop whatever it's doing and swim up immediately.
        try {
            const _head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            const _feet = bot.blockAt(bot.entity.position);
            const _inWater = (_feet && _feet.name === "water") || (_head && _head.name === "water");
            if (_inWater) {
                bot._waterEscapeTicks++;
                // Every 5 ticks (~0.25 s) while underwater: stop pathfinder,
                // jump / swim upward so the bot surfaces as fast as possible.
                if (bot._waterEscapeTicks % 5 === 1) {
                    bot.pathfinder.stop();
                    bot.setControlState("jump", true);
                    bot.setControlState("sneak", false);
                }
                // After 3 s (60 ticks) still underwater — find the nearest dry
                // land and pathfind there.
                if (bot._waterEscapeTicks === 60) {
                    bot.setControlState("jump", false);
                    const _Vec3W = require("vec3").Vec3;
                    // Search horizontally for a dry block to escape to.
                    let _escapeGoal = null;
                    for (let _r = 1; _r <= 10 && !_escapeGoal; _r++) {
                        for (let _dx = -_r; _dx <= _r && !_escapeGoal; _dx++) {
                            for (let _dz = -_r; _dz <= _r && !_escapeGoal; _dz++) {
                                if (Math.abs(_dx) !== _r && Math.abs(_dz) !== _r) continue;
                                for (let _dy = 3; _dy >= -2 && !_escapeGoal; _dy--) {
                                    const _p = bot.entity.position.offset(_dx, _dy, _dz);
                                    const _b = bot.blockAt(_p);
                                    const _above = bot.blockAt(_p.offset(0, 1, 0));
                                    if (_b && _b.solid && _above && _above.name !== "water" && _above.name !== "lava") {
                                        _escapeGoal = new (require("mineflayer-pathfinder").goals.GoalNear)(_p.x, _p.y + 1, _p.z, 1);
                                    }
                                }
                            }
                        }
                    }
                    if (_escapeGoal) {
                        bot.pathfinder.goto(_escapeGoal).catch(() => {});
                    }
                }
                return; // Skip stuck detection while escaping water
            } else {
                if (bot._waterEscapeTicks > 0) {
                    bot.setControlState("jump", false);
                    bot._waterEscapeTicks = 0;
                }
            }
        } catch (_we) {}
        // ── End water escape ─────────────────────────────────────────────────

        if (bot.pathfinder.isMoving()) {
            bot.stuckTickCounter++;
            if (bot.stuckTickCounter >= 100) {
                onStuck(1.5);
                bot.stuckTickCounter = 0;
            }
        } else {
            // Cave/pit self-trap detector: even when pathfinder isn't running
            // (e.g. between mineBlock retries, or while the LLM code is idling
            // after a failed dig), real players can still be stuck in a pit
            // they dug. Sample position every 100 ticks (~5s); after 5 samples
            // (~25s) with <1.5 block of movement, run the escape routine.
            bot.idleStuckTickCounter++;
            if (bot.idleStuckTickCounter >= 100) {
                bot.idleStuckTickCounter = 0;
                const cur = bot.entity.position;
                bot.idleStuckPosList.push(cur);
                if (bot.idleStuckPosList.length >= 5) {
                    const oldest = bot.idleStuckPosList[0];
                    if (cur.distanceTo(oldest) < 1.5) {
                        teleportBot();
                    }
                    bot.idleStuckPosList.shift();
                }
            }
        }
    }

    bot.on("physicTick", onTick);

    // initialize fail count
    let _craftItemFailCount = 0;
    let _killMobFailCount = 0;
    let _mineBlockFailCount = 0;
    let _placeItemFailCount = 0;
    let _smeltItemFailCount = 0;

    // Retrieve array form post bod
    const code = req.body.code;
    const programs = req.body.programs;
    bot.cumulativeObs = [];
    await bot.waitForTicks(bot.waitTicks);
    const r = await evaluateCode(code, programs);
    process.off("uncaughtException", otherError);
    if (r !== "success") {
        bot.emit("error", handleError(r));
    }
    await returnItems();
    // wait for last message
    await bot.waitForTicks(bot.waitTicks);
    if (!response_sent) {
        response_sent = true;
        res.json(bot.observe());
    }
    bot.removeListener("physicTick", onTick);

    async function evaluateCode(code, programs) {
        // Echo the code produced for players to see it. Don't echo when the bot code is already producing dialog or it will double echo
        try {
            // Race task execution against bot death. If the bot dies mid-task,
            // reject immediately so the Python side sees a clean failure and
            // starts a fresh task rather than continuing with a dead/respawned bot.
            const _codePromise = eval("(async () => {" + code + "\n" + programs + "})()");
            const _deathPromise = new Promise((_, reject) => {
                bot.once("death", () => {
                    bot.pathfinder.stop();
                    reject(Object.assign(new Error("Bot died during task — task abandoned"), { _botDied: true }));
                });
            });
            await Promise.race([_codePromise, _deathPromise]);
            // Remove the death listener if code finished cleanly.
            bot.removeAllListeners("_deathAbort");
            return "success";
        } catch (err) {
            return err;
        }
    }

    function onStuck(posThreshold) {
        const currentPos = bot.entity.position;
        bot.stuckPosList.push(currentPos);

        // Check if the list is full
        if (bot.stuckPosList.length === 5) {
            const oldestPos = bot.stuckPosList[0];
            const posDifference = currentPos.distanceTo(oldestPos);

            if (posDifference < posThreshold) {
                teleportBot(); // execute the function
            } else {
                // Bot moved enough — reset all escape counters.
                bot._noMaterialEscapeFailCount = 0;
                bot._stuckEscapeAttempts = 0;
            }

            // Remove the oldest time from the list
            bot.stuckPosList.shift();
        }
    }

    function teleportBot() {
        // HUMAN-LIKE: never use /tp. There is no case where a real Minecraft
        // player is *truly* stuck — you can always jump, dig sideways, or
        // pillar up. This unstucker tries those in escalating order, fire-
        // and-forget (we don't await; onStuck fires every few ticks anyway).
        const Vec3 = require("vec3");
        const dirs = [
            new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
            new Vec3(0, 0, 1), new Vec3(0, 0, -1),
        ];
        const isAir = (b) => b && b.name === "air";
        const isLiquid = (b) => b && (b.name === "water" || b.name === "lava");

        bot._stuckEscapeAttempts = (bot._stuckEscapeAttempts || 0) + 1;
        const _escPhase = bot._stuckEscapeAttempts;
        console.log(`[teleportBot] phase=${_escPhase}`);

        (async () => {
            try {
                const pos = bot.entity.position.floored();

                // ── Phase 1–2: Jump over the obstacle ────────────────────────────
                // A single 1-block-high obstacle is the most common blockage during
                // navigation. Jumping is always the cheapest fix — try it first.
                if (_escPhase <= 2) {
                    if (bot.setControlState) {
                        bot.setControlState("jump", true);
                        // Also step forward so the jump carries us over the lip.
                        bot.setControlState("forward", true);
                        setTimeout(() => {
                            bot.setControlState && bot.setControlState("jump", false);
                            bot.setControlState && bot.setControlState("forward", false);
                        }, 500);
                    }
                    console.log(`[teleportBot] jump attempt ${_escPhase}`);
                    return;
                }

                // ── Phase 3–4: Pillar up (jump + place under feet) ───────────────
                // After 2 failed jumps the obstacle is > 1 block tall. Gain 1–2
                // blocks of height by placing junk blocks under the bot's feet
                // while jumping — enough to hop over most obstacles.
                if (_escPhase <= 4) {
                    // Prefer true junk: dirt/gravel/sand/cobblestone/planks/log.
                    const placeable = bot.inventory.items().find((it) => it && (
                        it.name === "dirt" || it.name === "gravel" || it.name === "sand" ||
                        it.name === "cobblestone" || it.name === "netherrack" ||
                        it.name.endsWith("_planks") || it.name.endsWith("_log") ||
                        it.name === "stone"
                    ));
                    if (placeable) {
                        try {
                            await bot.equip(placeable, "hand");
                            for (let _pi = 0; _pi < 3; _pi++) {
                                bot.setControlState("jump", true);
                                await new Promise((r) => setTimeout(r, 100));
                                const _feet = bot.entity.position.floored();
                                const _ref = bot.blockAt(_feet.offset(0, -1, 0));
                                if (_ref && !isAir(_ref) && !isLiquid(_ref)) {
                                    try { await bot.placeBlock(_ref, new Vec3(0, 1, 0)); } catch { /* timing */ }
                                }
                                await new Promise((r) => setTimeout(r, 200));
                                bot.setControlState("jump", false);
                            }
                            console.log(`[teleportBot] pillar attempt ${_escPhase}`);
                            return;
                        } catch { /* fall through to dig */ }
                    } else {
                        console.log(`[teleportBot] no junk blocks for pillar — skipping to dig`);
                    }
                }

                // ── Phase 5+: Dig the obstacle ───────────────────────────────────
                // Jump and pillar both failed (or no inventory blocks available).
                // Break the solid block(s) blocking progress in any cardinal dir.
                for (const d of dirs) {
                    const at = pos.plus(d);            // foot-level
                    const above = at.offset(0, 1, 0);  // head-level
                    for (const target of [at, above]) {
                        const b = bot.blockAt(target);
                        if (!b || isAir(b) || isLiquid(b)) continue;
                        if (b.name === "bedrock") continue;
                        try {
                            await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
                            await bot.dig(b);
                            console.log(`[teleportBot] dug ${b.name} at ${target}`);
                            return;
                        } catch { /* try next */ }
                    }
                }

                // ── Fallback: random walk + /home ────────────────────────────────
                const safeDirs = dirs.filter((d) => {
                    const ahead = pos.plus(d);
                    const b = bot.blockAt(ahead);
                    return !b || b.name !== "lava";
                });
                const walkDir = safeDirs.length
                    ? safeDirs[Math.floor(Math.random() * safeDirs.length)]
                    : null;
                if (walkDir) {
                    try {
                        const yaw = Math.atan2(-walkDir.x, -walkDir.z);
                        await bot.look(yaw, 0, true);
                        bot.setControlState("forward", true);
                        bot.setControlState("jump", true);
                        setTimeout(() => {
                            bot.setControlState && bot.setControlState("forward", false);
                            bot.setControlState && bot.setControlState("jump", false);
                        }, 2000);
                    } catch { /* fall through */ }
                }

                bot._noMaterialEscapeFailCount = (bot._noMaterialEscapeFailCount || 0) + 1;
                if (bot._noMaterialEscapeFailCount >= 2) {
                    console.log(`[teleportBot] /home fallback after ${bot._noMaterialEscapeFailCount} failed escapes`);
                    bot._noMaterialEscapeFailCount = 0;
                    bot._stuckEscapeAttempts = 0;
                    try { bot.chat("/home"); } catch (_) {}
                }
            } catch (e) {
                console.log(`[teleportBot] escape failed: ${e && e.message}`);
            }
        })();
    }

    function returnItems() {
        // HUMAN-LIKE: real players don't auto-recover placed blocks via
        // /setblock + /give. If the LLM placed a crafting_table or furnace,
        // it should bot.dig() it back if it wants to carry it. Skip the
        // automatic recovery entirely.
        return;
    }

    function handleError(err) {
        let stack = err.stack;
        if (!stack) {
            return err;
        }
        console.log(stack);
        const final_line = stack.split("\n")[1];
        const regex = /<anonymous>:(\d+):\d+\)/;

        // The eval string is now "code\nprograms", so code occupies the
        // first code_length lines and programs follows.
        const code_length = code.split("\n").length;
        const programs_length = programs.split("\n").length;
        let match_line = null;
        for (const line of stack.split("\n")) {
            const match = regex.exec(line);
            if (match) {
                const line_num = parseInt(match[1]);
                if (line_num <= code_length) {
                    match_line = line_num;
                    break;
                }
            }
        }
        if (!match_line) {
            return err.message;
        }
        let f_line = final_line.match(
            /\((?<file>.*):(?<line>\d+):(?<pos>\d+)\)/
        );
        if (f_line && f_line.groups && fs.existsSync(f_line.groups.file)) {
            const { file, line, pos } = f_line.groups;
            const f = fs.readFileSync(file, "utf8").split("\n");
            // let filename = file.match(/(?<=node_modules\\)(.*)/)[1];
            let source = file + `:${line}\n${f[line - 1].trim()}\n `;

            const code_source =
                "at " +
                code.split("\n")[match_line - 1].trim() +
                " in your code";
            return source + err.message + "\n" + code_source;
        } else if (
            f_line &&
            f_line.groups &&
            f_line.groups.file.includes("<anonymous>")
        ) {
            const { file, line, pos } = f_line.groups;
            let source =
                "Your code" +
                `:${match_line}\n${code.split("\n")[match_line - 1].trim()}\n `;
            let code_source = "";
            if (line > code_length) {
                // Error originated inside programs (skills), not the LLM code
                const prog_line = line - code_length;
                source =
                    "In your program code: " +
                    programs.split("\n")[prog_line - 1].trim() +
                    "\n";
                code_source = `at line ${match_line}:${code
                    .split("\n")
                    [match_line - 1].trim()} in your code`;
            }
            return source + err.message + "\n" + code_source;
        }
        return err.message;
    }
});

app.post("/stop", (req, res) => {
    bot.end();
    res.json({
        message: "Bot stopped",
    });
});

app.post("/pause", (req, res) => {
    if (!bot) {
        res.status(400).json({ error: "Bot not spawned" });
        return;
    }
    bot.chat("/pause");
    bot.waitForTicks(bot.waitTicks).then(() => {
        res.json({ message: "Success" });
    });
});

// Server listening to PORT 3000

const DEFAULT_PORT = 3000;
const PORT = process.argv[2] || DEFAULT_PORT;
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
