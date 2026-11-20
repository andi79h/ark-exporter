# ark-manager: RCON-Verwaltung für ARK-Server

`ark-manager` hält zu jeder Karte eines ARK-Clusters eine RCON-Verbindung. Er sammelt Spieler, Chat und Spiellog in einer Datenbank. Bedient wird er über eine Weboberfläche mit Rollen und eine JSON-API. Er ist als selbst gehosteter Ersatz für bezahlte RCON-Dienste wie BattleMetrics gebaut, und zwar für **ARK: Survival Evolved unter Linux mit arkmanager**. Gemessen und getestet ist er an Build 358.24.

## Inhalt

- [Was er kann](#was-er-kann)
- [Wie er Chat und Log liest](#wie-er-chat-und-log-liest)
- [Sicherheitsregeln für RCON](#sicherheitsregeln-für-rcon)
- [Installation](#installation)
- [Konfiguration](#konfiguration)
- [Rollen](#rollen)
- [Trigger und Zeitpläne](#trigger-und-zeitpläne)
- [API](#api)
- [Datenbank](#datenbank)
- [Entwicklung und Tests](#entwicklung-und-tests)

## Was er kann

| Bereich | Funktion |
|---|---|
| **Dashboard** | eine Kachel je Karte mit Status, Spielern online, Live-Feed (Chat, Joins, Spiellog) und eigener Konsole. „An alle“ schickt einen Befehl oder eine Chatnachricht an alle Karten. |
| **Spieler** | Profil je SteamID: alle Namen, Charaktername, ARK-Spieler-ID (aus Admin-Logzeilen), erster und letzter Besuch, Sitzungen mit Dauer, Spielzeit, Chatverlauf, Banns, Notizen mit Markierung. Suche über Name, Charakter, SteamID oder ARK-ID. |
| **Aktivität** | Chat, Server-Chat, Join/Leave, Admin-Befehle im Spiel (mit SteamID), Stammes-Logs, Zähmungen, Mod-Meldungen, Kartenstatus. Filter nach Karte, Art und Text, live. |
| **Banns** | clusterweit, mit Grund und optionalem Ablauf. `BanPlayer` geht an jede erreichbare Karte. Gebannte Spieler werden beim Betreten gekickt, Zeitbanns laufen von selbst ab. Banns, die ein Admin im Spiel setzt, übernimmt der Manager. Import einer `BanList.txt`. |
| **Konsole** | Befehle an eine, mehrere oder alle Karten, jeweils durch die [Sicherheitsprüfung](#sicherheitsregeln-für-rcon). |
| **Gespeicherte Befehle** | Vorlagen mit Parametern (Text, SteamID, Zahl), mit eigenem Recht. Ziel ist eine feste Karte, alle Karten oder die Karte, auf der der Spieler gerade ist. Damit dürfen Moderatoren geprüfte Befehle ausführen, ohne die Konsole zu haben. |
| **Zeitpläne** | Cron mit fünf Feldern und Zeitzone, Vorwarnungen per ServerChat (z. B. 10 und 1 Minute vor einem Neustart). |
| **Trigger** | Ereignis → Bedingung → Aktionen. Ereignisse: Join, erster Besuch im Cluster oder auf der Karte, Leave, Chat (Regex), Spiellog-Zeile (Art und Regex), Karte online/offline, gekickter gebannter Spieler. Aktionen: Befehl, ServerChat, Privatnachricht, Kick, Bann, Notiz, Discord, Pause, gespeicherter Befehl. Je Trigger eine Sperrzeit. |
| **Discord** | Webhooks mit Routen je Ereignisart (Chat, Join/Leave, Banns, Audit, Admin-Befehle im Spiel, Zähmungen, Kartenstatus). Erwähnungen sind abgeschaltet, Nachrichten werden gebündelt, Rate-Limits beachtet. |
| **Audit-Log** | jede Aktion mit Urheber (Benutzer, API-Token, Kommandozeile, Zeitplan, Trigger, Admin im Spiel), Ziel, Befehl, Antwort je Karte und Ergebnis. |
| **Benutzer** | Rollen viewer, moderator, admin, superadmin. Anmeldung mit Passwort (scrypt) oder API-Token für Skripte und Portale. |

## Wie er Chat und Log liest

ASE schreibt mit `-servergamelog` jede Zeile des Spiellogs auch in `ShooterGame/Saved/Logs/ServerGame.<pid>.<Datum>.log`. Darin stehen dieselben Zeilen, die `GetGameLog` über RCON liefert, also auch Chat und Joins. Der Manager liest **diese Datei**. Das hat vier Gründe:

- `GetChat` und `GetGameLog` leeren einen Puffer, den sich alle RCON-Clients teilen. Liest ein zweites Werkzeug mit, fehlen dem ersten die Zeilen. Die Datei lässt sich lesen, ohne jemandem etwas wegzunehmen. Deshalb kann der Manager parallel zu BattleMetrics laufen.
- RCON liefert Namen und Chat nur als ASCII, jedes andere Zeichen wird zu `?`. Die Datei ist UTF-8, Umlaute bleiben also erhalten. Spielernamen aus `ListPlayers` (`J?rg`) repariert der Manager mit dem Namen aus der Logzeile (`Jörg`).
- Die Leseposition wird gespeichert. Nach einem Neustart des Managers geht keine Zeile verloren.
- Admin-Befehle im Spiel stehen mit Spielername, ARK-ID und SteamID in der Datei.

Wer `ListPlayers` abfragt, stört andere Clients nicht. Der Manager fragt alle 10 s (`pollSeconds`). Daraus entstehen Sitzungen und Spielerprofile, denn nur `ListPlayers` liefert die SteamID.

Liegen die Logdateien auf einem anderen Rechner, kann ein Befehl sie liefern (`logCommand`). Ein Beispiel dafür ist `scripts/follow-gamelog.sh` über ssh. Ohne Datei geht es mit `logSource: "rcon"` auch über `GetGameLog`, aber nur, wenn sonst niemand den Puffer liest.

## Sicherheitsregeln für RCON

Bei ASE laufen RCON-Befehle über einen eigenen Cheat-Manager ohne Spieler. Dabei verweist `MyPC` auf den GameMode statt auf einen PlayerController. Viele Admin-Befehle tun deshalb über RCON nichts, manche bringen den Server zum Absturz. Der Manager prüft jeden Befehl, bevor er ihn sendet. Die Regeln stehen in `src/manager/policy.ts`, die Tabelle in `src/manager/ase-358-commands.ts`. Die Tabelle stammt aus einer statischen Analyse der Server-Binary 358.24 mit 317 Befehlen, ergänzt um Tests auf einem Testserver.

| Regel | Grund |
|---|---|
| Abgelehnt: Befehle, die im Test abgestürzt sind (`SetDay`, `GetTribeIdPlayerList`, `LevelUp`, `PlayerCommand` …) | Server-Absturz |
| Abgelehnt: Befehle, die auf dem RCON-Pfad `MyPC` benutzen (74 + 2) | Absturzkandidaten |
| Abgelehnt: Befehle, die bei RCON sofort abbrechen (172, z. B. `KillPlayer`, `DestroyTribeId`, `GiveExpToPlayer`) | wirkungslos, die Antwort sieht aber aus wie bei Erfolg |
| Abgelehnt: unbekannte Befehle; `ScriptCommand` nur mit erlaubtem Unterbefehl (`scriptCommands`) | nicht geprüft |
| Präfix `cheat`/`admincheat` wird entfernt | mit Präfix ignoriert der Server den Befehl |
| Abgelehnt: `\|`-Ketten, Zeilenumbrüche, Nicht-ASCII, mehr als 480 Byte | nur der erste Befehl einer Kette läuft; Nicht-ASCII wird zu `?`; ab ~490 Byte trennt der Server die Verbindung |
| `GetChat`/`GetGameLog` abgelehnt, wenn `externalBufferReader: true` | leeren den gemeinsamen Puffer |
| Getestete Befehle (`ListPlayers`, `ServerChat`, `KickPlayer`, `BanPlayer` …): Recht `console` | |
| Befehle mit großer Wirkung (`DoExit`, `DestroyWildDinos`, `SetGlobalPause` …): Recht `console.risky` | |
| Laut Analyse lauffähige, aber ungetestete Befehle: nur `superadmin`, auf Live-Karten zusätzlich mit `force`; in Triggern und Zeitplänen nie | |

Textparameter, die nicht am Ende stehen, müssen in Anführungszeichen: `ServerChatTo "<SteamID>" Text`. Spielerbefehle wie `GiveItemToPlayer` verlangen die ARK-Spieler-ID, nicht die SteamID. Der Manager kennt sie aus den Admin-Logzeilen.

Andere Builds (ASA, neuere ASE-Versionen) haben keine geprüfte Tabelle. Für sie gilt die Tabelle von 358.24 nur als Annahme.

## Installation

Voraussetzung ist Node ≥ 22.18 oder Bun; der Code ist TypeScript ohne Build-Schritt. Auf Systemen mit alter glibc, etwa Ubuntu 18.04, läuft der Node-Build `linux-x64-glibc-217` von unofficial-builds.nodejs.org.

```bash
git clone https://github.com/andi79h/ark-exporter.git /opt/ark-manager
cd /opt/ark-manager && npm ci --omit=dev        # nur mysql2, und nur nötig für MySQL
mkdir -p /etc/ark-manager && cp docs/ark-manager.example.json /etc/ark-manager/config.json
bin/ark-manager maps --config /etc/ark-manager/config.json          # zeigt, welche Karten erkannt werden
bin/ark-manager user add admin --role superadmin --config /etc/ark-manager/config.json
bin/ark-manager run --config /etc/ark-manager/config.json
```

Der Manager muss unter dem Benutzer laufen, der die Server betreibt (z. B. `steam`). Nur dieser darf die arkmanager-Dateien und die Logdateien (Modus 0600) lesen. Eine systemd-Unit:

```ini
[Service]
User=steam
ExecStart=/usr/bin/node /opt/ark-manager/src/manager/cli.ts run --config /etc/ark-manager/config.json
Restart=always
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
```

Die Weboberfläche lauscht standardmäßig nur auf `127.0.0.1:8790`. Für den Zugriff von außen gibt es zwei Wege:

- einen Reverse-Proxy mit TLS; dann `secureCookies: true`, und `trustProxy: true`, damit die Sperre nach Fehlversuchen die echte Adresse sieht. Für den Live-Feed (Server-Sent Events) darf der Proxy nicht puffern.
- einen SSH-Tunnel: `ssh -L 8790:127.0.0.1:8790 server`

Läuft der Manager auf demselben Rechner wie die Server, sollten die RCON-Ports nach außen geschlossen sein.

## Konfiguration

```json
{
  "database": "@/etc/ark-manager/db.url",
  "arkmanager": {
    "instances": "/etc/arkmanager/instances",
    "exclude": ["update-master", "test-*"],
    "defaults": { "role": "live", "externalBufferReader": true, "logSource": "file" },
    "overrides": { "event-map": { "role": "test" } }
  },
  "maps": [
    { "name": "remote1", "host": "10.0.0.5", "rconPort": 32330, "passwordEnv": "REMOTE1_RCON", "logSource": "none" }
  ],
  "pollSeconds": 10,
  "web": { "listen": "127.0.0.1:8790", "secureCookies": false, "trustProxy": false },
  "discord": {
    "webhooks": { "chat": "@/etc/ark-manager/discord-chat.url", "admin": "@/etc/ark-manager/discord-admin.url" },
    "routes": { "chat": "chat", "join": "chat", "leave": "chat", "ban": "admin", "audit": "admin", "admin": "admin", "map": "admin" }
  },
  "scriptCommands": ["TCsAR", "SpawnDino_DS"],
  "hooks": ["hooks/site.ts"],
  "retentionDays": 0
}
```

**Allgemein**
- `database`: `mysql://user:pass@127.0.0.1/db` (MySQL ab 5.7) oder `sqlite:/pfad/datei.sqlite`. `@datei` liest den Wert aus einer Datei, das gilt auch für Webhooks.

**Karten**
- `arkmanager`: liest die Instanzdateien. Daraus kommen Port, Passwort (`ark_ServerAdminPassword`), Sitzungsname und `arkserverroot` (für den Logordner). Ausgelassen werden Instanzen ohne RCON und solche mit `arkUpdateOnly="true"`. `include`/`exclude` erlauben `*` am Ende.
- Nach einem Passwortwechsel in der Instanzdatei übernimmt der Manager das neue Passwort selbst, sobald die Karte es ablehnt.
- `maps`: Karten von Hand oder Ergänzungen zu erkannten Karten. Das Passwort kommt aus `password`, `passwordFile` oder `passwordEnv`.
- `role`: `live` oder `test`. Auf Test-Karten darf ein superadmin ungetestete Befehle ohne `force` senden.
- `externalBufferReader`: `true`, solange ein anderes Programm `GetChat`/`GetGameLog` liest. Bei Live-Karten ist das die Vorgabe.
- `logSource`: `file` (Standard, wenn ein Logordner bekannt ist), `rcon` oder `none`.

**Sonstiges**
- `hooks`: Module, die beim Start geladen werden (`export default function (manager) {}`). Sie hören auf Ereignisse (`poll`, `event`, `player`, `status`, `audit`) und können über `manager.store.db` in eigene Tabellen schreiben. Damit lassen sich bestehende Webseiten-Tabellen weiter befüllen.
- `retentionDays`: Chat und Log nach so vielen Tagen löschen; `0` heißt nie.

## Rollen

| Rolle | Rechte |
|---|---|
| viewer | Karten, Spieler, Chat und Log sehen |
| moderator | + Chat an Karten und Spieler, Kick, Bann, Notizen, gespeicherte Befehle |
| admin | + Konsole (getestete Befehle und solche mit großer Wirkung), Banns aufheben, gespeicherte Befehle, Zeitpläne und Trigger verwalten, Audit-Log |
| superadmin | + ungetestete Befehle, Benutzer und Rollen |

Gespeicherte Befehle, Trigger und Zeitpläne kann nur anlegen, wer selbst das nötige Recht hat. Trigger und Zeitpläne laufen mit den Rechten eines admin.

## Trigger und Zeitpläne

Aktionen sind eine JSON-Liste. Beispiele:

```json
[{ "type": "message", "text": "Willkommen {{player.name}}! Regeln: siehe Webseite." }]
[{ "type": "discord", "webhook": "admin", "text": "{{player.name}} auf {{map}}: {{text}}" }]
[{ "type": "command", "command": "SaveWorld", "target": "all" }, { "type": "delay", "seconds": 30 }, { "type": "broadcast", "text": "Gespeichert." }]
```

- **Platzhalter:** `{{player.name}}`, `{{player.steamId}}`, `{{map}}`, `{{map.title}}`, `{{text}}`, `{{match.1}}` (Regex-Gruppe), `{{count}}` (Spieler auf der Karte), `{{time}}`.
- **In RCON-Befehlen:** Werte werden auf ASCII umgeschrieben (ä → ae), Anführungszeichen und `|` werden entfernt.
- **Zeitplan mit Vorwarnung:** Cron `0 5 * * *`, Aktion `[{"type":"command","command":"SaveWorld"}]`, Warnungen `[{"minutes":10,"text":"Neustart in 10 Minuten"},{"minutes":1,"text":"Neustart in 1 Minute"}]`.

## API

Jeder Aufruf außer `/api/login` braucht eine Anmeldung, entweder per Sitzungs-Cookie oder per `Authorization: Bearer <Token>`. Bei Cookie-Anmeldung brauchen ändernde Aufrufe zusätzlich den Header `X-ARKM: 1` (Schutz gegen Cross-Site-Requests). Die Rechte sind dieselben wie in der Oberfläche.

**Abfragen (GET)**

| Pfad | Inhalt |
|---|---|
| `/api/maps` | Kartenstatus und Spieler online |
| `/api/events?map=&types=chat,join&steamId=&q=&beforeId=&limit=` | Aktivität |
| `/api/players?q=`, `/api/players/<SteamID>` | Suche, Profil |
| `/api/bans?active=1` | Banns |
| `/api/audit` | Audit-Log |
| `/api/stream` | Live-Ereignisse (Server-Sent Events: `event`, `player`, `status`, `console`, `audit`) |

**Aktionen (POST)**

| Pfad | Body |
|---|---|
| `/api/exec` | `{ "maps": "all" \| ["karte"], "command": "...", "force": false }` |
| `/api/broadcast` | `{ "maps": "all", "text": "..." }` |
| `/api/players/<SteamID>/message`, `/kick`, `/notes` | |
| `/api/bans` | `{ "steamId", "reason", "minutes" }` |
| `/api/bans/<id>/revoke` | |
| `/api/commands/<id>/run` | `{ "params": {...}, "maps": [...] }` |
| `/api/check` | `{ "command": "..." }`: Sicherheitsprüfung ohne Senden |

Dazu kommen CRUD-Pfade für `/api/commands`, `/api/schedules`, `/api/triggers` und `/api/users`.

## Datenbank

Alle Tabellen beginnen mit `mgr_` und passen damit in eine bestehende Datenbank. Der Manager legt sie beim Start an.

| Tabellen | Inhalt |
|---|---|
| `mgr_players`, `mgr_player_names`, `mgr_sessions` | Spieler, Namensverlauf, Sitzungen |
| `mgr_events` | Chat, Spiellog, Kartenstatus |
| `mgr_bans`, `mgr_notes` | Banns und Notizen |
| `mgr_audit` | Audit-Log |
| `mgr_commands`, `mgr_schedules`, `mgr_triggers` | gespeicherte Befehle, Zeitpläne, Trigger |
| `mgr_users` | Benutzer |
| `mgr_maps`, `mgr_state` | Kartenstatus, Leseposition der Logdateien |

Zeitstempel sind Millisekunden UTC.

## Entwicklung und Tests

```bash
node --test test/manager.test.ts                 # RCON-Attrappe mit dem Verhalten von ASE 358.24, SQLite
ARK_EXPORT_TEST_MYSQL=mysql://root:pw@127.0.0.1:3306/mysql node --test test/manager.test.ts   # zusätzlich MySQL
node test/demo.ts 8790                           # Vorführung: drei Attrappen-Karten mit Spielern und Chat, Anmeldung demo / demo-password
```

`test/fake-ark.ts` verhält sich in den wichtigen Punkten wie ein echter ASE-Server:

- ein Paket je Antwort
- „Server received, But no response!!“, wenn es nichts zu antworten gibt
- Kennung −1 bei falschem Passwort
- „Keep Alive“-Pakete
- Verbindungsabbruch bei zu langen Befehlen und bei `GetTribeIdPlayerList`
- `?` statt Nicht-ASCII
- ein leerender Chatpuffer und eine Bannliste
