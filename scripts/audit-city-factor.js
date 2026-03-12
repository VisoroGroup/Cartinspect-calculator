/**
 * Audit: 60% City Factor Compliance Check
 *
 * For CITIES (ORAS) and MUNICIPALITIES (MUNICIPIU), the calculation engine
 * applies a 60% factor to housing counts:
 *   effectiveHouses = totalHouses * 0.60
 *   minimumBase = effectiveHouses * 150 RON
 *
 * This script checks ALL cities and municipalities to ensure:
 *   1. They have housing data (houses > 0) in uat_data.js
 *   2. Their effective house count (after 60%) is reasonable
 *   3. Raw house count does not exceed the sanity limit for type
 *
 * Usage: node scripts/audit-city-factor.js
 * Output: audit-city-factor-results.json
 */

const fs = require('fs');
const path = require('path');

// ── Load data ──────────────────────────────────────────────────
const base = path.join(__dirname, '..');

const uatSrc = fs.readFileSync(path.join(base, 'romania_uat.js'), 'utf-8');
const match1 = uatSrc.match(/const\s+ROMANIA_UAT\s*=\s*(\{[\s\S]*\});/);
if (!match1) { console.error('Cannot parse romania_uat.js'); process.exit(1); }
const ROMANIA_UAT = new Function('return ' + match1[1])();

const dataSrc = fs.readFileSync(path.join(base, 'uat_data.js'), 'utf-8');
const match2 = dataSrc.match(/const\s+UAT_DATA\s*=\s*(\{[\s\S]*\});/);
if (!match2) { console.error('Cannot parse uat_data.js'); process.exit(1); }
const UAT_DATA = JSON.parse(match2[1]);

// ── Config ─────────────────────────────────────────────────────
const CITY_FACTOR = 0.60;                // 60% for city/municipiu
const PRICE_PER_HOUSE = 150;             // RON minimum tax per house
const MAX_HOUSES = {
    'municipiu': 200000,
    'oraș': 50000
};
const MIN_REASONABLE_HOUSES = {
    'municipiu': 1000,  // A municipiu with < 1000 houses is suspicious
    'oraș': 200         // A city with < 200 houses is suspicious
};

// ── Audit ──────────────────────────────────────────────────────
const issues = {
    noHouses: [],       // houses = 0 or missing (60% rule can't apply)
    tooHigh: [],        // houses exceed max for type (likely county-level leak)
    tooLow: [],         // suspiciously low house count
    ok: []              // all checks passed
};

let totalCities = 0;
let totalMunicipii = 0;

for (const county of Object.keys(ROMANIA_UAT).sort()) {
    for (const [name, info] of Object.entries(ROMANIA_UAT[county])) {
        const tip = info.tip;
        if (tip !== 'oraș' && tip !== 'municipiu') continue;

        if (tip === 'oraș') totalCities++;
        else totalMunicipii++;

        const d = UAT_DATA[county] && UAT_DATA[county][name];
        const rawHouses = d ? (d.houses || 0) : 0;
        const effectiveHouses = Math.round(rawHouses * CITY_FACTOR);
        const minimumBase = effectiveHouses * PRICE_PER_HOUSE;
        const hasTax = d && d.tax > 0;

        const entry = {
            county, name, tip,
            rawHouses,
            effectiveHouses,
            minimumBase,
            tax: d ? d.tax : 0,
            taxYear: d ? d.taxYear : null,
            housesYear: d ? d.housesYear : null,
            missing: !d
        };

        // Check 1: No houses data
        if (!d || rawHouses === 0) {
            issues.noHouses.push(entry);
            continue;
        }

        // Check 2: Houses too high (county-level leak)
        const maxForType = MAX_HOUSES[tip];
        if (rawHouses > maxForType) {
            issues.tooHigh.push({ ...entry, maxForType });
            continue;
        }

        // Check 3: Houses suspiciously low
        const minForType = MIN_REASONABLE_HOUSES[tip];
        if (rawHouses < minForType) {
            issues.tooLow.push({ ...entry, minForType });
            continue;
        }

        // All good
        issues.ok.push(entry);
    }
}

// ── Report ─────────────────────────────────────────────────────
const total = totalCities + totalMunicipii;
const totalOK = issues.ok.length;
const totalProblems = issues.noHouses.length + issues.tooHigh.length + issues.tooLow.length;

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║       60% CITY FACTOR COMPLIANCE AUDIT REPORT               ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

console.log('SCOPE: Only CITIES (ORAS) and MUNICIPALITIES (MUNICIPIU)');
console.log('RULE:  effectiveHouses = rawHouses × 60% → minimumBase = effectiveHouses × 150 RON\n');

console.log('Total cities (ORAS):          ' + totalCities);
console.log('Total municipalities (MUNI):  ' + totalMunicipii);
console.log('Total in scope:               ' + total);
console.log('PASSING (60% rule OK):        ' + totalOK);
console.log('FAILING (issues found):       ' + totalProblems + '\n');

// Issue 1: No houses
console.log('❌ NO HOUSING DATA (60% rule cannot apply): ' + issues.noHouses.length);
if (issues.noHouses.length > 0) {
    const grouped = {};
    for (const i of issues.noHouses) {
        if (!grouped[i.county]) grouped[i.county] = [];
        grouped[i.county].push(i);
    }
    for (const [county, items] of Object.entries(grouped)) {
        console.log('   ' + county + ':');
        for (const i of items) {
            const status = i.missing ? '[MISSING from uat_data]' : '[houses=0]';
            console.log('      ' + i.name + ' (' + i.tip + ') ' + status + ' tax=' + (i.tax ? i.tax.toLocaleString() + ' RON' : 'n/a'));
        }
    }
}

// Issue 2: Too high
console.log('\n🟠 HOUSING COUNT TOO HIGH (likely county-level leak): ' + issues.tooHigh.length);
if (issues.tooHigh.length > 0) {
    for (const i of issues.tooHigh) {
        console.log('   ' + i.county + ' → ' + i.name + ' (' + i.tip + ') raw=' + i.rawHouses + ' > max=' + i.maxForType);
    }
}

// Issue 3: Too low
console.log('\n🟡 HOUSING COUNT SUSPICIOUSLY LOW: ' + issues.tooLow.length);
if (issues.tooLow.length > 0) {
    for (const i of issues.tooLow) {
        console.log('   ' + i.county + ' → ' + i.name + ' (' + i.tip + ') raw=' + i.rawHouses + ' (min expected ~' + i.minForType + ')');
        console.log('      → effective (60%) = ' + i.effectiveHouses + ' | minimumBase = ' + i.minimumBase.toLocaleString() + ' RON');
    }
}

// Summary table for valid ones
console.log('\n✅ PASSING EXAMPLES (first 10):');
issues.ok.slice(0, 10).forEach(i => {
    const effectStr = i.effectiveHouses.toLocaleString();
    const minBaseStr = i.minimumBase.toLocaleString();
    console.log('   ' + i.county + ' → ' + i.name + ' (' + i.tip + '): raw=' + i.rawHouses + ' → 60%=' + effectStr + ' → min=' + minBaseStr + ' RON');
});

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('RESULT: ' + (totalProblems === 0 ? '✅ ALL OK — 60% rule applies correctly to all cities/municipii' : '❌ ' + totalProblems + ' cities/municipii have issues — run fix-city-factor.js to resolve'));
console.log('═══════════════════════════════════════════════════════════════\n');

// ── Export JSON ────────────────────────────────────────────────
const output = {
    generated: new Date().toISOString(),
    summary: {
        totalCities,
        totalMunicipii,
        total,
        ok: totalOK,
        noHouses: issues.noHouses.length,
        tooHigh: issues.tooHigh.length,
        tooLow: issues.tooLow.length,
        totalProblems
    },
    issues: {
        noHouses: issues.noHouses,
        tooHigh: issues.tooHigh,
        tooLow: issues.tooLow
    }
};

const outputFile = path.join(__dirname, 'audit-city-factor-results.json');
fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), 'utf-8');
console.log('Detailed results saved to: scripts/audit-city-factor-results.json');
console.log('To fix issues: node scripts/fix-city-factor.js\n');
