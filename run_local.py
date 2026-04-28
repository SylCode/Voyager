#!/usr/bin/env python3
"""
Run Voyager against the local Forge 1.18.2 server.

Architecture:
    Voyager (Python)
        └── voyager/env/mineflayer/index.js  (Node, mineflayer 1.18.2 protocol)
                └── localhost:25566  (forge-proxy.js, vanilla→Forge bridge)
                        └── localhost:25565  (the actual Forge 1.18.2 server)

Required env vars (set them in your shell before running, never hard-code):
    OPENAI_API_KEY   — your OpenAI API key
    OPENAI_MODEL     — chat model name (default: gpt-4o-mini)
    LLM_BASE_URL     — optional OpenAI-compatible base URL for a local/remote backend
    MC_PORT          — proxy port mineflayer should connect to (default: 25566)
    UPSTREAM_PORT    — real Forge server port (default: 25565)
"""
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent
MINEAI_PROXY = Path("/home/mykyta/repos/MineAI/bot/forge-proxy.js")

# Load .env from the repo root (OPENAI_API_KEY etc.)
load_dotenv(REPO_ROOT / ".env")

# ── Config ────────────────────────────────────────────────────────────────
MC_PORT = int(os.environ.get("MC_PORT", "25566"))
UPSTREAM_PORT = int(os.environ.get("UPSTREAM_PORT", "25565"))
MC_HOST = os.environ.get("MC_HOST", "localhost")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL") or os.environ.get("OPENAI_API_BASE")
OPENAI_KEY = os.environ.get("OPENAI_API_KEY")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL")

if LLM_BASE_URL:
    os.environ["OPENAI_API_BASE"] = LLM_BASE_URL.rstrip("/")
    OPENAI_KEY = OPENAI_KEY or "local"

if not OPENAI_KEY:
    sys.exit("ERROR: OPENAI_API_KEY env var is not set.")
if not MINEAI_PROXY.exists():
    sys.exit(f"ERROR: forge proxy not found at {MINEAI_PROXY}")

# ── Tell mineflayer how to talk to the proxy ──────────────────────────────
os.environ["MC_HOST"] = MC_HOST
os.environ["MC_VERSION"] = os.environ.get("MC_VERSION", "1.18.2")
os.environ["MC_AUTH"] = os.environ.get("MC_AUTH", "offline")
os.environ["MC_USERNAME"] = os.environ.get("MC_USERNAME", "Voyager")

# ── Tell forge-proxy how to talk to the Forge server ──────────────────────
proxy_env = os.environ.copy()
proxy_env.setdefault("PROXY_PORT", str(MC_PORT))
proxy_env.setdefault("HOST", MC_HOST)
proxy_env.setdefault("PORT", str(UPSTREAM_PORT))
proxy_env.setdefault("MC_VERSION", "1.18.2")
proxy_env.setdefault("AUTH", "offline")

# ── Optional: force re-capture of Forge handshake (modded registries) ─────
# Pass --rebuild-forge-registry on the command line, or set
# REBUILD_FORGE_REGISTRY=1, when adding/removing mods.
_proxy_extra_args = []
if "--rebuild-forge-registry" in sys.argv:
    sys.argv.remove("--rebuild-forge-registry")
    proxy_env["REBUILD_FORGE_REGISTRY"] = "1"
    _proxy_extra_args.append("--rebuild-forge-registry")
    print("[run_local] forge handshake registry capture: REBUILD requested")


def _free_stale_listener(port: int) -> None:
    result = subprocess.run(
        ["fuser", "-k", f"{port}/tcp"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        print(f"[run_local] freed stale listener on :{port}")


# ── Start the Forge proxy ─────────────────────────────────────────────────
_free_stale_listener(MC_PORT)
print(f"[run_local] starting forge-proxy on :{MC_PORT} → {MC_HOST}:{UPSTREAM_PORT}")
proxy = subprocess.Popen(
    ["node", str(MINEAI_PROXY), *_proxy_extra_args],
    cwd=str(MINEAI_PROXY.parent),
    env=proxy_env,
)


def _shutdown(*_):
    print("\n[run_local] shutting down proxy")
    proxy.send_signal(signal.SIGTERM)
    try:
        proxy.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proxy.kill()
    sys.exit(0)


signal.signal(signal.SIGINT, _shutdown)
signal.signal(signal.SIGTERM, _shutdown)

# Give the proxy a moment to bind
time.sleep(2)
if proxy.poll() is not None:
    sys.exit(f"ERROR: forge-proxy exited with code {proxy.returncode} at startup")

# ── Make `voyager` importable ─────────────────────────────────────────────
sys.path.insert(0, str(REPO_ROOT))
from voyager import Voyager  # noqa: E402

print(f"[run_local] launching Voyager (model={OPENAI_MODEL}, mc_port={MC_PORT})")
voyager = Voyager(
    mc_port=MC_PORT,
    openai_api_key=OPENAI_KEY,
    action_agent_model_name=OPENAI_MODEL,
    curriculum_agent_model_name=OPENAI_MODEL,
    curriculum_agent_qa_model_name=OPENAI_MODEL,
    critic_agent_model_name=OPENAI_MODEL,
    skill_manager_model_name=OPENAI_MODEL,
    ckpt_dir=str(REPO_ROOT / "ckpt"),
    resume=True,
    max_iterations=10000,
)

try:
    voyager.learn()
except BaseException:
    import traceback

    print("\n[run_local] learn() crashed:")
    traceback.print_exc()
finally:
    _shutdown()
