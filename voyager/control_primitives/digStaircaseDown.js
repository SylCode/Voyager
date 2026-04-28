// digStaircaseDown: dig a 3-block-tall descending staircase so the bot can
// safely reach underground ore levels and walk back up on the same path.
//
// Each "step" digs 3 blocks in the travel direction (head+2, head+1, head)
// and the block at floor-1 level ahead, then moves the bot forward-down 1.
// The resulting staircase is walkable going both down and back up.
//
// direction: 'north' | 'south' | 'east' | 'west'
//   Defaults to the direction of target, or 'north' if omitted.
// targetY: stop digging when bot.entity.position.y <= targetY
//          (optional; if omitted, digs exactly `steps` steps)
//
// Usage:
//   await digStaircaseDown(bot, 10);                   // 10 steps north
//   await digStaircaseDown(bot, 10, 'east');           // 10 steps east
//   await digStaircaseDown(bot, 30, 'north', -30);     // dig until y ≤ -30
async function digStaircaseDown(bot, steps, direction = 'north', targetY = null) {
    const mcData = require("minecraft-data")(bot.version);
    const Vec3 = require("vec3");
    const _pf = require("mineflayer-pathfinder");
    const _Movements = _pf.Movements;
    const _GoalNear = _pf.goals.GoalNear;

    const _dirVecMap = {
        north: new Vec3(0, 0, -1),
        south: new Vec3(0, 0, 1),
        east:  new Vec3(1, 0, 0),
        west:  new Vec3(-1, 0, 0),
    };
    const _dir = _dirVecMap[direction] || _dirVecMap.north;

    const _isAirLike = (b) => !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air';
    const _isDiggable = (b) => b && b.name !== 'air' && b.diggable && b.hardness !== null && b.hardness >= 0;

    // Equip best available pickaxe for faster digging
    const _pickaxeTiers = [
        'netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe',
        'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe',
    ];
    const _equip = async () => {
        for (const tool of _pickaxeTiers) {
            const item = bot.inventory.items().find(i => i && i.name === tool);
            if (item) {
                await bot.equip(item, 'hand');
                return;
            }
        }
    };
    await _equip();

    const _digSafe = async (block) => {
        if (!_isDiggable(block)) return;
        try {
            await bot.dig(block);
        } catch (_e) {
            // ignore individual dig errors (already air, unbreakable, etc.)
        }
    };

    for (let step = 0; step < steps; step++) {
        // Stop early if we reached the target depth
        if (targetY !== null && bot.entity.position.y <= targetY) {
            bot.chat(`[staircase] reached target depth y=${bot.entity.position.y.toFixed(1)}`);
            break;
        }

        const pos = bot.entity.position.floored();
        const dx = _dir.x;
        const dz = _dir.z;

        // Dig 3-tall corridor in the travel direction (above head down to floor)
        // Then dig the floor-level ahead and one below to make the step
        //
        //   Current: bot stands at pos (feet=pos, head=pos+1)
        //   Ahead:   [pos+dir+2]  <- top clearance
        //            [pos+dir+1]  <- head height
        //            [pos+dir+0]  <- foot height
        //            [pos+dir-1]  <- new floor (dig this to enable the step-down)
        const blocksToDigOrder = [
            bot.blockAt(pos.offset(dx, 2, dz)),   // head+2 clearance
            bot.blockAt(pos.offset(dx, 1, dz)),   // head level
            bot.blockAt(pos.offset(dx, 0, dz)),   // foot level
            bot.blockAt(pos.offset(dx, -1, dz)),  // new floor (creates the downward step)
        ];

        for (const b of blocksToDigOrder) {
            if (b && !_isAirLike(b)) {
                await _digSafe(b);
            }
        }

        // Navigate to the new step position (one block forward and one lower)
        const stepTarget = pos.offset(dx, -1, dz);
        const _moves = new _Movements(bot, mcData);
        _moves.canDig = true;
        _moves.allowParkour = false;
        _moves.maxDropDown = 2;
        _moves.allow1by1towers = false;
        bot.pathfinder.setMovements(_moves);

        try {
            await Promise.race([
                bot.pathfinder.goto(new _GoalNear(
                    stepTarget.x, stepTarget.y, stepTarget.z, 1
                )),
                new Promise((_, rej) => setTimeout(() => {
                    bot.pathfinder.setGoal(null);
                    rej(new Error('step move timeout'));
                }, 6000)),
            ]);
        } catch (_e) {
            // If pathfinder fails, try a brief manual forward+down
            bot.setControlState('forward', true);
            bot.setControlState('sneak', false);
            await new Promise(r => setTimeout(r, 400));
            bot.setControlState('forward', false);
        }
    }

    bot.chat(
        `[staircase] dug ${steps}-step staircase (${direction}), now at y=${bot.entity.position.y.toFixed(1)}`
    );
}
