import pathlib
import voyager.utils as U

_PROMPTS_DIR = pathlib.Path(__file__).parent


def load_prompt(prompt):
    return U.load_text(str(_PROMPTS_DIR / f"{prompt}.txt"))
