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
| ARK: Survival Evolved, Save-Version 9, **schreiben** | byte-genau zurückschreiben, Bauteile löschen, Verfall zurücksetzen, Inventare leeren, Basen verschieben und drehen, kopieren, Bau-Vorlagen (`ark-export edit`, siehe [Spielstände ändern](#spielstände-ändern)) |

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

Schlüssel über 500 Zeichen werden gekürzt und mit einer Prüfsumme eindeutig gemacht. Ist ein Schlüssel schon vergeben, bekommt jede weitere Kopie `#2`, `#3` usw. Das betrifft vor allem Bauteile: In der Gen2-Probe stehen 19.925 Spieler-Bauteile doppelt im Save, mit gleichem Namen, gleicher Klasse und gleichem Ort. Das Spiel schreibt sie selbst so; im Spiel ist es jeweils ein Bauteil.

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
ark-export edit verify|check|list|delete|decay|clear-inventory|move|copy|pattern-save|pattern-show|pattern-place ...
                                                    Spielstände ändern, siehe unten
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
- `ItemQualityIndex` (Byte, 0–5: primitiv … aufgestiegen), `ItemRating` (Float), `ItemDurability` (Float, aktuelle Haltbarkeit), `ItemQuantity` (UInt32).
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

- **Neues Item:** Die 95 Felder stehen in der Reihenfolge, die das Spiel schreibt (geprüft gegen echte Dateien). Die ItemID ist zufällig, kleiner als 10⁹ und in der Datei eindeutig. `OwnerPlayerDataID` kommt aus dem hochgeladenen Charakter oder den vorhandenen Items. Ohne Angabe gilt: Menge 1, Ablauf nach 86 400 s. Leere Dateien bekommen die vollständige Struktur.
- **Prüfung:** Vor dem Schreiben wird das Ergebnis neu gelesen. Danach muss es ein Item mehr haben und sich selbst byte-genau zurückschreiben lassen. Lässt sich schon die Eingabe nicht byte-genau zurückschreiben, bricht der Befehl ab.
- **`--in-place`:** Sichert das Original zuerst nach `--backup`. Dann schreibt der Befehl eine temporäre Datei daneben und ersetzt die Datei per `rename`. Rechte, Besitzer und Gruppe bleiben erhalten. Hat jemand die Datei seit dem Lesen geändert, etwa der Spielserver, wird nichts ersetzt.
- **Noch ungeklärt:** Ob der Server eingeschleuste Items so annimmt, ist im Spiel noch nicht getestet. Ebenso offen ist, ob er `ExpirationTimeUTC` oder `TributeItemExpirationSeconds` ab `UploadTime` beachtet und was bei sehr hohen Werten passiert. Siehe [Offen](#offen).

## Spielstände ändern

`ark-export edit` ändert `.ark`-Spielstände (ASE, Save-Version 9) und schreibt dabei immer eine **neue Datei**. Die Eingabe bleibt unberührt; `--out` darf nicht die Eingabe sein. Gedacht ist das für Admin-Dienste: einen Stand aus der Sicherung holen, ändern, auf einer Testinstanz laden und erst dann einspielen, während die Karte gestoppt ist.

**Byte-genau.** Ein unveränderter Save wird byte-gleich zurückgeschrieben. `edit verify` beweist das für jede Datei auf drei Wegen:
- Kopierpfad: unveränderte Objekte werden kopiert, nur Offsets neu berechnet.
- Patchpfad: alle Objektverweise werden neu geschrieben, als hätten sich Indizes verschoben.
- Vollständig neu kodiert: jedes Objekt, jede Eigenschaft, jedes eingebettete Archiv (Kryokapseln, Soul Traps) und jede serialisierte Eigenschaftsliste.

Geprüft mit Saves von 15 Karten eines Community-Servers (46 MB bis 766 MB, zusammen 9,4 Mio. Objekte): alle drei Wege byte-identisch, 0 undurchsichtige Eigenschaften. Gen2 (613 MB, 1,6 Mio. Objekte) braucht dafür mit Bun rund 20 s und 7 GB RAM.

**So arbeitet der Writer.**
- **Unverändertes:** Unveränderte Objekte behalten ihre Bytes. Neu geschrieben werden nur geänderte und neue Objekte, und zwar aus dem verlustfreien Eigenschaftenbaum (`src/tree.ts`, dieselbe Schicht wie bei den Cluster-Dateien).
- **Namen:** Namen laufen über die Namenstabelle der Datei. Neue Namen werden angehängt, die Reihenfolge der alten bleibt. Instanznummern folgen der Unreal-Regel (`Wall_Wood_C_12` = `Wall_Wood_C` + Instanz 13).
- **Verweise:** Objektverweise (`ObjectProperty`) sind Positionen in der Objekttabelle. Werden Objekte gelöscht, rückt alles dahinter auf. Der Writer schreibt dann jeden Verweis in jedem Objekt um, auch in unveränderten; dafür findet ein Scanner die Stellen, ohne das Objekt zu dekodieren. Verweise auf gelöschte Objekte werden aus Arrays entfernt, einzelne werden „kein Objekt“ (-1). Neue Objekte kommen ans Ende der Tabelle.
- **Hibernation:** Der Block wird unverändert übernommen. In allen geprüften Saves ist er leer; sonst warnt der Editor.

**Nach jedem Schreiben** liest der Befehl die neue Datei mit dem Export-Leser vollständig zurück und bricht ab, wenn ein Byte nicht zugeordnet werden kann. `edit check` zählt außerdem, was das Spiel verwirren könnte, und der Bericht stellt die Werte vor und nach der Änderung gegenüber:
- Verweise ins Leere,
- Komponenten ohne ihren Actor,
- doppelte ItemIDs und DinoIDs,
- doppelte Actor-Namen,
- einseitige `LinkedStructures`.

```
ark-export edit verify <Map.ark>...               byte-identisches Schreiben beweisen (liest nur)
ark-export edit check <Map.ark>...                Konsistenz: Verweise, eindeutige IDs, Komponenten (liest nur)
ark-export edit list <Map.ark> SELECTION [--full] Auswahl zählen: Klassen, Besitzer, Bereich
ark-export edit delete <Map.ark> SELECTION --out FILE
ark-export edit decay <Map.ark> SELECTION --out FILE [--days N]
ark-export edit clear-inventory <Map.ark> SELECTION --out FILE [--engrams] [--equipped]
ark-export edit move <Map.ark> SELECTION (--by DX,DY,DZ | --to X,Y,Z) [--rotate DEG] [--pivot X,Y,Z]
                     [--with-dinos] [--with-players] --out FILE
ark-export edit copy <Map.ark> SELECTION (--by … | --to …) [--rotate DEG] [--items] OWNER --out FILE
ark-export edit pattern-save <Map.ark> SELECTION --pattern FILE [--anchor X,Y,Z[,YAW]] [--items] [--name N]
ark-export edit pattern-show FILE
ark-export edit pattern-place <Map.ark> --pattern FILE --at X,Y,Z[,YAW] OWNER [--check] [--force]
                     [--limit N] [--limit-radius R] [--margin M] --out FILE
ark-export edit remap-classes <Map.ark> --mapping FILE [--assets FILE] [--no-profiles] [--cluster DIR]
                     [--trust-short-names] [--report FILE] (--dry-run | --out FILE [--out-dir DIR])
ark-export edit remove-classes <Map.ark> (--class C | --package PACKAGE)... [--assets FILE]
                     [--trust-short-names] [--refund FILE.csv|.json] [--grid UNITS] [--report FILE]
                     (--dry-run | --out FILE)
ark-export edit asset-list <Content/Mods>...      Asset-Pfade installierter Mods (Eingabe für --assets)
```

`SELECTION` besteht aus mindestens einem der folgenden Kriterien, mehrere gelten zusammen:
- `--tribe ID`: `TargetingTeam`, also Stamm-ID oder Spieler-ID bei Einzelspielern.
- `--owner NAME`: `OwnerName` bzw. `TribeName`.
- `--box X1,Y1,Z1,X2,Y2,Z2`: Quader.
- `--radius X,Y,R`: senkrechter Zylinder; `--radius X,Y,Z,R`: Kugel.
- `--class C`: Klasse, `*` als Platzhalter, mehrfach möglich.
- `--kind`: `structure` (Standard), `dino`, `pawn`, `actor`.

`OWNER` ist `--team ID [--tribe-name S] [--player-id N] [--player-name S]`.

Koordinaten sind Unreal-Einheiten (100 = 1 m), wie sie der Admin-Befehl `ccc` im Spiel ausgibt: `x y z pitch yaw roll`.

### Was die Operationen tun

| Operation | Wirkung |
|---|---|
| `delete` | entfernt die Actors samt Komponenten (Inventar, Status, Bemalung) und den Items ihrer Inventare; Verweise anderer Objekte (`LinkedStructures`, `StructuresPlacedOnFloor`, `PlacedOnFloorStructure`, Inventarlisten, Sattel) werden bereinigt. `mayCollapse` nennt die verbleibenden Bauteile, die auf einem gelöschten standen oder daran hingen: Das Spiel prüft beim Laden ihren Halt und lässt sie gegebenenfalls einstürzen (im Servertest geschehen) |
| `decay` | setzt `LastInAllyRangeTime` auf die Spielzeit des Saves (plus `--days`); der Verfall beginnt dann neu, als wäre gerade ein Stammesmitglied in der Nähe gewesen |
| `clear-inventory` | entfernt die Items aus `InventoryItems` (mit `--equipped` auch ausgerüstete Items und Slots); Engramme von Werkbänken bleiben, außer mit `--engrams`; Zähler am Behälter (`CurrentItemCount`, bei Super-Structures-Lagern `ResourceCount`) werden angepasst |
| `move` | verschiebt und dreht um die senkrechte Achse durch den Drehpunkt (Standard: Mitte der Auswahl auf ihrer tiefsten Höhe); Gier-Winkel und Weltkoordinaten in Eigenschaften (Rohr- und Kabelenden, Landeplätze) drehen mit; Bauteile auf Plattformsätteln folgen ihrem Tier; `--with-dinos`/`--with-players` nehmen zahme Tiere bzw. Spielerfiguren derselben Stämme im Bereich mit |
| `copy` | wie `pattern-save` und `pattern-place` in einem Schritt, innerhalb desselben Saves |

Die Rotation um die senkrechte Achse ist exakt, weil Unreal Rotationen in der Reihenfolge Gier, Nicken, Rollen zusammensetzt. Eine Drehung der ganzen Basis addiert sich also nur zum Gier-Winkel jedes Bauteils.

### Bau-Vorlagen

Ein Admin baut auf einer Testkarte ein Haus, eine Burg oder eine Windmühle. `pattern-save` schneidet den Bau als JSON-Vorlage aus. `pattern-place` setzt ihn an beliebiger Stelle wieder ein: auf jeder Karte, mit beliebiger Drehung und für jeden Stamm.

```bash
# Haus des Test-Stamms in einem Umkreis von 25 m herauslösen, leer (ohne Kisteninhalt)
bin/ark-export edit pattern-save TestMap.ark --tribe 1234567 --radius 120000,80000,2500 --pattern house.json --name house
# prüfen, ob am Zielort Platz ist (Exit-Code 2 bei Hindernissen)
bin/ark-export edit pattern-place TheIsland.ark --pattern house.json --at -50000,60000,-1200,90 --team 7654321 --check
# einsetzen, um 90° gedreht, für Stamm 7654321
bin/ark-export edit pattern-place TheIsland.ark --pattern house.json --at -50000,60000,-1200,90 \
  --team 7654321 --tribe-name "Die Neuen" --out TheIsland.new.ark
```

**Doppelte Einträge.** Das Spiel schreibt manche Actors zweimal unter demselben Namen in den Save, mit gleichen Werten. Beim Laden ist das ein einziger Actor. Belegt ist das durch einen Servertest: Ein einmal eingesetztes Bauteil stand nach `saveworld` doppelt im Save. Eine Vorlage übernimmt deshalb je Name nur einen Eintrag und biegt Verweise auf den zweiten um (`duplicatesMerged`); sonst stünde jedes Bauteil nach dem Einsetzen zweimal da. `list` zählt beides (`count`, `uniqueNames`).

**Inhalt einer Vorlage:**
- Positionen relativ zu einem Anker. Ohne `--anchor` ist das die Mitte der Auswahl auf ihrer tiefsten Höhe.
- Klassen, Namen und alle Eigenschaften verlustfrei.
- Verweise innerhalb der Vorlage. Verweise nach außen, etwa auf einen Nachbarbau oder den Spieler, der gebaut hat, werden entfernt und in `droppedRefs` gezählt.
- Mit `--items` auch die Kisteninhalte.

**Beim Einsetzen ändert sich:**
- Position und Gier-Winkel, auch Weltkoordinaten in Eigenschaften.
- Objektnamen: neue Instanznummern, Komponenten folgen ihrem Actor.
- `ItemId`, `DinoID1/2` und `BedID`: neu und im Ziel-Save eindeutig.
- Besitzer: `TargetingTeam`, `OwnerName`, `OwningPlayerID/Name`.
- Zeitstempel: Die Vorlage speichert sie relativ zur Spielzeit der Quelle und legt sie auf die Spielzeit des Ziels um. `OriginalCreationTime` und `LastInAllyRangeTime` werden „jetzt“.

**Was beim Einsetzen schiefgehen kann:**

| Risiko | Prüfung |
|---|---|
| Überlappung mit vorhandenen Bauten, Tieren, Spielern | blockiert (Quader um die gedrehte Vorlage plus `--margin`, Standard 1 m); `--force` setzt trotzdem |
| Boden: der Save kennt kein Terrain | Warnung; der Bericht nennt als Anhalt die Höhen bekannter Objekte im Umkreis von 50 m (`nearbyZ`). Zielhöhe am besten im Spiel mit `ccc` auf dem Boden abnehmen und im Spiel kontrollieren |
| Klassen, die im Ziel-Save nicht vorkommen (Mod dort nicht installiert?) | Warnung mit Klassenliste; Item-Klassen unter `/Game/Mods/` werden gezählt |
| Bauteil-Limit | `--limit N --limit-radius R` blockiert, wenn danach mehr als N Bauteile im Umkreis R stehen (Spieleinstellung `TheMaxStructuresInRange`) |
| Kryokapseln mit Tieren in der Vorlage | Warnung: jedes Einsetzen verdoppelt die Tiere darin |
| Einseitige Verknüpfungen | werden wie im Original übernommen (auch Live-Saves haben viele) |

Ob das Spiel einen so geänderten Save lädt, beweist nur ein Server. Der Ablauf dafür: Save laden, `saveworld`, den neuen Save wieder lesen. Erst danach gehört eine Änderung auf eine Live-Karte, und dort nur bei gestoppter Karte und mit frischer Sicherung.

### Mods tauschen und entfernen

Fehlt beim Serverstart die Klasse eines Objekts, verwirft das Spiel das Objekt, und nach dem nächsten Weltsave ist es weg. Wer eine Mod entfernt oder durch eine andere ersetzt, verliert so Bauten, Items und Tiere. Zwei Befehle helfen, das vorher kontrolliert zu erledigen, offline und auf einer Kopie:
- `remap-classes` schreibt Objekte auf Ersatzklassen um, etwa aus einer Nachfolge-Mod, aus dem Kernspiel oder aus einer eigenen Stub-Mod.
- `remove-classes` entfernt alle Objekte bestimmter Klassen und schreibt eine Erstattungsliste je Stamm.

**Wo Klassen stehen.** Der Objektkopf nennt die Klasse nur mit kurzem Namen (`BP_StorageLarge_C`). Volle Pfade gibt es nur in Eigenschaften und eingebetteten Archiven:

| Schicht | Beispiel | Schlüssel im Bericht |
|---|---|---|
| Objekttabelle | Klasse jedes Objekts, nur Kurzname | `world.header` |
| Pfad-Verweise (`ObjectProperty` mit Pfad) | `ItemArchetype`, `CraftingStationRecipes`, `CustomDataClasses`, `ItemCustomClass` | `world.path` |
| Str- und NameProperty | `ForPrimalBuffClassString`, `CustomDataStrings` (`,/Game/…/X.X\|0`), Klassennamen als Name | `world.string` |
| Eingebettete Archive | Tiere in Kryokapseln und Seelen, Sättel daneben als ItemNetInfo, die Wiederherstellungsliste von Dino Storage (`CCA Misc Data`) | `world.embedded.*` |
| `.arkprofile`, `.arktribe` | Engram-Listen (`PlayerState_EngramBlueprints`), Buff-Klassen, Standard-Slots | `profile.*`, `tribe.*` |
| Cluster-Dateien (`--cluster`) | hochgeladene Items und Tiere | `cluster.*` |

**Kurznamen sind nicht eindeutig.** Mods liefern Kopien von Kern-Assets mit gleichem Namen mit: Primitive Plus etwa `PrimalItemConsumable_RawMeat_Fish`, Primal Fear Extras ein eigenes `Campfire`. Seit dem Homestead-Update führt auch das Kernspiel viele Super-Structures-Klassen unter denselben Namen (`BP_DedicatedStorage` und weitere). Wer „alle Objekte mit Kurzname X“ umschreibt oder löscht, trifft also womöglich fremde Objekte. Deshalb gilt:
- **Pfade** werden nur bei vollständig gleichem Pfad umgeschrieben oder als Mod-Inhalt erkannt, also mit Paket.
- **Kurznamen** in Objektköpfen und als ganzer Str- oder Name-Wert ändern sich nur, wenn der Name nachweislich allein aus dem alten Paket stammt. Den Nachweis liefern die Pfade im Save (und in Profilen) und eine Asset-Liste aller geladenen Pakete (`--assets`). Der Bericht nennt je Zeile den Stand:
  - `verified`: Der Name kommt im alten Paket vor und sonst nirgends.
  - `ambiguous`: Der Name kommt auch in einem anderen Paket vor, mit Beispielen.
  - `unverified`: Es gibt keinen Beleg in die eine oder andere Richtung.
- Nur `verified` schreibt Objektköpfe um. `--trust-short-names` hebt die Sperre auf, wenn klar ist, dass alle Objekte dieses Namens gemeint sind.

Die Asset-Liste enthält eine Zeile je Asset: einen vollen Pfad (`/Game/Mods/StructuresPlusMod/Misc/StorageLarge/BP_StorageLarge`) oder einen bloßen Namen. Bloße Namen gelten als Kernspiel. `asset-list` erzeugt die Liste aus dem Mod-Verzeichnis eines Servers, die Paketwurzel liest es aus `<id>.mod`. Die Kern-Assets kommen dazu, etwa als Namensliste aus den Paketen des Spiels:

```bash
bin/ark-export edit asset-list /pfad/ShooterGame/Content/Mods > assets.txt
cat core_assets.txt >> assets.txt
```

**Mapping-Datei** (`remap-classes`): tabulatorgetrennt (oder JSON, siehe unten) mit den Spalten `old_class`, `new_class`, `old_path`, `new_path` und optional `only_mod_package`. Eine Kopfzeile mit diesen Namen darf die Reihenfolge ändern, `#` leitet Kommentare ein. Pfade dürfen in jeder üblichen Form stehen (`/Game/A/B.B_C`, `/Game/A/B`, `Blueprint'/Game/A/B.B'`). Der Befehl prüft, dass Pfad und Klassenname zusammenpassen. `only_mod_package` (`StructuresPlusMod` oder `/Game/Mods/StructuresPlusMod`) legt fest, aus welchem Paket der Kurzname stammen muss. Ohne die Spalte gilt das Paket von `old_path`. Alle Zeilen gelten gleichzeitig: Bei A→B und B→C wird A zu B, nicht zu C.

```
old_class	new_class	old_path	new_path	only_mod_package
BP_StorageLarge_C	StorageBox_Large_C	/Game/Mods/StructuresPlusMod/Misc/StorageLarge/BP_StorageLarge.BP_StorageLarge_C	/Game/PrimalEarth/Structures/StorageBox_Large.StorageBox_Large_C	StructuresPlusMod
```

**Was `remap-classes` tut und lässt:**
- Neue Namen hängt der Befehl an die Namenstabelle an. Vorhandene Einträge überschreibt er nie, weil ein Eintrag auch anderswo dienen kann.
- Instanznamen bleiben, wie sie sind: `BP_StorageLarge_C_12` heißt danach weiter so, nur mit der Klasse `StorageBox_Large_C`. Andere Objekte verweisen über diesen Namen, etwa Komponenten auf ihren Actor. Ob das Spiel abweichende Präfixe ohne Folgen hinnimmt, klärt erst ein Test auf einem Server.
- Eingebettete Archive und Profile werden nur geschrieben, wenn sie zuvor byte-gleich zurückkodieren. Unbeteiligte Objekte und Dateien bleiben byte-gleich. Das Ergebnis ist deterministisch.
- Geänderte `.arkprofile`- und `.arktribe`-Dateien neben dem Save landen in `--out-dir`, nie im Eingabeverzeichnis. `--no-profiles` lässt sie aus.
- `--dry-run` macht alles außer Schreiben. `--report FILE` hält den Bericht fest.

**Der Bericht** enthält je Zeile:
- Treffer je Schicht (`found`), davon umgeschrieben (`rewritten`) und übersprungen (`skipped`), dazu Profile mit Treffern.
- Die betroffenen Stämme mit Trefferzahl.
- Die Komponenten der umgeschriebenen Actors. `mapped: false` heißt: Die Inventar- oder Statuskomponente bleibt eine Mod-Klasse, ihr fehlt noch eine Mapping-Zeile.
- Eigenschaften der alten Objekte, die kein Objekt der Zielklasse im selben Save hat (`notOnTarget`). Die Zielklasse ignoriert sie vermutlich. Gibt es im Save kein Objekt der Zielklasse, steht dort `null` mit der Liste der alten Eigenschaften.

Unter `remaining` steht je Paket, was danach noch übrig ist: Objekte nach Klasse, getrennt nach eindeutigen und mehrdeutigen Kurznamen, sowie Pfad-Verweise. Sind diese Listen leer, lässt sich die Mod ohne Verlust abschalten.

**`remove-classes`** nimmt Klassen (`--class`, `*` als Platzhalter) oder ganze Pakete (`--package`, dafür `--assets` mitgeben, sonst kennt der Befehl nur Klassen, deren Pfad im Save steht). Mehrdeutige Kurznamen bleiben stehen, außer mit `--trust-short-names`. Entfernt werden:
- Actors der Klassen (Bauteile, Tiere, andere) samt Komponenten und Inventar. Verweise anderer Objekte werden bereinigt wie bei `delete`, `mayCollapse` nennt Bauteile, die ihren Halt verlieren.
- Items der Klassen in jedem Inventar, auch in fremden. Die Zähler der Behälter (`CurrentItemCount`, `ResourceCount`) passen sich an.
- In Kryokapseln und Seelen:
  - Ein Sattel oder Kostüm der Klassen neben dem Tier leert nur seinen Platz (`Bytes` mit 0 Byte), das Tier bleibt.
  - Ist das Tier selbst von einer entfernten Klasse, geht der ganze Behälter, die Kapsel oder die Seele.
- Einträge von Listen wie der Dino-Storage-Wiederherstellung (`CCA Misc Data`), die ein solches Tier tragen (`entriesDropped`).

Stehen bleiben, und der Bericht zählt sie:
- Komponenten der Klassen an Actors, die bleiben (`componentsKept`).
- Pfad-Verweise in anderen Objekten wie Rezepte, Logs oder Belohnungspakete (`pathReferencesLeft`). Das Spiel löst sie ohne die Mod zu nichts auf.
- Hochgeladene Items und Tiere in Cluster-Dateien sowie Profile. Beides fasst der Befehl nicht an.

**Erstattungsliste** (`--refund FILE.csv`, auch im Trockenlauf): eine Zeile je Stamm, Grund, Art, Klasse, Halter und Gebiet. Das Gebiet ist eine Rasterzelle von `--grid` Einheiten, Standard 10.000 = 100 m. Die Spalten:
- `map`, `tribe_id`, `tribe_name`.
- `reason`: `class` = selbst von einer entfernten Klasse, `content` = lag darin oder darauf, etwa der Inhalt einer Mod-Kiste oder das Tier einer Mod-Seele.
- `kind`: `structure`, `dino`, `item`, `actor`, `pawn`.
- `class`, `blueprint`, `objects`, `quantity` (Stückzahl).
- `holder`: wo es lag, bei eingebetteten Objekten als Kette, etwa `Raptor_Character_BP_C in PrimalItem_WeaponEmptyCryopod_C in StorageBox_Large_C`.
- `x`, `y`, `z`: ein Ort aus der Gruppe.

Doppelt gespeicherte Actors zählen einmal, Engramme gar nicht (`engramsRemoved`). Tiere in Seelen und Kryokapseln zählen für ihren eigenen Stamm. Einträge der Dino-Storage-Wiederherstellung erkennt man am Halter `… in DinoStorage2CCA_C`. Ob sie zu erstatten sind, entscheiden die Admins.

**Gemessen** auf einer lokalen Kopie des Gen2-Saves (613 MB, 1,6 Mio. Objekte, mit Bun, Trockenläufe):

| Lauf | Zeit | RAM | Ergebnis |
|---|---|---|---|
| `remap-classes`, S+-Großlager auf das Vanilla-Lager (3 Zeilen: Lager, Inventar, Item) | 4,8 s | 4,1 GB | 79 Objekte, 65 Profile (Engramme), alle Kurznamen `verified` |
| `remove-classes --package CraftableTributeTerminal` | 10 s | 5,0 GB | 142 Terminals, 47 Items, 1.964 Objekte mit Inhalt, 993 Erstattungszeilen für 90 Stämme |
| `remove-classes --package DinoStorage2` | 10 s | 5,4 GB | 2.855 Objekte, darin 4.540 Tiere in Seelen, 2.113 Erstattungszeilen |
| `remove-classes --package StructuresPlusMod` | 11 s | – | 687 S+-Klassen im Save: 665 eindeutig (31.002 Objekte, mit Inhalt 82.906 entfernt), 22 auch im Kernspiel (4.795 Objekte bleiben stehen); 3.458 Bauteile verlieren ihren Halt |

Geschrieben (statt Trockenlauf) braucht ein Lauf auf Gen2 rund 20–26 s und 12,5 GB, weil der Befehl die neue Datei vollständig zurückliest und beide Stände auf Konsistenz prüft. Beim Umschreiben der S+-Lager blieben alle übrigen 1.607.407 Objekte byte-gleich. Zwei Läufe ergaben dieselbe Datei, und `edit verify` bestand auf beiden Ausgaben alle drei Wege.

**Für Programme** (das geplante Webinterface ruft die CLI auf):
- Eingabe: Die Mapping-Datei darf statt TSV ein JSON-Array mit denselben Schlüsseln sein, z. B. `[{"old_class": "…", "new_class": "…", "old_path": "…", "new_path": "…", "only_mod_package": "…"}]`. Fehler nennen dann die Position im Array.
- Ausgabe: Der Bericht steht als JSON auf stdout, mit `--report FILE` zusätzlich in einer Datei. `--refund FILE.json` schreibt die Erstattungsliste als JSON-Zeilen mit den CSV-Spaltennamen.
- Fehler: Exit-Code 1, mit `ARK_EXPORT_ERRORS=json` als `{"error": "…"}` auf stderr.

**Vor dem Einspielen** gehört jeder Lauf zuerst auf eine Testinstanz: Save laden, Log prüfen, `saveworld`, den neuen Save mit `ark-export` lesen und mit dem Bericht vergleichen.

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
- `tree.ts`, `writer.ts`, `nametable.ts`: verlustfreier Eigenschaftenbaum, Schreiber, Namenstabelle
- `savegame.ts`, `container.ts`, `cluster.ts`: Dateitypen
- `editor.ts`, `verify.ts`: `.ark` schreiben, Byte-Beweis, Konsistenz
- `world.ts`, `operations.ts`, `pattern.ts`: Auswahl, Besitz, Operationen, Bau-Vorlagen
- `classes.ts`, `removal.ts`, `embedded.ts`: Klassen umschreiben (Mapping, Herkunftsnachweis), Klassen entfernen mit Erstattungsliste, eingebettete Archive
- `inline.ts`: Objektgruppe aus einem `.ark` als Inline-Archiv (Form von Kryokapseln und Cluster-`DinoData`)
- `normalize.ts`: Schlüssel, Verweise, flüchtige Felder
- `snapshot.ts`, `history.ts`: Datenbanken
- `cli.ts`, `cluster-cli.ts`, `editor-cli.ts`: Befehle

## Offen

- Bedeutung der `.arktributetribe`-Zahlen. Eine davon sieht wie ein Unix-Zeitstempel aus.
- Bedeutung der zwei Vektorlisten nach jeder Spielerfigur, vermutlich letzte Positionen.
- Doppelt gespeicherte Bauteile: Das Spiel schreibt manche Actors zweimal unter demselben Namen (siehe [Spielstände ändern](#spielstände-ändern)). Offen ist, nach welcher Regel es das tut.
- Verlauf schneller machen: ein Durchlauf über beide nach Schlüssel sortierten Snapshots statt mehrerer SQL-Joins.
- Räumlicher Index (SQLite R*Tree) für Suchen nach Bewegungsmustern.
- ARK: Survival Ascended (anderes Save-Format).
- Cluster-Dateien, nur im Spiel auf einem Testcluster zu klären:
  - Wird ein angehängtes Item am Obelisken angezeigt und lässt es sich herunterladen?
  - Welche Zeit zählt beim Ablauf: `ExpirationTimeUTC` oder `UploadTime` + `TributeItemExpirationSeconds`? Und was bewirken 0 oder 4294967295?
  - Bedeutet `ItemQuantity` 1 ein Stück? Hochgeladene Blaupausen haben 0 und zusätzlich alle `bIsEngram`. `--blueprint-copy` setzt dagegen nur `bIsBlueprint`, wie bei einer Blaupause aus einer Kiste.
  - Wird `ItemDurability` auf das Maximum aus `ItemStatValues[2]` begrenzt, wird `ItemRating` neu berechnet, und was gilt für sehr hohe Werte (65535)?
  - Spielt `OwnerPlayerDataID` beim Herunterladen eine Rolle?
  - Wann liest und schreibt der Server die Datei? Kann er eine gerade eingespielte Änderung mit einem älteren Stand überschreiben, etwa wenn der Spieler gleichzeitig hochlädt?

- Spielstände ändern, im Spiel zu klären:
  - Lädt der Server einen geänderten Save und schreibt er ihn per `saveworld` unverändert weiter?
  - Halten verschobene Basen ihre Verbindungen (Stabilität, Strom, Wasser)?
  - Wie verhält sich `PickupAllowedBeforeNetworkTime` bei eingesetzten Vorlagen?
  - Lassen sich Bauteile mit gelöschten Nachbarn abreißen, und stürzen frei hängende Teile ein?
  - Nimmt das Spiel umgeschriebene Klassen an, deren Instanznamen noch das alte Präfix tragen (`BP_StorageLarge_C_12` als `StorageBox_Large_C`)?
  - Lädt es Kryokapseln mit geleertem Sattelplatz, und verwirft es Pfad-Verweise auf entfernte Klassen ohne Fehler?
  - Wie löst es einen Kurznamen auf, den Kernspiel und Mod beide führen (geladene Klassen oder Pfadtabelle)?
- Save-Version 10–11 schreiben (Stored-Data-Blöcke), ASA.

## Quellen und Lizenz

Das Wissen über das Save-Format stammt aus dem Quellcode MIT-lizenzierter Projekte:
- [ASV](https://github.com/miragedmuk/ASV) von MirageUK mit dem darin gepflegten [ArkSavegameToolkit](https://github.com/miragedmuk/ASV/tree/master/ArkSavegameToolkit) von Flachdachs
- dessen Vorlage [ark-savegame-toolkit](https://github.com/Qowyn/ark-savegame-toolkit) von Qowyn, der das Binärformat ursprünglich entschlüsselt hat

Der Code hier ist neu geschrieben. Lizenz: [MIT](LICENSE).

ARK: Survival Evolved ist eine Marke von Studio Wildcard. Dieses Projekt steht in keiner Verbindung dazu.
