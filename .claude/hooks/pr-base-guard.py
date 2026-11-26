#!/usr/bin/env python3
"""PR-Regeln aus der CLAUDE.md (Abschnitt „Arbeitsablauf“) mechanisch prüfen.

PreToolUse auf Bash, verdrahtet in .claude/settings.json. Geprüft werden nur
Aufrufe von `gh pr …`, alles andere geht ungesehen durch.

  gh pr create / edit   Basis nur `main` oder `master`, nie ein `claude/…`-Branch.
                        Enthält der Branch einen offenen PR #A, der noch nicht auf
                        `main` ist, muss der neue PR ein Draft sein und sein Titel
                        mit `[nach #A]` beginnen.
  gh pr ready           Steht `[nach #A]` noch im Titel, wird abgelehnt: erst #A
                        mergen lassen, `origin/main` einmergen, Präfix entfernen.
  gh pr merge           Gemergt wird nur von andi79h.

Anlass ist andi79h/ark-exporter#21: Gestapelte PRs gingen gegen den Branch ihres
Vorgängers. Gemergt landeten sie dort und nicht auf `master`, das fiel erst
Tage später auf. exp#16 fehlte so bis zum 26.11.2026 auf `master`.

Ein Fehler im Hook selbst blockiert nichts (fail open).
"""

import json
import os
import re
import shlex
import subprocess
import sys

DEFAULT_BRANCHES = {"main", "master"}
# Nur an Befehlsposition: Anfang, nach &&, ||, ;, |, Zeilenende, ( oder $( .
# `echo "gh pr merge"` oder Fließtext in Doku zählt nicht.
GH_PR_RE = re.compile(r"(?:^|&&|\|\||[;|\n(]|\$\()\s*(gh\s+pr\s+(create|edit|merge|ready))\b")
HEREDOC_RE = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n(.*?)^\s*\2\s*$", re.S | re.M)
# Ende eines einfachen Befehls: Verkettung, Pipe, Zeilenende.
SEGMENT_END_RE = re.compile(r"&&|\|\||[;|\n]")
CD_RE = re.compile(r"(?:^|&&|;|\n)\s*cd\s+(\"[^\"]+\"|'[^']+'|[^\s;&|]+)")
DEPENDS_PREFIX_RE = re.compile(r"^\s*\[nach\s+(?:\w+)?#(\d+)\]")


def emit_deny(reason: str) -> None:
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            },
            ensure_ascii=False,
        )
    )


def run(args, cwd, timeout=15):
    try:
        out = subprocess.run(
            args, cwd=cwd, capture_output=True, text=True, timeout=timeout
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def is_ancestor(cwd, a, b) -> bool:
    try:
        return (
            subprocess.run(
                ["git", "merge-base", "--is-ancestor", a, b],
                cwd=cwd,
                capture_output=True,
                timeout=10,
            ).returncode
            == 0
        )
    except (OSError, subprocess.SubprocessError):
        return False


def split_args(segment: str):
    try:
        return shlex.split(segment, posix=True)
    except ValueError:
        return segment.split()


def option(args, longs, shorts):
    """Wert einer Option: `--base x`, `--base=x`, `-B x`. None = nicht gesetzt."""
    for i, a in enumerate(args):
        for name in longs:
            if a == name and i + 1 < len(args):
                return args[i + 1]
            if a.startswith(name + "="):
                return a.split("=", 1)[1]
        for name in shorts:
            if a == name and i + 1 < len(args):
                return args[i + 1]
            if a.startswith(name) and len(a) > len(name) and not a.startswith("--"):
                return a[len(name):]
    return None


def flag(args, longs, shorts) -> bool:
    return any(a in longs or a in shorts for a in args)


VALUE_OPTIONS = {"--repo", "-R"}


def positional(args):
    """Erstes Argument nach `gh pr <sub>`, das weder Option noch deren Wert ist."""
    rest = args[3:] if len(args) > 3 else []
    skip = False
    for a in rest:
        if skip:
            skip = False
            continue
        if a in VALUE_OPTIONS:
            skip = True
            continue
        if not a.startswith("-"):
            return a
    return None


def strip_heredocs(command: str) -> str:
    """Heredoc-Inhalte durch Leerzeilen ersetzen, Positionen bleiben gleich lang."""
    def blank(m):
        body = m.group(3)
        return m.group(0).replace(body, re.sub(r"[^\n]", " ", body), 1)
    return HEREDOC_RE.sub(blank, command)


def work_dir(command: str, start: int, cwd: str) -> str:
    """Verzeichnis, in dem der gh-Aufruf läuft: das letzte `cd` davor, sonst cwd."""
    found = None
    for m in CD_RE.finditer(command[:start]):
        found = m.group(1).strip("\"'")
    if not found:
        return cwd
    found = os.path.expanduser(found)
    return found if os.path.isabs(found) else os.path.join(cwd, found)


def open_prs(cwd, repo):
    args = ["gh", "pr", "list", "--state", "open", "--limit", "100",
            "--json", "number,headRefName,baseRefName,title"]
    if repo:
        args += ["--repo", repo]
    out = run(args, cwd, timeout=20)
    if not out:
        return []
    try:
        return json.loads(out)
    except ValueError:
        return []


def default_branch(cwd) -> str:
    ref = run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd)
    if ref and ref.startswith("origin/"):
        return ref[len("origin/"):]
    for name in ("main", "master"):
        if run(["git", "rev-parse", "--verify", "--quiet", f"origin/{name}"], cwd):
            return name
    return "main"


def check_base(sub, args) -> bool:
    base = option(args, ["--base"], ["-B"])
    if base is None or base in DEFAULT_BRANCHES:
        return True
    emit_deny(
        f"`gh pr {sub}` mit Basis `{base}` abgelehnt.\n\n"
        "Jeder PR geht gegen `main` (ark-exporter: `master`), nie gegen einen "
        "`claude/…`-Branch. Ein PR gegen einen anderen Branch landet beim Merge "
        "dort und nicht auf `main` (andi79h/ark-exporter#21).\n\n"
        "Baut die Arbeit auf einem offenen PR #A auf: Branch vom Branch von #A, "
        "PR trotzdem gegen `main`, als Draft (`--draft`), Titel beginnt mit "
        "`[nach #A]`, erste Zeile im Text: „Hängt an #A. Erst nach #A mergen, bis "
        "dahin enthält der Diff #A mit.“"
    )
    return False


def check_dependency(args, cwd) -> bool:
    if not run(["git", "rev-parse", "--git-dir"], cwd):
        return True
    head = option(args, ["--head"], ["-H"])
    if head and ":" in head:
        head = head.split(":", 1)[1]
    if not head:
        head = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd)
    if not head or head == "HEAD":
        return True
    repo = option(args, ["--repo"], ["-R"])
    base = default_branch(cwd)
    deps = []
    for pr in open_prs(cwd, repo):
        other = pr.get("headRefName") or ""
        if not other or other == head:
            continue
        ref = f"origin/{other}"
        if not run(["git", "rev-parse", "--verify", "--quiet", ref], cwd):
            continue
        if is_ancestor(cwd, ref, f"origin/{base}"):
            continue
        if is_ancestor(cwd, ref, head):
            deps.append(pr)
    if not deps:
        return True

    number = deps[0]["number"]
    draft = flag(args, ["--draft"], ["-d"])
    title = option(args, ["--title"], ["-t"]) or ""
    m = DEPENDS_PREFIX_RE.match(title)
    if draft and m:
        return True
    listed = ", ".join(f"#{p['number']} ({p['headRefName']})" for p in deps)
    emit_deny(
        f"`gh pr create` abgelehnt: Der Branch `{head}` enthält den offenen PR {listed}, "
        f"der noch nicht auf `{base}` ist.\n\n"
        "So ein PR geht trotzdem gegen `main`, aber als Draft und mit Präfix, damit "
        "man sofort sieht, dass er auf einen anderen wartet:\n"
        f"  gh pr create --draft --base {base} --title \"[nach #{number}] <Titel>\" …\n"
        f"Erste Zeile im Text: „Hängt an #{number}. Erst nach #{number} mergen, bis dahin "
        f"enthält der Diff #{number} mit.“\n\n"
        "Gehört die Arbeit gar nicht zu diesem PR, den Branch neu von "
        f"`origin/{base}` abzweigen."
    )
    return False


def check_ready(args, cwd) -> bool:
    target = positional(args)
    view = ["gh", "pr", "view", "--json", "number,title"]
    if target:
        view.insert(3, target)
    repo = option(args, ["--repo"], ["-R"])
    if repo:
        view += ["--repo", repo]
    out = run(view, cwd, timeout=20)
    if not out:
        return True
    try:
        pr = json.loads(out)
    except ValueError:
        return True
    m = DEPENDS_PREFIX_RE.match(pr.get("title") or "")
    if not m:
        return True
    a = m.group(1)
    emit_deny(
        f"`gh pr ready` für #{pr.get('number')} abgelehnt: Der Titel beginnt noch mit "
        f"`[nach #{a}]`.\n\n"
        f"Erst wenn #{a} gemergt ist (`gh pr view {a} --json state`):\n"
        "  1. `origin/main` (bzw. `origin/master`) in den Branch mergen und pushen,\n"
        "  2. Präfix und Hinweiszeile entfernen (`gh pr edit <N> --title … --body-file …`),\n"
        "  3. dann `gh pr ready`.\n"
        f"Ist #{a} noch offen, bleibt der PR ein Draft."
    )
    return False


def main() -> int:
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    command = (data.get("tool_input") or {}).get("command") or ""
    if "gh" not in command or "pr" not in command:
        return 0
    cwd = data.get("cwd") or os.getcwd()

    scan = strip_heredocs(command)
    for m in GH_PR_RE.finditer(scan):
        sub = m.group(2)
        start = m.start(1)
        end = SEGMENT_END_RE.search(scan, m.end())
        segment = scan[start: end.start() if end else len(scan)]
        args = split_args(segment)
        if sub == "merge":
            emit_deny(
                "`gh pr merge` abgelehnt: Gemergt wird nur von andi79h, per "
                "Merge-Commit nach Freigabe (CLAUDE.md, Abschnitt „Arbeitsablauf“). "
                "PR auf In review setzen und Bescheid geben."
            )
            return 0
        if sub in ("create", "edit") and not check_base(sub, args):
            return 0
        here = work_dir(scan, start, cwd)
        if sub == "create" and not check_dependency(args, here):
            return 0
        if sub == "ready" and not check_ready(args, here):
            return 0
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
