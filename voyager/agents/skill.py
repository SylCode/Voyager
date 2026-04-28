import os
import re

import voyager.utils as U
from langchain.chat_models import ChatOpenAI
from langchain.embeddings.openai import OpenAIEmbeddings
from langchain.schema import HumanMessage, SystemMessage
from langchain.vectorstores import Chroma

from voyager.prompts import load_prompt
from voyager.control_primitives import load_control_primitives


class SkillManager:
    def __init__(
        self,
        model_name="gpt-3.5-turbo",
        temperature=0,
        retrieval_top_k=5,
        request_timout=120,
        ckpt_dir="ckpt",
        resume=False,
    ):
        self.llm = ChatOpenAI(
            model_name=model_name,
            temperature=temperature,
            request_timeout=request_timout,
        )
        U.f_mkdir(f"{ckpt_dir}/skill/code")
        U.f_mkdir(f"{ckpt_dir}/skill/description")
        U.f_mkdir(f"{ckpt_dir}/skill/vectordb")
        # programs for env execution
        self.control_primitives = load_control_primitives()
        if resume:
            print(f"\033[33mLoading Skill Manager from {ckpt_dir}/skill\033[0m")
            self.skills = U.load_json(f"{ckpt_dir}/skill/skills.json")
        else:
            self.skills = {}
        self.retrieval_top_k = retrieval_top_k
        self.ckpt_dir = ckpt_dir
        self.skill_embeddings_ready = True
        self.vectordb = Chroma(
            collection_name="skill_vectordb",
            embedding_function=OpenAIEmbeddings(),
            persist_directory=f"{ckpt_dir}/skill/vectordb",
        )
        self._sync_skill_vectordb()

    def _vectordb_count(self):
        try:
            return self.vectordb._collection.count()
        except Exception:
            return 0

    def _disable_skill_embeddings(self, exc, action):
        if self.skill_embeddings_ready:
            print(
                f"\033[33mSkill Manager disabling embeddings after failing to {action}: {exc}\033[0m"
            )
        self.skill_embeddings_ready = False

    def _sync_skill_vectordb(self):
        current_count = self._vectordb_count()
        if current_count == len(self.skills):
            return
        print(
            f"\033[33mSkill Manager vectordb out of sync "
            f"({current_count} in db vs {len(self.skills)} in skills.json). "
            f"Repopulating vectordb from skills.json...\033[0m"
        )
        try:
            if current_count > 0:
                existing_ids = self.vectordb._collection.get()["ids"]
                self.vectordb._collection.delete(ids=existing_ids)
            for skill_name, entry in self.skills.items():
                self.vectordb.add_texts(
                    texts=[entry["description"]],
                    ids=[skill_name],
                    metadatas=[{"name": skill_name}],
                )
            self.vectordb.persist()
            print(
                f"\033[33mRepopulated vectordb with {len(self.skills)} skills.\033[0m"
            )
        except Exception as exc:
            self._disable_skill_embeddings(exc, "sync skill vectordb")

    def _store_skill_embedding(self, program_name, skill_description):
        if not self.skill_embeddings_ready:
            return False
        try:
            self.vectordb.add_texts(
                texts=[skill_description],
                ids=[program_name],
                metadatas=[{"name": program_name}],
            )
            self.vectordb.persist()
            return True
        except Exception as exc:
            self._disable_skill_embeddings(exc, f"store skill '{program_name}'")
            return False

    def _lexical_skill_matches(self, query, k):
        query_tokens = set(re.findall(r"[a-z0-9_]+", query.lower()))
        if not query_tokens:
            return []
        ranked = []
        for skill_name, entry in self.skills.items():
            haystack = f"{skill_name} {entry['description']}".lower()
            haystack_tokens = set(re.findall(r"[a-z0-9_]+", haystack))
            overlap = len(query_tokens & haystack_tokens)
            if overlap == 0:
                continue
            ranked.append((overlap, skill_name))
        ranked.sort(key=lambda item: (-item[0], item[1]))
        return [self.skills[skill_name]["code"] for _, skill_name in ranked[:k]]

    @property
    def programs(self):
        programs = ""
        for skill_name, entry in self.skills.items():
            programs += f"{entry['code']}\n\n"
        for primitives in self.control_primitives:
            programs += f"{primitives}\n\n"
        return programs

    def add_new_skill(self, info):
        if info["task"].startswith("Deposit useless items into the chest at"):
            # No need to reuse the deposit skill
            return
        if info["task"] in (
            "Place a double chest",
            "Craft 2 chests",
            "Craft 1 more chest",
        ):
            # Chest setup tasks are one-time — don't pollute the skill library
            return
        program_name = info["program_name"]
        program_code = info["program_code"]
        # Sanitize known broken LLM patterns before persisting.
        # The LLM frequently generates a sticks bail-out that fires before any
        # sticks are ever crafted.  Strip it so the stored skill stays correct.
        import re as _re_skill

        program_code = _re_skill.sub(
            r"[ \t]*if\s*\(\s*countSticks\(\)\s*<\s*2\s*\)\s*\{[^}]*not enough sticks[^}]*\}\n?",
            "",
            program_code,
            flags=_re_skill.DOTALL,
        )
        skill_description = self.generate_skill_description(program_name, program_code)
        print(
            f"\033[33mSkill Manager generated description for {program_name}:\n{skill_description}\033[0m"
        )
        if program_name in self.skills:
            print(f"\033[33mSkill {program_name} already exists. Rewriting!\033[0m")
            if self.skill_embeddings_ready:
                try:
                    self.vectordb._collection.delete(ids=[program_name])
                except Exception as exc:
                    self._disable_skill_embeddings(
                        exc, f"delete skill '{program_name}'"
                    )
            i = 2
            while f"{program_name}V{i}.js" in os.listdir(f"{self.ckpt_dir}/skill/code"):
                i += 1
            dumped_program_name = f"{program_name}V{i}"
        else:
            dumped_program_name = program_name
        self.skills[program_name] = {
            "code": program_code,
            "description": skill_description,
        }
        self._store_skill_embedding(program_name, skill_description)
        U.dump_text(
            program_code, f"{self.ckpt_dir}/skill/code/{dumped_program_name}.js"
        )
        U.dump_text(
            skill_description,
            f"{self.ckpt_dir}/skill/description/{dumped_program_name}.txt",
        )
        U.dump_json(self.skills, f"{self.ckpt_dir}/skill/skills.json")

    def generate_skill_description(self, program_name, program_code):
        messages = [
            SystemMessage(content=load_prompt("skill")),
            HumanMessage(
                content=program_code
                + "\n\n"
                + f"The main function is `{program_name}`."
            ),
        ]
        skill_description = f"    // { self.llm.invoke(messages).content}"
        return f"async function {program_name}(bot) {{\n{skill_description}\n}}"

    def retrieve_skills(self, query):
        k = min(self._vectordb_count(), self.retrieval_top_k)
        if k == 0:
            return self._lexical_skill_matches(query, self.retrieval_top_k)
        print(f"\033[33mSkill Manager retrieving for {k} skills\033[0m")
        try:
            docs_and_scores = self.vectordb.similarity_search_with_score(query, k=k)
        except Exception as exc:
            self._disable_skill_embeddings(exc, "query skill vectordb")
            return self._lexical_skill_matches(query, self.retrieval_top_k)
        print(
            f"\033[33mSkill Manager retrieved skills: "
            f"{', '.join([doc.metadata['name'] for doc, _ in docs_and_scores])}\033[0m"
        )
        skills = []
        for doc, _ in docs_and_scores:
            skills.append(self.skills[doc.metadata["name"]]["code"])
        return skills
