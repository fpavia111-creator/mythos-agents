# Mythos Machine domain agents

> Diese Übersetzung wurde von Claude erstellt und noch nicht von Muttersprachlern geprüft. Bei Abweichungen gilt die [englische README](README.md).

Dreißig kleine MCP-Agenten. Jeder ist für **genau einen Geschäftsprozess** zuständig (eine Zugriffsprüfung, einen Bankabgleich, eine ERP-Migrationsprüfung, eine Erstattungsreklamation) und kann außerhalb davon nichts tun. Sie lesen die Dateien, die Sie ohnehin exportieren, schreiben Berichte auf Ihrem Rechner und warten auf eine namentlich genannte Person, bevor etwas Wichtiges geschieht.

MIT-Lizenz · Node 20 oder neuer · nur lokale Dateien · keine Zugangsdaten · keine Abhängigkeiten

## Ausprobieren

```bash
npx -y ladon-of-access demo        # Zugriffsprüfung mit fiktiven Daten
npx -y olympus-of-migration demo   # ERP-Migrationsbereitschaft mit fiktiven Daten
```

Jeder Agent hat eine `demo` mit fiktiven Dateien und einen MCP-Server (`npx -y <agent> mcp`) für Claude Desktop, Claude Code, Cursor und andere MCP-Hosts. Die Werkzeuge stehen in der README des jeweiligen Agenten.

## Die Agenten

**Finanzen und Rechnungswesen**

| Agent | Was er tut | Wartet auf eine Person vor |
|---|---|---|
| `olympus-of-migration` | Vergleicht Exporte aus Alt- und Neusystem (fehlende Datensätze, Summen, Saldenlisten nach Gesellschaft und Währung, Feldregeln) und schreibt einen Bericht zur Migrationsbereitschaft | der Freigabe des Produktivstarts (die er nie erteilt) |
| `penelope-of-recon` | Abgleich Bank gegen Hauptbuch aus CSV, Excel, CAMT.053, MT940, BAI2 oder OFX: vorgeschlagene Zuordnungen, Abstimmposten, Saldenabgleich, Monatsabschluss | dem Buchen einer Korrekturbuchung |
| `ananke-of-match` | Dreifachabgleich von Bestellungen, Wareneingängen und Rechnungen mit einer Ausnahmeliste | Buchen oder Zahlen (nie) |
| `praxidike-of-expenses` | Spesenabrechnungen und Belegtexte gegen Ihre schriftliche Richtlinie, mit belegten Befunden | der Erstattung; Zahlen ist gesperrt |
| `auxo-of-vendors` | W-9-Bereitschaft von US-Lieferanten, maskierte Steuernummern, doppelte Lieferanten und Anfrageentwürfe | dem Versand einer Anfrage; reicht nie etwas beim IRS ein |
| `hesperides-of-inventory` | Inventurdifferenzen mit Prüfungen zu Zeitpunkt, Mengeneinheit und Nachzählung, nach Wert sortiert | dem Buchen von Korrekturen |
| `urania-of-flux` | Vorstandsunterlagen aus festgeschriebenen Zahlen, mit belegten Kommentaren und einer Prüfung der Aussagen | Freigabe und Verteilung |
| `polyhymnia-of-grants` | Fristen, Budgetverlauf, Ergebnisse und Nachweise von Fördermitteln in einem Berichtsentwurf | der Einreichung |

**Zugriff, Sicherheit und IT**

| Agent | Was er tut | Wartet auf eine Person vor |
|---|---|---|
| `ladon-of-access` | Rezertifizierung von Zugriffsrechten für Personen, Agenten und Dienstkonten: Ausgeschiedene, veraltete und privilegierte Konten, Konflikte bei der Funktionstrennung, Prüfer, Fristen, Nachweispaket | dem Entzug von Zugriffen (den er nie selbst vornimmt) |
| `helios-of-seats` | Ungenutzte, inaktive, doppelte und zu hoch lizenzierte SaaS-Lizenzen mit geschätzter Einsparung und Verlängerungskalender | dem Entzug einer Lizenz |
| `eos-of-onboarding` | Onboarding-Checklisten für Mitarbeitende, Auftragnehmer und Kunden, mit Entwürfen für Zugriffsanfragen | dem Erteilen oder Entziehen von Zugriffen |
| `tiresias-of-drift` | Abweichungen bei Konfiguration und Schema über die Zeit, mit Risikostufen erklärt | dem Anwenden einer Korrektur in Produktion |
| `aegle-of-certificates` | Ablauf von TLS-Zertifikaten, Domains, Lizenzen und Versicherungsnachweisen von Lieferanten, mit Erinnerungsentwürfen | bezahlten Verlängerungen, Produktionsänderungen und Versand |
| `aeolus-of-mail` | Prüfung von SPF, DKIM, DMARC, MX, MTA-STS und TLS-RPT mit reinen Lese-Abfragen per DNS-over-HTTPS | DNS-Änderungen (die er nie vornimmt) |
| `nemesis-of-servers` | Statische Prüfung eines MCP- oder Code-Mode-Servers oder einer MCP-Konfiguration auf riskante Muster | dem Ausführen (nie) |

**Kunden, Lieferanten und Betrieb**

| Agent | Was er tut | Wartet auf eine Person vor |
|---|---|---|
| `soteria-of-refunds` | Erstattungen und Rückbuchungen gegen Ihre Richtlinie einordnen, mit Entwürfen für Nachweispakete | Geldbewegungen (nie) |
| `augeas-of-masters` | Doppelte Lieferanten und Artikel, Vorschau jeder Zusammenführung Feld für Feld, eine freigegebene Zusammenführung nach der anderen auf einer Kopie | jeder Zusammenführung; Zahlungen an Lieferanten sind ein Klick |
| `nausicaa-of-hygiene` | Pflege von Kontaktlisten: Unzustellbare, Rollenadressen, Dubletten, veraltete Datensätze, Einwilligung | Massenlöschungen |
| `eucleia-of-outreach` | Prüft Entwürfe für Kontaktaufnahmen: Sperrliste, Pflichtangaben in der Fußzeile, Versandfenster, Längen | dem Versand (nie) |
| `epeius-of-rfis` | Bau-RFIs und Freigabelisten gegen Ihr Plan- und Spezifikationsverzeichnis, mit RFI-Entwürfen, die Ihre Dokumente zitieren | dem Versand |
| `arethusa-of-flows` | Prüfung von n8n-, Zapier- und Make-Flows auf defekte und riskante Abläufe | dem Aktivieren oder Ändern produktiver Flows |

**Datenschutz, Web und Recht**

| Agent | Was er tut | Wartet auf eine Person vor |
|---|---|---|
| `macaria-of-erasure` | Löschanfragen: wo personenbezogene Daten liegen, und eine Checkliste | dem Löschen (er löscht nie selbst) |
| `britomartis-of-consent` | Cookie- und Drittanbieter-Inventar aus exportiertem HTML und HAR-Mitschnitten, verglichen mit Ihrer erklärten Richtlinie und Ihrem Banner | der Veröffentlichung; kein Consent-Manager und keine Aussage zur Einhaltung von DSGVO oder CCPA |
| `daphne-of-pages` | Defekte Links, SEO-Grundlagen und automatisierbare WCAG-Prüfungen an exportiertem HTML, mit Korrekturliste | der Veröffentlichung; kein Rechtsgutachten |
| `solon-of-clauses` | Vertragsklauseln gegen Ihr eigenes Playbook, mit Fundstellen und einer Problemliste für Ihre Anwälte | einem verbindlichen Versand; E-Signatur ist gesperrt; keine Rechtsberatung |
| `lycurgus-of-licenses` | Ihre schriftliche Lizenzrichtlinie auf npm-Abhängigkeiten angewendet, mit Bericht, CycloneDX-SBOM und SARIF | einem Release; keine Rechtsberatung |
| `eirene-of-controls` | Nachweisordner aus Audit-Logs der Agenten; Nachweis, keine Zertifizierung | der Übergabe an Prüfer |

**Agenten bauen und testen**

| Agent | Was er tut | Wartet auf eine Person vor |
|---|---|---|
| `mythos-agent-core` | Die gemeinsame Laufzeit: Manifest, Erlauben/Fragen/Sperren, Eingabeprüfung, Modi Review/Assist/Auto, Limits, Not-Aus, signiertes Audit-Log, Freigabeseite, Domänengedächtnis, Dateileser, MCP-Server | (die Regeln unten) |
| `agon-of-evals` | Private Evals für einen Prozess auf einem festgelegten Modell, mit Regressionsvergleich; ruft kein Modell auf | der Veröffentlichung von Ergebnissen |
| `echo-of-docs` | Abweichungen in der Dokumentation: README und SKILL.md gegen Werkzeugliste, Schemas und package.json, mit mechanischen Korrekturen als Kopien | der Veröffentlichung |
| `epimetheus-of-scripts` | Inventar von NetSuite-SuiteScripts und Risikobewertung für 2.1 | dem Deployment (nie) |

## Dateien und Sprachen

Die Agenten lesen CSV, TSV, durch Semikolon oder senkrechten Strich getrennten Text, Excel `.xlsx`, JSON und JSONL. Zwölf von ihnen erkennen 39 benannte Exporte an ihren Spalten (Okta, Microsoft Entra ID, Google Workspace, NetSuite, QuickBooks Online, Xero, Stripe, Shopify, Salesforce, Ramp, mehrere US-Banken und weitere). Zwei dieser Layouts wurden mit der Herstellerdokumentation abgeglichen; die übrigen wurden aus Kenntnis der Exporte geschrieben, und keines wurde mit einem echten Konto getestet.

Dateien aus den größten Softwaremärkten werden so gelesen, wie lokale Systeme sie schreiben: Spaltennamen auf Deutsch, Französisch, Spanisch, brasilianischem Portugiesisch, Italienisch, Japanisch, Chinesisch und Koreanisch; Dateien in Shift_JIS, GB18030, Big5, EUC-KR, Windows-1252 und UTF-16; Beträge wie `1.234,56`, `R$ 1.234,56` oder `1,200円`; Datumsangaben wie `14. November 2026` oder `2026年11月14日`; Namen mit Rechtsformen wie GmbH, AG, SARL oder 株式会社. Mit `--lang de` erscheinen die Freigabeseite, der Olympus-Bericht und die Ladon-Zusammenfassung samt Nachweisseite auf Deutsch; Ergebnisse, Codes und CSV-Dateien bleiben auf Englisch.

## Regeln, die jeder Agent befolgt

- Unbekannte Werkzeuge sind gesperrt. Die Standardentscheidung ist Sperren.
- **Auto** ist standardmäßig aus und wird pro Aktion eingeschaltet, mit Schritt- und Ausgabenlimits und einem Not-Aus.
- Produktivstart, Entzug von Zugriffen, Löschen personenbezogener Daten, Geldbewegungen, rechtsverbindliche Sendungen und Produktions-Deployments brauchen immer den Klick einer namentlich genannten Person, auch in Auto. Das gilt auch für Änderungen am Gedächtnis eines Agenten.
- Agenten mit Gedächtnis (Olympus und Ladon) nutzen nur Fakten, die eine namentlich genannte Person akzeptiert hat, sagen bei jedem Ergebnis, welche, und können nichts lernen, was eine Prüfung lockert.
- Jede Entscheidung landet in einem hash-verketteten JSONL-Audit-Log, signiert, wenn Sie einen Schlüssel angeben.
- Text aus Ihren Dateien gilt als Daten. Tabellenformeln, rohes HTML und `../` in IDs werden bei der Ausgabe entschärft, und Text, der sich an ein KI-Modell richtet („ignore previous instructions“), wird markiert. Die Markierung ist eine Heuristik, kein Filter.

## Was sie nicht sind

- Keine Live-Integrationen: Sie lesen exportierte Dateien und melden sich nie bei Ihren Systemen an.
- Keine Rechts-, Steuer-, Buchhaltungs- oder Prüfungsberatung und keine Zertifizierung.
- Nicht vollautonom: Die oben genannten Schritte warten immer auf eine Person.
- Keine Aussage über Gesetze, Steuerregeln oder Meldeformate eines Landes.

## Entwickeln

```bash
npm install
npm test
npm run hostile
npm run release:check
npm run bench
```

Neue Agenten: [docs/build-an-agent.md](docs/build-an-agent.md) (Englisch). Änderungen in 0.2.0: [UPGRADE-0.2.0.md](UPGRADE-0.2.0.md) (Englisch).

MIT © 2026 Kurt Francisco · <https://mythosmachines.com>
