/**
 * Fix UAT housing data based on audit results
 * 
 * Removes county-level house count leaks from uat_data.js
 * by setting leaked values to 0 (so the frontend uses the minimumBase fallback).
 * 
 * Usage: node scripts/fix-uat-data.js
 */

const fs = require('fs');
const path = require('path');

// ── Load audit results ────────────────────────────────────────
const auditFile = path.join(__dirname, 'audit-results.json');
if (!fs.existsSync(auditFile)) {
    console.error('audit-results.json not found. Run audit-uat-data.js first.');
    process.exit(1);
}
const audit = JSON.parse(fs.readFileSync(auditFile, 'utf-8'));

// ── Load current uat_data.js ──────────────────────────────────
const dataPath = path.join(__dirname, '..', 'uat_data.js');
const dataSource = fs.readFileSync(dataPath, 'utf-8');
const match = dataSource.match(/const\s+UAT_DATA\s*=\s*(\{[\s\S]*\});/);
if (!match) { console.error('Could not parse uat_data.js'); process.exit(1); }
const UAT_DATA = JSON.parse(match[1]);

// ── Apply fixes ───────────────────────────────────────────────
let fixedCount = 0;

// Fix 1: County-level house count leaks → set houses to 0
for (const item of audit.issues.countyLeak) {
    const { county, name } = item;
    if (UAT_DATA[county]?.[name]) {
        const old = UAT_DATA[county][name].houses;
        UAT_DATA[county][name].houses = 0;
        UAT_DATA[county][name].housesYear = null;
        fixedCount++;
        console.log(`Fixed: ${county} → ${name}: ${old} → 0`);
    }
}

// Fix 2: Add missing UATs with empty data
for (const item of audit.issues.missing) {
    const { county, name } = item;
    if (!UAT_DATA[county]) UAT_DATA[county] = {};
    if (!UAT_DATA[county][name]) {
        UAT_DATA[county][name] = { tax: 0, taxYear: null, houses: 0, housesYear: null };
        fixedCount++;
        console.log(`Added missing: ${county} → ${name}`);
    }
}

// ── Write fixed uat_data.js ───────────────────────────────────
const timestamp = new Date().toISOString().split('T')[0];

// Count totals
let totalWithData = 0;
let totalAll = 0;
for (const county of Object.keys(UAT_DATA)) {
    for (const name of Object.keys(UAT_DATA[county])) {
        totalAll++;
        const d = UAT_DATA[county][name];
        if (d.tax > 0 || d.houses > 0) totalWithData++;
    }
}

const header = `// Auto-generated UAT data from transparenta.eu\n// Generated: ${timestamp} (fixed: removed ${audit.issues.countyLeak.length} county-level house count leaks)\n// Total: ${totalWithData} UATs with data out of ${totalAll}\n`;
const content = header + `const UAT_DATA = ${JSON.stringify(UAT_DATA, null, 0)};\n`;

fs.writeFileSync(dataPath, content, 'utf-8');

// Also copy to public/
const publicPath = path.join(__dirname, '..', 'public', 'uat_data.js');
if (fs.existsSync(path.dirname(publicPath))) {
    fs.writeFileSync(publicPath, content, 'utf-8');
    console.log(`\nAlso copied to public/uat_data.js`);
}

const sizeKB = Math.round(fs.statSync(dataPath).size / 1024);
console.log(`\n═══════════════════════════════════════`);
console.log(`Done! Fixed ${fixedCount} entries.`);
console.log(`Output: ${dataPath} (${sizeKB} KB)`);
