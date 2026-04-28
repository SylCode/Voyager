// Mine 3 cobblestone: mineBlock(bot, "stone", 3);
// Mine 5 logs (any species): mineBlock(bot, "wood", 5);
// Mine a specific species: mineBlock(bot, "dark_oak_log", 1);
// When mining underground ore (coal_ore, iron_ore, etc.) that is more than
// 4 blocks below the current position, ALWAYS dig a staircase first so you
// can walk back up: await digStaircaseDown(bot, steps, direction, targetY)
// Example: await digStaircaseDown(bot, 20, 'north', -20); // reach y=-20
//          await mineBlock(bot, 'coal_ore', 10);
// IMPORTANT: mineBlock automatically uses FTB Ultimine for trees and ore veins.
// It will fell the entire tree (all connected logs) in a single swing when you
// mine any log. NEVER write your own dig loop — always call mineBlock so that
// Ultimine fires correctly. Do NOT call bot.dig() or bot.collectBlock.collect()
// directly for wood/log tasks; mineBlock handles positioning, axe equipping,
// Ultimine key press, and drop collection automatically.
async function mineBlock(bot, name, count = 1) {
    // This function is implemented in mineBlock.js (primitive).
    // Signature: mineBlock(bot, name, count)
    // - name: block type string e.g. "wood", "oak_log", "coal_ore", "stone"
    // - count: how many to mine (Ultimine may mine more than count in one swing)
    // Returns when count items of the requested type are in inventory.
    // Throws if no reachable block exists or inventory gain is zero.
}
