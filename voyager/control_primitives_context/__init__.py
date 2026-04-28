import pathlib
import os
import voyager.utils as U

_CPC_DIR = pathlib.Path(__file__).parent


def load_control_primitives_context(primitive_names=None):
    package_path = str(_CPC_DIR.parent)
    if primitive_names is None:
        primitive_names = [
            primitive[:-3]
            for primitive in os.listdir(f"{package_path}/control_primitives_context")
            if primitive.endswith(".js")
        ]
    primitives = [
        U.load_text(f"{package_path}/control_primitives_context/{primitive_name}.js")
        for primitive_name in primitive_names
    ]
    return primitives
