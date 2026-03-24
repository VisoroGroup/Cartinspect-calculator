/**
 * Fix remaining duplicate data by using the LOCAL PROXY (localhost:3001)
 * which has the best entity matching logic.
 * 
 * Process:
 * 1. Detect all duplicate tax values within counties
 * 2. For each duplicate group, re-fetch via proxy
 * 3. Only update if the proxy returns DIFFERENT data than what's stored
 */
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'public', 'uat_data.js');
const PROXY_URL = 'http://localhost:3001/api/entity-data';
const DELAY_MS = 2500; // transparenta.eu rate limit

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchFromProxy(county, name) {
    const url = `${PROXY_URL}?county=${encodeURIComponent(county)}&name=${encodeURIComponent(name)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    return data;
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  Fix Duplicates via Proxy (localhost:3001)           ║');
    console.log('╚══════════════════════════════════════════════════════╝\n');

    // Test proxy connectivity
    try {
        const test = await fetch('http://localhost:3001/health', { signal: AbortSignal.timeout(3000) });
        if (!test.ok) throw new Error('not ok');
        console.log('✓ Proxy is running\n');
    } catch {
        console.error('✗ Proxy not running on localhost:3001! Start it first: cd proxy && node server.js');
        process.exit(1);
    }

    // Load data
    const src = fs.readFileSync(DATA_PATH, 'utf8');
    const match = src.match(/const UAT_DATA = ({[\s\S]*});?\s*$/m);
    if (!match) { console.error('Cannot parse UAT_DATA'); process.exit(1); }
    const UAT_DATA = eval('(' + match[1] + ')');

    // Detect all duplicates
    const toFix = []; // { county, name, duplicateWith, currentTax, currentHouses }
    for (const [county, uats] of Object.entries(UAT_DATA)) {
        const taxMap = {};
        for (const [name, d] of Object.entries(uats)) {
            const tax = (d.tax || 0).toFixed(2);
            if (parseFloat(tax) > 0) {
                if (!taxMap[tax]) taxMap[tax] = [];
                taxMap[tax].push(name);
            }
        }
        for (const [tax, names] of Object.entries(taxMap)) {
            if (names.length > 1) {
                for (const name of names) {
                    if (name === 'București' && county === 'București') continue;
                    const d = uats[name];
                    toFix.push({
                        county, name,
                        duplicateWith: names.filter(n => n !== name),
                        currentTax: d.tax || 0,
                        currentHouses: d.houses || 0,
                    });
                }
            }
        }
    }

    console.log(`Found ${toFix.length} UATs in duplicate groups\n`);

    let fixed = 0, unchanged = 0, failed = 0;

    for (let i = 0; i < toFix.length; i++) {
        const { county, name, duplicateWith, currentTax, currentHouses } = toFix[i];
        console.log(`[${i + 1}/${toFix.length}] ${county} → ${name}`);
        console.log(`    Duplicate with: ${duplicateWith.join(', ')}`);
        console.log(`    Current: tax=${currentTax.toLocaleString()}, houses=${currentHouses}`);

        try {
            const data = await fetchFromProxy(county, name);

            if (!data || !data.entity) {
                console.log('    ✗ Entity not found via proxy\n');
                failed++;
                await sleep(DELAY_MS);
                continue;
            }

            console.log(`    → Entity: "${data.entity.name}" | UAT: ${data.entity.uatName}`);

            const newTax = data.financial?.impozitCladiriFizice || 0;
            const newLandTax = data.financial?.impozitTerenuri || 0;
            const newTaxYear = data.financial?.year || null;
            const newHouses = data.housing?.count || 0;
            const newHousesYear = data.housing?.year || null;

            if (newTax === 0 && newHouses === 0) {
                console.log('    ✗ Proxy returned no data\n');
                failed++;
                await sleep(DELAY_MS);
                continue;
            }

            // Only update if data differs
            const existing = UAT_DATA[county][name];
            if (newTax === (existing.tax || 0) && newHouses === (existing.houses || 0) &&
                (newLandTax || 0) === (existing.landTax || 0)) {
                console.log('    = Data unchanged\n');
                unchanged++;
                await sleep(DELAY_MS);
                continue;
            }

            UAT_DATA[county][name] = {
                tax: newTax || existing.tax || 0,
                landTax: newLandTax || existing.landTax || 0,
                taxYear: newTaxYear || existing.taxYear || null,
                houses: newHouses || existing.houses || 0,
                housesYear: newHousesYear || existing.housesYear || null,
            };
            const d = UAT_DATA[county][name];
            console.log(`    ✅ FIXED: tax=${d.tax.toLocaleString()}, landTax=${d.landTax}, houses=${d.houses}\n`);
            fixed++;

        } catch (e) {
            console.log(`    ✗ Error: ${e.message}\n`);
            failed++;
        }
        await sleep(DELAY_MS);
    }

    // Save
    const timestamp = new Date().toISOString().split('T')[0];
    let totalWithData = 0, total = 0;
    for (const uats of Object.values(UAT_DATA)) {
        for (const d of Object.values(uats)) {
            total++;
            if (((d.tax || 0) + (d.landTax || 0)) > 0 || (d.houses || 0) > 0) totalWithData++;
        }
    }
    const header = `// Auto-generated UAT data from transparenta.eu\n// Generated: ${timestamp} (proxy-fix: ${fixed} fixed)\n// Total: ${totalWithData} UATs with data out of ${total}\n`;
    fs.writeFileSync(DATA_PATH, header + 'const UAT_DATA = ' + JSON.stringify(UAT_DATA) + ';\n');

    // Final check
    let remaining = 0;
    for (const [county, uats] of Object.entries(UAT_DATA)) {
        const taxMap = {};
        for (const [name, d] of Object.entries(uats)) {
            const t = (d.tax || 0).toFixed(2);
            if (parseFloat(t) > 0) { if (!taxMap[t]) taxMap[t] = []; taxMap[t].push(name); }
        }
        for (const [t, names] of Object.entries(taxMap)) {
            if (names.length > 1) {
                remaining++;
                console.log(`  Still duplicate: ${county} — ${names.join(', ')} (tax=${parseFloat(t).toLocaleString()})`);
            }
        }
    }

    console.log(`\n════════════════════════════════════════════════`);
    console.log(`Fixed: ${fixed} | Unchanged: ${unchanged} | Failed: ${failed}`);
    console.log(`Remaining duplicates: ${remaining}`);
    console.log(`Coverage: ${totalWithData}/${total} (${(totalWithData/total*100).toFixed(1)}%)`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
