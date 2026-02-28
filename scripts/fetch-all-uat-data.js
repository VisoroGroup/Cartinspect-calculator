/**
 * Fetches financial (fn:07.01.01) and housing data for ALL UATs
 * from transparenta.eu via the local proxy, then writes uat_data.js
 *
 * Usage: node scripts/fetch-all-uat-data.js
 * Requires: local proxy running on port 3001
 */

const fs = require('fs');
const path = require('path');

const PROXY = 'http://localhost:3001';
const DELAY_MS = 800; // Delay between requests to avoid rate limiting
const OUTPUT_FILE = path.join(__dirname, '..', 'uat_data.js');

// Load romania_uat.js to get all UATs
const uatSource = fs.readFileSync(path.join(__dirname, '..', 'romania_uat.js'), 'utf-8');
// Extract the object – it's defined as: const ROMANIA_UAT = { ... };
const match = uatSource.match(/const\s+ROMANIA_UAT\s*=\s*(\{[\s\S]*\});/);
if (!match) {
    console.error('Could not parse romania_uat.js');
    process.exit(1);
}
const ROMANIA_UAT = new Function('return ' + match[1])();

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchUAT(county, name) {
    try {
        const url = `${PROXY}/api/entity-data?county=${encodeURIComponent(county)}&name=${encodeURIComponent(name)}`;
        const res = await fetch(url, { timeout: 30000 });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.financial && !data.housing) return null;
        return {
            tax: data.financial?.total || 0,
            taxYear: data.financial?.year || null,
            houses: data.housing?.count || 0,
            housesYear: data.housing?.year || null
        };
    } catch (err) {
        return null;
    }
}

async function main() {
    const counties = Object.keys(ROMANIA_UAT).sort();
    let totalUATs = 0;
    let fetched = 0;
    let failed = 0;
    const result = {};

    // Count total
    for (const county of counties) {
        totalUATs += Object.keys(ROMANIA_UAT[county]).length;
    }
    console.log(`Total UATs to fetch: ${totalUATs}`);
    console.log(`Estimated time: ~${Math.round(totalUATs * DELAY_MS / 60000)} minutes\n`);

    let count = 0;
    for (const county of counties) {
        result[county] = {};
        const uats = Object.keys(ROMANIA_UAT[county]).sort();

        for (const uat of uats) {
            count++;
            process.stdout.write(`[${count}/${totalUATs}] ${county} → ${uat}... `);

            const data = await fetchUAT(county, uat);

            if (data && (data.tax > 0 || data.houses > 0)) {
                result[county][uat] = data;
                fetched++;
                console.log(`✓ ${data.tax.toLocaleString()} RON, ${data.houses} houses`);
            } else {
                failed++;
                console.log(`✗ no data`);
            }

            await sleep(DELAY_MS);
        }
    }

    // Write output
    const timestamp = new Date().toISOString().split('T')[0];
    const header = `// Auto-generated UAT data from transparenta.eu\n// Generated: ${timestamp}\n// Total: ${fetched} UATs with data, ${failed} without data\n`;
    const content = header + `const UAT_DATA = ${JSON.stringify(result, null, 0)};\n`;

    fs.writeFileSync(OUTPUT_FILE, content, 'utf-8');

    const sizeKB = Math.round(fs.statSync(OUTPUT_FILE).size / 1024);
    console.log(`\n============================`);
    console.log(`Done! ${fetched}/${totalUATs} UATs fetched (${failed} failed)`);
    console.log(`Output: ${OUTPUT_FILE} (${sizeKB} KB)`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
