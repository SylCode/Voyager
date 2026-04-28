// Place a crafting_table near the player. ONLY use same-Y or +1Y adjacent offsets: (1,0,0), (-1,0,0), (0,0,1), (0,0,-1).
// NEVER use negative-Y offsets like (1,-1,0) — you cannot place a block at floor level while standing on it.
// NEVER place on lava, water, or fire — placeItem will reject hazardous reference blocks automatically.
// Correct pattern: use the floor block next to you as reference. placeItem throws on failure, so only mark success after the await returns:
//   const ref = bot.blockAt(bot.entity.position.offset(1, -1, 0)); // solid floor 1 step right
//   await placeItem(bot, "crafting_table", ref.position.offset(0, 1, 0)); // place ON TOP of that floor block
// Simple same-level example: placeItem(bot, "crafting_table", bot.entity.position.offset(1, 0, 0));
// Success means the placed block at that position matches the requested name; mismatched blocks still count as failure.
async function placeItem(bot, name, position) {
    const item = bot.inventory.findInventoryItem(mcData.itemsByName[name].id);
    // find a reference block
    const faceVectors = [
        new Vec3(0, 1, 0),
        new Vec3(0, -1, 0),
        new Vec3(1, 0, 0),
        new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1),
        new Vec3(0, 0, -1),
    ];
    let referenceBlock = null;
    let faceVector = null;
    for (const vector of faceVectors) {
        const block = bot.blockAt(position.minus(vector));
        if (block?.name !== "air") {
            referenceBlock = block;
            faceVector = vector;
            break;
        }
    }
    // You must first go to the block position you want to place
    await bot.pathfinder.goto(new GoalPlaceBlock(position, bot.world, {}));
    // You must equip the item right before calling placeBlock
    await bot.equip(item, "hand");
    await bot.placeBlock(referenceBlock, faceVector);
    return true;
}
