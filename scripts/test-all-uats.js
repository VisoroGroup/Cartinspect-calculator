/**
 * Tests ALL 3200+ UATs to verify the proxy can find and return data for each.
 * Reports which UATs are missing financial data, housing data, or both.
 *
 * Usage: node scripts/test-all-uats.js
 * Requires: local proxy running on port 3001
 *
 * Output: scripts/test-all-uats-results.json
 */

const fs = require('fs');
const path = require('path');

const PROXY = 'http://localhost:3001';
const DELAY_MS = 500; // Delay between requests
const OUTPUT_FILE = path.join(__dirname, 'test-all-uats-results.json');

// Load romania_uat.js to get all UATs
const uatSource = fs.readFileSync(path.join(__dirname, '..', 'romania_uat.js'), 'utf-8');
const match = uatSource.match(/const\s+ROMANIA_UAT\s*=\s*(\{[\s\S]*\});/);
if (!match) { console.error('Could not parse romania_uat.js'); process.exit(1); }
const ROMANIA_UAT = new Function('return ' + match[1])();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function testUAT(county, name) {
    try {
        const url = `${PROXY}/api/entity-data?county=${encodeURIComponent(county)}&name=${encodeURIComponent(name)}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) {
            const body = await res.text();
            return { status: 'error', httpStatus: res.status, error: body };
        }
        const data = await res.json();
        return {
            status: 'ok',
            entityName: data.entity?.name || null,
            hasFinancial: !!(data.financial && data.financial.total > 0),
            financialTotal: data.financial?.total || 0,
            financialYear: data.financial?.year || null,
            hasHousing: !!(data.housing && data.housing.count > 0),
            housingCount: data.housing?.count || 0
        };
    } catch (err) {
        return { status: 'error', error: err.message };
    }
}

async function main() {
    const counties = Object.keys(ROMANIA_UAT).sort();
    let totalUATs = 0;
    for (const county of counties) {
        totalUATs += Object.keys(ROMANIA_UAT[county]).length;
    }

    console.log(`Testing ALL ${totalUATs} UATs against proxy`);
    console.log(`Estimated time: ~${Math.round(totalUATs * DELAY_MS / 60000)} minutes\n`);

    const results = {
        timestamp: new Date().toISOString(),
        totalUATs,
        ok: { financial: 0, housing: 0, both: 0, noFinancial: 0, noHousing: 0, neither: 0 },
        errors: 0,
        missingFinancial: [],
        missingHousing: [],
        failedCompletely: [],
        details: {}
    };

    let count = 0;
    for (const county of counties) {
        results.details[county] = {};
        const uats = Object.keys(ROMANIA_UAT[county]).sort();

        for (const uat of uats) {
            count++;
            const tip = ROMANIA_UAT[county][uat].tip;
            const prefix = `[${count}/${totalUATs}]`;

            const result = await testUAT(county, uat);
            results.details[county][uat] = result;

            if (result.status === 'error') {
                results.errors++;
                results.failedCompletely.push({ county, uat, tip, error: result.error });
                process.stdout.write(`${prefix} ${county} → ${uat} ✗ ERROR\n`);
            } else {
                const hasFin = result.hasFinancial;
                const hasHou = result.hasHousing;

                if (hasFin && hasHou) {
                    results.ok.both++;
                } else if (hasFin && !hasHou) {
                    results.ok.financial++;
                    results.ok.noHousing++;
                    results.missingHousing.push({ county, uat, tip });
                } else if (!hasFin && hasHou) {
                    results.ok.housing++;
                    results.ok.noFinancial++;
                    results.missingFinancial.push({ county, uat, tip });
                } else {
                    results.ok.neither++;
                    results.missingFinancial.push({ county, uat, tip });
                    results.missingHousing.push({ county, uat, tip });
                    results.failedCompletely.push({ county, uat, tip, error: 'no data at all' });
                }

                // Only print failures and municipalities for brevity
                if (!hasFin && (tip === 'municipiu' || tip === 'oraș')) {
                    process.stdout.write(`${prefix} ${county} → ${uat} (${tip}) ⚠ NO FINANCIAL - entity: ${result.entityName || 'null'}\n`);
                } else if (!hasFin && !hasHou) {
                    process.stdout.write(`${prefix} ${county} → ${uat} ✗ NO DATA\n`);
                } else if (count % 100 === 0) {
                    // Progress indicator every 100
                    process.stdout.write(`${prefix} ${county} → ${uat} ✓\n`);
                }
            }

            await sleep(DELAY_MS);
        }
    }

    // Summary
    const totalWithBoth = results.ok.both;
    const totalWithFinancial = results.ok.both + results.ok.financial;
    const totalWithHousing = results.ok.both + results.ok.housing;
    const missingFinMunicipii = results.missingFinancial.filter(m => m.tip === 'municipiu');
    const missingFinOrase = results.missingFinancial.filter(m => m.tip === 'oraș');

    console.log(`\n${'='.repeat(60)}`);
    console.log(`TEST RESULTS - ${new Date().toISOString()}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Total UATs tested: ${totalUATs}`);
    console.log(`Both financial + housing: ${totalWithBoth} (${(totalWithBoth/totalUATs*100).toFixed(1)}%)`);
    console.log(`Financial data: ${totalWithFinancial} (${(totalWithFinancial/totalUATs*100).toFixed(1)}%)`);
    console.log(`Housing data: ${totalWithHousing} (${(totalWithHousing/totalUATs*100).toFixed(1)}%)`);
    console.log(`Missing financial: ${results.missingFinancial.length}`);
    console.log(`  - Municipii: ${missingFinMunicipii.length} → ${missingFinMunicipii.map(m => m.uat).join(', ') || 'none'}`);
    console.log(`  - Orașe: ${missingFinOrase.length} → ${missingFinOrase.map(m => m.uat).join(', ') || 'none'}`);
    console.log(`Missing housing: ${results.missingHousing.length}`);
    console.log(`Complete failures (no data): ${results.failedCompletely.length}`);
    console.log(`API errors: ${results.errors}`);

    // Write detailed results (without the full details to keep it small)
    const summary = { ...results };
    delete summary.details; // Don't save 3200+ entries to JSON
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(summary, null, 2), 'utf-8');
    console.log(`\nResults saved to: ${OUTPUT_FILE}`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
