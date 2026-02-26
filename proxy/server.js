const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const GRAPHQL_URL = 'https://api.transparenta.eu/graphql';

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

// Helper: is this entity a primăria (municipality office)?
function isPrimaria(n) {
    const nm = (n.name || '').toUpperCase();
    return nm.includes('PRIMĂRIA') || nm.includes('PRIMARIA') ||
        nm.includes('ORAȘ') || nm.includes('ORAS') ||
        nm.includes('MUNICIPIUL') || nm.includes('COMUNA');
}

// Blacklist: NEVER match these entity types
function isBlacklisted(n) {
    const nm = (n.name || '').toUpperCase();
    return nm.includes('SCOALA') || nm.includes('ȘCOALA') || nm.includes('ȘCOALĂ') ||
        nm.includes('LICEUL') || nm.includes('LICEU') ||
        nm.includes('GRADINITA') || nm.includes('GRĂDINIȚA') || nm.includes('GRĂDINIȚĂ') ||
        nm.includes('SPITAL') || nm.includes('BISERICA') || nm.includes('BISERICĂ') ||
        nm.includes('BIBLIOTECA') || nm.includes('BIBLIOTECĂ') ||
        nm.includes('MUZEU') || nm.includes('CASA DE CULTURA') ||
        nm.includes('CLUBUL') || nm.includes('POLITIA') || nm.includes('POLIȚIA') ||
        nm.includes('INSPECTORAT') || nm.includes('SEMINARUL') ||
        nm.includes('COLEGIUL') || nm.includes('UNIVERSITATE') ||
        nm.includes('GIMNAZIAL') ||
        nm.includes('TRIBUNALUL') || nm.includes('TRIBUNAL') ||
        nm.includes('JUDECATORIA') || nm.includes('JUDECĂTORIA') ||
        nm.includes('CURTEA DE APEL') || nm.includes('PARCHETUL') ||
        nm.includes('DIRECTIA') || nm.includes('DIRECȚIA') ||
        nm.includes('AGENTIA') || nm.includes('AGENȚIA') ||
        nm.includes('CAMERA DE COMERT') || nm.includes('PREFECTURA') ||
        nm.includes('SERVICIUL') || nm.includes('CENTRUL') ||
        nm.startsWith('JUDETUL') || nm.startsWith('JUDEȚUL');
}

// Find best entity match from a list of nodes
function findBestMatch(nodes, countyUpper, nameUpper) {
    const inCounty = nodes
        .filter(n => n.uat?.county_name?.toUpperCase() === countyUpper)
        .filter(n => !isBlacklisted(n));

    // Match priority:
    // 1. Primăria + exact UAT name
    // 2. Any non-blacklisted + exact UAT name  
    // 3. Primăria + UAT name includes search name
    // 4. Primăria + entity name includes search name
    // 5. Any non-blacklisted + partial match
    // 6. First non-blacklisted in county (only if it's a primăria)
    return inCounty.find(n =>
        isPrimaria(n) && n.uat?.name?.toUpperCase() === nameUpper
    ) || inCounty.find(n =>
        n.uat?.name?.toUpperCase() === nameUpper && isPrimaria(n)
    ) || inCounty.find(n =>
        isPrimaria(n) && n.uat?.name?.toUpperCase().includes(nameUpper)
    ) || inCounty.find(n =>
        isPrimaria(n) && n.name?.toUpperCase().includes(nameUpper)
    ) || inCounty.find(n =>
        (n.uat?.name?.toUpperCase().includes(nameUpper) || n.name?.toUpperCase().includes(nameUpper)) && isPrimaria(n)
    ) || inCounty.find(n => isPrimaria(n)) || null;
}

app.get('/api/entity-data', async (req, res) => {
    try {
        const { county, name } = req.query;
        if (!county || !name) {
            return res.status(400).json({ error: 'county and name are required' });
        }

        const countyUpper = county.toUpperCase();
        const nameUpper = name.toUpperCase();

        // Try multiple search strategies to find the primăria
        const searchStrategies = [
            `Primaria ${name} ${county}`,     // Most specific: "Primaria Șcheia Suceava"
            `Comuna ${name} ${county}`,        // "Comuna Berchișești Suceava"
            `${name} ${county}`,               // Generic: "Șcheia Suceava"
            `Municipiul ${name} ${county}`,    // For cities: "Municipiul Deva Hunedoara"
            `Primaria ${name}`,                // Without county: "Primaria Iași"
        ];

        let match = null;
        for (const searchTerm of searchStrategies) {
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
        const housing = housingResult.status === 'fulfilled' ? housingResult.value : null;

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
            if (nodes.length === 0) continue;

            // Only use fn:07.01.01 – Impozit pe clădiri de la persoane fizice
            let impozitCladiriFizice = 0;

            for (const node of nodes) {
                const code = node.fn_c || '';
                const amount = parseFloat(node.amount) || 0;

                if (code === '07.01.01') {
                    impozitCladiriFizice = amount;
                }
            }

            if (impozitCladiriFizice > 0) {
                return {
                    year,
                    impozitCladiriFizice: Math.round(impozitCladiriFizice * 100) / 100,
                    total: Math.round(impozitCladiriFizice * 100) / 100
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

app.listen(PORT, () => {
    console.log(`CartInspect proxy running on port ${PORT}`);
});
