from __future__ import annotations

import random
import re

import voyager.utils as U
from voyager.prompts import load_prompt
from voyager.utils.json_utils import fix_and_parse_json
from langchain.chat_models import ChatOpenAI
from langchain.embeddings.openai import OpenAIEmbeddings
from langchain.schema import HumanMessage, SystemMessage
from langchain.vectorstores import Chroma


class CurriculumAgent:
    def __init__(
        self,
        model_name="gpt-3.5-turbo",
        temperature=0,
        qa_model_name="gpt-3.5-turbo",
        qa_temperature=0,
        request_timout=120,
        ckpt_dir="ckpt",
        resume=False,
        mode="auto",
        warm_up=None,
        core_inventory_items: str | None = None,
    ):
        self.llm = ChatOpenAI(
            model_name=model_name,
            temperature=temperature,
            request_timeout=request_timout,
        )
        self.qa_llm = ChatOpenAI(
            model_name=qa_model_name,
            temperature=qa_temperature,
            request_timeout=request_timout,
        )
        assert mode in [
            "auto",
            "manual",
        ], f"mode {mode} not supported"
        self.mode = mode
        self.ckpt_dir = ckpt_dir
        U.f_mkdir(f"{ckpt_dir}/curriculum/vectordb")
        if resume:
            print(f"\033[35mLoading Curriculum Agent from {ckpt_dir}/curriculum\033[0m")
            self.completed_tasks = U.load_json(
                f"{ckpt_dir}/curriculum/completed_tasks.json"
            )
            self.failed_tasks = U.load_json(f"{ckpt_dir}/curriculum/failed_tasks.json")
            # Deduplicate on load in case a previous run accumulated duplicates
            _seen_load: set = set()
            _trimmed_load = []
            for _t in self.failed_tasks:
                _k = _t.strip().lower()
                if _k not in _seen_load:
                    _seen_load.add(_k)
                    _trimmed_load.append(_t)
            self.failed_tasks = _trimmed_load
            self.qa_cache = U.load_json(f"{ckpt_dir}/curriculum/qa_cache.json")
        else:
            self.completed_tasks = []
            self.failed_tasks = []
            self.qa_cache = {}
        self.qa_cache_embeddings_ready = True
        # vectordb for qa cache
        self.qa_cache_questions_vectordb = Chroma(
            collection_name="qa_cache_questions_vectordb",
            embedding_function=OpenAIEmbeddings(),
            persist_directory=f"{ckpt_dir}/curriculum/vectordb",
        )
        self._sync_qa_cache_vectordb()
        # if warm up not defined, initialize it as a dict, else, initialize all the missing value as a default value
        if not warm_up:
            warm_up = self.default_warmup
        self.warm_up = {}
        if "optional_inventory_items" in warm_up:
            assert core_inventory_items is not None
            self._core_inv_items_regex = re.compile(core_inventory_items)
            self.warm_up["optional_inventory_items"] = warm_up[
                "optional_inventory_items"
            ]
        else:
            self.warm_up["optional_inventory_items"] = 0
        for key in self.curriculum_observations:
            self.warm_up[key] = warm_up.get(key, self.default_warmup[key])
        self.warm_up["nearby_blocks"] = 0
        self.warm_up["inventory"] = 0
        self.warm_up["completed_tasks"] = 0
        self.warm_up["failed_tasks"] = 0

    def _qa_vectordb_count(self):
        try:
            return self.qa_cache_questions_vectordb._collection.count()
        except Exception:
            return 0

    def _disable_qa_embeddings(self, exc, action):
        if self.qa_cache_embeddings_ready:
            print(
                f"\033[33mCurriculum Agent disabling qa embeddings after failing to {action}: {exc}\033[0m"
            )
        self.qa_cache_embeddings_ready = False

    def _sync_qa_cache_vectordb(self):
        current_count = self._qa_vectordb_count()
        if current_count == len(self.qa_cache):
            return
        print(
            f"\033[33mCurriculum Agent qa vectordb out of sync "
            f"({current_count} in db vs {len(self.qa_cache)} in qa_cache.json). "
            f"Repopulating vectordb from qa_cache.json...\033[0m"
        )
        try:
            if current_count > 0:
                existing_ids = self.qa_cache_questions_vectordb._collection.get()["ids"]
                self.qa_cache_questions_vectordb._collection.delete(ids=existing_ids)
            for question in self.qa_cache:
                self.qa_cache_questions_vectordb.add_texts(
                    texts=[question],
                    ids=[question],
                    metadatas=[{"question": question}],
                )
            self.qa_cache_questions_vectordb.persist()
            print(
                f"\033[33mRepopulated qa vectordb with {len(self.qa_cache)} entries.\033[0m"
            )
        except Exception as exc:
            self._disable_qa_embeddings(exc, "sync qa cache vectordb")

    def _find_cached_question(self, question):
        if not self.qa_cache_embeddings_ready or self._qa_vectordb_count() == 0:
            return None
        try:
            docs_and_scores = (
                self.qa_cache_questions_vectordb.similarity_search_with_score(
                    question, k=1
                )
            )
        except Exception as exc:
            self._disable_qa_embeddings(exc, "query qa cache vectordb")
            return None
        if docs_and_scores and docs_and_scores[0][1] < 0.05:
            return docs_and_scores[0][0].page_content
        return None

    def _store_cached_question(self, question):
        if not self.qa_cache_embeddings_ready:
            return
        try:
            self.qa_cache_questions_vectordb.add_texts(
                texts=[question],
                ids=[question],
                metadatas=[{"question": question}],
            )
            self.qa_cache_questions_vectordb.persist()
        except Exception as exc:
            self._disable_qa_embeddings(exc, "store qa cache question")

    @property
    def default_warmup(self):
        return {
            "context": 15,
            "biome": 10,
            "time": 15,
            "nearby_blocks": 0,
            "other_blocks": 10,
            "nearby_entities": 5,
            "health": 15,
            "hunger": 15,
            "position": 0,
            "equipment": 0,
            "inventory": 0,
            "optional_inventory_items": 7,
            "chests": 0,
            "completed_tasks": 0,
            "failed_tasks": 0,
        }

    @property
    def curriculum_observations(self):
        return [
            "context",
            "biome",
            "time",
            "nearby_blocks",
            "other_blocks",
            "nearby_entities",
            "health",
            "hunger",
            "position",
            "equipment",
            "inventory",
            "chests",
            "completed_tasks",
            "failed_tasks",
        ]

    @property
    def progress(self):
        return len(self.completed_tasks)

    def render_system_message(self):
        system_message = SystemMessage(content=load_prompt("curriculum"))
        assert isinstance(system_message, SystemMessage)
        return system_message

    def render_observation(self, *, events, chest_observation):
        assert events[-1][0] == "observe", "Last event must be observe"
        event = events[-1][1]
        biome = event["status"]["biome"]
        time_of_day = event["status"]["timeOfDay"]
        voxels = event["voxels"]
        block_records = event["blockRecords"]
        entities = event["status"]["entities"]
        health = event["status"]["health"]
        hunger = event["status"]["food"]
        position = event["status"]["position"]
        equipment = event["status"]["equipment"]
        inventory_used = event["status"]["inventoryUsed"]
        inventory = event["inventory"]

        if not any(
            "dirt" in block
            or "log" in block
            or "grass" in block
            or "sand" in block
            or "snow" in block
            for block in voxels
        ):
            biome = "underground"

        other_blocks = ", ".join(
            list(
                set(block_records).difference(set(voxels).union(set(inventory.keys())))
            )
        )

        other_blocks = other_blocks if other_blocks else "None"

        nearby_entities = (
            ", ".join([k for k, v in sorted(entities.items(), key=lambda x: x[1])])
            if entities
            else "None"
        )

        completed_tasks = (
            ", ".join(self.completed_tasks) if self.completed_tasks else "None"
        )
        failed_tasks = ", ".join(self.failed_tasks) if self.failed_tasks else "None"

        # filter out optional inventory items if required
        if self.progress < self.warm_up["optional_inventory_items"]:
            inventory = {
                k: v
                for k, v in inventory.items()
                if self._core_inv_items_regex.search(k) is not None
            }

        observation = {
            "context": "",
            "biome": f"Biome: {biome}\n\n",
            "time": f"Time: {time_of_day}\n\n",
            "nearby_blocks": f"Nearby blocks: {', '.join(voxels) if voxels else 'None'}\n\n",
            "other_blocks": f"Other blocks that are recently seen: {other_blocks}\n\n",
            "nearby_entities": f"Nearby entities: {nearby_entities}\n\n",
            "health": f"Health: {health:.1f}/20\n\n",
            "hunger": f"Hunger: {hunger:.1f}/20\n\n",
            "position": f"Position: x={position['x']:.1f}, y={position['y']:.1f}, z={position['z']:.1f}\n\n",
            "equipment": f"Equipment: {equipment}\n\n",
            "inventory": f"Inventory ({inventory_used}/36): {inventory if inventory else 'Empty'}\n\n",
            "chests": chest_observation,
            "completed_tasks": f"Completed tasks so far: {completed_tasks}\n\n",
            "failed_tasks": f"Failed tasks that are too hard: {failed_tasks}\n\n",
        }
        return observation

    def render_human_message(self, *, events, chest_observation):
        content = ""
        observation = self.render_observation(
            events=events, chest_observation=chest_observation
        )
        if self.progress >= self.warm_up["context"]:
            questions, answers = self.run_qa(
                events=events, chest_observation=chest_observation
            )
            i = 1
            for question, answer in zip(questions, answers):
                if "Answer: Unknown" in answer or "language model" in answer:
                    continue
                observation["context"] += f"Question {i}: {question}\n"
                observation["context"] += f"{answer}\n\n"
                i += 1
                if i > 5:
                    break

        for key in self.curriculum_observations:
            if self.progress >= self.warm_up[key]:
                if self.warm_up[key] != 0:
                    should_include = random.random() < 0.8
                else:
                    should_include = True
                if should_include:
                    content += observation[key]

        print(f"\033[35m****Curriculum Agent human message****\n{content}\033[0m")
        return HumanMessage(content=content)

    def propose_next_task(
        self,
        *,
        events,
        chest_observation,
        max_retries=5,
        preempt_check=None,
        home_position=None,
    ):
        if self.progress == 0 and self.mode == "auto":
            # NOTE: starter changed from "Mine 1 wood log" to "Mine 1 dirt"
            # because this server's mod set silently destroys log blocks without
            # spawning drop entities (see BLOCKING.md ISSUE-2). Dirt drops
            # reliably on hand-break and lets the curriculum get past iter 0.
            # Skip the starter task when the bot already carries a dirt-type
            # item (e.g. resumed run, or world spawn already gave us dirt) —
            # asking the LLM to "mine 1 dirt" when 32 dirt are in inventory
            # is wasteful and confuses the action agent.
            inv = events[-1][1].get("inventory", {}) if events else {}
            dirt_like = (
                "dirt",
                "grass_block",
                "coarse_dirt",
                "podzol",
                "mycelium",
                "rooted_dirt",
            )
            if not any(inv.get(name, 0) > 0 for name in dirt_like):
                task = "Mine 1 dirt"
                context = (
                    "Stand on or next to a dirt block (grass_block, dirt, coarse_dirt, "
                    "podzol, mycelium, rooted_dirt all count) and break it with your "
                    "bare hand. The block will drop as an item that the bot will "
                    "automatically pick up. Use bot.findBlock with a matching function "
                    "that accepts any block whose name ends in 'dirt' or equals "
                    "'grass_block'/'podzol'/'mycelium'/'rooted_dirt'."
                )
                return task, context
            # Already satisfied — record completion and fall through to AI proposer.
            have = {k: inv[k] for k in dirt_like if inv.get(k)}
            print(
                "\033[35m[Curriculum] Skipping starter task 'Mine 1 dirt' — "
                f"inventory already has dirt-type item: {have}\033[0m"
            )
            if "Mine 1 dirt" not in self.completed_tasks:
                self.completed_tasks.append("Mine 1 dirt")
                self.clean_up_tasks()

        # hard code task when inventory is almost full
        inventoryUsed = events[-1][1]["status"]["inventoryUsed"]
        if inventoryUsed >= 33:
            if chest_observation != "Chests: None\n\n":
                chests = chest_observation[8:-2].split("\n")
                for chest in chests:
                    content = chest.split(":")[1]
                    if content == " Unknown items inside" or content == " Empty":
                        position = chest.split(":")[0]
                        # Only deposit at home-base chests (within 48 blocks of spawn).
                        # This prevents the bot from depositing into random dungeon
                        # chests or other players' chests far from the base.
                        if home_position:
                            try:
                                coords = position.strip().strip("()").split(",")
                                cx, cy, cz = (
                                    float(coords[0]),
                                    float(coords[1]),
                                    float(coords[2]),
                                )
                                dist = (
                                    (cx - home_position["x"]) ** 2
                                    + (cy - home_position["y"]) ** 2
                                    + (cz - home_position["z"]) ** 2
                                ) ** 0.5
                                if dist > 48:
                                    print(
                                        f"\033[35m[Curriculum] Skipping far chest at {position} (dist={dist:.0f} from home)\033[0m"
                                    )
                                    continue
                            except Exception:
                                pass
                        task = f"Deposit useless items into the chest at {position}"
                        context = (
                            f"Your inventory have {inventoryUsed} occupied slots before depositing. "
                            "After depositing, your inventory should only have 20 occupied slots. "
                            "You should deposit useless items such as andesite, dirt, cobblestone, etc. "
                            "Also, you can deposit low-level tools, "
                            "For example, if you have a stone pickaxe, you can deposit a wooden pickaxe. "
                            "Make sure the list of useless items are in your inventory "
                            "(do not list items already in the chest), "
                            "You can use bot.inventoryUsed() to check how many inventory slots are used."
                        )
                        return task, context
            home_str = (
                f"({home_position['x']}, {home_position['y']}, {home_position['z']})"
                if home_position
                else "near your spawn"
            )
            if "chest" in events[-1][1]["inventory"]:
                chest_count = events[-1][1]["inventory"].get("chest", 0)
                if chest_count >= 2:
                    task = "Place a double chest"
                    context = (
                        f"Your home base is at {home_str}. Navigate there first using "
                        "bot.pathfinder.goto(new GoalNear(x, y, z, 3)). "
                        f"You have {chest_count} chests in inventory. Place TWO chests adjacent to each "
                        "other (horizontally, not stacked) to form a double chest. "
                        "Place the first chest, then place the second chest directly beside it. "
                        "If chests is not None or nearby blocks contain a chest, this task is success."
                    )
                else:
                    task = "Craft 1 more chest"
                    context = (
                        f"You have {chest_count} chest(s) in inventory but need 2 for a double chest "
                        f"at your home base {home_str}. "
                        "Craft 1 more chest with 8 planks of any kind of wood."
                    )
            else:
                task = "Craft 2 chests"
                context = (
                    f"Craft 2 chests (each needs 8 planks of any kind of wood). "
                    f"You need 2 adjacent chests at your home base {home_str} for storage."
                )
            return task, context

        messages = [
            self.render_system_message(),
            self.render_human_message(
                events=events, chest_observation=chest_observation
            ),
        ]

        if self.mode == "auto":
            current_inventory = events[-1][1].get("inventory", {}) if events else {}
            current_equipment = (
                events[-1][1].get("status", {}).get("equipment", []) if events else []
            )
            return self.propose_next_ai_task(
                messages=messages,
                max_retries=max_retries,
                current_inventory=current_inventory,
                current_equipment=current_equipment,
                preempt_check=preempt_check,
            )
        elif self.mode == "manual":
            return self.propose_next_manual_task()
        else:
            raise ValueError(f"Invalid curriculum agent mode: {self.mode}")

    def propose_next_ai_task(
        self,
        *,
        messages,
        max_retries=5,
        current_inventory=None,
        current_equipment=None,
        preempt_check=None,
    ):
        if current_inventory is None:
            current_inventory = {}
        if current_equipment is None:
            current_equipment = []
        if max_retries == 0:
            task, context = self._fallback_curriculum_task(
                current_inventory=current_inventory,
                current_equipment=current_equipment,
                preempt_check=preempt_check,
            )
            print(
                f"\033[35m[Curriculum] Max retries reached; falling back to "
                f"'{task}'.\033[0m"
            )
            return task, context
        curriculum = self.llm.invoke(messages).content
        print(f"\033[31m****Curriculum Agent ai message****\n{curriculum}\033[0m")
        try:
            response = self.parse_ai_message(curriculum)
            assert "next_task" in response
            # Reject tasks that always fail in this environment:
            # - leaves: never drop without shears
            # - stripped_*: player-placed processed wood, often inaccessible
            import re as _re

            _task = response["next_task"]
            _task_lc = _task.lower()
            _has_wood_progress = any(
                (
                    name.endswith("_log")
                    or name.endswith("_wood")
                    or name.endswith("_planks")
                    or name == "stick"
                    or name.endswith("_axe")
                    or name.endswith("_pickaxe")
                )
                and count > 0
                for name, count in current_inventory.items()
            )
            _has_pickaxe = any(
                name.endswith("_pickaxe") and count > 0
                for name, count in current_inventory.items()
            ) or any(
                isinstance(item, str) and item.endswith("_pickaxe")
                for item in current_equipment
            )
            _is_stone_progress_task = bool(
                _re.match(r"^mine\s+\d+\s+stone\b", _task_lc)
            )
            _is_wooden_pickaxe_task = _task_lc == "craft 1 wooden pickaxe"
            if _is_stone_progress_task and not _has_pickaxe:
                gated_task = (
                    "Craft 1 wooden pickaxe"
                    if _has_wood_progress
                    else "Mine 1 wood log"
                )
                print(
                    f"\033[35m[Curriculum] Gated task '{_task}' -> '{gated_task}' "
                    f"because stone mining requires a pickaxe first.\033[0m"
                )
                _task = gated_task
                _task_lc = _task.lower()
                response["next_task"] = _task
                _is_stone_progress_task = False
                _is_wooden_pickaxe_task = _task_lc == "craft 1 wooden pickaxe"
            if _is_wooden_pickaxe_task and not _has_wood_progress:
                print(
                    f"\033[35m[Curriculum] Gated task '{_task}' -> 'Mine 1 wood log' "
                    f"because crafting a wooden pickaxe requires wood first.\033[0m"
                )
                _task = "Mine 1 wood log"
                _task_lc = _task.lower()
                response["next_task"] = _task
            # Gate pickaxe-tier mining tasks (ore, coal, copper, iron, stone-adjacent)
            # behind having at least a wooden pickaxe.  Without one the task
            # will always fail, polluting failed_tasks and wasting retries.
            _is_pickaxe_tier_mine = bool(
                _re.search(
                    r"\bmine\s+\d+\s+(?:\w+_)?"
                    r"(?:ore|copper|iron|gold|diamond|coal|stone|cobblestone|"
                    r"deepslate|granite|diorite|andesite|basalt|tuff|netherrack|"
                    r"sandstone|gravel|calcite|dripstone|obsidian)\b",
                    _task_lc,
                )
            )
            if _is_pickaxe_tier_mine and not _has_pickaxe:
                gated_task = (
                    "Craft 1 wooden pickaxe"
                    if _has_wood_progress
                    else "Mine 1 wood log"
                )
                print(
                    f"\033[35m[Curriculum] Gated pickaxe-tier task '{_task}' -> "
                    f"'{gated_task}' because no pickaxe in inventory.\033[0m"
                )
                _task = gated_task
                _task_lc = _task.lower()
                response["next_task"] = _task
            _allow_failed_retry = _has_wood_progress and (
                _is_stone_progress_task or _is_wooden_pickaxe_task
            )
            # Use simple substring checks — word-boundary regex fails on
            # underscore-joined names like 'jungle_leaves' or 'stripped_log'
            if "leaves" in _task_lc or "stripped" in _task_lc:
                print(
                    f"\033[35m[Curriculum] Rejected unmineable task "
                    f"'{_task}' — retrying\033[0m"
                )
                return self.propose_next_ai_task(
                    messages=messages,
                    max_retries=max_retries - 1,
                    current_inventory=current_inventory,
                    current_equipment=current_equipment,
                    preempt_check=preempt_check,
                )
            # Hard-reject tasks already in failed_tasks — the LLM sometimes
            # ignores the failed_tasks hint in the prompt. Use bidirectional
            # substring check so "Mine 1 acacia wood log" is rejected when
            # "Mine 1 acacia wood" is in failed_tasks (and vice versa).
            _task_lower = _task.strip().lower()
            _is_retryable_generic_wood = bool(
                _re.match(r"^mine\s+\d+\s+wood log\b", _task_lower)
            )
            if (
                not _is_retryable_generic_wood
                and not _allow_failed_retry
                and any(
                    _task_lower == _ft.strip().lower()
                    or _task_lower in _ft.strip().lower()
                    or _ft.strip().lower() in _task_lower
                    for _ft in self.failed_tasks
                )
            ):
                print(
                    f"\033[35m[Curriculum] Hard-rejected already-failed task "
                    f"'{_task}' — retrying\033[0m"
                )
                return self.propose_next_ai_task(
                    messages=messages,
                    max_retries=max_retries - 1,
                    current_inventory=current_inventory,
                    current_equipment=current_equipment,
                    preempt_check=preempt_check,
                )
            # Hard-reject tasks already satisfied by the bot's current
            # inventory (deterministic mine/craft/smelt). Otherwise the
            # curriculum LLM keeps re-proposing things like 'Mine 3 coal_ore'
            # when the bot already has 10 coal, causing an infinite loop.
            if preempt_check is not None:
                try:
                    _preempt = preempt_check(
                        task=_task, gained={}, inventory=current_inventory or {}
                    )
                except Exception as _pe:
                    _preempt = None
                if _preempt is not None and _preempt[0]:
                    print(
                        f"\033[35m[Curriculum] Hard-rejected already-satisfied task "
                        f"'{_task}' (current inventory already meets requirement) — "
                        f"retrying\033[0m"
                    )
                    return self.propose_next_ai_task(
                        messages=messages,
                        max_retries=max_retries - 1,
                        current_inventory=current_inventory,
                        current_equipment=current_equipment,
                        preempt_check=preempt_check,
                    )
            context = self.get_task_context(response["next_task"])
            return response["next_task"], context
        except Exception as e:
            print(
                f"\033[35mError parsing curriculum response: {e}. Trying again!\033[0m"
            )
            return self.propose_next_ai_task(
                messages=messages,
                max_retries=max_retries - 1,
                current_inventory=current_inventory,
                current_equipment=current_equipment,
                preempt_check=preempt_check,
            )

    def _fallback_curriculum_task(
        self, *, current_inventory, current_equipment, preempt_check=None
    ):
        def _matches_failed(task):
            task_lower = task.strip().lower()
            return any(
                task_lower == failed_task.strip().lower()
                or task_lower in failed_task.strip().lower()
                or failed_task.strip().lower() in task_lower
                for failed_task in self.failed_tasks
            )

        def _is_preempted(task):
            if preempt_check is None:
                return False
            try:
                result = preempt_check(
                    task=task, gained={}, inventory=current_inventory or {}
                )
            except Exception:
                return False
            return bool(result and result[0])

        def _count_items(suffixes):
            return sum(
                count
                for name, count in current_inventory.items()
                if any(name.endswith(suffix) for suffix in suffixes)
            )

        has_wood_progress = any(
            (
                name.endswith("_log")
                or name.endswith("_wood")
                or name.endswith("_planks")
                or name == "stick"
                or name.endswith("_axe")
                or name.endswith("_pickaxe")
            )
            and count > 0
            for name, count in current_inventory.items()
        )
        has_pickaxe = any(
            name.endswith("_pickaxe") and count > 0
            for name, count in current_inventory.items()
        ) or any(
            isinstance(item, str) and item.endswith("_pickaxe")
            for item in current_equipment
        )
        stone_count = sum(
            count
            for name, count in current_inventory.items()
            if name in {"stone", "cobblestone", "cobbled_deepslate"}
        )
        plank_count = _count_items(("_planks",))
        stick_count = current_inventory.get("stick", 0)
        wood_unit_count = _count_items(("_log", "_wood", "_stem", "_hyphae"))
        total_plank_equivalent = plank_count + wood_unit_count * 4
        # Sticks can be crafted from planks (2 planks → 4 sticks), and planks
        # from logs, so count potential sticks even if none are in inventory yet.
        total_stick_equivalent = stick_count + (total_plank_equivalent // 2) * 2
        can_craft_pickaxe_from_inventory = (
            total_plank_equivalent >= 3 and total_stick_equivalent >= 2
        )

        candidates = []
        if not has_wood_progress:
            candidates.append("Mine 1 wood log")
        if not has_pickaxe:
            candidates.append(
                "Craft 1 wooden pickaxe"
                if can_craft_pickaxe_from_inventory
                else "Mine 1 wood log"
            )
        if has_pickaxe and stone_count < 3:
            candidates.append("Mine 3 stone")
        # Stone-tier complete: progress toward iron.
        has_stone_pickaxe = any(
            name == "stone_pickaxe" and count > 0
            for name, count in current_inventory.items()
        ) or any(
            isinstance(item, str) and item == "stone_pickaxe"
            for item in current_equipment
        )
        raw_iron_count = current_inventory.get("raw_iron", 0) + current_inventory.get(
            "iron_ingot", 0
        )
        has_iron_pickaxe = any(
            name == "iron_pickaxe" and count > 0
            for name, count in current_inventory.items()
        ) or any(
            isinstance(item, str) and item == "iron_pickaxe"
            for item in current_equipment
        )
        iron_ingot_count = current_inventory.get("iron_ingot", 0)
        has_diamond_pickaxe = any(
            name == "diamond_pickaxe" and count > 0
            for name, count in current_inventory.items()
        ) or any(
            isinstance(item, str) and item == "diamond_pickaxe"
            for item in current_equipment
        )
        diamond_count = current_inventory.get("diamond", 0)

        if has_stone_pickaxe:
            if raw_iron_count < 3:
                candidates.append("Mine 3 iron_ore")
            else:
                # Need a furnace to smelt. If we don't have one, craft it first.
                has_furnace = current_inventory.get("furnace", 0) > 0
                cobble_count = sum(
                    count
                    for name, count in current_inventory.items()
                    if name in {"cobblestone", "cobbled_deepslate"}
                )
                if not has_furnace and cobble_count >= 8:
                    candidates.append("Craft 1 furnace")
                elif not has_furnace:
                    candidates.append("Mine 8 stone")
                else:
                    candidates.append("Smelt 3 iron_ingot")

        # Iron-tier: craft iron pickaxe, then push toward diamonds.
        if has_stone_pickaxe and iron_ingot_count >= 3 and not has_iron_pickaxe:
            candidates.append("Craft 1 iron_pickaxe")
        if has_iron_pickaxe and not has_diamond_pickaxe:
            if diamond_count < 3:
                candidates.append("Mine 3 diamond_ore")
            else:
                candidates.append("Craft 1 diamond_pickaxe")

        if not candidates:
            candidates = ["Mine 3 stone" if has_pickaxe else "Craft 1 wooden pickaxe"]

        for candidate in candidates:
            if _is_preempted(candidate):
                continue
            if candidate.lower() == "mine 1 wood log":
                return candidate, self._fallback_task_context(candidate)
            if not _matches_failed(candidate):
                return candidate, self._fallback_task_context(candidate)
        return candidates[0], self._fallback_task_context(candidates[0])

    @staticmethod
    def _fallback_task_context(task):
        contexts = {
            "Mine 1 wood log": (
                "Collect one natural wood log. Prefer a reachable nearby log first; "
                "only leave the current area if no safe reachable log exists."
            ),
            "Craft 1 wooden pickaxe": (
                "Ensure you have logs, convert them to planks, place or use a crafting table if needed, "
                "and craft exactly one wooden pickaxe."
            ),
            "Mine 3 stone": (
                "Use an equipped pickaxe to mine three reachable stone blocks and collect the drops."
            ),
            "Mine 3 iron_ore": (
                "Equip a stone (or better) pickaxe and find iron_ore blocks (often "
                "underground or in mountainsides). Mine three of them; each drops raw_iron."
            ),
            "Craft 1 furnace": (
                "Open a crafting table and craft one furnace using 8 cobblestone "
                "(arranged around the centre slot). The result will be one furnace "
                "block in your inventory."
            ),
            "Smelt 3 iron_ingot": (
                "Open a furnace, place raw_iron in the input slot and coal/charcoal as fuel, "
                "and wait until three iron_ingot have been produced."
            ),
            "Craft 1 iron_pickaxe": (
                "Use a crafting table with 3 iron_ingot across the top row and 2 sticks in the "
                "middle and bottom-middle slots to craft one iron_pickaxe."
            ),
            "Mine 3 diamond_ore": (
                "Equip an iron (or better) pickaxe and descend to y=-60 to y=-16 where diamond_ore "
                "spawns. Mine 3 diamond_ore blocks; each drops 1 diamond."
            ),
            "Craft 1 diamond_pickaxe": (
                "Use a crafting table with 3 diamonds across the top row and 2 sticks in the "
                "middle and bottom-middle slots to craft one diamond_pickaxe."
            ),
        }
        return contexts.get(
            task, f"Complete the task '{task}' using currently available resources."
        )

    def parse_ai_message(self, message):
        task = ""
        for line in message.split("\n"):
            if line.startswith("Task:"):
                task = line[5:].replace(".", "").strip()
        assert task, "Task not found in Curriculum Agent response"
        task = self._generalize_wood_task(task)
        return {"next_task": task}

    @staticmethod
    def _generalize_wood_task(task):
        # Species-specific wood tasks (e.g. "Mine 1 birch_log" or "Mine 1 acacia wood log")
        # trap the bot in biomes that don't grow that species. ANY wood is fine for the
        # early game — the critic already accepts any *_log/_wood/_stem/_hyphae
        # item, and the action template tells the skill to scan all log types.
        # Rewrite the task to a species-agnostic phrasing so the action agent
        # doesn't search for the wrong species.
        # Handles both underscore-joined ("acacia_log") and space-separated
        # ("acacia wood log") species names.
        import re

        # Pattern 1: underscore-joined species (acacia_log, dark_oak_wood, etc.)
        m = re.match(
            r"^(Mine)\s+(\d+)\s+([a-z_]+?)_(log|wood|stem|hyphae)s?\b(.*)$",
            task,
            re.IGNORECASE,
        )
        if m:
            verb, n, _species, suffix, tail = m.groups()
            new_task = f"{verb} {n} wood log{tail}"
            if new_task != task:
                print(
                    f"\033[35m[Curriculum] Generalized wood task '{task}' -> "
                    f"'{new_task}' (any wood species counts)\033[0m"
                )
            return new_task

        # Pattern 2: space-separated species before log/wood keyword
        # e.g. "Mine 1 acacia wood log" or "Mine 1 dark oak log"
        # Groups: (1)=count, (2)=log|wood|..., (3)=tail
        m2 = re.match(
            r"^Mine\s+(\d+)\s+(?:[a-z]+ )+(log|wood|stem|hyphae)s?\b(.*)$",
            task,
            re.IGNORECASE,
        )
        if m2:
            n2, tail2 = m2.group(1), m2.group(3) or ""
            new_task = f"Mine {n2} wood log{tail2}"
            if new_task != task:
                print(
                    f"\033[35m[Curriculum] Generalized wood task '{task}' -> "
                    f"'{new_task}' (any wood species counts)\033[0m"
                )
            return new_task

        return task

    def propose_next_manual_task(self):
        confirmed = False
        task, context = "", ""
        while not confirmed:
            task = input("Enter task: ")
            context = input("Enter context: ")
            print(f"Task: {task}\nContext: {context}")
            confirmed = input("Confirm? (y/n)").lower() in ["y", ""]
        return task, context

    def update_exploration_progress(self, info):
        task = info["task"]
        if task.startswith("Deposit useless items into the chest at"):
            # No need to record the deposit task
            return
        if task in (
            "Place a double chest",
            "Craft 2 chests",
            "Craft 1 more chest",
            "Place a chest",
            "Craft 1 chest",
        ):
            # Chest setup tasks are transient; don't pollute completed/failed lists
            return
        if info["success"]:
            print(f"\033[35mCompleted task {task}.\033[0m")
            self.completed_tasks.append(task)
        else:
            print(
                f"\033[35mFailed to complete task {task}. Skipping to next task.\033[0m"
            )
            # No duplicates — only add if not already recorded.
            if task not in self.failed_tasks:
                self.failed_tasks.append(task)

        # clean up tasks and dump to disk
        self.clean_up_tasks()

    def clean_up_tasks(self):
        updated_completed_tasks = []
        # record repeated failed tasks
        updated_failed_tasks = self.failed_tasks
        # dedup but keep order
        for task in self.completed_tasks:
            if task not in updated_completed_tasks:
                updated_completed_tasks.append(task)

        # remove completed tasks from failed tasks
        for task in updated_completed_tasks:
            while task in updated_failed_tasks:
                updated_failed_tasks.remove(task)

        # Deduplicate: keep only the first occurrence of each task.
        _seen_tasks: set = set()
        _trimmed = []
        for _t in updated_failed_tasks:
            _key = _t.strip().lower()
            if _key not in _seen_tasks:
                _seen_tasks.add(_key)
                _trimmed.append(_t)
        updated_failed_tasks = _trimmed

        self.completed_tasks = updated_completed_tasks
        self.failed_tasks = updated_failed_tasks

        # dump to json
        U.dump_json(
            self.completed_tasks, f"{self.ckpt_dir}/curriculum/completed_tasks.json"
        )
        U.dump_json(self.failed_tasks, f"{self.ckpt_dir}/curriculum/failed_tasks.json")

    def decompose_task(self, task, events):
        messages = [
            SystemMessage(
                content=load_prompt("curriculum_task_decomposition"),
            ),
            self.render_human_message(events=events, chest_observation=""),
            HumanMessage(content=f"Final task: {task}"),
        ]
        print(
            f"\033[31m****Curriculum Agent task decomposition****\nFinal task: {task}\033[0m"
        )
        response = self.llm.invoke(messages).content
        print(f"\033[31m****Curriculum Agent task decomposition****\n{response}\033[0m")
        return fix_and_parse_json(response)

    def run_qa(self, *, events, chest_observation):
        questions_new, _ = self.run_qa_step1_ask_questions(
            events=events, chest_observation=chest_observation
        )
        questions = []
        answers = []
        for question in questions_new:
            question_cached = self._find_cached_question(question)
            if question_cached:
                assert question_cached in self.qa_cache
                answer_cached = self.qa_cache[question_cached]
                questions.append(question_cached)
                answers.append(answer_cached)
                continue
            answer = self.run_qa_step2_answer_questions(question=question)
            assert question not in self.qa_cache
            self.qa_cache[question] = answer
            self._store_cached_question(question)
            U.dump_json(self.qa_cache, f"{self.ckpt_dir}/curriculum/qa_cache.json")
            questions.append(question)
            answers.append(answer)
        assert len(questions_new) == len(questions) == len(answers)
        return questions, answers

    def get_task_context(self, task):
        # if include ore in question, gpt will try to use tool with skill touch enhancement to mine
        question = (
            f"How to {task.replace('_', ' ').replace(' ore', '').replace(' ores', '').replace('.', '').strip().lower()}"
            f" in Minecraft?"
        )
        if question in self.qa_cache:
            answer = self.qa_cache[question]
        else:
            answer = self.run_qa_step2_answer_questions(question=question)
            self.qa_cache[question] = answer
            self._store_cached_question(question)
            U.dump_json(self.qa_cache, f"{self.ckpt_dir}/curriculum/qa_cache.json")
        context = f"Question: {question}\n{answer}"
        return context

    def render_system_message_qa_step1_ask_questions(self):
        return SystemMessage(content=load_prompt("curriculum_qa_step1_ask_questions"))

    def render_human_message_qa_step1_ask_questions(self, *, events, chest_observation):
        observation = self.render_observation(
            events=events, chest_observation=chest_observation
        )
        content = ""
        for key in self.curriculum_observations:
            content += observation[key]
        return HumanMessage(content=content)

    def run_qa_step1_ask_questions(self, *, events, chest_observation):
        biome = events[-1][1]["status"]["biome"].replace("_", " ")
        questions = [
            f"What are the blocks that I can find in the {biome} in Minecraft?",
            f"What are the items that I can find in the {biome} in Minecraft?",
            f"What are the mobs that I can find in the {biome} in Minecraft?",
        ]
        concepts = [biome, biome, biome]
        messages = [
            self.render_system_message_qa_step1_ask_questions(),
            self.render_human_message_qa_step1_ask_questions(
                events=events, chest_observation=chest_observation
            ),
        ]
        qa_response = self.qa_llm(messages).content
        try:
            # Regex pattern to extract question and concept pairs
            pattern = r"Question \d+: (.+)\nConcept \d+: (.+)"
            # Extracting all question and concept pairs from the text
            pairs = re.findall(pattern, qa_response)
            # Storing each question and concept in separate lists
            questions_new = [pair[0] for pair in pairs]
            concepts_new = [pair[1] for pair in pairs]
            assert len(questions_new) == len(concepts_new)
            questions.extend(questions_new)
            concepts.extend(concepts_new)
        except Exception as e:
            print(
                f"\033[35mError parsing curriculum response for "
                f"QA step 1 ask questions: {e}.\033[0m"
            )
        return questions, concepts

    def render_system_message_qa_step2_answer_questions(self):
        return SystemMessage(
            content=load_prompt("curriculum_qa_step2_answer_questions")
        )

    def render_human_message_qa_step2_answer_questions(self, question):
        content = f"Question: {question}"
        return HumanMessage(content=content)

    def run_qa_step2_answer_questions(self, question):
        messages = [
            self.render_system_message_qa_step2_answer_questions(),
            self.render_human_message_qa_step2_answer_questions(question=question),
        ]
        print(f"\033[35mCurriculum Agent Question: {question}\033[0m")
        qa_answer = self.qa_llm(messages).content
        print(f"\033[31mCurriculum Agent {qa_answer}\033[0m")
        return qa_answer
