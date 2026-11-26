# ark-exporter – Projektregeln

Exporter, Save-Editor, Cluster-Dateien und der RCON-Dienst `ark-rcon` für ARK: Survival Evolved und Ascended. Dieses Repo ist **öffentlich**.

## Öffentliches Repo

- **Keine Serverdaten:** keine Instanznamen, IPs, SteamIDs, Spielernamen oder Saves, auch nicht in Tests, Commits und PR-Texten. Test-SteamIDs sind erfunden (`765611980000000xx`).
- **Keine Geheimnisse.** Vor jedem Commit den Diff danach durchsuchen, und zwar mit `LC_ALL=C grep -a`. Ohne das überspringt macOS-grep Dateien in Latin-1.
- **Keine `.ark`-Saves** und andere Spieldateien. Die `.gitignore` schließt sie aus.

## Sprache

- Antworten, Doku, Commits und PRs auf Deutsch.
- Namen immer englisch: Dateien, Ordner, Befehle, Optionen, Funktionen, Variablen.

## Arbeitsablauf

Er ist derselbe wie im Hauptprojekt (andi79h/ark-server, privat).

1. **Zuerst das Ticket.** Tickets sind Issues in andi79h/ark-server auf Board #3 „ARK“, nicht hier, weil Issues hier öffentlich wären. Anlegen mit `/spike`, `/feature` oder `/fix`, erst nach einem klaren „ja“ des Users.
2. **Sitzungstitel:** Er beginnt mit `ark#<Ticket>`, der Issue-Nummer in ark-server, nicht der PR-Nummer. Das prüft `.claude/hooks/session-title-ticket-number.py`.
3. **Branch:** `claude/<N>-<slug>` von `origin/master`, in einem eigenen Worktree.
4. **PR gegen `master`**, nie gegen einen `claude/…`-Branch.
   - Im PR-Text steht `Closes andi79h/ark-server#N`, wenn nach dem Merge nichts einzuspielen ist, sonst `Refs andi79h/ark-server#N`.
   - Den PR von Hand aufs Board setzen, Status In review: `gh project item-add 3 --owner andi79h --url <pr-url>`.
5. **Hängt ein PR an einem offenen PR #A:** Der Branch zweigt vom Branch von #A ab. Der PR geht trotzdem gegen `master`, als Draft.
   - Der Titel beginnt mit `[nach #A]`. Die erste Zeile im Text lautet: „Hängt an #A. Erst nach #A mergen, bis dahin enthält der Diff #A mit.“
   - Ist #A gemergt: `origin/master` in den Branch mergen, Präfix entfernen, dann `gh pr ready`.
   - Gestapelte PRs gegen `claude/…`-Branches landeten früher beim Merge dort und nicht auf `master` (siehe #21, #22).
   - Das prüft `.claude/hooks/pr-base-guard.py`.
6. **Freigabe und Merge macht andi79h**, per Merge-Commit. Claude mergt nie selbst, `gh pr merge` sperrt der Hook.
7. **Eingespielt wird nur aus `origin/master`**, nie aus einem Branch oder einem lokalen Stand.

## Git

- Auf `master` nie direkt pushen und nie force-pushen. Das Ruleset `protect-master` erzwingt das.
- Commit-Identität: `git -c user.name=andi79h-claude -c user.email=304104817+andi79h-claude@users.noreply.github.com commit …`

## Prüfen

- `npm run check` (TypeScript, `tsc --noEmit`)
- `npm test` (`node --test`). Die MySQL-Tests werden ohne Testserver übersprungen.
- Ein frischer Worktree hat kein `node_modules/`. Bei gleichem `package-lock.json` per `cp -Rc` aus einem anderen Worktree klonen, sonst `npm ci`.
