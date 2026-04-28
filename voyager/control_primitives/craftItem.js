// ── Persistent crafting-table memory ────────────────────────────────
// `findBlocks` only scans loaded chunks. After a reconnect the chunks
// where we previously placed tables may not be in memory yet, so we
// would never find them. Persist coordinates to disk and consult that
// list as a fallback.
// NOTE: requires are inlined inside each function to avoid temporal dead zone
// errors when LLM code (which comes first in the eval'd IIFE) calls craftItem
// before the top-level const declarations in programs are initialized.

function _loadCraftingTableMemory() {
    try {
        const _fs_ct = require('fs');
        const _path_ct = require('path');
        const _CT_MEMORY_FILE = _path_ct.resolve(__dirname, '../../ckpt/action/crafting_table_memory.json');
        if (_fs_ct.existsSync(_CT_MEMORY_FILE)) {
            const raw = _fs_ct.readFileSync(_CT_MEMORY_FILE, 'utf8');
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) return arr;
        }
    } catch (e) {
        console.log(`[craftItem] failed to load CT memory: ${e.message}`);
    }
    return [];
}

function _saveCraftingTableMemory(arr) {
    try {
        const _fs_ct = require('fs');
        const _path_ct = require('path');
        const _CT_MEMORY_FILE = _path_ct.resolve(__dirname, '../../ckpt/action/crafting_table_memory.json');
        _fs_ct.mkdirSync(_path_ct.dirname(_CT_MEMORY_FILE), { recursive: true });
        _fs_ct.writeFileSync(_CT_MEMORY_FILE, JSON.stringify(arr, null, 2));
    } catch (e) {
        console.log(`[craftItem] failed to save CT memory: ${e.message}`);
    }
}

function _rememberCraftingTable(pos) {
    if (!pos) return;
    const arr = _loadCraftingTableMemory();
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (!arr.some((p) => `${p.x},${p.y},${p.z}` === key)) {
        arr.push({ x: pos.x, y: pos.y, z: pos.z });
        _saveCraftingTableMemory(arr);
        console.log(`[craftItem] remembered crafting_table at ${key} (total=${arr.length})`);
    }
}

function _forgetCraftingTable(pos) {
    if (!pos) return;
    const arr = _loadCraftingTableMemory();
    const key = `${pos.x},${pos.y},${pos.z}`;
    const filtered = arr.filter((p) => `${p.x},${p.y},${p.z}` !== key);
    if (filtered.length !== arr.length) {
        _saveCraftingTableMemory(filtered);
        console.log(`[craftItem] forgot crafting_table at ${key} (no longer present)`);
    }
}

function _findNearbyCraftingTable(bot, maxDistance = 128) {
    // Search a wide radius — `bot.findBlocks` returns positions sorted by
    // distance from the bot, so the first hit is the closest one in the
    // currently-loaded world.  This is what lets the bot reuse a table it
    // placed earlier instead of spawning a new one for every craft.
    //
    // Match by *name suffix* "crafting_table" so we tolerate any mod
    // namespace prefix (e.g. some mods register the block under their own
    // namespace and the resolved name comes through as `<mod>:crafting_table`).
    const positions = bot.findBlocks({
        matching: (block) => {
            if (!block || !block.name) return false;
            const n = block.name;
            return n === 'crafting_table' || n.endsWith(':crafting_table') || n.endsWith('_crafting_table');
        },
        maxDistance,
        count: 1,
    });
    // Diagnostic: dump any block within 64 blocks whose name *contains*
    // "craft" or "table" or "bench" so we can see what the server is
    // actually calling the table on this Forge modpack. Also try matching
    // by mcData numeric block id which is robust against name remapping.
    try {
        const _nearCraft = bot.findBlocks({
            matching: (block) => {
                if (!block || !block.name) return false;
                const n = block.name.toLowerCase();
                return n.includes('craft') || n.includes('bench') || n.includes('table');
            },
            maxDistance: 64,
            count: 10,
        });
        if (_nearCraft && _nearCraft.length) {
            const names = _nearCraft.map((p) => {
                const b = bot.blockAt(p);
                return `${b && b.name}#${b && b.type}@(${p.x},${p.y},${p.z})d=${p.distanceTo(bot.entity.position).toFixed(1)}`;
            }).join(' | ');
            console.log(`[craftItem] nearby craft/bench/table blocks within 64: ${names}`);
        } else {
            console.log(`[craftItem] no craft/bench/table-named blocks within 64`);
        }
        // Dump ALL unique non-air/non-lava/non-stone block names within 16
        // blocks of the bot so we can see what the modpack actually calls
        // its blocks. This is the only way to find the table when name
        // matching fails on Forge servers with renamed blocks.
        try {
            const _IGNORE = new Set([
                'air','cave_air','void_air',
            ]);
            const _seen = new Map();
            const _bp = bot.entity.position;
            const _bx = Math.floor(_bp.x), _by = Math.floor(_bp.y), _bz = Math.floor(_bp.z);
            console.log(`[craftItem] BOT POS exact=(${_bp.x.toFixed(2)},${_bp.y.toFixed(2)},${_bp.z.toFixed(2)}) onGround=${bot.entity.onGround}`);
            const _Vec3b = require('vec3').Vec3;
            // Dump the 5x5 grid at bot foot level (y) and below (y-1) so we
            // can see exactly what's around and beneath the bot.
            for (const dy of [-1, 0, 1]) {
                const row = [];
                for (let dz = -2; dz <= 2; dz++) {
                    for (let dx = -2; dx <= 2; dx++) {
                        const b = bot.blockAt(new _Vec3b(_bx+dx, _by+dy, _bz+dz));
                        row.push(`${dx},${dy},${dz}=${b && b.name}`);
                    }
                }
                console.log(`[craftItem] CLOSE dy=${dy}: ${row.join(' | ')}`);
            }
            for (let dy = -3; dy <= 4; dy++) {
                for (let dx = -10; dx <= 10; dx++) {
                    for (let dz = -10; dz <= 10; dz++) {
                        const b = bot.blockAt(new _Vec3b(_bx+dx, _by+dy, _bz+dz));
                        if (!b || !b.name || _IGNORE.has(b.name)) continue;
                        if (!_seen.has(b.name)) {
                            _seen.set(b.name, `(${_bx+dx},${_by+dy},${_bz+dz})`);
                        }
                    }
                }
            }
            const _summary = Array.from(_seen.entries()).map(([n,p])=>`${n}@${p}`).join(' | ');
            console.log(`[craftItem] ALL block names within 10 of bot: ${_summary || '(none)'}`);
        } catch (_e3) { console.log(`[craftItem] block dump error: ${_e3.message}`); }
        // Also try by mcData id.
        try {
            const _ctId = mcData.blocksByName.crafting_table && mcData.blocksByName.crafting_table.id;
            if (_ctId !== undefined) {
                const _byId = bot.findBlocks({
                    matching: _ctId,
                    maxDistance: 128,
                    count: 3,
                });
                console.log(`[craftItem] findBlocks by mcData crafting_table id=${_ctId}: ${_byId.length} hits${_byId.length ? ' first=(' + _byId[0].x + ',' + _byId[0].y + ',' + _byId[0].z + ')' : ''}`);
            }
        } catch (_e2) {}
    } catch (_e) {}
    if (!positions || positions.length === 0) {
        console.log(`[craftItem] _findNearbyCraftingTable: NONE within ${maxDistance} blocks of (${bot.entity.position.x.toFixed(0)},${bot.entity.position.y.toFixed(0)},${bot.entity.position.z.toFixed(0)}) — checking persistent memory`);
        // Memory fallback: try to verify any remembered coords whose chunks
        // happen to be loaded right now.  If a remembered table has been
        // destroyed or replaced, drop it from memory.
        const _Vec3 = require('vec3').Vec3;
        const remembered = _loadCraftingTableMemory();
        let bestVerified = null;
        let bestDist = Infinity;
        for (const r of remembered) {
            const v = new _Vec3(r.x, r.y, r.z);
            const blk = bot.blockAt(v);
            if (!blk) continue; // chunk not loaded — can't verify yet
            const isTable = blk.name && (blk.name === 'crafting_table' || blk.name.endsWith(':crafting_table') || blk.name.endsWith('_crafting_table'));
            if (!isTable) {
                _forgetCraftingTable(r);
                continue;
            }
            const d = v.distanceTo(bot.entity.position);
            if (d < bestDist) {
                bestDist = d;
                bestVerified = blk;
            }
        }
        if (bestVerified) {
            console.log(`[craftItem] memory hit verified: ${bestVerified.name} at (${bestVerified.position.x},${bestVerified.position.y},${bestVerified.position.z}) dist=${bestDist.toFixed(1)}`);
            return bestVerified;
        }
        if (remembered.length > 0) {
            console.log(`[craftItem] ${remembered.length} crafting tables remembered but none verifiable in loaded chunks (probably out of view)`);
        }
        return null;
    }
    const blk = bot.blockAt(positions[0]);
    console.log(`[craftItem] _findNearbyCraftingTable: hit name=${blk && blk.name} at (${positions[0].x},${positions[0].y},${positions[0].z}) dist=${positions[0].distanceTo(bot.entity.position).toFixed(1)}`);
    // Opportunistically remember it.
    _rememberCraftingTable(positions[0]);
    return blk;
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
                (target.name !== '' && target.boundingBox === 'empty'));
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
        console.log(`[DBG-CT] dx=${dx} dz=${dz} target=${target?.name}/${target?.boundingBox} ref=${reference?.name}/${reference?.boundingBox} tOpen=${targetOpen} safeRef=${safeReference}`);
        if (targetOpen && safeReference) {
            positions.push(position);
        }
    }

    // --- Additional pass: try placing ONE ABOVE the bot's current position ---
    // This handles the case where the bot is on a narrow modded-block platform
    // surrounded by lava at the reference level.  The modded block at y≈bot.y
    // (which the bot stands on/in due to physicsTick) serves as the reference,
    // and the crafting table goes to y≈bot.y+1 (above the bot's head).
    for (const [dx, dz] of offsets) {
        const position = bot.entity.position.offset(dx, 1, dz);
        const target   = bot.blockAt(position);
        const reference = bot.blockAt(bot.entity.position.offset(dx, 0, dz));
        const targetOpen =
            target &&
            (target.name === 'air' ||
                (target.name !== '' && target.boundingBox === 'empty'));
        const _refIsLeaf = reference && (reference.name.endsWith('_leaves') || reference.name.endsWith('_leaf'));
        const safeReference =
            reference &&
            !_refIsLeaf &&
            !_HAZARD_NAMES.has(reference.name) &&
            (reference.boundingBox === 'block' || reference.name === '');
        if (targetOpen && safeReference) {
            console.log(`[DBG-CT+1] dx=${dx} dz=${dz} ABOVE ref=${reference?.name}/${reference?.boundingBox}`);
            positions.push(position);
        }
    }
    // Also try placing directly above the bot (dx=0,dz=0) using the modded
    // block at the bot's own level as reference.
    {
        const _abovePos = bot.entity.position.offset(0, 1, 0);
        const _aboveTarget = bot.blockAt(_abovePos);
        const _refBlock   = bot.blockAt(bot.entity.position.offset(0, 0, 0));
        const _aboveOpen  = _aboveTarget && (_aboveTarget.name === 'air' || (_aboveTarget.name !== '' && _aboveTarget.boundingBox === 'empty'));
        const _refIsLeaf  = _refBlock && (_refBlock.name.endsWith('_leaves') || _refBlock.name.endsWith('_leaf'));
        const _safeRef    = _refBlock && !_refIsLeaf && !_HAZARD_NAMES.has(_refBlock.name) && (_refBlock.boundingBox === 'block' || _refBlock.name === '');
        if (_aboveOpen && _safeRef) {
            console.log(`[DBG-CT+1] dx=0 dz=0 DIRECTLY-ABOVE ref=${_refBlock?.name}/${_refBlock?.boundingBox}`);
            positions.push(_abovePos);
        }
    }

    return positions;
}

async function _ensureCraftingTableNearby(bot) {
    // ── Reuse logic ────────────────────────────────────────────────
    // Players don't litter the world with crafting tables.  If we already
    // placed one and we're within walking distance of it (≤ 30 blocks),
    // use it instead of plopping another.  Only past 30 blocks is it
    // worth placing a fresh one (and only if we have one in inventory).
    const REUSE_RADIUS = 30;
    const _existing = _findNearbyCraftingTable(bot, 128);
    let craftingTableItem = bot.inventory.findInventoryItem(
        mcData.itemsByName.crafting_table.id
    );
    if (_existing) {
        const _dist = _existing.position.distanceTo(bot.entity.position);
        const _shouldReuse = _dist <= REUSE_RADIUS || !craftingTableItem;
        if (_shouldReuse) {
            console.log(`[craftItem] reusing existing crafting_table at (${_existing.position.x},${_existing.position.y},${_existing.position.z}) dist=${_dist.toFixed(1)}`);
            try {
                const { goals: { GoalNear } } = require('mineflayer-pathfinder');
                const _CT_NAV_MS = 60000;
                await Promise.race([
                    bot.pathfinder.goto(
                        new GoalNear(_existing.position.x, _existing.position.y, _existing.position.z, 2)
                    ),
                    new Promise((_, reject) => setTimeout(
                        () => reject(new Error(`nav to CT timed out after ${_CT_NAV_MS}ms`)),
                        _CT_NAV_MS
                    )),
                ]);
            } catch (_navErr) {
                console.log(`[craftItem] navigate to existing crafting_table failed: ${_navErr && _navErr.message}`);
                try { bot.pathfinder.stop(); } catch (_se) {}
            }
            // Re-resolve in case the block went out of view during nav.
            const _stillThere = _findNearbyCraftingTable(bot, 128);
            if (_stillThere) {
                const _postNavDist = _stillThere.position.distanceTo(bot.entity.position);
                if (_postNavDist <= 5) return _stillThere;
                console.log(`[craftItem] nav to existing CT failed — still ${_postNavDist.toFixed(1)} blocks away; will place fresh table`);
            }
        } else {
            console.log(`[craftItem] existing crafting_table is ${_dist.toFixed(1)} blocks away (> ${REUSE_RADIUS}); placing a fresh one`);
        }
    } else {
        // No table found in loaded chunks. Memory may still know of one
        // whose chunk hasn't loaded yet — walk toward the nearest remembered
        // coord and re-check before placing a fresh table.
        const _remembered = _loadCraftingTableMemory();
        if (_remembered.length > 0) {
            const _Vec3 = require('vec3').Vec3;
            const _bp = bot.entity.position;
            // Pick the nearest remembered coord.
            let nearest = null, nearestDist = Infinity;
            for (const r of _remembered) {
                const v = new _Vec3(r.x, r.y, r.z);
                const d = v.distanceTo(_bp);
                if (d < nearestDist) { nearestDist = d; nearest = v; }
            }
            if (nearest && nearestDist <= REUSE_RADIUS) {
                console.log(`[craftItem] no table in loaded chunks but memory has one at (${nearest.x},${nearest.y},${nearest.z}) dist=${nearestDist.toFixed(1)} — walking to verify`);
                try {
                    const { goals: { GoalNear } } = require('mineflayer-pathfinder');
                    const _MEM_NAV_MS = 30000;
                    await Promise.race([
                        bot.pathfinder.goto(new GoalNear(nearest.x, nearest.y, nearest.z, 2)),
                        new Promise((_, reject) => setTimeout(
                            () => reject(new Error(`nav to remembered CT timed out after ${_MEM_NAV_MS}ms`)),
                            _MEM_NAV_MS
                        )),
                    ]);
                } catch (_navErr) {
                    console.log(`[craftItem] nav to remembered CT failed: ${_navErr && _navErr.message}`);
                    try { bot.pathfinder.stop(); } catch (_se) {}
                }
                const _afterNav = _findNearbyCraftingTable(bot, 128);
                if (_afterNav) {
                    const _afterNavDist = _afterNav.position.distanceTo(bot.entity.position);
                    if (_afterNavDist <= 5) return _afterNav;
                    console.log(`[craftItem] nav to remembered CT failed — still ${_afterNavDist.toFixed(1)} blocks away; placing fresh table`);
                }
                // Nav succeeded but block is gone — _findNearbyCraftingTable
                // already pruned it from memory via the verify pass.
            } else if (nearest) {
                console.log(`[craftItem] nearest remembered CT is ${nearestDist.toFixed(1)} blocks away (> ${REUSE_RADIUS}); placing a fresh one`);
            }
        }
    }
    if (!craftingTableItem) {
        // Fallback: craft a crafting_table from inventory planks/logs.
        // 4 planks → 1 crafting_table uses only the 2×2 player grid (no table needed).
        try {
            const _planks = bot.inventory.items().filter(i => i.name.endsWith('_planks'));
            let _planksCount = _planks.reduce((s, i) => s + i.count, 0);
            // If short on planks, try to convert a log first.
            if (_planksCount < 4) {
                const _logItem = bot.inventory.items().find(
                    i => i.name.endsWith('_log') || i.name.endsWith('_wood')
                );
                if (_logItem) {
                    const _plankName = _logItem.name.replace(/_log$/, '_planks').replace(/_wood$/, '_planks');
                    const _plankData = mcData.itemsByName[_plankName];
                    if (_plankData) {
                        const _plankRecipe = bot.recipesFor(_plankData.id, null, 1, null)[0];
                        if (_plankRecipe) {
                            await bot.craft(_plankRecipe, 1, null);
                            console.log(`[craftItem] crafted ${_plankName} from ${_logItem.name} for CT`);
                            _planksCount = bot.inventory.items()
                                .filter(i => i.name.endsWith('_planks'))
                                .reduce((s, i) => s + i.count, 0);
                        }
                    }
                }
            }
            if (_planksCount >= 4) {
                const _ctId = mcData.itemsByName.crafting_table.id;
                const _ctRecipe = bot.recipesFor(_ctId, null, 1, null)[0];
                if (_ctRecipe) {
                    await bot.craft(_ctRecipe, 1, null);
                    console.log('[craftItem] crafted a crafting_table from planks');
                    craftingTableItem = bot.inventory.findInventoryItem(_ctId);
                }
            }
        } catch (_autoCTErr) {
            console.log(`[craftItem] auto-craft CT failed: ${_autoCTErr && _autoCTErr.message}`);
        }
    }
    if (!craftingTableItem) {
        return null;
    }
    const placementPositions = _findCraftingTablePlacements(bot);
    if (!placementPositions.length) {
        // Bot may be over hazardous terrain (lava, etc.).  Try to navigate to the
        // nearest solid-ground block and retry placement there.
        console.log('[craftItem] no placement spots — searching for solid ground');
        const _CT_HAZARD = new Set(['lava','flowing_lava','water','flowing_water','fire','soul_fire','magma_block']);
        // Only vanilla ground blocks are reliable references — leaf blocks report
        // boundingBox==='block' on this Forge server but are over lava (treetops).
        const _GROUND_NAMES = new Set([
            'stone','cobblestone','granite','diorite','andesite',
            'dirt','grass_block','coarse_dirt','podzol','rooted_dirt',
            'gravel','sand','sandstone','red_sand','red_sandstone',
            'clay','mycelium','snow_block','ice','packed_ice',
            'moss_block','mud','deepslate','tuff','netherrack',
            'soul_sand','soul_soil','basalt','blackstone',
        ]);
        let _navigated = false;
        try {
            // Find closest vanilla ground block that is safe to stand on.
            const _solidGround = bot.findBlock({
                matching: (block) => {
                    if (!block || !block.name) return false;
                    if (_CT_HAZARD.has(block.name)) return false;
                    // Only accept known vanilla ground blocks — NOT leaves or
                    // modded blocks that may be treetops over lava.
                    return _GROUND_NAMES.has(block.name);
                },
                maxDistance: 64,
                count: 1,
            });
            if (_solidGround) {
                const { goals: { GoalNear } } = require('mineflayer-pathfinder');
                const _standY = _solidGround.position.y + 1;
                console.log(`[craftItem] navigating to solid ground (${_solidGround.name}) at (${_solidGround.position.x},${_solidGround.position.y},${_solidGround.position.z})`)
                // Timeout the goto so we don't hang forever when no path exists.
                const _NAV_TIMEOUT_MS = 30000;
                try {
                    await Promise.race([
                        bot.pathfinder.goto(
                            new GoalNear(_solidGround.position.x, _standY, _solidGround.position.z, 2)
                        ),
                        new Promise((_, reject) => setTimeout(
                            () => reject(new Error(`pathfinder timeout after ${_NAV_TIMEOUT_MS}ms`)),
                            _NAV_TIMEOUT_MS
                        )),
                    ]);
                    _navigated = true;
                } catch (_navInner) {
                    console.log(`[craftItem] nav to solid ground aborted: ${_navInner && _navInner.message}`);
                    try { bot.pathfinder.stop(); } catch (_e3) {}
                }
            }
        } catch (_navErr) {
            console.log(`[craftItem] navigate to solid ground failed: ${_navErr && _navErr.message}`);
        }
        const _retryPositions = _navigated ? _findCraftingTablePlacements(bot) : [];
        if (!_retryPositions.length) {
            console.log('[craftItem] no safe spot nearby to place a crafting table.');
            return null;
        }
        // Fall through using retryPositions.
        console.log('[craftItem] placing crafting table for crafting (after nav to solid ground)');
        for (const placementPosition of _retryPositions) {
            try {
                await placeItem(bot, 'crafting_table', placementPosition);
                craftingTable = _findNearbyCraftingTable(bot);
                if (craftingTable) {
                    _rememberCraftingTable(craftingTable.position);
                    return craftingTable;
                }
            } catch (_e) {}
        }
        console.log('[craftItem] no safe spot nearby to place a crafting table.');
        return null;
    }
    console.log('[craftItem] placing crafting table for crafting.');
    for (const placementPosition of placementPositions) {
        try {
            await placeItem(bot, 'crafting_table', placementPosition);
            craftingTable = _findNearbyCraftingTable(bot);
            if (craftingTable) {
                _rememberCraftingTable(craftingTable.position);
                return craftingTable;
            }
        } catch (err) {}
    }
    console.log('[craftItem] no safe spot nearby to place a crafting table.');
    return null;
}

async function craftItem(bot, name, count = 1) {
    // return if name is not string
    if (typeof name !== "string") {
        throw new Error("name for craftItem must be a string");
    }
    // return if count is not number
    if (typeof count !== "number") {
        throw new Error("count for craftItem must be a number");
    }
    const itemByName = mcData.itemsByName[name];
    if (!itemByName) {
        throw new Error(`No item named ${name}`);
    }
    let craftingTable = _findNearbyCraftingTable(bot, 6);
    // The function may return a memory-verified table that is far away.
    // Only treat it as "already at the table" if it's genuinely adjacent.
    if (craftingTable && craftingTable.position.distanceTo(bot.entity.position) > 6) {
        craftingTable = null;
    }
    let recipe = bot.recipesFor(itemByName.id, null, 1, craftingTable)[0];
    const tableRecipes = bot.recipesAll(
        itemByName.id,
        null,
        mcData.blocksByName.crafting_table.id
    );
    if (!recipe && !craftingTable && tableRecipes.length > 0) {
        craftingTable = await _ensureCraftingTableNearby(bot);
        recipe = bot.recipesFor(itemByName.id, null, 1, craftingTable)[0];
    }
    if (!craftingTable) {
        console.log('[craftItem] crafting without a crafting table (2x2 grid)');
    } else {
        try {
            const _LOOK_NAV_MS = 20000;
            await Promise.race([
                bot.pathfinder.goto(new GoalLookAtBlock(craftingTable.position, bot.world)),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error(`nav to look at CT timed out after ${_LOOK_NAV_MS}ms`)),
                    _LOOK_NAV_MS
                )),
            ]);
        } catch (_lookNavErr) {
            console.log(`[craftItem] nav to look at crafting_table failed: ${_lookNavErr && _lookNavErr.message}`);
            try { bot.pathfinder.stop(); } catch (_se) {}
            // Nav failed but bot may already be close enough — look directly at the table.
            try {
                await bot.lookAt(craftingTable.position.offset(0.5, 0.5, 0.5), true);
            } catch (_la) {}
        }
    }
    // If recipe still not found, try auto-converting logs → planks for wooden tools.
    if (!recipe && craftingTable) {
        const _needsPlanks = [
            'wooden_pickaxe','wooden_axe','wooden_shovel','wooden_sword','wooden_hoe',
            'crafting_table','stick',
        ].includes(name) || name.endsWith('_planks');
        if (_needsPlanks) {
            const _inv = bot.inventory.items();
            const _logCounts = {};
            _inv.forEach(i => { if (i && i.name && i.name.endsWith('_log')) _logCounts[i.name] = (_logCounts[i.name] || 0) + i.count; });
            const _bestLog = Object.keys(_logCounts).sort((a, b) => _logCounts[b] - _logCounts[a])[0];
            if (_bestLog) {
                const _plankType = _bestLog.replace('_log', '_planks');
                const _plankId = mcData.itemsByName[_plankType] && mcData.itemsByName[_plankType].id;
                if (_plankId) {
                    // Planks are a 1×1 recipe — no crafting table needed.
                    const _plankRec = bot.recipesFor(_plankId, null, 1, null)[0];
                    if (_plankRec) {
                        const _logQty = _logCounts[_bestLog];
                        console.log(`[craftItem] auto-converting ${_logQty}x ${_bestLog} → ${_plankType} before ${name}`);
                        try { await bot.craft(_plankRec, _logQty, null); } catch (_pe) {
                            console.log(`[craftItem] plank auto-craft failed: ${_pe && _pe.message}`);
                        }
                        recipe = bot.recipesFor(itemByName.id, null, 1, craftingTable)[0];
                        console.log(`[craftItem] recipe after plank conversion: ${recipe ? 'found' : 'still null'}`);
                    }
                }
            }
        }
    }
    // ── Auto-craft sticks if needed for tools/bows/etc. ──────────────────────
    // Many items need sticks as a sub-ingredient. Rather than forcing the LLM
    // to remember to craft sticks first, handle it transparently here.
    if (!recipe) {
        const _toolsNeedingSticks = new Set([
            'iron_pickaxe','iron_axe','iron_shovel','iron_sword','iron_hoe',
            'stone_pickaxe','stone_axe','stone_shovel','stone_sword','stone_hoe',
            'wooden_pickaxe','wooden_axe','wooden_shovel','wooden_sword','wooden_hoe',
            'golden_pickaxe','golden_axe','golden_shovel','golden_sword','golden_hoe',
            'diamond_pickaxe','diamond_axe','diamond_shovel','diamond_sword','diamond_hoe',
            'netherite_pickaxe','netherite_axe','netherite_shovel','netherite_sword','netherite_hoe',
            'bow','crossbow','fishing_rod','ladder','torch','sign',
        ]);
        if (_toolsNeedingSticks.has(name)) {
            const _stickEntry = mcData.itemsByName.stick;
            const _stickId = _stickEntry && _stickEntry.id;
            const _stickCount = _stickId
                ? bot.inventory.items().filter(i => i && i.type === _stickId).reduce((s, i) => s + i.count, 0)
                : 0;
            if (_stickCount < 2 && _stickId) {
                // Try to craft sticks directly (requires planks in inventory)
                const _stickRec = bot.recipesFor(_stickId, null, 1, null)[0];
                if (_stickRec) {
                    console.log(`[craftItem] auto-crafting sticks (have ${_stickCount}) before ${name}`);
                    try {
                        await bot.craft(_stickRec, 1, null);
                        await new Promise(r => setTimeout(r, 200));
                    } catch (_se) {
                        console.log(`[craftItem] stick auto-craft failed (${_se && _se.message}), trying logs→planks→sticks`);
                        // No planks? Try converting a log first.
                        const _logItem2 = bot.inventory.items().find(i => i && i.name && i.name.endsWith('_log'));
                        if (_logItem2) {
                            const _plankType2 = _logItem2.name.replace('_log', '_planks');
                            const _plankId2 = mcData.itemsByName[_plankType2] && mcData.itemsByName[_plankType2].id;
                            const _plankRec2 = _plankId2 && bot.recipesFor(_plankId2, null, 1, null)[0];
                            if (_plankRec2) {
                                try { await bot.craft(_plankRec2, 1, null); await new Promise(r => setTimeout(r, 200)); } catch (_pe2) {}
                            }
                            const _stickRec2 = bot.recipesFor(_stickId, null, 1, null)[0];
                            if (_stickRec2) {
                                try { await bot.craft(_stickRec2, 1, null); await new Promise(r => setTimeout(r, 200)); } catch (_se2) {
                                    console.log(`[craftItem] stick retry also failed: ${_se2 && _se2.message}`);
                                }
                            }
                        }
                    }
                    recipe = bot.recipesFor(itemByName.id, null, 1, craftingTable)[0];
                    console.log(`[craftItem] recipe after stick auto-craft: ${recipe ? 'found' : 'still null'}`);
                }
            }
        }
    }
    if (recipe) {
        // Pre-flight: check for full inventory only for non-stackable outputs (tools, armor).
        // Stackable items (planks, sticks, etc.) are fine because ingredient consumption
        // frees the slot that the output occupies.
        const _freeSlotsBefore = bot.inventory.emptySlotCount();
        if (_freeSlotsBefore === 0) {
            const _outputId = itemByName ? itemByName.id : -1;
            const _canStack = _outputId >= 0 &&
                bot.inventory.items().some(i => i && i.type === _outputId && i.count < 64);
            const _outputStackSize = (_outputId >= 0 && mcData.items && mcData.items[_outputId])
                ? (mcData.items[_outputId].stackSize || 64)
                : 64;
            // Only throw for truly non-stackable outputs that can't fit anywhere.
            if (_outputStackSize === 1 && !_canStack) {
                throw new Error(
                    `craftItem: inventory is full (0 free slots) — deposit items first before crafting ${name}`
                );
            }
        }
        console.log(`[craftItem] can make ${name} (free slots: ${_freeSlotsBefore})`);
        const _beforeCount = bot.inventory.items()
            .filter(i => i && i.name === name)
            .reduce((s, i) => s + i.count, 0);
        try {
            await bot.craft(recipe, count, craftingTable);
            // Small delay: modded servers may send inventory updates slightly after
            // the craft confirmation packet, so we wait before returning to the caller.
            await new Promise(r => setTimeout(r, 300));
            const _afterCount = bot.inventory.items()
                .filter(i => i && i.name === name)
                .reduce((s, i) => s + i.count, 0);
            if (_afterCount <= _beforeCount) {
                throw new Error(
                    `craftItem: recipe ran but ${name} did not appear in inventory (before=${_beforeCount}, after=${_afterCount}). ` +
                    `Inventory may be full — deposit items first.`
                );
            }
            console.log(`[craftItem] did the recipe for ${name} ${count} times (inventory: ${_beforeCount} -> ${_afterCount})`);
        } catch (err) {
            console.log(`[craftItem] cannot do the recipe for ${name} ${count} times: ${err && err.message}`);
            throw err;
        }
    } else {
        failedCraftFeedback(bot, name, itemByName, craftingTable);
        _craftItemFailCount++;
        if (_craftItemFailCount > 10) {
            throw new Error(
                "craftItem failed too many times, check chat log to see what happened"
            );
        }
    }
}
