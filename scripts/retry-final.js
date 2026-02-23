/**
 * Final aggressive retry: searches with type prefix (MUNICIPIUL, ORAȘUL, COMUNA)
 * and other strategies for the remaining missing UATs.
 */

const fs = require('fs');
const path = require('path');

const PROXY = 'http://localhost:3001';
const GRAPHQL_URL = 'https://api.transparenta.eu/graphql';
const DELAY_MS = 1200;
const OUTPUT_FILE = path.join(__dirname, '..', 'uat_data.js');

// Load romania_uat.js
const uatSource = fs.readFileSync(path.join(__dirname, '..', 'romania_uat.js'), 'utf-8');
const match = uatSource.match(/const\s+ROMANIA_UAT\s*=\s*(\{[\s\S]*\});/);
const ROMANIA_UAT = eval('(' + match[1] + ')');

// Load existing uat_data.js
const dataSource = fs.readFileSync(OUTPUT_FILE, 'utf-8');
const dataMatch = dataSource.match(/const\s+UAT_DATA\s*=\s*(\{[\s\S]*\});/);
const UAT_DATA = JSON.parse(dataMatch[1]);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function removeDiacritics(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

// Type prefix map
const TYPE_PREFIX = {
    'municipiu': 'MUNICIPIUL',
    'oraș': 'ORAȘUL',
    'comună': 'COMUNA'
};

async function graphql(query, variables) {
    const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`GraphQL ${res.status}`);
    const data = await res.json();
    if (data.errors) throw new Error(data.errors[0].message);
    return data.data;
}

// Search directly via GraphQL with various name patterns
async function searchEntity(patterns) {
    for (const pattern of patterns) {
        try {
            const data = await graphql(`
                query EntitySearch($search: String, $limit: Int) {
                    entities(filter: { search: $search }, limit: $limit) {
                        nodes { name cui uat { county_name name siruta_code } }
                    }
                }
            `, { search: pattern, limit: 5 });

            const nodes = data.entities?.nodes || [];
            // Return first match that has a UAT
            const match = nodes.find(n => n.uat?.siruta_code);
            if (match) return match;
        } catch { }
        await sleep(500);
    }
    return null;
}

async function fetchFinancialForCui(cui) {
    const years = [2025, 2024, 2023, 2022];
    for (const year of years) {
        try {
            const data = await graphql(`
                query AggregatedLineItems($filter: AnalyticsFilterInput!, $limit: Int) {
                    aggregatedLineItems(filter: $filter, limit: $limit) {
                        nodes { fn_c: functional_code amount }
                    }
                }
            `, {
                filter: {
                    report_period: { type: "YEAR", selection: { interval: { start: String(year), end: String(year) } } },
                    account_category: "vn",
                    report_type: "PRINCIPAL_AGGREGATED",
                    entity_cuis: [cui],
                    functional_prefixes: ["07.01.01"],
                    is_uat: true,
                    normalization: "total",
                    show_period_growth: false,
                    currency: "RON",
                    inflation_adjusted: false
                },
                limit: 150000
            });
            const nodes = data.aggregatedLineItems?.nodes || [];
            for (const n of nodes) {
                if (n.fn_c === '07.01.01' && parseFloat(n.amount) > 0) {
                    return { tax: Math.round(parseFloat(n.amount) * 100) / 100, year };
                }
            }
        } catch { }
    }
    return null;
}

async function fetchHousingForSiruta(siruta) {
    try {
        const data = await graphql(`
            query InsObservations($datasetCode: String!, $filter: InsObservationFilterInput, $limit: Int) {
                insObservations(datasetCode: $datasetCode, filter: $filter, limit: $limit) {
                    nodes { value time_period { year } territory { name_ro } }
                }
            }
        `, {
            datasetCode: "LOC101B",
            filter: { sirutaCodes: [siruta], territoryLevels: ["LAU"] },
            limit: 100
        });
        const nodes = data.insObservations?.nodes || [];
        if (nodes.length === 0) return null;
        let latest = nodes[0];
        for (const n of nodes) {
            if (n.time_period?.year > latest.time_period?.year) latest = n;
        }
        return { count: parseInt(latest.value) || 0, year: latest.time_period?.year };
    } catch { return null; }
}

async function main() {
    // Find truly missing UATs (no data at all or tax=0 and houses=0)
    const missing = [];
    for (const county of Object.keys(ROMANIA_UAT).sort()) {
        for (const uat of Object.keys(ROMANIA_UAT[county]).sort()) {
            const existing = UAT_DATA[county]?.[uat];
            if (!existing || (existing.tax === 0 && existing.houses === 0)) {
                const info = ROMANIA_UAT[county][uat];
                missing.push({ county, uat, tip: info.tip });
            }
        }
    }

    console.log(`${missing.length} UATs to retry with aggressive search\n`);
    console.log('Strategies: type prefix, plain name, diacritics removal, direct API\n');

    let found = 0;
    let stillMissing = 0;
    const notFound = [];

    for (let i = 0; i < missing.length; i++) {
        const { county, uat, tip } = missing[i];
        const prefix = TYPE_PREFIX[tip] || '';
        const plain = removeDiacritics(uat);

        process.stdout.write(`[${i + 1}/${missing.length}] ${county} → ${uat} (${tip})... `);

        // Generate search patterns (most specific first)
        const patterns = [
            `${prefix} ${uat}`,                           // MUNICIPIUL Iași
            `${prefix} ${plain}`,                          // MUNICIPIUL Iasi
            `${uat} ${county}`,                            // Iași Iași
            `${plain} ${county}`,                          // Iasi Iasi
            `primaria ${uat}`,                             // primaria Iași
            `${prefix} ${uat.split(/[\s-]/)[0]} ${county}` // MUNICIPIUL Iași Iași
        ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

        const entity = await searchEntity(patterns);

        if (entity) {
            const cui = entity.cui;
            const siruta = entity.uat?.siruta_code;

            // Fetch financial + housing
            const [fin, housing] = await Promise.all([
                fetchFinancialForCui(cui),
                siruta ? fetchHousingForSiruta(siruta) : null
            ]);

            if (fin || housing) {
                const result = {
                    tax: fin?.tax || 0,
                    taxYear: fin?.year || null,
                    houses: housing?.count || 0,
                    housesYear: housing?.year || null
                };

                if (!UAT_DATA[county]) UAT_DATA[county] = {};
                UAT_DATA[county][uat] = result;
                found++;
                console.log(`✓ FOUND! (${entity.name}) ${result.tax.toLocaleString()} RON, ${result.houses} houses`);
            } else {
                stillMissing++;
                notFound.push(`${county} → ${uat} (${tip}) [entity found: ${entity.name}, CUI: ${cui}, but no fn:07.01.01 data]`);
                console.log(`✗ entity found (${entity.name}) but no fn:07.01.01 data`);
            }
        } else {
            stillMissing++;
            notFound.push(`${county} → ${uat} (${tip}) [no entity found]`);
            console.log(`✗ no entity found`);
        }

        await sleep(DELAY_MS);
    }

    // Write updated file
    const timestamp = new Date().toISOString().split('T')[0];
    let totalWithData = 0, totalAll = 0;
    for (const county of Object.keys(ROMANIA_UAT)) {
        for (const uat of Object.keys(ROMANIA_UAT[county])) {
            totalAll++;
            if (UAT_DATA[county]?.[uat] && (UAT_DATA[county][uat].tax > 0 || UAT_DATA[county][uat].houses > 0)) {
                totalWithData++;
            }
        }
    }

    const header = `// Auto-generated UAT data from transparenta.eu\n// Generated: ${timestamp}\n// Total: ${totalWithData} UATs with data out of ${totalAll}\n`;
    fs.writeFileSync(OUTPUT_FILE, header + `const UAT_DATA = ${JSON.stringify(UAT_DATA, null, 0)};\n`, 'utf-8');

    const sizeKB = Math.round(fs.statSync(OUTPUT_FILE).size / 1024);
    console.log(`\n============================`);
    console.log(`Retry complete! Found ${found} new, ${stillMissing} still missing`);
    console.log(`Total: ${totalWithData}/${totalAll} UATs with data`);
    console.log(`Output: ${OUTPUT_FILE} (${sizeKB} KB)`);

    if (notFound.length > 0) {
        console.log(`\nStill missing:`);
        notFound.forEach(s => console.log(`  - ${s}`));
    }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
