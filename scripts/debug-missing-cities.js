/**
 * Debug: find why 12 cities fail to resolve via proxy
 * and fetch their housing data directly via GraphQL
 */

const fs = require('fs');
const path = require('path');

const GRAPHQL_URL = 'https://api.transparenta.eu/graphql';
const base = path.join(__dirname, '..');

// The 12 problematic cities
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

function removeDiacritics(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }

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
    `, { search, limit: 10 });
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

async function main() {
    for (const { county, name, tip } of MISSING) {
        console.log('\n─── ' + county + ' → ' + name + ' (' + tip + ') ───');

        // Try many search patterns
        const plain = removeDiacritics(name);
        const patterns = [
            'ORAȘUL ' + name,
            'ORASUL ' + name,
            'ORASUL ' + plain,
            'Primaria ' + name,
            'Primaria ' + plain,
            name + ' ' + county,
            plain + ' ' + county,
            name,
            plain,
        ];

        for (const pattern of patterns) {
            try {
                const nodes = await searchEntities(pattern);
                if (nodes.length > 0) {
                    console.log('  Pattern "' + pattern + '" → ' + nodes.length + ' results:');
                    for (const n of nodes.slice(0, 3)) {
                        const uatName = n.uat?.name || '?';
                        const uatCounty = n.uat?.county_name || '?';
                        const siruta = n.uat?.siruta_code || '?';
                        console.log('    - "' + n.name + '" | UAT: ' + uatName + ' | county: ' + uatCounty + ' | siruta: ' + siruta);
                    }
                    // If first result has siruta, try fetching housing
                    const best = nodes.find(n => n.uat?.siruta_code);
                    if (best) {
                        const housing = await fetchHousingForSiruta(best.uat.siruta_code);
                        if (housing) {
                            console.log('  ✓ HOUSING FOUND via "' + pattern + '": count=' + housing.count + ' year=' + housing.year + ' territory="' + housing.territory + '"');
                        } else {
                            console.log('  ✗ Entity found (siruta=' + best.uat.siruta_code + ') but no INS housing data');
                        }
                        break;
                    }
                }
            } catch (e) {
                console.log('  Error for "' + pattern + '": ' + e.message);
            }
            await new Promise(r => setTimeout(r, 500));
        }
    }
}

main().catch(err => { console.error(err); process.exit(1); });
