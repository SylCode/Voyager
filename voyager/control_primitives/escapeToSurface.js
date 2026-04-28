// escapeToSurface: navigate to the surface when the bot is underground / crevice-trapped.
//
// Strategy 1: pathfinder with canDig + allow1by1towers (uses cobblestone/dirt to pillar).
//             Long timeout (45 s) so path-computation has time to plan a tower route.
// Strategy 2: manual pillar-jump — dig ceiling, look down, jump + place scaffold under,
//             rise 1 block per iteration. Works even in 1×1 crevices with no horizontal room.
// Strategy 3: ascending diagonal staircase — for when there is some horizontal space but
//             no scaffold material.
async function escapeToSurface(bot) {
    const mcData = require("minecraft-data")(bot.version);
    const Vec3 = require("vec3");
    const _pf = require("mineflayer-pathfinder");
    const _Movements = _pf.Movements;
    const _GoalNear = _pf.goals.GoalNear;
    const _GoalY = _pf.goals.GoalY;

    const _isAirLike = (b) =>
        !b ||
        b.name === "air" ||
        b.name === "cave_air" ||
        b.name === "void_air" ||
        b.name === "water" ||
        b.name === "flowing_water";

    const _isHazard = (b) =>
        b &&
        (b.name === "lava" ||
            b.name === "flowing_lava" ||
            b.name === "fire" ||
            b.name === "soul_fire");

    const _isSolidDiggable = (b) => {
        if (!b) return false;
        if (_isAirLike(b)) return false;
        if (_isHazard(b)) return false;
        if (b.hardness === null || b.hardness < 0) return false; // bedrock / unbreakable
        return b.boundingBox === "block";
    };

    // Has enough vertical clearance to move freely (≥4 air blocks above).
    const _hasClearance = () => {
        if (!bot.entity) return false;
        for (let dy = 1; dy <= 4; dy++) {
            if (!_isAirLike(bot.blockAt(bot.entity.position.offset(0, dy, 0)))) return false;
        }
        return true;
    };

    if (_hasClearance()) {
        console.log("[escapeToSurface] already has clearance");
        return;
    }

    const _startY = bot.entity.position.y;

    // ── Shared helpers ────────────────────────────────────────────────────────
    const _toolTiers = [
        "diamond_pickaxe", "iron_pickaxe", "stone_pickaxe", "golden_pickaxe", "wooden_pickaxe",
    ];
    const _equipBestPickaxe = async () => {
        for (const tName of _toolTiers) {
            const def = mcData.itemsByName[tName];
            if (!def) continue;
            const found = bot.inventory.findInventoryItem(def.id, null);
            if (found) {
                try {
                    if (!bot.heldItem || bot.heldItem.name !== tName)
                        await bot.equip(found, "hand");
                } catch (_e) {}
                return true;
            }
        }
        return false;
    };

    const _scaffoldNames = [
        "cobblestone", "dirt", "gravel", "andesite", "diorite", "granite",
        "stone", "sand", "netherrack", "cobbled_deepslate",
    ];
    const _getScaffoldItem = () => {
        for (const n of _scaffoldNames) {
            const def = mcData.itemsByName[n];
            if (!def) continue;
            const item = bot.inventory.findInventoryItem(def.id, null);
            if (item && item.count > 0) return item;
        }
        return null;
    };

    await _equipBestPickaxe();

    // ── Strategy 1: pathfinder with tower support ─────────────────────────────
    // scafoldingBlocks defaults to [dirt, cobblestone] in mineflayer-pathfinder.
    // We also add whatever else the bot carries so it can use gravel/andesite etc.
    const _surfaceTargetY = Math.round(bot.entity.position.y) + 60;
    try {
        const _moves = new _Movements(bot, mcData);
        _moves.canDig = true;
        _moves.allow1by1towers = true;
        _moves.allowParkour = false;
        // Augment scaffolding list with all soft blocks in inventory.
        for (const n of _scaffoldNames) {
            const def = mcData.blocksByName[n];
            if (def && !_moves.scafoldingBlocks.includes(def.id)) {
                _moves.scafoldingBlocks.push(def.id);
            }
        }
        bot.pathfinder.setMovements(_moves);
        await Promise.race([
            bot.pathfinder.goto(new _GoalY(_surfaceTargetY)),
            new Promise((_, rej) =>
                setTimeout(() => {
                    bot.pathfinder.setGoal(null);
                    rej(new Error("pathfinder surface timeout"));
                }, 45000)
            ),
        ]);
        if (_hasClearance()) {
            console.log("[escapeToSurface] pathfinder reached surface");
            return;
        }
    } catch (_e) {
        console.log(`[escapeToSurface] pathfinder failed (${_e.message}), trying pillar-jump`);
    }

    if (_hasClearance()) return;

    // ── Strategy 2: manual pillar-jump ───────────────────────────────────────
    // Dig ceiling, look down, jump + place scaffold block under feet, repeat.
    // Works in 1×1 crevices; only needs 1 scaffold block per step.
    console.log("[escapeToSurface] starting pillar-jump");
    const _pillarUp = async () => {
        for (let step = 0; step < 80; step++) {
            if (_hasClearance()) return;
            if (bot.entity.position.y - _startY > 80) return; // safety cap

            await _equipBestPickaxe();
            const pos = bot.entity.position;

            // Dig the 3 ceiling blocks directly above to make a vertical shaft.
            for (let dy = 1; dy <= 3; dy++) {
                const b = bot.blockAt(pos.offset(0, dy, 0));
                if (b && _isSolidDiggable(b)) {
                    try { await bot.dig(b); } catch (_e) {}
                }
            }

            const scaffold = _getScaffoldItem();
            if (scaffold) {
                try {
                    await bot.equip(scaffold, "hand");
                    // Look straight down so we can place on the top face of the floor.
                    await bot.look(bot.entity.yaw, Math.PI / 2);
                    const floorBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0));
                    if (floorBlock && floorBlock.boundingBox === "block") {
                        // Jump first, then place while briefly airborne.
                        bot.setControlState("jump", true);
                        await bot.waitForTicks(2);
                        bot.setControlState("jump", false);
                        try {
                            await bot.placeBlock(floorBlock, new Vec3(0, 1, 0));
                        } catch (_pe) { /* best effort — we still rose from the jump */ }
                        await bot.waitForTicks(8);
                    } else {
                        // No floor reference — just jump-spam (might catch a ledge).
                        bot.setControlState("jump", true);
                        await bot.waitForTicks(4);
                        bot.setControlState("jump", false);
                        await bot.waitForTicks(8);
                    }
                } catch (_e) {
                    console.log(`[escapeToSurface] pillar step ${step} failed: ${_e.message}`);
                    await bot.waitForTicks(5);
                }
            } else {
                // No scaffold — jump-spam; maybe the shaft digs let us catch a ledge.
                bot.setControlState("jump", true);
                await bot.waitForTicks(5);
                bot.setControlState("jump", false);
                await bot.waitForTicks(10);
            }
        }
    };

    await _pillarUp();
    if (_hasClearance()) {
        console.log("[escapeToSurface] pillar-jump reached surface");
        return;
    }

    // ── Strategy 3: ascending diagonal staircase ─────────────────────────────
    // Pick the least-obstructed cardinal direction and dig a 2-high staircase.
    console.log("[escapeToSurface] falling back to staircase");
    const _dirs = [
        { dx: 1, dz: 0, label: "+x" },
        { dx: -1, dz: 0, label: "-x" },
        { dx: 0, dz: 1, label: "+z" },
        { dx: 0, dz: -1, label: "-z" },
    ];
    const _countDiagSolid = (dx, dz, steps = 24) => {
        let count = 0;
        for (let i = 1; i <= steps; i++) {
            const b1 = bot.blockAt(bot.entity.position.offset(dx * i, i, dz * i));
            const b2 = bot.blockAt(bot.entity.position.offset(dx * i, i + 1, dz * i));
            if (_isSolidDiggable(b1)) count++;
            if (_isSolidDiggable(b2)) count++;
            if (_isHazard(b1) || _isHazard(b2)) count += 20;
        }
        return count;
    };
    let _bestDir = _dirs[0];
    let _bestCount = Infinity;
    for (const d of _dirs) {
        const c = _countDiagSolid(d.dx, d.dz);
        if (c < _bestCount) { _bestCount = c; _bestDir = d; }
    }
    console.log(`[escapeToSurface] staircase dir=${_bestDir.label} estimated_solid=${_bestCount}`);
    const { dx, dz } = _bestDir;
    for (let step = 0; step < 80; step++) {
        if (_hasClearance()) {
            console.log(`[escapeToSurface] staircase reached clearance at step ${step}`);
            return;
        }
        await _equipBestPickaxe();
        const pos = bot.entity.position;
        const bFeet = bot.blockAt(pos.offset(dx, 1, dz));
        const bHead = bot.blockAt(pos.offset(dx, 2, dz));
        if (_isHazard(bFeet) || _isHazard(bHead)) {
            console.log(`[escapeToSurface] staircase hazard at step ${step}, aborting`);
            break;
        }
        if (_isSolidDiggable(bFeet)) try { await bot.dig(bFeet); } catch (_e) {}
        if (_isSolidDiggable(bHead)) try { await bot.dig(bHead); } catch (_e) {}
        const bCeil = bot.blockAt(pos.offset(dx, 3, dz));
        if (_isSolidDiggable(bCeil)) try { await bot.dig(bCeil); } catch (_e) {}
        const stepX = Math.round(pos.x) + dx;
        const stepY = Math.round(pos.y) + 1;
        const stepZ = Math.round(pos.z) + dz;
        try {
            const stepMoves = new _Movements(bot, mcData);
            stepMoves.canDig = true;
            stepMoves.allow1by1towers = false;
            bot.pathfinder.setMovements(stepMoves);
            await Promise.race([
                bot.pathfinder.goto(new _GoalNear(stepX, stepY, stepZ, 0)),
                new Promise((_, rej) => setTimeout(() => { bot.pathfinder.setGoal(null); rej(new Error("step timeout")); }, 6000)),
            ]);
        } catch (_e) {
            console.log(`[escapeToSurface] staircase step failed: ${_e.message}`);
            await _equipBestPickaxe();
        }
    }

    if (_hasClearance()) {
        console.log("[escapeToSurface] reached clearance");
    } else {
        console.log("[escapeToSurface] could not escape — manual intervention may be needed");
    }
}
