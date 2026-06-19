#!/usr/bin/env python3
"""end-to-end conformance test for pi-evolve.

drives the shared hcp conformance suite (../hcp-spec/conformance) against the
real pi binary, then adds pi-specific scenarios. the protocol-level build and
heartbeat assertions live in the shared driver; this file owns the pi seam
(models.json custom-provider config, the `pi -e <ext>` invocation, the evolve
env vars) and the scenarios unique to pi:

  1. build + heartbeat (shared driver): hello tools, system-prompt fidelity, the
     heartbeat fired during a stalled build
  2. compaction: ctx.compact() runs hello's compacting hook and summarizes
  3. EVOLVE_PRESERVE_SKILLS: Pi's available_skills block is re-appended (or not)

the test requires no real api key and depends on no user-installed pi extension.
the agent dir is isolated per scenario so the user's real ~/.pi/agent is never
touched.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
EXTENSION_PATH = PROJECT_ROOT / "src" / "extension" / "index.ts"
TRIGGER_COMPACT_FIXTURE = PROJECT_ROOT / "tests" / "_trigger_compact.ts"
SKILL_FIXTURE_DIR = PROJECT_ROOT / "tests" / "_skill_fixture"
SKILL_FIXTURE_NAME = "evolve-test-skill"
ARTIFACTS = PROJECT_ROOT / "tests" / ".artifacts"
PI_BIN = os.environ.get("PI_BIN", "pi")

# short heartbeat + a stall on the first build give the heartbeat timer room to
# fire inside the still-alive pi process before the build response arrives.
HEARTBEAT_MS = 500
STALL_SECONDS = 5

sys.path.insert(0, str(PROJECT_ROOT.parent / "hcp-spec" / "conformance"))
import hcpconform as hc

# the mock provider is configured through pi's stock models.json custom-provider
# path (relocated per-scenario via PI_CODING_AGENT_DIR) instead of a
# registerProvider extension. matches the --provider/--model flags below.
MOCK_PROVIDER = "mock"
MOCK_MODEL_ID = "fake-model"
MOCK_MODEL = f"{MOCK_PROVIDER}/{MOCK_MODEL_ID}"
MOCK_API_KEY = "test"


def write_models_json(agent_dir, base_url):
    """seed an isolated PI_CODING_AGENT_DIR with a models.json defining the mock
    openai-completions provider at base_url. apiKey is sent as a bearer token;
    fake-openai ignores it."""
    agent_dir.mkdir(parents=True, exist_ok=True)
    (agent_dir / "models.json").write_text(json.dumps({
        "providers": {MOCK_PROVIDER: {
            "baseUrl": base_url, "api": "openai-completions", "apiKey": MOCK_API_KEY,
            "models": [{"id": MOCK_MODEL_ID, "name": "Fake Model",
                        "contextWindow": 200000, "maxTokens": 4096}],
        }}
    }, indent=2))
    return agent_dir


def run_pi(workspace, base_url, *, extra_extensions=None, extra_env=None,
           session_dir=None, extra_messages=None, extra_skills=None, timeout=45):
    """launch pi with the evolve extension against the mock. returns (stdout,
    stderr). isolates PI_CODING_AGENT_DIR so the user's ~/.pi/agent is untouched."""
    agent_dir = write_models_json(workspace.parent / "agent", base_url)
    env = {
        **os.environ,
        "EVOLVE_WORKSPACE": str(workspace), "EVOLVE_DEBUG": "1",
        "EVOLVE_HEARTBEAT_MS": str(HEARTBEAT_MS), "PI_CODING_AGENT_DIR": str(agent_dir),
        "PI_OFFLINE": "1", "CI": "1", **(extra_env or {}),
    }
    cmd = [PI_BIN, "-e", str(EXTENSION_PATH)]
    for ext in extra_extensions or []:
        cmd += ["-e", str(ext)]
    cmd += ["--session-dir", str(session_dir)] if session_dir else ["--no-session"]
    cmd += ["--no-extensions", "--no-context-files"]
    for skill in extra_skills or []:
        cmd += ["--skill", str(skill)]
    cmd += ["--provider", MOCK_PROVIDER, "--model", MOCK_MODEL, "-p", "hello"]
    cmd += list(extra_messages or [])
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, env=env, cwd=str(workspace))
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, stderr = proc.communicate()
        stderr = (stderr or "") + f"\n[test runner: pi timed out after {timeout}s]\n"
    return stdout or "", stderr or ""


class PiAdapter(hc.HostAdapter):
    name = "pi-evolve"
    wants_heartbeat = True
    builtin_tools = {"hello_datetime", "hello_heartbeat_time", "hello_prompt_read",
                     "hello_prompt_write", "hello_hook_read", "hello_hook_write",
                     "hello_hook_validate"}

    def __init__(self):
        self.stderr = ""

    def available(self):
        if not EXTENSION_PATH.exists():
            return False, f"FAIL: extension not found at {EXTENSION_PATH}"
        if not _which(PI_BIN):
            return False, f"SKIP: {PI_BIN} not on PATH; set PI_BIN to override"
        return True, ""

    def run_build(self, fixture):
        fake = hc.start_fake_openai("--stall-first-with-tools",
                                    "--stall-seconds", str(STALL_SECONDS))
        print(f"mock server on {fake.base_url}")
        with tempfile.TemporaryDirectory(prefix="pi-evolve-test-") as tmp:
            ws = hc.seed_workspace(Path(tmp) / "workspace", fixture)
            stdout, self.stderr = run_pi(ws, fake.base_url)
            caps = fake.captures()
            fake.stop()
        return hc.RunResult(hc.find_build_request(caps), hc.find_heartbeat_request(caps),
                            caps, stdout, self.stderr)

    def extra_build_checks(self, body, fixture, runner):
        hc.assert_builtin_tools(body, self.builtin_tools, runner)
        hc.assert_param_descriptions(body, runner)
        hc.assert_system_preamble_chat(body, fixture, runner)
        # pi-evolve replaces (not appends to) pi's system prompt.
        runner.check("build: system prompt does NOT include pi's default preamble "
                     "(hook should replace, not append)",
                     "expert coding assistant operating inside pi" not in hc.system_text(body))
        # prompt_read.name is enum-locked to the prompt-contract files.
        read = hc.prop(body, "hello_prompt_read", "name")
        runner.check("build: hello_prompt_read.name enum-locked to contract files",
                     hc.enum_values(read) == set(hc.CONTRACT_PROMPTS), repr(read))


def _which(binary):
    import shutil
    return shutil.which(binary)


def check_stderr(adapter, runner):
    """pi-specific load/discover log lines (the shared driver does not see them)."""
    runner.check("extension load: pi-evolve loaded line in stderr",
                 "pi-evolve loaded" in adapter.stderr, adapter.stderr[-500:])
    runner.check("discover: hello hook registered as 'hello'",
                 'discovered hello.py as "hello"' in adapter.stderr, adapter.stderr[-500:])


def scenario_compaction(runner, fixture):
    """ctx.compact() runs hello's compacting hook (which abstains -> contract
    default) and summarizes via an llm call that hits the mock."""
    fake = hc.start_fake_openai()
    print(f"\ncompaction mock server on {fake.base_url}")
    try:
        with tempfile.TemporaryDirectory(prefix="pi-evolve-compact-") as tmp:
            ws = hc.seed_workspace(Path(tmp) / "workspace", fixture)
            sess_dir = Path(tmp) / "sessions"
            sess_dir.mkdir()
            _, stderr = run_pi(ws, fake.base_url, extra_extensions=[TRIGGER_COMPACT_FIXTURE],
                               session_dir=sess_dir, extra_messages=["/trigger-compact"],
                               extra_env={"EVOLVE_HEARTBEAT_MS": "-1"})
            requests = fake.chat_captures()
        build_cap = hc.find_build_request(requests)
        sentinel = fixture.compaction.split("\n")[0].strip()
        compact_cap = next((c for c in requests if c is not build_cap and sentinel
                            and sentinel in hc.user_text(c["body"])), None)
        runner.check("compaction: build chat request captured", build_cap is not None,
                     f"captured: {len(requests)} reqs")
        runner.check("compaction: compaction LLM call captured", compact_cap is not None,
                     f"captured: {len(requests)} reqs; sentinel='{sentinel}'\n"
                     f"stderr tail:\n{stderr[-1000:]}")
        if compact_cap:
            cu = hc.user_text(compact_cap["body"])
            runner.check("compaction: hook's compaction.md content reaches LLM as instructions",
                         fixture.compaction in cu, cu[:500])
            runner.check("compaction: prior conversation embedded in <conversation> block",
                         "<conversation>" in cu and "</conversation>" in cu, cu[:500])
            runner.check("compaction: LLM call has no tools array (summarization, not agent turn)",
                         not compact_cap["body"].get("tools"), repr(compact_cap["body"].get("tools")))
    finally:
        fake.stop()


def scenario_skills(runner, fixture):
    """pi-evolve re-appends Pi's available_skills block by default so downstream
    extensions (pi-skillful) still find it; EVOLVE_PRESERVE_SKILLS=0 opts out."""
    marker = "The following skills provide specialized instructions"
    for label, env_extra, expect in (("preserve-skills default", {}, True),
                                      ("preserve-skills off", {"EVOLVE_PRESERVE_SKILLS": "0"}, False)):
        fake = hc.start_fake_openai()
        print(f"\n{label} mock server on {fake.base_url}")
        try:
            with tempfile.TemporaryDirectory(prefix="pi-evolve-skills-") as tmp:
                ws = hc.seed_workspace(Path(tmp) / "workspace", fixture)
                run_pi(ws, fake.base_url, extra_skills=[SKILL_FIXTURE_DIR],
                       extra_env={"EVOLVE_HEARTBEAT_MS": "-1", **env_extra})
                chat = hc.find_build_request(fake.chat_captures())
        finally:
            fake.stop()
        runner.check(f"skills [{label}]: build chat request captured", chat is not None)
        if not chat:
            continue
        s = hc.system_text(chat["body"])
        if expect:
            runner.check(f"skills [{label}]: available_skills marker present", marker in s, s[-1500:])
            runner.check(f"skills [{label}]: available_skills envelope closed",
                         "</available_skills>" in s, s[-1500:])
            runner.check(f"skills [{label}]: fixture skill name appears in prompt",
                         SKILL_FIXTURE_NAME in s, s[-1500:])
        else:
            runner.check(f"skills [{label}]: available_skills marker absent", marker not in s, s[-1500:])
            runner.check(f"skills [{label}]: fixture skill name absent",
                         SKILL_FIXTURE_NAME not in s, s[-1500:])


def main():
    adapter = PiAdapter()
    if not hc.preflight(adapter):
        return 0
    fixture = hc.Fixture()
    runner = hc.CheckRunner()
    result = hc.run_conformance(adapter, runner, fixture)
    hc.dump_artifacts(ARTIFACTS, "pi_integration", result)
    check_stderr(adapter, runner)
    scenario_compaction(runner, fixture)
    scenario_skills(runner, fixture)
    runner.summary()
    return runner.exit_code()


if __name__ == "__main__":
    sys.exit(main())
