/**
 * Retry script: finds UATs missing from uat_data.js and re-fetches them
 * with better name matching strategies.
 * 
 * Usage: node scripts/retry-missing-uats.js
 * Requires: local proxy running on port 3001
 */

const fs = require('fs');
const path = require('path');

const PROXY = 'http://localhost:3001';
const DELAY_MS = 1000;
const OUTPUT_FILE = path.join(__dirname, '..', 'uat_data.js');

// Load romania_uat.js
const uatSource = fs.readFileSync(path.join(__dirname, '..', 'romania_uat.js'), 'utf-8');
const match = uatSource.match(/const\s+ROMANIA_UAT\s*=\s*(\{[\s\S]*\});/);
const ROMANIA_UAT = new Function('return ' + match[1])();

// Load existing uat_data.js
const dataSource = fs.readFileSync(OUTPUT_FILE, 'utf-8');
const dataMatch = dataSource.match(/const\s+UAT_DATA\s*=\s*(\{[\s\S]*\});/);
const UAT_DATA = JSON.parse(dataMatch[1]);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Remove diacritics for search
function removeDiacritics(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

async function fetchWithRetry(county, name, attempt = 1) {
    // Strategy 1: exact name
    let data = await tryFetch(county, name);
    if (data) return data;

    // Strategy 2: without diacritics
    const plain = removeDiacritics(name);
    if (plain !== name) {
        data = await tryFetch(county, plain);
        if (data) return data;
    }

    // Strategy 3: first word only (for multi-word names like "Câmpia Turzii")
    const firstWord = name.split(/[\s-]/)[0];
    if (firstWord.length > 3 && firstWord !== name) {
        data = await tryFetch(county, firstWord);
        if (data) return data;
    }

    // Strategy 4: without prefix (for names like "Valea Mare")
    const parts = name.split(/\s+/);
    if (parts.length > 1) {
        const lastPart = parts[parts.length - 1];
        if (lastPart.length > 3) {
            data = await tryFetch(county, lastPart + ' ' + county);
            if (data) return data;
        }
    }

    // Strategy 5: replace hyphens with spaces
    if (name.includes('-')) {
        data = await tryFetch(county, name.replace(/-/g, ' '));
        if (data) return data;
    }

    return null;
}

async function tryFetch(county, searchName) {
    try {
        const url = `${PROXY}/api/entity-data?county=${encodeURIComponent(county)}&name=${encodeURIComponent(searchName)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.financial?.total > 0 || data.housing?.count > 0) {
            return {
                tax: data.financial?.total || 0,
                taxYear: data.financial?.year || null,
                houses: data.housing?.count || 0,
                housesYear: data.housing?.year || null
            };
        }
        return null;
    } catch {
        return null;
    }
}

async function main() {
    // Find missing UATs
    const missing = [];
    for (const county of Object.keys(ROMANIA_UAT).sort()) {
        for (const uat of Object.keys(ROMANIA_UAT[county]).sort()) {
            const existing = UAT_DATA[county]?.[uat];
            if (!existing || (existing.tax === 0 && existing.houses === 0)) {
                missing.push({ county, uat });
            }
        }
    }

    console.log(`Found ${missing.length} UATs to retry\n`);

    let found = 0;
    let stillMissing = 0;

    for (let i = 0; i < missing.length; i++) {
        const { county, uat } = missing[i];
        process.stdout.write(`[${i + 1}/${missing.length}] ${county} → ${uat}... `);

        const data = await fetchWithRetry(county, uat);

        if (data && (data.tax > 0 || data.houses > 0)) {
            if (!UAT_DATA[county]) UAT_DATA[county] = {};
            UAT_DATA[county][uat] = data;
            found++;
            console.log(`✓ FOUND! ${data.tax.toLocaleString()} RON, ${data.houses} houses`);
        } else {
            stillMissing++;
            console.log(`✗ still no data`);
        }

        await sleep(DELAY_MS);
    }

    // Write updated file
    const timestamp = new Date().toISOString().split('T')[0];

    // Count totals
    let totalWithData = 0;
    let totalAll = 0;
    for (const county of Object.keys(ROMANIA_UAT)) {
        for (const uat of Object.keys(ROMANIA_UAT[county])) {
            totalAll++;
            if (UAT_DATA[county]?.[uat] && (UAT_DATA[county][uat].tax > 0 || UAT_DATA[county][uat].houses > 0)) {
                totalWithData++;
            }
        }
    }

    const header = `// Auto-generated UAT data from transparenta.eu\n// Generated: ${timestamp}\n// Total: ${totalWithData} UATs with data out of ${totalAll}\n`;
    const content = header + `const UAT_DATA = ${JSON.stringify(UAT_DATA, null, 0)};\n`;

    fs.writeFileSync(OUTPUT_FILE, content, 'utf-8');

    const sizeKB = Math.round(fs.statSync(OUTPUT_FILE).size / 1024);
    console.log(`\n============================`);
    console.log(`Retry complete! Found ${found} new, ${stillMissing} still missing`);
    console.log(`Total: ${totalWithData}/${totalAll} UATs with data`);
    console.log(`Output: ${OUTPUT_FILE} (${sizeKB} KB)`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
