import copy
import json
import os
import time
from typing import Dict

import voyager.utils as U
from .env import VoyagerEnv

from .agents import ActionAgent
from .agents import CriticAgent
from .agents import CurriculumAgent
from .agents import SkillManager


# TODO: remove event memory
class Voyager:
    def __init__(
        self,
        mc_port: int = None,
        azure_login: Dict[str, str] = None,
        server_port: int = 3000,
        openai_api_key: str = None,
        env_wait_ticks: int = 20,
        env_request_timeout: int = 600,
        max_iterations: int = 160,
        reset_placed_if_failed: bool = False,
        action_agent_model_name: str = "gpt-4",
        action_agent_temperature: float = 0,
        action_agent_task_max_retries: int = 4,
        action_agent_show_chat_log: bool = True,
        action_agent_show_execution_error: bool = True,
        curriculum_agent_model_name: str = "gpt-4",
        curriculum_agent_temperature: float = 0,
        curriculum_agent_qa_model_name: str = "gpt-3.5-turbo",
        curriculum_agent_qa_temperature: float = 0,
        curriculum_agent_warm_up: Dict[str, int] = None,
        curriculum_agent_core_inventory_items: str = r".*_log|.*_planks|stick|crafting_table|furnace"
        r"|cobblestone|dirt|coal|.*_pickaxe|.*_sword|.*_axe",
        curriculum_agent_mode: str = "auto",
        critic_agent_model_name: str = "gpt-4",
        critic_agent_temperature: float = 0,
        critic_agent_mode: str = "auto",
        skill_manager_model_name: str = "gpt-3.5-turbo",
        skill_manager_temperature: float = 0,
        skill_manager_retrieval_top_k: int = 5,
        openai_api_request_timeout: int = 240,
        ckpt_dir: str = "ckpt",
        skill_library_dir: str = None,
        resume: bool = False,
    ):
        """
        The main class for Voyager.
        Action agent is the iterative prompting mechanism in paper.
        Curriculum agent is the automatic curriculum in paper.
        Critic agent is the self-verification in paper.
        Skill manager is the skill library in paper.
        :param mc_port: minecraft in-game port
        :param azure_login: minecraft login config
        :param server_port: mineflayer port
        :param openai_api_key: openai api key
        :param env_wait_ticks: how many ticks at the end each step will wait, if you found some chat log missing,
        you should increase this value
        :param env_request_timeout: how many seconds to wait for each step, if the code execution exceeds this time,
        python side will terminate the connection and need to be resumed
        :param reset_placed_if_failed: whether to reset placed blocks if failed, useful for building task
        :param action_agent_model_name: action agent model name
        :param action_agent_temperature: action agent temperature
        :param action_agent_task_max_retries: how many times to retry if failed
        :param curriculum_agent_model_name: curriculum agent model name
        :param curriculum_agent_temperature: curriculum agent temperature
        :param curriculum_agent_qa_model_name: curriculum agent qa model name
        :param curriculum_agent_qa_temperature: curriculum agent qa temperature
        :param curriculum_agent_warm_up: info will show in curriculum human message
        if completed task larger than the value in dict, available keys are:
        {
            "context": int,
            "biome": int,
            "time": int,
            "other_blocks": int,
            "nearby_entities": int,
            "health": int,
            "hunger": int,
            "position": int,
            "equipment": int,
            "chests": int,
            "optional_inventory_items": int,
        }
        :param curriculum_agent_core_inventory_items: only show these items in inventory before optional_inventory_items
        reached in warm up
        :param curriculum_agent_mode: "auto" for automatic curriculum, "manual" for human curriculum
        :param critic_agent_model_name: critic agent model name
        :param critic_agent_temperature: critic agent temperature
        :param critic_agent_mode: "auto" for automatic critic ,"manual" for human critic
        :param skill_manager_model_name: skill manager model name
        :param skill_manager_temperature: skill manager temperature
        :param skill_manager_retrieval_top_k: how many skills to retrieve for each task
        :param openai_api_request_timeout: how many seconds to wait for openai api
        :param ckpt_dir: checkpoint dir
        :param skill_library_dir: skill library dir
        :param resume: whether to resume from checkpoint
        """
        # init env
        self.env = VoyagerEnv(
            mc_port=mc_port,
            azure_login=azure_login,
            server_port=server_port,
            request_timeout=env_request_timeout,
        )
        self.env_wait_ticks = env_wait_ticks
        self.reset_placed_if_failed = reset_placed_if_failed
        self.max_iterations = max_iterations

        # set openai api key
        os.environ["OPENAI_API_KEY"] = openai_api_key

        # init agents
        self.action_agent = ActionAgent(
            model_name=action_agent_model_name,
            temperature=action_agent_temperature,
            request_timout=openai_api_request_timeout,
            ckpt_dir=ckpt_dir,
            resume=resume,
            chat_log=action_agent_show_chat_log,
            execution_error=action_agent_show_execution_error,
        )
        self.action_agent_task_max_retries = action_agent_task_max_retries
        self.curriculum_agent = CurriculumAgent(
            model_name=curriculum_agent_model_name,
            temperature=curriculum_agent_temperature,
            qa_model_name=curriculum_agent_qa_model_name,
            qa_temperature=curriculum_agent_qa_temperature,
            request_timout=openai_api_request_timeout,
            ckpt_dir=ckpt_dir,
            resume=resume,
            mode=curriculum_agent_mode,
            warm_up=curriculum_agent_warm_up,
            core_inventory_items=curriculum_agent_core_inventory_items,
        )
        self.critic_agent = CriticAgent(
            model_name=critic_agent_model_name,
            temperature=critic_agent_temperature,
            request_timout=openai_api_request_timeout,
            mode=critic_agent_mode,
        )
        self.skill_manager = SkillManager(
            model_name=skill_manager_model_name,
            temperature=skill_manager_temperature,
            retrieval_top_k=skill_manager_retrieval_top_k,
            request_timout=openai_api_request_timeout,
            ckpt_dir=skill_library_dir if skill_library_dir else ckpt_dir,
            resume=True if resume or skill_library_dir else False,
        )
        self.recorder = U.EventRecorder(ckpt_dir=ckpt_dir, resume=resume)
        self.resume = resume

        # init variables for rollout
        self.action_agent_rollout_num_iter = -1
        self.task = None
        self.context = ""
        self.messages = None
        self.conversations = []
        self.last_events = None
        # Inventory snapshot at the beginning of the current attempt, used by the
        # critic to judge mine/craft/smelt success via a true delta.
        self.attempt_start_inventory = {}

    def reset(self, task, context="", reset_env=True):
        self.action_agent_rollout_num_iter = 0
        self.task = task
        self.context = context
        if reset_env:
            self.env.reset(
                options={
                    "mode": "soft",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
        difficulty = (
            "easy" if len(self.curriculum_agent.completed_tasks) > 15 else "peaceful"
        )
        # step to peek an observation
        events = self.env.step(
            "bot.chat(`/time set ${getNextTime()}`);\n"
            + f"bot.chat('/difficulty {difficulty}');"
        )
        # ── Auto-recover death totem if the bot died last task ──────────────
        try:
            last_status = events[-1][1] if events else {}
            if last_status.get("deathPos"):
                print(
                    "\033[35m[rollout] death position detected – running recoverDeathTotem\033[0m"
                )
                events = self.env.step("await recoverDeathTotem(bot);")
        except Exception as _e:
            print(f"[rollout] recoverDeathTotem step failed (non-fatal): {_e}")
        skills = self.skill_manager.retrieve_skills(query=self.context)
        print(
            f"\033[33mRender Action Agent system message with {len(skills)} skills\033[0m"
        )
        system_message = self.action_agent.render_system_message(skills=skills)
        human_message = self.action_agent.render_human_message(
            events=events, code="", task=self.task, context=context, critique=""
        )
        # Snapshot inventory now so the first attempt's delta is computed
        # against the true pre-attempt state (events[-1] is the post-state).
        try:
            self.attempt_start_inventory = dict(
                events[-1][1].get("inventory", {}) or {}
            )
        except Exception:
            self.attempt_start_inventory = {}
        self.messages = [system_message, human_message]
        print(
            f"\033[32m****Action Agent human message****\n{human_message.content}\033[0m"
        )
        assert len(self.messages) == 2
        self.conversations = []
        return self.messages

    def close(self):
        self.env.close()

    def step(self):
        if self.action_agent_rollout_num_iter < 0:
            raise ValueError("Agent must be reset before stepping")
        ai_message = self.action_agent.deterministic_response(self.task)
        if ai_message is None:
            ai_message = self.action_agent.llm.invoke(self.messages)
        print(f"\033[34m****Action Agent ai message****\n{ai_message.content}\033[0m")
        self.conversations.append(
            (self.messages[0].content, self.messages[1].content, ai_message.content)
        )
        parsed_result = self.action_agent.process_ai_message(message=ai_message)
        success = False
        if isinstance(parsed_result, dict):
            code = parsed_result["program_code"] + "\n" + parsed_result["exec_code"]
            events = self.env.step(
                code,
                programs=self.skill_manager.programs,
            )
            self.recorder.record(events, self.task)
            self.action_agent.update_chest_memory(events[-1][1]["nearbyChests"])

            # If the bot died during this step, abandon the task immediately —
            # no point retrying with a freshly respawned, empty-handed bot.
            _bot_died = any(
                event_type == "onError"
                and "bot died" in event.get("onError", "").lower()
                for event_type, event in events
            )
            if _bot_died:
                print(
                    "\033[35m[step] Bot died during task — abandoning without retry\033[0m"
                )
                self.action_agent_rollout_num_iter = self.action_agent_task_max_retries
                self.last_events = copy.deepcopy(events)
                info = {
                    "task": self.task,
                    "success": False,
                    "conversations": self.conversations,
                }
                return self.messages, 0, True, info

            success, critique = self.critic_agent.check_task_success(
                events=events,
                task=self.task,
                context=self.context,
                chest_observation=self.action_agent.render_chest_observation(),
                max_retries=5,
                prev_inventory=self.attempt_start_inventory,
            )
            # Roll the snapshot forward: next attempt starts from this state.
            try:
                self.attempt_start_inventory = dict(
                    events[-1][1].get("inventory", {}) or {}
                )
            except Exception:
                self.attempt_start_inventory = {}

            if self.reset_placed_if_failed and not success:
                # revert all the placing event in the last step
                blocks = []
                positions = []
                for event_type, event in events:
                    if event_type == "onSave" and event["onSave"].endswith("_placed"):
                        block = event["onSave"].split("_placed")[0]
                        position = event["status"]["position"]
                        blocks.append(block)
                        positions.append(position)
                new_events = self.env.step(
                    f"await givePlacedItemBack(bot, {U.json_dumps(blocks)}, {U.json_dumps(positions)})",
                    programs=self.skill_manager.programs,
                )
                events[-1][1]["inventory"] = new_events[-1][1]["inventory"]
                events[-1][1]["voxels"] = new_events[-1][1]["voxels"]
            new_skills = self.skill_manager.retrieve_skills(
                query=self.context
                + "\n\n"
                + self.action_agent.summarize_chatlog(events)
            )
            system_message = self.action_agent.render_system_message(skills=new_skills)
            human_message = self.action_agent.render_human_message(
                events=events,
                code=parsed_result["program_code"],
                task=self.task,
                context=self.context,
                critique=critique,
            )
            self.last_events = copy.deepcopy(events)
            self.messages = [system_message, human_message]
        else:
            assert isinstance(parsed_result, str)
            self.recorder.record([], self.task)
            print(f"\033[34m{parsed_result} Trying again!\033[0m")
        assert len(self.messages) == 2
        self.action_agent_rollout_num_iter += 1
        done = (
            self.action_agent_rollout_num_iter >= self.action_agent_task_max_retries
            or success
        )
        info = {
            "task": self.task,
            "success": success,
            "conversations": self.conversations,
        }
        if success:
            assert (
                "program_code" in parsed_result and "program_name" in parsed_result
            ), "program and program_name must be returned when success"
            info["program_code"] = parsed_result["program_code"]
            info["program_name"] = parsed_result["program_name"]
        else:
            print(
                f"\033[32m****Action Agent human message****\n{self.messages[-1].content}\033[0m"
            )
        return self.messages, 0, done, info

    def rollout(self, *, task, context, reset_env=True):
        self.reset(task=task, context=context, reset_env=reset_env)
        # Short-circuit: if the bot's CURRENT inventory already satisfies a
        # deterministic mine/craft/smelt task (e.g. "Mine 3 stone" when 21
        # cobblestone is already in inventory), don't invoke the action agent
        # at all — just mark it complete. Avoids burning retries and tokens
        # on tasks that are already done.
        try:
            inventory = (
                self.last_events[-1][1].get("inventory", {}) if self.last_events else {}
            )
            preempt = self.critic_agent._deterministic_task_success(
                task=task,
                gained={},
                inventory=inventory,
            )
            if preempt is not None and preempt[0]:
                print(
                    f"\033[36m[rollout] task '{task}' already satisfied by current "
                    f"inventory; skipping action agent.\033[0m"
                )
                info = {"task": task, "success": True, "conversations": []}
                return self.messages, 0, True, info
        except Exception as _e:
            print(f"[rollout] preempt-check failed (non-fatal): {_e}")
        while True:
            messages, reward, done, info = self.step()
            if done:
                break
        return messages, reward, done, info

    def learn(self, reset_env=True):
        if self.resume:
            # keep the inventory
            self.env.reset(
                options={
                    "mode": "soft",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
        else:
            # clear the inventory
            self.env.reset(
                options={
                    "mode": "hard",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
            self.resume = True
        self.last_events = self.env.step("")

        # ── Capture / restore home position ──────────────────────────────────
        # Home position = the bot's surface spawn location, recorded once and
        # reused across restarts. All chests and appliances should be near here.
        _home_pos_file = f"{self.recorder.ckpt_dir}/home_position.json"
        if os.path.exists(_home_pos_file):
            try:
                self._home_position = U.load_json(_home_pos_file)
                print(
                    f"\033[35m[Home] Loaded home position: {self._home_position}\033[0m"
                )
            except Exception as _he:
                print(f"[Home] Failed to load home_position.json: {_he}")
                self._home_position = None
        else:
            try:
                _pos = self.last_events[-1][1]["status"]["position"]
                self._home_position = {
                    "x": round(_pos["x"]),
                    "y": round(_pos["y"]),
                    "z": round(_pos["z"]),
                }
                U.dump_json(self._home_position, _home_pos_file)
                print(
                    f"\033[35m[Home] Recorded home position: {self._home_position}\033[0m"
                )
            except Exception as _he:
                print(f"[Home] Failed to record home position: {_he}")
                self._home_position = None
        # Share home position with action agent so it filters chest observation
        self.action_agent.home_position = self._home_position

        while True:
            if self.recorder.iteration > self.max_iterations:
                print("Iteration limit reached")
                break
            task, context = self.curriculum_agent.propose_next_task(
                events=self.last_events,
                chest_observation=self.action_agent.render_chest_observation(),
                max_retries=5,
                preempt_check=self.critic_agent._deterministic_task_success,
                home_position=getattr(self, "_home_position", None),
            )
            print(
                f"\033[35mStarting task {task} for at most {self.action_agent_task_max_retries} times\033[0m"
            )
            # Safety: if the bot is currently in water, wait a few seconds for
            # the water-escape ticker to surface it before starting any task.
            try:
                _last_obs = self.last_events[-1][1] if self.last_events else {}
                _biome = _last_obs.get("status", {}).get("biome", "")
                _blocks = _last_obs.get("nearbyBlocks", [])
                if isinstance(_blocks, list) and any(
                    "water" in str(b).lower() for b in _blocks
                ):
                    print(
                        "\033[35m[Safety] Bot near water — waiting 5 s before starting task.\033[0m"
                    )
                    import time as _time_w

                    _time_w.sleep(5)
            except Exception:
                pass

            # If the bot is underground and needs to deposit loot, teleport home
            # first via /home so it arrives next to the base chests instantly.
            # "Underground" = biome tag set to "underground" by the curriculum
            # observation renderer (no surface blocks nearby).
            try:
                _deposit_task = task.startswith(
                    "Deposit useless items into the chest at"
                )
                if _deposit_task:
                    _obs = self.last_events[-1][1] if self.last_events else {}
                    _voxels = _obs.get("voxels", [])
                    _surface_names = {
                        "dirt",
                        "grass_block",
                        "coarse_dirt",
                        "podzol",
                        "mycelium",
                        "rooted_dirt",
                        "sand",
                        "gravel",
                        "snow_block",
                        "moss_block",
                    }
                    _is_underground = not any(
                        any(s in str(v) for s in _surface_names) for v in _voxels
                    )
                    _pos_y = _obs.get("status", {}).get("position", {}).get("y", 64)
                    # Also consider underground if y < 40 regardless of biome tag
                    if _is_underground or _pos_y < 40:
                        print(
                            f"\033[35m[Home] Bot underground (y={_pos_y:.0f}) before deposit — "
                            "issuing /home to teleport to base\033[0m"
                        )
                        self.last_events = self.env.step(
                            "bot.chat('/home');\n"
                            "await new Promise(r => setTimeout(r, 3000));"
                        )
            except Exception as _home_err:
                print(f"[Home] Pre-deposit /home step failed (non-fatal): {_home_err}")

            try:
                messages, reward, done, info = self.rollout(
                    task=task,
                    context=context,
                    reset_env=reset_env,
                )
            except Exception as e:
                time.sleep(3)  # wait for mineflayer to exit
                info = {
                    "task": task,
                    "success": False,
                }
                # reset bot status here
                self.last_events = self.env.reset(
                    options={
                        "mode": "hard",
                        "wait_ticks": self.env_wait_ticks,
                        "inventory": self.last_events[-1][1]["inventory"],
                        "equipment": self.last_events[-1][1]["status"]["equipment"],
                        "position": self.last_events[-1][1]["status"]["position"],
                    }
                )
                # use red color background to print the error
                print("Your last round rollout terminated due to error:")
                print(f"\033[41m{e}\033[0m")

            if info["success"]:
                # Preempted tasks (already-satisfied inventory) have no program
                # to register; only add a skill if the action agent ran.
                if "program_name" in info:
                    self.skill_manager.add_new_skill(info)

            self.curriculum_agent.update_exploration_progress(info)
            print(
                f"\033[35mCompleted tasks: {', '.join(self.curriculum_agent.completed_tasks)}\033[0m"
            )
            print(
                f"\033[35mFailed tasks: {', '.join(self.curriculum_agent.failed_tasks)}\033[0m"
            )

        return {
            "completed_tasks": self.curriculum_agent.completed_tasks,
            "failed_tasks": self.curriculum_agent.failed_tasks,
            "skills": self.skill_manager.skills,
        }

    def decompose_task(self, task):
        if not self.last_events:
            self.last_events = self.env.reset(
                options={
                    "mode": "hard",
                    "wait_ticks": self.env_wait_ticks,
                }
            )
        return self.curriculum_agent.decompose_task(task, self.last_events)

    def inference(self, task=None, sub_goals=[], reset_mode="hard", reset_env=True):
        if not task and not sub_goals:
            raise ValueError("Either task or sub_goals must be provided")
        if not sub_goals:
            sub_goals = self.decompose_task(task)
        self.env.reset(
            options={
                "mode": reset_mode,
                "wait_ticks": self.env_wait_ticks,
            }
        )
        self.curriculum_agent.completed_tasks = []
        self.curriculum_agent.failed_tasks = []
        self.last_events = self.env.step("")
        while self.curriculum_agent.progress < len(sub_goals):
            next_task = sub_goals[self.curriculum_agent.progress]
            context = self.curriculum_agent.get_task_context(next_task)
            print(
                f"\033[35mStarting task {next_task} for at most {self.action_agent_task_max_retries} times\033[0m"
            )
            messages, reward, done, info = self.rollout(
                task=next_task,
                context=context,
                reset_env=reset_env,
            )
            self.curriculum_agent.update_exploration_progress(info)
            print(
                f"\033[35mCompleted tasks: {', '.join(self.curriculum_agent.completed_tasks)}\033[0m"
            )
            print(
                f"\033[35mFailed tasks: {', '.join(self.curriculum_agent.failed_tasks)}\033[0m"
            )
