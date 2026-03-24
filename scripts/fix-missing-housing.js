/**
 * Fix missing housing data for 12 UATs.
 * Searches transparenta.eu GraphQL for SIRUTA codes, then fetches INS LOC101B housing data.
 * Also fixes suspicious tax values (county-level leaks).
 */

const fs = require('fs');
const path = require('path');

const GRAPHQL_URL = 'https://api.transparenta.eu/graphql';
const DATA_PATH = path.join(__dirname, '..', 'public', 'uat_data.js');
const DELAY_MS = 1500;

const MISSING = [
    { county: 'Arad', name: 'Hășmaș', tip: 'comună' },
    { county: 'Arad', name: 'Mișca', tip: 'comună' },
    { county: 'Botoșani', name: 'Nicșeni', tip: 'comună' },
    { county: 'București', name: 'București', tip: 'municipiu' },
    { county: 'Giurgiu', name: 'Malu', tip: 'comună' },
    { county: 'Giurgiu', name: 'Mârșa', tip: 'comună' },
    { county: 'Mureș', name: 'Gălești', tip: 'comună' },
    { county: 'Neamț', name: 'Dămuc', tip: 'comună' },
    { county: 'Suceava', name: 'Grămești', tip: 'comună' },
    { county: 'Suceava', name: 'Moara', tip: 'comună' },
    { county: 'Suceava', name: 'Mușenița', tip: 'comună' },
    { county: 'Suceava', name: 'Mălini', tip: 'comună' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function stripDiacritics(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function norm(s) { return stripDiacritics((s || '').toUpperCase()).replace(/-/g, ' ').trim(); }

async function graphql(query, variables) {
    const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error('GraphQL ' + res.status);
    const data = await res.json();
    if (data.errors) throw new Error(data.errors[0].message);
    return data.data;
}

async function searchEntities(search) {
    const data = await graphql(`
        query EntitySearch($search: String, $limit: Int) {
            entities(filter: { search: $search }, limit: $limit) {
                nodes { name cui uat { county_name name siruta_code } }
            }
        }
    `, { search, limit: 30 });
    return data.entities?.nodes || [];
}

async function fetchHousingForSiruta(siruta) {
    const data = await graphql(`
        query InsObservations($datasetCode: String!, $filter: InsObservationFilterInput, $limit: Int) {
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
                query AggregatedLineItems($filter: AnalyticsFilterInput!, $limit: Int) {
                    aggregatedLineItems(filter: $filter, limit: $limit) {
                        nodes { fn_c: functional_code amount }
                    }
                }
            `, {
                filter: {
                    report_period: { type: 'YEAR', selection: { interval: { start: String(year), end: String(year) } } },
                    account_category: 'vn',
                    report_type: 'PRINCIPAL_AGGREGATED',
                    entity_cuis: [cui],
                    functional_prefixes: ['07.01.01', '07.02'],
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
    const bad = ['SERVICIUL PUBLIC', 'CLUB SPORTIV', 'DIRECTIA', 'POLITIA', 'SCOALA', 'SPITAL', 'LICEU'];
    if (bad.some(b => n.includes(b))) return false;
    return true;
}

async function findEntity(name, county, tip) {
    const nameNorm = norm(name);
    const countyNorm = norm(county);
    const plain = stripDiacritics(name);
    const prefix = tip === 'municipiu' ? 'Municipiul' : tip === 'oraș' ? 'Orasul' : 'Comuna';

    const patterns = [
        prefix + ' ' + name,
        prefix + ' ' + plain,
        'Comuna ' + name,
        'Comuna ' + plain,
        name + ' ' + county,
        plain,
    ];

    for (const pattern of patterns) {
        try {
            const nodes = await searchEntities(pattern);
            await sleep(300);

            // Filter by county
            const inCounty = nodes.filter(n => {
                const nc = norm(n.uat?.county_name || '');
                return nc === countyNorm || nc.includes(countyNorm) || countyNorm.includes(nc);
            });

            // Filter to UAT entities
            const uatEntities = inCounty.filter(n => isUATEntity(n.name || ''));

            // Prefer exact name match
            const exact = uatEntities.find(n => norm(n.uat?.name || '') === nameNorm);
            const contains = uatEntities.find(n => {
                const un = norm(n.uat?.name || '');
                return un.includes(nameNorm) || nameNorm.includes(un);
            });
            const best = exact || contains || uatEntities[0];

            if (best?.uat?.siruta_code) {
                return { cui: best.cui, siruta: best.uat.siruta_code, entityName: best.name, uatName: best.uat.name };
            }

            // Fallback: any entity in county with correct UAT name
            const anyMatch = inCounty.find(n => norm(n.uat?.name || '') === nameNorm && n.uat?.siruta_code);
            if (anyMatch) {
                return { cui: anyMatch.cui, siruta: anyMatch.uat.siruta_code, entityName: anyMatch.name, uatName: anyMatch.uat.name };
            }
        } catch (e) {
            console.log('    ⚠ Search error for "' + pattern + '": ' + e.message);
        }
    }
    return null;
}

async function main() {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  Fix Missing Housing Data — 12 UATs             ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    // Load UAT_DATA
    const src = fs.readFileSync(DATA_PATH, 'utf8');
    const match = src.match(/const UAT_DATA = ({[\s\S]*});?\s*$/m);
    if (!match) { console.error('Cannot parse UAT_DATA'); process.exit(1); }
    const UAT_DATA = eval('(' + match[1] + ')');

    let fixed = 0, failed = 0;

    for (let i = 0; i < MISSING.length; i++) {
        const { county, name, tip } = MISSING[i];
        const existing = UAT_DATA[county]?.[name];
        console.log(`[${i + 1}/${MISSING.length}] ${county} → ${name} (${tip})`);
        console.log(`    Current: tax=${existing?.tax || 0}, landTax=${existing?.landTax || 0}, houses=${existing?.houses || 0}`);

        // Skip București — sector-level data
        if (name === 'București' && county === 'București') {
            console.log('    ⚠ SKIP: București — sector-level data on transparenta.eu\n');
            failed++;
            continue;
        }

        try {
            const entity = await findEntity(name, county, tip);
            if (!entity) {
                console.log('    ✗ No entity found\n');
                failed++;
                await sleep(DELAY_MS);
                continue;
            }
            console.log(`    → Entity: "${entity.entityName}" | UAT: ${entity.uatName} | SIRUTA: ${entity.siruta}`);

            // Fetch housing
            const housing = await fetchHousingForSiruta(entity.siruta);
            await sleep(800);

            if (!housing || housing.count === 0) {
                console.log('    ✗ No INS housing data for SIRUTA=' + entity.siruta + '\n');
                failed++;
                await sleep(DELAY_MS);
                continue;
            }

            // Sanity check
            const maxHouses = tip === 'municipiu' ? 200000 : 15000;
            if (housing.count > maxHouses) {
                console.log(`    ⚠ Housing ${housing.count} > max ${maxHouses} — likely county-level leak, skipping\n`);
                failed++;
                await sleep(DELAY_MS);
                continue;
            }

            console.log(`    ✓ HOUSING: ${housing.count} (${housing.year}) — "${housing.territory}"`);

            // Also fix suspicious tax values — check if it's a county-level leak
            let tax = existing?.tax || 0;
            let landTax = existing?.landTax || 0;
            let taxYear = existing?.taxYear || null;

            // If tax seems suspiciously high for a comună (> 5M), re-fetch
            const suspiciousTax = tip === 'comună' && tax > 5000000;
            if (suspiciousTax) {
                console.log(`    ⚠ Tax ${tax} seems too high for a comună — re-fetching...`);
                const fin = await fetchFinancialForCui(entity.cui);
                await sleep(800);
                if (fin) {
                    tax = fin.tax;
                    landTax = fin.landTax;
                    taxYear = fin.year;
                    console.log(`    ✓ FIXED TAX: ${tax} + landTax=${landTax} (${taxYear})`);
                } else {
                    console.log('    ✗ Could not re-fetch financial data');
                }
            }

            // Update
            if (!UAT_DATA[county]) UAT_DATA[county] = {};
            UAT_DATA[county][name] = {
                tax,
                taxYear,
                houses: housing.count,
                housesYear: housing.year,
                landTax
            };
            fixed++;
            console.log(`    ✅ DONE: houses=${housing.count}, tax=${tax}, landTax=${landTax}\n`);

        } catch (e) {
            console.log('    ✗ Error: ' + e.message + '\n');
            failed++;
        }

        await sleep(DELAY_MS);
    }

    // Save
    const timestamp = new Date().toISOString().split('T')[0];
    let totalWithData = 0, total = 0;
    for (const [c, uats] of Object.entries(UAT_DATA)) {
        for (const [u, d] of Object.entries(uats)) {
            total++;
            if (((d.tax || 0) + (d.landTax || 0)) > 0 || (d.houses || 0) > 0) totalWithData++;
        }
    }

    const header = `// Auto-generated UAT data from transparenta.eu\n// Generated: ${timestamp} (fix-missing-housing: +${fixed} housing records)\n// Total: ${totalWithData} UATs with data out of ${total}\n`;
    const content = header + 'const UAT_DATA = ' + JSON.stringify(UAT_DATA) + ';\n';
    fs.writeFileSync(DATA_PATH, content, 'utf-8');

    console.log('═══════════════════════════════════════════════════');
    console.log(`Done!  Fixed: ${fixed}  |  Failed: ${failed}`);
    console.log(`Output: ${DATA_PATH} (${Math.round(fs.statSync(DATA_PATH).size / 1024)} KB)`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
