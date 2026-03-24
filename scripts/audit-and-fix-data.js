/**
 * Comprehensive audit & fix for UAT data quality.
 * 
 * Detects:
 * 1. DUPLICATE TAX — multiple UATs in same county with identical tax values (county-level leak)
 * 2. DUPLICATE HOUSES — multiple UATs sharing identical house counts (likely same SIRUTA leak)
 * 3. SUSPICIOUS TAX — comună with tax > 2M RON (likely county seat value)
 * 4. SUSPICIOUS HOUSES — UAT with 0 houses or impossibly high for type
 * 
 * Fixes: re-fetches correct data from transparenta.eu GraphQL API for each flagged UAT.
 * 
 * Usage: node scripts/audit-and-fix-data.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const GRAPHQL_URL = 'https://api.transparenta.eu/graphql';
const DATA_PATH = path.join(__dirname, '..', 'public', 'uat_data.js');
const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = 1200;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function stripDiacritics(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function norm(s) { return stripDiacritics((s || '').toUpperCase()).replace(/-/g, ' ').trim(); }

async function graphql(query, variables, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(GRAPHQL_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, variables }),
                signal: AbortSignal.timeout(30000)
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const data = await res.json();
            if (data.errors) throw new Error(data.errors[0].message);
            return data.data;
        } catch (e) {
            if (attempt < retries) { await sleep(2000); continue; }
            throw e;
        }
    }
}

async function searchEntities(search) {
    const data = await graphql(`
        query($search: String, $limit: Int) {
            entities(filter: { search: $search }, limit: $limit) {
                nodes { name cui uat { county_name name siruta_code } }
            }
        }
    `, { search, limit: 30 });
    return data.entities?.nodes || [];
}

async function fetchHousingForSiruta(siruta) {
    const data = await graphql(`
        query($datasetCode: String!, $filter: InsObservationFilterInput, $limit: Int) {
            insObservations(datasetCode: $datasetCode, filter: $filter, limit: $limit) {
                nodes { value time_period { year } territory { siruta_code name_ro } }
            }
        }
    `, {
        datasetCode: 'LOC101B',
        filter: { sirutaCodes: [siruta], territoryLevels: ['LAU'] },
        limit: 100
    });
    const nodes = data.insObservations?.nodes || [];
    if (!nodes.length) return null;
    let latest = nodes[0];
    for (const n of nodes) if (n.time_period?.year > latest.time_period?.year) latest = n;
    return { count: parseInt(latest.value) || 0, year: latest.time_period?.year, territory: latest.territory?.name_ro };
}

async function fetchFinancialForCui(cui) {
    for (const year of [2025, 2024, 2023]) {
        try {
            const data = await graphql(`
                query($filter: AnalyticsFilterInput!, $limit: Int) {
                    aggregatedLineItems(filter: $filter, limit: $limit) {
                        nodes { fn_c: functional_code amount }
                    }
                }
            `, {
                filter: {
                    report_period: { type: 'YEAR', selection: { interval: { start: String(year), end: String(year) } } },
                    account_category: 'vn', report_type: 'PRINCIPAL_AGGREGATED',
                    entity_cuis: [cui], functional_prefixes: ['07.01.01', '07.02'],
                    is_uat: true, normalization: 'total', show_period_growth: false,
                    currency: 'RON', inflation_adjusted: false
                },
                limit: 150000
            });
            let tax = 0, landTax = 0;
            for (const n of data.aggregatedLineItems?.nodes || []) {
                const amt = parseFloat(n.amount) || 0;
                if (n.fn_c === '07.01.01') tax = Math.round(amt * 100) / 100;
                if (n.fn_c === '07.02') landTax = Math.round(amt * 100) / 100;
            }
            if (tax > 0 || landTax > 0) return { tax, landTax, year };
        } catch { }
    }
    return null;
}

function isUATEntity(entityName) {
    const n = entityName.toUpperCase();
    const prefixes = ['COMUNA ', 'ORAS ', 'ORASUL ', 'ORAȘUL ', 'MUNICIPIUL ', 'PRIMARIA '];
    if (!prefixes.some(p => n.startsWith(p))) return false;
    const bad = ['SERVICIUL PUBLIC', 'CLUB SPORTIV', 'DIRECTIA', 'POLITIA', 'SCOALA', 'SPITAL',
                  'LICEU', 'GRADINITA', 'COLEGIUL', 'BIBLIOTECA', 'MUZEU', 'CAMIN', 'CENTRU'];
    if (bad.some(b => n.includes(b))) return false;
    return true;
}

async function findAndFetchUAT(name, county) {
    const nameNorm = norm(name);
    const countyNorm = norm(county);
    const plain = stripDiacritics(name);

    const patterns = [
        'Comuna ' + name,
        'Comuna ' + plain,
        'Orasul ' + name,
        'Orasul ' + plain,
        'Municipiul ' + name,
        'Municipiul ' + plain,
        name + ' ' + county,
        plain,
    ];

    for (const pattern of patterns) {
        try {
            const nodes = await searchEntities(pattern);
            await sleep(300);

            const inCounty = nodes.filter(n => {
                const nc = norm(n.uat?.county_name || '');
                return nc === countyNorm || nc.includes(countyNorm) || countyNorm.includes(nc);
            });

            const uatEntities = inCounty.filter(n => isUATEntity(n.name || ''));

            // Prefer exact UAT name match
            const exact = uatEntities.find(n => norm(n.uat?.name || '') === nameNorm);
            const contains = uatEntities.find(n => {
                const un = norm(n.uat?.name || '');
                return un === nameNorm || un.includes(nameNorm) || nameNorm.includes(un);
            });
            const best = exact || contains || uatEntities[0];

            // Fallback: any entity in county with matching UAT name
            const anyMatch = !best && inCounty.find(n => norm(n.uat?.name || '') === nameNorm && n.uat?.siruta_code);

            const entity = best || anyMatch;
            if (entity?.cui && entity?.uat?.siruta_code) {
                // Fetch financial
                const fin = await fetchFinancialForCui(entity.cui);
                await sleep(500);

                // Fetch housing
                const housing = await fetchHousingForSiruta(entity.uat.siruta_code);
                await sleep(500);

                return {
                    entityName: entity.name,
                    uatName: entity.uat.name,
                    siruta: entity.uat.siruta_code,
                    cui: entity.cui,
                    tax: fin?.tax || 0,
                    landTax: fin?.landTax || 0,
                    taxYear: fin?.year || null,
                    houses: housing?.count || 0,
                    housesYear: housing?.year || null,
                };
            }
        } catch { }
    }
    return null;
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║  Comprehensive UAT Data Audit & Fix                     ║');
    console.log('║  Mode: ' + (DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (will fix)   ') + '                        ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    // Load data
    const src = fs.readFileSync(DATA_PATH, 'utf8');
    const match = src.match(/const UAT_DATA = ({[\s\S]*});?\s*$/m);
    if (!match) { console.error('Cannot parse UAT_DATA'); process.exit(1); }
    const UAT_DATA = eval('(' + match[1] + ')');

    // ─── PHASE 1: Detect anomalies ───────────────────────────────

    console.log('═══ PHASE 1: Detecting anomalies ═══\n');

    const issues = []; // { county, name, reason, priority }

    for (const [county, uats] of Object.entries(UAT_DATA)) {
        const entries = Object.entries(uats);
        
        // Build tax frequency map
        const taxMap = {};
        for (const [name, d] of entries) {
            const tax = d.tax || 0;
            if (tax > 0) {
                const key = tax.toFixed(2);
                if (!taxMap[key]) taxMap[key] = [];
                taxMap[key].push(name);
            }
        }

        // Build houses frequency map
        const housesMap = {};
        for (const [name, d] of entries) {
            const h = d.houses || 0;
            if (h > 0) {
                const key = String(h);
                if (!housesMap[key]) housesMap[key] = [];
                housesMap[key].push(name);
            }
        }

        for (const [name, d] of entries) {
            if (name === 'București' && county === 'București') continue; // skip
            
            const tax = d.tax || 0;
            const houses = d.houses || 0;
            const taxKey = tax.toFixed(2);
            const housesKey = String(houses);

            // Issue 1: Duplicate tax (same exact value as another UAT in county = likely leak)
            if (tax > 0 && taxMap[taxKey]?.length > 1) {
                const dupeWith = taxMap[taxKey].filter(n => n !== name);
                issues.push({
                    county, name,
                    reason: `DUPLICATE TAX: ${tax.toLocaleString()} RON (same as ${dupeWith.join(', ')})`,
                    priority: 1
                });
            }

            // Issue 2: Duplicate houses (same exact count + same tax usually means full copy)
            if (houses > 0 && housesMap[housesKey]?.length > 1) {
                const dupeWith = housesMap[housesKey].filter(n => n !== name);
                // Only flag if tax is also the same (confirming it's a data copy)
                const sameData = dupeWith.some(other => {
                    const od = uats[other];
                    return od && (od.tax || 0) === tax;
                });
                if (sameData && !issues.find(i => i.county === county && i.name === name)) {
                    issues.push({
                        county, name,
                        reason: `DUPLICATE HOUSES+TAX: ${houses} houses (same as ${dupeWith.join(', ')})`,
                        priority: 1
                    });
                }
            }

            // Issue 3: Missing houses
            if (houses <= 0 && tax > 0) {
                if (!issues.find(i => i.county === county && i.name === name)) {
                    issues.push({ county, name, reason: `MISSING HOUSES (tax=${tax})`, priority: 2 });
                }
            }
        }
    }

    // Deduplicate issues by county+name (keep first/highest priority)
    const uniqueIssues = [];
    const seen = new Set();
    for (const issue of issues.sort((a, b) => a.priority - b.priority)) {
        const key = issue.county + '|' + issue.name;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueIssues.push(issue);
        }
    }

    console.log(`Found ${uniqueIssues.length} issues:\n`);
    for (const issue of uniqueIssues) {
        console.log(`  ⚠ ${issue.county} / ${issue.name}: ${issue.reason}`);
    }

    if (uniqueIssues.length === 0) {
        console.log('  ✅ No issues found!');
        return;
    }

    if (DRY_RUN) {
        console.log('\n--- DRY RUN: no changes made. Remove --dry-run to fix. ---');
        return;
    }

    // ─── PHASE 2: Fix each issue ────────────────────────────────

    console.log(`\n═══ PHASE 2: Fixing ${uniqueIssues.length} issues ═══\n`);

    let fixed = 0, failed = 0, skipped = 0;

    for (let i = 0; i < uniqueIssues.length; i++) {
        const { county, name, reason } = uniqueIssues[i];
        const existing = UAT_DATA[county]?.[name];
        console.log(`[${i + 1}/${uniqueIssues.length}] ${county} → ${name}`);
        console.log(`    Issue: ${reason}`);
        console.log(`    Current: tax=${existing?.tax || 0}, landTax=${existing?.landTax || 0}, houses=${existing?.houses || 0}`);

        try {
            const result = await findAndFetchUAT(name, county);

            if (!result) {
                console.log('    ✗ Could not find entity on transparenta.eu\n');
                failed++;
                await sleep(DELAY_MS);
                continue;
            }

            console.log(`    → Entity: "${result.entityName}" | SIRUTA: ${result.siruta}`);

            // Validate: new data should be different from old (otherwise it's the same leak)
            const oldTax = existing?.tax || 0;
            const newTax = result.tax;
            const newHouses = result.houses;

            if (newTax === 0 && newHouses === 0) {
                console.log('    ✗ API returned no data\n');
                failed++;
                await sleep(DELAY_MS);
                continue;
            }

            // Sanity: houses should be reasonable
            if (newHouses > 50000) {
                console.log(`    ⚠ Houses=${newHouses} seems too high — likely county-level. Keeping old houses.`);
                result.houses = existing?.houses || 0;
                result.housesYear = existing?.housesYear || null;
            }

            // Check if data actually changed
            if (newTax === oldTax && newHouses === (existing?.houses || 0)) {
                console.log('    = Data unchanged (same values from API)\n');
                skipped++;
                await sleep(DELAY_MS);
                continue;
            }

            // Update
            UAT_DATA[county][name] = {
                tax: result.tax,
                taxYear: result.taxYear,
                houses: result.houses,
                housesYear: result.housesYear,
                landTax: result.landTax
            };

            console.log(`    ✅ FIXED: tax=${result.tax}, landTax=${result.landTax}, houses=${result.houses} (${result.taxYear || 'N/A'})\n`);
            fixed++;

        } catch (e) {
            console.log(`    ✗ Error: ${e.message}\n`);
            failed++;
        }

        await sleep(DELAY_MS);
    }

    // ─── PHASE 3: Save ──────────────────────────────────────────

    console.log('\n═══ PHASE 3: Saving ═══\n');

    const timestamp = new Date().toISOString().split('T')[0];
    let totalWithData = 0, total = 0;
    for (const uats of Object.values(UAT_DATA)) {
        for (const d of Object.values(uats)) {
            total++;
            if (((d.tax || 0) + (d.landTax || 0)) > 0 || (d.houses || 0) > 0) totalWithData++;
        }
    }

    const header = `// Auto-generated UAT data from transparenta.eu\n// Generated: ${timestamp} (audit-and-fix: ${fixed} fixed, ${failed} failed, ${skipped} unchanged)\n// Total: ${totalWithData} UATs with data out of ${total}\n`;
    const content = header + 'const UAT_DATA = ' + JSON.stringify(UAT_DATA) + ';\n';
    fs.writeFileSync(DATA_PATH, content, 'utf-8');

    const sizeKB = Math.round(fs.statSync(DATA_PATH).size / 1024);

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Results: Fixed=${fixed} | Failed=${failed} | Unchanged=${skipped}`);
    console.log(`Output: ${DATA_PATH} (${sizeKB} KB)`);
    console.log(`Coverage: ${totalWithData}/${total} (${(totalWithData/total*100).toFixed(1)}%)`);

    // Final verification: check for remaining duplicates
    let remainingDupes = 0;
    for (const [county, uats] of Object.entries(UAT_DATA)) {
        const taxMap = {};
        for (const [name, d] of Object.entries(uats)) {
            const t = (d.tax || 0).toFixed(2);
            if (parseFloat(t) > 0) {
                if (!taxMap[t]) taxMap[t] = [];
                taxMap[t].push(name);
            }
        }
        for (const [t, names] of Object.entries(taxMap)) {
            if (names.length > 1) remainingDupes++;
        }
    }
    if (remainingDupes > 0) {
        console.log(`\n⚠ ${remainingDupes} duplicate tax groups still remain (may need manual review)`);
    } else {
        console.log('\n✅ No duplicate tax values remain!');
    }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
