# Somotex Service Portal

An installable, offline-first web app (PWA) for the service centre. It covers:

- **Complaint registration.** The helpdesk records the caller, what the customer said in their own words, and their preferred visit time.
- **Guided questionnaire.** Each product type has its own questions, and the app suggests likely causes as they're answered.
- **Complaint tracking.** Technician assignment, status timeline, target resolution times, customer call log and closure history.
- **Inventory.** Spares, refrigerants, brazing gases, nitrogen and consumables, with a full stock ledger and stock-sheet import.
- **Gas consumption control.** Every job gets a budget for refrigerant, brazing gas, nitrogen and flushing solvent. Over-use is flagged, and a Gas Efficiency page shows where gas is being lost.

Brands include Midea (commercial AC / VRF), Sharp, Beko, AUX and Chigo, plus the in-house brands **Tamashi** and **Bruhm**.

## Running it

```bash
npm install
npm run dev        # development server
npm test           # unit tests
npm run build      # production build in dist/
npm run preview    # serve the production build
```

Open the app in Chrome or Edge and use **Install app** (or **Add to Home screen** on Android or iOS). After the first load it works without an internet connection.

### Hosting

Pushes to `main` are tested, built and published to GitHub Pages by `.github/workflows/deploy.yml`. To turn it on, go to **Settings → Pages → Source: GitHub Actions**. The build uses relative paths, so any static host works: copy `dist/` onto it.

## Where the data lives

All data is stored **on the device** in the browser's IndexedDB, so the app is fast and works offline. As a result, each device has its own data. Use **Settings → Data & backup** to download a backup regularly and to restore it.

To share one live dataset between the helpdesk, technicians and the store, add a server database such as PostgreSQL. All reads and writes go through `src/db/service.ts`, so that file is the place to connect a sync or API layer.

## First-time setup

1. **Settings → General:** enter your name. It is recorded against every entry you make. Also check the currency, brands and target times.
2. **Technicians:** add the team.
3. **Inventory → Import stock sheet:** upload your spare parts and gas stock lists as CSV, starting from **Download template**.
   - Columns are matched by name. Headings like *Part No, Description, UOM, Qty, Min Stock, Rate, Model, Bin* work.
   - Refrigerants, brazing gases (and their method), nitrogen and flushing solvent are recognised from the item name.
4. **Inventory → item → Edit:** set unit costs, so excess gas shows as money. Review the per-activity norms for brazing gases, nitrogen and flushing solvent.
5. **Settings → Gas norms:** adjust the refrigerant charge norms and job-type factors to your own experience.

To try it out first, use **Settings → Data & backup → Load demo data**.

## How gas budgets work

### Refrigerant

Supported refrigerants are R-22, R-134a, R-410A, R-32, R-600a and R-290 (plus R-407C).

**Full system charge.** This comes from the nameplate charge if it was entered. Otherwise it is estimated from:
- capacity × g/kW for air conditioners (BTU/h, TR, kW and HP are converted), or
- volume × g/L for fridges and freezers.

**Job budget:**

```
budget = full charge × job-type share
       + extra pipe beyond the pre-charged length × g/m   (installation, leak repair, compressor or coil replacement)
       + hose / purge allowance
```

For example, a top-up is 35% of the full charge, a leak repair with full recharge is 100%, and a PCB repair is 0%.

### Brazing gases, nitrogen and flushing solvent

These are budgeted per activity that is recorded on the job:

| Gas | Budgeted per | Counts when |
| --- | --- | --- |
| Oxygen + Acetylene | brazed joint | brazing method is **Oxy-Acetylene** |
| LPG / Butane | brazed joint | brazing method is **LPG / Butane** |
| MAPP | brazed joint | brazing method is **MAPP** |
| Nitrogen | brazed joint (purge), pressure test (+ per kW), metre flushed | purging, pressure test or flushing is recorded |
| Flushing solvent | metre flushed | flushing is recorded |

### Enforcement and alerts

**At the store counter**, the job screen shows the budget for each gas.
- Issuing beyond budget + tolerance (default 15%) requires a written reason.
- Unused gas returned to the store is credited back to the job.

**Alerts** are raised automatically, and a supervisor reviews each one with a note. The app raises them for:
- use above budget: a warning above the tolerance, critical above 40%
- the wrong refrigerant for the unit
- gas used where the job records no matching activity, such as acetylene on an LPG-brazed job, or refrigerant on a PCB repair
- the same serial number re-charged within 90 days, which points to a leak that wasn't fixed

**The Gas Efficiency page** shows:
- actual vs budget and the cost of excess, by gas, technician, job type and brand
- the jobs furthest over budget
- units that were charged repeatedly
- savings advice generated from the data, such as a high share of top-ups, low refrigerant recovery or brazing gas over the per-joint norm

## Helpdesk questionnaire

There are question sets for air conditioners (split, commercial, VRF, chiller), fridges and freezers, washing machines, TVs, gas cookers and microwaves.

As the executive fills in answers and types what the customer says, the app:
- ranks likely causes, with what the technician should check and which spares and gas to carry
- suggests things the customer can safely try on the call
- raises the priority for safety issues, with advice to read to the customer (for example, a gas smell at a cooker)

At closure the technician picks the **confirmed cause**. Causes confirmed on earlier jobs rank higher in later suggestions. The rules live in `src/lib/diagnosis.ts` and are plain data, so they are easy to extend.

## Project layout

| Path | Contents |
| --- | --- |
| `src/lib/consumption.ts` | Gas budget and alert engine (pure functions, unit tested) |
| `src/lib/diagnosis.ts` | Questionnaires and cause suggestions |
| `src/lib/csv.ts` | CSV parsing, export and stock-sheet mapping |
| `src/db/` | Database schema (Dexie / IndexedDB), data operations, settings, seed and demo data |
| `src/pages/` | Screens, each loaded on demand |
| `src/__tests__/` | Unit and data-layer tests |
