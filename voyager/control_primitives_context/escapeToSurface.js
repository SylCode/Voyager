/*
escapeToSurface: navigate from underground / a crevice to the surface.
Call this when the bot is stuck underground and cannot pathfind to goals.

Strategy 1: pathfinder with digging + towering (uses cobblestone/dirt in inventory).
Strategy 2 (crevice fallback): manual pillar-jump — digs ceiling, places scaffold under
            feet while jumping, rising 1 block per step. Works even in 1×1 crevices.
Strategy 3: ascending diagonal staircase (when there is horizontal room).

// Basic usage:
await escapeToSurface(bot);

// Pattern: escape before any surface-dependent task
await escapeToSurface(bot);
await smeltItem(bot, "raw_iron", "coal", 4);

// Pattern: escape before crafting or furnace access
await escapeToSurface(bot);
await craftItem(bot, "iron_chestplate", 1);
*/
async function escapeToSurface(bot) {
    // Implementation is in control_primitives/escapeToSurface.js
    // No return value. Does nothing if the bot already has ≥4 blocks of clearance above.
}
