import re
import time

import voyager.utils as U
from javascript import require
from langchain.chat_models import ChatOpenAI
from langchain.prompts import SystemMessagePromptTemplate
from langchain.schema import AIMessage, HumanMessage, SystemMessage

from voyager.prompts import load_prompt
from voyager.control_primitives_context import load_control_primitives_context


DETERMINISTIC_WOOD_LOG_RESPONSE = """Explain: This is a deterministic early-game fallback for gathering a real wood log. It uses the validated helper and mineBlock contract instead of relying on model-specific planning quality.

Plan:
1) Use ensureLogsReachable(bot) to move out of decorative spawn pockets and find reachable natural logs.
2) Mine exactly one generic wood log with mineBlock(bot, \"wood log\", 1).
3) Verify that the inventory log count increased.

Code:
```javascript
async function mineOneWoodLogDeterministic(bot) {
    bot.chat("Starting task: mine 1 wood log.");

    const countLogs = () =>
        bot.inventory
            .items()
            .filter(
                (item) =>
                    item &&
                    (item.name.endsWith("_log") ||
                        item.name.endsWith("_wood") ||
                        item.name.endsWith("_stem") ||
                        item.name.endsWith("_hyphae"))
            )
            .reduce((sum, item) => sum + item.count, 0);

    const beforeCount = countLogs();

    bot.chat("Checking for reachable logs.");
    const reachable = await ensureLogsReachable(bot);
    if (!reachable) {
        bot.chat("Failed: could not find reachable wood logs.");
        return;
    }

    try {
        await mineBlock(bot, "wood log", 1);
    } catch (err) {
        bot.chat(`Failed while mining wood: ${err.message}`);
        return;
    }

    if (countLogs() > beforeCount) {
        bot.chat("Done: mined 1 wood log.");
    } else {
        bot.chat("Failed: no wood log was collected.");
    }
}
```"""


DETERMINISTIC_WOODEN_PICKAXE_RESPONSE = """Explain: This is a deterministic early-game fallback for crafting a wooden pickaxe. It uses the real primitive contracts: ensure reachable logs when needed, convert logs into planks, craft a crafting table only when table access is missing, and then call craftItem(bot, \"wooden_pickaxe\", 1).

Plan:
1) Ensure at least 2 sticks are already present.
2) If there is no crafting-table access, gather enough total wood for both the table and the pickaxe.
3) Craft planks from gathered logs, craft a crafting table if needed, then craft the wooden pickaxe.
4) Verify the pickaxe appears in inventory.

Code:
```javascript
async function craftWoodenPickaxeDeterministic(bot) {
    bot.chat("Starting task: craft 1 wooden pickaxe.");

    const items = () => bot.inventory.items();
    const countItems = (predicate) =>
        items().filter(predicate).reduce((sum, item) => sum + item.count, 0);
    const countPlanks = () =>
        countItems((item) => item && item.name.endsWith("_planks"));
    const countSticks = () => countItems((item) => item && item.name === "stick");
    const countLogs = () =>
        countItems(
            (item) =>
                item &&
                (item.name.endsWith("_log") ||
                    item.name.endsWith("_wood") ||
                    item.name.endsWith("_stem") ||
                    item.name.endsWith("_hyphae"))
        );
    const hasPickaxe = () =>
        items().some((item) => item && item.name === "wooden_pickaxe");
    const hasTableInInventory = () =>
        items().some((item) => item && item.name === "crafting_table");
    const hasTableNearby = () =>
        !!bot.findBlock({
            matching: (block) => block && block.name === "crafting_table",
            maxDistance: 128,
        });
    const hasTableAccess = () => hasTableInInventory() || hasTableNearby();
    const findLogItem = () =>
        items().find(
            (item) =>
                item &&
                (item.name.endsWith("_log") ||
                    item.name.endsWith("_wood") ||
                    item.name.endsWith("_stem") ||
                    item.name.endsWith("_hyphae"))
        );
    const plankNameFromLog = (name) =>
        name
            .replace(/_log$/, "_planks")
            .replace(/_wood$/, "_planks")
            .replace(/_stem$/, "_planks")
            .replace(/_hyphae$/, "_planks");

    const mineOneLog = async () => {
        bot.chat("Checking for reachable logs.");
        const reachable = await ensureLogsReachable(bot);
        if (!reachable) {
            bot.chat("Failed: could not find reachable wood logs.");
            return false;
        }
        try {
            await mineBlock(bot, "wood log", 1);
            return true;
        } catch (err) {
            bot.chat(`Failed while mining wood: ${err.message}`);
            return false;
        }
    };

    const craftPlanksUntil = async (minimumPlanks) => {
        while (countPlanks() < minimumPlanks) {
            if (countLogs() === 0) {
                const mined = await mineOneLog();
                if (!mined) return false;
            }
            const logItem = findLogItem();
            if (!logItem) {
                bot.chat("Failed: no logs available to craft planks.");
                return false;
            }
            try {
                await craftItem(bot, plankNameFromLog(logItem.name), 1);
            } catch (err) {
                bot.chat(`Failed while crafting planks: ${err.message}`);
                return false;
            }
        }
        return true;
    };

    if (hasPickaxe()) {
        bot.chat("Done: already have a wooden pickaxe.");
        return;
    }

    if (countSticks() < 2) {
        bot.chat("Failed: not enough sticks for a wooden pickaxe.");
        return;
    }

    // FAST PATH: if we already have enough planks and sticks for the pickaxe,
    // delegate to craftItem directly. craftItem handles finding/placing a
    // crafting table on its own (reuses an existing one within 30 blocks).
    // This avoids over-cautious wood mining when ingredients suffice.
    if (countPlanks() >= 3) {
        bot.chat("Have enough planks and sticks; trying direct craft.");
        try {
            await craftItem(bot, "wooden_pickaxe", 1);
        } catch (err) {
            bot.chat(`Direct craft failed: ${err.message}`);
        }
        if (hasPickaxe()) {
            bot.chat("Done: crafted 1 wooden pickaxe.");
            return;
        }
        // If direct craft failed (likely no table and no carried table item),
        // and we have 4+ planks, place a table from spare planks.
        if (countPlanks() >= 4 && !hasTableInInventory()) {
            bot.chat("Crafting crafting table from spare planks.");
            try {
                await craftItem(bot, "crafting_table", 1);
            } catch (err) {
                bot.chat(`Failed crafting table: ${err.message}`);
            }
            if (countPlanks() >= 3) {
                try {
                    await craftItem(bot, "wooden_pickaxe", 1);
                } catch (err) {
                    bot.chat(`Pickaxe craft after table failed: ${err.message}`);
                }
                if (hasPickaxe()) {
                    bot.chat("Done: crafted 1 wooden pickaxe.");
                    return;
                }
            }
        }
        // Fall through to wood gathering only if still no pickaxe.
    }

    // Need to gather wood. Cap attempts so we don't infinite-loop on an
    // unreachable-wood platform.
    const MAX_MINE_ATTEMPTS = 4;
    let mineAttempts = 0;
    const tryMineOnce = async () => {
        if (mineAttempts >= MAX_MINE_ATTEMPTS) {
            bot.chat(`Failed: gave up mining wood after ${MAX_MINE_ATTEMPTS} attempts (no reachable logs).`);
            return false;
        }
        mineAttempts += 1;
        return await mineOneLog();
    };

    while (!hasTableAccess() && countPlanks() + 4 * countLogs() < 7) {
        const mined = await tryMineOnce();
        if (!mined) return;
    }

    if (!hasTableAccess()) {
        const haveTablePlanks = await craftPlanksUntil(4);
        if (!haveTablePlanks) return;
        bot.chat("Crafting crafting table.");
        try {
            await craftItem(bot, "crafting_table", 1);
        } catch (err) {
            bot.chat(`Failed while crafting crafting table: ${err.message}`);
            return;
        }
    }

    while (countPlanks() + 4 * countLogs() < 3) {
        const mined = await tryMineOnce();
        if (!mined) return;
    }

    const havePickaxePlanks = await craftPlanksUntil(3);
    if (!havePickaxePlanks) return;

    if (countPlanks() < 3 || countSticks() < 2) {
        bot.chat("Failed: not enough materials for a wooden pickaxe.");
        return;
    }

    bot.chat("Crafting wooden pickaxe.");
    try {
        await craftItem(bot, "wooden_pickaxe", 1);
    } catch (err) {
        bot.chat(`Failed while crafting wooden pickaxe: ${err.message}`);
        return;
    }

    if (hasPickaxe()) {
        bot.chat("Done: crafted 1 wooden pickaxe.");
    } else {
        bot.chat("Failed: wooden pickaxe was not crafted.");
    }
}
```"""


DETERMINISTIC_WOODEN_SWORD_RESPONSE = """Explain: This is a deterministic fallback for crafting a wooden sword. It avoids unreliable recipe retrieval by gathering only the needed materials, converting one log into planks when required, and then calling craftItem(bot, \"wooden_sword\", 1).

Plan:
1) Ensure at least 1 stick is already present.
2) Gather enough wood for 2 planks if they are not already in inventory.
3) Craft planks from a real log when needed.
4) Craft the wooden sword and verify it appears in inventory.

Code:
```javascript
async function craftWoodenSwordDeterministic(bot) {
    bot.chat("Starting task: craft 1 wooden sword.");

    const items = () => bot.inventory.items();
    const countItems = (predicate) =>
        items().filter(predicate).reduce((sum, item) => sum + item.count, 0);
    const countPlanks = () =>
        countItems((item) => item && item.name.endsWith("_planks"));
    const countSticks = () => countItems((item) => item && item.name === "stick");
    const countLogs = () =>
        countItems(
            (item) =>
                item &&
                (item.name.endsWith("_log") ||
                    item.name.endsWith("_wood") ||
                    item.name.endsWith("_stem") ||
                    item.name.endsWith("_hyphae"))
        );
    const hasSword = () =>
        items().some((item) => item && item.name === "wooden_sword");
    const findLogItem = () =>
        items().find(
            (item) =>
                item &&
                (item.name.endsWith("_log") ||
                    item.name.endsWith("_wood") ||
                    item.name.endsWith("_stem") ||
                    item.name.endsWith("_hyphae"))
        );
    const plankNameFromLog = (name) =>
        name
            .replace(/_log$/, "_planks")
            .replace(/_wood$/, "_planks")
            .replace(/_stem$/, "_planks")
            .replace(/_hyphae$/, "_planks");

    const mineOneLog = async () => {
        bot.chat("Checking for reachable logs.");
        const reachable = await ensureLogsReachable(bot);
        if (!reachable) {
            bot.chat("Failed: could not find reachable wood logs.");
            return false;
        }
        try {
            await mineBlock(bot, "wood log", 1);
            return true;
        } catch (err) {
            bot.chat(`Failed while mining wood: ${err.message}`);
            return false;
        }
    };

    const craftPlanksUntil = async (minimumPlanks) => {
        while (countPlanks() < minimumPlanks) {
            if (countLogs() === 0) {
                const mined = await mineOneLog();
                if (!mined) return false;
            }
            const logItem = findLogItem();
            if (!logItem) {
                bot.chat("Failed: no logs available to craft planks.");
                return false;
            }
            try {
                await craftItem(bot, plankNameFromLog(logItem.name), 1);
            } catch (err) {
                bot.chat(`Failed while crafting planks: ${err.message}`);
                return false;
            }
        }
        return true;
    };

    if (hasSword()) {
        bot.chat("Done: already have a wooden sword.");
        return;
    }

    if (countSticks() < 1) {
        bot.chat("Failed: not enough sticks for a wooden sword.");
        return;
    }

    while (countPlanks() + 4 * countLogs() < 2) {
        const mined = await mineOneLog();
        if (!mined) return;
    }

    const haveSwordPlanks = await craftPlanksUntil(2);
    if (!haveSwordPlanks) return;

    if (countPlanks() < 2 || countSticks() < 1) {
        bot.chat("Failed: not enough materials for a wooden sword.");
        return;
    }

    bot.chat("Crafting wooden sword.");
    try {
        await craftItem(bot, "wooden_sword", 1);
    } catch (err) {
        bot.chat(`Failed while crafting wooden sword: ${err.message}`);
        return;
    }

    if (hasSword()) {
        bot.chat("Done: crafted 1 wooden sword.");
    } else {
        bot.chat("Failed: wooden sword was not crafted.");
    }
}
```"""


class ActionAgent:
    def __init__(
        self,
        model_name="gpt-3.5-turbo",
        temperature=0,
        request_timout=120,
        ckpt_dir="ckpt",
        resume=False,
        chat_log=True,
        execution_error=True,
    ):
        self.ckpt_dir = ckpt_dir
        self.chat_log = chat_log
        self.execution_error = execution_error
        U.f_mkdir(f"{ckpt_dir}/action")
        if resume:
            print(f"\033[32mLoading Action Agent from {ckpt_dir}/action\033[0m")
            self.chest_memory = U.load_json(f"{ckpt_dir}/action/chest_memory.json")
        else:
            self.chest_memory = {}
        # Home position (set by voyager.py after first spawn). When set, only
        # chests within HOME_CHEST_RADIUS blocks of home are shown to the LLM
        # so it never deposits into random world-generated chests.
        self.home_position = None
        self.HOME_CHEST_RADIUS = 48
        self.llm = ChatOpenAI(
            model_name=model_name,
            temperature=temperature,
            request_timeout=request_timout,
        )

    def deterministic_response(self, task):
        task_normalized = (task or "").strip().lower()
        if task_normalized == "mine 1 wood log":
            return AIMessage(content=DETERMINISTIC_WOOD_LOG_RESPONSE)
        if task_normalized == "craft 1 wooden pickaxe":
            return AIMessage(content=DETERMINISTIC_WOODEN_PICKAXE_RESPONSE)
        if task_normalized == "craft 1 wooden sword":
            return AIMessage(content=DETERMINISTIC_WOODEN_SWORD_RESPONSE)
        return None

    def update_chest_memory(self, chests):
        for position, chest in chests.items():
            if position in self.chest_memory:
                if isinstance(chest, dict):
                    self.chest_memory[position] = chest
                if chest == "Invalid":
                    print(
                        f"\033[32mAction Agent removing chest {position}: {chest}\033[0m"
                    )
                    self.chest_memory.pop(position)
            else:
                if chest != "Invalid":
                    print(
                        f"\033[32mAction Agent saving chest {position}: {chest}\033[0m"
                    )
                    self.chest_memory[position] = chest
        U.dump_json(self.chest_memory, f"{self.ckpt_dir}/action/chest_memory.json")

    def _chest_near_home(self, position_str):
        """Return True if this chest position string is within HOME_CHEST_RADIUS of home."""
        if not self.home_position:
            return True  # no home set yet — allow all
        try:
            coords = position_str.strip().strip("()").split(",")
            cx, cy, cz = float(coords[0]), float(coords[1]), float(coords[2])
            hx = self.home_position["x"]
            hy = self.home_position["y"]
            hz = self.home_position["z"]
            dist = ((cx - hx) ** 2 + (cy - hy) ** 2 + (cz - hz) ** 2) ** 0.5
            return dist <= self.HOME_CHEST_RADIUS
        except Exception:
            return True  # can't parse — allow it

    def render_chest_observation(self):
        chests = []
        for chest_position, chest in self.chest_memory.items():
            if not self._chest_near_home(chest_position):
                continue
            if isinstance(chest, dict) and len(chest) > 0:
                chests.append(f"{chest_position}: {chest}")
        for chest_position, chest in self.chest_memory.items():
            if not self._chest_near_home(chest_position):
                continue
            if isinstance(chest, dict) and len(chest) == 0:
                chests.append(f"{chest_position}: Empty")
        for chest_position, chest in self.chest_memory.items():
            if not self._chest_near_home(chest_position):
                continue
            if isinstance(chest, str):
                assert chest == "Unknown"
                chests.append(f"{chest_position}: Unknown items inside")
        if chests:
            chests = "\n".join(chests)
            return f"Chests:\n{chests}\n\n"
        else:
            return f"Chests: None\n\n"

    def render_system_message(self, skills=[]):
        system_template = load_prompt("action_template")
        # FIXME: Hardcoded control_primitives
        base_skills = [
            "exploreUntil",
            "mineBlock",
            "craftItem",
            "placeItem",
            "smeltItem",
            "killMob",
        ]
        if not self.llm.model_name == "gpt-3.5-turbo":
            base_skills += [
                "useChest",
                "mineflayer",
            ]
        programs = "\n\n".join(load_control_primitives_context(base_skills) + skills)
        response_format = load_prompt("action_response_format")
        system_message_prompt = SystemMessagePromptTemplate.from_template(
            system_template
        )
        system_message = system_message_prompt.format(
            programs=programs, response_format=response_format
        )
        assert isinstance(system_message, SystemMessage)
        return system_message

    def render_human_message(
        self, *, events, code="", task="", context="", critique=""
    ):
        chat_messages = []
        error_messages = []
        # FIXME: damage_messages is not used
        damage_messages = []
        assert events[-1][0] == "observe", "Last event must be observe"
        for i, (event_type, event) in enumerate(events):
            if event_type == "onChat":
                chat_messages.append(event["onChat"])
            elif event_type == "onError":
                error_messages.append(event["onError"])
            elif event_type == "onDamage":
                damage_messages.append(event["onDamage"])
            elif event_type == "observe":
                biome = event["status"]["biome"]
                time_of_day = event["status"]["timeOfDay"]
                voxels = event["voxels"]
                entities = event["status"]["entities"]
                health = event["status"]["health"]
                hunger = event["status"]["food"]
                position = event["status"]["position"]
                equipment = event["status"]["equipment"]
                inventory_used = event["status"]["inventoryUsed"]
                inventory = event["inventory"]
                assert i == len(events) - 1, "observe must be the last event"

        observation = ""

        if code:
            observation += f"Code from the last round:\n{code}\n\n"
        else:
            observation += f"Code from the last round: No code in the first round\n\n"

        if self.execution_error:
            if error_messages:
                error = "\n".join(error_messages)
                observation += f"Execution error:\n{error}\n\n"
            else:
                observation += f"Execution error: No error\n\n"

        if self.chat_log:
            if chat_messages:
                chat_log = "\n".join(chat_messages)
                observation += f"Chat log: {chat_log}\n\n"
            else:
                observation += f"Chat log: None\n\n"

        observation += f"Biome: {biome}\n\n"

        observation += f"Time: {time_of_day}\n\n"

        if voxels:
            observation += f"Nearby blocks: {', '.join(voxels)}\n\n"
        else:
            observation += f"Nearby blocks: None\n\n"

        if entities:
            nearby_entities = [
                k for k, v in sorted(entities.items(), key=lambda x: x[1])
            ]
            observation += f"Nearby entities (nearest to farthest): {', '.join(nearby_entities)}\n\n"
        else:
            observation += f"Nearby entities (nearest to farthest): None\n\n"

        observation += f"Health: {health:.1f}/20\n\n"

        observation += f"Hunger: {hunger:.1f}/20\n\n"

        observation += f"Position: x={position['x']:.1f}, y={position['y']:.1f}, z={position['z']:.1f}\n\n"

        observation += f"Equipment: {equipment}\n\n"

        if inventory:
            observation += f"Inventory ({inventory_used}/36): {inventory}\n\n"
        else:
            observation += f"Inventory ({inventory_used}/36): Empty\n\n"

        if not (
            task == "Place and deposit useless items into a chest"
            or task.startswith("Deposit useless items into the chest at")
        ):
            observation += self.render_chest_observation()

        observation += f"Task: {task}\n\n"

        if context:
            observation += f"Context: {context}\n\n"
        else:
            observation += f"Context: None\n\n"

        if critique:
            observation += f"Critique: {critique}\n\n"
        else:
            observation += f"Critique: None\n\n"

        return HumanMessage(content=observation)

    def process_ai_message(self, message):
        assert isinstance(message, AIMessage)

        retry = 3
        error = None
        while retry > 0:
            try:
                babel = require("@babel/core")
                babel_generator = require("@babel/generator").default

                code_pattern = re.compile(r"```(?:javascript|js)(.*?)```", re.DOTALL)
                code = "\n".join(code_pattern.findall(message.content))
                parsed = babel.parse(code)
                functions = []
                assert len(list(parsed.program.body)) > 0, "No functions found"
                for i, node in enumerate(parsed.program.body):
                    if node.type != "FunctionDeclaration":
                        continue
                    node_type = (
                        "AsyncFunctionDeclaration"
                        if node["async"]
                        else "FunctionDeclaration"
                    )
                    functions.append(
                        {
                            "name": node.id.name,
                            "type": node_type,
                            "body": babel_generator(node).code,
                            "params": list(node["params"]),
                        }
                    )
                # find the last async function
                main_function = None
                for function in reversed(functions):
                    if function["type"] == "AsyncFunctionDeclaration":
                        main_function = function
                        break
                assert (
                    main_function is not None
                ), "No async function found. Your main function must be async."
                assert (
                    len(main_function["params"]) == 1
                    and main_function["params"][0].name == "bot"
                ), f"Main function {main_function['name']} must take a single argument named 'bot'"
                program_code = "\n\n".join(function["body"] for function in functions)
                exec_code = f"await {main_function['name']}(bot);"
                return {
                    "program_code": program_code,
                    "program_name": main_function["name"],
                    "exec_code": exec_code,
                }
            except Exception as e:
                retry -= 1
                error = e
                time.sleep(1)
        return f"Error parsing action response (before program execution): {error}"

    def summarize_chatlog(self, events):
        def filter_item(message: str):
            craft_pattern = r"I cannot make \w+ because I need: (.*)"
            craft_pattern2 = (
                r"I cannot make \w+ because there is no crafting table nearby"
            )
            mine_pattern = r"I need at least a (.*) to mine \w+!"
            if re.match(craft_pattern, message):
                return re.match(craft_pattern, message).groups()[0]
            elif re.match(craft_pattern2, message):
                return "a nearby crafting table"
            elif re.match(mine_pattern, message):
                return re.match(mine_pattern, message).groups()[0]
            else:
                return ""

        chatlog = set()
        for event_type, event in events:
            if event_type == "onChat":
                item = filter_item(event["onChat"])
                if item:
                    chatlog.add(item)
        return "I also need " + ", ".join(chatlog) + "." if chatlog else ""
