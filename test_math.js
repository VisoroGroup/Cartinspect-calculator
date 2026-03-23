// Test: new calculation model
// base = fn:07.01.01 + fn:07.02
// For municipiu/oraș: CartInspect applies to 60% only (apartment buildings excluded)
// For comună: CartInspect applies to 100%
// cost = measurableHouses × 110 RON

const MODEL = {
    PRICE_PER_IMOBIL: 110,
    CARTINSPECT_FACTOR: 1.8
};

const testCases = [
    {
        name: 'Municipiu example',
        tip: 'municipiu',
        impozitCladiriFizice: 454325,
        impozitTerenuri: 563698,
        totalHouses: 15000
    },
    {
        name: 'Oraș example',
        tip: 'oraș',
        impozitCladiriFizice: 200000,
        impozitTerenuri: 150000,
        totalHouses: 5000
    },
    {
        name: 'Comună example',
        tip: 'comună',
        impozitCladiriFizice: 80000,
        impozitTerenuri: 30000,
        totalHouses: 2000
    }
];

for (const tc of testCases) {
    const isCity = tc.tip === 'municipiu' || tc.tip === 'oraș';
    const cityFactor = isCity ? 0.6 : 1.0;

    const currentRevenue = tc.impozitCladiriFizice + tc.impozitTerenuri;
    const afterCartInspect = currentRevenue * (1 - cityFactor + cityFactor * MODEL.CARTINSPECT_FACTOR);
    const deltaYear = afterCartInspect - currentRevenue;
    const delta10Y = deltaYear * 10;

    const measurableHouses = Math.round(tc.totalHouses * cityFactor);
    const cost = measurableHouses * MODEL.PRICE_PER_IMOBIL;
    const roi10Y = cost > 0 ? (delta10Y - cost) / cost : 0;
    const paybackYears = deltaYear > 0 ? cost / deltaYear : Infinity;

    console.log(`\n--- ${tc.name} (${tc.tip}, cityFactor=${cityFactor}) ---`);
    console.log(`  07.01.01:          ${tc.impozitCladiriFizice.toLocaleString()} RON`);
    console.log(`  07.02:             ${tc.impozitTerenuri.toLocaleString()} RON`);
    console.log(`  currentRevenue:    ${Math.round(currentRevenue).toLocaleString()} RON (piros)`);
    console.log(`  afterCartInspect:  ${Math.round(afterCartInspect).toLocaleString()} RON (zöld)`);
    console.log(`  deltaYear:         +${Math.round(deltaYear).toLocaleString()} RON`);
    console.log(`  delta10Y:          +${Math.round(delta10Y).toLocaleString()} RON`);
    console.log(`  measurableHouses:  ${measurableHouses.toLocaleString()} (${Math.round(cityFactor*100)}% of ${tc.totalHouses})`);
    console.log(`  cost:              ${Math.round(cost).toLocaleString()} RON (${measurableHouses} × 110)`);
    console.log(`  ROI 10Y:           ${Math.round(roi10Y * 100)}%`);
    console.log(`  payback:           ${paybackYears.toFixed(1)} years`);
}
