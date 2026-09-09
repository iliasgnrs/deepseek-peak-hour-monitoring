# DeepSeek Peak Hour Monitoring

Ένα VS Code extension που σας δείχνει **στη status bar** αν βρίσκεστε **εντός ή εκτός
DeepSeek peak hours** και **πότε τελειώνει το τρέχον peak**, με βάση το ρολόι του
υπολογιστή σας (η κατάταξη γίνεται πάντα σε **UTC**, όπως ορίζει το DeepSeek).

> **Τι είναι τα peak hours του DeepSeek** (default): Δευτέρα–Παρασκευή, **01:00–04:00**
> και **06:00–10:00 UTC**. Τις υπόλοιπες ώρες είστε **off-peak**.

## Χαρακτηριστικά

- 🟢/🔴 Ένδειξη στη **status bar**: `Off-peak` ή `Peak · τέλος 04:00 (σε ~45 λεπτά)`.
- ⏱️ **Αντίστροφη μέτρηση** για το πότε τελειώνει το τρέχον peak (ή πότε αρχίζει το επόμενο).
- 🔔 **Ειδοποιήσεις** όταν αλλάζει η κατάσταση και **λίγο πριν** την αλλαγή.
- 🛠️ **Πλήρως ρυθμιζόμενο** ωράριο (παράθυρα, ημέρες, ειδοποιήσεις).

## Εγκατάσταση (development / local)

1. Ανοίξτε το φάκελο του project στο VS Code.
2. Εγκαταστήστε τις εξαρτήσεις και μεταγλωττίστε:
   ```bash
   npm install
   npm run compile
   ```
3. Πατήστε **F5** (ή Run → Start Debugging) για να ανοίξει ένα
   *Extension Development Host* με το extension φορτωμένο.

Θα δείτε την ένδειξη αριστερά στη status bar. Πατώντας πάνω της ανοίγει ένα
παράθυρο με αναλυτική κατάσταση (τοπική ώρα + UTC + πότε αλλάζει).

## Ρυθμίσεις

Ανοίξτε τις ρυθμίσεις (`Ctrl+,`) και ψάξτε για `deepseekPeak` (ή χρησιμοποιήστε
την εντολή **DeepSeek Peak Hours: Ρυθμίσεις** από την Command Palette).

| Ρύθμιση | Τύπος | Default | Περιγραφή |
|---|---|---|---|
| `deepseekPeak.enabled` | boolean | `true` | Εμφάνιση/απόκρυψη ένδειξης στη status bar |
| `deepseekPeak.windowsUtc` | string[] | `["01:00-04:00", "06:00-10:00"]` | Παράθυρα peak σε **UTC**, μορφή `"HH:MM-HH:MM"` |
| `deepseekPeak.weekdays` | number[] | `[1,2,3,4,5]` | Ημέρες εβδομάδας (0=Κυρ … 6=Σάβ) |
| `deepseekPeak.notifyOnChange` | boolean | `true` | Ειδοποίηση όταν αλλάζει κατάσταση |
| `deepseekPeak.notifyMinutesBefore` | number | `10` | Λεπτά πριν την αλλαγή για προειδοποίηση (0=απενεργ.) |

### Παράδειγμα: αλλαγή ωραρίου

Αν π.χ. τα peak σας είναι 02:00–05:00 και 09:00–12:00 UTC, Σάβ-Κυρ:

```json
{
  "deepseekPeak.windowsUtc": ["02:00-05:00", "09:00-12:00"],
  "deepseekPeak.weekdays": [0, 6]
}
```

## Πώς λειτουργεί το «computer time»

Το extension χρησιμοποιεί το ρολόι του υπολογιστή σας, αλλά η **ταξινόμηση γίνεται σε
UTC** — έτσι ισχύει όπου κι αν βρίσκεστε. Οι ώρες που σας δείχνει (π.χ. «τέλος 04:00»)
μετατρέπονται στην **τοπική σας ζώνη** ώρας για ευκολία.

## Δομή

```
├── package.json      # metadata, commands, ρυθμίσεις
├── tsconfig.json
├── src/extension.ts  # όλη η λογική (peak math, status bar, notifications)
└── .vscode/          # debug (F5) + build task
```

## Άδεια

MIT
