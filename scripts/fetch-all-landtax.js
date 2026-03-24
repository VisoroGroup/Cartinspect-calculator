/**
 * Fetch missing landTax (07.02 — Impozit pe terenuri) for all UATs that have landTax=0.
 * Uses the local proxy (localhost:3001) which fetches both 07.01.01 and 07.02.
 * Saves incrementally every 50 successful fetches.
 * 
 * Usage: 
 *   1. Start proxy: node proxy/server.js
 *   2. Run: node scripts/fetch-all-landtax.js
 */
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'public', 'uat_data.js');
const PROXY_URL = 'http://localhost:3001/api/entity-data';
const DELAY_MS = 2000;
const SAVE_EVERY = 50;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadData() {
    const src = fs.readFileSync(DATA_PATH, 'utf8');
    const match = src.match(/const UAT_DATA = ({[\s\S]*});?\s*$/m);
    if (!match) throw new Error('Cannot parse UAT_DATA');
    return JSON.parse(match[1]);
}

function saveData(data, fixed, total) {
    const timestamp = new Date().toISOString().split('T')[0];
    let withData = 0, count = 0, withLandTax = 0;
    for (const uats of Object.values(data)) {
        for (const d of Object.values(uats)) {
            count++;
            if (((d.tax || 0) + (d.landTax || 0)) > 0 || (d.houses || 0) > 0) withData++;
            if ((d.landTax || 0) > 0) withLandTax++;
        }
    }
    const header = `// Auto-generated UAT data from transparenta.eu\n// Generated: ${timestamp} (fetch-all-landtax: ${fixed} updated)\n// Total: ${withData} UATs with data out of ${count}, ${withLandTax} with landTax\n`;
    fs.writeFileSync(DATA_PATH, header + 'const UAT_DATA = ' + JSON.stringify(data) + ';\n');
}

async function fetchFromProxy(county, name) {
    const url = `${PROXY_URL}?county=${encodeURIComponent(county)}&name=${encodeURIComponent(name)}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.error) return null;
        return data;
    } catch {
        return null;
    }
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║  Fetch Missing LandTax (07.02) for All UATs             ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Test proxy
    try {
        const test = await fetch('http://localhost:3001/health', { signal: AbortSignal.timeout(3000) });
        if (!test.ok) throw new Error('not ok');
        console.log('✓ Proxy is running\n');
    } catch {
        console.error('✗ Proxy not running! Start it: node proxy/server.js');
        process.exit(1);
    }

    const data = loadData();

    // Find UATs with landTax = 0 but with tax > 0
    const missing = [];
    for (const [county, uats] of Object.entries(data)) {
        for (const [name, d] of Object.entries(uats)) {
            if (name === 'București' && county === 'București') continue;
            if ((d.landTax || 0) === 0 && (d.tax || 0) > 0) {
                missing.push({ county, name });
            }
        }
    }

    console.log(`Found ${missing.length} UATs with missing landTax\n`);

    let fixed = 0, failed = 0, noData = 0, sinceLastSave = 0;
    const startTime = Date.now();

    for (let i = 0; i < missing.length; i++) {
        const { county, name } = missing[i];
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const eta = i > 0 ? Math.round(elapsed / i * (missing.length - i) / 60) : '?';
        process.stdout.write(`[${i + 1}/${missing.length}] ${county} → ${name} (elapsed: ${Math.floor(elapsed/60)}m, ETA: ${eta}m) ... `);

        const result = await fetchFromProxy(county, name);

        if (!result || !result.financial) {
            process.stdout.write('✗ no financial\n');
            failed++;
            await sleep(DELAY_MS);
            continue;
        }

        const landTax = result.financial.impozitTerenuri || 0;
        const newTax = result.financial.impozitCladiriFizice || 0;

        if (landTax === 0) {
            process.stdout.write('= landTax=0 (confirmed)\n');
            noData++;
            await sleep(DELAY_MS);
            continue;
        }

        // Update landTax
        data[county][name].landTax = landTax;
        // Also update tax if it changed (shouldn't normally, but just in case)
        if (newTax > 0 && Math.abs(newTax - (data[county][name].tax || 0)) > 1) {
            data[county][name].tax = newTax;
        }
        data[county][name].taxYear = result.financial.year;

        process.stdout.write(`✓ landTax=${landTax.toLocaleString()}\n`);
        fixed++;
        sinceLastSave++;

        // Incremental save
        if (sinceLastSave >= SAVE_EVERY) {
            saveData(data, fixed, missing.length);
            console.log(`    💾 Saved (${fixed} fixed so far)\n`);
            sinceLastSave = 0;
        }

        await sleep(DELAY_MS);
    }

    // Final save
    saveData(data, fixed, missing.length);

    // Stats
    let totalLandTax = 0;
    for (const uats of Object.values(data)) {
        for (const d of Object.values(uats)) {
            if ((d.landTax || 0) > 0) totalLandTax++;
        }
    }

    const totalElapsed = Math.round((Date.now() - startTime) / 1000 / 60);
    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(`Done in ${totalElapsed} minutes!`);
    console.log(`Fixed (got landTax): ${fixed}`);
    console.log(`Confirmed 0:         ${noData}`);
    console.log(`Failed:              ${failed}`);
    console.log(`Total with landTax:  ${totalLandTax}/3181`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
