async function recoverDeathTotem(bot) {
    // Navigate back to the last death position, find the Quark "Totem of
    // Holding" entity (quark:totem) that holds the bot's inventory, attack it
    // until it despawns (releasing all items), then collect the drops.
    // Returns true on success, false if no totem was found or the attempt timed out.
    // bot._deathPos is set automatically by the death event handler.
}
