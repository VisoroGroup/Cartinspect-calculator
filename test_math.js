const rTargets = [0.9, 0.9, 0.9];
const rCurrents = [0.8, 0.6, 0.4];
const MODEL = {
    PRICE_PER_IMOBIL: 130,
    TAX_INCREASE: 1.8,
    DISCOUNT_REMOVAL: 1.25,
    CARTINSPECT_FACTOR: 1.8
};
const transparentaTotal = 886355;
const effectiveHouses = 5914;

for(let i=0; i<3; i++) {
    const rCurrent = rCurrents[i];
    const rTarget = Math.max(rCurrent, rTargets[i]);
    
    const minimumBase = effectiveHouses * 150;
    const effectiveTax = Math.max(transparentaTotal, minimumBase);
    
    const potential100 = effectiveTax / rCurrent;
    const currentRevenue = potential100 * rCurrent;
    
    const afterTaxIncrease = potential100 * MODEL.TAX_INCREASE;
    const afterDiscountRemoval = afterTaxIncrease * MODEL.DISCOUNT_REMOVAL;
    
    const afterCartInspect = (afterDiscountRemoval * MODEL.CARTINSPECT_FACTOR) * rTarget;
    const deltaYear = afterCartInspect - currentRevenue;
    const delta10Y = deltaYear * 10;
    
    console.log(`--- Test ${i+1}: rCurrent=${rCurrent*100}%, rTarget=${rTarget*100}% ---`);
    console.log(`currentRevenue: ${Math.round(currentRevenue)}`);
    console.log(`afterCartInspect: ${Math.round(afterCartInspect)}`);
    console.log(`delta10Y: +${Math.round(delta10Y)}`);
}
