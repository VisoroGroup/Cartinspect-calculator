/**
 * Final fix for 4 UATs with specific CUIs found via manual search.
 */
const fs = require('fs');
const path = require('path');
const GRAPHQL_URL = 'https://api.transparenta.eu/graphql';
const DATA_PATH = path.join(__dirname, '..', 'public', 'uat_data.js');

async function gql(q, v) {
    const r = await fetch(GRAPHQL_URL, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({query:q,variables:v}), signal: AbortSignal.timeout(30000) });
    const d = await r.json();
    if (d.errors) throw new Error(d.errors[0].message);
    return d.data;
}

async function fetchFinancial(cui) {
    for (const year of [2025, 2024, 2023]) {
        try {
            const data = await gql(
                'query($f:AnalyticsFilterInput!,$l:Int){aggregatedLineItems(filter:$f,limit:$l){nodes{fn_c:functional_code amount}}}',
                { f: {
                    report_period: { type: 'YEAR', selection: { interval: { start: String(year), end: String(year) } } },
                    account_category: 'vn', report_type: 'PRINCIPAL_AGGREGATED',
                    entity_cuis: [cui], functional_prefixes: ['07.01.01', '07.02'],
                    is_uat: true, normalization: 'total', show_period_growth: false,
                    currency: 'RON', inflation_adjusted: false
                }, l: 150000 }
            );
            let tax = 0, landTax = 0;
            for (const n of data.aggregatedLineItems?.nodes || []) {
                const amt = parseFloat(n.amount) || 0;
                if (n.fn_c === '07.01.01') tax = Math.round(amt * 100) / 100;
                if (n.fn_c === '07.02') landTax = Math.round(amt * 100) / 100;
            }
            if (tax > 0 || landTax > 0) return { tax, landTax, year };
        } catch {}
    }
    return null;
}

async function fetchHousing(siruta) {
    const data = await gql(
        'query($d:String!,$f:InsObservationFilterInput,$l:Int){insObservations(datasetCode:$d,filter:$f,limit:$l){nodes{value time_period{year}}}}',
        { d: 'LOC101B', f: { sirutaCodes: [siruta], territoryLevels: ['LAU'] }, l: 100 }
    );
    const nodes = data.insObservations?.nodes || [];
    if (!nodes.length) return null;
    let latest = nodes[0];
    for (const n of nodes) if (n.time_period?.year > latest.time_period?.year) latest = n;
    return { count: parseInt(latest.value) || 0, year: latest.time_period?.year };
}

async function main() {
    const src = fs.readFileSync(DATA_PATH, 'utf8');
    const match = src.match(/const UAT_DATA = ({[\s\S]*});?\s*$/m);
    const data = JSON.parse(match[1]);

    // Specific fixes with correct CUIs and SIRUTAs
    const fixes = [
        { county: 'Galați', name: 'Berești', cui: '3346883', siruta: '75338', note: 'ORASUL BERESTI' },
        { county: 'Sibiu', name: 'Sadu', cui: '4241222', siruta: '145471', note: 'COMUNA SADU' },
        { county: 'Teleorman', name: 'Siliștea', cui: '6853198', siruta: '154228', note: 'COMUNA SILISTEA Teleorman' },
        { county: 'Ialomița', name: 'Adâncata', cui: '4365123', siruta: '100754', note: 'COMUNA ADANCATA Ialomița' },
    ];

    for (const fix of fixes) {
        console.log(`${fix.county} / ${fix.name} (${fix.note}):`);
        const fin = await fetchFinancial(fix.cui);
        await new Promise(r => setTimeout(r, 800));
        const housing = await fetchHousing(fix.siruta);
        await new Promise(r => setTimeout(r, 800));

        const old = data[fix.county][fix.name];
        data[fix.county][fix.name] = {
            tax: fin?.tax || 0,
            landTax: fin?.landTax || 0,
            taxYear: fin?.year || old.taxYear,
            houses: housing?.count || old.houses || 0,
            housesYear: housing?.year || old.housesYear,
        };
        const d = data[fix.county][fix.name];
        console.log(`  tax=${d.tax}, landTax=${d.landTax}, houses=${d.houses} (${d.taxYear})\n`);
    }

    // Save
    const timestamp = new Date().toISOString().split('T')[0];
    let wLT = 0, tot = 0, noTax = 0, dupes = 0;
    for (const [county, uats] of Object.entries(data)) {
        const taxMap = {};
        for (const [n, d] of Object.entries(uats)) {
            if (n === 'București' && county === 'București') continue;
            tot++;
            if ((d.landTax || 0) > 0) wLT++;
            if ((d.tax || 0) <= 0) noTax++;
            const t = (d.tax || 0).toFixed(2);
            if (parseFloat(t) > 0) { if (!taxMap[t]) taxMap[t] = []; taxMap[t].push(n); }
        }
        for (const names of Object.values(taxMap)) {
            if (names.length > 1) { dupes++; console.log('DUPE: ' + county + ' — ' + names.join(', ')); }
        }
    }
    const header = `// Auto-generated UAT data from transparenta.eu\n// Generated: ${timestamp} (all fixes complete)\n// Total: ${tot + 1} UATs, ${wLT} with landTax, ${dupes} dupes, ${noTax} no-tax\n`;
    fs.writeFileSync(DATA_PATH, header + 'const UAT_DATA = ' + JSON.stringify(data) + ';\n');
    console.log(`\nSaved! Dupes: ${dupes} | NoTax: ${noTax} | LandTax: ${wLT}/${tot}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
