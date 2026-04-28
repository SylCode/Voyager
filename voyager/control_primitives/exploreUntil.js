// Explore downward for 60 seconds: exploreUntil(bot, new Vec3(0, -1, 0), 60);
async function exploreUntil(
    bot,
    direction,
    maxTime = 60,
    callback = () => {
        return false;
    }
) {
    if (typeof maxTime !== "number") {
        throw new Error("maxTime must be a number");
    }
    if (typeof callback !== "function") {
        throw new Error("callback must be a function");
    }
    const test = callback();
    if (test) {
        bot.chat("Explore success.");
        return Promise.resolve(test);
    }
    if (direction.x === 0 && direction.y === 0 && direction.z === 0) {
        throw new Error("direction cannot be 0, 0, 0");
    }
    if (
        !(
            (direction.x === 0 || direction.x === 1 || direction.x === -1) &&
            (direction.y === 0 || direction.y === 1 || direction.y === -1) &&
            (direction.z === 0 || direction.z === 1 || direction.z === -1)
        )
    ) {
        throw new Error(
            "direction must be a Vec3 only with value of -1, 0 or 1"
        );
    }
    maxTime = Math.min(maxTime, 1200);
    return new Promise((resolve, reject) => {
        const _pf = require("mineflayer-pathfinder");
        const _Movements = _pf.Movements;
        const dx = direction.x;
        const dy = direction.y;
        const dz = direction.z;
        const hazardNames = new Set([
            "lava", "flowing_lava", "fire", "soul_fire", "campfire", "soul_campfire",
            "magma_block", "cactus", "sweet_berry_bush", "wither_rose",
        ]);
        const hasNearbyHazard = (position) => {
            if (!position) return true;
            for (let _dy = -1; _dy <= 1; _dy++) {
                for (let _dx = -2; _dx <= 2; _dx++) {
                    for (let _dz = -2; _dz <= 2; _dz++) {
                        const block = bot.blockAt(position.offset(_dx, _dy, _dz));
                        if (block && hazardNames.has(block.name)) return true;
                    }
                }
            }
            return false;
        };
        const previousMovements = bot.pathfinder.movements;
        let horizontalMovements = null;
        if (dy === 0) {
            const softNames = new Set([
                "dirt",
                "grass_block",
                "sand",
                "gravel",
                "snow",
                "snow_block",
                "clay",
                "farmland",
                "dirt_path",
                "podzol",
                "mycelium",
                "coarse_dirt",
                "rooted_dirt",
                "moss_block",
                "mud",
                "grass",
                "tall_grass",
                "fern",
                "large_fern",
                "vine",
            ]);
            horizontalMovements = new _Movements(bot, mcData);
            horizontalMovements.canDig = true;
            horizontalMovements.allow1by1towers = false;
            horizontalMovements.allowParkour = false;
            horizontalMovements.maxDropDown = 1;
            horizontalMovements.infiniteLiquidDropdownDistance = false;
            horizontalMovements.scafoldingBlocks = [];
            horizontalMovements.blocksCantBreak = new Set();
            for (const name in mcData.blocksByName) {
                const id = mcData.blocksByName[name].id;
                const isLeaves = name.endsWith("_leaves") || name.endsWith("_leaf");
                if (!softNames.has(name) && !isLeaves) {
                    horizontalMovements.blocksCantBreak.add(id);
                }
            }
            horizontalMovements.blocksToAvoid = new Set([
                ...(horizontalMovements.blocksToAvoid || []),
                ...["lava", "flowing_lava", "fire", "soul_fire", "campfire", "soul_campfire", "magma_block"]
                    .map((name) => mcData.blocksByName[name] && mcData.blocksByName[name].id)
                    .filter((id) => typeof id === "number"),
            ]);
            bot.pathfinder.setMovements(horizontalMovements);
        }

        let explorationInterval;
        let maxTimeTimeout;
        let lastProgressAt = Date.now();
        let lastPosition = bot.entity.position.clone();
        const replanIdleMs = 6000;
        const progressDistance = 0.5;

        const cleanUp = () => {
            clearInterval(explorationInterval);
            clearTimeout(maxTimeTimeout);
            bot.pathfinder.setGoal(null);
            if (previousMovements) bot.pathfinder.setMovements(previousMovements);
        };

        const explore = () => {
            if (bot.entity.position.distanceTo(lastPosition) >= progressDistance) {
                lastPosition = bot.entity.position.clone();
                lastProgressAt = Date.now();
            }
            if (bot.pathfinder.goal && Date.now() - lastProgressAt < replanIdleMs) {
                try {
                    const result = callback();
                    if (result) {
                        cleanUp();
                        bot.chat("Explore success.");
                        resolve(result);
                    }
                } catch (err) {
                    cleanUp();
                    reject(err);
                }
                return;
            }
            const x =
                bot.entity.position.x +
                Math.floor(Math.random() * 20 + 10) * dx;
            const y =
                bot.entity.position.y +
                Math.floor(Math.random() * 20 + 10) * dy;
            const z =
                bot.entity.position.z +
                Math.floor(Math.random() * 20 + 10) * dz;
            let goal = new GoalNear(x, y, z, 1);
            if (dy === 0) {
                const origin = bot.entity.position.floored();
                const candidates = bot.findBlocks({
                    matching: (block) => {
                        return !!(
                            block &&
                            block.boundingBox === "block" &&
                            !hazardNames.has(block.name)
                        );
                    },
                    maxDistance: 48,
                    count: 512,
                }).map((pos) => bot.blockAt(pos)).filter((block) => {
                    if (!block || !block.position) return false;
                    const relX = block.position.x - origin.x;
                    const relZ = block.position.z - origin.z;
                    if (Math.abs(relX) + Math.abs(relZ) < 8) return false;
                    if (dx !== 0 && Math.sign(relX) !== dx) return false;
                    if (dz !== 0 && Math.sign(relZ) !== dz) return false;
                    if (Math.abs(block.position.y - origin.y) > 8) return false;
                    const above = bot.blockAt(block.position.offset(0, 1, 0));
                    const above2 = bot.blockAt(block.position.offset(0, 2, 0));
                    const headroom1 = !above || above.boundingBox === "empty";
                    const headroom2 = !above2 || above2.boundingBox === "empty";
                    if (!headroom1 || !headroom2) return false;
                    return !hasNearbyHazard(block.position.offset(0, 1, 0));
                }).sort((a, b) => {
                    const aDist = a.position.distanceTo(bot.entity.position);
                    const bDist = b.position.distanceTo(bot.entity.position);
                    return aDist - bDist;
                });
                const destination = candidates[0];
                if (destination) {
                    goal = new GoalNear(
                        destination.position.x,
                        destination.position.y + 1,
                        destination.position.z,
                        1
                    );
                } else {
                    goal = new GoalNear(x, bot.entity.position.y, z, 1);
                }
            }
            if (horizontalMovements) bot.pathfinder.setMovements(horizontalMovements);
            bot.pathfinder.setGoal(goal);

            try {
                const result = callback();
                if (result) {
                    cleanUp();
                    bot.chat("Explore success.");
                    resolve(result);
                }
            } catch (err) {
                cleanUp();
                reject(err);
            }
        };

        explorationInterval = setInterval(explore, 2000);
        explore();

        maxTimeTimeout = setTimeout(() => {
            cleanUp();
            bot.chat("Max exploration time reached");
            resolve(null);
        }, maxTime * 1000);
    });
}
