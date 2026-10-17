# Riorganizzazione Controlli Visualizzatore PDF: Paginazione Fluttuante in Basso & Pulsante Indice Dedicato

Riorganizzazione dell'esperienza di lettura del visualizzatore PDF per eliminare i controlli di zoom ridondanti, posizionare la paginazione in basso a portata di pollice/mouse, e inserire nella toolbar superiore un pulsante rapido per saltare all'indice del documento.

### User Review & Critical Decisions

> [!IMPORTANT]
> **Rilevamento della pagina dell'Indice**:
> Il pulsante **"Indice"** nella barra superiore punterà di default a **pagina 2** (come richiesto, tipica pagina del sommario nelle dispense universitarie), ma se il documento PDF contiene un indice nativo (Outline/Bookmarks) con un capitolo "Indice" o "Sommario", il sistema salterà con precisione chirurgica alla pagina esatta rilevata dall'Outline. Se il PDF ha 1 sola pagina, rimane a pagina 1.

---

### 1. Overview & Core Concept

- **Cosa fa**: Ridisegna l'interfaccia del visualizzatore PDF rimuovendo del tutto i pulsanti di zoom e riallocando lo spazio per massimizzare la leggibilità e l'ergonomia.
- **Esperienza Utente**:
  - **In basso al centro**: Una barra fluttuante compatta ed elegante contenente esclusivamente i controlli di navigazione tra le pagine: `[ ◀ ]` `[ Pagina ]` `/` `[ Totale ]` `[ ▶ ]`.
  - **In alto a destra**: La toolbar superiore conterrà il pulsante rapido **"📑 Indice"** (che riporta subito alla pagina del sommario) e il toggle della **Modalità Notturna**.
  - **Zero ingombro da zoom**: Eliminati tutti i tasti zoom (zoom in, zoom out, adatta larghezza). La pagina si adatta sempre automaticamente alla larghezza dello schermo (sia su smartphone che su tablet e desktop), e su dispositivi touch resta disponibile il pinch-to-zoom naturale.

---

### 2. User Experience & Visual Design

#### Flusso di Navigazione
1. L'utente apre qualsiasi dispensa dalla griglia cliccando sulla card o su "Leggi PDF".
2. Il PDF si apre a schermo intero già ottimizzato e adattato al 100% della larghezza dello schermo.
3. In alto:
   - A sinistra: pulsante **← Indietro** con titolo del capitolo e nome del file.
   - A destra: nuovo pulsante **"📑 Indice"** e pulsante **Modalità Notturna**.
4. In basso al centro:
   - Barra fluttuante pill-shaped scura e trasparente (`backdrop-filter: blur`) con i pulsanti per cambiare pagina (`◀` e `▶`) e il contatore numerico modificabile.
5. Quando l'utente clicca su **"Indice"**:
   - Il visualizzatore salta direttamente a pagina 2 (o alla pagina del sommario del documento).
   - I titoli dell'indice restano cliccabili grazie all'AnnotationLayer già integrato per saltare direttamente alle singole lezioni/capitoli.

#### Schema della nuova interfaccia

```
┌────────────────────────────────────────────────────────────────────────┐
│  ← Indietro  │  Titolo Dispensa (Materia)             [📑 Indice]  [🌙] │  <-- Top Toolbar
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│                                                                        │
│                      [ FOGLIO PDF CENTRATO ]                           │
│                      Adattato a tutta larghezza                        │
│                                                                        │
│                                                                        │
│                       ┌──────────────────────┐                         │
│                       │  ◀   [ 2 ] / 45   ▶  │                         │  <-- Bottom Floating Bar
│                       └──────────────────────┘                         │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 3. Key Product Decisions & Trade-Offs

- **Rimozione totale dei tasti Zoom**:
  - *Decisione*: Rimossi sia i pulsanti zoom dalla toolbar che quelli dalla barra fluttuante.
  - *Motivazione*: L'auto-adattamento dinamico al 100% della larghezza garantisce sempre una lettura confortevole su qualsiasi schermo (telefono, tablet, PC), eliminando controlli superflui che occupavano spazio prezioso.
- **Paginazione in Basso al Centro**:
  - *Decisione*: Spostamento della paginazione in una barra fluttuante in basso.
  - *Motivazione*: Su smartphone e tablet i pollici raggiungono comodamente la parte inferiore dello schermo; su PC la barra rimane centrata e non invasiva.
- **Comportamento del pulsante "Indice"**:
  - *Decisione*: Cliccando "Indice", l'app chiama `goToPage(indexPageNumber)`. Se il documento ha un Outline con capitolo "Indice"/"Sommario"/"Table of Contents", usa quella pagina; altrimenti salta a pagina 2 (se il documento ha $\ge 2$ pagine).

---

### 4. Technical Architecture & Component Mapping

#### Componenti Modificati

1. **`index.html`**:
   - Rimuove i pulsanti `#btn-zoom-in`, `#btn-zoom-out`, `#btn-reset-zoom` e la classe `.viewer-zoom-group`.
   - Rimuove i pulsanti `#btn-zoom-out-float`, `#btn-reset-zoom-float`, `#btn-zoom-in-float`.
   - Nella `.pdf-viewer-toolbar`, rimuove i vecchi controlli di pagina e inserisce il pulsante `#btn-go-to-index` ("Indice" con icona segnalibro/elenco).
   - Crea il contenitore `#viewer-bottom-pagination` posizionato in basso con `#btn-prev-page`, `#page-input`, `#total-pages`, `#btn-next-page`.

2. **`style.css`**:
   - Rimuove le regole CSS associate ai controlli zoom rimossi.
   - Crea lo stile per `.viewer-bottom-pagination`: barra fluttuante pill ergonomica (`position: fixed; bottom: 1.25rem; left: 50%; transform: translateX(-50%)`).
   - Stile del pulsante `#btn-go-to-index` integrato nella toolbar superiore.

3. **`app.js`**:
   - Rimozione dei listener degli zoom rimossi.
   - Aggiunta della logica per determinare la pagina dell'indice all'apertura del PDF (ricerca "indice" / "sommario" nei bookmark o fallback a pagina 2).
   - Collegamento del click del pulsante `#btn-go-to-index` alla funzione `goToPage(indexPage)`.
