# CartInspect Calculator — MASTER BRAIN

> **Ez a fájl a projekt „agya".** Minden beszélgetés eredménye, döntés, bugfix és fejlesztés ide kerül mentésre.
> Utolsó frissítés: 2026-03-10

---

## 1. Összefoglaló

Költségvetési hatáselemző kalkulátor **romániai önkormányzatok** számára. A felhasználó választ egy települést, és a rendszer kiszámolja a CartInspect ingatlanellenőrzés költség/megtérülés hatását. API proxy-n keresztül lekéri a helyi költségvetési adatokat (Transparenta.eu).

- **Élő URL:** `https://cartinspect-calculator-production.up.railway.app`
- **GitHub:** `https://github.com/VisoroGroup/Cartinspect-calculator.git` (branch: `main`)
- **Verzió:** 3.0.0

---

## 2. Tech Stack

| Réteg | Technológia |
|-------|------------|
| Frontend | Vanilla HTML + CSS + JS (single page, `index.html` — ~1900 sor) |
| Backend / Proxy | Node.js + Express (`proxy/server.js`) |
| Adat | `romania_uat.js` (település DB), `uat_data.js` (offline cache) |
| PDF | jsPDF (CDN) + Roboto font (base64, `roboto-fonts.js`) |
| Deploy | Railway (auto-deploy from GitHub `main`) |
| Dependencies | `express` ^4.18.2, `cors` ^2.8.5, `node-fetch` ^2.7.0 |

---

## 3. Fájlstruktúra

```
Cartinspect calculator/
├── index.html              ← Fő kalkulátor (single-page app, ~74KB)
├── proxy/
│   ├── server.js           ← Express API proxy → Transparenta.eu GraphQL
│   └── package.json        ← proxy dependencies
├── public/                 ← Railway által szolgált static fájlok
│   ├── index.html          ← (másolat a root index.html-ből)
│   ├── logo-01.png, favicon-*, apple-touch-icon.png
│   ├── romania_uat.js      ← települések adatbázisa
│   ├── uat_data.js         ← offline cache (adó + lakás adatok)
│   └── roboto-fonts.js     ← base64 Roboto betűtípusok PDF-hez
├── scripts/
│   ├── fetch-all-uat-data.js  ← UAT adatok letöltése (batch)
│   ├── retry-missing-uats.js  ← hiányzó adatok pótlása
│   └── retry-final.js         ← végső retry script
├── romania_uat.js          ← root-level település adatok
├── uat_data.js             ← root-level offline cache
├── roboto-fonts.js         ← root-level font
├── test_math.js            ← számítási logika tesztje
├── logo-01.png             ← Visoro logó
├── package.json            ← v3.0.0
├── PROJECT_INFO.md         ← régi projekt összefoglaló (legacy)
├── PROJECT_MASTER.md       ← ⭐ EZ A FÁJL — master brain
└── .gitignore
```

---

## 4. Számítási Motor (Business Logic)

### 4.1 MODEL konstansok

| Konstans | Érték | Jelentés |
|----------|-------|---------|
| `PRICE_PER_IMOBIL` | 130 RON | CartInspect ár per ingatlan |
| `TAX_INCREASE` | 1.6 (×) | +60% adóemelés (2026-os törvény) |
| `DISCOUNT_REMOVAL` | 1.25 (×) | Kedvezmény eltörlés (átlag ×1.25) |
| `CARTINSPECT_FACTOR` | 1.8 (×) | +80% CartInspect mérésből |
| `ASSUMED_COLLECTION` | 0.80 | Transparenta adat 80% begyűjtési rátát feltételez |
| `MAX_CONTRACT` | 270.000 RON | Közbeszerzési direkt limit (részletfizetésnél) |

### 4.2 Számítási folyamat

```
1. transparentaTotal ← Transparenta.eu API (impozit clădiri fizice, kód: 07.01.01)
2. totalHouses ← INS LOC101B dataset (SIRUTA alapján)
3. cityFactor = város/municipiu → 0.6, község → 0.5
4. effectiveHouses = totalHouses × cityFactor
5. minimumBase = effectiveHouses × 150
6. taxFactor = város/municipiu → 0.6, község → 1.0
7. baseValue = max(transparentaTotal × taxFactor, minimumBase)
8. potential100 = baseValue / 0.80
9. afterTaxIncrease = potential100 × 1.6
10. afterDiscountRemoval = afterTaxIncrease × 1.25
11. afterCartInspect = afterDiscountRemoval × 1.8 × rTarget
12. deltaYear = afterCartInspect − baseValue
13. delta10Y = deltaYear × 10
14. cost = totalHouses × 130   ← ÖSSZES ház ellenőrizve
15. ROI = (delta10Y − cost) / cost
16. paybackYears = cost / deltaYear
```

### 4.3 Fontos szabályok / Constraint-ek

- **Piros szám** (currentRevenue) = fix Transparenta.eu adat, slider NEM változtatja
- **Sárga szám** (realMinimum) = totalHouses × factor × 150 → **SOHA nem lehet kisebb mint a piros szám**
- **10 éves impact** stabil, csak a target slider változtatja
- Ha `financial: null` → minimumBase fallback (effectiveHouses × 150)
- Lakásszám sanity check: max municipiu=200k, város=50k, község=15k (county-level adat kiszűrése)

---

## 5. API Proxy (proxy/server.js)

### 5.1 Endpoint

`GET /api/entity-data?county=X&name=Y`

Kombinált endpoint: entity keresés + pénzügyi + lakás adat egy hívásban.

### 5.2 Entity keresési stratégia (prioritás sorrend)

1. `Primaria <name> <county>`
2. `Comuna <name> <county>`
3. `<name> <county>`
4. `Municipiul <name> <county>`
5. `Primaria <name>`
6. Kötőjeles variánsok (pl. Piatra-Neamț)

### 5.3 Match prioritás

1. isPrimaria + UAT name exact match
2. isPrimaria + UAT name includes
3. isPrimaria + entity name includes
4. UAT name exact match
5. UAT/entity name includes

### 5.4 Blacklist

Soha nem match-elnek: SCOALA, LICEUL, SPITAL, BISERICA, MUZEU, TRIBUNAL, JUDECATORIA, stb. (~50+ kulcsszó).
**De**: ha az entitás neve tartalmazza: PRIMĂRIA, PRIMARIA, ORAȘ, MUNICIPIUL, COMUNA → MINDIG átmegy.

### 5.5 Pénzügyi adat

GraphQL → `aggregatedLineItems` → `functional_prefixes: ["07.01.01"]`
Évek: 2025 → 2024 → 2023 → 2022 (fallback sorrendben)

### 5.6 Lakás adat

GraphQL → `insObservations` → dataset: `LOC101B`, SIRUTA kód, legfrissebb év.

---

## 6. UI Szekciók

1. **Date Administrative** — Megye + település választás, rang megjelenítés, Transparenta státusz
2. **Rezultate Simulare** — Piros (aktuális), Sárga (minimum), Zöld (CartInspect után), 10Y impact
3. **Cost și Recuperare** — Projekt költség, ROI %, payback idő
4. **Ce se poate realiza** — Surplus felhasználási példák (játszótér, út, parkoló, stb.)
5. **Plan de plată în rate** — Részletfizetési plan + 10 éves timeline vizualizáció
6. **Parametri Colectare** — Slider-ek (aktuális ráta 10-90%, potenciális ráta 10-100%)
7. **PDF generálás** — jsPDF → Roboto font, Visoro logó, A4 layout, auto letöltés

### UI design jellemzők
- Sötét téma (dark mode), glassmorphism, Inter font
- Arany-kék-sötétkék színvilág (Visoro brand)
- Responsive: 2-column grid → mobil: single column (<700px)
- fadeInUp animációk, gradient mesh háttér

---

## 7. Deployment

- **Hosting:** Railway (auto-deploy from GitHub `main` branch)
- **Start:** `npm start` → `node proxy/server.js`
- **PORT:** env variable (Railway állítja), default: 3001
- Static fájlok: `public/` mappa

---

## 8. Git History Összefoglaló

56 commit összesen (`main` branch). Főbb fejlesztési területek:

### Entity search javítások
- Blacklist bővítés (iskolák, kórházak, bíróságok, penitenciar, stb.)
- Whitelist-first: primăria mindig átmegy
- Kötőjeles keresés (Piatra-Neamț)
- Veszélyes last-resort fallback eltávolítása

### Számítási logika finomítások
- TAX_INCREASE: 1.8 → 1.6 (+60%)
- cityFactor község: 1.0 → 0.5
- currentRevenue fix: mindig a Transparenta baseline
- Piros/sárga szám constraint (sárga ≥ piros)
- taxFactor és cityFactor szétválasztása
- Slider fill vizuális fix

### Egyéb
- Lakásszám sanity check
- Költség = totalHouses × 130 (nem effectiveHouses)
- `eval` → `Function`, `console.log` → `console.info`

---

## 9. Beszélgetés Napló

> Ide kerül minden jövőbeli beszélgetés eredménye, döntése, változtatása.

### 2026-03-10 — Projekt áttekintés
- **Cél:** Teljes projekt feltérképezés és master brain fájl létrehozása
- **Eredmény:** `PROJECT_MASTER.md` létrehozva, összegyűjtve: tech stack, fájlstruktúra, számítási motor, API proxy, UI, deploy, git history
- **Döntés:** Ez a fájl lesz a központi tudásbázis minden jövőbeli beszélgetéshez

### 2026-03-10 — Házszám adat audit és javítás
- **Probléma:** 282 község/város a megye főváros lakásszámát kapta (county-level SIRUTA leak)
  - Pl. Arad megye: 10 község 85.233 házzal, Satu Mare: 35 község 49.839 házzal
  - Roșiești (Vaslui): teljesen hiányzott az offline cache-ből → "0 locuințe"
- **Megoldás:**
  1. `scripts/audit-uat-data.js` — audit script, 3187 UAT átvizsgálása
  2. `scripts/fix-uat-data.js` — 282 hibás házszám nullázása
  3. `proxy/server.js` — server-side sanity check (maxHouses type alapján)
  4. `index.html` — frontend: houses=0 esetén warning üzenet, financial-only fallback
- **Eredmény:** Post-fix audit: 0 county-level leak, 282 → 0 hibás adat
- **Megjegyzés:** 5 "too high" értéke valós (Florești/Cluj 32K, Chiajna/Ilfov 38K stb. — város melletti mega-községek)
- **Utolsó audit futtatás (2026-03-10 18:33):**

```
Total UATs in romania_uat.js: 3187
UATs with valid data:         2894

❌ MISSING:       0
🔴 HOUSES = 0:    282  (szándékosan nullázva — nincs valós adat)
🟡 COUNTY LEAK:   0    ✅ (korábban 282)
🟠 TOO HIGH:      5    (valós mega-községek: Budapest, Florești, Miroslava, Chiajna, Giroc)
🔵 NO TAX:        416  (info only)
```

### 2026-03-12 — 60% City Factor javítás + Custom Domain beállítás

#### A) 60% Szabály Audit és Javítás

**Probléma:** Városoknál (oraș) és municipiumoknál az `effectiveHouses = rawHouses × 0.6` számítás fut le, de sok városnál `houses = 0` volt az `uat_data.js`-ben, így a 60%-os szabály nem érvényesülhetett. Az eredeti fetch script a GraphQL keresési eredményekből nem szűrt megye szerint, ezért rossz SIRUTA kódot kapott néhány városnál.

**Új scriptek:**

1. **`scripts/audit-city-factor.js`** — Átvizsgálja az összes 319 várost és municipiumot, kimenete: `audit-city-factor-results.json`
2. **`scripts/fix-city-factor.js`** — Javítja a proxy-n keresztül, county-level leaket nulláz
3. **`scripts/fetch-missing-cities.js`** — Fejlettebb fetch, megye-alapú GraphQL szűréssel (a fő javítás)

**Végeredmény:** 318/319 város és municipium ✅ (csak Budapest marad — INS szektorra osztja)

Sikeres lekérések: Ștefănești (Argeș/Botoșani), Săveni, Găești, Căzănești, Tășnad, Săliște, Milișăuți, Făget, Măcin, Mărășești.

#### B) UI Fix — 60% megjelenítés (`index.html`)

Az `effectiveHousingCount` sor rejtve volt. Javítás:
- `Locuințe existente` → `Locuințe existente (INS)` (nyers adat, mindig látható)
- Új sor: `Locuințe individuale (60% — oraș/municipiu)` — arany színnel, csak városoknál jelenik meg automatikusan

#### C) Static File Serving javítás (`proxy/server.js`)

Hiányzott az `express.static` middleware → `Cannot GET /` Railway-en. Javítás:
```js
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
```

#### D) Custom Domain `simulator-cartinspect.org` → Railway átirányítás

**Előtte:** Cloudflare Pages hosztolta statikus fájlok (régi verzió, manuális deploy kellett)  
**Utána:** DNS CNAME `6h1d3oum.up.railway.app`-ra mutat → teljesen automatikus

Cloudflare DNS beállítás:
- Root CNAME: `simulator-cartinspect.pages.dev` → `6h1d3oum.up.railway.app` (DNS only, szürke felhő)
- TXT: `_railway-verify=5706e9a6bbfbeb6088199f1697cfde267c65696e097da3422ccb54ee688311d6`

Railway: custom domain `simulator-cartinspect.org` → port 8080 (auto-detected)

**Mostantól:** GitHub push → Railway deploy → custom domain is automatikusan frissül.

---

## 10. Scripts Referencia

| Script | Parancs | Leírás |
|--------|---------|--------|
| `scripts/fetch-all-uat-data.js` | `node scripts/fetch-all-uat-data.js` | Összes UAT adat letöltése (proxy kell) |
| `scripts/audit-uat-data.js` | `node scripts/audit-uat-data.js` | Általános UAT adatminőség audit |
| `scripts/fix-uat-data.js` | `node scripts/fix-uat-data.js` | County-level leak javítás |
| `scripts/audit-city-factor.js` | `node scripts/audit-city-factor.js` | 60% szabály audit városokra |
| `scripts/fix-city-factor.js` | `node scripts/fix-city-factor.js` | 60% javítás (proxy kell) |
| `scripts/fetch-missing-cities.js` | `node scripts/fetch-missing-cities.js` | Hiányzó városok megye-alapú fetch |

**Cloudflare Pages manuális deploy (vészhelyzet esetén):**
```
npx wrangler pages deploy public --project-name=simulator-cartinspect --commit-dirty=true
```

**Deploy URL-ek:**
- Railway: `https://cartinspect-calculator-production.up.railway.app`
- Custom domain: `https://simulator-cartinspect.org`
- GitHub: `https://github.com/VisoroGroup/Cartinspect-calculator.git`
