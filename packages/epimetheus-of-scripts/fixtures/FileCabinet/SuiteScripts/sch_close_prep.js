/**
 * Sample SuiteScript 1.0 scheduled script (fictional).
 */
function run() {
  var ctx = nlapiGetContext();
  var results = nlapiSearchRecord('transaction', 'customsearch_open_je', null, null) || [];
  for (var i = 0; i < results.length; i++) {
    var je = nlapiLoadRecord('journalentry', results[i].getId());
    je.setFieldValue('memo', 'close prep');
    nlapiSubmitRecord(je);
    if (ctx.getRemainingUsage() < 100) { nlapiYieldScript(); }
  }
}
