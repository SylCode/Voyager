import re

from voyager.prompts import load_prompt
from voyager.utils.json_utils import fix_and_parse_json
from langchain.chat_models import ChatOpenAI
from langchain.schema import HumanMessage, SystemMessage


class CriticAgent:
    def __init__(
        self,
        model_name="gpt-3.5-turbo",
        temperature=0,
        request_timout=120,
        mode="auto",
    ):
        self.llm = ChatOpenAI(
            model_name=model_name,
            temperature=temperature,
            request_timeout=request_timout,
        )
        assert mode in ["auto", "manual"]
        self.mode = mode

    def render_system_message(self):
        system_message = SystemMessage(content=load_prompt("critic"))
        return system_message

    @staticmethod
    def _compute_inventory_delta(prev_inventory, inventory):
        prev_inv_dict = dict(prev_inventory) if prev_inventory else {}
        cur_inv = dict(inventory) if inventory else {}
        gained = {}
        lost = {}
        all_keys = set(prev_inv_dict) | set(cur_inv)
        for key in all_keys:
            delta = cur_inv.get(key, 0) - prev_inv_dict.get(key, 0)
            if delta > 0:
                gained[key] = delta
            elif delta < 0:
                lost[key] = -delta
        return gained, lost

    @staticmethod
    def _sum_matching_items(items, predicate):
        return sum(count for name, count in items.items() if predicate(name))

    @staticmethod
    def _normalize_item_name(name):
        return name.strip().lower().replace(" ", "_")

    def _count_mined_items(self, requested_item, gained):
        normalized = self._normalize_item_name(requested_item)

        if normalized in {"wood_log", "wood_logs", "log", "logs"}:
            return self._sum_matching_items(
                gained,
                lambda name: name.endswith(("_log", "_wood", "_stem", "_hyphae")),
            )
        if normalized in {"stone"}:
            return self._sum_matching_items(
                gained,
                lambda name: name in {"stone", "cobblestone", "cobbled_deepslate"},
            )
        if normalized in {"coal_ore", "coal"}:
            return gained.get("coal", 0)
        if normalized == "iron_ore":
            return gained.get("raw_iron", 0)
        if normalized == "copper_ore":
            return gained.get("raw_copper", 0)
        if normalized == "gold_ore":
            return gained.get("raw_gold", 0)
        if normalized == "diamond_ore":
            return gained.get("diamond", 0)
        if normalized == "redstone_ore":
            return gained.get("redstone", 0)
        if normalized == "lapis_ore":
            return gained.get("lapis_lazuli", 0)
        if normalized == "emerald_ore":
            return gained.get("emerald", 0)
        if normalized in {
            "grass_block",
            "dirt",
            "coarse_dirt",
            "podzol",
            "mycelium",
            "rooted_dirt",
        }:
            return gained.get("dirt", 0)
        if normalized == "gravel":
            return gained.get("gravel", 0) + gained.get("flint", 0)
        return gained.get(normalized, 0)

    def _deterministic_task_success(self, *, task, gained, inventory=None):
        task_lc = task.strip().lower().replace(".", "")
        matched = re.match(r"^(mine|craft|smelt)\s+(\d+)\s+(.+)$", task_lc)
        if not matched:
            return None

        verb, amount_text, requested_item = matched.groups()
        required_amount = int(amount_text)
        normalized_item = self._normalize_item_name(requested_item)

        if verb == "mine":
            actual_amount = self._count_mined_items(requested_item, gained)
        else:
            actual_amount = gained.get(normalized_item, 0)

        if actual_amount >= required_amount:
            return True, ""

        # Fallback: if the bot already has enough of the target item in its
        # CURRENT inventory (e.g. carried over from earlier tasks), the task is
        # objectively complete even though this attempt's delta is small.
        # Without this, the bot loops forever re-mining stone it already has.
        if inventory:
            absolute_amount = (
                self._count_mined_items(requested_item, inventory)
                if verb == "mine"
                else inventory.get(normalized_item, 0)
            )
            if absolute_amount >= required_amount:
                return True, ""

        critique = (
            f"Inventory delta gained {actual_amount}/{required_amount} of the required "
            f"result for '{task}' during this attempt."
        )
        return False, critique

    def render_human_message(
        self, *, events, task, context, chest_observation, prev_inventory=None
    ):
        assert events[-1][0] == "observe", "Last event must be observe"
        biome = events[-1][1]["status"]["biome"]
        time_of_day = events[-1][1]["status"]["timeOfDay"]
        voxels = events[-1][1]["voxels"]
        health = events[-1][1]["status"]["health"]
        hunger = events[-1][1]["status"]["food"]
        position = events[-1][1]["status"]["position"]
        equipment = events[-1][1]["status"]["equipment"]
        inventory_used = events[-1][1]["status"]["inventoryUsed"]
        inventory = events[-1][1]["inventory"]

        # Compute inventory delta vs the snapshot taken at the start of this
        # attempt (passed in by Voyager.step). Mining/crafting tasks succeed
        # by *gaining* resources, so the critic must see what changed during
        # this attempt — pre-existing stockpiles do not count.
        gained, lost = self._compute_inventory_delta(prev_inventory, inventory)

        for i, (event_type, event) in enumerate(events):
            if event_type == "onError":
                print(f"\033[31mCritic Agent: Error occurs {event['onError']}\033[0m")
                return None

        observation = ""

        observation += f"Biome: {biome}\n\n"

        observation += f"Time: {time_of_day}\n\n"

        if voxels:
            observation += f"Nearby blocks: {', '.join(voxels)}\n\n"
        else:
            observation += f"Nearby blocks: None\n\n"

        observation += f"Health: {health:.1f}/20\n\n"
        observation += f"Hunger: {hunger:.1f}/20\n\n"

        observation += f"Position: x={position['x']:.1f}, y={position['y']:.1f}, z={position['z']:.1f}\n\n"

        observation += f"Equipment: {equipment}\n\n"

        if inventory:
            observation += f"Inventory ({inventory_used}/36): {inventory}\n\n"
        else:
            observation += f"Inventory ({inventory_used}/36): Empty\n\n"

        # Inventory delta is the source of truth for mine/craft/smelt success.
        observation += f"Inventory delta during this attempt — gained: {gained or 'nothing'}; lost: {lost or 'nothing'}\n\n"

        observation += chest_observation

        observation += f"Task: {task}\n\n"

        if context:
            observation += f"Context: {context}\n\n"
        else:
            observation += f"Context: None\n\n"

        print(f"\033[31m****Critic Agent human message****\n{observation}\033[0m")
        return HumanMessage(content=observation)

    def human_check_task_success(self):
        confirmed = False
        success = False
        critique = ""
        while not confirmed:
            success = input("Success? (y/n)")
            success = success.lower() == "y"
            critique = input("Enter your critique:")
            print(f"Success: {success}\nCritique: {critique}")
            confirmed = input("Confirm? (y/n)") in ["y", ""]
        return success, critique

    def ai_check_task_success(self, messages, max_retries=5):
        if max_retries == 0:
            print(
                "\033[31mFailed to parse Critic Agent response. Consider updating your prompt.\033[0m"
            )
            return False, ""

        if messages[1] is None:
            return False, ""

        critic = self.llm.invoke(messages).content
        print(f"\033[31m****Critic Agent ai message****\n{critic}\033[0m")
        try:
            response = fix_and_parse_json(critic)
            assert response["success"] in [True, False]
            if "critique" not in response:
                response["critique"] = ""
            return response["success"], response["critique"]
        except Exception as e:
            print(f"\033[31mError parsing critic response: {e} Trying again!\033[0m")
            return self.ai_check_task_success(
                messages=messages,
                max_retries=max_retries - 1,
            )

    def check_task_success(
        self,
        *,
        events,
        task,
        context,
        chest_observation,
        max_retries=5,
        prev_inventory=None,
    ):
        human_message = self.render_human_message(
            events=events,
            task=task,
            context=context,
            chest_observation=chest_observation,
            prev_inventory=prev_inventory,
        )

        messages = [
            self.render_system_message(),
            human_message,
        ]

        inventory = events[-1][1].get("inventory", {}) if events else {}
        gained, _lost = self._compute_inventory_delta(prev_inventory, inventory)
        deterministic_result = self._deterministic_task_success(
            task=task,
            gained=gained,
            inventory=inventory,
        )
        if deterministic_result is not None:
            return deterministic_result

        if self.mode == "manual":
            return self.human_check_task_success()
        elif self.mode == "auto":
            return self.ai_check_task_success(
                messages=messages, max_retries=max_retries
            )
        else:
            raise ValueError(f"Invalid critic agent mode: {self.mode}")
