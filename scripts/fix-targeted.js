/**
 * Targeted fix for specific UATs that got wrong entity data from the audit script.
 * Uses very specific search terms (Municipiul/Orașul/Comuna + exact name) with strict matching.
 */
const fs = require('fs');
const path = require('path');

const GRAPHQL_URL = 'https://api.transparenta.eu/graphql';
const DATA_PATH = path.join(__dirname, '..', 'public', 'uat_data.js');
const DELAY_MS = 1500;

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
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.errors) throw new Error(data.errors[0].message);
    return data.data;
}

async function searchEntities(search) {
    const data = await graphql(`
        query($search: String, $limit: Int) {
            entities(filter: { search: $search }, limit: $limit) {
                nodes { name cui uat { county_name name siruta_code } }
            }
        }
    `, { search, limit: 50 });
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
    return { count: parseInt(latest.value) || 0, year: latest.time_period?.year };
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

// Find entity by searching for specific term, then selecting the one whose
// entity name STARTS WITH the correct prefix AND whose UAT name matches
async function findSpecific(searchTerm, expectedEntityPrefix, expectedUatName, expectedCounty) {
    const nodes = await searchEntities(searchTerm);
    const nameNorm = norm(expectedUatName);
    const countyNorm = norm(expectedCounty);
    
    // Filter by county
    const inCounty = nodes.filter(n => {
        const nc = norm(n.uat?.county_name || '');
        return nc === countyNorm || nc.includes(countyNorm) || countyNorm.includes(nc);
    });
    
    // Find entity whose name starts with the expected prefix AND whose UAT name matches
    const prefixNorm = norm(expectedEntityPrefix);
    const match = inCounty.find(n => {
        const en = norm(n.name || '');
        const un = norm(n.uat?.name || '');
        return en.startsWith(prefixNorm) && un === nameNorm;
    });
    
    // Fallback: any entity whose UAT name matches
    const fallback = !match && inCounty.find(n => norm(n.uat?.name || '') === nameNorm);
    
    return match || fallback || null;
}

// Specific fixes needed — each with targeted search and validation
const FIXES = [
    // Botoșani municipiu — was wrongly set to Darabani
    { county: 'Botoșani', name: 'Botoșani', search: 'Municipiul Botosani', prefix: 'MUNICIPIUL BOTOSANI', type: 'municipiu' },
    // Tulcea municipiu — was wrongly set to Frecăței  
    { county: 'Tulcea', name: 'Tulcea', search: 'Municipiul Tulcea', prefix: 'MUNICIPIUL TULCEA', type: 'municipiu' },
    // Măcin oraș — was wrongly set to Maliuc
    { county: 'Tulcea', name: 'Măcin', search: 'Orasul Macin', prefix: 'ORASUL MACIN', type: 'oraș' },
    // Costești Argeș — was wrongly set to Titești
    { county: 'Argeș', name: 'Costești', search: 'Orasul Costesti Arges', prefix: 'ORASUL COSTESTI', type: 'oraș' },
    // Ștefănești Argeș — was wrongly set to Titești
    { county: 'Argeș', name: 'Ștefănești', search: 'Orasul Stefanesti Arges', prefix: 'ORASUL STEFANESTI', type: 'oraș' },
    // Câmpina — was wrongly sharing with Poiana Câmpina
    { county: 'Prahova', name: 'Câmpina', search: 'Municipiul Campina', prefix: 'MUNICIPIUL CAMPINA', type: 'municipiu' },
    // Mădăraș Mureș — was wrongly set to Raciu
    { county: 'Mureș', name: 'Mădăraș', search: 'Comuna Madaras Mures', prefix: 'COMUNA MADARAS', type: 'comună' },
    // Sărmașu Mureș — was wrongly set to Cozma
    { county: 'Mureș', name: 'Sărmașu', search: 'Orasul Sarmasu', prefix: 'ORASUL SARMASU', type: 'oraș' },
    // Sărățeni Mureș — was wrongly set to Suseni
    { county: 'Mureș', name: 'Sărățeni', search: 'Comuna Sarateni Mures', prefix: 'COMUNA SARATENI', type: 'comună' },
    // Țăndărei Ialomița — was wrongly set to Reviga
    { county: 'Ialomița', name: 'Țăndărei', search: 'Orasul Tandarei', prefix: 'ORASUL TANDAREI', type: 'oraș' },
    // Hășmaș Arad — still shares with Macea
    { county: 'Arad', name: 'Hășmaș', search: 'Comuna Hasmas Arad', prefix: 'COMUNA HASMAS', type: 'comună' },
];

async function main() {
    console.log('╔═══════════════════════════════════════════════════╗');
    console.log('║  Targeted Fix for Mismatched Entities             ║');
    console.log('╚═══════════════════════════════════════════════════╝\n');

    const src = fs.readFileSync(DATA_PATH, 'utf8');
    const match = src.match(/const UAT_DATA = ({[\s\S]*});?\s*$/m);
    const UAT_DATA = eval('(' + match[1] + ')');

    let fixed = 0, failed = 0;

    for (let i = 0; i < FIXES.length; i++) {
        const fix = FIXES[i];
        const existing = UAT_DATA[fix.county]?.[fix.name];
        console.log(`[${i+1}/${FIXES.length}] ${fix.county} → ${fix.name} (${fix.type})`);
        console.log(`    Current: tax=${existing?.tax||0}, houses=${existing?.houses||0}`);
        console.log(`    Searching: "${fix.search}"`);

        try {
            const entity = await findSpecific(fix.search, fix.prefix, fix.name, fix.county);
            await sleep(500);

            if (!entity) {
                // Try alternative searches
                const alts = [
                    fix.prefix.replace('ORASUL', 'ORAS'),
                    stripDiacritics(fix.name),
                    fix.name + ' ' + fix.county,
                ];
                let found = null;
                for (const alt of alts) {
                    const nodes = await searchEntities(alt);
                    await sleep(300);
                    const nameNorm = norm(fix.name);
                    const countyNorm = norm(fix.county);
                    found = nodes.find(n => {
                        const un = norm(n.uat?.name || '');
                        const cn = norm(n.uat?.county_name || '');
                        return un === nameNorm && (cn === countyNorm || cn.includes(countyNorm) || countyNorm.includes(cn));
                    });
                    if (found) break;
                }
                if (!found) {
                    console.log('    ✗ Entity not found\n');
                    failed++;
                    await sleep(DELAY_MS);
                    continue;
                }
                console.log(`    → Fallback found: "${found.name}" | CUI: ${found.cui} | UAT: ${found.uat?.name} | SIRUTA: ${found.uat?.siruta_code}`);

                const fin = await fetchFinancialForCui(found.cui);
                await sleep(500);
                const housing = found.uat?.siruta_code ? await fetchHousingForSiruta(found.uat.siruta_code) : null;
                await sleep(500);

                UAT_DATA[fix.county][fix.name] = {
                    tax: fin?.tax || existing?.tax || 0,
                    landTax: fin?.landTax || existing?.landTax || 0,
                    taxYear: fin?.year || existing?.taxYear || null,
                    houses: housing?.count || existing?.houses || 0,
                    housesYear: housing?.year || existing?.housesYear || null,
                };
                const d = UAT_DATA[fix.county][fix.name];
                console.log(`    ✅ FIXED: tax=${d.tax}, landTax=${d.landTax}, houses=${d.houses}\n`);
                fixed++;
            } else {
                console.log(`    → Found: "${entity.name}" | CUI: ${entity.cui} | UAT: ${entity.uat?.name} | SIRUTA: ${entity.uat?.siruta_code}`);

                const fin = await fetchFinancialForCui(entity.cui);
                await sleep(500);
                const housing = entity.uat?.siruta_code ? await fetchHousingForSiruta(entity.uat.siruta_code) : null;
                await sleep(500);

                UAT_DATA[fix.county][fix.name] = {
                    tax: fin?.tax || existing?.tax || 0,
                    landTax: fin?.landTax || existing?.landTax || 0,
                    taxYear: fin?.year || existing?.taxYear || null,
                    houses: housing?.count || existing?.houses || 0,
                    housesYear: housing?.year || existing?.housesYear || null,
                };
                const d = UAT_DATA[fix.county][fix.name];
                console.log(`    ✅ FIXED: tax=${d.tax}, landTax=${d.landTax}, houses=${d.houses}\n`);
                fixed++;
            }
        } catch (e) {
            console.log(`    ✗ Error: ${e.message}\n`);
            failed++;
        }
        await sleep(DELAY_MS);
    }

    // Save
    const timestamp = new Date().toISOString().split('T')[0];
    let totalWithData = 0, total = 0;
    for (const uats of Object.values(UAT_DATA)) {
        for (const d of Object.values(uats)) {
            total++;
            if (((d.tax||0)+(d.landTax||0)) > 0 || (d.houses||0) > 0) totalWithData++;
        }
    }
    const header = `// Auto-generated UAT data from transparenta.eu\n// Generated: ${timestamp} (targeted-fix: ${fixed} fixed)\n// Total: ${totalWithData} UATs with data out of ${total}\n`;
    fs.writeFileSync(DATA_PATH, header + 'const UAT_DATA = ' + JSON.stringify(UAT_DATA) + ';\n');

    // Final duplicate check
    let dupes = 0;
    for (const [county, uats] of Object.entries(UAT_DATA)) {
        const taxMap = {};
        for (const [name, d] of Object.entries(uats)) {
            const t = (d.tax||0).toFixed(2);
            if (parseFloat(t) > 0) { if (!taxMap[t]) taxMap[t] = []; taxMap[t].push(name); }
        }
        for (const [t, names] of Object.entries(taxMap)) {
            if (names.length > 1) {
                dupes++;
                console.log(`  Still duplicate: ${county} — tax=${parseFloat(t).toLocaleString()}: ${names.join(', ')}`);
            }
        }
    }

    console.log(`\n═══════════════════════════════════════════════════`);
    console.log(`Fixed: ${fixed} | Failed: ${failed}`);
    console.log(`Remaining duplicates: ${dupes}`);
    console.log(`Coverage: ${totalWithData}/${total}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
