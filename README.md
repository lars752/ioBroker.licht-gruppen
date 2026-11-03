# ioBroker.licht-gruppen

Verbindet **Schalter** (z. B. Sonoff M5 Matter über `matter.0`) mit **Lampen** (z. B. Govee H60A4/H1250 über [ioBroker.govee-smart](https://github.com/krobipd/ioBroker.govee-smart)) in frei wählbaren **Gruppen** – typischerweise eine Gruppe je Raum.  
Die Geräte werden mit ihrem **Klartext-Namen** eingetragen – so, wie er im Objektbaum der Quell-Adapter steht, oder mit einem eigenen Namen aus der Tabelle **Gerätenamen**. Aufbau, Tabelle und Import/Export entsprechen [ioBroker.ecoflow-gruppen](https://github.com/lars752/ioBroker.ecoflow-gruppen).

## Funktionen

- **Instanzen per Auswahlliste:** Schalter- und Lampen-Instanzen werden aus den installierten Instanzen gewählt (Mehrfachauswahl), nichts muss getippt werden.
- **Gruppen vorbelegt aus Räumen:** Beim Einlesen der Geräte wird die Gruppe aus den ioBroker-Räumen (`enum.rooms.*`) oder aus einem Raumnamen im Gerätenamen (Küche, Flur, Badezimmer, Esszimmer …) eingetragen.
- **Gruppen frei konfigurierbar:** Tabelle mit *Gruppe* und *Gerät (Klartext)*. Das Gerät wird aus einem Dropdown gewählt (oder von Hand eingetragen). Ob es Schalter oder Lampe ist, ergibt sich aus der Instanz.
- **Beliebig viele Schalter und Lampen je Gruppe**, ein Gerät darf auch in mehreren Gruppen stehen.
- **Doppelschalter:** Jeder Kanal erscheint als eigenes Gerät, z. B. `Flur Doppelschalter – Kanal 1` und `… – Kanal 2`, und kann einer anderen Gruppe zugeordnet werden.
- **Schalter-Modus oder Taster-Modus**, dazu optional **Rückmeldung** der Lampen an die Schalter – Beschreibung im Abschnitt „Verhalten von Schalter, Taster und Lampen“.
- **Echo-Erkennung:** Bestätigungen der Geräte auf eigene Befehle lösen keine Kettenreaktion aus.
- **Lang-Druck dimmt:** ausgeschaltete Lampen starten bei 1 %, eingeschaltete bei ihrer aktuellen Helligkeit, und werden heller, bis der Schalter losgelassen wird (für Schalter mit Halte-Signal, siehe unten).
- **Helligkeit** je Gruppe und Lampe als schreibbarer Datenpunkt.
- **Eigene Klartext-Namen (optional)** für einzelne Geräte, zugeordnet über die stabile Datenpunkt-ID.
- **Eigene Datenpunkte** je Gruppe und Gerät, alle schreibbar – nutzbar für VIS, Skripte, Alexa usw.
- **Import / Export** der Konfiguration als JSON, **Aufräumen** nicht mehr konfigurierter Datenpunkte beim Start.

## Installation

1. ioBroker Admin → Adapter → Experten-Modus → „Adapter aus eigener URL installieren“:  
   `https://github.com/lars752/ioBroker.licht-gruppen`  
   Alternativ: `iobroker url https://github.com/lars752/ioBroker.licht-gruppen`
2. Instanz anlegen.

**Voraussetzungen:** Node.js ≥ 18, js-controller ≥ 5.0.19, Admin ≥ 6.12.2, laufende Schalter- und Lampen-Instanz.

## Einrichtung

1. **Schalter-Instanzen** (z. B. `matter.0`) und **Lampen-Instanzen** (z. B. `govee-smart.0`) aus der Auswahlliste wählen und **speichern**. Die Instanz startet; die Liste und das Einlesen funktionieren nur bei laufender Instanz.
2. Einstellungen erneut öffnen und **„Geräte einlesen und Gruppen vorbelegen“** drücken. Alle erkannten Schalter und Lampen landen in der Tabelle, die **Gruppe** ist aus dem Raum vorbelegt (siehe unten).
3. Tabelle prüfen: Gruppen ändern, Zeilen ohne Gruppe ausfüllen (sonst werden sie ignoriert), nicht benötigte Geräte löschen. Zeilen lassen sich auch von Hand anlegen, das Gerät wird im Dropdown gewählt. Erlaubt sind in Gruppennamen A–Z, 0–9, `_`, `-`.
4. Optional, Reiter **Gerätenamen**: einzelnen Geräten einen eigenen Klartext-Namen geben. Normalerweise nicht nötig, die Namen kommen aus der Govee-App bzw. aus matter.0.
5. Speichern. Im Log (Stufe debug) steht für jedes erkannte Gerät, welcher Datenpunkt verwendet wird.

### Gruppen aus Räumen vorbelegen

Beim Einlesen bekommt jedes Gerät eine Gruppe in dieser Reihenfolge:

1. **ioBroker-Räume:** Ist das Gerät, sein Kanal oder sein Datenpunkt Mitglied eines Raums (`enum.rooms.*`, im Admin unter „Aufzählungen“), wird der Raumname verwendet.
2. **Raumname im Gerätenamen:** Erkannt werden u. a. Wohnzimmer, Esszimmer, Küche, Badezimmer (auch „Bad“), WC, Schlafzimmer, Kinderzimmer, Gästezimmer, Arbeitszimmer (auch „Büro“), Flur (auch „Diele“, „Eingang“), Treppe, Keller, Dachboden, Hauswirtschaftsraum, Vorratsraum, Ankleide, Hobbyraum, Wintergarten, Terrasse, Balkon, Garage, Garten und Außen – auch als Wortanfang (`Flurlicht`, `Badezimmerlampe`).
3. Sonst bleibt die Gruppe leer.

Aus dem Raumnamen wird die Gruppen-ID gebildet: Umlaute werden ausgeschrieben, Leerzeichen werden zu `_` (`Küche` → `Kueche`, `Gäste Bad` → `Gaeste_Bad`). Bereits eingetragene Gruppen bleiben beim erneuten Einlesen unverändert; leere Gruppen bestehender Zeilen werden gefüllt. Die Vorbelegung ist ein Vorschlag – bei einem Doppelschalter, dessen Kanäle in verschiedene Räume gehören, die Gruppe von Hand ändern.

## Verhalten von Schalter, Taster und Lampen

**Schalter (Modus „Schalter“, Standard):** Die Stellung des Schalters bestimmt die Gruppe. Schalter an → alle Lampen der Gruppe an, Schalter aus → alle Lampen aus. Hat die Gruppe mehrere Schalter (Wechselschaltung), werden die übrigen Schalter auf denselben Zustand gestellt, damit alle gleich stehen. Geändert wird nur, wenn sich etwas ändert: Steht die Gruppe schon auf dem gewünschten Zustand, passiert nichts.

**Taster (Modus „Taster“):** Jede Betätigung (jeder Zustandswechsel des Geräts) schaltet die Gruppe um: aus → an, an → aus. Andere Schalter der Gruppe werden nicht nachgeführt, weil ihre Stellung dann keine Bedeutung hat. Dieser Modus passt auch für Wandschalter, die bei jedem Druck umschalten sollen, egal in welcher Stellung sie stehen. Beispiel: Die Lampen wurden per App eingeschaltet und die Rückmeldung ist aus; der Schalter steht noch auf aus. Im Modus „Schalter“ schaltet der nächste Druck den Schalter auf an, die Gruppe steht für den Adapter aber schon auf an – der erste Druck bleibt wirkungslos. Im Modus „Taster“ schaltet er die Gruppe aus.

**Taster mit kurz und lang** (Matter Generic Switch, Datenpunkte `PRESS` und `PRESS_LONG`, unabhängig vom Modus): kurz drücken schaltet die Gruppe um, lang drücken dimmt (siehe unten).

**Rückmeldung der Lampen** (Einstellung „Rückmeldung: Schalter folgen den Lampen“, Standard an): Wird eine Lampe außerhalb von ioBroker geschaltet, z. B. in der Govee-App, übernimmt die Gruppe den neuen Zustand:

| Zustand der Lampen | Gruppe gilt als | Schalter (Modus „Schalter“) |
|---|---|---|
| mindestens eine Lampe an | an | werden auf an gestellt |
| alle Lampen aus | aus | werden auf aus gestellt |

Im Modus „Taster“ wird nur der Gruppenzustand (`<gruppe>.on`) aktualisiert, die Schalter bleiben unberührt. Nach einem eigenen Schaltbefehl werden Meldungen der Lampen für die **Sperrzeit** (Standard 3 s) ignoriert, damit die Gruppe nicht flackert, während die Lampen nacheinander antworten. Bei ausgeschalteter Rückmeldung ändert eine von außen geschaltete Lampe weder Gruppe noch Schalter.

**Lampen** einer Gruppe werden immer gemeinsam geschaltet. Einzelne Lampen lassen sich über `<gruppe>.Lampe<n>.on` getrennt schalten.

Beispiel:

| Gruppe | Gerät (Klartext) |
|---|---|
| Wohnzimmer | Wohnzimmer Schalter |
| Wohnzimmer | Wohnzimmer Decke |
| Flur | Flur Doppelschalter – Kanal 1 |
| Flur | Flur Decke |
| Kueche | Flur Doppelschalter – Kanal 2 |
| Kueche | Küche Decke |

### Wie werden Geräte erkannt?

In jeder Instanz werden beschreibbare boolesche Datenpunkte gesucht, deren Rolle mit `switch` beginnt oder deren Name `on`, `onOff`, `power`, `state`, `switch` o. Ä. lautet. Je Ordner wird der beste Treffer genommen (`switch.light` vor `switch.power` vor `switch`). Der Klartext ist der Name des übergeordneten Geräts (`common.name`), bei mehreren Treffern je Gerät ergänzt um den Kanalnamen. Gleiche Namen in verschiedenen Instanzen werden um die Instanz ergänzt.

**Umbenennen:** Wird ein Gerät im Quell-Adapter umbenannt, passt der Eintrag nicht mehr. Der Adapter meldet das im Log und im Datenpunkt `info.missing`.

## Govee-Lampen (govee-smart)

In der govee-smart-Instanz das **Govee-Konto** (E-Mail/Passwort, optional API-Key) eintragen. Dann übernimmt govee-smart die **Namen aus der Govee-App** – genau diese Namen erscheinen in licht-gruppen im Dropdown, ein eigener Name ist nicht nötig. Zusätzlich in der Govee-Home-App bei den Lampen den **LAN-Modus** einschalten: govee-smart schaltet Ein/Aus und Helligkeit dann lokal mit sehr kurzer Reaktionszeit und erhält Zustandsänderungen sofort über das Govee-Konto.

## Lang-Druck: Dimmen

| Gruppe vorher | Lang drücken | Loslassen |
|---|---|---|
| aus | Helligkeit 1 % setzen, Lampen einschalten, dann stetig heller | erreichte Helligkeit bleibt |
| an | ab aktueller Helligkeit stetig heller | erreichte Helligkeit bleibt |

Bei 100 % endet das Dimmen von selbst. Fehlt die Meldung „losgelassen“, beendet eine Sicherung das Dimmen nach doppelter Dimmdauer + 5 s. Ein kurzer Druck schaltet die Gruppe um; bei Tastern mit Lang-Druck erst nach der Wartezeit (Standard 0,8 s), damit ein Lang-Druck nicht zusätzlich umschaltet.

**Voraussetzung: Der Schalter muss Drücken und Loslassen melden.** ioBroker.matter legt dafür bei Geräten mit Matter-„Generic Switch“ (Taster mit Lang-Druck) die Datenpunkte `PRESS` und `PRESS_LONG` an (`PRESS_LONG` = `true` beim Halten, `false` beim Loslassen). licht-gruppen erkennt sie automatisch – auch, wenn sie in einem eigenen Endpunkt neben dem Relais liegen. Beim Start steht im Log, für welche Schalter Dimmen aktiv ist.

**Sonoff M5 Matter:** Mit der Standard-Firmware meldet der M5 per Matter nach allen verfügbaren Tests nur Ein/Aus (Einfach-Klick), kein Halten/Loslassen. Ein reiner Ein/Aus-Zustand verrät nicht, wie lange gedrückt wurde – Dimmen per Lang-Druck ist mit diesen Schaltern dann nicht möglich; Ein/Aus funktioniert wie gewohnt. Liefert eine spätere Firmware einen Generic Switch, greift das Dimmen ohne Änderung an der Konfiguration (Instanz neu starten).

### Hinweis zu Sonoff M5 Matter und Smart-Lampen

Damit die Govee-Lampen dauerhaft Strom haben, darf das Relais des M5 die Lampen nicht abschalten (Lampe nicht über das Relais anschließen bzw. Relais-Entkopplung nutzen, falls das Gerät sie anbietet). Der Adapter wertet nur den Zustand des Schalters in `matter.0` aus.

## Konfiguration

| Einstellung | Standard | Bedeutung |
|---|---|---|
| Schalter-Instanzen | `matter.0` | Auswahlliste (Mehrfachauswahl) der installierten Instanzen |
| Lampen-Instanzen | `govee-smart.0` | Auswahlliste (Mehrfachauswahl) der installierten Instanzen |
| Verhalten der Schalter | Schalter | Schalter (Stellung bestimmt die Gruppe) oder Taster (jede Betätigung schaltet um) |
| Rückmeldung | an | Schalter folgen den Lampen |
| Sperrzeit | 3000 ms | Lampen-Rückmeldungen werden nach eigenem Befehl so lange ignoriert |
| Beim Start angleichen | aus | Schalter beim Start auf den Lampenzustand setzen |
| Aufräumen beim Start | an | nicht mehr konfigurierte Datenpunkte löschen |
| Schaltvorgänge im Log | aus | als `info` statt `debug` protokollieren |
| Start-Helligkeit | 1 % | Helligkeit beim Lang-Druck aus ausgeschaltetem Zustand |
| Dimmdauer | 4000 ms | Zeit von Start-Helligkeit bis 100 % |
| Abstand der Dimmschritte | 300 ms | kleiner = feiner, aber mehr Befehle |
| Wartezeit kurz/lang | 800 ms | Wartezeit auf einen möglichen Lang-Druck |
| Gerätenamen (eigener Reiter) | leer | optional: Gerät der Quelle (Datenpunkt-ID) → eigener Klartext-Name |

## Datenpunkte (`licht-gruppen.0.*`)

| Datenpunkt | Inhalt |
|---|---|
| `<gruppe>.on` | Gruppe an/aus (**schreibbar**: schaltet alle Lampen und führt die Schalter nach) |
| `<gruppe>.Schalter<n>.on` | Zustand des Schalters (**schreibbar**: nur dieses Gerät) |
| `<gruppe>.Lampe<n>.on` | Zustand der Lampe (**schreibbar**: nur dieses Gerät) |
| `<gruppe>.brightness` | Helligkeit der Gruppe in % (**schreibbar**: alle Lampen; 0 = aus; schaltet bei Bedarf ein) |
| `<gruppe>.Lampe<n>.brightness` | Helligkeit der Lampe in % (**schreibbar**) |
| `<gruppe>.Taster<n>` / `Schalter<n>.pressLong` | `true`, solange lang gedrückt wird |
| `<gruppe>.info.Count` | Anzahl Geräte der Gruppe |
| `<gruppe>.info.LampsOn` | Anzahl eingeschalteter Lampen |
| `info.connection` | `true`, wenn mindestens ein Gerät zugeordnet ist |
| `info.missing` | nicht gefundene Einträge (`Gruppe: Klartext`) |

Kanäle tragen den Klartext-Namen des Geräts. Namen `Schalter1`, `Lampe1` … werden je Gruppe in Tabellenreihenfolge vergeben – neue Geräte deshalb am Ende der Gruppe eintragen.

## Import / Export

Reiter **„Import / Export“**: Export schreibt die Konfiguration als JSON in das Textfeld, Import übernimmt eingefügtes JSON ins Formular (danach „Speichern und schließen“).

```json
{
  "adapter": "licht-gruppen",
  "version": 1,
  "config": {
    "switchAdapters": ["matter.0"],
    "lampAdapters": ["govee-smart.0"],
    "switchMode": "state",
    "lampFeedback": true,
    "syncOnStart": false,
    "lockMs": 3000,
    "pruneOnStart": true,
    "logActions": false,
    "devices": [
      { "group": "Wohnzimmer", "device": "Wohnzimmer Schalter" },
      { "group": "Wohnzimmer", "device": "Wohnzimmer Decke" }
    ],
    "names": [
      { "source": "govee-smart.0.devices.h60a4-1a2b.control.power", "name": "Wohnzimmer Decke" }
    ]
  }
}
```

## Entwicklung

```
npm install
npm test
```

## Changelog

### 1.3.0
- Schalter- und Lampen-Instanzen per Auswahlliste der installierten Instanzen (Mehrfachauswahl); kommagetrennter Text aus älteren Exporten wird weiter gelesen
- Einlesen belegt die Gruppe aus ioBroker-Räumen bzw. Raumnamen im Gerätenamen vor
- Beschreibung des Verhaltens von Schalter, Taster, Rückmeldung und Sperrzeit in den Einstellungen und im README
- Hinweise im Log, wenn eine gewählte Instanz nicht existiert

### 1.2.0
- Lang-Druck dimmt (Start bei 1 % bzw. aktueller Helligkeit, Loslassen hält den Wert) für Schalter mit Halte-Signal (Matter Generic Switch `PRESS_LONG`)
- Kurzer Druck auf Taster (`PRESS`) schaltet die Gruppe um
- Helligkeits-Datenpunkte je Gruppe und Lampe
- govee-smart darf wieder Govee-Konto/Cloud nutzen; LAN-Prüfung und `info.localOnly` entfernt, Gerätenamen-Tabelle nur noch optional

### 1.1.0
- Lampen-Quelle govee-smart im reinen LAN-Betrieb (Standard `govee-smart.0`)
- Neuer Reiter „Gerätenamen“: eigene Klartext-Namen je Gerät, Dropdown mit Quellname und IP-Adresse
- LAN-Prüfung der govee-smart-Instanz, Datenpunkt `info.localOnly`

### 1.0.0
- Erstveröffentlichung

## Lizenz

MIT, siehe [LICENSE](LICENSE).
