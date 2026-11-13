#!/usr/bin/env python3
"""Run trigger evaluation for a skill description.

Tests whether a skill's description causes Pi to read the skill for a set of
queries. Outputs results as JSON.
"""

import argparse
import json
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from scripts.utils import parse_skill_md


def find_project_root() -> Path:
    """Find the project root by walking up from cwd looking for .pi/ or .git/."""
    current = Path.cwd()
    for parent in [current, *current.parents]:
        if (parent / ".pi").is_dir() or (parent / ".git").exists():
            return parent
    return current


def _pi_read_triggered(event: dict, marker: str) -> bool:
    """True when Pi starts reading the probe skill.

    Pi has no Skill tool. Triggering means the model reads that skill's
    SKILL.md. Other tools do not count, and do not fail the query early.
    """
    if event.get("type") == "tool_execution_start" and event.get("toolName") == "read":
        return marker in json.dumps(event.get("args", {}))
    update = event.get("assistantMessageEvent") or {}
    if event.get("type") == "message_update" and update.get("type") == "toolcall_end":
        call = update.get("toolCall") or {}
        if call.get("name") == "read":
            return marker in json.dumps(call)
    return False


def run_single_query(
    query: str,
    skill_name: str,
    skill_description: str,
    timeout: int,
    project_root: str,
    model: str | None = None,
) -> bool:
    """Run a single query and return whether Pi read the probe skill.

    Writes a temporary skill and runs `pi -p --skill <dir> --mode json`.
    `--no-skills` hides every other skill; an explicit --skill still loads.
    Returns as soon as Pi reads that SKILL.md, without waiting for the task.
    """
    del project_root  # Pi loads the probe with --skill, not a project command dir.
    unique_id = uuid.uuid4().hex[:8]
    clean_name = f"{skill_name}-skill-{unique_id}"
    skill_dir = Path(tempfile.mkdtemp(prefix=f"{clean_name}-"))
    skill_file = skill_dir / "SKILL.md"

    try:
        indented_desc = "\n  ".join(skill_description.split("\n"))
        skill_file.write_text(
            f"---\n"
            f"name: {clean_name}\n"
            f"description: |\n"
            f"  {indented_desc}\n"
            f"---\n\n"
            f"# {skill_name}\n\n"
            f"This skill handles: {skill_description}\n"
        )

        cmd = [
            "pi",
            "--no-extensions",
            "--offline",
            "--skill", str(skill_dir),
            "--no-skills",
            "--no-session",
            "--mode", "json",
            "-p",
        ]
        if model:
            cmd.extend(["--model", model])

        process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=skill_dir,
        )
        assert process.stdin is not None
        assert process.stdout is not None
        process.stdin.write(query.encode("utf-8"))
        process.stdin.close()

        line_queue: queue.Queue[bytes | None] = queue.Queue()

        def _pump_stdout(pipe) -> None:
            try:
                for raw_line in iter(pipe.readline, b""):
                    line_queue.put(raw_line)
            finally:
                line_queue.put(None)

        reader = threading.Thread(target=_pump_stdout, args=(process.stdout,), daemon=True)
        reader.start()

        deadline = time.monotonic() + timeout
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    raw_line = line_queue.get(timeout=min(1.0, remaining))
                except queue.Empty:
                    if process.poll() is not None and not reader.is_alive() and line_queue.empty():
                        break
                    continue
                if raw_line is None:
                    break
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if _pi_read_triggered(event, clean_name):
                    return True
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            reader.join(timeout=1.0)

        return False
    finally:
        shutil.rmtree(skill_dir, ignore_errors=True)


def run_eval(
    eval_set: list[dict],
    skill_name: str,
    description: str,
    num_workers: int,
    timeout: int,
    project_root: Path,
    runs_per_query: int = 1,
    trigger_threshold: float = 0.5,
    model: str | None = None,
) -> dict:
    """Run the full eval set and return results."""
    results = []

    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        future_to_info = {}
        for item in eval_set:
            for run_idx in range(runs_per_query):
                future = executor.submit(
                    run_single_query,
                    item["query"],
                    skill_name,
                    description,
                    timeout,
                    str(project_root),
                    model,
                )
                future_to_info[future] = (item, run_idx)

        query_triggers: dict[str, list[bool]] = {}
        query_items: dict[str, dict] = {}
        for future in as_completed(future_to_info):
            item, _ = future_to_info[future]
            query = item["query"]
            query_items[query] = item
            if query not in query_triggers:
                query_triggers[query] = []
            try:
                query_triggers[query].append(future.result())
            except Exception as e:
                print(f"Warning: query failed: {e}", file=sys.stderr)
                query_triggers[query].append(False)

    for query, triggers in query_triggers.items():
        item = query_items[query]
        trigger_rate = sum(triggers) / len(triggers)
        should_trigger = item["should_trigger"]
        if should_trigger:
            did_pass = trigger_rate >= trigger_threshold
        else:
            did_pass = trigger_rate < trigger_threshold
        results.append({
            "query": query,
            "should_trigger": should_trigger,
            "trigger_rate": trigger_rate,
            "triggers": sum(triggers),
            "runs": len(triggers),
            "pass": did_pass,
        })

    passed = sum(1 for r in results if r["pass"])
    total = len(results)

    return {
        "skill_name": skill_name,
        "description": description,
        "results": results,
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Run trigger evaluation for a skill description")
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON file")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--description", default=None, help="Override description to test")
    parser.add_argument("--num-workers", type=int, default=10, help="Number of parallel workers")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout per query in seconds")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Number of runs per query")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold")
    parser.add_argument("--model", default=None, help="Model to use for pi -p (default: Pi's configured model)")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path)

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, original_description, content = parse_skill_md(skill_path)
    description = args.description or original_description
    project_root = find_project_root()

    if args.verbose:
        print(f"Evaluating: {description}", file=sys.stderr)

    output = run_eval(
        eval_set=eval_set,
        skill_name=name,
        description=description,
        num_workers=args.num_workers,
        timeout=args.timeout,
        project_root=project_root,
        runs_per_query=args.runs_per_query,
        trigger_threshold=args.trigger_threshold,
        model=args.model,
    )

    if args.verbose:
        summary = output["summary"]
        print(f"Results: {summary['passed']}/{summary['total']} passed", file=sys.stderr)
        for r in output["results"]:
            status = "PASS" if r["pass"] else "FAIL"
            rate_str = f"{r['triggers']}/{r['runs']}"
            print(f"  [{status}] rate={rate_str} expected={r['should_trigger']}: {r['query'][:70]}", file=sys.stderr)

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
