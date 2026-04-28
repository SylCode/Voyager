async function givePlacedItemBack(bot, name, position) {
    // NOTE: removed doTileDrops toggle (was causing race that suppressed mining drops globally).
    // Use /setblock ... air (no `destroy`) inside the helper instead.
    const history = [];
    for (let i = 0; i < name.length; i++) {
        await givePlacedItemBackSingle(bot, name[i], position[i]);
    }

    async function givePlacedItemBackSingle(bot, name, position) {
        bot.chat(`/give bot ${name} 1`);
        const x = Math.floor(position.x);
        const y = Math.floor(position.y);
        const z = Math.floor(position.z);
        // loop through 125 blocks around the block
        const size = 3;
        for (let dx = -size; dx <= size; dx++) {
            for (let dy = -size; dy <= size; dy++) {
                for (let dz = -size; dz <= size; dz++) {
                    const block = bot.blockAt(new Vec3(x + dx, y + dy, z + dz));
                    if (
                        block?.name === name &&
                        !history.includes(block.position)
                    ) {
                        await bot.chat(
                            `/setblock ${x + dx} ${y + dy} ${
                                z + dz
                            } air`
                        );
                        history.push(block.position);
                        await bot.waitForTicks(20);
                        return;
                    }
                }
            }
        }
    }
}
