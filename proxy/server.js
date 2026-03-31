const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve static files from the project root (no more public/ duplication)
app.use(express.static(path.join(__dirname, '..')));

const GRAPHQL_URL = 'https://api.transparenta.eu/graphql';

// Strip Romanian diacritics to ASCII (transparenta.eu often stores names in ASCII)
function stripDiacritics(s) {
    return s
        .replace(/[ăâ]/gi, m => m === m.toLowerCase() ? 'a' : 'A')
        .replace(/[î]/gi, m => m === m.toLowerCase() ? 'i' : 'I')
        .replace(/[șş]/gi, m => m === m.toLowerCase() ? 's' : 'S')
        .replace(/[țţ]/gi, m => m === m.toLowerCase() ? 't' : 'T');
}

// Helper: execute GraphQL query
async function graphql(query, variables) {
    const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables })
    });
    if (!res.ok) throw new Error(`GraphQL request failed: ${res.status}`);
    const data = await res.json();
    if (data.errors) throw new Error(data.errors.map(e => e.message).join(', '));
    return data.data;
}

// ============================================================
// GET /api/entity-data?county=Bihor&name=Rosia
// Combined endpoint – search + financial + housing in one call
// ============================================================
// Helper: search entities via GraphQL
async function searchEntities(searchTerm) {
    const data = await graphql(`
        query EntitySearch($search: String, $limit: Int) {
            entities(filter: { search: $search }, limit: $limit) {
                nodes {
                    name
                    cui
                    uat {
                        county_name
                        name
                        siruta_code
                    }
                }
            }
        }
    `, { search: searchTerm, limit: 30 });
    return data.entities?.nodes || [];
}

// ============================================================
// Entity matching — SIMPLE RULE:
// Only match entities whose name starts with:
//   ORAS / ORASUL / ORAȘUL / COMUNA / MUN / MUNICIPIUL / PRIMARIA / PRIMĂRIA
// Everything else is ignored. No blacklist needed.
// ============================================================

function isUATEntity(n) {
    const nm = stripDiacritics((n.name || '').toUpperCase().trim());
    // Must start with ORAS/COMUNA/MUN/PRIMARIA
    if (!/^(ORAS\b|ORASUL\b|COMUNA\b|MUN\b|MUNICIPIUL\b|PRIMARIA\b)/.test(nm)) return false;
    // Reject subsidiary services: "COMUNA X SERVICIUL PUBLIC DE..."
    if (/SERVICIUL|SERVICIU |GOSPODARI|ALIMENTARE|EXPLOATARE|INTRETINERE/.test(nm)) return false;
    return true;
}

// Find best entity match from a list of nodes
function findBestMatch(nodes, countyUpper, nameUpper) {
    const norm = (s) => stripDiacritics((s || '').toUpperCase().normalize('NFC')).replace(/-/g, ' ');
    const countyNorm = norm(countyUpper);
    const nameNorm = norm(nameUpper);

    // Step 1: filter to same county + UAT entities only (ORAS/COMUNA/MUN/PRIMARIA)
    const candidates = nodes
        .filter(n => {
            const cn = norm(n.uat?.county_name);
            return cn === countyNorm || cn.includes(countyNorm) || countyNorm.includes(cn);
        })
        .filter(n => isUATEntity(n));

    if (candidates.length === 0) return null;

    // "endsWith" check: e.g. "MUNICIPIUL BISTRITA" ends with "BISTRITA"
    const endsWithName = (s) => {
        const sn = norm(s);
        return sn === nameNorm || sn.endsWith(' ' + nameNorm);
    };

    // Priority 1: exact UAT name match
    return candidates.find(n => norm(n.uat?.name) === nameNorm)
    // Priority 2: UAT name ends with the search name
        || candidates.find(n => endsWithName(n.uat?.name))
    // Priority 3: entity name ends with the search name
        || candidates.find(n => endsWithName(n.name))
    // Priority 4: UAT name contains the search name
        || candidates.find(n => norm(n.uat?.name).includes(nameNorm))
    // Priority 5: entity name contains the search name
        || candidates.find(n => norm(n.name).includes(nameNorm))
        || null;
}

app.get('/api/entity-data', async (req, res) => {
    try {
        const { county, name } = req.query;
        if (!county || !name) {
            return res.status(400).json({ error: 'county and name are required' });
        }

        const countyUpper = county.toUpperCase();
        const nameUpper = name.toUpperCase();

        // Build search strategies – include hyphenated variant if name has spaces
        const nameHyphen = name.includes(' ') ? name.replace(/ /g, '-') : null;
        const nameAscii = stripDiacritics(name);
        const countyAscii = stripDiacritics(county);
        const hasSpecialChars = nameAscii !== name;

        const searchStrategies = [
            `Primaria ${name} ${county}`,     // Most specific: "Primaria Șcheia Suceava"
            `Municipiul ${name} ${county}`,    // For cities: "Municipiul Deva Hunedoara"
            `Orașul ${name} ${county}`,         // For towns: "Orașul Beclean Bistrița-Năsăud"
            `Comuna ${name} ${county}`,        // "Comuna Berchișești Suceava"
            `${name} ${county}`,               // Generic: "Șcheia Suceava"
            `Primaria ${name}`,                // Without county: "Primaria Iași"
            `Municipiul ${name}`,              // Without county: "Municipiul Brașov"
            `Orașul ${name}`,                   // Without county: "Orașul Beclean"
            `Comuna ${name}`,                  // Without county: "Comuna Șcheia"
            name,                              // Just the name: "Beclean"
        ];

        // Add ASCII (diacritics-stripped) variants — transparenta.eu often stores names in ASCII
        if (hasSpecialChars) {
            searchStrategies.push(
                `Primaria ${nameAscii} ${countyAscii}`,
                `Municipiul ${nameAscii} ${countyAscii}`,
                `Orasul ${nameAscii} ${countyAscii}`,
                `Primaria ${nameAscii}`,
                `Municipiul ${nameAscii}`,
                `Orasul ${nameAscii}`,
                `Comuna ${nameAscii}`,
                nameAscii,
            );
        }

        // Add hyphenated variants for names with spaces (e.g. "Piatra Neamț" → "Piatra-Neamț")
        if (nameHyphen) {
            const nameHyphenAscii = stripDiacritics(nameHyphen);
            searchStrategies.push(
                `Municipiul ${nameHyphen} ${county}`,
                `Orașul ${nameHyphen} ${county}`,
                `${nameHyphen} ${county}`,
                `Primaria ${nameHyphen}`,
                `Municipiul ${nameHyphen}`,
                nameHyphen
            );
            if (hasSpecialChars) {
                searchStrategies.push(
                    `Municipiul ${nameHyphenAscii}`,
                    `Primaria ${nameHyphenAscii}`,
                    nameHyphenAscii
                );
            }
        }

        // Deduplicate search strategies (keep order)
        const seen = new Set();
        const uniqueStrategies = searchStrategies.filter(s => {
            if (seen.has(s)) return false;
            seen.add(s);
            return true;
        });

        let match = null;
        for (const searchTerm of uniqueStrategies) {
            const nodes = await searchEntities(searchTerm);
            match = findBestMatch(nodes, countyUpper, nameUpper);
            if (match) break;
        }

        if (!match) {
            return res.status(404).json({ error: 'Entity not found', searched: `${name} ${county}` });
        }

        const cui = match.cui;
        const siruta = match.uat?.siruta_code;

        // Step 2: Fetch financial + housing data in parallel
        const [financialResult, housingResult] = await Promise.allSettled([
            fetchFinancialData(cui),
            siruta ? fetchHousingData(siruta) : Promise.resolve(null)
        ]);

        const financial = financialResult.status === 'fulfilled' ? financialResult.value : null;
        let housing = housingResult.status === 'fulfilled' ? housingResult.value : null;

        // Sanity check: reject impossibly high housing counts (likely county-level data)
        if (housing && housing.count) {
            const uatName = match.uat?.name || '';
            const maxHouses = uatName.toUpperCase().includes('MUNICIPIUL') ? 200000
                : uatName.toUpperCase().includes('ORAȘ') ? 50000
                    : 15000;
            if (housing.count > maxHouses) {
                console.warn(`[SANITY] Housing count ${housing.count} exceeds max ${maxHouses} for "${name}" (${county}). Rejecting as county-level data.`);
                housing = null;
            }
            // Also warn if territory name doesn't match (use ASCII normalization)
            if (housing && housing.territory) {
                const territoryNorm = stripDiacritics((housing.territory || '').toUpperCase().replace(/-/g, ' '));
                const nameNorm = stripDiacritics(nameUpper.replace(/-/g, ' '));
                if (!territoryNorm.includes(nameNorm) && !nameNorm.includes(territoryNorm)) {
                    console.warn(`[SANITY] Housing territory "${housing.territory}" doesn't match requested "${name}". Data may be wrong.`);
                }
            }
        }

        res.json({
            entity: {
                cui: match.cui,
                siruta: match.uat?.siruta_code,
                name: match.name,
                county: match.uat?.county_name,
                uatName: match.uat?.name
            },
            financial,
            housing
        });
    } catch (err) {
        console.error('Entity data error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// Fetch financial data using AggregatedLineItems query
// Tries years 2025 → 2024 → 2023 → 2022
// ============================================================
async function fetchFinancialData(cui) {
    const yearsToTry = [2025, 2024, 2023, 2022];

    for (const year of yearsToTry) {
        try {
            const data = await graphql(`
                query AggregatedLineItems($filter: AnalyticsFilterInput!, $limit: Int) {
                    aggregatedLineItems(filter: $filter, limit: $limit) {
                        nodes {
                            fn_c: functional_code
                            fn_n: functional_name
                            amount
                        }
                    }
                }
            `, {
                filter: {
                    report_period: {
                        type: "YEAR",
                        selection: { interval: { start: String(year), end: String(year) } }
                    },
                    account_category: "vn",
                    report_type: "PRINCIPAL_AGGREGATED",
                    entity_cuis: [cui],
                    functional_prefixes: ["07.01.01", "07.02"],
                    is_uat: true,
                    normalization: "total",
                    show_period_growth: false,
                    currency: "RON",
                    inflation_adjusted: false
                },
                limit: 150000
            });

            const nodes = data.aggregatedLineItems?.nodes || [];
            if (nodes.length === 0) continue;

            // fn:07.01.01 – Impozit pe clădiri de la persoane fizice
            // fn:07.02    – Impozit pe terenuri
            let impozitCladiriFizice = 0;
            let impozitTerenuri = 0;

            for (const node of nodes) {
                const code = node.fn_c || '';
                const amount = parseFloat(node.amount) || 0;

                if (code === '07.01.01') {
                    impozitCladiriFizice = amount;
                } else if (code.startsWith('07.02')) {
                    impozitTerenuri += amount;
                }
            }

            if (impozitCladiriFizice > 0 || impozitTerenuri > 0) {
                return {
                    year,
                    impozitCladiriFizice: Math.round(impozitCladiriFizice * 100) / 100,
                    impozitTerenuri: Math.round(impozitTerenuri * 100) / 100,
                    total: Math.round((impozitCladiriFizice + impozitTerenuri) * 100) / 100
                };
            }
        } catch (e) {
            console.error(`Financial data error for year ${year}:`, e.message);
            continue;
        }
    }
    return null;
}

// ============================================================
// Fetch housing data from INS LOC101B dataset
// ============================================================
async function fetchHousingData(siruta) {
    const data = await graphql(`
        query InsObservations($datasetCode: String!, $filter: InsObservationFilterInput, $limit: Int) {
            insObservations(datasetCode: $datasetCode, filter: $filter, limit: $limit) {
                nodes {
                    value
                    time_period { year }
                    territory { siruta_code name_ro }
                }
            }
        }
    `, {
        datasetCode: "LOC101B",
        filter: {
            sirutaCodes: [siruta],
            territoryLevels: ["LAU"]
        },
        limit: 100
    });

    const nodes = data.insObservations?.nodes || [];
    if (nodes.length === 0) return null;

    // Find the most recent year
    let latest = nodes[0];
    for (const node of nodes) {
        if (node.time_period?.year > latest.time_period?.year) {
            latest = node;
        }
    }

    return {
        year: latest.time_period?.year,
        count: parseInt(latest.value) || 0,
        territory: latest.territory?.name_ro
    };
}

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Fallback: serve index.html for all non-API routes (SPA)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

app.listen(PORT, () => {
    console.info(`CartInspect proxy running on port ${PORT}`);
});
