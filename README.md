# ioBroker.licht-gruppen

Verbindet **Schalter** (z. B. Sonoff M5 Matter über `matter.0`) mit **Lampen** (z. B. Govee H60A4/H1250 über [ioBroker.govee-smart](https://github.com/krobipd/ioBroker.govee-smart)) in frei wählbaren **Gruppen** – typischerweise eine Gruppe je Raum.  
Die Geräte werden mit ihrem **Klartext-Namen** eingetragen – so, wie er im Objektbaum der Quell-Adapter steht, oder mit einem eigenen Namen aus der Tabelle **Gerätenamen**. Aufbau, Tabelle und Import/Export entsprechen [ioBroker.ecoflow-gruppen](https://github.com/lars752/ioBroker.ecoflow-gruppen).

## Funktionen

- **Gruppen frei konfigurierbar:** Tabelle mit *Gruppe* und *Gerät (Klartext)*. Das Gerät wird aus einem Dropdown gewählt (oder von Hand eingetragen). Ob es Schalter oder Lampe ist, ergibt sich aus der Instanz.
- **Beliebig viele Schalter und Lampen je Gruppe**, ein Gerät darf auch in mehreren Gruppen stehen.
- **Doppelschalter:** Jeder Kanal erscheint als eigenes Gerät, z. B. `Flur Doppelschalter – Kanal 1` und `… – Kanal 2`, und kann einer anderen Gruppe zugeordnet werden.
- **Schalter-Modus:** Zustand des Schalters = Zustand der Gruppe; weitere Schalter der Gruppe werden nachgeführt.
- **Taster-Modus:** Jede Zustandsänderung des Schalters schaltet die Gruppe um.
- **Rückmeldung (abschaltbar):** Wird eine Lampe z. B. über die Govee-App geschaltet, folgen die Schalter („mindestens eine Lampe an“ = an). Eine Sperrzeit nach eigenen Befehlen verhindert Flackern.
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

1. **Schalter-Instanzen** (`matter.0`) und **Lampen-Instanzen** (`govee-smart.0`) eintragen, **speichern**. Die Instanz startet.
2. Optional, Reiter **Gerätenamen**: einzelnen Geräten einen eigenen Klartext-Namen geben. Normalerweise nicht nötig, die Namen kommen aus der Govee-App bzw. aus matter.0.
3. Instanz-Einstellungen erneut öffnen. Entweder **„Alle Geräte der Instanzen in die Tabelle einlesen“** (alle erkannten Geräte landen ohne Gruppe in der Tabelle) oder Zeilen von Hand anlegen und das Gerät im Dropdown wählen.
4. Je Zeile die **Gruppe** eintragen (z. B. `Wohnzimmer`; erlaubt: A–Z, 0–9, `_`, `-`). Zeilen ohne Gruppe werden ignoriert.
5. Speichern. Im Log (Stufe debug) steht für jedes erkannte Gerät, welcher Datenpunkt verwendet wird.

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
| Schalter-Instanzen | `matter.0` | kommagetrennt |
| Lampen-Instanzen | `govee-smart.0` | kommagetrennt |
| Verhalten der Schalter | Schalter | Schalter (Zustand) oder Taster (jede Änderung schaltet um) |
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
    "switchAdapters": "matter.0",
    "lampAdapters": "govee-smart.0",
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
