async function mineBlock(bot, name, count = 1) {
    // return if name is not string
    if (typeof name !== "string") {
        throw new Error(`name for mineBlock must be a string`);
    }
    if (typeof count !== "number") {
        throw new Error(`count for mineBlock must be a number`);
    }
    // Hard-reject stripped_* wood — these are player-processed blocks placed
    // in inaccessible spots on this server. Never reachable, always stall.
    if (/^stripped_/.test(name)) {
        throw new Error(
            `mineBlock: '${name}' is a stripped wood variant — these are placed blocks ` +
            `that are not reachable on this server. Mine a natural log instead ` +
            `(e.g. oak_log, jungle_log, acacia_log, dark_oak_log).`
        );
    }
    // Generic wood/log aliases — the curriculum normalizes species-specific
    // log tasks (e.g. "Mine 1 birch_log") to the generic "Mine N wood log"
    // so we don't strand the bot in a biome that lacks that species. For the
    // generic path, match true log-like blocks only. Decorative all-bark
    // *_wood blocks around spawn are usually supports/protected builds and
    // are the main source of fake-positive wood targets on this server.
    const _isGenericWood = /^(wood|log|wood[\s_]?log|wood_block|any_log|any_wood)$/i.test(name);
    let blockByName = null;
    let _matching = null;
    if (_isGenericWood) {
        // Match live block names instead of mcData IDs so modded logs such as
        // pine_log/fir_log/redwood_log are eligible too.
        _matching = (block) => {
            return !!(
                block &&
                block.name &&
                /(_log|_wood|_stem|_hyphae)$/.test(block.name) &&
                !block.name.startsWith("stripped_")
            );
        };
        blockByName = mcData.blocksByName.oak_log || mcData.blocksByName.birch_log || null;
    } else {
        blockByName = mcData.blocksByName[name];
        _matching = blockByName
            ? (block) => block && block.type === blockByName.id
            : (block) => block && block.name === name;
    }
    const _isWoodyTargetName = _isGenericWood || /(_log|_wood|_stem|_hyphae)$/.test(name);
    if (_isWoodyTargetName) {
        const _held = bot.heldItem ? `${bot.heldItem.name}x${bot.heldItem.count || 1}` : "<empty>";
        console.log(`[DBG-MB] start name=${name} count=${count} held=${_held} pos=(${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)})`);
    }
    const _naturalGroundNames = new Set([
        "dirt", "grass_block", "coarse_dirt", "rooted_dirt", "podzol",
        "mycelium", "moss_block", "mud", "sand", "red_sand", "snow_block",
        "gravel", "clay",
    ]);
    const _surfaceGatherTargetName = _isWoodyTargetName || _naturalGroundNames.has(name);
    const _decorativeMarkerRe = /(_wool|_sign|_banner|_carpet|_fence|_fence_gate|_wall|_button|_pressure_plate|_torch|_lantern)$/;
    const _hazardNames = new Set([
        "lava", "flowing_lava", "fire", "soul_fire", "campfire", "soul_campfire",
        "magma_block", "cactus", "sweet_berry_bush", "wither_rose",
    ]);
    const _isDecorativeMarkerName = (blockName) => {
        return !!(
            blockName && (
                _decorativeMarkerRe.test(blockName) ||
                blockName === "note_block" ||
                blockName === "jukebox" ||
                blockName === "pink_wool" ||
                blockName === "white_wool" ||
                blockName === "orange_wool" ||
                blockName === "yellow_wool" ||
                blockName === "lime_wool" ||
                blockName === "red_wool"
            )
        );
    };
    const _decorativeScoreAt = (position) => {
        if (!position) return 0;
        let _score = 0;
        for (let _dy = -1; _dy <= 2; _dy++) {
            for (let _dx = -4; _dx <= 4; _dx++) {
                for (let _dz = -4; _dz <= 4; _dz++) {
                    const _block = bot.blockAt(position.offset(_dx, _dy, _dz));
                    if (!_block || !_block.name) continue;
                    if (_hazardNames.has(_block.name)) _score += 3;
                    if (_isDecorativeMarkerName(_block.name)) _score += 2;
                    if (/^[a-z_]+_wood$/.test(_block.name) && !_block.name.startsWith("stripped_")) _score += 1;
                }
            }
        }
        return _score;
    };
    const _moveOutOfDecorativeSpawn = async () => {
        if (!_surfaceGatherTargetName) return;
        const _inventoryItems = bot.inventory.items();
        const _hasProgressionItems = _inventoryItems.some((item) => {
            return item && item.name && /(_log|_wood|_planks|stick|crafting_table|_pickaxe|_axe)$/.test(item.name);
        });
        if (_hasProgressionItems && !_isWoodyTargetName) return;
        const _here = bot.entity.position.floored();
        const _hereScore = _decorativeScoreAt(_here);
        if (_hereScore < 8) return;
        const _pf = require("mineflayer-pathfinder");
        const _Movements = _pf.Movements;
        const _GoalNear = _pf.goals.GoalNear;
        const _candidates = bot.findBlocks({
            matching: (block) => block && _naturalGroundNames.has(block.name),
            maxDistance: 64,
            count: 512,
        }).map((pos) => bot.blockAt(pos)).filter((block) => {
            return !!(
                block &&
                block.position &&
                block.position.y >= bot.entity.position.y - 2 &&
                block.position.distanceTo(bot.entity.position) >= 6
            );
        }).sort((a, b) => {
            const _aScore = _decorativeScoreAt(a.position);
            const _bScore = _decorativeScoreAt(b.position);
            if (_aScore !== _bScore) return _aScore - _bScore;
            return a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position);
        });
        const _targetScore = Math.max(2, _hereScore - 4);
        const _destination = _candidates.find((block) => _decorativeScoreAt(block.position) <= _targetScore) || _candidates[0];
        if (!_destination) return;
        if (_decorativeScoreAt(_destination.position) >= _hereScore) return;
        const _prevMovements = bot.pathfinder.movements;
        let _decorSpawnTimeoutHandle;
        try {
            const _moves = new _Movements(bot, mcData);
            _moves.canDig = true;
            _moves.allowParkour = true;
            _moves.maxDropDown = 4;
            _moves.allow1by1towers = false; // no inventory check needed for spawn-exit
            bot.pathfinder.setMovements(_moves);
            await Promise.race([
                bot.pathfinder.goto(new _GoalNear(_destination.position.x, _destination.position.y, _destination.position.z, 1)),
                new Promise((_, _rej) => {
                    _decorSpawnTimeoutHandle = setTimeout(() => {
                        bot.pathfinder.setGoal(null);
                        _rej(new Error("GoalNear timed out"));
                    }, 15000);
                }),
            ]);
        } catch (_e) {
            // Best effort only; if we fail to leave the decorative spawn area,
            // the ordinary reachability/inventory checks below will surface it.
        } finally {
            if (_decorSpawnTimeoutHandle !== undefined) clearTimeout(_decorSpawnTimeoutHandle);
            if (_prevMovements) bot.pathfinder.setMovements(_prevMovements);
            else {
                const _moves = new _Movements(bot, mcData);
                bot.pathfinder.setMovements(_moves);
            }
        }
    };
    await _moveOutOfDecorativeSpawn();

    // ── Water-pit escape ────────────────────────────────────────────────────
    // Strategy:
    //   1. Swim to the water surface (hold jump for a few seconds)
    //   2. Once at surface, find the nearest solid dry block reachable by
    //      digging soil/dirt/sand — always available in a soil pit
    //   3. If the bot has any pickaxe, also allow digging stone — meaning it
    //      can escape ANY pit, not just soft-soil ones
    //   4. If pathfinder still can't plan a route, dig a vertical shaft upward
    //      block by block to escape manually
    if (bot.entity && (bot.entity.isInWater || bot.entity.isInLava)) {
        console.log(`[DBG-MB] water-pit escape: bot in liquid at y=${bot.entity.position.y.toFixed(1)}`);
        try {
            // ── Step 1: Swim up to the water surface ───────────────────────
            bot.setControlState('jump', true);
            const _swimStart = Date.now();
            while (bot.entity.isInWater && Date.now() - _swimStart < 5000) {
                await new Promise(r => setTimeout(r, 200));
            }
            bot.setControlState('jump', false);
            console.log(`[DBG-MB] water-pit escape: after swim, inWater=${bot.entity.isInWater} y=${bot.entity.position.y.toFixed(1)}`);

            // ── Step 2: Dig upward through any solid blocks above head ─────
            // This handles cases where the water surface is capped by soil.
            for (let _up = 0; _up < 6; _up++) {
                const _overhead = bot.blockAt(bot.entity.position.offset(0, 1, 0));
                if (!_overhead || _overhead.name === 'air' || _overhead.name === 'water') break;
                if (_overhead.diggable) {
                    console.log(`[DBG-MB] water-pit escape: digging overhead ${_overhead.name}`);
                    await bot.dig(_overhead).catch(() => {});
                    bot.setControlState('jump', true);
                    await new Promise(r => setTimeout(r, 400));
                    bot.setControlState('jump', false);
                } else {
                    break;
                }
            }

            // ── Step 3: Pathfind to nearest dry surface, digging walls ─────
            const _wpfMod = require("mineflayer-pathfinder");
            const _wpMoves = new _wpfMod.Movements(bot, mcData);
            _wpMoves.canDig = true;
            _wpMoves.allowParkour = false;
            _wpMoves.maxDropDown = 1;
            // Only tower if bot has blocks — without blocks the pathfinder plans
            // tower paths that silently fail, stalling the escape for 25 seconds.
            const _wpScaffNames = ['dirt','coarse_dirt','sand','gravel','cobblestone','stone','netherrack','blackstone'];
            const _wpScaffIDs = _wpScaffNames.map(n => mcData.blocksByName[n] && mcData.blocksByName[n].id).filter(id => typeof id === 'number' && bot.inventory.items().some(it => it && it.type === id && it.count > 0));
            _wpMoves.allow1by1towers = _wpScaffIDs.length > 0;
            _wpMoves.scafoldingBlocks = _wpScaffIDs;

            // What we can dig depends on tools available
            const _wpInv = bot.inventory.items();
            const _wpHasPickaxe = _wpInv.some(i => i && i.name && i.name.endsWith('_pickaxe'));
            const _wpHasShovel   = _wpInv.some(i => i && i.name && i.name.endsWith('_shovel'));
            const _wpDiggable = new Set([
                // Always: soft ground
                "dirt", "grass_block", "coarse_dirt", "rooted_dirt", "podzol",
                "mycelium", "moss_block", "mud", "sand", "red_sand", "gravel",
                "clay", "snow", "snow_block", "farmland",
                ...Object.keys(mcData.blocksByName).filter(n => n.endsWith("_leaves") || n.endsWith("_leaf")),
            ]);
            if (_wpHasPickaxe) {
                // Pickaxe = can escape any pit, including stone/cobblestone walls
                for (const _sn of ["stone", "cobblestone", "deepslate", "cobbled_deepslate",
                                    "granite", "diorite", "andesite", "sandstone", "netherrack",
                                    "tuff", "calcite", "dripstone_block"]) {
                    _wpDiggable.add(_sn);
                }
            }
            _wpMoves.blocksCantBreak = new Set();
            for (const _bn in mcData.blocksByName) {
                if (!_wpDiggable.has(_bn)) _wpMoves.blocksCantBreak.add(mcData.blocksByName[_bn].id);
            }

            // Find nearest dry walkable surface block at or above bot y
            const _wpDryBlocks = bot.findBlocks({
                matching: (block) => {
                    if (!block || !block.name || !block.position) return false;
                    if (block.name === 'air' || block.name === 'water' || block.name === 'lava') return false;
                    if (block.boundingBox !== 'block') return false;
                    try {
                        const _ab1 = bot.blockAt(block.position.offset(0, 1, 0));
                        const _ab2 = bot.blockAt(block.position.offset(0, 2, 0));
                        return (!_ab1 || _ab1.boundingBox === 'empty' || _ab1.name === 'air') &&
                               (!_ab2 || _ab2.boundingBox === 'empty' || _ab2.name === 'air');
                    } catch (_e) { return false; }
                },
                maxDistance: 32,
                count: 128,
            }).map(pos => bot.blockAt(pos))
              .filter(b => b && b.position && b.position.y >= bot.entity.position.y - 1)
              .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));

            if (_wpDryBlocks.length > 0) {
                const _wpT = _wpDryBlocks[0];
                console.log(`[DBG-MB] water-pit escape: pathfinding to ${_wpT.name}@(${_wpT.position.x},${_wpT.position.y},${_wpT.position.z}) hasPickaxe=${_wpHasPickaxe}`);
                bot.pathfinder.setMovements(_wpMoves);
                await Promise.race([
                    bot.pathfinder.goto(new _wpfMod.goals.GoalNear(_wpT.position.x, _wpT.position.y + 1, _wpT.position.z, 1)),
                    new Promise((_, _rj) => setTimeout(() => { bot.pathfinder.setGoal(null); _rj(new Error("water-escape pf timeout")); }, 25000)),
                ]);
                console.log(`[DBG-MB] water-pit escape: reached dry surface y=${bot.entity.position.y.toFixed(1)}`);
            } else {
                // ── Step 4: No surface found — dig a vertical exit shaft ───
                // Dig straight up through whatever is there, then jump each step
                console.log(`[DBG-MB] water-pit escape: no surface found, digging exit shaft`);
                for (let _s = 0; _s < 12; _s++) {
                    if (!bot.entity.isInWater) break;
                    // Dig the block at head level (offset +1) if solid
                    const _blk = bot.blockAt(bot.entity.position.offset(0, 1, 0));
                    if (_blk && _blk.name !== 'air' && _blk.name !== 'water' && _blk.diggable) {
                        await bot.dig(_blk).catch(() => {});
                    }
                    bot.setControlState('jump', true);
                    await new Promise(r => setTimeout(r, 500));
                    bot.setControlState('jump', false);
                    await new Promise(r => setTimeout(r, 100));
                }
            }
        } catch (_wpErr) {
            console.log(`[DBG-MB] water-pit escape failed: ${_wpErr && _wpErr.message}`);
        } finally {
            bot.setControlState('jump', false);
        }
        console.log(`[DBG-MB] water-pit escape done: inWater=${bot.entity.isInWater} y=${bot.entity.position.y.toFixed(1)}`);
    }
    // ── End water-pit escape ────────────────────────────────────────────────

    // ── Dry-pit / crevice escape ─────────────────────────────────────────────
    // If the bot is below nearby terrain (natural crevice, ravine, terrain dip,
    // or a hole left by prior digging), escape BEFORE mining anything.
    // Water pits are handled above; this catches all DRY holes.
    // Three strategies in order:
    //   A. Tower up using inventory solid blocks (fastest for deep pits)
    //   B. Dig a 1×2 staircase through soft walls (cardinal direction scan)
    //   C. Pathfinder with canDig + inventory-dynamic scaffolding
    const _escapePit = async () => {
        if (!bot.entity) return;
        if (bot.entity.isInWater || bot.entity.isInLava) return;
        const _epBotPos = bot.entity.position.clone();
        const _epBotFloorY = Math.floor(_epBotPos.y);
        // Detect: is solid walkable terrain HIGHER than the bot within 4 XZ blocks?
        let _epHighY = _epBotFloorY;
        for (let _dx = -4; _dx <= 4; _dx++) {
            for (let _dz = -4; _dz <= 4; _dz++) {
                if (_dx === 0 && _dz === 0) continue;
                for (let _dy = 1; _dy <= 6; _dy++) {
                    const _sb = bot.blockAt(_epBotPos.offset(_dx, _dy, _dz));
                    if (!_sb || _sb.boundingBox !== 'block') continue;
                    if (_sb.name === 'water' || _sb.name === 'lava') continue;
                    const _a1 = bot.blockAt(_epBotPos.offset(_dx, _dy + 1, _dz));
                    const _a2 = bot.blockAt(_epBotPos.offset(_dx, _dy + 2, _dz));
                    if ((!_a1 || _a1.boundingBox === 'empty') && (!_a2 || _a2.boundingBox === 'empty')) {
                        _epHighY = Math.max(_epHighY, _epBotFloorY + _dy);
                    }
                }
            }
        }
        const _epDepth = _epHighY - _epBotFloorY;
        if (_epDepth < 2) return; // not in a significant pit
        console.log(`[DBG-MB] pit-escape: depth=${_epDepth} botY=${_epBotFloorY} terrainY=${_epHighY}`);
        // Solid placeable block names valid for towers
        const _epSolidNames = [
            'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'moss_block', 'mud',
            'sand', 'red_sand', 'gravel', 'clay',
            'cobblestone', 'stone', 'granite', 'diorite', 'andesite', 'tuff', 'deepslate',
            'netherrack', 'blackstone', 'cobbled_deepslate',
            'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
            'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
            'crimson_planks', 'warped_planks',
        ];
        const _epGetScaffoldIDs = () => _epSolidNames
            .map(n => mcData.blocksByName[n] && mcData.blocksByName[n].id)
            .filter(id => typeof id === 'number' && bot.inventory.items().some(it => it && it.type === id && it.count > 0));
        // Soft block set for staircase digging + pathfinder
        const _epSoftNames = new Set([
            'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
            'moss_block', 'mud', 'sand', 'red_sand', 'gravel', 'clay', 'snow', 'snow_block',
            'farmland', 'dirt_path',
        ]);
        const _epHasPickaxe = bot.inventory.items().some(i => i && i.name && i.name.endsWith('_pickaxe'));
        if (_epHasPickaxe) {
            for (const _s of ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'granite', 'diorite', 'andesite', 'sandstone', 'tuff']) {
                _epSoftNames.add(_s);
            }
        }
        // ── Method A: Tower up with inventory blocks ──────────────────────
        const _epTowerName = _epSolidNames.find(n => {
            const _b = mcData.blocksByName[n];
            return _b && bot.inventory.items().some(it => it && it.type === _b.id && it.count > 0);
        });
        if (_epTowerName && _epDepth <= 5) {
            console.log(`[DBG-MB] pit-escape method-A tower with ${_epTowerName} depth=${_epDepth}`);
            let _epTowerOk = false;
            for (let _s = 0; _s < _epDepth + 2; _s++) {
                try {
                    const _epFloor = bot.blockAt(bot.entity.position.offset(0, -1, 0));
                    if (_epFloor && _epFloor.boundingBox === 'block') {
                        const _epItemDef = mcData.itemsByName[_epTowerName];
                        if (_epItemDef) {
                            const _epInvItem = bot.inventory.findInventoryItem(_epItemDef.id, null);
                            if (_epInvItem) {
                                await bot.equip(_epInvItem, 'hand');
                                const _epFaceVec = _epFloor.position.offset(0, 1, 0).minus(_epFloor.position);
                                await bot.placeBlock(_epFloor, _epFaceVec).catch(() => {});
                            }
                        }
                    }
                    bot.setControlState('jump', true);
                    await new Promise(r => setTimeout(r, 700));
                    bot.setControlState('jump', false);
                    await new Promise(r => setTimeout(r, 150));
                    if (Math.floor(bot.entity.position.y) >= _epHighY) { _epTowerOk = true; break; }
                } catch (_te) {
                    console.log(`[DBG-MB] pit-escape method-A step error: ${_te && _te.message}`);
                    break;
                }
            }
            bot.setControlState('jump', false);
            if (_epTowerOk) {
                console.log(`[DBG-MB] pit-escape method-A success y=${bot.entity.position.y.toFixed(1)}`);
                return;
            }
        }
        // ── Method B: Dig 1×2 staircase through soft walls ───────────────
        // Scan all four cardinal directions for a column where both the
        // feet-level and head-level blocks are either air or soft-diggable,
        // and there is standing room above them. Dig then sprint-jump out.
        for (const [_dx, _dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const _w0 = bot.blockAt(_epBotPos.offset(_dx, 0, _dz));
            const _w1 = bot.blockAt(_epBotPos.offset(_dx, 1, _dz));
            const _w2 = bot.blockAt(_epBotPos.offset(_dx, 2, _dz));
            if (!_w0 || !_w1) continue;
            const _w0ok = _w0.name === 'air' || _epSoftNames.has(_w0.name);
            const _w1ok = _w1.name === 'air' || _epSoftNames.has(_w1.name);
            const _w2open = !_w2 || _w2.name === 'air' || _w2.boundingBox === 'empty';
            if (!_w0ok || !_w1ok || !_w2open) continue;
            console.log(`[DBG-MB] pit-escape method-B staircase dir=(${_dx},0,${_dz}) w0=${_w0.name} w1=${_w1.name}`);
            try {
                if (_w0.name !== 'air' && _w0.diggable) await bot.dig(_w0).catch(() => {});
                if (_w1.name !== 'air' && _w1.diggable) await bot.dig(_w1).catch(() => {});
                const _epLookTarget = bot.entity.position.offset(_dx * 2, 0, _dz * 2);
                await bot.lookAt(_epLookTarget, true).catch(() => {});
                bot.setControlState('forward', true);
                bot.setControlState('jump', true);
                await new Promise(r => setTimeout(r, 900));
                bot.setControlState('forward', false);
                bot.setControlState('jump', false);
                await new Promise(r => setTimeout(r, 250));
                // Continue jumping out if still below terrain level
                for (let _jup = 0; _jup < _epDepth; _jup++) {
                    if (Math.floor(bot.entity.position.y) >= _epHighY) break;
                    const _headB = bot.blockAt(bot.entity.position.offset(0, 1, 0));
                    if (_headB && _headB.name !== 'air' && _epSoftNames.has(_headB.name) && _headB.diggable) {
                        await bot.dig(_headB).catch(() => {});
                    }
                    bot.setControlState('jump', true);
                    await new Promise(r => setTimeout(r, 600));
                    bot.setControlState('jump', false);
                    await new Promise(r => setTimeout(r, 150));
                }
                if (Math.floor(bot.entity.position.y) >= _epHighY - 1) {
                    console.log(`[DBG-MB] pit-escape method-B success y=${bot.entity.position.y.toFixed(1)}`);
                    return;
                }
            } catch (_be) {
                console.log(`[DBG-MB] pit-escape method-B error dir=(${_dx},${_dz}): ${_be && _be.message}`);
            } finally {
                bot.setControlState('forward', false);
                bot.setControlState('jump', false);
            }
        }
        // ── Method C: Pathfinder with dig + inventory-dynamic scaffolding ─
        // Only enable towers if bot has scaffolding blocks — the pathfinder
        // planning tower paths without blocks causes silent execution failures.
        try {
            const _epPf = require('mineflayer-pathfinder');
            const _epMoves = new _epPf.Movements(bot, mcData);
            _epMoves.canDig = true;
            _epMoves.allowParkour = false;
            _epMoves.maxDropDown = 2;
            const _epScaffIDs = _epGetScaffoldIDs();
            _epMoves.allow1by1towers = _epScaffIDs.length > 0;
            _epMoves.scafoldingBlocks = _epScaffIDs;
            _epMoves.blocksCantBreak = new Set();
            for (const _bn in mcData.blocksByName) {
                if (!_epSoftNames.has(_bn) && !_bn.endsWith('_leaves') && !_bn.endsWith('_leaf')) {
                    _epMoves.blocksCantBreak.add(mcData.blocksByName[_bn].id);
                }
            }
            const _epSurfaces = bot.findBlocks({
                matching: (block) => {
                    if (!block || !block.position || block.boundingBox !== 'block') return false;
                    if (block.name === 'water' || block.name === 'lava') return false;
                    const _a1 = bot.blockAt(block.position.offset(0, 1, 0));
                    const _a2 = bot.blockAt(block.position.offset(0, 2, 0));
                    return (!_a1 || _a1.boundingBox === 'empty') && (!_a2 || _a2.boundingBox === 'empty');
                },
                maxDistance: 24,
                count: 64,
            }).map(p => bot.blockAt(p))
              .filter(b => b && b.position && b.position.y > _epBotFloorY)
              .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
            if (_epSurfaces.length > 0) {
                const _epT = _epSurfaces[0];
                console.log(`[DBG-MB] pit-escape method-C pathfinder to ${_epT.name}@(${_epT.position.x},${_epT.position.y},${_epT.position.z})`);
                let _epPfHandle;
                const _epPrevMoves = bot.pathfinder.movements;
                bot.pathfinder.setMovements(_epMoves);
                try {
                    await Promise.race([
                        bot.pathfinder.goto(new _epPf.goals.GoalNear(_epT.position.x, _epT.position.y + 1, _epT.position.z, 1)),
                        new Promise((_, _rj) => { _epPfHandle = setTimeout(() => { bot.pathfinder.setGoal(null); _rj(new Error('pit-escape pf timeout')); }, 20000); }),
                    ]);
                    console.log(`[DBG-MB] pit-escape method-C success y=${bot.entity.position.y.toFixed(1)}`);
                } finally {
                    if (_epPfHandle) clearTimeout(_epPfHandle);
                    if (_epPrevMoves) bot.pathfinder.setMovements(_epPrevMoves);
                }
            }
        } catch (_ce) {
            console.log(`[DBG-MB] pit-escape method-C failed: ${_ce && _ce.message}`);
        }
    };
    await _escapePit();
    // ── End dry-pit escape ──────────────────────────────────────────────────

    // Use a tighter search radius for specific block names: the pathfinder
    // probe can return "success" for 20+ block paths that the bot can't
    // actually navigate in practice (complex terrain, partial ledges, etc.).
    // Limiting to 16 blocks forces fast-fail → re-plan instead of 30s stall.
    const _searchDist = _isGenericWood ? 32 : 16;
    const blocks = bot.findBlocks({
        matching: _matching,
        maxDistance: _searchDist,
        count: 1024,
    });
    if (_isWoodyTargetName) {
        console.log(`[DBG-MB] scan name=${name} searchDist=${_searchDist} hits=${blocks.length}`);
    }
    if (blocks.length === 0) {
        if (_isWoodyTargetName) {
            console.log(`[DBG-MB] no-blocks name=${name}`);
        }
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
    // Prefer targets that are NOT deep below the bot — chasing wood inside
    // a lava cave below the bot just re-traps it. If there are any targets
    // at or above (botY - 2), restrict to those; if all are below, fail fast
    // rather than trying unreachable blocks.
    const _botY = bot.entity.position.y;
    const _findSolidSupportBelow = (maxDepth = 8) => {
        for (let depth = 0; depth <= maxDepth; depth++) {
            const support = bot.blockAt(bot.entity.position.offset(0, -0.5 - depth, 0));
            if (
                support &&
                support.name !== "air" &&
                support.name !== "water" &&
                support.name !== "lava" &&
                support.boundingBox === "block"
            ) {
                return support;
            }
        }
        return null;
    };
    const _support = _findSolidSupportBelow();
    const _minSurfaceY = _support ? _support.position.y - 8 : _botY - 12;
    const _surfaceTargets = targets.filter((t) => t && t.position && t.position.y >= _minSurfaceY);
    if (_surfaceTargets.length === 0) {
        const _pos = bot.entity.position;
        throw new Error(
            `mineBlock ${name} x${count}: all nearby ${name} blocks are underground ` +
            `(bot at y=${_botY.toFixed(1)}, nearest at y=${targets[0].position.y}). ` +
            `The bot is likely cave-trapped — explore horizontally to find surface wood ` +
            `or try a different block type that is reachable from the current position.`
        );
    }
    if (_surfaceTargets.length < targets.length) {
        targets.length = 0;
        for (const t of _surfaceTargets) targets.push(t);
    }
    // Prefer natural tree trunks over decorative wood supports. Around spawn
    // this server has player-placed wood pillars and all-bark *_wood blocks
    // that break to air but do not yield inventory progress. Real trees tend
    // to have leaves nearby, trunk continuity, and natural ground below.
    const _woodFamilyName = (blockName) => {
        if (!blockName) return "";
        return blockName.replace(/(_log|_wood|_stem|_hyphae)$/, "");
    };
    const _isLeafBlock = (blockName) => !!(blockName && /(_leaves|_leaf)$/.test(blockName));
    const _sameWoodFamily = (block, family) => {
        return !!(
            block &&
            block.name &&
            /(_log|_wood|_stem|_hyphae)$/.test(block.name) &&
            _woodFamilyName(block.name) === family
        );
    };
    const _scoreNaturalWoodTarget = (block) => {
        if (!block || !block.position || !block.name) return -999;
        const _family = _woodFamilyName(block.name);
        let _score = /(_log|_stem|_hyphae)$/.test(block.name) ? 8 : -6;
        let _leafCount = 0;
        let _sameLevelNeighbors = 0;
        for (let _dy = -2; _dy <= 4; _dy++) {
            for (let _dx = -2; _dx <= 2; _dx++) {
                for (let _dz = -2; _dz <= 2; _dz++) {
                    if (_dx === 0 && _dy === 0 && _dz === 0) continue;
                    const _neighbor = bot.blockAt(block.position.offset(_dx, _dy, _dz));
                    if (!_neighbor || !_neighbor.name) continue;
                    if (_isLeafBlock(_neighbor.name)) _leafCount++;
                    if (_dy === 0 && Math.abs(_dx) + Math.abs(_dz) === 1 && _sameWoodFamily(_neighbor, _family)) {
                        _sameLevelNeighbors++;
                    }
                }
            }
        }
        for (let _dy = 1; _dy <= 4; _dy++) {
            const _above = bot.blockAt(block.position.offset(0, _dy, 0));
            if (_sameWoodFamily(_above, _family)) _score += 3;
        }
        for (let _dy = 1; _dy <= 2; _dy++) {
            const _below = bot.blockAt(block.position.offset(0, -_dy, 0));
            if (_sameWoodFamily(_below, _family)) {
                _score += 2;
            } else if (_below && _naturalGroundNames.has(_below.name)) {
                _score += 4;
                break;
            }
        }
        _score += Math.min(_leafCount, 6) * 2;
        if (_sameLevelNeighbors >= 2) _score -= 8;
        if (_sameLevelNeighbors >= 3) _score -= 6;
        const _decorPenalty = Math.min(_decorativeScoreAt(block.position), 16);
        _score -= _decorPenalty;
        return _score;
    };
    if (_isGenericWood) {
        const _botPos = bot.entity.position;
        // Preserve nearby _wood blocks (within 10 blocks) before log-preference filter discards them
        const _closeWood = targets.filter((t) =>
            t && t.position && /(_wood)$/.test(t.name || "") &&
            !(t.name || "").startsWith("stripped_") &&
            t.position.distanceTo(_botPos) <= 10
        );
        console.log(`[DBG-MB] closeWood count=${_closeWood.length} preview=${_closeWood.slice(0,3).map(t=>t.name+'@'+t.position.x+','+t.position.y+','+t.position.z+'dist='+t.position.distanceTo(_botPos).toFixed(1)).join('|')}`);
        // Log all _wood$ blocks in targets regardless of distance
        const _allWood = targets.filter((t) => t && t.name && /(_wood)$/.test(t.name));
        console.log(`[DBG-MB] allWood count=${_allWood.length} preview=${_allWood.slice(0,5).map(t=>t.name+'@('+t.position.x+','+t.position.y+','+t.position.z+')dist='+t.position.distanceTo(_botPos).toFixed(1)).join(' | ')}`);
        const _logLikeTargets = targets.filter((t) => t && /(_log|_stem|_hyphae)$/.test(t.name || ""));
        if (_logLikeTargets.length > 0) {
            targets.length = 0;
            for (const _t of _logLikeTargets) targets.push(_t);
            // Re-add close wood blocks that were displaced by log preference
            for (const _t of _closeWood) targets.push(_t);
        }
        const _treeLikeTargets = targets.filter((t) => _scoreNaturalWoodTarget(t) >= 8);
        if (_treeLikeTargets.length > 0) {
            targets.length = 0;
            for (const _t of _treeLikeTargets) targets.push(_t);
            // Re-add close wood blocks that scored below tree threshold
            for (const _t of _closeWood) {
                if (!targets.some((m) => m.position.equals(_t.position))) targets.push(_t);
            }
        }
        console.log(`[DBG-MB] targets-after-wood-filter count=${targets.length}`);
    }
    const _toolTier = (toolName) => {
        if (!toolName) return -1;
        if (toolName.startsWith("netherite_")) return 5;
        if (toolName.startsWith("diamond_")) return 4;
        if (toolName.startsWith("iron_")) return 3;
        if (toolName.startsWith("stone_")) return 2;
        if (toolName.startsWith("golden_")) return 1;
        return 0;
    };
    const _findBestInventoryTool = (toolKind) => {
        const _candidates = bot.inventory.items()
            .filter((it) => it && it.name && it.name.endsWith(`_${toolKind}`));
        if (_candidates.length === 0) return null;
        _candidates.sort((a, b) => _toolTier(b.name) - _toolTier(a.name));
        return _candidates[0];
    };
    const _placeNearbyCraftingTable = async () => {
        const _tableItemDef = mcData.itemsByName.crafting_table;
        if (!_tableItemDef) return null;
        const _tableItem = bot.inventory.findInventoryItem(_tableItemDef.id, null);
        if (!_tableItem) return null;
        const _pf = require("mineflayer-pathfinder");
        const _GoalNear = _pf.goals.GoalNear;
        const _origin = bot.entity.position.floored();
        const _hazards = new Set(["lava", "flowing_lava", "water", "flowing_water", "fire", "soul_fire", "magma_block", "cactus", "sweet_berry_bush", "wither_rose"]);
        const _offsets = [
            [1, 0], [-1, 0], [0, 1], [0, -1],
            [1, 1], [1, -1], [-1, 1], [-1, -1],
            [2, 0], [-2, 0], [0, 2], [0, -2],
        ];
        for (const [_dx, _dz] of _offsets) {
            const _targetPos = _origin.offset(_dx, 0, _dz);
            const _targetBlock = bot.blockAt(_targetPos);
            const _support = bot.blockAt(_targetPos.offset(0, -1, 0));
            const _targetEmpty = !_targetBlock || _targetBlock.name === "air" || _targetBlock.name === "" || _targetBlock.boundingBox === "empty";
            const _supportOk = _support && _support.boundingBox === "block" && !_hazards.has(_support.name);
            if (!_targetEmpty || !_supportOk) continue;
            try {
                await bot.pathfinder.goto(new _GoalNear(_support.position.x, _support.position.y, _support.position.z, 2));
                await bot.equip(_tableItem, "hand");
                await bot.placeBlock(_support, _targetPos.minus(_support.position));
                await new Promise((resolve) => setTimeout(resolve, 300));
                const _placed = bot.blockAt(_targetPos);
                if (_placed && _placed.name === "crafting_table") return _placed;
            } catch (_e) { /* try next nearby spot */ }
        }
        return null;
    };
    const _ensureAxeForWood = async () => {
        if (!_isWoodyTargetName) return;
        let _axe = _findBestInventoryTool("axe");
        if (_axe) {
            if (!bot.heldItem || bot.heldItem.name !== _axe.name) {
                await bot.equip(_axe, "hand");
            }
            return;
        }
        const _woodenAxeDef = mcData.itemsByName.wooden_axe;
        if (!_woodenAxeDef) {
            throw new Error(
                `mineBlock ${name} x${count}: this server drops no wood when broken bare-handed, ` +
                `and wooden_axe is missing from mcData. Equip any axe first.`
            );
        }
        let _craftingTable = bot.findBlock({
            matching: (block) => block && block.name === "crafting_table",
            maxDistance: 16,
        });
        if (!_craftingTable) {
            _craftingTable = await _placeNearbyCraftingTable();
        }
        if (!_craftingTable) {
            throw new Error(
                `mineBlock ${name} x${count}: this server drops no wood when broken bare-handed. ` +
                `No crafting table is placed nearby and none could be placed from inventory — equip or craft an axe first.`
            );
        }
        try {
            await bot.pathfinder.goto(new GoalLookAtBlock(_craftingTable.position, bot.world));
        } catch (_e) { /* best effort */ }
        const _recipe = bot.recipesFor(_woodenAxeDef.id, null, 1, _craftingTable)[0];
        if (!_recipe) {
            throw new Error(
                `mineBlock ${name} x${count}: this server drops no wood when broken bare-handed. ` +
                `Missing materials for wooden_axe or crafting table access failed.`
            );
        }
        await bot.craft(_recipe, 1, _craftingTable);
        _axe = _findBestInventoryTool("axe");
        if (!_axe) {
            throw new Error(
                `mineBlock ${name} x${count}: crafted wooden_axe recipe but no axe appeared in inventory.`
            );
        }
        if (!bot.heldItem || bot.heldItem.name !== _axe.name) {
            await bot.equip(_axe, "hand");
        }
    };
    const _moveNearWoodTarget = async (target) => {
        if (!_isWoodyTargetName || !target || !target.position) return;
        const _dist = target.position.distanceTo(bot.entity.position);
        const _hasLineOfSight = (() => {
            try { return bot.canSeeBlock(target); } catch (_e) { return false; }
        })();
        if (_dist <= 4 && _hasLineOfSight) return;
        const _pf = require("mineflayer-pathfinder");
        const _Movements = _pf.Movements;
        const _GoalNear = _pf.goals.GoalNear;
        const _prevMovements = bot.pathfinder.movements;
        const _moves = new _Movements(bot, mcData);
        _moves.canDig = true;
        _moves.allowParkour = true;
        _moves.maxDropDown = 4;
        // Only allow towers when the bot has scaffold blocks in inventory.
        // Planning tower paths without placeable blocks causes 15-second stalls.
        const _mvScaffCandidates = [
            "dirt", "sand", "gravel", "coarse_dirt", "rooted_dirt",
            "podzol", "mycelium", "grass_block", "moss_block",
            "cobblestone", "stone", "netherrack", "blackstone",
        ];
        const _mvScaffIDs = _mvScaffCandidates
            .map(n => mcData.blocksByName[n] && mcData.blocksByName[n].id)
            .filter(id => typeof id === 'number' && bot.inventory.items().some(it => it && it.type === id && it.count > 0));
        _moves.allow1by1towers = _mvScaffIDs.length > 0;
        _moves.scafoldingBlocks = _mvScaffIDs;
        _moves.blocksCantBreak = new Set();
        const _softNames = new Set([
            "dirt", "grass_block", "sand", "gravel", "coarse_dirt",
            "rooted_dirt", "podzol", "mycelium", "moss_block", "snow",
            "snow_block", "clay", "farmland",
        ]);
        for (const _name in mcData.blocksByName) {
            const _id = mcData.blocksByName[_name].id;
            const _isLeaves = _name.endsWith("_leaves") || _name.endsWith("_leaf");
            if (!_softNames.has(_name) && !_isLeaves) _moves.blocksCantBreak.add(_id);
        }
        let _moveNearTimeoutHandle;
        const _forceOnGroundMove = () => { bot.entity.onGround = true; };
        bot.on("physicsTick", _forceOnGroundMove);
        try {
            bot.pathfinder.setMovements(_moves);
            await Promise.race([
                bot.pathfinder.goto(new _GoalNear(target.position.x, target.position.y + 1, target.position.z, 1)),
                new Promise((_, _rej) => {
                    _moveNearTimeoutHandle = setTimeout(() => {
                        bot.pathfinder.setGoal(null);
                        _rej(new Error("GoalNear timed out"));
                    }, 15000);
                }),
            ]);
        } finally {
            // Always clear the timeout so a stale setGoal(null) never fires
            // while a subsequent pathfinder.goto (e.g. CollectBlock) is running.
            if (_moveNearTimeoutHandle !== undefined) clearTimeout(_moveNearTimeoutHandle);
            if (_prevMovements) bot.pathfinder.setMovements(_prevMovements);
            else bot.pathfinder.setMovements(new _Movements(bot, mcData));
            bot.removeListener("physicsTick", _forceOnGroundMove);
        }
    };
    // Pathfinder reachability probe — collectBlock.collect with
    // ignoreNoPath:true will spin forever on unreachable targets (lava
    // walls, sealed-off chunks). Probe up to N candidates with a short
    // think-budget; keep only those pathfinder can actually reach.
    try {
        const _pf = require("mineflayer-pathfinder");
        const _Movements = _pf.Movements;
        const _GoalNear = _pf.goals.GoalNear;
        const _moves = new _Movements(bot, mcData);
        // bare-hand-safe: never dig stone we can't break, never break logs
        // we're trying to keep, never enter lava.
        _moves.canDig = true;
        _moves.allowParkour = true;
        _moves.maxDropDown = 4;
        // Only plan tower paths when the bot has scaffolding blocks in inventory.
        // A probe returning "success" for a tower path the bot can't execute
        // is the root cause of 15-second stalls in crevices and shallow pits.
        const _probeScaffCandidates = ["dirt", "sand", "gravel", "coarse_dirt", "cobblestone", "cobbled_deepslate", "netherrack", "andesite", "diorite", "granite"];
        const _probeScaffIDs = _probeScaffCandidates
            .map(n => mcData.blocksByName[n] && mcData.blocksByName[n].id)
            .filter(id => typeof id === 'number' && bot.inventory.items().some(it => it && it.type === id && it.count > 0));
        _moves.allow1by1towers = _probeScaffIDs.length > 0;
        _moves.scafoldingBlocks = _probeScaffIDs;
        const _PROBE_LIMIT = _isGenericWood ? 24 : 8;
        // For generic wood, probe more candidates and rank natural-looking
        // trunks first so we don't get trapped mining decorative spawn wood.
        const _botPos = bot.entity.position;
        targets.sort((a, b) => {
            if (_isWoodyTargetName) {
                const _aScore = _scoreNaturalWoodTarget(a);
                const _bScore = _scoreNaturalWoodTarget(b);
                if (_aScore !== _bScore) return _bScore - _aScore;
            }
            return a.position.distanceTo(_botPos) - b.position.distanceTo(_botPos);
        });
        // Give pathfinder enough time to find a real path. 800ms was too
        // short for complex terrain — increase to 3000ms.
        const _PROBE_THINK_MS = 3000;
        const _candidates = targets.slice(0, _PROBE_LIMIT);
        if (_isWoodyTargetName) {
            const _preview = _candidates.slice(0, 5).map((_t) => {
                const _score = _scoreNaturalWoodTarget(_t);
                const _dist = _t.position.distanceTo(_botPos).toFixed(2);
                return `${_t.name}@(${_t.position.x},${_t.position.y},${_t.position.z}) score=${_score} dist=${_dist}`;
            }).join(" | ");
            console.log(`[DBG-MB] probe-candidates count=${_candidates.length} preview=${_preview}`);
        }
        const _reachable = [];
        // Restrict blocksCantBreak to match _moveNearWoodTarget — only soft blocks
        // and leaves can be dug. This ensures probe results match actual navigation.
        const _softBlockNames = new Set([
            "dirt", "grass_block", "sand", "gravel", "coarse_dirt",
            "rooted_dirt", "podzol", "mycelium", "moss_block", "snow",
            "snow_block", "clay", "farmland",
        ]);
        _moves.blocksCantBreak = new Set();
        for (const _bn in mcData.blocksByName) {
            const _bid = mcData.blocksByName[_bn].id;
            const _isLeaves = _bn.endsWith("_leaves") || _bn.endsWith("_leaf");
            if (!_softBlockNames.has(_bn) && !_isLeaves) _moves.blocksCantBreak.add(_bid);
        }
        // If the bot is floating on a Forge-modded platform that mineflayer
        // doesn't recognise as solid (onGround=false), set onGround=true so
        // getPathTo (which is synchronous) has a valid start node.
        // The Movements.getBlock patch in index.js now marks unknown modded
        // blocks as physical, so A* can compute paths along the platform surface.
        const _probeOrigOG = bot.entity.onGround;
        if (!bot.entity.onGround) {
            bot.entity.onGround = true;
        }
        try {
        for (const _t of _candidates) {
            if (!_t || !_t.position) continue;
            // Very close blocks (≤4.5 blocks): the bot can swing without moving.
            if (_t.position.distanceTo(_botPos) <= 4.5) {
                _reachable.push(_t);
                continue;
            }
            try {
                const _goal = new _GoalNear(_t.position.x, _t.position.y + 1, _t.position.z, 1);
                const _res = bot.pathfinder.getPathTo(_moves, _goal, _PROBE_THINK_MS);
                // Require full "success" with a path that isn't absurdly long.
                // A short partial path or a very long winding path usually means
                // the block is actually enclosed and the bot will stall trying
                // to navigate around lava/walls.
                if (_res && _res.status === "success" && _res.path && _res.path.length <= 300) {
                    _reachable.push(_t);
                }
            } catch (_e) { /* probe failure → treat as unreachable */ }
        }
        } finally {
            bot.entity.onGround = _probeOrigOG;
        }
        if (_isWoodyTargetName) {
            console.log(`[DBG-MB] probe-reachable count=${_reachable.length}`);
        }
        // FAST PATH for wood: if the strict probe rejected everything but
        // candidates exist within 24 blocks, accept the closest natural-wood
        // candidates anyway and let CollectBlock figure out the path.  The
        // strict probe was over-eagerly rejecting reachable trees on Forge
        // platforms (modded blocks confuse Movements).  Mining the WHOLE
        // tree is preferable to standing still and "exploring" indefinitely.
        let _usedFastPath = false;
        if (_isWoodyTargetName && _reachable.length === 0 && _candidates.length > 0) {
            const _close = _candidates
                .filter((c) => c && c.position && c.position.distanceTo(_botPos) <= 24)
                // Reject canopy logs more than 5 blocks above the bot — they
                // are physically unreachable without bridging and cause an
                // infinite retry loop on Forge platforms.
                .filter((c) => c.position.y <= _botPos.y + 5)
                .sort((a, b) => a.position.distanceTo(_botPos) - b.position.distanceTo(_botPos))
                .slice(0, 8);
            if (_close.length > 0) {
                for (const _c of _close) _reachable.push(_c);
                _usedFastPath = true;
                console.log(`[DBG-MB] probe-fastpath accepted=${_close.length} closest=${_close[0].name}@(${_close[0].position.x},${_close[0].position.y},${_close[0].position.z}) dist=${_close[0].position.distanceTo(_botPos).toFixed(1)}`);
            }
        }
        if (_reachable.length > 0) {
            if (_isWoodyTargetName) {
                // Always keep blocks that score ≥0 (natural wood) or are within swing range (≤4.5 blocks).
                const _naturalReachable = _reachable.filter((target) =>
                    _scoreNaturalWoodTarget(target) >= 0 ||
                    target.position.distanceTo(_botPos) <= 4.5
                );
                // Prefer natural-looking (score ≥ 0) blocks; but if none exist,
                // fall back to ALL reachable wood — on modded/Forge servers the
                // platform itself is made of _wood$ variants (acacia_wood etc.) that
                // still yield planks-capable items when mined.
                if (_naturalReachable.length > 0) {
                    _reachable.length = 0;
                    for (const _target of _naturalReachable) _reachable.push(_target);
                }
                // else: keep _reachable as-is (contains decorative-wood blocks)
                console.log(`[DBG-MB] natural-reachable count=${_naturalReachable.length} total-reachable=${_reachable.length}`);
            }
            const _rankTreeTargets = (a, b) => {
                const _aScore = _scoreNaturalWoodTarget(a);
                const _bScore = _scoreNaturalWoodTarget(b);
                if (_aScore !== _bScore) return _bScore - _aScore;
                const _aVisible = (() => {
                    try { return bot.canSeeBlock(a) ? 1 : 0; } catch (_e) { return 0; }
                })();
                const _bVisible = (() => {
                    try { return bot.canSeeBlock(b) ? 1 : 0; } catch (_e) { return 0; }
                })();
                if (_aVisible !== _bVisible) return _bVisible - _aVisible;
                const _aDist = a.position.distanceTo(_botPos);
                const _bDist = b.position.distanceTo(_botPos);
                if (Math.abs(_aDist - _bDist) > 0.25) return _aDist - _bDist;
                return a.position.y - b.position.y;
            };
            // For tree-like targets, prefer the LOWEST reachable block:
            // mining the base of a tree means the bot is standing on
            // ground next to the drop, so collectBlock can pick it up.
            // Mining the treetop drops the item into the canopy/cave
            // below where the bot can't reach it (and it may burn in
            // fire/lava on the way down).
            _reachable.sort(_rankTreeTargets);
            // Line-of-sight gate for wood/log targets. Without LOS the
            // bot is e.g. standing in a 2-deep crevasse below a tree and
            // collectBlock will dig STRAIGHT UP through dirt/leaves to
            // reach the trunk — when the trunk finally breaks, the log
            // drop falls onto the canopy or off into the surroundings
            // where the bot can never collect it. Require canSeeBlock so
            // the bot is actually adjacent to the trunk before swinging.
            if (_isWoodyTargetName) {
                // LOS gate: prefer blocks the bot can actually see from its
                // current position so CollectBlock doesn't dig blindly through
                // canopy/dirt and drop the log somewhere unreachable.
                // Exception: blocks at the same Y level as the bot (≤ 1 block
                // height difference) on a flat platform — no LOS concern there.
                const _isSameLevel = (t) => Math.abs(t.position.y - bot.entity.position.y) <= 1;
                const _visible = _reachable.filter((t) => {
                    if (_isSameLevel(t)) return true; // platform-level block — skip LOS gate
                    try { return bot.canSeeBlock(t); } catch (_e) { return false; }
                }).sort(_rankTreeTargets);
                if (_visible.length > 0) {
                    targets.length = 0;
                    for (const _t of _visible) targets.push(_t);
                    console.log(`[DBG-MB] los-gate passed count=${_visible.length} top=${_visible[0].name}@(${_visible[0].position.x},${_visible[0].position.y},${_visible[0].position.z})`);
                } else if (_usedFastPath) {
                    // FAST-PATH targets: skip pathfinder move-near (it has been
                    // walking the bot off Forge platforms into lava).  Just
                    // accept whatever fast-path gave us — collectBlock will
                    // handle approach (and may fail safely without crashing).
                    targets.length = 0;
                    for (const _t of _reachable) targets.push(_t);
                    console.log(`[DBG-MB] los-gate skipped (fastpath) count=${_reachable.length} top=${_reachable[0].name}@(${_reachable[0].position.x},${_reachable[0].position.y},${_reachable[0].position.z})`);
                } else {
                    // Nothing visible — walk closer to the nearest
                    // reachable wood (without digging it) so the next
                    // call has LOS. We use GoalNear with a 2-block
                    // tolerance so the bot lands beside the trunk
                    // rather than on it.
                    const _posBefore = bot.entity.position.clone();
                    try {
                        const _nearest = _reachable[0];
                        await _moveNearWoodTarget(_nearest);
                    } catch (_e) { /* swallow */ }
                    // Re-check visibility after the move.
                    const _visible2 = _reachable.filter((t) => {
                        if (_isSameLevel(t)) return true;
                        try { return bot.canSeeBlock(t); } catch (_e) { return false; }
                    }).sort(_rankTreeTargets);
                    if (_visible2.length > 0) {
                        targets.length = 0;
                        for (const _t of _visible2) targets.push(_t);
                    } else {
                        // No LOS even after trying to approach. If the bot didn't move
                        // (pathfinder blocked by barriers) throwing just creates an infinite
                        // retry loop — the error message never changes and the bot never
                        // escapes. Instead, proceed with whatever reachable targets we have
                        // and let collectBlock attempt the mine. It may still fail, but at
                        // least it will be a different error and the curriculum can react.
                        const _moved = bot.entity.position.distanceTo(_posBefore) > 0.5;
                        if (!_moved) {
                            // Bot didn't move at all — barrier/pathfinder blocked.
                            // Use reachable targets as-is; collectBlock will try to navigate.
                            targets.length = 0;
                            for (const _t of _reachable) targets.push(_t);
                            console.log(`[DBG-MB] los-gate no-los + no move → proceeding with reachable count=${_reachable.length}`);
                        } else {
                            throw new Error(
                                `mineBlock ${name} x${count}: no ${name} in direct line of sight ` +
                                `from bot at (${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}). ` +
                                `Move to open ground next to the tree trunk before mining — ` +
                                `digging blindly through canopy/dirt drops the log where the bot can't pick it up.`
                            );
                        }
                    }
                }
            } else {
                targets.length = 0;
                for (const _t of _reachable) targets.push(_t);
            }
        } else {
            if (_isWoodyTargetName) {
                const _naturalCandidates = _candidates.filter((target) => _scoreNaturalWoodTarget(target) >= 0);
                const _fallbackTargets = _naturalCandidates.length > 0 ? _naturalCandidates : _candidates;
                console.log(
                    `[DBG-MB] probe-fallback name=${name} bot=(${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}) ` +
                    `using=${_fallbackTargets.length}`
                );
                if (_fallbackTargets.length > 0) {
                    // If all fallback targets are far away (> 8 blocks), the bot is
                    // unlikely to reach any of them from its current position.
                    // Throw immediately so ensureLogsReachable can trigger exploration.
                    const _botPos = bot.entity.position;
                    const _minDist = Math.min(..._fallbackTargets.map((t) =>
                        t.position.distanceTo(_botPos)
                    ));
                    if (_minDist > 8) {
                        throw Object.assign(
                            new Error(`could not get near natural wood target (all ${_fallbackTargets.length} candidates >${_minDist.toFixed(1)} blocks away, probe unreachable)`),
                            { _mineBlockFastFail: true }
                        );
                    }
                    targets.length = 0;
                    for (const _target of _fallbackTargets) targets.push(_target);
                }
            }
        }
    } catch (_e) {
        // Re-throw our own diagnostic errors; only swallow probe
        // infrastructure failures (e.g. mineflayer-pathfinder missing).
        if (_e && (_e._mineBlockFastFail || /line of sight|no reachable/.test(_e.message || ""))) {
            throw _e;
        }
        /* pathfinder probe unavailable → skip filter */
    }
    // ── ISSUE-2 fix: verify a real inventory gain after mining, so skills
    // can't lie about "Done: mined X" when nothing was actually collected.
    // We accept EITHER an exact-name delta OR a generic total-stack delta,
    // because modded loot tables can drop a different item id (e.g. the
    // `coarse_dirt` block on this server drops the `dirt` item). Counting
    // only the requested name caused false negatives in cycle 30.
    const _itemName = name;
    const _woodSuffixRe = /(_log|_wood|_stem|_hyphae)$/;
    // Vanilla-ish block→drop aliases. When the bot calls mineBlock(bot, 'stone', N)
    // it expects to count cobblestone (the actual drop without Silk Touch). Same
    // for ores: coal_ore→coal, iron_ore→raw_iron, etc. Without this, the
    // post-mine inventory check throws even though the mine succeeded.
    const _dropAliases = {
        stone:           ["cobblestone", "stone"],
        cobblestone:     ["cobblestone"],
        coal_ore:        ["coal"],
        deepslate_coal_ore:    ["coal"],
        iron_ore:        ["raw_iron", "iron_ore"],
        deepslate_iron_ore:    ["raw_iron"],
        copper_ore:      ["raw_copper"],
        deepslate_copper_ore:  ["raw_copper"],
        gold_ore:        ["raw_gold"],
        deepslate_gold_ore:    ["raw_gold"],
        nether_gold_ore: ["gold_nugget"],
        diamond_ore:     ["diamond"],
        deepslate_diamond_ore: ["diamond"],
        emerald_ore:     ["emerald"],
        deepslate_emerald_ore: ["emerald"],
        lapis_ore:       ["lapis_lazuli"],
        deepslate_lapis_ore:   ["lapis_lazuli"],
        redstone_ore:    ["redstone"],
        deepslate_redstone_ore: ["redstone"],
        nether_quartz_ore:     ["quartz"],
        ancient_debris:  ["ancient_debris"],
        gravel:          ["gravel", "flint"],
        grass_block:     ["dirt", "grass_block"],
        grass:           ["wheat_seeds"],
        tall_grass:      ["wheat_seeds"],
        clay:            ["clay_ball", "clay"],
        snow:            ["snowball", "snow"],
        snow_block:      ["snowball", "snow_block"],
        glowstone:       ["glowstone_dust", "glowstone"],
        sea_lantern:     ["prismarine_crystals"],
        melon:           ["melon_slice"],
        bamboo:          ["bamboo"],
        sweet_berry_bush:["sweet_berries"],
        cocoa:           ["cocoa_beans"],
    };
    const _aliasNames = _dropAliases[_itemName] || [_itemName];
    const _matchesItem = (it) => {
        if (!it || !it.name) return false;
        if (_isGenericWood) return _woodSuffixRe.test(it.name);
        return _aliasNames.includes(it.name);
    };
    const _countByName = () => bot.inventory.items()
        .filter(_matchesItem)
        .reduce((a, it) => a + (it.count || 0), 0);
    const _countTotal = () => bot.inventory.items()
        .reduce((a, it) => a + (it && it.count ? it.count : 0), 0);
    const _beforeName  = _countByName();
    const _beforeTotal = _countTotal();
    // Auto-equip the best harvesting tool. On this Forge modded server,
    // breaking a wood/log block while holding `dirt` succeeds (the block
    // turns to air) but the loot table yields ZERO drops (dropsRegistry
    // is empty), so the bot never collects anything. We must hold an
    // axe for logs/wood and a pickaxe for stone/ore — otherwise digs
    // are silent no-ops from a loot perspective.
    if (_isWoodyTargetName) {
        try {
            await _ensureAxeForWood();
        } catch (_e) {
            // Best effort only. Some natural logs on this server can still be
            // collected bare-handed, so prefer an axe but do not hard-fail the
            // first attempt solely because crafting is unavailable yet.
        }
        const _equippedAxe = bot.heldItem && /_axe$/.test(bot.heldItem.name || "");
        if (!_equippedAxe && !_findBestInventoryTool("axe") && bot.heldItem) {
            try {
                console.log(`[DBG-MB] unequip-hand held=${bot.heldItem.name}`);
                await bot.unequip("hand");
            } catch (_e) { /* best effort only */ }
        }
    }
    // Blocks that require the correct tool to drop ANYTHING (requiresCorrectTool=true in vanilla).
    // Mining these bare-handed gives zero drops — throw early with a clear message.
    const _requiredToolKind =
        /(stone|ore|cobblestone|deepslate|granite|diorite|andesite|basalt|tuff|netherrack|end_stone|blackstone|sandstone|brick|nether_brick|quartz|obsidian|prismarine|terracotta|concrete)/.test(name)
            ? "pickaxe"
            : null;

    // Blocks that are hand-minable but benefit from the right tool (speed / efficiency).
    // Equip if available, but do NOT throw if the tool is absent.
    const _preferredToolKind = _isWoodyTargetName || /(?:^|_)(log|wood|planks|leaves)($|_)/.test(name)
        ? "axe"
        : /(dirt|grass_block|sand|gravel|soul_sand|soul_soil|clay|farmland|podzol|mycelium|coarse_dirt|rooted_dirt|moss_block|mud|snow_block|powder_snow)/.test(name)
            ? "shovel"
            : null;
    try {
        const _sample = blockByName;
        if (_sample && bot.pathfinder && bot.pathfinder.bestHarvestTool) {
            const _tool = bot.pathfinder.bestHarvestTool(_sample);
            if (_tool && (!bot.heldItem || bot.heldItem.name !== _tool.name)) {
                await bot.equip(_tool, "hand");
            } else if (!_tool) {
                if (_requiredToolKind) {
                    // Block needs correct tool for any drop — throw if missing.
                    const _best = _findBestInventoryTool(_requiredToolKind);
                    if (_best) {
                        if (!bot.heldItem || bot.heldItem.name !== _best.name) await bot.equip(_best, "hand");
                    } else {
                        throw new Error(
                            `mineBlock ${name} x${count}: a ${_requiredToolKind} is required to mine '${name}' ` +
                            `but none is in the inventory. Craft or obtain a ${_requiredToolKind} first.`
                        );
                    }
                } else if (_preferredToolKind) {
                    // Hand-minable block — equip best tool for speed if available, else bare hands.
                    const _pref = _findBestInventoryTool(_preferredToolKind);
                    if (_pref && (!bot.heldItem || bot.heldItem.name !== _pref.name))
                        try { await bot.equip(_pref, "hand"); } catch (_e2) {}
                }
            }
        } else {
            // Fallback heuristic if pathfinder helper isn't available.
            if (_requiredToolKind) {
                const _pick = _findBestInventoryTool(_requiredToolKind);
                if (_pick) {
                    if (!bot.heldItem || bot.heldItem.name !== _pick.name) await bot.equip(_pick, "hand");
                } else {
                    throw new Error(
                        `mineBlock ${name} x${count}: a ${_requiredToolKind} is required to mine '${name}' ` +
                        `but none is in the inventory. Craft or obtain a ${_requiredToolKind} first.`
                    );
                }
            } else if (_preferredToolKind) {
                const _pref = _findBestInventoryTool(_preferredToolKind);
                if (_pref && (!bot.heldItem || bot.heldItem.name !== _pref.name))
                    try { await bot.equip(_pref, "hand"); } catch (_e2) {}
            }
        }
    } catch (_e) {
        // Re-throw explicit "required tool missing" errors; swallow equip glitches.
        if (_e && _e.message && _e.message.includes("is required to mine")) throw _e;
        /* equip failure → fall through; gain check will catch */
    }
    // Stall-detection timeout. Wall-clock timeout was too aggressive: when
    // pathfinder has to dig through coarse_dirt/stone to reach surface
    // wood, a single mineBlock call can legitimately take > 60s. Instead,
    // measure progress: if bot hasn't moved more than 0.5 blocks for 30s
    // straight, declare it stalled and abort.
    const _STALL_WINDOW_MS = 30000;
    const _STALL_MIN_MOVE = 0.5;
    const _HARD_CAP_MS = 240000; // absolute upper bound, prevents truly infinite hangs
    let _timeoutId;
    let _stallCheckId;
    const _t0 = Date.now();
    let _lastMoveT = _t0;
    let _lastPos = bot.entity.position.clone();
    const _abort = (reason) => {
        try { bot.collectBlock.cancelTask && bot.collectBlock.cancelTask(); } catch (_e) {}
        try { bot.pathfinder && bot.pathfinder.stop && bot.pathfinder.stop(); } catch (_e) {}
        try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (_e) {}
        return new Error(`mineBlock ${name} x${count}: ${reason} (likely no reachable path; bot may be cave-trapped — try ensureLogsReachable / surface escape)`);
    };
    const _timeoutPromise = new Promise((_, reject) => {
        _stallCheckId = setInterval(() => {
            const _now = Date.now();
            const _pos = bot.entity.position;
            const _moved = _pos.distanceTo(_lastPos);
            if (_moved >= _STALL_MIN_MOVE) {
                _lastPos = _pos.clone();
                _lastMoveT = _now;
            }
            if (_now - _lastMoveT > _STALL_WINDOW_MS) {
                clearInterval(_stallCheckId);
                reject(_abort(`stalled (no movement for ${_STALL_WINDOW_MS / 1000}s)`));
                return;
            }
            if (_now - _t0 > _HARD_CAP_MS) {
                clearInterval(_stallCheckId);
                reject(_abort(`hard cap ${_HARD_CAP_MS / 1000}s exceeded`));
                return;
            }
        }, 2000);
    });
    // Hoisted outside outer try so the inventory check after `} finally {`
    // can reference it without a ReferenceError.
    let _collectErr = null;
    try {
        // Pass only the single best (closest, reachable, visible) target.
        // Passing an array with ignoreNoPath:true causes collectBlock to
        // cycle through targets in a tight cancel-loop ("goal was changed"
        // spam) when none are truly reachable. ignoreNoPath:false lets it
        // fail fast so the critic can re-plan instead of a 30s stall.
        const _bestTarget = targets[0];
        if (_bestTarget && _isWoodyTargetName) {
            console.log(`[DBG-MB] best-target name=${_bestTarget.name} pos=(${_bestTarget.position.x},${_bestTarget.position.y},${_bestTarget.position.z}) held=${bot.heldItem ? bot.heldItem.name : '<empty>'}`);
            try {
                await _moveNearWoodTarget(_bestTarget);
            } catch (_e) { /* fall through to the open-ground retry below */ }
            let _afterMoveDist = _bestTarget.position.distanceTo(bot.entity.position);
            if (_afterMoveDist > 4) {
                try {
                    await _moveOutOfDecorativeSpawn();
                    await _moveNearWoodTarget(_bestTarget);
                } catch (_e) { /* best effort only */ }
                _afterMoveDist = _bestTarget.position.distanceTo(bot.entity.position);
                if (_afterMoveDist > 4) {
                    console.log(
                        `[DBG-MB] move-near fallback target=(${_bestTarget.position.x},${_bestTarget.position.y},${_bestTarget.position.z}) ` +
                        `bot=(${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}) ` +
                        `dist=${_afterMoveDist.toFixed(2)}`
                    );
                }
            }
        }
        // Reset stall window so CollectBlock navigation gets a fresh 30s budget
        // (moveNear attempts may have consumed most of the original window).
        _lastMoveT = Date.now();
        _lastPos = bot.entity.position.clone();
        // ── Smart batch-mine expansion ────────────────────────────────────────
        // For logs/wood: BFS flood-fill to collect the whole tree.
        // For ores/coal: BFS flood-fill to collect the whole vein.
        // For everything else: expand to all matching blocks within 3 blocks.
        let _effectiveCount = count;
        // FTB Ultimine is installed server-side: send key_pressed packet before
        // digging one block and the server mines the entire connected group.
        // Enable for ALL block types so ultimine is always active.
        const _useUltimine = true;
        {
            const _isLog = _isWoodyTargetName || /(?:^|_)(log|wood)($|_)/.test(name);
            const _isOre = /ore$/.test(name) || name === "coal" || name === "coal_block";
            if (_isLog || _isOre) {
                // BFS flood-fill from all known matching blocks (up to 64-block search radius).
                // Flood-fill distance cap: trees are ≤ ~25 blocks tall; veins ≤ 40 blocks wide.
                const _floodMax = _isLog ? 32 : 48;
                const _seedPositions = bot.findBlocks({ matching: _matching, maxDistance: 64, count: 512 });
                const _visited = new Set();
                const _queue = [];
                const _posKey = (p) => `${p.x},${p.y},${p.z}`;
                // Seed from the first block near the bot (typically what collectBlock is targeting).
                if (_seedPositions.length > 0) {
                    _queue.push(_seedPositions[0]);
                    _visited.add(_posKey(_seedPositions[0]));
                }
                // Also seed from the nearest few matching blocks so disconnected sub-trees/veins
                // that are right next to each other still get included.
                for (let _si = 1; _si < Math.min(4, _seedPositions.length); _si++) {
                    const _sp = _seedPositions[_si];
                    if (!_visited.has(_posKey(_sp))) {
                        _queue.push(_sp);
                        _visited.add(_posKey(_sp));
                    }
                }
                let _qi = 0;
                const Vec3 = require("vec3");
                const _neighbors26 = [];
                for (let _dx = -1; _dx <= 1; _dx++)
                    for (let _dy = -1; _dy <= 1; _dy++)
                        for (let _dz = -1; _dz <= 1; _dz++)
                            if (_dx || _dy || _dz) _neighbors26.push(new Vec3(_dx, _dy, _dz));
                while (_qi < _queue.length) {
                    const _cur = _queue[_qi++];
                    for (const _off of _neighbors26) {
                        const _np = _cur.plus(_off);
                        const _key = _posKey(_np);
                        if (_visited.has(_key)) continue;
                        _visited.add(_key);
                        const _nb = bot.blockAt(_np);
                        if (_nb && _matching(_nb)) {
                            _queue.push(_np);
                            if (_queue.length > _floodMax) break;
                        }
                    }
                    if (_queue.length > _floodMax) break;
                }
                const _floodCount = _visited.size;
                _effectiveCount = Math.max(count, _floodCount);
                if (_floodCount > count) {
                    console.log(`[DBG-MB] flood-expand name=${name} requested=${count} flood=${_floodCount} effectiveCount=${_effectiveCount}`);
                }
            } else {
                // Generic nearby expansion for all other block types.
                const _nearbyCount = bot.findBlocks({ matching: _matching, maxDistance: 3, count: 256 }).length;
                _effectiveCount = Math.max(count, _nearbyCount);
                if (_nearbyCount > count) {
                    console.log(`[DBG-MB] batch-expand name=${name} requested=${count} nearby3=${_nearbyCount} effectiveCount=${_effectiveCount}`);
                }
            }
        }
        // On a Forge-modded platform the mineflayer physics engine may flip
        // onGround=false mid-tick (platform blocks aren't fully recognised),
        // which causes the pathfinder to plan "floating" paths that never
        // move the bot.  Pin onGround=true for every tick while navigating
        // so the pathfinder always computes from a valid grounded start node.
        const _forceOnGround = () => { bot.entity.onGround = true; };
        bot.on("physicsTick", _forceOnGround);
        // Allow larger drops during mining so the bot can navigate freely.
        // Restored to 1 (canyon-avoidance) in the finally block.
        const _prevMaxDrop = bot._movements ? bot._movements.maxDropDown : 4;
        if (bot._movements) bot._movements.maxDropDown = 4;
        try {
            if (_useUltimine) {
                // ── FTB Ultimine path ───────────────────────────────────────────────
                // Press the Ultimine key → dig one block → server mines entire
                // connected tree / ore vein → release key → walk spiral to pick up
                // all item entities that dropped around the break point.
                const _basePos = _bestTarget.position.clone();
                // Activate ultimine via Architectury network channel.
                // FTB Ultimine uses Architectury SimpleNetworkManager which
                // multiplexes ALL mod packets through a single Forge channel
                // "architectury:network". Payload = writeUtf(packetId) + data.
                // writeUtf = VarInt(byteLength) + UTF-8 bytes.
                const _ultRl = Buffer.from('ftbultimine:key_pressed', 'utf8');  // 23 bytes
                const _ultRlBuf = Buffer.concat([Buffer.from([_ultRl.length]), _ultRl]);
                const _ultPress = Buffer.concat([_ultRlBuf, Buffer.from([0x01])]);
                const _ultRelease = Buffer.concat([_ultRlBuf, Buffer.from([0x00])]);
                try { bot._client.write('custom_payload', { channel: 'architectury:network', data: _ultPress }); } catch (_pe) { console.log(`[DBG-MB] ultimine send err: ${_pe.message || _pe}`); }
                console.log(`[DBG-MB] ultimine key_pressed=true name=${name} pos=(${_basePos.x},${_basePos.y},${_basePos.z}) effectiveCount=${_effectiveCount}`);
                // Dig the single target block
                try {
                    const _bl = bot.blockAt(_bestTarget.position);
                    if (_bl && _matching(_bl)) {
                        await Promise.race([bot.dig(_bl, true), _timeoutPromise]);
                    }
                } catch (_de) {
                    if (_de && _de._mineBlockFastFail) throw _de;
                    _collectErr = _de;
                    console.log(`[DBG-MB] ultimine dig threw (checking inventory): ${_de && _de.message ? _de.message : _de}`);
                }
                // Release ultimine key
                try { bot._client.write('custom_payload', { channel: 'architectury:network', data: _ultRelease }); } catch (_pe) {}
                // Wait for server to process all block breaks and spawn item entities.
                // Use a longer wait for ores/logs which may mine large veins.
                await new Promise((r) => setTimeout(r, 1200));
                // Collect drops: navigate to every nearby item entity spawned by the
                // ultimine. For large veins, drops scatter widely so we can't rely on
                // a small spiral — we need to walk to each item entity.
                try {
                    const _pf = require("mineflayer-pathfinder");
                    const _GoalNear = _pf.goals.GoalNear;
                    const _bx = _basePos.x, _by = _basePos.y, _bz = _basePos.z;
                    // Find all item entities within 32 blocks of the dug block.
                    const _nearItems = Object.values(bot.entities).filter(e =>
                        e && e.name === 'item' && e.position &&
                        Math.abs(e.position.x - _bx) < 32 &&
                        Math.abs(e.position.y - _by) < 16 &&
                        Math.abs(e.position.z - _bz) < 32
                    );
                    if (_nearItems.length > 0) {
                        console.log(`[DBG-MB] ultimine items nearby=${_nearItems.length} name=${name}`);
                        // Navigate to each item entity so mineflayer's auto-pickup collects it.
                        // collectBlock.collect(entity[]) uses GoalFollow+entityGone which times
                        // out when items are stuck in tree canopies or cave crevices.
                        // Instead, pathfinder.goto(GoalNear, entity pos) within 1 block is enough
                        // for the auto-pickup radius to trigger.
                        const _sortedItems = _nearItems
                            .slice()
                            .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
                            .slice(0, 20); // cap at 20 positions (3s each = 60s max)
                        for (const _e of _sortedItems) {
                            if (!_e || !_e.position || !_e.isValid) continue;
                            const _ex = _e.position.x, _ey = _e.position.y, _ez = _e.position.z;
                            await Promise.race([
                                bot.pathfinder.goto(new _GoalNear(Math.floor(_ex), Math.floor(_ey), Math.floor(_ez), 1)),
                                new Promise((_, _r) => setTimeout(() => _r(new Error("item-goto")), 3000)),
                            ]).catch(() => {});
                            await new Promise(r => setTimeout(r, 150)); // brief pause for auto-pickup
                        }
                    } else {
                        // No item entities found — small spiral as fallback.
                        const _spiral = [[2,0],[-2,0],[0,2],[0,-2],[1,1],[1,-1],[-1,1],[-1,-1]];
                        for (const [_dx, _dz] of _spiral) {
                            await Promise.race([
                                bot.pathfinder.goto(new _GoalNear(_bx + _dx, _by, _bz + _dz, 1)),
                                new Promise((_, _r) => setTimeout(() => _r(new Error("spiral-timeout")), 1500)),
                            ]).catch(() => {});
                        }
                    }
                    console.log(`[DBG-MB] ultimine collect done name=${name}`);
                } catch (_se) { /* best-effort item pickup */ }
            } else {
                // ── Standard collectBlock path (dirt, sand, leaves, etc.) ────────────
                await Promise.race([
                    bot.collectBlock.collect(_bestTarget, { ignoreNoPath: false, count: _effectiveCount }),
                    _timeoutPromise,
                ]);
            }
        } catch (_e) {
            // Propagate hard failures; swallow transient pickup errors so the
            // inventory check below can still confirm success.
            if (_e && _e._mineBlockFastFail) throw _e;
            _collectErr = _e;
            if (_useUltimine || _isWoodyTargetName) {
                console.log(`[DBG-MB] collect threw (will check inventory): ${_e && _e.message ? _e.message : String(_e)}`);
            }
        } finally {
            bot.removeListener("physicsTick", _forceOnGround);
            if (bot._movements) bot._movements.maxDropDown = _prevMaxDrop;
        }
    } finally {
        if (_timeoutId) clearTimeout(_timeoutId);
        if (_stallCheckId) clearInterval(_stallCheckId);
    }
    // Brief grace period: the server may emit the inventory_pickup packet
    // a few ticks after CollectBlock's "Collect finish!" chat fires.
    await new Promise((r) => setTimeout(r, 400));
    const _afterName  = _countByName();
    const _afterTotal = _countTotal();
    const _deltaName  = _afterName  - _beforeName;
    const _deltaTotal = _afterTotal - _beforeTotal;
    // For wood/log/planks targets, drops are valuable and discrete — accept
    // ONLY a name-specific delta. The total-stack fallback masks failures
    // when the wood drop burns in nearby fire/lava but a stray dirt from
    // path scaffolding bumps the total. For dirt-family blocks (whose
    // modded loot tables can drop a different item id), we still allow
    // the total-stack fallback.
    const _isWoody = _isWoodyTargetName || /planks$/.test(_itemName);
    const _gainOk = _isWoody
        ? (_deltaName >= count)
        : (_deltaName >= count || _deltaTotal >= count);
    if (_isWoodyTargetName) {
        console.log(`[DBG-MB] delta name=${name} deltaName=${_deltaName} deltaTotal=${_deltaTotal} beforeName=${_beforeName} afterName=${_afterName} beforeTotal=${_beforeTotal} afterTotal=${_afterTotal}`);
    }
    if (!_gainOk) {
        // Human-readable label: show what items we're actually counting
        // (e.g. "cobblestone/stone" instead of bare "stone")
        const _dropLabel = _aliasNames.length > 1 ? _aliasNames.join('/') : name;
        // If CollectBlock threw a transient error but we still gained items,
        // treat that as success (re-throw the original error only on true failure).
        if (_collectErr) {
            throw new Error(
                `mineBlock ${name} x${count}: inventory gained ${_deltaName} ${_dropLabel} ` +
                `(${_beforeName}→${_afterName}) and ${_deltaTotal} total items ` +
                `(${_beforeTotal}→${_afterTotal}). ` +
                `CollectBlock also threw: ${_collectErr.message || _collectErr}. ` +
                `Likely causes: dig was server-rejected (no LOS / out of reach), ` +
                `drop entity never spawned, or pickup walk failed. ` +
                `DO NOT chat success — the inventory is the source of truth.`
            );
        }
        // Don't bot.chat — the skill or critic will see the throw.
        throw new Error(
            `mineBlock ${name} x${count}: inventory gained ${_deltaName} ${_dropLabel} ` +
            `(${_beforeName}→${_afterName}) and ${_deltaTotal} total items ` +
            `(${_beforeTotal}→${_afterTotal}). ` +
            `Likely causes: dig was server-rejected (no LOS / out of reach), ` +
            `drop entity never spawned, or pickup walk failed. ` +
            `DO NOT chat success — the inventory is the source of truth.`
        );
    }
    bot.save(`${name}_mined`);
}
