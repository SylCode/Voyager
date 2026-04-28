// recoverDeathTotem(bot)
// Navigate to the saved death position, find the Quark "Totem of Holding"
// entity (quark:totem), attack it until it despawns, then collect dropped items.
// Returns true if recovery succeeded, false if no totem was found.
async function recoverDeathTotem(bot) {
    const Vec3 = require("vec3").Vec3;
    const { goals: { GoalNear } } = require("mineflayer-pathfinder");
    const pathfinder = bot.pathfinder;

    // ── 1. Require a saved death position ───────────────────────────────────
    if (!bot._deathPos) {
        bot.chat("No death position saved – nothing to recover.");
        return false;
    }
    const deathPos = bot._deathPos;
    bot.chat(`Heading to death site at ${Math.round(deathPos.x)} ${Math.round(deathPos.y)} ${Math.round(deathPos.z)} to recover totem.`);

    // ── 2. Navigate to death position ───────────────────────────────────────
    await pathfinder.goto(new GoalNear(deathPos.x, deathPos.y, deathPos.z, 4));

    // ── 3. Find the Quark totem entity ──────────────────────────────────────
    function findTotem() {
        return Object.values(bot.entities).find(e => {
            if (!e || !e.position) return false;
            // Quark registers the entity as "quark:totem"; mineflayer exposes
            // it via e.name or e.entityType (modded entities often lack .name).
            const nameMatch =
                (e.name && (e.name.toLowerCase().includes("totem") || e.name === "quark:totem")) ||
                (e.entityType && String(e.entityType).toLowerCase().includes("totem"));
            if (!nameMatch) return false;
            return e.position.distanceTo(deathPos) < 32;
        });
    }

    // Wait up to 10 s for the totem to appear (server may take a tick to spawn it)
    let totem = null;
    for (let i = 0; i < 20; i++) {
        totem = findTotem();
        if (totem) break;
        await bot.waitForTicks(10);
    }

    if (!totem) {
        bot.chat("No totem of holding found at death site.");
        bot._deathPos = null;
        return false;
    }

    bot.chat("Found totem of holding – attacking to recover items.");

    // ── 4. Attack the totem until it despawns ───────────────────────────────
    // Quark's totem releases its items and removes itself after taking enough
    // hits.  We keep attacking until the entity is gone (isValid === false or
    // it disappears from bot.entities), with a 30-second hard timeout.
    const startTime = Date.now();
    const TIMEOUT_MS = 30_000;

    while (Date.now() - startTime < TIMEOUT_MS) {
        totem = findTotem();
        if (!totem || !totem.isValid) break;

        // Move close enough to hit (melee range ~2 blocks)
        const dist = bot.entity.position.distanceTo(totem.position);
        if (dist > 3) {
            await pathfinder.goto(new GoalNear(totem.position.x, totem.position.y, totem.position.z, 2));
        }

        bot.lookAt(totem.position.offset(0, totem.height / 2, 0));
        await bot.waitForTicks(2);
        bot.attack(totem);
        await bot.waitForTicks(6); // ~0.3 s between attacks
    }

    if (findTotem()) {
        bot.chat("Totem did not despawn within timeout – giving up.");
        bot._deathPos = null;
        return false;
    }

    bot.chat("Totem despawned – collecting dropped items.");

    // ── 5. Collect item drops ────────────────────────────────────────────────
    // Wait a moment for items to fall, then collect anything nearby.
    await bot.waitForTicks(20);

    const itemEntities = Object.values(bot.entities).filter(e => {
        return e.type === "object" && e.objectType === "Item" &&
               e.position.distanceTo(deathPos) < 10;
    });

    for (const item of itemEntities) {
        if (bot.entity.position.distanceTo(item.position) > 2) {
            try {
                await pathfinder.goto(new GoalNear(item.position.x, item.position.y, item.position.z, 1));
            } catch (_) {}
        }
        await bot.waitForTicks(5);
    }

    bot.chat("Item recovery complete.");
    bot._deathPos = null;
    return true;
}
