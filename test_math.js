// Test: calculation model — total × 1.8, nothing else
// currentRevenue = impozitCladiriFizice + impozitTerenuri (from transparenta.eu)
// afterCartInspect = currentRevenue × 1.8
// cost = totalHouses × 130

const MODEL = {
    PRICE_PER_IMOBIL: 130,
    CARTINSPECT_FACTOR: 1.8
};

const testCases = [
    {
        name: 'Municipiu — normal case',
        tax: 454325,
        landTax: 563698,
        houses: 15000,
        expected: {
            currentRevenue: 1018023,
            afterCartInspect: 1832441.4,
            deltaYear: 814418.4,
            cost: 1950000
        }
    },
    {
        name: 'Oraș — normal case',
        tax: 200000,
        landTax: 150000,
        houses: 5000,
        expected: {
            currentRevenue: 350000,
            afterCartInspect: 630000,
            deltaYear: 280000,
            cost: 650000
        }
    },
    {
        name: 'Comună — normal case',
        tax: 80000,
        landTax: 30000,
        houses: 2000,
        expected: {
            currentRevenue: 110000,
            afterCartInspect: 198000,
            deltaYear: 88000,
            cost: 260000
        }
    },
    {
        name: 'No housing data',
        tax: 100000,
        landTax: 50000,
        houses: 0,
        expected: {
            currentRevenue: 150000,
            afterCartInspect: 270000,
            deltaYear: 120000,
            cost: 0
        }
    },
    {
        name: 'No tax data',
        tax: 0,
        landTax: 0,
        houses: 500,
        expected: {
            currentRevenue: 0,
            afterCartInspect: 0,
            deltaYear: 0,
            cost: 65000
        }
    },
    {
        name: 'Only landTax, no building tax',
        tax: 0,
        landTax: 200000,
        houses: 3000,
        expected: {
            currentRevenue: 200000,
            afterCartInspect: 360000,
            deltaYear: 160000,
            cost: 390000
        }
    }
];

let passed = 0;
let failed = 0;

for (const tc of testCases) {
    const currentRevenue = tc.tax + tc.landTax;
    const afterCartInspect = currentRevenue * MODEL.CARTINSPECT_FACTOR;
    const deltaYear = afterCartInspect - currentRevenue;
    const delta10Y = deltaYear * 10;
    const cost = tc.houses * MODEL.PRICE_PER_IMOBIL;
    const roi10Y = cost > 0 ? (delta10Y - cost) / cost : 0;
    const paybackYears = deltaYear > 0 ? cost / deltaYear : Infinity;

    const checks = [
        ['currentRevenue', currentRevenue, tc.expected.currentRevenue],
        ['afterCartInspect', afterCartInspect, tc.expected.afterCartInspect],
        ['deltaYear', deltaYear, tc.expected.deltaYear],
        ['cost', cost, tc.expected.cost],
    ];

    console.log(`\n--- ${tc.name} ---`);
    for (const [label, actual, expected] of checks) {
        const ok = Math.abs(actual - expected) < 0.1;
        console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}: ${actual} (expected ${expected})`);
        if (ok) passed++; else failed++;
    }
    console.log(`  ROI 10Y: ${Math.round(roi10Y * 100)}%`);
    console.log(`  Payback: ${paybackYears === Infinity ? '∞' : paybackYears.toFixed(1)} years`);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
