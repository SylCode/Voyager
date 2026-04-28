import pathlib
import os
import voyager.utils as U

_CP_DIR = pathlib.Path(__file__).parent


def load_control_primitives(primitive_names=None):
    package_path = str(_CP_DIR.parent)
    if primitive_names is None:
        primitive_names = [
            primitives[:-3]
            for primitives in os.listdir(f"{package_path}/control_primitives")
            if primitives.endswith(".js")
        ]
    primitives = [
        U.load_text(f"{package_path}/control_primitives/{primitive_name}.js")
        for primitive_name in primitive_names
    ]
    return primitives
