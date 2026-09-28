# Somotex Service Portal

An installable web app (PWA) for the service centre. It covers:

- **Complaint registration.** Helpdesk executives register complaints with a guided questionnaire, record the customer's own words, and get likely causes as they type.
- **Dispatch and tracking.** Executives assign technicians and track each complaint through to closure, including target times, the customer call log and closure history.
- **Duplicate warnings.** The app warns when a complaint is already open for the same customer or unit, and flags repeat visits.
- **Inventory.** Spares, refrigerants, brazing gases, nitrogen and consumables, with a complete ledger, stock-sheet import and a reorder list.
- **Gas budgets.** Every job gets a budget for refrigerant, brazing gas, nitrogen and flushing solvent. Over-use is flagged, and a Gas Efficiency page shows where gas is being lost.
- **Printable job cards** for technicians, and **WhatsApp / SMS updates** to customers.
- **Customer links.** The customer follows their complaint's progress and rates the service from a link in the WhatsApp message.
- **Insights** for management, such as:
  - where gas leaks
  - which in-house models and batches fail
  - the effect of bad power
  - how much refrigerant to stock
  - branch, technician and customer comparisons
- **Tools and part returns.** Tools are tracked with their calibration dates, and defective parts are followed back to Lagos for warranty claims.

Brands include Midea (commercial AC / VRF), Sharp, Beko, AUX and Chigo, plus the in-house brands **Tamashi** and **Bruhm**.

## Who uses it

| Role | Can do |
| --- | --- |
| **Service Head** | Everything. Also: manage user accounts, settings and gas norms, technicians, the item catalogue and costs, stock sheet imports, stock counts, reviewing gas alerts, re-opening or cancelling complaints. |
| **Helpdesk Executive** | Register, update and close **any** complaint at any branch (including other executives'), assign technicians, log customer calls, issue and return stock, receive deliveries, print job cards, view reports. |

Everyone signs in with their **own email and password**. The server records who logged and who closed each complaint, with their email address, from the signed-in account, so it can't be typed in by someone else. The same applies to every timeline entry and stock movement.

## Going live (shared between computers)

The app is hosted on **Vercel** (or Netlify). Shared data and logins live in **Supabase** (PostgreSQL). Both have free tiers that are enough for a service centre.

### 1. Create the database (Supabase)

1. Sign up at [supabase.com](https://supabase.com) and create a new project. Pick the region closest to you, and keep the database password somewhere safe.
2. Open **SQL Editor → New query**, paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and click **Run**.
3. Open **Authentication → Sign In / Providers**:
   - Turn **off** "Allow new users to sign up". Only the Service Head creates accounts.
   - Keep **Email** enabled.
4. Open **Project Settings → API** and copy the **Project URL** and the **anon public** key.

### 2. Publish the app (Vercel)

1. At [vercel.com](https://vercel.com), choose **Add New → Project** and import this repository.
2. Under **Environment Variables**, add:
   - `VITE_SUPABASE_URL`: the Project URL
   - `VITE_SUPABASE_ANON_KEY`: the anon public key
3. Click **Deploy**. You get an address like `somotex-service.vercel.app`, and you can add your own domain later.

On Netlify it's the same: import the repository, then add both variables under **Site configuration → Environment variables**.

### 3. First sign-in

1. Open the app address. The first screen is **First-time setup**: the Service Head creates their own account. Do this straight away. Until it's done, anyone who opens the address could claim the Service Head account.
2. The Service Head opens **Users** and adds each helpdesk executive with their name and email. The app gives each one a temporary password, and they choose their own password at first sign-in.
3. The Service Head:
   - adds **Technicians**
   - imports stock sheets under **Inventory → Import stock sheet**
   - sets unit costs
   - reviews **Settings** (company name, branches, currency, dialling code, target times, gas norms)
4. On each computer, open the address in Chrome or Edge and choose **Install app**, so it opens like a normal program.

**Trying it out first:** the Service Head can use **Settings → Data & backup → Load demo data**. It adds about two months of sample customers, complaints, stock, gas use, tools and part returns, plus a year of refrigerant supply history, so the reports, insights and alerts have something to show. **Remove demo data** takes it all out again, on every computer, and leaves anything real untouched. Remove it before real use; ticket numbers then restart from 1.

**Forgotten password:** the Service Head uses **Users → Reset password** and gives the person the new temporary password.

**Leaving staff:** use **Disable**. They can no longer sign in or see any data, and their past entries keep their name.

Supabase's free tier pauses a project after a week without any use. Normal daily use keeps it awake; a paused project can be restored from the Supabase dashboard.

## How the data works

- **Each computer keeps a copy of the data**, so screens open instantly and work continues if the internet drops. Changes made offline are uploaded when the connection returns. The sidebar shows the sync status.
- **Changes appear on the other computers within seconds**, and at the latest within a minute.
- **Ticket numbers** (e.g. `SMX-2026-00042`) are assigned by the server, so two computers never issue the same number. A complaint registered offline shows a temporary `TMP-…` number until it reaches the server.
- **Stock levels** are calculated from the shared stock ledger. If two computers issue the last of an item at the same time, the server refuses the second issue. It then appears under **Settings → Sync** for review.
- If two people edit the same complaint at the same moment, the last save wins. Every action is also kept in the complaint's timeline.

Without the two environment variables, the app runs in **single-device mode**: accounts and data live only in that browser. This is useful for trying it out; use **Settings → Data & backup** for backups in that mode.

## Daily use

### New complaint

1. Find the customer by name or phone, or enter a new one.
2. Record the product. Capacity, refrigerant and nameplate charge make the gas budget accurate.
3. Type what the customer says and answer the questions for that product.

As you answer:
- Likely causes appear, with what the technician should check and what to carry.
- Safety issues, such as a gas smell at a cooker, raise the priority and show advice to read to the customer.
- If a complaint is already open for the same phone number or serial number, it's shown with who logged it. Registering another one needs a deliberate tick.
- If the unit was closed within the last 30 days, the app flags a likely repeat visit.

### On the complaint page

- Assign a technician and print the **Job card**.
- Send the customer a **WhatsApp or SMS** update from a template.
- Log customer calls.
- Issue gas and spares against the job's budget. Going over the budget requires a reason.
- Record the job details, the confirmed cause and the resolution, then close the complaint.

### Visit schedule

**Booking visits**
- When assigning a technician, book the visit's **date and slot** (morning, afternoon or evening). You can do this on the complaint page or under **Schedule → Open jobs without a visit**.
- Moving a visit is logged with the reason.

**The Schedule page**
- Shows the day per technician, filtered by branch.
- Sends each customer a **WhatsApp reminder**.
- Can print the day plan for the technicians.
- Lists **missed visits**: the slot has passed and the job hasn't started.

### Branch requests (Lagos store to branches)

All stock is held in Lagos. A branch that needs parts or gas for a job uses **Request from Lagos** on the complaint, or **Branch requests → New request**.
1. The **Service Head approves** or rejects the request.
2. **Lagos dispatches** it with a waybill and carrier. The stock leaves Lagos at this point and is booked to the job, so its gas budget includes it.
3. The **branch marks it received**.

While parts are on their way, the job shows **Awaiting Parts**. It returns to **In Progress** when everything has arrived.

### Gas cylinders (weigh-out / weigh-in)

**Setting up:** register each cylinder with its tag.
- Refrigerant, LPG and MAPP cylinders are tracked by **weight**; enter the tare weight.
- Oxygen and nitrogen cylinders are tracked by **pressure**; enter the water capacity in litres.

**Using them:** on a job, or under **Cylinders**, the store **weighs the cylinder out** to the technician and **weighs it in** on return. The difference is booked to the job as the gas actually used, so budgets and alerts work on real figures.

**The app also flags:**
- **Gas lost in the store:** a cylinder weighs less at weigh-out than when it was last weighed in. This is recorded as a loss.
- **Cylinders out more than 48 hours.**

Refills and retiring a cylinder are recorded too.

### Typical nameplate charges

For 1, 1.5 and 2 HP wall splits (9,000, 12,000 and 18,000 BTU/h), the app uses a table of typical factory charges when the nameplate charge isn't known. The table covers R-32, R-410A and R-22, inverter and non-inverter.
- The complaint form shows the typical figure and can fill it in.
- The figures are **tentative**. Replace them with the charges on your units' labels under **Settings → Gas norms**.

### Customer status and rating links

In shared mode, every complaint gets a private link. The **Send customer update** messages include it:
- **Registered, assigned, awaiting parts:** the customer sees the progress of their complaint, the technician's first name and the booked visit. They see nothing else: no phone numbers, addresses or internal notes.
- **Job completed:** the customer rates the service from 1 to 5 stars and can add a comment. The rating appears on the complaint and in the reports, marked "from the customer". Staff can't change it afterwards.

"Copy tracking link" and "Copy rating link" on the complaint page give the links on their own, for example to paste into an SMS.

### Escalation

Complaints that are past their target time, or are logged as Critical, appear at the top of the dashboard under **Escalate to the Service Head**.
- One click sends them to the Service Head by WhatsApp or email, as a single message that includes links to each complaint. Each complaint is escalated once.
- Set the Service Head's number and email, the delay and which priorities to escalate under **Settings → General → Escalation**.
- The Service Head can also turn on **desktop alerts** under **Settings → My account**.

The app opens WhatsApp or the mail program with the message ready; someone still clicks Send. Fully automatic sending needs a messaging service (for example the WhatsApp Business API or an email service), which can be added later.

### Tools

Register each vacuum pump, gauge set, charging scale, recovery machine and brazing kit under **Tools**, with its tag and calibration interval.
- **Issue** a tool to a technician and mark it **returned**. Tools out for more than 7 days are flagged.
- **Calibration:** record each calibration; the next due date follows from the interval. A tool overdue for calibration needs a reason to be issued.
- **Charging scales:** a scale overdue for calibration is highlighted, because every gas weight taken with it is suspect.
- **Repairs and retirement** are recorded in each tool's history.

### Defective part returns

When a part is replaced under warranty, register the old part on the complaint (**Defective part return**). It is then followed through these stages:
1. At site
2. With the technician
3. At the branch
4. In transit to Lagos, with the waybill
5. Received in Lagos
6. Sent to the principal, with the claim/RMA number (or scrapped, with a reason)

Parts not in Lagos within 14 days are flagged. The **Part returns** page lists what is ready to claim from each brand.

### Insights

The **Insights** page turns the complaint history into management information:

| Insight | What it shows |
| --- | --- |
| Gas leak hotspots | Leak repairs and top-ups by where the leak was (flare nut, coil, service valve…), by model, and units that keep losing gas. Record "Leak found at" in Job & closure. |
| In-house brand quality | Failures of Tamashi and Bruhm (or any brand) by model, part replaced and serial-number batch, with months from sale to first failure and failures within 6 months. Evidence for the factory or supplier. |
| Power-related failures | PCB, power supply and compressor failures by area. Shows the effect of stabilisers, bad voltage and generator use, and lists in-warranty failures with power conditions outside the warranty. Record the voltage, stabiliser and power source in Job & closure. |
| Refrigerant forecast | Refrigerant leaving Lagos each month, and the next three months' likely need and what to order. With a year of history it uses last year's months and the recent trend; before that, the recent rate and the typical Nigerian season (peak February to May). |
| Branch scorecard | For each branch: time to resolve, share within target, first-time fix, repeat visits, gas used against budget, customer rating and material cost per job. |
| Technician gas ranking | Refrigerant used against each job's budget. The budget allows for unit size, job type and pipe length, so the comparison is fair. |
| Repeat customers | Customers with many complaints, flagging units that keep failing (check the installation), failures soon after installation, and AMC candidates. |

### Warranty

The Service Head sets **warranty periods** under **Settings → General**. The most specific rule applies:
1. brand and product
2. brand only
3. product only
4. the general rule

A rule can also carry a longer **compressor** period.

When the executive enters the **invoice date**, the complaint shows "In warranty until …" or "expired …", with compressor cover shown separately. If the customer finds the invoice later, add it on the complaint page and the status updates. AMC contracts can be set by hand. The job form hints whether to charge.

Reports show warranty jobs and their material cost by brand. For principal brands this is what can be claimed back; for in-house brands it is the warranty cost to the company.

### Other pages

- **Alerts:** gas used above budget, the wrong refrigerant, gas used with no matching activity, and units charged repeatedly. The Service Head reviews each alert.
- **Gas efficiency:** actual vs budget and the cost of excess, by gas, technician, job type and brand, with savings advice.
- **Reports:** closures, time to resolve, share resolved within target, ratings, technician performance (including jobs that came back within 30 days), in-house brand failures by model, and a CSV export that includes who logged and who closed each complaint.
- **Inventory → Reorder list:** items to order, with suggested quantities based on the last 30 days' use.

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

### Brazing gases, nitrogen and flushing solvent

These are budgeted per activity recorded on the job:

| Gas | Budgeted per | Counts when |
| --- | --- | --- |
| Oxygen + Acetylene | brazed joint | brazing method is **Oxy-Acetylene** |
| LPG / Butane | brazed joint | brazing method is **LPG / Butane** |
| MAPP | brazed joint | brazing method is **MAPP** |
| Nitrogen | brazed joint (purge), pressure test (+ per kW), metre flushed | purging, pressure test or flushing is recorded |
| Flushing solvent | metre flushed | flushing is recorded |

The starting norms are estimates. The Service Head should tune them under **Settings → Gas norms** and on each gas item.

## Development

```bash
npm install
npm run dev               # development server (single-device mode unless .env.local is set; see .env.example)
npm test                  # unit, data-layer, sync and login tests
npm run build             # production build in dist/
supabase/tests/run.sh     # database schema tests (needs a local PostgreSQL; see the script)
```

The GitHub Actions workflow runs the app tests, the build and the database tests on every push. Vercel publishes `main`.

## Project layout

| Path | Contents |
| --- | --- |
| `supabase/schema.sql` | Shared database: tables, access rules by role, ticket numbering, stock checks, staff account functions |
| `supabase/tests/` | Database tests run against plain PostgreSQL with a Supabase stand-in |
| `src/cloud/sync.ts` | Sync between the device copy and the server |
| `src/auth/` | Sign-in (shared or single-device), setup and password screens |
| `src/lib/consumption.ts` | Gas budget and alert engine |
| `src/lib/diagnosis.ts` | Questionnaires and cause suggestions |
| `src/db/` | Device database, data operations, settings, accounts, seed and demo data |
| `src/pages/` | Screens, each loaded on demand |
