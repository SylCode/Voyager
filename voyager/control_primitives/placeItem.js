async function placeItem(bot, name, position) {
    // return if name is not string
    if (typeof name !== "string") {
        throw new Error(`name for placeItem must be a string`);
    }
    // return if position is not Vec3
    if (!(position instanceof Vec3)) {
        throw new Error(`position for placeItem must be a Vec3`);
    }
    const itemByName = mcData.itemsByName[name];
    if (!itemByName) {
        throw new Error(`No item named ${name}`);
    }
    const item = bot.inventory.findInventoryItem(itemByName.id);
    if (!item) {
        const message = `No ${name} in inventory`;
        bot.chat(message);
        throw new Error(message);
    }
    const item_count = item.count;
    // find a reference block
    const faceVectors = [
        new Vec3(0, 1, 0),
        new Vec3(0, -1, 0),
        new Vec3(1, 0, 0),
        new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1),
        new Vec3(0, 0, -1),
    ];
    // Reject if target position is already occupied by a solid block.
    // Allow: air, empty-name blocks (unknown modded passthrough), or blocks with empty bounding box.
    const _targetBlock = bot.blockAt(position);
    // Unknown modded blocks (name==='') may be solid on the server — treat them
    // as blocking to avoid attempting placement into occupied modded-block space.
    const _isSolid = _targetBlock && (
        (_targetBlock.name !== 'air' && _targetBlock.boundingBox !== 'empty') ||
        _targetBlock.name === ''
    );
    if (_isSolid) {
        const message = `Cannot place ${name}: target ${position} is occupied by ${_targetBlock.name}.`;
        bot.chat(message);
        _placeItemFailCount++;
        if (_placeItemFailCount > 10) throw new Error(`placeItem failed too many times.`);
        throw new Error(message);
    }
    // Hazardous blocks cannot be used as a reference surface.
    const _HAZARD = new Set(["lava","flowing_lava","water","flowing_water","fire","soul_fire","magma_block","cactus","sweet_berry_bush","wither_rose"]);
    let referenceBlock = null;
    let faceVector = null;
    for (const vector of faceVectors) {
        const block = bot.blockAt(position.minus(vector));
        // Reference block must be solid and not a hazard or leaf.
        // Accept (1) known-solid vanilla blocks (boundingBox==='block') or
        // (2) unknown modded blocks (name==='') — the bot walks on them so the
        // server treats them as solid and will accept block placement on top.
        const _isLeaf = block && (block.name.endsWith('_leaves') || block.name.endsWith('_leaf'));
        if (
            block &&
            !_isLeaf &&
            !_HAZARD.has(block.name) &&
            (block.boundingBox === "block" || block.name === "")
        ) {
            referenceBlock = block;
            faceVector = vector;
            bot.chat(`Placing ${name} on ${block.name} at ${block.position}`);
            break;
        }
    }
    if (!referenceBlock) {
        const message =
            `No block to place ${name} on. You cannot place a floating block.`;
        bot.chat(message);
        _placeItemFailCount++;
        if (_placeItemFailCount > 10) {
            throw new Error(
                `placeItem failed too many times. You cannot place a floating block.`
            );
        }
        throw new Error(message);
    }

    // You must use try catch to placeBlock
    try {
        // Navigate to a position from which we can place the block.
        // GoalPlaceBlock can timeout on complex terrain — fall back to GoalNear.
        try {
            await bot.pathfinder.goto(new GoalPlaceBlock(position, bot.world, {}));
        } catch (navErr) {
            // Fallback: get close to the reference block instead
            await bot.pathfinder.goto(
                new GoalNear(referenceBlock.position.x, referenceBlock.position.y, referenceBlock.position.z, 3)
            );
        }
        // You must equip the item right before calling placeBlock
        await bot.equip(item, "hand");
        await bot.placeBlock(referenceBlock, faceVector);
        // Wait for the blockUpdate event to propagate (Forge servers can be slow)
        await new Promise(r => setTimeout(r, 500));
        // Verify the block actually persists (lava/physics can remove it silently)
        const placedBlock = bot.blockAt(position);
        if (!placedBlock || placedBlock.name === "air" || placedBlock.name === "") {
            throw new Error(`${name} not found at ${position} after placement (found: ${placedBlock?.name || "null"}) — block may have been removed by fluid or physics`);
        }
        if (placedBlock.name !== name) {
            throw new Error(
                `${name} placement resolved to unexpected block ${placedBlock.name} at ${position}`
            );
        }
        bot.chat(`Placed ${name} (block.name=${placedBlock.name} bb=${placedBlock.boundingBox})`);
        bot.save(`${name}_placed`);
    } catch (err) {
        const placedBlock = bot.blockAt(position);
        if (placedBlock && placedBlock.name === name) {
            bot.chat(`Placed ${name} (block.name=${placedBlock.name} bb=${placedBlock.boundingBox})`);
            bot.save(`${name}_placed`);
            return true;
        }
        const remainingItem = bot.inventory.findInventoryItem(itemByName.id);
        if (remainingItem?.count !== item_count) {
            bot.chat(`Placed ${name}`);
            bot.save(`${name}_placed`);
            return true;
        }
        bot.chat(
            `Error placing ${name}: ${err.message}, please find another position to place`
        );
        _placeItemFailCount++;
        if (_placeItemFailCount > 10) {
            throw new Error(
                `placeItem failed too many times, please find another position to place.`
            );
        }
        throw err;
    }
    return true;
}
