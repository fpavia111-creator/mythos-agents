# Mythos Machine domain agents

> Questa traduzione è stata scritta da Claude e non è ancora stata rivista da madrelingua. In caso di differenze vale il [README in inglese](README.md).

Trenta piccoli agenti MCP. Ognuno si occupa di **un solo processo aziendale** (una revisione degli accessi, una riconciliazione bancaria, un controllo di migrazione ERP, una contestazione di rimborso) e non può agire al di fuori di esso. Leggono i file che già esportate, scrivono i report sul vostro computer e aspettano una persona indicata per nome prima di ogni passaggio importante.

Licenza MIT · Node 20 o successivo · solo file locali · nessuna credenziale · nessuna dipendenza

## Provatelo

```bash
npx -y ladon-of-access demo        # revisione degli accessi su dati fittizi
npx -y olympus-of-migration demo   # prontezza di una migrazione ERP su dati fittizi
```

Ogni agente ha una `demo` che gira su file fittizi e un server MCP (`npx -y <agent> mcp`) per Claude Desktop, Claude Code, Cursor e altri host MCP. Gli strumenti di ogni agente sono descritti nel suo README (in inglese).

## Gli agenti

**Finanza e contabilità**

| Agente | Che cosa fa | Aspetta una persona prima di |
|---|---|---|
| `olympus-of-migration` | Confronta le esportazioni del vecchio e del nuovo sistema (record mancanti, totali, bilanci di verifica per società e valuta, regole sui campi) e scrive un report di prontezza | approvare l'avvio in produzione (non lo fa mai) |
| `penelope-of-recon` | Riconciliazione tra banca e contabilità generale da CSV, Excel, CAMT.053, MT940, BAI2 o OFX: abbinamenti proposti, partite in riconciliazione, quadratura dei saldi, riporto di fine mese | registrare una scrittura di rettifica |
| `ananke-of-match` | Abbinamento a tre vie di ordini, ricevimenti e fatture passive, con un elenco di eccezioni | registrare o pagare (mai) |
| `praxidike-of-expenses` | Note spese e testi delle ricevute controllati secondo la vostra policy scritta, con rilievi citati | rimborsare; il pagamento è bloccato |
| `auxo-of-vendors` | Preparazione dei moduli W-9 dei fornitori statunitensi, codici fiscali mascherati, fornitori duplicati e bozze di richiesta | inviare una richiesta; non presenta mai nulla all'IRS |
| `hesperides-of-inventory` | Differenze di inventario a rotazione con controlli su data, unità di misura e riconteggio, ordinate per valore | registrare le rettifiche |
| `urania-of-flux` | Materiale per il consiglio da cifre chiuse, con commenti citati e un controllo delle affermazioni | l'approvazione e la distribuzione |
| `polyhymnia-of-grants` | Scadenze, andamento del budget, risultati e prove dei finanziamenti in una bozza di rendiconto | la presentazione |

**Accessi, sicurezza e IT**

| Agente | Che cosa fa | Aspetta una persona prima di |
|---|---|---|
| `ladon-of-access` | Ricertificazione degli accessi di persone, agenti e account di servizio: cessati, account inattivi e privilegiati, conflitti di separazione dei compiti, revisori, scadenze, pacchetto di prove | revocare un accesso (non lo fa mai) |
| `helios-of-seats` | Licenze SaaS inutilizzate, inattive, duplicate o di piano eccessivo, con risparmio stimato e calendario dei rinnovi | revocare una licenza |
| `eos-of-onboarding` | Checklist di inserimento per dipendenti, collaboratori e clienti, con bozze di richieste di accesso | concedere o revocare accessi |
| `tiresias-of-drift` | Variazioni di configurazione e di schema nel tempo, spiegate con livelli di rischio | applicare una correzione in produzione |
| `aegle-of-certificates` | Monitoraggio delle scadenze di certificati TLS, domini, licenze e certificati assicurativi dei fornitori, con bozze di sollecito | rinnovi a pagamento, modifiche in produzione e invii |
| `aeolus-of-mail` | Verifica di SPF, DKIM, DMARC, MX, MTA-STS e TLS-RPT con interrogazioni DNS-over-HTTPS in sola lettura | modificare il DNS (non lo fa mai) |
| `nemesis-of-servers` | Revisione statica di un server MCP o Code Mode, o di una configurazione MCP, alla ricerca di schemi rischiosi | eseguirlo (mai) |

**Clienti, fornitori e operazioni**

| Agente | Che cosa fa | Aspetta una persona prima di |
|---|---|---|
| `soteria-of-refunds` | Smistamento di rimborsi e chargeback secondo la vostra policy, con bozze di pacchetti di prove | muovere denaro (mai) |
| `augeas-of-masters` | Fornitori e articoli duplicati, anteprima di ogni unione campo per campo, un'unione approvata alla volta su una copia | ogni unione; pagare un fornitore richiede un clic |
| `nausicaa-of-hygiene` | Pulizia delle liste contatti: rimbalzi, indirizzi generici, duplicati, record vecchi, consenso | le cancellazioni massive |
| `eucleia-of-outreach` | Controllo delle bozze di contatto commerciale: lista di esclusione, dati a piè di pagina, fascia di invio, lunghezza | inviare (mai) |
| `epeius-of-rfis` | Registri di RFI e di approvazioni di cantiere confrontati con il vostro indice di tavole e capitolati, con bozze di RFI che citano i vostri documenti | l'invio |
| `arethusa-of-flows` | Verifica dei flussi n8n, Zapier e Make guasti o rischiosi | attivare o modificare flussi in produzione |

**Privacy, web e legale**

| Agente | Che cosa fa | Aspetta una persona prima di |
|---|---|---|
| `macaria-of-erasure` | Richieste di cancellazione: dove si trovano i dati personali e una checklist | cancellare (non cancella mai da solo) |
| `britomartis-of-consent` | Inventario di cookie e servizi di terze parti da HTML esportato e acquisizioni HAR, confrontato con la vostra policy e il vostro banner | pubblicare; non è uno strumento di gestione del consenso e non afferma la conformità al GDPR o al CCPA |
| `daphne-of-pages` | Link interrotti, basi SEO e controlli WCAG automatizzabili su HTML esportato, con un elenco di correzioni | pubblicare; non è un parere legale |
| `solon-of-clauses` | Clausole contrattuali controllate secondo il vostro manuale, con citazioni e un elenco di punti per i vostri legali | un invio vincolante; la firma elettronica è bloccata; non è consulenza legale |
| `lycurgus-of-licenses` | La vostra policy scritta sulle licenze applicata alle dipendenze npm, con report, SBOM CycloneDX e SARIF | una release; non è consulenza legale |
| `eirene-of-controls` | Cartella di prove dai log di audit degli agenti; prove, non una certificazione | inviarla a un revisore |

**Costruire e testare agenti**

| Agente | Che cosa fa | Aspetta una persona prima di |
|---|---|---|
| `mythos-agent-core` | Il motore comune: manifest, policy consenti/chiedi/blocca, validazione degli input, modalità Review/Assist/Auto, limiti, arresto di emergenza, log di audit firmato, pagina di approvazione, memoria di dominio, lettori di file, server MCP | (le regole qui sotto) |
| `agon-of-evals` | Valutazioni private di un processo su un modello fisso, con confronto delle regressioni; non chiama alcun modello | pubblicare i risultati |
| `echo-of-docs` | Disallineamenti della documentazione: README e SKILL.md confrontati con l'elenco degli strumenti, gli schemi e il package.json, con correzioni meccaniche come copie | pubblicare la documentazione |
| `epimetheus-of-scripts` | Inventario degli SuiteScript di NetSuite e classifica del rischio di migrazione a 2.1 | il deploy (mai) |

## File e lingue

Gli agenti leggono CSV, TSV, testo separato da punto e virgola o barra verticale, Excel `.xlsx`, JSON e JSONL. Dodici di loro riconoscono 39 esportazioni con nome dalle colonne (Okta, Microsoft Entra ID, Google Workspace, NetSuite, QuickBooks Online, Xero, Stripe, Shopify, Salesforce, Ramp, cinque banche statunitensi e altre). Due di questi formati sono stati verificati sulla documentazione del produttore; gli altri sono stati scritti a partire dalla conoscenza di quelle esportazioni, e nessuno è stato provato su un account reale.

I file dei sistemi italiani si leggono così come escono: nomi di colonna in italiano (`Importo`, `Fornitore`, `Partita IVA`, `Causale`, `Dare`, `Avere`, `Data di scadenza` e altri), file in Windows-1252 o UTF-16, importi come `1.234,56 €`, date come `14/11/2026` o `14 novembre 2026`, ragioni sociali con S.r.l., S.p.A., S.n.c. o S.a.s. Anche gli estratti conto CAMT.053 e MT940 vengono letti. Con `--lang it`, la pagina di approvazione, il report di prontezza di Olympus e il riepilogo di ricertificazione e la pagina delle prove di Ladon appaiono in italiano; risultati, codici e file CSV restano in inglese.

## Le regole che ogni agente segue

- Gli strumenti sconosciuti sono bloccati. La decisione predefinita è bloccare.
- **Auto** è spento per impostazione predefinita e si attiva azione per azione, con limiti di passaggi e di spesa e un arresto di emergenza.
- Avvio in produzione, revoca degli accessi, cancellazione di dati personali, movimenti di denaro, invii giuridicamente vincolanti e deploy in produzione richiedono sempre il clic di una persona indicata per nome, anche in Auto. Lo stesso vale per cambiare ciò che un agente ricorda.
- Gli agenti con memoria (Olympus e Ladon) usano solo fatti accettati da una persona indicata per nome, dicono quali fatti ha usato ogni risultato e non possono imparare nulla che allenti un controllo.
- Ogni decisione finisce in un log di audit JSONL concatenato tramite hash, firmato se fornite una chiave.
- Il testo dei vostri file è trattato come dato. Formule dei fogli di calcolo, HTML grezzo e `../` negli identificativi vengono neutralizzati in uscita, e un risultato che cita un testo rivolto a un modello di IA ("ignore previous instructions") viene segnalato. La segnalazione è un'euristica, non un filtro.

## Che cosa non sono

- Non sono integrazioni in tempo reale: leggono file esportati e non accedono mai ai vostri sistemi.
- Non sono consulenza legale, fiscale, contabile o di revisione, né certificano alcunché.
- Non sono del tutto autonomi: i passaggi sopra aspettano una persona, ogni volta.
- Nessuna affermazione su leggi, norme fiscali o formati di dichiarazione di alcun paese.

## Sviluppo

```bash
npm install
npm test
npm run hostile
npm run release:check
npm run bench
```

Creare un nuovo agente: [docs/build-an-agent.md](docs/build-an-agent.md) (in inglese). Le novità della 0.2.0: [UPGRADE-0.2.0.md](UPGRADE-0.2.0.md) (in inglese).

MIT © 2026 Kurt Francisco · <https://mythosmachines.com>
