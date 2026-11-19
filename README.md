# ark-exporter

Liest Spielstände von **ARK: Survival Evolved** (`.ark`, Save-Version 9) **vollständig** und legt nach jedem Save zwei Dinge ab:

- einen **vollen Snapshot** als SQLite-Datei mit einer Zeile pro Objekt. Das sind Tiere, Items, Bauteile, Komponenten, Kryo-Inhalte, Profile und Stämme, jeweils mit allen Eigenschaften als JSON.
- einen **Verlauf**: was dazugekommen ist, was weggefallen ist, was sich wirklich geändert hat und wohin sich Tiere und Spieler bewegt haben.

Das Werkzeug heißt `ark-export` und läuft mit **Bun** oder **Node ≥ 22.18**. Es ist TypeScript ohne Build-Schritt und hat keine Laufzeit-Abhängigkeiten. ARK: Survival Ascended (ASA) wird noch nicht unterstützt.

> **Datenschutz:** Exporte enthalten Steam-IDs, Spielernamen und zuletzt genutzte IP-Adressen aus den Profilen. Nicht veröffentlichen.

## Schnellstart

```bash
git clone https://github.com/andi79h/ark-exporter.git
cd ark-exporter
bin/ark-export inspect /pfad/zu/SavedArks/TheIsland.ark       # was steckt drin, wie viel wird gelesen
bin/ark-export run /pfad/zu/SavedArks/TheIsland.ark --out export
bin/ark-export query export/TheIsland/latest.sqlite "SELECT category, count(*) AS n FROM objects GROUP BY 1"
```

## Was gelesen wird

Gemessen an einem `Gen2.ark` eines Community-Servers (816 MB, 2,19 Mio. Objekte):

| Teil | Größe | Stand |
|---|---|---|
| Kopf, Sublevel-Liste (242), Namenstabelle (7.526) | 0,5 MB | vollständig |
| Objekttabelle: Klasse, Namen, Sublevel, Position | 134,5 MB | vollständig |
| Hibernation: zwei leere Speicherblöcke für Stamm- und Spielerdaten, keine Einträge | 48 Byte | vollständig (auf allen 15 geprüften Karten leer) |
| Eigenschaftslisten: alle 19 Eigenschaftstypen, verschachtelte Strukturen und Arrays | 670,7 MB | vollständig |
| Daten nach den Eigenschaften: Foliage-Listen, Endmarken, zwei Vektorlisten je Spielerfigur | 10,4 MB | vollständig |
| Kryo-Inhalte als eingebettete Archive: Kryokapseln, Soul Traps (Mod Dino Storage), Zweitgestalt des Ferox | in Byte-Feldern | vollständig, Tiere als eigene Zeilen |
| Serialisierte Item-Eigenschaften (Dino Storage, „CCA Misc Data“) | in Byte-Feldern | vollständig |
| `.arkprofile`, `.arktribe` | 400 Dateien | vollständig |
| `.arktributetribe` | 24–104 Byte | als Zahlenfolge, Bedeutung offen |

**Ergebnis:** 99,99 % der Bytes werden strukturiert gelesen, ohne einen einzigen unbekannten Typ. Roh (Base64) bleiben nur 65 KB kleiner Byte-Felder, deren Inhalt schlicht Zahlencodes sind.

`ark-export inspect` zeigt die Abdeckung jeder Datei (Abschnitte, Rohbytes, Auffälligkeiten). Sie steht außerdem in der `meta`-Tabelle jedes Snapshots. Unbekanntes bricht den Lauf nicht ab: Es wird roh aufbewahrt und gezählt.

Nicht dabei sind die Cluster-Dateien (Uploads zwischen Karten).

## Stabile Schlüssel

Jede Zeile hat einen Schlüssel, der Saves und Server-Neustarts überdauert. Zwischen zwei Gen2-Saves im Abstand von 24 h finden sich 99,5 % der Objekte wieder; der Rest ist echte Neuerung (Items, Wildtiere).

| Schlüssel | Für |
|---|---|
| `dino:<DinoID1>:<DinoID2>` | Tiere, auch in Kryokapseln (Kapsel steht in `container`) |
| `item:<ItemID1>:<ItemID2>` | Items |
| `pawn:<LinkedPlayerDataID>` | Spielerfiguren in der Welt |
| `player:<PlayerDataID>` | Spielerprofile (`.arkprofile`) |
| `tribe:<TribeId>` | Stämme (`.arktribe`) |
| `actor:<Name>` | Bauteile und andere platzierte Actors |
| `actor:<Name>@<Sublevel>` | Actors aus Sublevels (Foliage, NPC-Zonen) |
| `<Besitzer>/<Name>` | Komponenten (Inventar, Status) und eingebettete Kopien unter ihrem Besitzer |

Ist ein Schlüssel schon vergeben, bekommt jede weitere Kopie `#2`, `#3` usw. Das betrifft vor allem Bauteile: In der Gen2-Probe stehen 19.925 Spieler-Bauteile doppelt im Save, mit gleichem Namen, gleicher Klasse und gleichem Ort. Die Ursache ist noch unklar.

Die GUIDs der Objekttabelle sind als Schlüssel unbrauchbar: Sie sind zu 95 % leer, der Rest ist vielfach doppelt.

Verweise zwischen Objekten (`ObjectProperty`) sind im Save nur Positionsnummern. Der Exporter ersetzt sie durch die stabilen Schlüssel. Nur so lassen sich zwei Saves vergleichen.

## Flüchtige Felder

Manche Felder ändern sich bei fast jedem Save, ohne dass im Spiel etwas passiert. Beispiele:
- Stasis-Zeitstempel
- Verderb-, Treibstoff- und Ernte-Timer
- beim Neustart neu ausgewürfelte Werte wie `RequiredTamingFoodIndex`
- `PlatformProfileID`

Sie stehen weiter im JSON, zählen aber nicht als Änderung. Die Liste (`VOLATILE_FIELDS` in `src/normalize.ts`) ist aus Gen2-Saves im Abstand von 2 h und 24 h abgeleitet. `ark-export compare` zeigt, welche Felder sich zwischen zwei Snapshots ändern.

Ohne diese Liste wären nach jedem Neustart fast alle 2,2 Mio. Objekte „geändert“. Mit ihr bleiben in der Probe wenige tausend echte Änderungen:
- 2 h: 1.813 geändert, +321/−331
- 24 h: 2.360 geändert, +11.146/−11.335, meist verbrauchte und neu entstandene Items

## Ausgabe

```
<out>/<name>/
  latest.sqlite -> snapshots/2026-09-22T12-12-03Z.sqlite
  snapshots/<Save-Zeit UTC>.sqlite   voller Stand, Gen2 ≈ 1,5 GB; die letzten --keep (2) bleiben
  history.sqlite                     Verlauf
```

### Snapshot: Tabelle `objects`

| Spalte | Inhalt |
|---|---|
| `key` | stabiler Schlüssel (eindeutig) |
| `source` | `world`, `cryo` (eingebettet), `profile`, `tribe`, `tribute` |
| `category` | `dino`, `item`, `structure`, `pawn`, `component`, `actor`, `player`, `player-data`, `tribe`, `tribe-data`, `tribute` |
| `class` | Blueprint-Klasse |
| `names` | Namenskette als JSON (Actor, dann Besitzer) |
| `container` | Item, in dem das Objekt eingebettet ist (Kryokapsel) |
| `owner` | Besitzer: Actor des Inventars (bei Items) bzw. äußeres Objekt (bei Komponenten) |
| `team` | `TargetingTeam` (Stamm-ID; zahme Tiere ≥ 50.000) bzw. Stamm von Profil und Stamm |
| `x`, `y`, `z`, `pitch`, `yaw`, `roll` | Position aus der Objekttabelle |
| `data_file` | Sublevel-Index bei Actors aus Sublevels |
| `guid` | GUID, falls nicht leer |
| `hash` | Prüfsumme über alle nicht flüchtigen Eigenschaften |
| `props` | alle Eigenschaften als JSON |
| `extra` | Daten nach den Eigenschaften (Foliage, Spielerfigur-Vektoren) als JSON |

`meta` enthält unter anderem:
- Karte, Save-Zeit, Spielzeit, Save-Zähler
- Sublevels, Abschnittsgrößen, Rohbytes, Auffälligkeiten
- Zähler je Kategorie, verwendete Liste flüchtiger Felder, Laufzeiten

### JSON-Konventionen

- Verweis: `{"$ref": "dino:…"}`. Pfad- oder Klassenverweis: `{"$path": "BlueprintGeneratedClass /Game/…"}`.
- Eingebettetes Archiv: `{"$embedded": 2}`. Die Objekte stehen als eigene Zeilen mit `container` = dieses Item.
- Serialisierte Eigenschaftsliste: `{"$properties": {…}}`. Rohbytes: `{"$bytes": "<base64>"}`.
- 64-Bit-Zahlen als Text, weil die IDs über 2^53 liegen. Floats als kürzeste exakte Dezimalzahl.
- Statische Arrays wie im Save einzeln: `CurrentStatusValues`, `CurrentStatusValues[4]` usw. Nur Werte ungleich dem Standard sind gespeichert.

### Verlauf: `history.sqlite`

| Tabelle | Inhalt |
|---|---|
| `saves` | ein Eintrag je verarbeitetem Save mit Zeit, Objektzahl und Zählern; der erste ist die Basis |
| `changes` | `added`/`removed` mit vollen Eigenschaften, `changed` mit `{"Feld": [alt, neu]}`; Spaltenänderungen als `$owner`, `$container` usw. |
| `positions` | Tiere und Spieler bei der Basis, danach alles, was sich mehr als 50 Einheiten (0,5 m) bewegt hat oder bei Tieren den Behälter bzw. Besitzer gewechselt hat |

## Beispiele

```bash
# zahme Tiere eines Stamms
ark-export query latest.sqlite "SELECT key, class, json_extract(props, '$.TamedName') AS name FROM objects WHERE category = 'dino' AND team = ?" 1234567
# Tiere in Kryokapseln nach Name
ark-export query latest.sqlite "SELECT key, class FROM objects WHERE source = 'cryo' AND category = 'dino' AND json_extract(props, '$.TamedName') LIKE ?" '%Rex%'
# Inhalt einer Kiste
ark-export query latest.sqlite "SELECT key, json_extract(props, '$.ItemQuantity') AS n FROM objects WHERE owner = ?" 'actor:StorageBox_Large_C_3'
# Weg eines Tiers
ark-export query history.sqlite "SELECT s.saved_at, p.x, p.y, p.z, p.container FROM positions p JOIN saves s ON s.id = p.save_id WHERE p.key = ? ORDER BY s.saved_at" 'dino:12345:67890'
# letzte Änderungen eines Stamms
ark-export query history.sqlite "SELECT s.saved_at, c.kind, c.key, c.data FROM changes c JOIN saves s ON s.id = c.save_id WHERE c.team = ? ORDER BY s.saved_at DESC LIMIT 50" 1234567
```

## Befehle

```
ark-export inspect <Map.ark>                        Abdeckung als JSON, schreibt nichts
ark-export snapshot <Map.ark> --out DIR [--name N]  voller Snapshot
ark-export history --out DIR --name N [--keep K]    neuesten Snapshot mit dem vorigen vergleichen
ark-export run <Map.ark> --out DIR [--name N]       Snapshot + Verlauf + alte Snapshots löschen
ark-export sync --out DIR [--exclude A,B] <SavedArks-Ordner | Map.ark>...
                                                    für jeden Save, der seit dem letzten Export neu ist
ark-export query <datei.sqlite> <SQL> [Parameter]   Zeilen als JSON Lines
ark-export compare <alt.sqlite> <neu.sqlite>        welche Felder sich ändern
```

- **`sync` und der Save:** `sync` nimmt pro `SavedArks`-Ordner den neuesten `.ark` (keine Zeitstempel-Sicherungen). Saves, die jünger als `--min-age` Sekunden sind, lässt es aus. Es läuft nie doppelt (Sperrdatei im Export-Ordner).
- **Name:** Der Name ist der Ordner über `ShooterGame` (`…/<name>/ShooterGame/Saved/SavedArks/…`), sonst der Kartenname.
- **Profile und Stämme:** Sie kommen aus demselben Ordner wie der Save.

## Laufzeit und Speicher

Gemessen auf einem Mac (M5 Max) mit dem Gen2-Save, je Save:

| | Bun 1.3 | Node 26 |
|---|---|---|
| Einlesen | 1,3 s | 1,9 s |
| Snapshot schreiben (2,2 Mio. Zeilen + Indizes) | 12 s | 12 s |
| Verlauf | 13 s | 12 s |
| Spitzen-RAM | 8,8 GB | 4,3 GB |

Auf einem älteren Server (Xeon E5-1650 v3) war das reine Einlesen 3- bis 4,7-mal langsamer. Für einen so großen Save ist also mit 1,5–2 Minuten je Save zu rechnen, auf einem Kern. Zwei Snapshots einer Gen2-Karte brauchen etwa 3 GB Platz. Der Verlauf wächst um wenige MB pro Tag.

## Einrichtung auf einem Linux-Server

Beispiel für einen Server, auf dem die Spielstände dem Benutzer `steam` gehören:

```bash
# Laufzeit: Bun (https://bun.sh) oder Node ≥ 22.18
# Code
git clone https://github.com/andi79h/ark-exporter.git /opt/ark-exporter
mkdir -p /home/steam/ark-export && chown steam:steam /home/steam/ark-export
```

Cron des Benutzers `steam`, kurz nach den Saves. Hier wird angenommen, dass der Server um :24 und :54 speichert:

```
26,56 * * * * nice -n 19 ionice -c3 /opt/ark-exporter/bin/ark-export sync --out /home/steam/ark-export /pfad/zu/den/*/ShooterGame/Saved/SavedArks >> /home/steam/ark-export/export.log 2>&1
```

- **Laufzeit festlegen:** Stehen weder `bun` noch `node` im `PATH`, zeigt `ARK_EXPORT_RUNTIME` auf die Binary. Beispiel: `ARK_EXPORT_RUNTIME=/opt/node/bin/node`.
- **Ältere Distributionen** wie Ubuntu 18.04 (glibc 2.27): Das offizielle Node ab Version 18 läuft dort nicht. Bun läuft, ebenso der inoffizielle Build `linux-x64-glibc-217` von [unofficial-builds.nodejs.org](https://unofficial-builds.nodejs.org/download/release/).

## Entwicklung

```bash
npm install         # nur TypeScript und Typen für die Prüfung
npm run check       # tsc --noEmit
npm test            # Node-Testlauf
npm run test:bun    # dieselben Tests unter Bun
```

Die Tests bauen kleine künstliche Saves (`test/build.ts`, `test/fixtures.ts`). Im Repo liegen keine echten Spielstände.

Aufbau:
- `src/archive.ts`, `properties.ts`, `objects.ts`: Binärformat
- `savegame.ts`, `container.ts`: Dateitypen
- `normalize.ts`: Schlüssel, Verweise, flüchtige Felder
- `snapshot.ts`, `history.ts`: Datenbanken
- `cli.ts`: Befehle

## Offen

- Bedeutung der `.arktributetribe`-Zahlen. Eine davon sieht wie ein Unix-Zeitstempel aus.
- Bedeutung der zwei Vektorlisten nach jeder Spielerfigur, vermutlich letzte Positionen.
- Doppelt gespeicherte Bauteile: Ursache klären.
- Verlauf schneller machen: ein Durchlauf über beide nach Schlüssel sortierten Snapshots statt mehrerer SQL-Joins.
- Räumlicher Index (SQLite R*Tree) für Suchen nach Bewegungsmustern.
- ARK: Survival Ascended (anderes Save-Format).

## Quellen und Lizenz

Das Wissen über das Save-Format stammt aus dem Quellcode MIT-lizenzierter Projekte:
- [ASV](https://github.com/miragedmuk/ASV) von MirageUK mit dem darin gepflegten [ArkSavegameToolkit](https://github.com/miragedmuk/ASV/tree/master/ArkSavegameToolkit) von Flachdachs
- dessen Vorlage [ark-savegame-toolkit](https://github.com/Qowyn/ark-savegame-toolkit) von Qowyn, der das Binärformat ursprünglich entschlüsselt hat

Der Code hier ist neu geschrieben. Lizenz: [MIT](LICENSE).

ARK: Survival Evolved ist eine Marke von Studio Wildcard. Dieses Projekt steht in keiner Verbindung dazu.
