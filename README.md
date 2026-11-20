# ark-exporter

Liest Spielstände von **ARK: Survival Evolved** (`.ark`, Save-Version 9) **vollständig** und legt nach jedem Save zwei Dinge ab:

- einen **vollen Snapshot** als SQLite-Datei mit einer Zeile pro Objekt. Das sind Tiere, Items, Bauteile, Komponenten, Kryo-Inhalte, Profile und Stämme, jeweils mit allen Eigenschaften als JSON.
- einen **Verlauf**: was dazugekommen ist, was weggefallen ist, was sich wirklich geändert hat und wohin sich Tiere und Spieler bewegt haben.

Auf Wunsch spiegelt es beides nach **MySQL**, damit man mit jedem MySQL-Werkzeug darin suchen kann.

Das Werkzeug heißt `ark-export` und läuft mit **Bun** oder **Node ≥ 22.18**. Es ist TypeScript ohne Build-Schritt. Die einzige Laufzeit-Abhängigkeit ist der MySQL-Treiber `mysql2`; er wird nur geladen, wenn MySQL genutzt wird (`npm ci --omit=dev`).

## Formate

| Spiel und Format | Stand |
|---|---|
| ARK: Survival Evolved, Save-Version 9 | vollständig, getestet mit Genesis 2 |
| ARK: Survival Evolved, Save-Version 10–11 (neuere Spielstände) | teilweise: Welt und Eigenschaften wie bei 9; die angehängten Blöcke mit Stämmen, Spielern und Kryo-Speicher werden noch nicht gelesen und in `inspect` als „unaccounted“ gezählt; ohne Beispiel-Save ungetestet |
| ARK: Survival Evolved, Save-Version 12 | noch nicht |
| ARK: Survival Ascended (ASA) | noch nicht |
| ASE-Cluster-Dateien (`clusters/<ClusterId>/<SteamID>`) | lesen und byte-genau zurückschreiben, Items anhängen (`ark-export cluster`, siehe [Cluster-Dateien](#cluster-dateien)) |

ASA speichert ganz anders als ASE:
- **Speicherform:** Die `.ark` ist selbst eine SQLite-Datenbank. Jedes Objekt liegt als Binärblock unter einer echten 16-Byte-UUID in der Tabelle `game`.
- **Kopf und Positionen:** Kopf, Namenstabelle und Positionen stehen in der Tabelle `custom`.
- **Eigenschaften:** Sie folgen dem Unreal-5-Format.

Ein Leser dafür ist machbar; ASV enthält dafür ein eigenes Toolkit von rund 2.200 Zeilen. Zum Testen braucht es aber ASA-Spielstände.

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

Nicht im Snapshot sind die Cluster-Dateien (Uploads zwischen Karten); sie liest und schreibt `ark-export cluster`, siehe [Cluster-Dateien](#cluster-dateien).

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
| `<Besitzer>/<Name>` | Komponenten (Inventar, Status) unter ihrem Besitzer |
| `dino:…~2`, `~3` … | eingebettete Kopien mit derselben ID; der Ferox legt bei jeder Verwandlung seine alte Gestalt eine Ebene tiefer ab (bis zu 16 Ebenen gesehen) |

Schlüssel über 500 Zeichen werden gekürzt und mit einer Prüfsumme eindeutig gemacht. Ist ein Schlüssel schon vergeben, bekommt jede weitere Kopie `#2`, `#3` usw. Das betrifft vor allem Bauteile: In der Gen2-Probe stehen 19.925 Spieler-Bauteile doppelt im Save, mit gleichem Namen, gleicher Klasse und gleichem Ort. Die Ursache ist noch unklar.

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
| `name` | lesbarer Name zum Suchen: Tiername, Spielername, Kistenname, Item-Name, Stammname |
| `tribe_name` | Stamm oder Besitzer, wie im Spiel angezeigt |
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

## MySQL

Mit `--mysql` (oder der Umgebungsvariable `ARK_EXPORT_MYSQL`) halten `run` und `sync` zusätzlich eine MySQL-Datenbank aktuell. Erwartet wird eine URL `mysql://benutzer:passwort@host:3306/datenbank`. Damit das Passwort nicht in der Prozessliste steht, kann statt der URL `@/pfad/zur/datei` stehen; die Datei enthält dann die URL.

Die Tabellen legt der Exporter selbst an. Alle Exporte teilen sich eine Datenbank, die Spalte `map` trennt sie (der Name des Exports, z. B. die Instanz):

| Tabelle | Inhalt |
|---|---|
| `maps` | je Export: ARK-Karte, gespiegelter Snapshot, Save-Zeit, Objektzahl, Abdeckung |
| `objects` | der neueste Stand, Spalten wie im Snapshot; `props`, `names`, `extra` als JSON |
| `saves`, `changes`, `positions` | der Verlauf, `seq` ist die laufende Nummer des Saves |

**Was geschrieben wird:**
- **Erster Lauf:** Der volle Stand wird geladen.
- **Danach:** Nur die Zeilen, die sich gegenüber dem gespiegelten Snapshot unterscheiden, werden geschrieben. Bei einem normalen Save sind das wenige tausend; nach einem Server-Neustart mehr, weil sich die Stasis-Zeiten aller Objekte ändern.
- **Verlauf:** Neue Einträge werden angehängt.
- **Wenn MySQL nicht erreichbar ist:** Die alten Snapshots bleiben liegen. Der nächste Lauf holt den Abgleich nach.

Getestet mit MySQL 5.7 und 8.0. Der Benutzer braucht auf der Datenbank `CREATE`, `INDEX`, `SELECT`, `INSERT`, `UPDATE` und `DELETE`.

**Messung mit dem Gen2-Save** (MySQL 8.0 in Docker auf einem Mac):

| | |
|---|---|
| Erstladung, 2,2 Mio. Zeilen über 4 Verbindungen | 4,9 Minuten |
| danach je Save (2.926 Zeilen geschrieben, 331 gelöscht) | 4,7 Sekunden |
| Platz in MySQL für eine Gen2-Karte | 3,1 GB |

Ein größerer `innodb_buffer_pool_size` beschleunigt die Erstladung; voreingestellt sind nur 128 MB.

```sql
-- zahme Tiere eines Stamms, über alle Karten
SELECT map, name, class, x, y FROM objects WHERE category = 'dino' AND tribe_name = 'Meine Truppe';
-- Suche nach Namen
SELECT map, `key`, category, name FROM objects WHERE name LIKE '%Rex%';
-- Werte aus dem JSON
SELECT name, props->>'$.BaseCharacterLevel' AS level FROM objects WHERE `key` LIKE 'dino:%' AND props->>'$.TamedName' IS NOT NULL;
-- Weg eines Tiers
SELECT s.saved_at, p.x, p.y, p.z FROM positions p JOIN saves s USING (map, seq) WHERE p.`key` = 'dino:12345:67890' ORDER BY s.saved_at;
```

Im JSON sind Verweise Objekte wie `{"$ref": "…"}`. In MySQL-Pfaden muss der Name deshalb in Anführungszeichen stehen: `props->>'$.MyInventoryComponent."$ref"'`.

## Beispiele für die SQLite-Dateien

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
ark-export mysql --out DIR [--name N] --mysql URL   neuesten Stand und Verlauf nach MySQL übertragen
ark-export query <datei.sqlite> <SQL> [Parameter]   Zeilen als JSON Lines
ark-export compare <alt.sqlite> <neu.sqlite>        welche Felder sich ändern
ark-export cluster show|check|add-item ...          Cluster-Dateien, siehe unten
```

- **`sync` und der Save:** `sync` nimmt pro `SavedArks`-Ordner den neuesten `.ark` (keine Zeitstempel-Sicherungen). Saves, die jünger als `--min-age` Sekunden sind, lässt es aus. Es läuft nie doppelt (Sperrdatei im Export-Ordner).
- **Name:** Der Name ist der Ordner über `ShooterGame` (`…/<name>/ShooterGame/Saved/SavedArks/…`), sonst der Kartenname.
- **Profile und Stämme:** Sie kommen aus demselben Ordner wie der Save.

## Cluster-Dateien

Was Spieler an Obelisk, Terminal oder Transmitter hochladen, legt der Server pro Spieler in `clusters/<ClusterId>/<SteamID>` ab. Jeder Server des Clusters liest dieselbe Datei. Spieler ohne Uploads haben eine Datei mit 0 Byte.

**Aufbau.** Die Datei ist ein Container wie `.arkprofile`, aber mit Version 4: `04000000 01000000`, ein Objekt `ArkCloudInventoryData`, dann dessen Eigenschaften. Die Eigenschaft `MyArkData` (Struct `ArkInventoryData`) enthält bis zu drei Arrays; leere Arrays fehlen:

| Array | ein Eintrag |
|---|---|
| `ArkItems` | `ArkTributeItem` (Struct `ItemNetInfo`, 95 Felder), `Version` (Float 2.0), `UploadTime` (Int32, Unix-Sekunden) |
| `ArkTamedDinosData` | `DinoClassName`, `DinoClass`, `DinoData` (Bytes: eingebettetes Archiv wie in Kryokapseln), `DinoName`, `DinoStats[0..11]` (Text), `DinoID1/2`, `UploadTime` … |
| `ArkPlayerData` | `PlayerDataID`, `PlayerDataBytes` (Bytes: eingebettetes Archiv), `PlayerName`, `PlayerStats[0..11]`, `UploadingServerMapName`, `UploadTime` … |

Wichtige Felder in `ItemNetInfo`:
- `ItemArchetype`: Klasse als `BlueprintGeneratedClass /Game/…/X.X_C`.
- `ItemId`: `ItemID1`, `ItemID2` (je UInt32). In allen untersuchten Dateien kleiner als 10⁹; das Spiel erzeugt sie offenbar als Zufalls-Float × 10⁹.
- `ItemStatValues[0..7]` (UInt16): allgemeine Qualität, Rüstung, Haltbarkeit (Maximum), Schaden, Munition, Kälteschutz, Gewicht, Hitzeschutz. Die Werte im Spiel ergeben sich daraus mit den Faktoren der jeweiligen Item-Klasse.
- `ItemQualityIndex` (Byte, 0–5: primitiv … aufgestiegen), `ItemRating` (Float), `ItemDurability` (Float, aktuelle Haltbarkeit).
- `ItemQuantity` (UInt32): **Anzahl − 1.** Einzelne Items und Blaupausen haben 0, ein voller 100er-Stapel hat 99, ein voller 50er-Stapel 49. Im Spieltest am 20.11.2026 kamen bei `ItemQuantity` 100 genau 101 Stück an. `cluster show` meldet deshalb `quantity` (Anzahl, also `ItemQuantity` + 1) und daneben `quantityRaw` (gespeicherter Wert).
- `ExpirationTimeUTC` (UInt32, Unix-Sekunden). In allen untersuchten Dateien genau `UploadTime + 86400`.
- `OwnerPlayerDataID` (UInt64): die `PlayerDataID` des Spielers, der hochgeladen hat.

**Lesen und Schreiben.** `src/tree.ts` liest Eigenschaften verlustfrei: Typ, Index, Reihenfolge und Kodierung bleiben erhalten. Werte, die der Schreiber anders kodieren würde, behalten ihre Original-Bytes, solange sie unverändert bleiben; das sind Texte in ungewöhnlicher Kodierung oder NaN mit Nutzlast. Unbekannte Teile bleiben Rohbytes. Dadurch wird jede Datei byte-genau zurückgeschrieben. `cluster check` prüft das für ganze Ordner, auch für die eingebetteten Tier- und Charakterarchive. Der Befehl schreibt nichts.

```
ark-export cluster show <datei> [--full]           Items, Tiere, Charaktere als JSON
ark-export cluster check <datei | ordner>...       jede Datei lesen und zurückschreiben, Abweichungen melden
ark-export cluster add-item <datei> --blueprint BP (--out DATEI | --in-place --backup ORDNER) [Optionen]
```

Beispiel: ein aufgestiegenes Krawallhemd mit freien Werten, eine Woche abholbar, als neue Datei:

```bash
bin/ark-export cluster add-item 7656119xxxxxxxxxx \
  --blueprint "Blueprint'/Game/PrimalEarth/CoreBlueprints/Items/Armor/Riot/PrimalItemArmor_RiotShirt.PrimalItemArmor_RiotShirt'" \
  --stats 0,30000,30000 --quality 5 --rating 15 --durability 1000 --expires-in 604800 \
  --custom-name "Treuebonus" --out /tmp/neu
```

- **Neues Item:** Die 95 Felder stehen in der Reihenfolge, die das Spiel schreibt (geprüft gegen echte Dateien). Die ItemID ist zufällig, kleiner als 10⁹ und in der Datei eindeutig. `OwnerPlayerDataID` kommt aus dem hochgeladenen Charakter oder den vorhandenen Items. `--quantity` ist die Anzahl im Spiel (mindestens 1); geschrieben wird `ItemQuantity` = Anzahl − 1, also `--quantity 100` → 99. Ohne Angabe gilt: 1 Stück, Ablauf nach 86 400 s. Leere Dateien bekommen die vollständige Struktur.
- **Prüfung:** Vor dem Schreiben wird das Ergebnis neu gelesen. Danach muss es ein Item mehr haben und sich selbst byte-genau zurückschreiben lassen. Lässt sich schon die Eingabe nicht byte-genau zurückschreiben, bricht der Befehl ab.
- **`--in-place`:** Sichert das Original zuerst nach `--backup`. Dann schreibt der Befehl eine temporäre Datei daneben und ersetzt die Datei per `rename`. Rechte, Besitzer und Gruppe bleiben erhalten. Hat jemand die Datei seit dem Lesen geändert, etwa der Spielserver, wird nichts ersetzt.
- **Noch ungeklärt:** Ob der Server eingeschleuste Items so annimmt, ist im Spiel noch nicht getestet. Ebenso offen ist, ob er `ExpirationTimeUTC` oder `TributeItemExpirationSeconds` ab `UploadTime` beachtet und was bei sehr hohen Werten passiert. Siehe [Offen](#offen).

### Tiere in Cluster-Dateien

Ein hochgeladenes Tier ist ein Eintrag in `ArkTamedDinosData`. Das Tier selbst steckt in `DinoData` als eingebettetes Archiv mit drei Objekten: das Tier (`DinoID1/2`, `TamedName`, `TargetingTeam`, `TamerString` …), seine Status-Komponente (Stufen, Werte, Erfahrung) und seine Inventar-Komponente. Kryokapseln, Seelen von Dino Storage v2, dessen Recovery-Liste und S+-Vivarien speichern dasselbe Archiv in `CustomItemDatas[].CustomDataBytes.ByteArrays[].Bytes`. Beim Herunterladen baut das Spiel das Tier aus `DinoData` (`APrimalDinoCharacter::SpawnFromDinoDataEx`, mit dem Team des Abholers und einer Duplikatprüfung). Die übrigen Felder des Eintrags (Name, die zwölf `DinoStats`-Texte, Erfahrung) zeigt nur die Upload-Liste an.

```
ark-export cluster dinos <datei | save.ark>...       Tiere, die add-dino kopieren kann (mit Nummer für --pick)
ark-export cluster add-dino <datei> --from DATEI (--pick N | --source-id A:B) (--out DATEI | --in-place --backup ORDNER) [Optionen]
ark-export cluster copy-item <datei> --from DATEI --index N (--out DATEI | --in-place --backup ORDNER) [Optionen]
```

- **Quellen für `add-dino`:** Uploads, Seelen und Kryokapseln aus einer anderen Cluster-Datei. Aus einem Spielstand (`.ark`) kommen Tiere in Seelen, in der Dino-Storage-Recovery-Liste, in Kryokapseln und in Vivarien. Tiere, die frei in der Welt stehen, sind Objekte des Spielstands selbst und noch nicht kopierbar. Den Klassenpfad liefert der Upload-Eintrag, bei Kryokapseln `CustomDataClasses` und bei Seelen `CustomDataStrings`. Bei Vivarien kommt er von einem anderen Tier derselben Klasse, sonst gibt man ihn mit `--blueprint` an.
- **Was sich ändert:** Das Tier bekommt neue, zufällige `DinoID1/2` (im Archiv und im Eintrag) und `UploadTime` = jetzt. Mit `--name` kommt ein neuer `TamedName` dazu. Alles andere bleibt Byte für Byte: Werte, Mutationen, Abstammung, Prägung, Farben, Inventar und Besitzfelder. Mit `--keep-id` bleiben die IDs erhalten; das ist nur sinnvoll, wenn das Original nicht mehr existiert. Stammt die Quelle aus einem Upload-Eintrag, werden dessen Felder übernommen. Sonst werden sie aus dem Archiv gebildet: `DinoName` als „Name - Lvl N (Art)“ und die `DinoStats`-Texte im Format des Spiels. Stufe = `BaseCharacterLevel` + `ExtraCharacterLevel`; Nahkampf und Tempo werden als (1 + Wert) × 100 % angezeigt.
- **`copy-item`** kopiert ein hochgeladenes Item, etwa eine gefüllte Seele, in eine andere Datei. Es bekommt eine neue ItemID, Upload- und Ablaufzeit sowie die `OwnerPlayerDataID` des Ziels. Tiere darin erhalten neue IDs. Dino Storage führt die IDs zusätzlich als Text `"id1 id2"` und den Besitzer als SteamID in `CustomDataStrings`; beides wird ersetzt. Die SteamID kommt standardmäßig aus dem Namen der Zieldatei.
- **Prüfungen:** wie bei `add-item`. Gelesen wird streng, und vor dem Schreiben wird alles erneut gelesen und zurückgeschrieben. Mit `--in-place` wird zuerst gesichert, dann atomar ersetzt. Ein Tier, dessen Archiv sich nicht byte-genau zurückschreiben lässt, wird nicht kopiert. Bei mehr als 20 Tieren in der Datei gibt es eine Warnung (`MaxTributeDinos`).
- **Erprobt** an Kopien echter Dateien: 45 Cluster-Dateien mit 55 hochgeladenen Tieren, 7 Kryokapseln und 3 gefüllten Seelen lassen sich alle in leere und volle Dateien einsetzen. Aus einem echten Genesis-2-Spielstand gilt das für 4.570 von 4.571 Tieren aus Seelen, Recovery-Liste und Vivarien; die Ausnahme ist eine Ferox-Gestalt ohne Klassenpfad. Ob der Server ein so eingesetztes Tier zum Herunterladen anbietet, ist im Spiel zu prüfen (siehe [Offen](#offen)).

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
- **Mit MySQL:** `--mysql @/home/steam/.ark-export-mysql` anhängen. Die Datei gehört `steam`, hat die Rechte 600 und enthält nur die URL.
- **Nach dem Einrichten:** Npm-Pakete einmal installieren: `cd /opt/ark-exporter && npm ci --omit=dev` (oder `bun install --production`).
- **Ältere Distributionen** wie Ubuntu 18.04 (glibc 2.27): Das offizielle Node ab Version 18 läuft dort nicht. Bun läuft, ebenso der inoffizielle Build `linux-x64-glibc-217` von [unofficial-builds.nodejs.org](https://unofficial-builds.nodejs.org/download/release/).

## Entwicklung

```bash
npm install         # nur TypeScript und Typen für die Prüfung
npm run check       # tsc --noEmit
npm test            # Node-Testlauf
npm run test:bun    # dieselben Tests unter Bun
ARK_EXPORT_TEST_MYSQL=mysql://root:pw@127.0.0.1:3306/mysql npm test   # mit MySQL-Test (legt eine Wegwerf-Datenbank an)
```

Die Tests bauen kleine künstliche Saves (`test/build.ts`, `test/fixtures.ts`). Im Repo liegen keine echten Spielstände.

Aufbau:
- `src/archive.ts`, `properties.ts`, `objects.ts`: Binärformat (lesen)
- `tree.ts`, `writer.ts`: verlustfreier Eigenschaftenbaum und Schreiber
- `savegame.ts`, `container.ts`, `cluster.ts`: Dateitypen
- `normalize.ts`: Schlüssel, Verweise, flüchtige Felder
- `snapshot.ts`, `history.ts`: Datenbanken
- `cli.ts`, `cluster-cli.ts`: Befehle

## Offen

- Bedeutung der `.arktributetribe`-Zahlen. Eine davon sieht wie ein Unix-Zeitstempel aus.
- Bedeutung der zwei Vektorlisten nach jeder Spielerfigur, vermutlich letzte Positionen.
- Doppelt gespeicherte Bauteile: Ursache klären.
- Verlauf schneller machen: ein Durchlauf über beide nach Schlüssel sortierten Snapshots statt mehrerer SQL-Joins.
- Räumlicher Index (SQLite R*Tree) für Suchen nach Bewegungsmustern.
- ARK: Survival Ascended (anderes Save-Format).
- Cluster-Dateien, nur im Spiel auf einem Testcluster zu klären:
  - Wird ein angehängtes Item am Obelisken angezeigt und lässt es sich herunterladen?
  - Welche Zeit zählt beim Ablauf: `ExpirationTimeUTC` oder `UploadTime` + `TributeItemExpirationSeconds`? Und was bewirken 0 oder 4294967295?
  - Hochgeladene Blaupausen haben zusätzlich alle `bIsEngram`. `--blueprint-copy` setzt dagegen nur `bIsBlueprint`, wie bei einer Blaupause aus einer Kiste. Reicht das? (Geklärt ist `ItemQuantity`: Anzahl − 1, siehe oben.)
  - Wird `ItemDurability` auf das Maximum aus `ItemStatValues[2]` begrenzt, wird `ItemRating` neu berechnet, und was gilt für sehr hohe Werte (65535)?
  - Spielt `OwnerPlayerDataID` beim Herunterladen eine Rolle?
  - Wann liest und schreibt der Server die Datei? Kann er eine gerade eingespielte Änderung mit einem älteren Stand überschreiben, etwa wenn der Spieler gleichzeitig hochlädt?
  - Bietet der Server ein mit `add-dino` eingesetztes Tier zum Herunterladen an? Wem gehört es danach: dem Abholer, wie `SpawnFromDinoDataEx(…, ForTeam, …)` vermuten lässt, oder weiter dem alten Stamm aus `TargetingTeam`?
  - Lässt sich eine mit `copy-item` kopierte Seele vom neuen Besitzer freilassen, obwohl darin noch die Stamm-ID des alten Besitzers steht?

## Quellen und Lizenz

Das Wissen über das Save-Format stammt aus dem Quellcode MIT-lizenzierter Projekte:
- [ASV](https://github.com/miragedmuk/ASV) von MirageUK mit dem darin gepflegten [ArkSavegameToolkit](https://github.com/miragedmuk/ASV/tree/master/ArkSavegameToolkit) von Flachdachs
- dessen Vorlage [ark-savegame-toolkit](https://github.com/Qowyn/ark-savegame-toolkit) von Qowyn, der das Binärformat ursprünglich entschlüsselt hat

Der Code hier ist neu geschrieben. Lizenz: [MIT](LICENSE).

ARK: Survival Evolved ist eine Marke von Studio Wildcard. Dieses Projekt steht in keiner Verbindung dazu.
