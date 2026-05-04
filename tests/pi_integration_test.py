#!/usr/bin/env python3
"""end-to-end integration test for pi-evolve.

mirrors opencode-evolve's opencode_integration_test.py:

  1. spawn a local http server (MockOpenAIServer, shared with opencode-evolve)
     impersonating an openai chat-completions endpoint
  2. load a test-fixture extension that registers a "mock" provider pointing at
     that server (api: "openai-completions")
  3. seed a temp workspace from `examples/hello/` so we run against the actual
     production hook, not a synthetic fixture
  4. run `pi -p "hello" --provider mock --model mock/mock-model`
  5. assert the captured chat-completions requests:
       - build request: hello tools registered, system prompt has hello's
         preamble + chat verbatim, <env> block, no heartbeat content
       - heartbeat request (fired during a stalled build): [heartbeat] prefix,
         hello's heartbeat body, system has preamble + heartbeat but NOT chat

the test requires no api key (mock provider) and depends on no user-installed
pi extension. EVOLVE_TEST_MOCK_API_KEY is the fake key the provider reads.
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PASS = FAIL = 0
PROJECT_ROOT = Path(__file__).resolve().parent.parent
EXTENSION_PATH = PROJECT_ROOT / "src" / "evolve.ts"
PROVIDER_FIXTURE = PROJECT_ROOT / "tests" / "_mock_provider.ts"
TRIGGER_COMPACT_FIXTURE = PROJECT_ROOT / "tests" / "_trigger_compact.ts"
EXAMPLES_HELLO = (PROJECT_ROOT / "examples" / "hello").resolve()
HELLO_PROMPTS = EXAMPLES_HELLO / "prompts"
ARTIFACTS = PROJECT_ROOT / "tests" / ".artifacts"
ARTIFACTS.mkdir(parents=True, exist_ok=True)
PI_BIN = os.environ.get("PI_BIN", "pi")

# mock server pacing — short heartbeat interval + a stall on the first build
# request gives the heartbeat timer room to fire inside the still-alive pi
# process before the build response arrives.
HEARTBEAT_MS = 500
STALL_SECONDS = 5

# the mock openai-compatible server is shared with opencode-evolve so both
# integration tests use the same SSE response format and capture interface.
SHARED_TESTS_DIR = (PROJECT_ROOT / ".." / "opencode-evolve" / "tests").resolve()
if not (SHARED_TESTS_DIR / "mock_openai.py").exists():
    sys.exit(f"FAIL: shared mock_openai.py not found at {SHARED_TESTS_DIR}")
sys.path.insert(0, str(SHARED_TESTS_DIR))
from mock_openai import MockOpenAIServer, is_heartbeat_request  # noqa: E402


# --- assertion helper ---

def check(desc, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS: {desc}")
    else:
        FAIL += 1
        print(f"FAIL: {desc}")
        if detail:
            print(f"  {detail}")


# --- workspace seeding (real hello example) ---

def make_workspace(root: Path) -> Path:
    """seed temp workspace from examples/hello/. running against the real
    production hook validates the load-bearing claim that opencode-evolve
    hooks run unmodified in pi-evolve."""
    ws = root / "workspace"
    shutil.copytree(EXAMPLES_HELLO, ws)
    for p in (ws / "hooks").iterdir():
        if p.is_file():
            p.chmod(p.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return ws


# --- pi invocation ---

def run_pi(workspace: Path, base_url: str, *,
           extra_extensions: list[Path] | None = None,
           extra_env: dict | None = None,
           session_dir: Path | None = None,
           extra_messages: list[str] | None = None,
           timeout: int = 45) -> tuple[str, str]:
    env = {
        **os.environ,
        "EVOLVE_WORKSPACE": str(workspace),
        "EVOLVE_DEBUG": "1",
        "EVOLVE_HEARTBEAT_MS": str(HEARTBEAT_MS),
        "EVOLVE_TEST_MOCK_BASE_URL": base_url,
        "EVOLVE_TEST_MOCK_API_KEY": "test",
        "PI_OFFLINE": "1",
        "CI": "1",
        **(extra_env or {}),
    }
    cmd = [
        PI_BIN,
        "-e", str(EXTENSION_PATH),
        "-e", str(PROVIDER_FIXTURE),
    ]
    for ext in extra_extensions or []:
        cmd += ["-e", str(ext)]
    if session_dir is not None:
        # use a temp session dir so ctx.compact() (which needs a persisted
        # session) works. cannot combine with --no-session.
        cmd += ["--session-dir", str(session_dir)]
    else:
        cmd += ["--no-session"]
    cmd += [
        "--no-extensions",
        "--no-context-files",
        "--provider", "mock",
        "--model", "mock/mock-model",
        "-p", "hello",
    ]
    for m in extra_messages or []:
        cmd.append(m)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, env=env, cwd=str(workspace))
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, stderr = proc.communicate()
        stderr = (stderr or "") + f"\n[test runner: pi timed out after {timeout}s]\n"
    return stdout or "", stderr or ""


# --- system-prompt extraction ---

def extract_system_text(body: dict) -> str:
    parts = []
    for msg in body.get("messages", []):
        if msg.get("role") in ("system", "developer"):
            content = msg.get("content")
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                parts.extend(p.get("text", "") for p in content if isinstance(p, dict))
    return "\n".join(parts)


def extract_user_text(body: dict) -> str:
    parts = []
    for msg in body.get("messages", []):
        if msg.get("role") == "user":
            content = msg.get("content")
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                parts.extend(p.get("text", "") for p in content if isinstance(p, dict))
    return "\n".join(parts)


# --- main ---

def main() -> int:
    if not EXTENSION_PATH.exists():
        print(f"FAIL: extension not found at {EXTENSION_PATH}")
        return 1
    if not PROVIDER_FIXTURE.exists():
        print(f"FAIL: provider fixture not found at {PROVIDER_FIXTURE}")
        return 1
    if not EXAMPLES_HELLO.exists():
        print(f"FAIL: hello example not found at {EXAMPLES_HELLO}")
        return 1
    if not shutil.which(PI_BIN):
        print(f"SKIP: {PI_BIN} not on PATH; set PI_BIN to override")
        return 0

    mock = MockOpenAIServer(stall_first_with_tools=True, stall_seconds=STALL_SECONDS)
    mock.start()
    print(f"mock server on {mock.base_url}")

    with tempfile.TemporaryDirectory(prefix="pi-evolve-test-") as tmp:
        ws = make_workspace(Path(tmp))
        stdout, stderr = run_pi(ws, mock.base_url)

        (ARTIFACTS / "pi_integration.stdout.log").write_text(stdout)
        (ARTIFACTS / "pi_integration.stderr.log").write_text(stderr)
        mock.shutdown()

        # find chat (build) and heartbeat requests in the captured set
        with mock.lock:
            chat_req = next(
                (c for c in mock.captured
                 if "chat/completions" in c["path"]
                 and c["body"].get("tools")
                 and not is_heartbeat_request(c["body"])),
                None,
            )
            hb_req = next(
                (c for c in mock.captured
                 if "chat/completions" in c["path"]
                 and is_heartbeat_request(c["body"])),
                None,
            )
            captured_paths = [c["path"] for c in mock.captured]

        if chat_req:
            (ARTIFACTS / "pi_integration.build_request.json").write_text(
                json.dumps(chat_req, indent=2, default=str))
        if hb_req:
            (ARTIFACTS / "pi_integration.heartbeat_request.json").write_text(
                json.dumps(hb_req, indent=2, default=str))

        # --- extension load + discover ---

        check("extension load: pi-evolve loaded line in stderr",
              "pi-evolve loaded" in stderr, stderr[-500:])
        check("discover: hello hook registered as 'hello'",
              'discovered evolve.py as "hello"' in stderr, stderr[-500:])

        check("build chat/completions request captured", chat_req is not None,
              f"captured paths: {captured_paths}\nstderr tail:\n{stderr[-1000:]}")
        if not chat_req:
            print(f"\n{PASS} passed, {FAIL} failed")
            return 1

        body = chat_req["body"]
        tool_names = [t["function"]["name"] for t in body.get("tools", [])]

        # --- build request: tools ---

        check("build: tools array present", len(tool_names) > 0)
        for required in ["hello_note_list", "hello_note_read",
                         "hello_note_write", "hello_note_delete"]:
            check(f"build: tool registered: {required}", required in tool_names)
        for builtin in ["hello_datetime", "hello_heartbeat_time",
                        "hello_prompt_read", "hello_prompt_write",
                        "hello_hook_read", "hello_hook_write",
                        "hello_hook_validate"]:
            check(f"build: builtin tool registered: {builtin}", builtin in tool_names)

        # every tool parameter has a description (mirrors opencode test)
        missing_desc = []
        for t in body.get("tools", []):
            fn = t.get("function", {})
            params = (fn.get("parameters") or {}).get("properties") or {}
            for pname, pschema in params.items():
                # enum-shaped (anyOf of consts) need not have a top-level
                # description; check anyOf members or the wrapper itself.
                if "description" in pschema:
                    continue
                if pschema.get("anyOf"):
                    continue
                missing_desc.append(f"{fn.get('name')}.{pname}")
        check("build: every tool parameter has a description",
              not missing_desc, f"missing: {missing_desc[:10]}")

        # prompt_read.name enum-locked to contract files
        prompt_read = next((t for t in body["tools"]
                            if t["function"]["name"] == "hello_prompt_read"), None)
        if prompt_read:
            consts = sorted(s.get("const") for s in
                            prompt_read["function"]["parameters"]["properties"]["name"].get("anyOf", []))
            check("build: hello_prompt_read.name enum-locked to contract files",
                  consts == ["chat.md", "compaction.md", "heartbeat.md", "preamble.md", "recover.md"],
                  repr(consts))

        # note_write should expose the priority enum and required name+content
        note_write = next((t for t in body["tools"]
                           if t["function"]["name"] == "hello_note_write"), None)
        if note_write:
            params = note_write["function"]["parameters"]
            check("build: hello_note_write.name required",
                  "name" in params.get("required", []))
            check("build: hello_note_write.content required",
                  "content" in params.get("required", []))
            priority = params["properties"].get("priority", {})
            consts = sorted(s.get("const") for s in priority.get("anyOf", []))
            check("build: hello_note_write.priority enum round-trip",
                  consts == ["high", "low", "normal"], repr(consts))

        # --- build request: system prompt fidelity ---

        sys_text = extract_system_text(body)
        preamble = HELLO_PROMPTS.joinpath("preamble.md").read_text().strip()
        chat = HELLO_PROMPTS.joinpath("chat.md").read_text().strip()
        heartbeat_body = HELLO_PROMPTS.joinpath("heartbeat.md").read_text().strip()

        check("build: system prompt non-empty", len(sys_text) > 100, f"len={len(sys_text)}")
        check("build: system prompt contains hello preamble verbatim",
              preamble in sys_text, sys_text[:500])
        check("build: system prompt contains hello chat stage verbatim",
              chat in sys_text, sys_text[:500])
        check("build: system prompt does NOT include heartbeat stage body",
              heartbeat_body not in sys_text, sys_text[:500])
        check("build: system prompt contains <env> block",
              "<env>" in sys_text and "</env>" in sys_text, sys_text[:500])

        # --- heartbeat request ---

        check("heartbeat chat/completions request captured", hb_req is not None,
              f"captured paths: {captured_paths}\nstderr tail:\n{stderr[-1000:]}")

        if hb_req:
            hb_body = hb_req["body"]
            hb_user = extract_user_text(hb_body)
            hb_sys = extract_system_text(hb_body)

            # evolve.ts spawns a fresh in-process agent session for each
            # heartbeat (via createAgentSession + DefaultResourceLoader with
            # the heartbeat-stage system prompt). this matches opencode-evolve's
            # architecture: the heartbeat session has its own system prompt
            # (preamble + heartbeat) and a clean history (no prior build turn).
            check("heartbeat: user message has [heartbeat] prefix",
                  "[heartbeat]" in hb_user, hb_user[:300])
            check("heartbeat: user message contains hello heartbeat body",
                  heartbeat_body in hb_user, hb_user[:500])
            check("heartbeat: system prompt non-empty",
                  len(hb_sys) > 50, f"len={len(hb_sys)}")
            check("heartbeat: system prompt contains hello preamble verbatim",
                  preamble in hb_sys, hb_sys[:500])
            check("heartbeat: system prompt contains heartbeat stage verbatim",
                  heartbeat_body in hb_sys, hb_sys[:500])
            check("heartbeat: system prompt does NOT include chat stage body",
                  chat not in hb_sys, hb_sys[:500])
            check("heartbeat: fresh session — only one user message in history",
                  len([m for m in hb_body.get("messages", []) if m.get("role") == "user"]) == 1,
                  f"user-role messages: {[m.get('content') for m in hb_body.get('messages', []) if m.get('role') == 'user']}")
            check("heartbeat: request carries tools",
                  len(hb_body.get("tools", [])) > 0)

    # ─── scenario 2: compaction ────────────────────────────────────────────
    # spin up a fresh mock + workspace and run pi with the trigger-compact
    # fixture, which calls ctx.compact({}) once after the first turn ends.
    # evolve.ts intercepts via session_before_compact, runs hello's compacting
    # hook (which returns {}, signaling "use the contract default"), pulls the
    # contract's compaction.md content, and computes the summary by calling
    # complete() — that LLM call hits the mock and we capture/assert on it.
    cmock = MockOpenAIServer()
    cmock.start()
    print(f"\ncompaction mock server on {cmock.base_url}")
    try:
        with tempfile.TemporaryDirectory(prefix="pi-evolve-compact-") as tmp:
            ws = make_workspace(Path(tmp))
            sess_dir = Path(tmp) / "sessions"
            sess_dir.mkdir()
            stdout, stderr = run_pi(
                ws, cmock.base_url,
                extra_extensions=[TRIGGER_COMPACT_FIXTURE],
                session_dir=sess_dir,
                extra_messages=["/trigger-compact"],
                extra_env={
                    "EVOLVE_HEARTBEAT_MS": "-1",
                },
            )
            (ARTIFACTS / "pi_integration.compaction.stdout.log").write_text(stdout)
            (ARTIFACTS / "pi_integration.compaction.stderr.log").write_text(stderr)
            cmock.shutdown()

            with cmock.lock:
                # build = first chat/completions request with tools and no
                # heartbeat. compaction = the chat/completions request whose
                # user message contains hello's compaction.md sentinel.
                requests = [c for c in cmock.captured if "chat/completions" in c["path"]]
                build_cap = next((c for c in requests
                                  if c["body"].get("tools")
                                  and not is_heartbeat_request(c["body"])), None)
                compaction_sentinel = HELLO_PROMPTS.joinpath("compaction.md").read_text().split("\n")[0].strip()
                compact_cap = None
                for c in requests:
                    if c is build_cap:
                        continue
                    if compaction_sentinel and compaction_sentinel in extract_user_text(c["body"]):
                        compact_cap = c
                        break

            (ARTIFACTS / "pi_integration.compaction.captured.json").write_text(
                json.dumps([c for c in cmock.captured], indent=2, default=str))

            check("compaction: build chat request captured", build_cap is not None,
                  f"captured: {len(requests)} reqs")
            check("compaction: compaction LLM call captured", compact_cap is not None,
                  f"captured: {len(requests)} reqs; sentinel='{compaction_sentinel}'\n"
                  f"stderr tail:\n{stderr[-1000:]}")

            if compact_cap:
                cu = extract_user_text(compact_cap["body"])
                hello_compaction = HELLO_PROMPTS.joinpath("compaction.md").read_text().strip()
                check("compaction: hook's compaction.md content reaches LLM as instructions",
                      hello_compaction in cu, cu[:500])
                check("compaction: prior conversation embedded in <conversation> block",
                      "<conversation>" in cu and "</conversation>" in cu, cu[:500])
                # the compaction LLM call should NOT carry the build turn's tools
                # (it's a summarization call, not an agentic turn)
                check("compaction: LLM call has no tools array (summarization, not agent turn)",
                      not compact_cap["body"].get("tools"), repr(compact_cap["body"].get("tools")))
    finally:
        cmock.shutdown()

    print(f"\n{PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
