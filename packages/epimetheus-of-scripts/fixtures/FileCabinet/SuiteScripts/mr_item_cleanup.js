/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record'], (search, record) => {
  const getInputData = () => search.load({ id: 'customsearch_inactive_items' });
  const map = (ctx) => { const r = JSON.parse(ctx.value); ctx.write(r.id, r.values.itemid); };
  return { getInputData, map };
});
