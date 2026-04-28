// Soil-type blocks that should NOT trigger FTB Ultimine (shapeless vein-mine).
// Ultimine on soil causes massive unwanted terrain destruction.
const _SOIL_BLOCKS = new Set([
    "dirt", "grass_block", "coarse_dirt", "rooted_dirt", "mud",
    "podzol", "mycelium", "farmland", "dirt_path",
    "gravel", "sand", "red_sand", "suspicious_sand", "suspicious_gravel",
    "clay", "soul_sand", "soul_soil",
]);

async function mineBlock(bot, name, count = 1) {
    // return if name is not string
    if (typeof name !== "string") {
        throw new Error(`name for mineBlock must be a string`);
    }
    if (typeof count !== "number") {
        throw new Error(`count for mineBlock must be a number`);
    }
    const blockByName = mcData.blocksByName[name];
    if (!blockByName) {
        throw new Error(`No block named ${name}`);
    }
    const blocks = bot.findBlocks({
        matching: [blockByName.id],
        maxDistance: 32,
        count: 1024,
    });
    if (blocks.length === 0) {
        bot.chat(`No ${name} nearby, please explore first`);
        _mineBlockFailCount++;
        if (_mineBlockFailCount > 10) {
            throw new Error(
                "mineBlock failed too many times, make sure you explore before calling mineBlock"
            );
        }
        return;
    }
    const targets = [];
    for (let i = 0; i < blocks.length; i++) {
        targets.push(bot.blockAt(blocks[i]));
    }

    // FTB Ultimine: for non-soil blocks, hold the Ultimine key while digging one
    // block — the server-side mod mines the entire connected group.
    // Soil blocks use the standard collectBlock path to avoid terrain craters.
    if (!_SOIL_BLOCKS.has(name)) {
        const _ultRl = Buffer.from('ftbultimine:key_pressed', 'utf8'); // 23 bytes
        const _ultRlBuf = Buffer.concat([Buffer.from([_ultRl.length]), _ultRl]);
        const _ultPress   = Buffer.concat([_ultRlBuf, Buffer.from([0x01])]);
        const _ultRelease = Buffer.concat([_ultRlBuf, Buffer.from([0x00])]);

        // Architectury multiplexes all mod packets through "architectury:network".
        try { bot._client.write('custom_payload', { channel: 'architectury:network', data: _ultPress }); }
        catch (_pe) { console.log(`[mineBlock] ultimine press err: ${_pe.message || _pe}`); }

        // Dig the first target block — Ultimine propagates to the full vein/tree.
        try {
            const _bl = targets[0];
            if (_bl) await bot.dig(_bl, true);
        } catch (_de) {
            console.log(`[mineBlock] ultimine dig err: ${_de && _de.message ? _de.message : _de}`);
        }

        // Release the Ultimine key.
        try { bot._client.write('custom_payload', { channel: 'architectury:network', data: _ultRelease }); }
        catch (_) {}

        // Wait for server to process all block breaks and spawn item drops.
        await new Promise((r) => setTimeout(r, 1200));

        // Walk to nearby item entities so mineflayer's auto-pickup collects them.
        try {
            const _pf = require("mineflayer-pathfinder");
            const _GoalNear = _pf.goals.GoalNear;
            const _base = targets[0].position;
            const _nearItems = Object.values(bot.entities).filter(e =>
                e && e.name === 'item' && e.position &&
                Math.abs(e.position.x - _base.x) < 32 &&
                Math.abs(e.position.y - _base.y) < 16 &&
                Math.abs(e.position.z - _base.z) < 32
            );
            const _sorted = _nearItems
                .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
                .slice(0, 20);
            for (const _e of _sorted) {
                if (!_e || !_e.position || !_e.isValid) continue;
                await Promise.race([
                    bot.pathfinder.goto(new _GoalNear(Math.floor(_e.position.x), Math.floor(_e.position.y), Math.floor(_e.position.z), 1)),
                    new Promise((_, _r) => setTimeout(() => _r(new Error("item-goto")), 3000)),
                ]).catch(() => {});
                await new Promise(r => setTimeout(r, 150));
            }
        } catch (_se) { /* best-effort item pickup */ }
    } else {
        // Standard path for soil/terrain blocks.
        await bot.collectBlock.collect(targets, {
            ignoreNoPath: true,
            count: count,
        });
    }

    bot.save(`${name}_mined`);
}
