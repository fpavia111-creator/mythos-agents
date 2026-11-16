/**
 * @NApiVersion 2.0
 * Sample tax library (fictional). Deliberately imports pricing back, forming a cycle.
 */
define(['./pricing'], function (pricing) {
  function forAmount(amount) { return Math.round(amount * 0.07 * 100) / 100; }
  return { forAmount: forAmount, pricing: pricing };
});
