/**
 * Retries fetching financial data for UATs that have tax=0 in uat_data.js
 * Merges results into existing data — NEVER overwrites good data with zeros.
 * Saves progress every 25 successful fetches (crash-safe).
 *
 * Usage: node scripts/retry-missing-financial.js
 * Requires: local proxy running on port 3001
 */

const fs = require('fs');
const path = require('path');

const PROXY = 'http://localhost:3001';
const DELAY_MS = 1200;
const SAVE_EVERY = 25; // Save to disk every N successful fetches
const PUBLIC_UAT_FILE = path.join(__dirname, '..', 'public', 'uat_data.js');
const ROOT_UAT_FILE = path.join(__dirname, '..', 'uat_data.js');

// Load romania_uat.js to know ALL UATs and their types
const uatSource = fs.readFileSync(path.join(__dirname, '..', 'romania_uat.js'), 'utf-8');
const match = uatSource.match(/const\s+ROMANIA_UAT\s*=\s*(\{[\s\S]*\});/);
if (!match) { console.error('Could not parse romania_uat.js'); process.exit(1); }
const ROMANIA_UAT = new Function('return ' + match[1])();

// Load existing public/uat_data.js (re-read each time to be safe)
function loadUATData() {
    const src = fs.readFileSync(PUBLIC_UAT_FILE, 'utf-8');
    const m = src.match(/const\s+UAT_DATA\s*=\s*(\{[\s\S]*\});/);
    if (!m) { console.error('Could not parse public/uat_data.js'); process.exit(1); }
    return new Function('return ' + m[1])();
}

let UAT_DATA = loadUATData();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function saveData(updated) {
    // Upgrade ALL entries to new format (add landTax if missing)
    for (const county of Object.keys(UAT_DATA)) {
        for (const uat of Object.keys(UAT_DATA[county])) {
            const entry = UAT_DATA[county][uat];
            if (entry.landTax === undefined) {
                entry.landTax = 0;
            }
        }
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const totalWithData = Object.values(UAT_DATA).reduce((sum, county) =>
        sum + Object.values(county).filter(e => e.tax > 0 || e.landTax > 0 || e.houses > 0).length, 0);
    const totalUATs = Object.values(ROMANIA_UAT).reduce((sum, county) =>
        sum + Object.keys(county).length, 0);

    const header = `// Auto-generated UAT data from transparenta.eu\n// Generated: ${timestamp} (retry-missing-financial: ${updated} new records)\n// Total: ${totalWithData} UATs with data out of ${totalUATs}\n`;
    const content = header + `const UAT_DATA = ${JSON.stringify(UAT_DATA, null, 0)};\n`;

    fs.writeFileSync(PUBLIC_UAT_FILE, content, 'utf-8');
    fs.writeFileSync(ROOT_UAT_FILE, content, 'utf-8');
    return totalWithData;
}

async function fetchUAT(county, name, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const url = `${PROXY}/api/entity-data?county=${encodeURIComponent(county)}&name=${encodeURIComponent(name)}`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 45000);
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            if (!res.ok) {
                if (attempt < retries) { await sleep(2000 * attempt); continue; }
                return null;
            }
            const data = await res.json();
            if (data.error && attempt < retries) { await sleep(2000 * attempt); continue; }
            return data;
        } catch (err) {
            if (attempt < retries) {
                process.stdout.write(`[retry ${attempt}] `);
                await sleep(3000 * attempt);
                continue;
            }
            return null;
        }
    }
    return null;
}

async function main() {
    // Find all UATs missing financial data
    const missing = [];
    const counties = Object.keys(ROMANIA_UAT).sort();

    for (const county of counties) {
        const uats = Object.keys(ROMANIA_UAT[county]).sort();
        for (const uat of uats) {
            const existing = UAT_DATA[county]?.[uat];
            const hasTax = existing && (existing.tax > 0 || existing.landTax > 0);
            if (!hasTax) {
                missing.push({ county, uat, tip: ROMANIA_UAT[county][uat].tip });
            }
        }
    }

    console.log(`Found ${missing.length} UATs with missing financial data`);
    const cities = missing.filter(m => m.tip === 'municipiu' || m.tip === 'oraș');
    console.log(`  - ${cities.length} are municipiu/oraș (high priority)`);
    console.log(`  - ${missing.length - cities.length} are comună\n`);
    console.log(`Estimated time: ~${Math.round(missing.length * DELAY_MS / 60000)} minutes\n`);

    if (missing.length === 0) {
        console.log('🎉 No missing financial data! All UATs have data.');
        return;
    }

    let fetched = 0;
    let failed = 0;
    let updated = 0;
    let sinceLastSave = 0;

    for (let i = 0; i < missing.length; i++) {
        const { county, uat, tip } = missing[i];
        process.stdout.write(`[${i + 1}/${missing.length}] ${county} → ${uat} (${tip})... `);

        const data = await fetchUAT(county, uat);

        if (data && data.financial && data.financial.total > 0) {
            if (!UAT_DATA[county]) UAT_DATA[county] = {};
            const existing = UAT_DATA[county][uat] || {};

            UAT_DATA[county][uat] = {
                tax: data.financial.impozitCladiriFizice || 0,
                landTax: data.financial.impozitTerenuri || 0,
                taxYear: data.financial.year || null,
                houses: data.housing?.count || existing.houses || 0,
                housesYear: data.housing?.year || existing.housesYear || null
            };

            fetched++;
            updated++;
            sinceLastSave++;
            console.log(`✓ clădiri: ${data.financial.impozitCladiriFizice?.toLocaleString()} RON, terenuri: ${data.financial.impozitTerenuri?.toLocaleString()} RON`);

            // Auto-save every N successful fetches
            if (sinceLastSave >= SAVE_EVERY) {
                const total = saveData(updated);
                console.log(`  💾 Saved! (${total} UATs with data total)`);
                sinceLastSave = 0;
            }
        } else if (data && data.housing && data.housing.count > 0) {
            if (!UAT_DATA[county]) UAT_DATA[county] = {};
            const existing = UAT_DATA[county][uat] || {};
            if (!existing.houses || existing.houses === 0) {
                UAT_DATA[county][uat] = {
                    tax: existing.tax || 0,
                    landTax: existing.landTax || 0,
                    taxYear: existing.taxYear || null,
                    houses: data.housing.count,
                    housesYear: data.housing.year || null
                };
                console.log(`~ housing only: ${data.housing.count} houses (no financial)`);
            } else {
                failed++;
                console.log(`✗ no financial data (housing unchanged)`);
            }
        } else {
            failed++;
            console.log(`✗ no data`);
        }

        await sleep(DELAY_MS);
    }

    // Final save
    const totalWithData = saveData(updated);
    const sizeKB = Math.round(fs.statSync(PUBLIC_UAT_FILE).size / 1024);

    console.log(`\n============================`);
    console.log(`Done! ${fetched} new financial records fetched`);
    console.log(`Failed: ${failed}`);
    console.log(`Total UATs with data: ${totalWithData}`);
    console.log(`Output: ${PUBLIC_UAT_FILE} (${sizeKB} KB)`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    // Emergency save before exit
    try { saveData(0); console.log('Emergency save done.'); } catch(e) {}
    process.exit(1);
});
