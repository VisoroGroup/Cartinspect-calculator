/**
 * Find and fix the 2 remaining UATs without landTax:
 * - Dâmbovița / Dragodana
 * - Iași / Alexandru I.cuza
 */
const fs = require('fs');
const path = require('path');

const GRAPHQL_URL = 'https://api.transparenta.eu/graphql';
const DATA_PATH = path.join(__dirname, '..', 'public', 'uat_data.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function graphql(query, variables) {
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
}

async function search(term) {
    const data = await graphql(
        'query($s:String,$l:Int){entities(filter:{search:$s},limit:$l){nodes{name cui uat{county_name name siruta_code}}}}',
        { s: term, l: 20 }
    );
    return data.entities?.nodes || [];
}

async function fetchFinancial(cui) {
    for (const year of [2025, 2024, 2023]) {
        try {
            const data = await graphql(
                'query($f:AnalyticsFilterInput!,$l:Int){aggregatedLineItems(filter:$f,limit:$l){nodes{fn_c:functional_code amount}}}',
                {
                    f: {
                        report_period: { type: 'YEAR', selection: { interval: { start: String(year), end: String(year) } } },
                        account_category: 'vn', report_type: 'PRINCIPAL_AGGREGATED',
                        entity_cuis: [cui], functional_prefixes: ['07.01.01', '07.02'],
                        is_uat: true, normalization: 'total', show_period_growth: false,
                        currency: 'RON', inflation_adjusted: false
                    },
                    l: 150000
                }
            );
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

async function fetchHousing(siruta) {
    const data = await graphql(
        'query($d:String!,$f:InsObservationFilterInput,$l:Int){insObservations(datasetCode:$d,filter:$f,limit:$l){nodes{value time_period{year} territory{siruta_code name_ro}}}}',
        { d: 'LOC101B', f: { sirutaCodes: [siruta], territoryLevels: ['LAU'] }, l: 100 }
    );
    const nodes = data.insObservations?.nodes || [];
    if (!nodes.length) return null;
    let latest = nodes[0];
    for (const n of nodes) if (n.time_period?.year > latest.time_period?.year) latest = n;
    return { count: parseInt(latest.value) || 0, year: latest.time_period?.year };
}

async function main() {
    console.log('=== Finding 2 remaining UATs ===\n');

    // Try many search patterns for each
    const targets = [
        {
            county: 'Dâmbovița', name: 'Dragodana',
            searches: [
                'Dragodana Dambovita', 'Comuna Dragodana', 'Primaria Dragodana',
                'Dragodana', 'DRAGODANA', 'Dragodana judetul Dambovita',
            ]
        },
        {
            county: 'Iași', name: 'Alexandru I.cuza',
            searches: [
                'Alexandru Ioan Cuza Iasi', 'Alexandru I Cuza Iasi', 'Alexandru Cuza Iasi',
                'Comuna Alexandru', 'Alexandru I.Cuza', 'Alexandru Cuza',
                'Alexandru Ioan Cuza', 'A.I.Cuza Iasi', 'Cuza Iasi',
            ]
        }
    ];

    const src = fs.readFileSync(DATA_PATH, 'utf8');
    const match = src.match(/const UAT_DATA = ({[\s\S]*});?\s*$/m);
    const UAT_DATA = JSON.parse(match[1]);

    for (const target of targets) {
        console.log(`--- ${target.county} / ${target.name} ---`);
        let found = null;

        for (const term of target.searches) {
            console.log(`  Search: "${term}"`);
            const nodes = await search(term);
            await sleep(800);

            // Show all results
            for (const n of nodes) {
                const cn = (n.uat?.county_name || '').toUpperCase();
                const un = (n.uat?.name || '').toUpperCase();
                const relevant = cn.includes('DAMBOVITA') || cn.includes('IASI') || cn.includes('DÂMBOVIȚA') || cn.includes('IAȘI') ||
                    un.includes('DRAGODANA') || un.includes('ALEXANDRU') || un.includes('CUZA');
                if (relevant) {
                    console.log(`    ✓ "${n.name}" | UAT: ${n.uat?.name} | County: ${n.uat?.county_name} | CUI: ${n.cui} | SIRUTA: ${n.uat?.siruta_code}`);
                    if (!found && n.cui && n.uat?.siruta_code) {
                        // Check if UAT name matches
                        const targetNorm = target.name.toUpperCase().replace(/[.\s]/g, '');
                        const uatNorm = (n.uat?.name || '').toUpperCase().replace(/[.\s]/g, '');
                        if (uatNorm.includes(targetNorm) || targetNorm.includes(uatNorm) ||
                            uatNorm.includes('DRAGODANA') || uatNorm.includes('ALEXANDRU')) {
                            found = n;
                        }
                    }
                }
            }
            if (found) break;
        }

        if (!found) {
            console.log(`  ✗ Not found!\n`);
            continue;
        }

        console.log(`\n  → Best match: "${found.name}" | CUI: ${found.cui} | SIRUTA: ${found.uat?.siruta_code}`);

        // Fetch financial
        const fin = await fetchFinancial(found.cui);
        await sleep(800);
        console.log(`  Financial: tax=${fin?.tax || 0}, landTax=${fin?.landTax || 0} (${fin?.year || 'N/A'})`);

        // Fetch housing
        const housing = await fetchHousing(found.uat.siruta_code);
        await sleep(800);
        console.log(`  Housing: ${housing?.count || 0} (${housing?.year || 'N/A'})`);

        // Update
        const existing = UAT_DATA[target.county]?.[target.name];
        UAT_DATA[target.county][target.name] = {
            tax: fin?.tax || existing?.tax || 0,
            landTax: fin?.landTax || existing?.landTax || 0,
            taxYear: fin?.year || existing?.taxYear || null,
            houses: housing?.count || existing?.houses || 0,
            housesYear: housing?.year || existing?.housesYear || null,
        };
        const d = UAT_DATA[target.county][target.name];
        console.log(`  ✅ Updated: tax=${d.tax}, landTax=${d.landTax}, houses=${d.houses}\n`);
    }

    // Save
    const timestamp = new Date().toISOString().split('T')[0];
    let withLT = 0, total = 0;
    for (const uats of Object.values(UAT_DATA)) {
        for (const d of Object.values(uats)) { total++; if ((d.landTax || 0) > 0) withLT++; }
    }
    const header = `// Auto-generated UAT data from transparenta.eu\n// Generated: ${timestamp} (fix-last-2: landTax complete)\n// Total: ${total} UATs, ${withLT} with landTax\n`;
    fs.writeFileSync(DATA_PATH, header + 'const UAT_DATA = ' + JSON.stringify(UAT_DATA) + ';\n');
    console.log(`Saved! ${withLT}/${total} with landTax`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
