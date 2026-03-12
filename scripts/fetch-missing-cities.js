/**
 * Fetch housing data for the 12 cities that the proxy couldn't resolve.
 * Uses direct GraphQL search with county-based filtering to get correct SIRUTA,
 * then fetches INS LOC101B housing data with that exact SIRUTA.
 *
 * Usage: node scripts/fetch-missing-cities.js
 */

const fs = require('fs');
const path = require('path');

const GRAPHQL_URL = 'https://api.transparenta.eu/graphql';
const base = path.join(__dirname, '..');
const DELAY_MS = 1200;

// The 12 problematic cities (from audit-city-factor-results.json)
const MISSING = [
    { county: 'Argeș', name: 'Ștefănești', tip: 'oraș' },
    { county: 'Botoșani', name: 'Săveni', tip: 'oraș' },
    { county: 'Botoșani', name: 'Ștefănești', tip: 'oraș' },
    { county: 'București', name: 'București', tip: 'municipiu' },
    { county: 'Dâmbovița', name: 'Găești', tip: 'oraș' },
    { county: 'Ialomița', name: 'Căzănești', tip: 'oraș' },
    { county: 'Satu Mare', name: 'Tășnad', tip: 'oraș' },
    { county: 'Sibiu', name: 'Săliște', tip: 'oraș' },
    { county: 'Suceava', name: 'Milișăuți', tip: 'oraș' },
    { county: 'Timiș', name: 'Făget', tip: 'oraș' },
    { county: 'Tulcea', name: 'Măcin', tip: 'oraș' },
    { county: 'Vrancea', name: 'Mărășești', tip: 'oraș' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function removeDiacritics(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function norm(s) { return removeDiacritics((s || '').toUpperCase()).replace(/-/g, ' ').trim(); }

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
    for (const year of [2025, 2024, 2023, 2022]) {
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
                    functional_prefixes: ['07.01.01'],
                    is_uat: true, normalization: 'total', show_period_growth: false,
                    currency: 'RON', inflation_adjusted: false
                },
                limit: 150000
            });
            for (const n of data.aggregatedLineItems?.nodes || []) {
                if (n.fn_c === '07.01.01' && parseFloat(n.amount) > 0) {
                    return { tax: Math.round(parseFloat(n.amount) * 100) / 100, year };
                }
            }
        } catch { }
    }
    return null;
}

// Find entity with county-based filtering (key improvement over proxy)
async function findEntityForCity(name, county, tip) {
    const countyNorm = norm(county);
    const nameNorm = norm(name);
    const plain = removeDiacritics(name);
    const typePrefix = tip === 'municipiu' ? 'MUNICIPIUL' : 'ORASUL';

    // Search patterns: try multiple to maximize chances
    const patterns = [
        typePrefix + ' ' + name,
        typePrefix + ' ' + plain,
        'Primaria ' + name + ' ' + county,
        'Primaria ' + name,
        name + ' ' + county,
        plain + ' ' + county,
    ];

    const BAD_KEYWORDS = ['SCOALA', 'SPITAL', 'LICEU', 'TRIBUNAL', 'JUDECATORIA', 'DIRECTIA', 'POLITIA'];

    for (const pattern of patterns) {
        try {
            const nodes = await searchEntities(pattern);
            await sleep(300);

            // Filter: must be in correct county
            const inCounty = nodes.filter(n => {
                const nodeCounty = norm(n.uat?.county_name || '');
                // Match county: either exact or contains
                return nodeCounty === countyNorm || nodeCounty.includes(countyNorm) || countyNorm.includes(nodeCounty);
            }).filter(n => {
                // Not blacklisted
                const nm = (n.name || '').toUpperCase();
                return !BAD_KEYWORDS.some(kw => nm.includes(kw));
            });

            if (inCounty.length === 0) continue;

            // Prefer exact UAT name match
            const exact = inCounty.find(n => norm(n.uat?.name || '') === nameNorm);
            const contains = inCounty.find(n => norm(n.uat?.name || '').includes(nameNorm) || nameNorm.includes(norm(n.uat?.name || '')));
            const best = exact || contains || inCounty[0];

            if (best && best.uat?.siruta_code) {
                return { cui: best.cui, siruta: best.uat.siruta_code, entityName: best.name, uatName: best.uat.name };
            }
        } catch (e) {
            console.log('    Error for "' + pattern + '": ' + e.message);
        }
    }
    return null;
}

async function main() {
    console.log('╔═════════════════════════════════════════════════════════╗');
    console.log('║   Fetch Housing Data for 12 Cities (County-Filtered)   ║');
    console.log('╚═════════════════════════════════════════════════════════╝\n');

    // Load uat_data.js
    const dataPath = path.join(base, 'uat_data.js');
    const dataSrc = fs.readFileSync(dataPath, 'utf-8');
    const match = dataSrc.match(/const\s+UAT_DATA\s*=\s*(\{[\s\S]*\});/);
    const UAT_DATA = JSON.parse(match[1]);

    let fixed = 0;
    let failed = 0;
    const results = [];

    for (let i = 0; i < MISSING.length; i++) {
        const { county, name, tip } = MISSING[i];
        process.stdout.write('[' + (i + 1) + '/' + MISSING.length + '] ' + county + ' → ' + name + ' (' + tip + ')... ');

        // Special case: București — find the city-level entity differently
        if (name === 'București' && county === 'București') {
            // București doesn't have a single city-level LAU housing entry in INS
            // It's split into sectors. Skip with explanation.
            console.log('⚠ Skipping București: data is at sector level, not city level');
            failed++;
            results.push({ county, name, status: 'skipped', reason: 'sector-level data only' });
            continue;
        }

        try {
            const entity = await findEntityForCity(name, county, tip);

            if (!entity) {
                console.log('✗ No entity found in county ' + county);
                failed++;
                results.push({ county, name, status: 'failed', reason: 'no entity in county' });
                await sleep(DELAY_MS);
                continue;
            }

            console.log('\n    → Entity: "' + entity.entityName + '" | UAT: ' + entity.uatName + ' | SIRUTA: ' + entity.siruta);

            // Validate: housing count must be reasonable
            const maxHouses = tip === 'municipiu' ? 200000 : 50000;

            // Fetch housing
            const housing = await fetchHousingForSiruta(entity.siruta);
            await sleep(DELAY_MS);

            if (!housing || housing.count === 0) {
                console.log('    ✗ No INS housing data for SIRUTA=' + entity.siruta);
                failed++;
                results.push({ county, name, status: 'failed', reason: 'no INS data', siruta: entity.siruta });
                continue;
            }

            if (housing.count > maxHouses) {
                console.log('    ⚠ Housing count ' + housing.count + ' > max ' + maxHouses + ' — county leak, skipping');
                failed++;
                results.push({ county, name, status: 'failed', reason: 'county leak: ' + housing.count });
                continue;
            }

            // Fetch tax if missing
            const existing = UAT_DATA[county]?.[name];
            let finalTax = existing?.tax || 0;
            let finalTaxYear = existing?.taxYear || null;

            if (!finalTax && entity.cui) {
                const fin = await fetchFinancialForCui(entity.cui);
                await sleep(DELAY_MS);
                if (fin) { finalTax = fin.tax; finalTaxYear = fin.year; }
            }

            // Update UAT_DATA
            if (!UAT_DATA[county]) UAT_DATA[county] = {};
            UAT_DATA[county][name] = {
                tax: finalTax,
                taxYear: finalTaxYear,
                houses: housing.count,
                housesYear: housing.year
            };

            const eff = Math.round(housing.count * 0.6);
            const minBase = (eff * 150).toLocaleString();
            console.log('    ✓ houses=' + housing.count + ' (' + housing.year + ') → 60%=' + eff + ' → minBase=' + minBase + ' RON | territory="' + housing.territory + '"');
            fixed++;
            results.push({ county, name, status: 'fixed', houses: housing.count, year: housing.year, territory: housing.territory });

        } catch (e) {
            console.log('    ✗ Error: ' + e.message);
            failed++;
            results.push({ county, name, status: 'failed', reason: e.message });
        }

        await sleep(DELAY_MS);
    }

    // Write updated uat_data.js
    const timestamp = new Date().toISOString().split('T')[0];

    const uatSrc = fs.readFileSync(path.join(base, 'romania_uat.js'), 'utf-8');
    const matchUat = uatSrc.match(/const\s+ROMANIA_UAT\s*=\s*(\{[\s\S]*\});/);
    const ROMANIA_UAT = new Function('return ' + matchUat[1])();
    let totalWithData = 0, totalAll = 0;
    for (const c of Object.keys(ROMANIA_UAT)) {
        for (const u of Object.keys(ROMANIA_UAT[c])) {
            totalAll++;
            const d = UAT_DATA[c]?.[u];
            if (d && (d.tax > 0 || d.houses > 0)) totalWithData++;
        }
    }

    const header = '// Auto-generated UAT data from transparenta.eu\n'
        + '// Generated: ' + timestamp + ' (fetch-missing-cities: ' + fixed + ' new housing records)\n'
        + '// Total: ' + totalWithData + ' UATs with data out of ' + totalAll + '\n';
    const content = header + 'const UAT_DATA = ' + JSON.stringify(UAT_DATA, null, 0) + ';\n';

    fs.writeFileSync(dataPath, content, 'utf-8');

    const publicPath = path.join(base, 'public', 'uat_data.js');
    if (fs.existsSync(path.dirname(publicPath))) {
        fs.writeFileSync(publicPath, content, 'utf-8');
        console.log('\nCopied to public/uat_data.js');
    }

    const sizeKB = Math.round(fs.statSync(dataPath).size / 1024);
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('Done!  Fixed: ' + fixed + '  |  Failed: ' + failed);
    console.log('Output: ' + dataPath + ' (' + sizeKB + ' KB)');

    if (failed > 0) {
        console.log('\nFailed entries:');
        results.filter(r => r.status !== 'fixed').forEach(r => {
            console.log('  ' + r.county + ' → ' + r.name + ': ' + r.reason);
        });
    }

    console.log('\nRun audit-city-factor.js to verify.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
