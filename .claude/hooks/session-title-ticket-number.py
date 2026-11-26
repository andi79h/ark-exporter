#!/usr/bin/env python3
"""Setzt die Titelregel durch: bearbeitet eine Session ein Ticket, steht
`ark#<Ticket>` als allererstes im Namen (`ark#165 Arbeitsablauf festschreiben`).
Die Nummer ist die Issue-Nummer in andi79h/ark-server, auch wenn der Code nach
ark-exporter geht. Übernommen aus duels (`#748 …`), dort ohne Präfix.

Zwei Modi, beide in .claude/settings.json verdrahtet:

  --spawn-task   PreToolUse auf mcp__ccd_session__start_session (und den älteren
                 spawn_task, hand_off_to_session). Ein Titel mit einer
                 Ticketnummer, die nicht als `ark#N` vorn steht, wird abgelehnt.
                 Der Titel wird eins zu eins der Name der neuen Session.

  --prompt       UserPromptSubmit. Nennt der Prompt eine Ticketnummer und traegt
                 die Session sie nicht vorn im Titel, erinnert der Hook einmal
                 pro Session an set_session_title -- mit dem fertigen Aufruf,
                 damit die ToolSearch-Runde niemanden aufhaelt.

Warum ueberhaupt ein Hook: Die Regel stand nur in der Memory. Die
Werkzeugbeschreibung von spawn_task verlangt dagegen woertlich eine
"Imperative action phrase (start with a verb)" und liegt beim Schreiben des
Titels direkt vor Augen -- sie gewinnt, und die Nummer rutscht nach hinten.
Gegen einen mechanischen Konflikt hilft nur eine mechanische Pruefung.
"""

import json
import os
import re
import sys

# `ark#165` oder `#165`, aber nicht `exp#21` (ein PR in ark-exporter), nicht die
# Raute in `#!/bin/sh`, in Farbwerten oder mitten im Wort.
TICKET_RE = re.compile(r"(?:(?<=\bark)|(?<![\w#]))#(\d{1,6})(?!\w)")
TICKET_SUB_RE = re.compile(r"(?:\bark)?(?<![\w#])#\d{1,6}(?!\w)|\bark#\d{1,6}(?!\w)")
# `https://github.com/andi79h/ark-server/issues/165` -- im Prompt einer neuen Session der Regelfall.
ISSUE_URL_RE = re.compile(r"ark-server/issues/(\d{1,6})\b")


def read_input() -> dict:
    try:
        return json.loads(sys.stdin.read() or "{}")
    except (json.JSONDecodeError, ValueError):
        return {}


def leading_ticket(text: str):
    """Ticketnummer, wenn sie am Anfang steht -- sonst None."""
    m = re.match(r"\s*ark#(\d{1,6})(?!\w)", text or "")
    return m.group(1) if m else None


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


# ---------------------------------------------------------------- spawn_task


def check_spawn_task(data: dict) -> int:
    title = (data.get("tool_input") or {}).get("title") or ""
    if not title.strip():
        return 0

    numbers = TICKET_RE.findall(title)
    if not numbers:
        # Chip ohne Ticketbezug (Aufraeumen, Recherche) -- die Regel greift nicht.
        return 0

    if leading_ticket(title):
        return 0

    first = numbers[0]
    # Nur die erste Nummer herausloesen -- eine zweite im Titel ist Inhalt
    # (`Rette #648 nach master: PR #657 verlor den Stack`) und bleibt stehen.
    rest = TICKET_SUB_RE.sub("", title, count=1)
    # Klammerreste aus `… beheben (#748)`, haengende Satzzeichen aus `Baue #748: …`.
    rest = re.sub(r"\(\s*\)|\[\s*\]", "", rest)
    rest = re.sub(r"\s+([:,;.!?])", r"\1", rest)
    rest = re.sub(r"\s{2,}", " ", rest).strip(" \t-–—:,;")
    suggestion = f"ark#{first} {rest}".strip()

    emit(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"Titel abgelehnt: „{title}“.\n\n"
                    "Der Titel wird eins zu eins der Name der neuen Session, und bei einem "
                    "Ticket steht `ark#<Ticket>` als allererstes (CLAUDE.md, Abschnitt "
                    "„Arbeitsablauf“). Eine Nummer in Klammern am Ende, hinter dem Verb "
                    "oder ohne `ark` ist derselbe Fehler.\n\n"
                    f"Ruf das Werkzeug erneut auf mit: title=\"{suggestion}\"\n\n"
                    "Die Werkzeugbeschreibung verlangt eine Verbphrase — die Ticketnummer "
                    "schlägt sie. Gehört zur Session wirklich kein Ticket, lass die Nummer "
                    "ganz weg statt sie nach hinten zu schieben. Ist die Zahl eine "
                    "PR-Nummer, schreib sie als `exp#N` bzw. `PR #N` hinter den Text."
                ),
            }
        }
    )
    return 0


# --------------------------------------------------------- UserPromptSubmit


def session_title(data: dict):
    """Aktueller Titel aus dem Transcript. None = nicht ermittelbar.

    Rueckwaerts in Bloecken gelesen: der geltende Titel steht im *letzten*
    `custom-title`-Ereignis, und diese Dateien werden hier zweistellig
    megabytegross (der Spitzenreiter 51 MB). Ein Vollscan bei jedem Prompt
    waere spuerbar, das Ende reicht.
    """
    path = data.get("transcript_path")
    if not path or not os.path.isfile(path):
        return None
    block = 256 * 1024
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            read = 0
            tail = b""
            while read < size:
                read = min(read + block, size)
                fh.seek(size - read)
                tail = fh.read(read)
                # Erste (unvollstaendige) Zeile verwerfen, solange noch mehr da ist.
                lines = tail.split(b"\n")
                if read < size:
                    lines = lines[1:]
                for raw in reversed(lines):
                    if b'"custom-title"' not in raw:
                        continue
                    try:
                        event = json.loads(raw.decode("utf-8", "ignore"))
                    except (json.JSONDecodeError, ValueError):
                        continue
                    if event.get("type") == "custom-title":
                        return event.get("customTitle") or None
    except OSError:
        return None
    return None


def already_reminded(session_id: str) -> bool:
    """Einmal pro Session genügt — sonst steht die Erinnerung in jedem Turn."""
    if not session_id:
        return False
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id)[:80]
    marker = os.path.join(
        os.path.expanduser("~/.claude"), "session-title-reminders", safe
    )
    if os.path.exists(marker):
        return True
    try:
        os.makedirs(os.path.dirname(marker), exist_ok=True)
        with open(marker, "w", encoding="utf-8") as fh:
            fh.write("")
    except OSError:
        pass
    return False


def check_prompt(data: dict) -> int:
    prompt = data.get("prompt") or ""
    numbers = TICKET_RE.findall(prompt) or ISSUE_URL_RE.findall(prompt)
    if not numbers:
        return 0

    title = session_title(data)
    if title is not None and leading_ticket(title):
        return 0

    if already_reminded(data.get("session_id") or ""):
        return 0

    first = numbers[0]
    current = f" Aktuell heißt sie „{title}“." if title else ""
    emit(
        {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": (
                    f"Titelregel: Der Prompt nennt #{first}, der Titel dieser Session "
                    f"beginnt aber nicht mit `ark#<Ticket>`.{current}\n\n"
                    "Bearbeitet diese Session das Ticket, benenn sie **jetzt** um — "
                    "nicht erst am Ende der Arbeit:\n"
                    "  mcp__ccd_session_mgmt__set_session_title "
                    f'{{session_id: "self", title: "ark#{first} <Kurzbeschreibung>"}}\n\n'
                    "Das Werkzeug ist deferred, lad es vorher mit ToolSearch "
                    '("select:mcp__ccd_session_mgmt__set_session_title").\n\n'
                    "`ark#<Ticket>` steht ganz vorn im Titel — nicht in Klammern am "
                    "Ende, nicht hinter einem Verb. Nimm die Issue-Nummer vom Board #3, "
                    "nicht die PR-Nummer; bei Epic + Sub-Issue die, an der wirklich "
                    "gearbeitet wird. Ist `#N` hier ein PR oder wird das Ticket nur "
                    "erwähnt und nicht bearbeitet, bleibt der Titel wie er ist — dann "
                    "ignorier diesen Hinweis wortlos."
                ),
            }
        }
    )
    return 0


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    data = read_input()
    if mode == "--spawn-task":
        return check_spawn_task(data)
    if mode == "--prompt":
        return check_prompt(data)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Ein kaputter Hook darf niemandem die Arbeit blockieren.
        sys.exit(0)
