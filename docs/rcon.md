# ark-rcon: RCON-Verwaltung für ARK-Server

`ark-rcon` hält zu jeder Karte eines ARK-Clusters eine RCON-Verbindung. Er sammelt Spieler, Chat und Spiellog in einer Datenbank. Bedient wird er über eine Weboberfläche mit Rollen und eine JSON-API. Er ist als selbst gehosteter Ersatz für bezahlte RCON-Dienste wie BattleMetrics gebaut, und zwar für **ARK: Survival Evolved unter Linux mit arkmanager**. Gemessen und getestet ist er an Build 358.24.

## Inhalt

- [Was er kann](#was-er-kann)
- [Wie er Chat und Log liest](#wie-er-chat-und-log-liest)
  - [Tribe- und Allianz-Chat: das Chat-Log](#tribe--und-allianz-chat-das-chat-log)
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
| **Banns** | clusterweit, mit Grund und optionalem Ablauf. `BanPlayer` geht an jede erreichbare Karte. Gebannte Spieler werden beim Betreten gekickt, Zeitbanns laufen von selbst ab. Banns, die ein Admin im Spiel setzt, übernimmt der Dienst. Import einer `BanList.txt`. |
| **Konsole** | Befehle an eine, mehrere oder alle Karten, jeweils durch die [Sicherheitsprüfung](#sicherheitsregeln-für-rcon). |
| **Gespeicherte Befehle** | Vorlagen mit Parametern (Text, SteamID, Zahl), mit eigenem Recht. Ziel ist eine feste Karte, alle Karten oder die Karte, auf der der Spieler gerade ist. Damit dürfen Moderatoren geprüfte Befehle ausführen, ohne die Konsole zu haben. |
| **Zeitpläne** | Cron mit fünf Feldern und Zeitzone, Vorwarnungen per ServerChat (z. B. 10 und 1 Minute vor einem Neustart). |
| **Trigger** | Ereignis → Bedingung → Aktionen. Ereignisse: Join, erster Besuch im Cluster oder auf der Karte, Leave, Chat (Regex, mit [Chat-Log](#tribe--und-allianz-chat-das-chat-log) auch Befehle aus Tribe- und Allianz-Chat), Spiellog-Zeile (Art und Regex), Karte online/offline, gekickter gebannter Spieler. Aktionen: Befehl, ServerChat, Privatnachricht, Kick, Bann, Notiz, Discord, Pause, gespeicherter Befehl. Je Trigger eine Sperrzeit. |
| **Discord** | Webhooks mit Routen je Ereignisart (Chat, Join/Leave, Banns, Audit, Admin-Befehle im Spiel, Zähmungen, Kartenstatus). Erwähnungen sind abgeschaltet, Nachrichten werden gebündelt, Rate-Limits beachtet. |
| **Audit-Log** | jede Aktion mit Urheber (Benutzer, API-Token, Kommandozeile, Zeitplan, Trigger, Admin im Spiel), Ziel, Befehl, Antwort je Karte und Ergebnis. |
| **Benutzer** | Rollen viewer, moderator, admin, superadmin. Anmeldung mit Passwort (scrypt) oder API-Token für Skripte und Portale. |

## Wie er Chat und Log liest

ASE schreibt mit `-servergamelog` jede Zeile des Spiellogs auch in `ShooterGame/Saved/Logs/ServerGame.<pid>.<Datum>.log`. Darin stehen dieselben Zeilen, die `GetGameLog` über RCON liefert, also auch Chat und Joins. Der Dienst liest **diese Datei**. Das hat vier Gründe:

- `GetChat` und `GetGameLog` leeren einen Puffer, den sich alle RCON-Clients teilen. Liest ein zweites Werkzeug mit, fehlen dem ersten die Zeilen. Die Datei lässt sich lesen, ohne jemandem etwas wegzunehmen. Deshalb kann der Dienst parallel zu BattleMetrics laufen.
- RCON liefert Namen und Chat nur als ASCII, jedes andere Zeichen wird zu `?`. Die Datei ist UTF-8, Umlaute bleiben also erhalten. Spielernamen aus `ListPlayers` (`J?rg`) repariert der Dienst mit dem Namen aus der Logzeile (`Jörg`).
- Die Leseposition wird gespeichert. Nach einem Neustart des Dienstes geht keine Zeile verloren.
- Admin-Befehle im Spiel stehen mit Spielername, ARK-ID und SteamID in der Datei.

Wer `ListPlayers` abfragt, stört andere Clients nicht. Der Dienst fragt alle 10 s (`pollSeconds`). Daraus entstehen Sitzungen und Spielerprofile, denn nur `ListPlayers` liefert die SteamID.

Liegen die Logdateien auf einem anderen Rechner, kann ein Befehl sie liefern (`logCommand`). Ein Beispiel dafür ist `scripts/follow-gamelog.sh` über ssh. Ohne Datei geht es mit `logSource: "rcon"` auch über `GetGameLog`, aber nur, wenn sonst niemand den Puffer liest.

### Tribe- und Allianz-Chat: das Chat-Log

Im `ServerGame`-Log und in `GetChat` stehen nur Global- und Lokal-Chat, in ASE wie in ASA. Tribe- und Allianz-Chat schreibt der Server nur in ein eigenes Chat-Log. Dafür muss in der `GameUserSettings.ini` unter `[ServerSettings]` `LogChatMessages=True` stehen, als reine Startoption wirkt der Schalter nicht. Der Server meldet dann im `ShooterGame.log` „Chat logging enabled“. Mit `chatLogSource: "file"` liest der Dienst dieses Log als zweite Quelle neben dem `ServerGame`-Log.

- **Ort:** `ShooterGame/Saved/Logs/ChatLogs/<SessionName ohne Sonderzeichen>/ChatLog_<Datum>_<Stunde>-<Minute>_<Karte>.json`. Die Zeit ist UTC, Stunde und Minute stehen ohne führende Null, etwa jede Minute beginnt eine Datei. `chatLogDir` zeigt auf `ChatLogs` (Vorgabe: neben dem Logordner) oder direkt auf den Unterordner. Fehlt der Ordner beim Start noch, wartet der Dienst auf ihn.
- **Format:** jede Datei ist ein JSON-Feld, vorn ein Eintrag mit `"Metadata": true` und `FileTimestamp`, am Ende `{}`. Die laufende Datei ist noch offen. Der Server schreibt sie bei jedem Flush neu, frühestens alle 15 s (`ChatLogFlushIntervalSeconds`). Der Dienst zählt je Datei, wie viele Einträge er schon verarbeitet hat. So kommt jeder Eintrag genau einmal an, auch wenn er eine Datei mitten im Schreiben liest oder selbst neu startet. Er prüft den Ordner alle 2 s.
- **ASE und ASA:** ASE schreibt je Eintrag `Timestamp` (dieselbe Millisekunde wie im `ServerGame`-Log) und in `SenderSteamId` die SteamID64. ASA hat keinen Zeitstempel je Eintrag, und in `SenderSteamId` steht die 32-stellige EOS-ID. Bei ASA gilt die Zeit, zu der die Datei geschrieben wurde, das Ereignis trägt dann `tsEstimated`.
- **Absender:** kommt direkt aus `SenderSteamId`, ein Namensabgleich ist nicht nötig. `SenderId` ist die ARK-Spieler-ID, der Dienst trägt sie ins Spielerprofil ein (für Befehle wie `GiveItemToPlayer`). Den Namen aus RCON mit `?` statt Umlaut repariert er wie bei Joins.
- **Doppelte:** Global- und Lokal-Chat stehen in beiden Logs. Die erste Kopie zählt, die zweite fällt weg. Erkannt werden Kopien am Zeilentext `Name (Charakter): Text`, bei ASE zusätzlich an der Zeit (±2 s), bei ASA an der Ankunft innerhalb von 2 Minuten. Schickt jemand denselben Befehl zweimal, bleiben beide erhalten.
- **Datenschutz:** Mit dem Schalter schreibt der Server auch private Tribe- und Allianz-Gespräche mit. Aus diesen beiden Kanälen und aus unbekannten Kanälen gibt der Dienst nur Zeilen weiter, die mit `!` beginnen. Alle anderen zählt er nur. Text, Absender und IDs dieser Zeilen speichert er nicht. Die Befehle landen als `chat` mit `data.channel` (`tribe`, `alliance`) in `mgr_events`, an Hooks und an Trigger, aber nicht in Discord. Die Dateien selbst löscht der Server nach `ChatLogMaxAgeInDays` (z. B. `1`). Serverregeln und Datenschutzhinweis sollten den Mitschnitt nennen.
- **Verzug:** Befehle aus dem Chat-Log kommen erst mit dem nächsten Flush an, also bis zu 15 s später als Zeilen aus dem `ServerGame`-Log.
- **Andere Rechner:** Das Chat-Log liest der Dienst nur aus einem Ordner. Einen Befehl wie `logCommand` gibt es dafür noch nicht.

## Sicherheitsregeln für RCON

Bei ASE laufen RCON-Befehle über einen eigenen Cheat-Manager ohne Spieler. Dabei verweist `MyPC` auf den GameMode statt auf einen PlayerController. Viele Admin-Befehle tun deshalb über RCON nichts, manche bringen den Server zum Absturz. Der Dienst prüft jeden Befehl, bevor er ihn sendet. Die Regeln stehen in `src/rcon/policy.ts`, die Tabelle in `src/rcon/ase-358-commands.ts`. Die Tabelle stammt aus einer statischen Analyse der Server-Binary 358.24 mit 317 Befehlen, ergänzt um Tests auf einem Testserver.

| Regel | Grund |
|---|---|
| Abgelehnt: die 31 Befehle, die im Test abgestürzt sind (`SetDay`, `GetTribeIdPlayerList`, `LevelUp`, `PlayerCommand`, `Fly`, `Ghost` …) | Server-Absturz |
| Abgelehnt: Befehle, die auf dem RCON-Pfad `MyPC` benutzen (74 + 2) | Absturzkandidaten |
| Abgelehnt: Befehle, die bei RCON sofort abbrechen (172, z. B. `KillPlayer`, `DestroyTribeId`, `GiveExpToPlayer`) | wirkungslos, die Antwort sieht aber aus wie bei Erfolg |
| Abgelehnt: unbekannte Befehle; `ScriptCommand` nur mit erlaubtem Unterbefehl (`scriptCommands`) | nicht geprüft |
| Präfix `cheat`/`admincheat` wird entfernt | mit Präfix ignoriert der Server den Befehl |
| Abgelehnt: `\|`-Ketten, Zeilenumbrüche, Nicht-ASCII, mehr als 480 Byte | nur der erste Befehl einer Kette läuft; Nicht-ASCII wird zu `?`; ab ~490 Byte trennt der Server die Verbindung |
| `GetChat`/`GetGameLog` abgelehnt, wenn `externalBufferReader: true` | leeren den gemeinsamen Puffer |
| Getestete Befehle (`ListPlayers`, `ServerChat`, `KickPlayer`, `BanPlayer` …): Recht `console` | |
| Abgelehnt: `SetGlobalPause` | danach antwortet der Server nicht mehr per RCON (getestet) |
| Immer abgelehnt, auch über `extraVerified` nicht freizuschalten: `DumpConfig`, `QueueCheat`, `SpawnServerStatReplicator` (ASA) | `DumpConfig` schreibt das Admin- und das Join-Passwort im Klartext ins Server-Log (auf ASA getestet); die beiden anderen nutzen den fehlenden Spieler-Controller, Absturzkandidaten |
| Befehle mit großer Wirkung (`DoExit`, `DestroyWildDinos` …): Recht `console.risky` | |
| Laut Analyse lauffähige, aber ungetestete Befehle: nur `superadmin`, auf Live-Karten zusätzlich mit `force`; in Triggern und Zeitplänen nie | |

Textparameter, die nicht am Ende stehen, müssen in Anführungszeichen: `ServerChatTo "<SteamID>" Text`. Spielerbefehle wie `GiveItemToPlayer` verlangen die ARK-Spieler-ID, nicht die SteamID. Der Dienst kennt sie aus den Admin-Logzeilen, sonst steht sie in jedem Save an der Spielerfigur (`LinkedPlayerDataID`). `GiveItemToPlayer` gilt als getestet: Mit dem Empfänger online auf derselben Karte kommt das Item an und der Server läuft weiter. Ist der Spieler dort nicht online, passiert still nichts, eine Rückmeldung gibt es in keinem Fall.

Andere Builds (ASA, neuere ASE-Versionen) haben keine geprüfte Tabelle. Für sie gilt die Tabelle von 358.24 nur als Annahme.

## Installation

Voraussetzung ist Node ≥ 22.18 oder Bun; der Code ist TypeScript ohne Build-Schritt. Auf Systemen mit alter glibc, etwa Ubuntu 18.04, läuft der Node-Build `linux-x64-glibc-217` von unofficial-builds.nodejs.org.

```bash
git clone https://github.com/andi79h/ark-exporter.git /opt/ark-rcon
cd /opt/ark-rcon && npm ci --omit=dev        # nur mysql2, und nur nötig für MySQL
mkdir -p /etc/ark-rcon && cp docs/ark-rcon.example.json /etc/ark-rcon/config.json
bin/ark-rcon maps --config /etc/ark-rcon/config.json          # zeigt, welche Karten erkannt werden
bin/ark-rcon user add admin --role superadmin --config /etc/ark-rcon/config.json
bin/ark-rcon run --config /etc/ark-rcon/config.json
```

Der Dienst muss unter dem Benutzer laufen, der die Server betreibt (z. B. `steam`). Nur dieser darf die arkmanager-Dateien und die Logdateien (Modus 0600) lesen. Eine systemd-Unit:

```ini
[Service]
User=steam
ExecStart=/usr/bin/node /opt/ark-rcon/src/rcon/cli.ts run --config /etc/ark-rcon/config.json
Restart=always
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
```

Die Weboberfläche lauscht standardmäßig nur auf `127.0.0.1:8790`. Für den Zugriff von außen gibt es zwei Wege:

- einen Reverse-Proxy mit TLS; dann `secureCookies: true`, und `trustProxy: true`, damit die Sperre nach Fehlversuchen die echte Adresse sieht. Für den Live-Feed (Server-Sent Events) darf der Proxy nicht puffern.
- einen SSH-Tunnel: `ssh -L 8790:127.0.0.1:8790 server`

Läuft der Dienst auf demselben Rechner wie die Server, sollten die RCON-Ports nach außen geschlossen sein.

## Konfiguration

```json
{
  "database": "@/etc/ark-rcon/db.url",
  "arkmanager": {
    "instances": "/etc/arkmanager/instances",
    "exclude": ["update-master", "test-*"],
    "defaults": { "role": "live", "externalBufferReader": true, "logSource": "file" },
    "overrides": { "event-map": { "role": "test" }, "main-map": { "chatLogSource": "file" } }
  },
  "maps": [
    { "name": "remote1", "host": "10.0.0.5", "rconPort": 32330, "passwordEnv": "REMOTE1_RCON", "logSource": "none" }
  ],
  "pollSeconds": 10,
  "web": { "listen": "127.0.0.1:8790", "secureCookies": false, "trustProxy": false },
  "discord": {
    "webhooks": { "chat": "@/etc/ark-rcon/discord-chat.url", "admin": "@/etc/ark-rcon/discord-admin.url" },
    "routes": { "chat": "chat", "join": "chat", "leave": "chat", "ban": "admin", "audit": "admin", "admin": "admin", "map": "admin" }
  },
  "scriptCommands": ["TCsAR", "SpawnDino_DS"],
  "hooks": ["hooks/site.ts"],
  "databases": { "site": "@/etc/ark-rcon/site-db.url" },
  "retentionDays": 0
}
```

**Allgemein**
- `database`: `mysql://user:pass@127.0.0.1/db` (MySQL ab 5.7) oder `sqlite:/pfad/datei.sqlite`. `@datei` liest den Wert aus einer Datei, das gilt auch für Webhooks.

**Karten**
- `arkmanager`: liest die Instanzdateien. Daraus kommen Port, Passwort (`ark_ServerAdminPassword`), Sitzungsname und `arkserverroot` (für den Logordner). Ausgelassen werden Instanzen ohne RCON und solche mit `arkUpdateOnly="true"`. `include`/`exclude` erlauben `*` am Ende.
- Nach einem Passwortwechsel in der Instanzdatei übernimmt der Dienst das neue Passwort selbst, sobald die Karte es ablehnt.
- `maps`: Karten von Hand oder Ergänzungen zu erkannten Karten. Das Passwort kommt aus `password`, `passwordFile` oder `passwordEnv`.
- `role`: `live` oder `test`. Auf Test-Karten darf ein superadmin ungetestete Befehle ohne `force` senden.
- `externalBufferReader`: `true`, solange ein anderes Programm `GetChat`/`GetGameLog` liest. Bei Live-Karten ist das die Vorgabe.
- `logSource`: `file` (Standard, wenn ein Logordner bekannt ist), `rcon` oder `none`.
- `chatLogSource`: `file` liest zusätzlich das JSON-Chat-Log mit Tribe- und Allianz-Chat ([siehe oben](#tribe--und-allianz-chat-das-chat-log)). Vorgabe ist `none`, weil der Server dort auch private Gespräche mitschreibt.
- `chatLogDir`: Ordner `Saved/Logs/ChatLogs` oder der Unterordner der Sitzung darin. Vorgabe ist `ChatLogs` im Logordner (`logDir`).

**Sonstiges**
- `hooks`: Module, die beim Start geladen werden (`export default function (service) {}`). Sie hören auf Ereignisse (`poll`, `event`, `player`, `status`, `audit`) und können über `service.store.db` in eigene Tabellen schreiben.
- `databases`: weitere Datenbanken für Hooks, je mit einem Namen und in derselben Form wie `database`. Ein Hook holt sie mit `await service.database('site')`. Die Verbindung wird beim ersten Aufruf geöffnet und mit dem Dienst geschlossen. Damit kann ein Hook bestehende Webseiten-Tabellen in deren eigener Datenbank weiter befüllen, während die Tabellen von ark-rcon in einer eigenen Datenbank liegen.
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

Jeder Aufruf außer `/api/login` braucht eine Anmeldung, entweder per Sitzungs-Cookie oder per `Authorization: Bearer <Token>`. Bei Cookie-Anmeldung brauchen ändernde Aufrufe zusätzlich den Header `X-Ark-Rcon: 1` (Schutz gegen Cross-Site-Requests). Die Rechte sind dieselben wie in der Oberfläche.

Ein Portal, das mit einem eigenen Token für seine angemeldeten Benutzer handelt, schickt `X-Ark-Rcon-On-Behalf-Of: <Name>` mit. Im Audit-Log steht dann `<Token-Benutzer>:<Name>`. Es gelten die Rechte des Token-Benutzers.

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

Alle Tabellen beginnen mit `mgr_` und passen damit auch in eine bestehende Datenbank. Empfohlen ist eine eigene Datenbank, z. B. `ark_rcon`: Der Dienst braucht das Recht, Tabellen anzulegen, und das lässt sich in MySQL am einfachsten je Datenbank vergeben. Der Dienst legt seine Tabellen beim Start an.

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
node --test test/rcon.test.ts                    # RCON-Attrappe mit dem Verhalten von ASE 358.24, SQLite
node --test test/chatlog.test.ts                 # Chat-Log von ASE und ASA: Leser, Ordner, Doppelte, Weg durch den Dienst
ARK_EXPORT_TEST_MYSQL=mysql://root:pw@127.0.0.1:3306/mysql node --test test/rcon.test.ts   # zusätzlich MySQL
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
