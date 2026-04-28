// Craft 8 oak_planks from 2 oak_log (do the recipe 2 times): craftItem(bot, "oak_planks", 2);
// IMPORTANT: craftItem(bot, "crafting_table", 1) only crafts the table item into inventory.
// It does NOT place the table in the world. For 3x3 recipes, craftItem(bot, <recipe>, 1)
// reuses a nearby placed table and, if needed, tries to place a carried crafting_table first.
// IMPORTANT: craftItem throws if the inventory is full (0 free slots) and the output cannot
// stack into an existing slot. Always ensure bot.inventory.emptySlotCount() > 0 before calling
// craftItem for items you don't already have. If you get an inventory-full error, you must
// deposit items first — do NOT retry the craft in a loop without freeing space.
function _findNearbyCraftingTable(bot) {
    return bot.findBlock({
        matching: (block) => block && block.name === 'crafting_table',
        maxDistance: 64,
    });
}

function _findCraftingTablePlacements(bot) {
    const offsets = [];
    for (let radius = 1; radius <= 3; radius++) {
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                if (dx === 0 && dz === 0) {
                    continue;
                }
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) {
                    continue;
                }
                offsets.push([dx, dz]);
            }
        }
    }
    const _HAZARD_NAMES = new Set(['lava','flowing_lava','water','flowing_water','fire','soul_fire','magma_block']);
    const positions = [];
    for (const [dx, dz] of offsets) {
        const position = bot.entity.position.offset(dx, 0, dz);
        const target = bot.blockAt(position);
        const reference = bot.blockAt(bot.entity.position.offset(dx, -1, dz));
        const targetOpen =
            target &&
            (target.name === 'air' ||
                target.name === '' ||
                target.boundingBox === 'empty');
        const _refIsLeaf = reference && (reference.name.endsWith('_leaves') || reference.name.endsWith('_leaf'));
        // Accept (1) known-solid vanilla blocks (boundingBox==='block') or
        // (2) unknown modded blocks (name==='') which the pathfinder treats as
        // physical — the bot walks on them, so the server will accept block
        // placement on top of them. Exclude hazards and leaves explicitly.
        const safeReference =
            reference &&
            !_refIsLeaf &&
            !_HAZARD_NAMES.has(reference.name) &&
            (reference.boundingBox === 'block' || reference.name === '');
        if (targetOpen && safeReference) {
            positions.push(position);
        }
    }
    return positions;
}

async function _ensureCraftingTableNearby(bot) {
    let craftingTable = _findNearbyCraftingTable(bot);
    if (craftingTable) {
        return craftingTable;
    }
    const craftingTableItem = bot.inventory.findInventoryItem(
        mcData.itemsByName.crafting_table.id
    );
    if (!craftingTableItem) {
        return null;
    }
    const placementPositions = _findCraftingTablePlacements(bot);
    if (!placementPositions.length) {
        return null;
    }
    for (const placementPosition of placementPositions) {
        try {
            await placeItem(bot, 'crafting_table', placementPosition);
            craftingTable = _findNearbyCraftingTable(bot);
            if (craftingTable) {
                return craftingTable;
            }
        } catch (err) {}
    }
    return null;
}

async function craftItem(bot, name, count = 1) {
    const item = mcData.itemsByName[name];
    let craftingTable = _findNearbyCraftingTable(bot);
    let recipe = bot.recipesFor(item.id, null, 1, craftingTable)[0];
    const tableRecipes = bot.recipesAll(
        item.id,
        null,
        mcData.blocksByName.crafting_table.id
    );
    if (!recipe && !craftingTable && tableRecipes.length > 0) {
        craftingTable = await _ensureCraftingTableNearby(bot);
        recipe = bot.recipesFor(item.id, null, 1, craftingTable)[0];
    }
    if (craftingTable) {
        await bot.pathfinder.goto(
            new GoalLookAtBlock(craftingTable.position, bot.world)
        );
    }
    await bot.craft(recipe, count, craftingTable);
}
