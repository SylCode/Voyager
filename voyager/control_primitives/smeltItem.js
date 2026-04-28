async function smeltItem(bot, itemName, fuelName, count = 1) {
    // return if itemName or fuelName is not string
    if (typeof itemName !== "string" || typeof fuelName !== "string") {
        throw new Error("itemName or fuelName for smeltItem must be a string");
    }
    // return if count is not a number
    if (typeof count !== "number") {
        throw new Error("count for smeltItem must be a number");
    }
    const item = mcData.itemsByName[itemName];
    const fuel = mcData.itemsByName[fuelName];
    if (!item) {
        throw new Error(`No item named ${itemName}`);
    }
    if (!fuel) {
        throw new Error(`No item named ${fuelName}`);
    }
    const furnaceBlock = bot.findBlock({
        matching: mcData.blocksByName.furnace.id,
        maxDistance: 32,
    });
    if (!furnaceBlock) {
        throw new Error("No furnace nearby");
    }
    // Navigate to the furnace. If pathfinding fails (e.g. bot is underground / cave-trapped),
    // attempt to escape to the surface first and then retry navigation.
    const _navToFurnace = async () => {
        await bot.pathfinder.goto(
            new GoalLookAtBlock(furnaceBlock.position, bot.world)
        );
    };
    try {
        await Promise.race([
            _navToFurnace(),
            new Promise((_, rej) =>
                setTimeout(() => rej(new Error("furnace nav timeout")), 20000)
            ),
        ]);
    } catch (_navErr) {
        bot.chat(`Warning: could not path to furnace (${_navErr.message}), trying to escape cave first`);
        try {
            await escapeToSurface(bot);
        } catch (_escErr) {
            bot.chat(`Warning: escapeToSurface failed: ${_escErr.message}`);
        }
        // Re-locate furnace after potentially moving
        const _furnaceRetry = bot.findBlock({
            matching: mcData.blocksByName.furnace.id,
            maxDistance: 48,
        });
        if (!_furnaceRetry) {
            throw new Error("No furnace found after cave escape");
        }
        await bot.pathfinder.goto(
            new GoalLookAtBlock(_furnaceRetry.position, bot.world)
        );
    }
    const furnace = await bot.openFurnace(furnaceBlock);
    let success_count = 0;
    for (let i = 0; i < count; i++) {
        if (!bot.inventory.findInventoryItem(item.id, null)) {
            bot.chat(`No ${itemName} to smelt in inventory`);
            break;
        }
        if (furnace.fuelSeconds < 15 && furnace.fuelItem()?.name !== fuelName) {
            if (!bot.inventory.findInventoryItem(fuel.id, null)) {
                bot.chat(`No ${fuelName} as fuel in inventory`);
                break;
            }
            await furnace.putFuel(fuel.id, null, 1);
            await bot.waitForTicks(20);
            if (!furnace.fuel && furnace.fuelItem()?.name !== fuelName) {
                throw new Error(`${fuelName} is not a valid fuel`);
            }
        }
        await furnace.putInput(item.id, null, 1);
        await bot.waitForTicks(12 * 20);
        if (!furnace.outputItem()) {
            throw new Error(`${itemName} is not a valid input`);
        }
        await furnace.takeOutput();
        success_count++;
    }
    furnace.close();
    if (success_count > 0) {
        bot.chat(`Smelted ${success_count} ${itemName}.`);
    } else {
        bot.chat(
            `Failed to smelt ${itemName}, please check the fuel and input.`
        );
        _smeltItemFailCount++;
        if (_smeltItemFailCount > 10) {
            throw new Error(
                `smeltItem failed too many times, please check the fuel and input.`
            );
        }
    }
    // Return the actual smelted count so callers can verify success directly
    // without using an inventory delta (which breaks when chest deposit or
    // other inventory changes happen concurrently during the smelt window).
    return success_count;
}
