/**
 * Fix: 60% City Factor — Fetch missing housing data for cities and municipalities
 *
 * This script reads the audit-city-factor-results.json and attempts to fetch
 * fresh housing data for all ORAS/MUNICIPIU entries that currently have houses=0.
 *
 * For entries with county-level data leaks (too high), the count is nulled.
 *
 * REQUIRES: local proxy running on port 3001
 *   cd proxy && npm install && node server.js
 *
 * Usage: node scripts/fix-city-factor.js
 */

const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..');
const PROXY = 'http://localhost:3001';
const DELAY_MS = 1000;

// ── Load audit results ─────────────────────────────────────────
const auditFile = path.join(__dirname, 'audit-city-factor-results.json');
if (!fs.existsSync(auditFile)) {
    console.error('audit-city-factor-results.json not found. Run audit-city-factor.js first.');
    process.exit(1);
}
const audit = JSON.parse(fs.readFileSync(auditFile, 'utf-8'));

// ── Load uat_data.js ───────────────────────────────────────────
const dataPath = path.join(base, 'uat_data.js');
const dataSrc = fs.readFileSync(dataPath, 'utf-8');
const match2 = dataSrc.match(/const\s+UAT_DATA\s*=\s*(\{[\s\S]*\});/);
if (!match2) { console.error('Cannot parse uat_data.js'); process.exit(1); }
const UAT_DATA = JSON.parse(match2[1]);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchFromProxy(county, name) {
    try {
        const url = `${PROXY}/api/entity-data?county=${encodeURIComponent(county)}&name=${encodeURIComponent(name)}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) return null;
        const data = await res.json();
        return data;
    } catch {
        return null;
    }
}

async function main() {
    const toFetch = audit.issues.noHouses;
    const toNull = audit.issues.tooHigh;

    console.log('╔════════════════════════════════════════════════════╗');
    console.log('║   FIX: 60% City Factor — Housing Data Repair      ║');
    console.log('╚════════════════════════════════════════════════════╝\n');
    console.log('Issues to fix:');
    console.log('  ' + toFetch.length + ' cities/municipii with houses=0 → will try to fetch fresh data');
    console.log('  ' + toNull.length + ' cities/municipii with county-level data leak → will null houses\n');

    let fixed = 0;
    let failed = 0;
    let nulled = 0;

    // ── Fix 1: Fetch fresh housing data ───────────────────────
    if (toFetch.length > 0) {
        console.log('─── Fetching fresh housing data ───\n');

        for (let i = 0; i < toFetch.length; i++) {
            const { county, name, tip, tax, taxYear } = toFetch[i];
            process.stdout.write('[' + (i + 1) + '/' + toFetch.length + '] ' + county + ' → ' + name + ' (' + tip + ')... ');

            const data = await fetchFromProxy(county, name);

            if (data && data.housing && data.housing.count > 0) {
                // Sanity check the returned value
                const maxHouses = tip === 'municipiu' ? 200000 : 50000;
                if (data.housing.count > maxHouses) {
                    console.log('⚠ count=' + data.housing.count + ' exceeds max=' + maxHouses + ' for ' + tip + ' — SKIPPING (likely county-level data)');
                    failed++;
                } else {
                    if (!UAT_DATA[county]) UAT_DATA[county] = {};
                    if (!UAT_DATA[county][name]) UAT_DATA[county][name] = { tax: tax || 0, taxYear: taxYear || null, houses: 0, housesYear: null };
                    UAT_DATA[county][name].houses = data.housing.count;
                    UAT_DATA[county][name].housesYear = data.housing.year || null;

                    // Also update tax if we got better data
                    if (data.financial && data.financial.total > 0 && !UAT_DATA[county][name].tax) {
                        UAT_DATA[county][name].tax = data.financial.total;
                        UAT_DATA[county][name].taxYear = data.financial.year || null;
                    }

                    const eff = Math.round(data.housing.count * 0.6);
                    const minBase = (eff * 150).toLocaleString();
                    console.log('✓ houses=' + data.housing.count + ' → 60%=' + eff + ' → minBase=' + minBase + ' RON');
                    fixed++;
                }
            } else {
                console.log('✗ No housing data found (proxy returned nothing)');
                failed++;
            }

            await sleep(DELAY_MS);
        }
    }

    // ── Fix 2: Null county-level data leaks ───────────────────
    if (toNull.length > 0) {
        console.log('\n─── Nulling county-level housing data leaks ───\n');
        for (const { county, name, rawHouses, maxForType } of toNull) {
            if (UAT_DATA[county] && UAT_DATA[county][name]) {
                const old = UAT_DATA[county][name].houses;
                UAT_DATA[county][name].houses = 0;
                UAT_DATA[county][name].housesYear = null;
                console.log('Nulled: ' + county + ' → ' + name + ': ' + old + ' → 0 (exceeded max=' + maxForType + ')');
                nulled++;
            }
        }
    }

    // ── Write updated file ─────────────────────────────────────
    const timestamp = new Date().toISOString().split('T')[0];
    let totalWithData = 0, totalAll = 0;

    // Load romania_uat for counting
    const uatSrc = fs.readFileSync(path.join(base, 'romania_uat.js'), 'utf-8');
    const matchUat = uatSrc.match(/const\s+ROMANIA_UAT\s*=\s*(\{[\s\S]*\});/);
    const ROMANIA_UAT = new Function('return ' + matchUat[1])();

    for (const county of Object.keys(ROMANIA_UAT)) {
        for (const uat of Object.keys(ROMANIA_UAT[county])) {
            totalAll++;
            const d = UAT_DATA[county] && UAT_DATA[county][uat];
            if (d && (d.tax > 0 || d.houses > 0)) totalWithData++;
        }
    }

    const header = '// Auto-generated UAT data from transparenta.eu\n'
        + '// Generated: ' + timestamp + ' (fix-city-factor: fetched ' + fixed + ' housing records, nulled ' + nulled + ')\n'
        + '// Total: ' + totalWithData + ' UATs with data out of ' + totalAll + '\n';
    const content = header + 'const UAT_DATA = ' + JSON.stringify(UAT_DATA, null, 0) + ';\n';

    fs.writeFileSync(dataPath, content, 'utf-8');

    // Copy to public/
    const publicPath = path.join(base, 'public', 'uat_data.js');
    if (fs.existsSync(path.dirname(publicPath))) {
        fs.writeFileSync(publicPath, content, 'utf-8');
        console.log('\nAlso copied to public/uat_data.js');
    }

    const sizeKB = Math.round(fs.statSync(dataPath).size / 1024);

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('DONE!');
    console.log('  Fixed (new housing data fetched):  ' + fixed);
    console.log('  Failed (no data found):            ' + failed);
    console.log('  Nulled (county-level leak):        ' + nulled);
    console.log('  Output: ' + dataPath + ' (' + sizeKB + ' KB)');
    console.log('═══════════════════════════════════════════════════════\n');

    if (failed > 0) {
        console.log('NOTE: ' + failed + ' entries still have no housing data.');
        console.log('These will use financial-only fallback in the calculator.');
        console.log('Run audit-city-factor.js again to verify the final state.\n');
    }

    console.log('Run audit-city-factor.js again to confirm all issues are resolved.');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
