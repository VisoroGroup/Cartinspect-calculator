/**
 * Audit UAT housing data quality
 * 
 * Checks for:
 * 1. Missing UATs (in romania_uat.js but not in uat_data.js)
 * 2. Houses = 0
 * 3. County-level house count leaks (communes with same count as county capital)
 * 4. Suspiciously high house counts for commune type
 * 
 * Usage: node scripts/audit-uat-data.js
 */

const fs = require('fs');
const path = require('path');

// ── Load data ──────────────────────────────────────────────────
const uatSource = fs.readFileSync(path.join(__dirname, '..', 'romania_uat.js'), 'utf-8');
const match1 = uatSource.match(/const\s+ROMANIA_UAT\s*=\s*(\{[\s\S]*\});/);
if (!match1) { console.error('Could not parse romania_uat.js'); process.exit(1); }
const ROMANIA_UAT = new Function('return ' + match1[1])();

const dataSource = fs.readFileSync(path.join(__dirname, '..', 'uat_data.js'), 'utf-8');
const match2 = dataSource.match(/const\s+UAT_DATA\s*=\s*(\{[\s\S]*\});/);
if (!match2) { console.error('Could not parse uat_data.js'); process.exit(1); }
const UAT_DATA = JSON.parse(match2[1]);

// ── Max thresholds by type ────────────────────────────────────
const MAX_HOUSES = {
    'municipiu': 200000,
    'oraș': 50000,
    'comună': 15000,
    'sector': 500000
};

// ── Audit ─────────────────────────────────────────────────────
const issues = {
    missing: [],        // In romania_uat but not in uat_data
    zeroHouses: [],     // houses = 0 or missing
    countyLeak: [],     // houses = county capital's count (county-level data)
    tooHigh: [],        // houses exceed max for type
    noTax: [],          // tax = 0 or null
    duplicateHouses: [] // multiple communes with exact same suspicious count
};

let totalUATs = 0;
let totalOK = 0;

for (const county of Object.keys(ROMANIA_UAT).sort()) {
    const uats = ROMANIA_UAT[county];
    const data = UAT_DATA[county] || {};

    // Find the county capital's house count (highest in county, or the municipiu rang I/II)
    let capitalHouses = 0;
    let capitalName = '';
    for (const [name, info] of Object.entries(uats)) {
        if (info.tip === 'municipiu' && data[name]?.houses) {
            if (data[name].houses > capitalHouses) {
                capitalHouses = data[name].houses;
                capitalName = name;
            }
        }
    }

    // Also find the highest house count in the county (could be the county-level leak value)
    let maxHouses = 0;
    let maxName = '';
    for (const [name, d] of Object.entries(data)) {
        if (d.houses > maxHouses) {
            maxHouses = d.houses;
            maxName = name;
        }
    }

    // Count how many UATs have the same house count as the capital
    const capitalHouseCounts = {};
    for (const [name, d] of Object.entries(data)) {
        const h = d.houses;
        if (h > 5000) { // Only care about high values
            capitalHouseCounts[h] = (capitalHouseCounts[h] || []);
            capitalHouseCounts[h].push(name);
        }
    }

    for (const [name, info] of Object.entries(uats)) {
        totalUATs++;

        // Skip sectors
        if (info.tip === 'sector') continue;

        const d = data[name];

        // Check 1: Missing from uat_data
        if (!d) {
            issues.missing.push({ county, name, tip: info.tip, rang: info.rang });
            continue;
        }

        // Check 2: Houses = 0
        if (!d.houses || d.houses === 0) {
            issues.zeroHouses.push({ county, name, tip: info.tip, houses: d.houses, tax: d.tax });
            continue;
        }

        // Check 3: County-level house count leak
        // A commune/oraș having the exact same house count as the county's capital is suspicious
        if (info.tip === 'comună' || info.tip === 'oraș') {
            if (capitalHouses > 0 && d.houses === capitalHouses) {
                issues.countyLeak.push({
                    county, name, tip: info.tip,
                    houses: d.houses,
                    capitalName,
                    capitalHouses,
                    tax: d.tax
                });
                continue;
            }
            // Also check: if multiple communes share the exact same high house count
            if (d.houses > 5000 && capitalHouseCounts[d.houses]?.length > 2) {
                // More than 2 communes with the same high count = suspicious
                if (!issues.countyLeak.find(i => i.county === county && i.name === name)) {
                    issues.countyLeak.push({
                        county, name, tip: info.tip,
                        houses: d.houses,
                        capitalName: `${capitalHouseCounts[d.houses].length} UATs share this count`,
                        capitalHouses: d.houses,
                        tax: d.tax
                    });
                    continue;
                }
            }
        }

        // Check 4: Too high for type
        const maxForType = MAX_HOUSES[info.tip] || 15000;
        if (d.houses > maxForType) {
            issues.tooHigh.push({
                county, name, tip: info.tip,
                houses: d.houses,
                max: maxForType,
                tax: d.tax
            });
            continue;
        }

        // Check 5: No tax data
        if (!d.tax || d.tax === 0) {
            issues.noTax.push({ county, name, tip: info.tip, houses: d.houses, tax: d.tax });
            // Don't continue, this is informational
        }

        totalOK++;
    }
}

// ── Report ────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║            UAT DATA QUALITY AUDIT REPORT                    ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

console.log(`Total UATs in romania_uat.js: ${totalUATs}`);
console.log(`UATs with valid data:         ${totalOK}`);
console.log(`\n── ISSUES ──\n`);

// Missing
console.log(`❌ MISSING from uat_data.js: ${issues.missing.length}`);
if (issues.missing.length > 0) {
    for (const i of issues.missing.slice(0, 20)) {
        console.log(`   ${i.county} → ${i.name} (${i.tip})`);
    }
    if (issues.missing.length > 20) console.log(`   ... and ${issues.missing.length - 20} more`);
}

// Zero houses
console.log(`\n🔴 HOUSES = 0: ${issues.zeroHouses.length}`);
if (issues.zeroHouses.length > 0) {
    for (const i of issues.zeroHouses.slice(0, 10)) {
        console.log(`   ${i.county} → ${i.name} (${i.tip}) tax=${i.tax}`);
    }
    if (issues.zeroHouses.length > 10) console.log(`   ... and ${issues.zeroHouses.length - 10} more`);
}

// County leak
console.log(`\n🟡 COUNTY-LEVEL HOUSE COUNT LEAK: ${issues.countyLeak.length}`);
if (issues.countyLeak.length > 0) {
    // Group by county for readability
    const byCounty = {};
    for (const i of issues.countyLeak) {
        if (!byCounty[i.county]) byCounty[i.county] = [];
        byCounty[i.county].push(i);
    }
    for (const [county, items] of Object.entries(byCounty)) {
        console.log(`   ${county} (leak value: ${items[0].capitalHouses} = ${items[0].capitalName}):`);
        for (const i of items) {
            console.log(`      ${i.name} (${i.tip}) → houses=${i.houses}, tax=${i.tax}`);
        }
    }
}

// Too high
console.log(`\n🟠 HOUSES TOO HIGH FOR TYPE: ${issues.tooHigh.length}`);
if (issues.tooHigh.length > 0) {
    for (const i of issues.tooHigh) {
        console.log(`   ${i.county} → ${i.name} (${i.tip}) houses=${i.houses} > max=${i.max}`);
    }
}

// No tax (informational)
console.log(`\n🔵 NO TAX DATA (informational): ${issues.noTax.length}`);

// Summary
const totalIssues = issues.missing.length + issues.zeroHouses.length + issues.countyLeak.length + issues.tooHigh.length;
console.log(`\n═══════════════════════════════════════`);
console.log(`TOTAL ISSUES: ${totalIssues} out of ${totalUATs} UATs (${(totalIssues / totalUATs * 100).toFixed(1)}%)`);
console.log(`  Missing:      ${issues.missing.length}`);
console.log(`  Zero houses:  ${issues.zeroHouses.length}`);
console.log(`  County leak:  ${issues.countyLeak.length}`);
console.log(`  Too high:     ${issues.tooHigh.length}`);
console.log(`  No tax:       ${issues.noTax.length} (info only)`);

// ── Export JSON for fix script ───────────────────────────────
const exportData = {
    generated: new Date().toISOString(),
    summary: {
        total: totalUATs,
        ok: totalOK,
        missing: issues.missing.length,
        zeroHouses: issues.zeroHouses.length,
        countyLeak: issues.countyLeak.length,
        tooHigh: issues.tooHigh.length,
        noTax: issues.noTax.length
    },
    issues
};

const outputFile = path.join(__dirname, 'audit-results.json');
fs.writeFileSync(outputFile, JSON.stringify(exportData, null, 2), 'utf-8');
console.log(`\nDetailed results saved to: ${outputFile}`);
