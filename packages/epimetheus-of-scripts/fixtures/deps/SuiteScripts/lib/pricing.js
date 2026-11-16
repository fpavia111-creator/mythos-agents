/**
 * @NApiVersion 2.0
 * @NModuleScope SameAccount
 * Sample pricing library (fictional).
 */
define(['N/search', './tax'], function (searchModule, tax) {
  function total(rec) {
    var amount = rec.getValue({ fieldId: 'subtotal' });
    return amount + tax.forAmount(amount);
  }
  return { total: total };
});
