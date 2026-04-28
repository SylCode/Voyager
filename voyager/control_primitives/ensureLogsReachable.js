async function ensureLogsReachable(bot) {
    const mcData = require("minecraft-data")(bot.version);
    const _pf = require("mineflayer-pathfinder");
    const _Movements = _pf.Movements;
    const _GoalNear = _pf.goals.GoalNear;
    const _naturalGroundNames = new Set([
        "dirt",
        "grass_block",
        "coarse_dirt",
        "rooted_dirt",
        "podzol",
        "mycelium",
        "moss_block",
        "mud",
        "sand",
        "red_sand",
        "snow_block",
        "gravel",
        "clay",
    ]);
    const _hazardNames = new Set([
        "lava",
        "flowing_lava",
        "fire",
        "soul_fire",
        "campfire",
        "soul_campfire",
        "magma_block",
        "cactus",
        "sweet_berry_bush",
        "wither_rose",
    ]);
    const _isSolidGround = (block) => {
        return !!(
            block &&
            block.name &&
            block.name !== "air" &&
            block.name !== "water" &&
            block.name !== "lava" &&
            block.boundingBox === "block"
        );
    };
    const _findSolidSupportBelow = (maxDepth = 6) => {
        if (!bot.entity) return null;
        for (let depth = 0; depth <= maxDepth; depth++) {
            const support = bot.blockAt(bot.entity.position.offset(0, -0.5 - depth, 0));
            if (_isSolidGround(support)) return support;
        }
        return null;
    };
    const _stabilizeGrounding = async () => {
        try {
            if (!bot.entity) return false;
            if (bot.entity.isInWater || bot.entity.isInLava) {
                console.log("[ensureLogsReachable] grounding skip: in liquid");
                return false;
            }
            const support = _findSolidSupportBelow();
            if (!support) {
                console.log("[ensureLogsReachable] grounding skip: no solid support below");
                return false;
            }
            const groundedY = support.position.y + 1;
            // If the nearest recognised-solid floor is > 2 blocks below the
            // actual server position, the bot is standing on Forge-modded blocks
            // that mineflayer doesn't recognise.  Teleporting to groundedY would
            // drop the bot into lava/fire inside that modded layer and kill it.
            // Instead, keep the actual server position and just set onGround=true.
            const _snapY = (bot.entity.position.y - groundedY > 2)
                ? bot.entity.position.y
                : groundedY;
            bot.entity.position.set(
                bot.entity.position.x,
                _snapY,
                bot.entity.position.z
            );
            bot.entity.velocity.set(0, 0, 0);
            bot.entity.onGround = true;
            try {
                bot._client.write("position", {
                    x: bot.entity.position.x,
                    y: bot.entity.position.y,
                    z: bot.entity.position.z,
                    onGround: true,
                    flags: {
                        onGround: true,
                        hasHorizontalCollision: undefined,
                    },
                });
            } catch (_e) {}
            await bot.waitForTicks(2).catch(() => {});
            console.log(
                `[ensureLogsReachable] stabilized grounding at ${bot.entity.position} ` +
                `support=${support.name}@${support.position}`
            );
            return true;
        } catch (_e) {
            console.log(`[ensureLogsReachable] grounding stabilize failed: ${_e && _e.message ? _e.message : _e}`);
            return false;
        }
    };
    const _decorMarker = (block) => {
        return !!(
            block &&
            block.name &&
            (
                block.name.endsWith("_wool") ||
                block.name.endsWith("_sign") ||
                block.name.endsWith("_glazed_terracotta") ||
                block.name === "note_block" ||
                block.name === "jukebox" ||
                block.name === "fire" ||
                block.name === "campfire" ||
                block.name === "soul_campfire"
            )
        );
    };
    const _logMatcher = (block) => {
        return !!(
            block &&
            block.name &&
            /(_log|_wood|_stem|_hyphae)$/.test(block.name) &&
            !block.name.startsWith("stripped_")
        );
    };
    const _decorNearby = (radius = 16) => {
        return bot.findBlocks({
            matching: (block) => _decorMarker(block),
            maxDistance: radius,
            count: 32,
        }).length > 0;
    };
    const _decorScoreAt = (position) => {
        if (!position) return 999;
        let _score = 0;
        for (let _dy = -1; _dy <= 2; _dy++) {
            for (let _dx = -4; _dx <= 4; _dx++) {
                for (let _dz = -4; _dz <= 4; _dz++) {
                    const _block = bot.blockAt(position.offset(_dx, _dy, _dz));
                    if (!_block || !_block.name) continue;
                    if (_decorMarker(_block)) _score += 2;
                    if (_hazardNames.has(_block.name)) _score += 2;
                    if (_block.name.endsWith("_wood")) _score += 1;
                }
            }
        }
        return _score;
    };
    const _hasNearbyHazard = (position) => {
        if (!position) return true;
        for (let _dy = -1; _dy <= 1; _dy++) {
            for (let _dx = -2; _dx <= 2; _dx++) {
                for (let _dz = -2; _dz <= 2; _dz++) {
                    const _block = bot.blockAt(position.offset(_dx, _dy, _dz));
                    if (_block && _hazardNames.has(_block.name)) return true;
                }
            }
        }
        return false;
    };
    const _hasStandingRoom = (groundPosition) => {
        if (!groundPosition) return false;
        const _above = bot.blockAt(groundPosition.offset(0, 1, 0));
        const _above2 = bot.blockAt(groundPosition.offset(0, 2, 0));
        const _headroom1 = !_above || _above.boundingBox === "empty";
        const _headroom2 = !_above2 || _above2.boundingBox === "empty";
        return _headroom1 && _headroom2 && !_hasNearbyHazard(groundPosition.offset(0, 1, 0));
    };
    const _isEscapeSurface = (block) => {
        return !!(
            block &&
            block.name &&
            block.boundingBox === "block" &&
            !_hazardNames.has(block.name) &&
            !_decorMarker(block) &&
            !block.name.endsWith("_wood")
        );
    };
    const _isClearEnoughPosition = (position) => {
        return !!position && !_hasNearbyHazard(position);
    };
    const _canUseLocalLog = (block) => {
        if (!block || !block.position) return false;
        // Reject logs that are more than 4 blocks below the bot's local (possibly
        // hacked) position — likely underground and unreachable by pathfinder.
        // Threshold = 4 so that a log at y=60 is rejected when bot.entity.position.y
        // is 65 (support.y+1 from _stabilizeGrounding): 60 < 65-4=61 → filtered out.
        if (block.position.y < bot.entity.position.y - 4) return false;
        // Also reject canopy logs the bot can't physically reach without bridging.
        // Server reach is 4.5 blocks; allow some pathfinder slack but anything
        // more than 5 blocks above the bot's head requires building scaffolding,
        // which the bot can't do. Targeting unreachable canopy causes infinite
        // FAST-PATH retry loops on Forge platforms over lava.
        if (block.position.y > bot.entity.position.y + 5) return false;
        return true;
    };
    // Quick pathfinder probe: verify the bot can actually navigate to the log.
    // Prevents ensureLogsReachable from returning true when the log is visible
    // from the platform but blocked by terrain (lava, height gap, etc.).
    const _isPathfinderReachable = (block) => {
        if (!block || !block.position) return false;
        const _dist = block.position.distanceTo(bot.entity.position);
        if (_dist <= 4.5) return true; // in swing range — no navigation needed
        try {
            const _pf = require("mineflayer-pathfinder");
            const _moves = new _pf.Movements(bot, mcData);
            _moves.canDig = true;
            _moves.allowParkour = true;
            _moves.allow1by1towers = true;
            const _softNames = new Set([
                "dirt", "grass_block", "sand", "gravel", "coarse_dirt",
                "rooted_dirt", "podzol", "mycelium", "moss_block", "snow",
                "snow_block", "clay", "farmland",
            ]);
            _moves.blocksCantBreak = new Set();
            for (const _bn in mcData.blocksByName) {
                const _bid = mcData.blocksByName[_bn].id;
                const _isLeaves = _bn.endsWith("_leaves") || _bn.endsWith("_leaf");
                if (!_softNames.has(_bn) && !_isLeaves) _moves.blocksCantBreak.add(_bid);
            }
            const _savedOG = bot.entity.onGround;
            if (!bot.entity.onGround) bot.entity.onGround = true;
            const _goal = new _pf.goals.GoalNear(block.position.x, block.position.y + 1, block.position.z, 1);
            const _res = bot.pathfinder.getPathTo(_moves, _goal, 3000);
            bot.entity.onGround = _savedOG;
            const _ok = !!(
                _res && _res.status === "success" &&
                _res.path && _res.path.length > 0 && _res.path.length <= 300
            );
            console.log(`[ensureLogsReachable] pathProbe block=${block.name}@(${block.position.x},${block.position.y},${block.position.z}) dist=${_dist.toFixed(1)} status=${_res ? _res.status : 'null'} pathLen=${_res && _res.path ? _res.path.length : 0} ok=${_ok}`);
            return _ok;
        } catch (_e) {
            return false;
        }
    };
    const _rankLogs = (blocks) => {
        const _botPos = bot.entity.position;
        const _support = _findSolidSupportBelow();
        const _minLogY = _support ? _support.position.y - 8 : _botPos.y - 12;
        return blocks
            .filter((block) => {
                return !!(
                    block &&
                    block.position &&
                    block.position.y >= _minLogY
                );
            })
            .sort((a, b) => {
                const _aScore = _decorScoreAt(a.position);
                const _bScore = _decorScoreAt(b.position);
                if (_aScore !== _bScore) return _aScore - _bScore;
                const _aVisible = (() => {
                    try {
                        return bot.canSeeBlock(a) ? 1 : 0;
                    } catch (_e) {
                        return 0;
                    }
                })();
                const _bVisible = (() => {
                    try {
                        return bot.canSeeBlock(b) ? 1 : 0;
                    } catch (_e) {
                        return 0;
                    }
                })();
                if (_aVisible !== _bVisible) return _bVisible - _aVisible;
                return a.position.distanceTo(_botPos) - b.position.distanceTo(_botPos);
            });
    };
    const _scanLogs = (radius) => {
        return _rankLogs(
            bot.findBlocks({
                matching: (block) => _logMatcher(block),
                maxDistance: radius,
                count: 64,
            }).map((pos) => bot.blockAt(pos))
        );
    };
    const _pickDir = () => {
        const _opts = [-1, 0, 1];
        for (let _i = 0; _i < 10; _i++) {
            const _dx = _opts[Math.floor(Math.random() * 3)];
            const _dz = _opts[Math.floor(Math.random() * 3)];
            if (_dx !== 0 || _dz !== 0) {
                return new Vec3(_dx, 0, _dz);
            }
        }
        return new Vec3(1, 0, 0);
    };
    const _moveNear = async (target) => {
        if (!target || !target.position) return false;
        const _prevMovements = bot.pathfinder.movements;
        const _moves = new _Movements(bot, mcData);
        _moves.canDig = true;
        _moves.allow1by1towers = true;
        _moves.allowParkour = true;
        _moves.scafoldingBlocks = [
            "dirt",
            "sand",
            "gravel",
            "coarse_dirt",
            "rooted_dirt",
            "podzol",
            "mycelium",
            "grass_block",
        ]
            .map((name) => mcData.blocksByName[name] && mcData.blocksByName[name].id)
            .filter((id) => typeof id === "number");
        let _moveNearTimeoutHandle;
        const _forceOnGroundMN = () => { bot.entity.onGround = true; };
        bot.on("physicsTick", _forceOnGroundMN);
        try {
            bot.pathfinder.setMovements(_moves);
            // If bot is floating (modded platform not recognised by mineflayer),
            // mark onGround=true so pathfinder's initial getPathTo has a valid
            // start node.  We stay at the actual server position — do NOT snap
            // to a lower solid block because that layer may contain lava/fire.
            if (!bot.entity.onGround) {
                bot.entity.onGround = true;
            }
            await Promise.race([
                bot.pathfinder.goto(new _GoalNear(target.position.x, target.position.y, target.position.z, 2)),
                new Promise((_, reject) => {
                    _moveNearTimeoutHandle = setTimeout(() => {
                        bot.pathfinder.setGoal(null);
                        reject(new Error("GoalNear timed out"));
                    }, 15000);
                }),
            ]);
            return true;
        } catch (_e) {
            return false;
        } finally {
            if (_moveNearTimeoutHandle !== undefined) clearTimeout(_moveNearTimeoutHandle);
            if (_prevMovements) bot.pathfinder.setMovements(_prevMovements);
            else bot.pathfinder.setMovements(new _Movements(bot, mcData));
            bot.removeListener("physicsTick", _forceOnGroundMN);
        }
    };
    const _gotoWithProgressGuard = async (goalFactory, hardTimeoutMs, stallTimeoutMs = 4000) => {
        let _lastProgressAt = Date.now();
        let _lastPosition = bot.entity.position.clone();
        let _stallInterval = null;
        let _gotoTimeoutHandle;
        const _forceOnGroundGoto = () => { bot.entity.onGround = true; };
        bot.on("physicsTick", _forceOnGroundGoto);
        try {
            // If floating (modded platform), just set onGround=true so pathfinder
            // can compute a start node. Stay at actual server position.
            if (!bot.entity.onGround) {
                bot.entity.onGround = true;
            }
            await Promise.race([
                bot.pathfinder.goto(goalFactory()),
                new Promise((_, reject) => {
                    _stallInterval = setInterval(() => {
                        const _currentPosition = bot.entity.position;
                        if (_currentPosition.distanceTo(_lastPosition) >= 0.5) {
                            _lastPosition = _currentPosition.clone();
                            _lastProgressAt = Date.now();
                            return;
                        }
                        if (Date.now() - _lastProgressAt >= stallTimeoutMs) {
                            bot.pathfinder.setGoal(null);
                            reject(new Error("GoalNear stalled"));
                        }
                    }, 500);
                }),
                new Promise((_, reject) => {
                    _gotoTimeoutHandle = setTimeout(() => {
                        bot.pathfinder.setGoal(null);
                        reject(new Error("GoalNear timed out"));
                    }, hardTimeoutMs);
                }),
            ]);
            return true;
        } catch (_e) {
            console.log(`[ensureLogsReachable] goto failed: ${_e && _e.message ? _e.message : _e}`);
            return false;
        } finally {
            if (_stallInterval) clearInterval(_stallInterval);
            if (_gotoTimeoutHandle !== undefined) clearTimeout(_gotoTimeoutHandle);
            bot.removeListener("physicsTick", _forceOnGroundGoto);
        }
    };
    const _isDiggableEscapeBlock = (block) => {
        return !!(
            block &&
            block.name &&
            block.boundingBox === "block" &&
            block.diggable !== false &&
            block.name !== "bedrock" &&
            !_hazardNames.has(block.name)
        );
    };
    const _tryLocalEscapeStep = async () => {
        const _origin = bot.entity.position.clone();
        const _originBlock = _origin.floored();
        const _originScore = _decorScoreAt(_originBlock);
        const _support = _findSolidSupportBelow();
        const _supportY = _support ? _support.position.y + 1 : _originBlock.y;
        const _dirs = [
            { _dx: 1, _dz: 0, _label: "east" },
            { _dx: -1, _dz: 0, _label: "west" },
            { _dx: 0, _dz: 1, _label: "south" },
            { _dx: 0, _dz: -1, _label: "north" },
            { _dx: 1, _dz: 1, _label: "southeast" },
            { _dx: 1, _dz: -1, _label: "northeast" },
            { _dx: -1, _dz: 1, _label: "southwest" },
            { _dx: -1, _dz: -1, _label: "northwest" },
        ];
        for (const _dir of _dirs) {
            const _targets = [];
            const _seenTargets = new Set();
            const _eyePosition = bot.entity.position.offset(0, 1.6, 0);
            let _dugSomething = false;
            for (let _y = _originBlock.y + 1; _y >= _supportY - 1; _y--) {
                const _candidate = bot.blockAt(new Vec3(
                    _originBlock.x + _dir._dx,
                    _y,
                    _originBlock.z + _dir._dz
                ));
                if (!_isDiggableEscapeBlock(_candidate)) continue;
                const _candidateCenter = _candidate.position.offset(0.5, 0.5, 0.5);
                if (_candidateCenter.distanceTo(_eyePosition) > 5.25) continue;
                const _key = `${_candidate.position.x},${_candidate.position.y},${_candidate.position.z}`;
                if (_seenTargets.has(_key)) continue;
                _seenTargets.add(_key);
                _targets.push(_candidate);
            }
            try {
                for (const _target of _targets) {
                    console.log(`[ensureLogsReachable] local escape dig ${_target.name} ${_dir._label} at ${_target.position}`);
                    await bot.lookAt(_target.position.offset(0.5, 0.5, 0.5), true);
                    await Promise.race([
                        bot.dig(_target),
                        new Promise((_, reject) => setTimeout(() => {
                            try {
                                if (typeof bot.stopDigging === "function") bot.stopDigging();
                            } catch (_stopErr) {}
                            reject(new Error("local escape dig timed out"));
                        }, 12000)),
                    ]);
                    console.log(`[ensureLogsReachable] local escape dig finished ${_target.name} ${_dir._label} at ${_target.position}`);
                    _dugSomething = true;
                    break;
                }
            } catch (_e) {
                console.log(`[ensureLogsReachable] local escape dig failed ${_dir._label}: ${_e && _e.message ? _e.message : _e}`);
            }
            try {
                const _yaw = Math.atan2(-_dir._dx, -_dir._dz);
                await bot.look(_yaw, 0, true);
                bot.setControlState("forward", true);
                bot.setControlState("jump", true);
                await bot.waitForTicks(8);
            } catch (_e) {
                console.log(`[ensureLogsReachable] local escape nudge failed ${_dir._label}: ${_e && _e.message ? _e.message : _e}`);
            } finally {
                bot.setControlState("forward", false);
                bot.setControlState("jump", false);
            }
            if (
                (bot.entity.position.distanceTo(_origin) >= 0.75 ||
                    bot.entity.position.y >= _origin.y + 1) &&
                (_isClearEnoughPosition(bot.entity.position.floored()) ||
                    _decorScoreAt(bot.entity.position.floored()) < _originScore)
            ) {
                console.log(`[ensureLogsReachable] local escape moved to ${bot.entity.position}`);
                return true;
            }
            if (_dugSomething) {
                console.log(`[ensureLogsReachable] local escape opened ${_dir._label} without immediate relocation`);
                return false;
            }
        }
        console.log(`[ensureLogsReachable] local escape made no meaningful progress from ${_origin}`);
        return false;
    };
    const _collectEscapeCandidates = (_originScore) => {
        const _allCandidates = bot.findBlocks({
            matching: (block) => _isEscapeSurface(block),
            maxDistance: 64,
            count: 512,
        }).map((pos) => bot.blockAt(pos)).filter((block) => {
            return !!(
                block &&
                block.position &&
                block.position.y >= bot.entity.position.y - 2 &&
                block.position.distanceTo(bot.entity.position) >= 2 &&
                _decorScoreAt(block.position) < _originScore &&
                _hasStandingRoom(block.position)
            );
        });
        const _preferredCandidates = _allCandidates.filter((block) => {
            return block.position.distanceTo(bot.entity.position) <= 16;
        });
        const _nearLevelCandidates = _allCandidates.filter((block) => {
            return Math.abs(block.position.y - bot.entity.position.y) <= 2;
        });
        const _nearLevelPreferred = _nearLevelCandidates.filter((block) => {
            return block.position.distanceTo(bot.entity.position) <= 16;
        });
        const _candidatePool =
            (_nearLevelPreferred.length > 0 && _nearLevelPreferred) ||
            (_nearLevelCandidates.length > 0 && _nearLevelCandidates) ||
            (_preferredCandidates.length > 0 && _preferredCandidates) ||
            _allCandidates;
        const _candidates = _candidatePool.sort((a, b) => {
            const _aHeight = Math.abs(a.position.y - bot.entity.position.y);
            const _bHeight = Math.abs(b.position.y - bot.entity.position.y);
            if (_aHeight !== _bHeight) return _aHeight - _bHeight;
            const _aDist = a.position.distanceTo(bot.entity.position);
            const _bDist = b.position.distanceTo(bot.entity.position);
            if (Math.abs(_aDist - _bDist) > 1) return _aDist - _bDist;
            const _aScore = _decorScoreAt(a.position);
            const _bScore = _decorScoreAt(b.position);
            return _aScore - _bScore;
        });
        return {
            _allCandidates,
            _nearLevelCandidates,
            _candidates,
        };
    };
    const _tryDirectEscapeNudge = async (_destination) => {
        if (!_destination || !_destination.position) return false;
        const _origin = bot.entity.position.clone();
        const _originBlock = _origin.floored();
        let _bestPosition = _origin;
        for (let _burst = 1; _burst <= 3; _burst++) {
            try {
                bot.pathfinder.setGoal(null);
                await bot.lookAt(_destination.position.offset(0.5, 0.5, 0.5), true);
                bot.setControlState("forward", true);
                bot.setControlState("jump", true);
                await bot.waitForTicks(12);
            } catch (_e) {
                console.log(`[ensureLogsReachable] direct escape nudge failed: ${_e && _e.message ? _e.message : _e}`);
                break;
            } finally {
                bot.setControlState("forward", false);
                bot.setControlState("jump", false);
            }
            const _currentPosition = bot.entity.position.clone();
            if (_currentPosition.distanceTo(_origin) > _bestPosition.distanceTo(_origin)) {
                _bestPosition = _currentPosition;
            }
            const _currentBlock = _currentPosition.floored();
            const _movedEnough =
                _currentPosition.distanceTo(_origin) >= 1.1 ||
                _currentBlock.x !== _originBlock.x ||
                _currentBlock.z !== _originBlock.z;
            if (_movedEnough) {
                console.log(
                    `[ensureLogsReachable] direct escape nudge moved to ${_currentPosition} ` +
                    `toward ${_destination.position} in ${_burst} burst(s)`
                );
                return true;
            }
            if (_burst < 3) {
                await bot.waitForTicks(2);
            }
        }
        const _bestDelta = _bestPosition.distanceTo(_origin);
        if (_bestDelta >= 0.35) {
            console.log(
                `[ensureLogsReachable] direct escape nudge fell short at ${_bestPosition} ` +
                `toward ${_destination.position} delta=${_bestDelta.toFixed(2)}`
            );
        }
        return false;
    };
    const _escapeDecorativePocket = async () => {
        await _stabilizeGrounding();
        let _origin = bot.entity.position.floored();
        let _originScore = _decorScoreAt(_origin);
        if (_originScore <= 0) return false;
        let { _nearLevelCandidates, _candidates } = _collectEscapeCandidates(_originScore);
        const _ensureNearLevelEscapeCandidates = async (_phase) => {
            if (
                _nearLevelCandidates.length === 0 &&
                _candidates.length > 0 &&
                Math.abs(_candidates[0].position.y - bot.entity.position.y) > 3
            ) {
                for (let _round = 1; _round <= 3; _round++) {
                    console.log(`[ensureLogsReachable] ${_phase} no near-level escape surfaces; trying local escape step ${_round}/3 first`);
                    const _moved = await _tryLocalEscapeStep();
                    ({ _nearLevelCandidates, _candidates } = _collectEscapeCandidates(_originScore));
                    if (_nearLevelCandidates.length > 0 || _moved) break;
                }
                if (_nearLevelCandidates.length === 0) {
                    console.log(`[ensureLogsReachable] ${_phase} still no near-level escape surfaces after local escape steps`);
                    return false;
                }
            }
            return true;
        };
        if (!(await _ensureNearLevelEscapeCandidates("initial"))) {
            console.log("[ensureLogsReachable] deferring to exploration");
            return false;
        }
        console.log(`[ensureLogsReachable] escape origin=${_origin.x},${_origin.y},${_origin.z} originScore=${_originScore} candidates=${_candidates.length}`);
        const _prevMovements = bot.pathfinder.movements;
        const _moves = new _Movements(bot, mcData);
        _moves.canDig = true;
        _moves.allow1by1towers = true;
        _moves.allowParkour = true;
        try {
            bot.pathfinder.setMovements(_moves);
            let _attempt = 0;
            let _totalAttempts = 0;
            let _candidateIndex = 0;
            let _stalledAttempts = 0;
            const _forceLocalEscapeIfStalled = async (_reason) => {
                if (_stalledAttempts < 3) return false;
                console.log(
                    `[ensureLogsReachable] forcing local escape after ${_stalledAttempts} stalled attempts (${_reason})`
                );
                _stalledAttempts = 0;
                await _stabilizeGrounding();
                const _movedLocally = await _tryLocalEscapeStep();
                const _nudgedDirectly = !_movedLocally && _candidates.length > 0
                    ? await _tryDirectEscapeNudge(_candidates[0])
                    : false;
                const _currentPosition = bot.entity.position.floored();
                const _currentScore = _decorScoreAt(_currentPosition);
                const _movedEnough =
                    _currentPosition.distanceTo(_origin) >= 1.5 ||
                    _currentPosition.x !== _origin.x ||
                    _currentPosition.z !== _origin.z;
                if (_isClearEnoughPosition(_currentPosition) && (_movedLocally || _nudgedDirectly || _movedEnough)) {
                    console.log(`[ensureLogsReachable] escape success after forced local escape at ${_currentPosition}`);
                    return true;
                }
                if (_currentScore < _originScore && _movedEnough) {
                    console.log(
                        `[ensureLogsReachable] forced local escape improved score at ` +
                        `${_currentPosition} score=${_currentScore}`
                    );
                    _origin = _currentPosition.clone ? _currentPosition.clone() : _currentPosition;
                    _originScore = _currentScore;
                }
                ({ _nearLevelCandidates, _candidates } = _collectEscapeCandidates(_originScore));
                if (!(await _ensureNearLevelEscapeCandidates("forced-local"))) {
                    console.log("[ensureLogsReachable] forced local escape still lacks practical surfaces; deferring to exploration");
                    return false;
                }
                _attempt = 0;
                _candidateIndex = 0;
                return false;
            };
            while (_totalAttempts < 36 && _candidateIndex < _candidates.length) {
                const _destination = _candidates[_candidateIndex++];
                _attempt += 1;
                _totalAttempts += 1;
                try {
                    console.log(
                        `[ensureLogsReachable] escape attempt ${_attempt}/${Math.min(_candidates.length, 12)} ` +
                        `dest=${_destination.position.x},${_destination.position.y},${_destination.position.z} ` +
                        `dist=${_destination.position.distanceTo(bot.entity.position).toFixed(2)} ` +
                        `score=${_decorScoreAt(_destination.position)}`
                    );
                    const _reached = await _gotoWithProgressGuard(
                        () => new _GoalNear(_destination.position.x, _destination.position.y + 1, _destination.position.z, 1),
                        12000,
                        3500
                    );
                    if (!_reached) {
                        _stalledAttempts += 1;
                        if (await _forceLocalEscapeIfStalled("path failure")) {
                            return true;
                        }
                        continue;
                    }
                    const _currentPosition = bot.entity.position.floored();
                    const _currentScore = _decorScoreAt(_currentPosition);
                    const _movedEnough =
                        _currentPosition.distanceTo(_origin) >= 1.5 ||
                        _currentPosition.x !== _origin.x ||
                        _currentPosition.z !== _origin.z;
                    if (_currentScore < _originScore && _movedEnough) {
                        _stalledAttempts = 0;
                        if (_isClearEnoughPosition(_currentPosition)) {
                            console.log(`[ensureLogsReachable] escape success after ${_attempt} attempts at ${_currentPosition}`);
                            return true;
                        }
                        console.log(
                            `[ensureLogsReachable] partial escape progress after ${_attempt} attempts at ` +
                            `${_currentPosition} score=${_currentScore}, but area is still decorative`
                        );
                        _origin = _currentPosition.clone ? _currentPosition.clone() : _currentPosition;
                        _originScore = _currentScore;
                        ({ _nearLevelCandidates, _candidates } = _collectEscapeCandidates(_originScore));
                        if (!(await _ensureNearLevelEscapeCandidates("rebased"))) {
                            console.log("[ensureLogsReachable] rebased escape search still lacks practical surfaces; deferring to exploration");
                            return false;
                        }
                        _attempt = 0;
                        _candidateIndex = 0;
                    } else if (_currentScore < _originScore) {
                        _stalledAttempts += 1;
                        console.log(
                            `[ensureLogsReachable] ignoring score drop without meaningful relocation at ` +
                            `${_currentPosition} score=${_currentScore} origin=${_origin}`
                        );
                        if (await _forceLocalEscapeIfStalled("score drop without relocation")) {
                            return true;
                        }
                    } else if (!_movedEnough) {
                        _stalledAttempts += 1;
                        if (await _forceLocalEscapeIfStalled("no meaningful relocation")) {
                            return true;
                        }
                    } else {
                        _stalledAttempts = 0;
                    }
                } catch (_e) {
                    console.log(`[ensureLogsReachable] escape attempt ${_attempt} threw: ${_e && _e.message ? _e.message : _e}`);
                }
            }
            console.log(`[ensureLogsReachable] escape exhausted candidates without progress`);
            return false;
        } catch (_e) {
            console.log(`[ensureLogsReachable] escape failed before attempts: ${_e && _e.message ? _e.message : _e}`);
            return false;
        } finally {
            if (_prevMovements) bot.pathfinder.setMovements(_prevMovements);
            else bot.pathfinder.setMovements(new _Movements(bot, mcData));
        }
    };
    const _tryExplore = async (attempts = 3, maxTime = 60) => {
        for (let _i = 0; _i < attempts; _i++) {
            await _stabilizeGrounding();
            try {
                const _found = await exploreUntil(bot, _pickDir(), maxTime, () => {
                    const _local = _scanLogs(32)[0] || _scanLogs(48)[0] || null;
                    return _canUseLocalLog(_local) ? _local : null;
                });
                if (_found) return true;
            } catch (_e) {
                // Try another direction.
            }
            const _local = _scanLogs(32)[0] || _scanLogs(48)[0] || null;
            if (_canUseLocalLog(_local)) return true;
        }
        return false;
    };

    await _stabilizeGrounding();

    // ── SURFACE ESCAPE ────────────────────────────────────────────────────────
    // If the bot is underground, local logs found by findBlocks are cave
    // decorations that mineBlock cannot navigate to.  Climb to the surface
    // first so the subsequent log scan targets real trees.
    const _SURFACE_Y = 60;
    const _surfaceEscape = async () => {
        const { goals: { GoalY, GoalXZ } } = require('mineflayer-pathfinder');
        const _prevSurfMov = bot.pathfinder.movements;
        const _runGoalY = async (targetY, canDig, timeout) => {
            const _m = new _Movements(bot, mcData);
            _m.canDig = canDig;
            _m.allow1by1towers = canDig;
            _m.allowParkour = true;
            bot.pathfinder.setMovements(_m);
            return new Promise((resolve, reject) => {
                const _t = setTimeout(() => {
                    bot.pathfinder.setGoal(null);
                    reject(new Error(`GoalY(${targetY}) canDig=${canDig} timed out after ${timeout}ms`));
                }, timeout);
                bot.pathfinder.goto(new GoalY(targetY))
                    .then(() => { clearTimeout(_t); resolve(); })
                    .catch((e) => { clearTimeout(_t); reject(e); });
            });
        };
        try {
            // Tier 1: natural passages only, 60s
            await _runGoalY(_SURFACE_Y, false, 60000);
            await _stabilizeGrounding();
            if (bot.entity.position.y >= _SURFACE_Y) {
                console.log(`[ensureLogsReachable] surface escape tier1 succeeded y=${bot.entity.position.y.toFixed(1)}`);
                return;
            }
        } catch (_e1) {
            console.log(`[ensureLogsReachable] surface tier1 failed: ${_e1 && _e1.message}`);
        } finally {
            if (_prevSurfMov) bot.pathfinder.setMovements(_prevSurfMov);
        }
        // Tier 2: dig/place blocks, incremental Y goals, 90s total
        try {
            const _m2 = new _Movements(bot, mcData);
            _m2.canDig = true;
            _m2.allow1by1towers = true;
            _m2.allowParkour = true;
            bot.pathfinder.setMovements(_m2);
            const _steps = [0, 20, 40, _SURFACE_Y];
            for (const _stepY of _steps) {
                if (bot.entity.position.y >= _SURFACE_Y) break;
                if (_stepY <= bot.entity.position.y) continue;
                await new Promise((resolve, reject) => {
                    const _t = setTimeout(() => {
                        bot.pathfinder.setGoal(null);
                        reject(new Error(`GoalY(${_stepY}) step timed out`));
                    }, 30000);
                    bot.pathfinder.goto(new GoalY(_stepY))
                        .then(() => { clearTimeout(_t); resolve(); })
                        .catch((e) => { clearTimeout(_t); reject(e); });
                }).catch((_e) => console.log(`[ensureLogsReachable] step GoalY(${_stepY}): ${_e && _e.message}`));
            }
            await _stabilizeGrounding();
            if (bot.entity.position.y >= _SURFACE_Y) {
                console.log(`[ensureLogsReachable] surface escape tier2 succeeded y=${bot.entity.position.y.toFixed(1)}`);
                return;
            }
        } catch (_e2) {
            console.log(`[ensureLogsReachable] surface tier2 failed: ${_e2 && _e2.message}`);
        } finally {
            if (_prevSurfMov) bot.pathfinder.setMovements(_prevSurfMov);
        }
        // Tier 3: use /home (allowed server command) — bot is trapped with no blocks/pickaxe
        console.log(`[ensureLogsReachable] surface tier3: /home at y=${bot.entity.position.y.toFixed(1)}`);
        try {
            bot.chat('/home');
            // Wait for teleport to take effect
            await new Promise(r => setTimeout(r, 3000));
            await _stabilizeGrounding();
            console.log(`[ensureLogsReachable] surface tier3 /home done y=${bot.entity.position.y.toFixed(1)}`);
        } catch (_e3) {
            console.log(`[ensureLogsReachable] surface tier3 failed: ${_e3 && _e3.message}`);
            // Last resort: /spawn
            try {
                bot.chat('/spawn');
                await new Promise(r => setTimeout(r, 3000));
                await _stabilizeGrounding();
                console.log(`[ensureLogsReachable] surface tier3 /spawn done y=${bot.entity.position.y.toFixed(1)}`);
            } catch (_e4) {}
        }
    };
    if (bot.entity.position.y < _SURFACE_Y) {
        console.log(`[ensureLogsReachable] underground at y=${bot.entity.position.y.toFixed(1)} — attempting surface escape to y=${_SURFACE_Y}`);
        await _surfaceEscape();
        console.log(`[ensureLogsReachable] after escape: y=${bot.entity.position.y.toFixed(1)}`);
    }

    // FAST PATH: if a natural-looking log is visible within 24 blocks, trust
    // mineBlock to handle approach.  The strict pathfinder probe below was
    // rejecting reachable logs (returning probe-reachable count=0) on Forge
    // platforms, causing the bot to "explore for wood" while real logs sit
    // 6 blocks away.  Just return true and let the mining primitive decide.
    // Skip fast-path when still underground — cave logs look reachable but aren't.
    {
        const _fast16 = _scanLogs(16);
        const _fast24 = _scanLogs(24);
        const _fast = _fast16[0] || _fast24[0] || null;
        const _aboveSurface = bot.entity.position.y >= _SURFACE_Y;
        console.log(`[ensureLogsReachable] FAST-PATH probe scan16=${_fast16.length} scan24=${_fast24.length} pick=${_fast ? _fast.name + '@(' + _fast.position.x + ',' + _fast.position.y + ',' + _fast.position.z + ')' : 'null'} canUse=${_fast ? _canUseLocalLog(_fast) : 'n/a'} aboveSurface=${_aboveSurface}`);
        if (_fast && _canUseLocalLog(_fast) && _aboveSurface) {
            try {
                const _vis = bot.canSeeBlock(_fast);
                console.log(`[ensureLogsReachable] FAST-PATH log ${_fast.name}@(${_fast.position.x},${_fast.position.y},${_fast.position.z}) dist=${_fast.position.distanceTo(bot.entity.position).toFixed(1)} visible=${_vis} — skipping probe`);
            } catch (_e) {}
            return true;
        }
    }

    let _target = _scanLogs(32)[0] || _scanLogs(48)[0] || null;
    if (_target) {
        if (_canUseLocalLog(_target) && _isPathfinderReachable(_target)) {
            return true;
        }
        await _moveNear(_target);
        _target = _scanLogs(32)[0] || _scanLogs(48)[0] || null;
        if (_canUseLocalLog(_target) && _isPathfinderReachable(_target)) {
            return true;
        }
    }

    if (!_target) {
        _target = _scanLogs(64)[0] || _scanLogs(96)[0] || _scanLogs(128)[0] || null;
    }
    if (_target) {
        await _moveNear(_target);
        const _local = _scanLogs(32)[0] || _scanLogs(48)[0] || null;
        if (_canUseLocalLog(_local) && _isPathfinderReachable(_local)) {
            return true;
        }
    }

    bot.chat("No logs nearby; exploring for wood.");
    if (await _tryExplore(2, 20)) {
        return true;
    }
    const _lastResort = _scanLogs(48)[0] || _scanLogs(64)[0] || null;
    return !!(_lastResort && _canUseLocalLog(_lastResort) && _isPathfinderReachable(_lastResort));
}