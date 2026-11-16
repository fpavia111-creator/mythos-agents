// Static ARIA checks: unknown roles and aria-* attributes, invalid values, references to
// missing ids, interactive roles that a keyboard cannot reach, focusable content hidden
// from assistive technology. Lists from WAI-ARIA 1.2 (role and state/property names only).

export const ROLES = new Set(('alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem doc-abstract doc-acknowledgments doc-afterword doc-appendix doc-backlink doc-biblioentry doc-bibliography doc-biblioref doc-chapter doc-colophon doc-conclusion doc-cover doc-credit doc-credits doc-dedication doc-endnote doc-endnotes doc-epigraph doc-epilogue doc-errata doc-example doc-footnote doc-foreword doc-glossary doc-glossref doc-index doc-introduction doc-noteref doc-notice doc-pagebreak doc-pagelist doc-part doc-preface doc-prologue doc-pullquote doc-qna doc-subtitle doc-tip doc-toc graphics-document graphics-object graphics-symbol').split(' '));
export const ARIA_ATTRS = new Set(('activedescendant atomic autocomplete braillelabel brailleroledescription busy checked colcount colindex colindextext colspan controls current describedby description details disabled dropeffect errormessage expanded flowto grabbed haspopup hidden invalid keyshortcuts label labelledby level live modal multiline multiselectable orientation owns placeholder posinset pressed readonly relevant required roledescription rowcount rowindex rowindextext rowspan selected setsize sort valuemax valuemin valuenow valuetext').split(' ').map((x) => 'aria-' + x));
const TRUE_FALSE = new Set(['aria-atomic', 'aria-busy', 'aria-disabled', 'aria-modal', 'aria-multiline', 'aria-multiselectable', 'aria-readonly', 'aria-required']);
const TRISTATE = new Set(['aria-checked', 'aria-pressed']);
const TF_UNDEF = new Set(['aria-expanded', 'aria-hidden', 'aria-selected', 'aria-grabbed']);
const ENUMS = {
  'aria-live': ['off', 'polite', 'assertive'], 'aria-current': ['page', 'step', 'location', 'date', 'time', 'true', 'false'],
  'aria-haspopup': ['false', 'true', 'menu', 'listbox', 'tree', 'grid', 'dialog'], 'aria-invalid': ['grammar', 'false', 'spelling', 'true'],
  'aria-orientation': ['horizontal', 'vertical', 'undefined'], 'aria-sort': ['ascending', 'descending', 'none', 'other'], 'aria-autocomplete': ['inline', 'list', 'both', 'none'],
};
const IDREFS = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-flowto', 'aria-activedescendant', 'aria-errormessage', 'aria-details'];
const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'slider', 'spinbutton', 'textbox', 'searchbox', 'combobox', 'treeitem']);
const NATIVE_FOCUSABLE = (e) => (e.name === 'a' && 'href' in e.attrs) || (['button', 'select', 'textarea', 'iframe', 'summary'].includes(e.name)) || (e.name === 'input' && (e.attrs.type || '').toLowerCase() !== 'hidden') || ((e.name === 'audio' || e.name === 'video') && 'controls' in e.attrs);
export const isFocusable = (e) => !('disabled' in e.attrs) && ((NATIVE_FOCUSABLE(e) && e.attrs.tabindex !== '-1') || (/^\d+$/.test(e.attrs.tabindex || '')));

/** Returns [{ check, el, detail }] for one parsed page. */
export function ariaIssues(els, ids, nameOf) {
  const out = []; const add = (check, el, detail) => out.push({ check, el, detail });
  for (const e of els) {
    const role = String(e.attrs.role || '').trim().toLowerCase();
    if ('role' in e.attrs) {
      const first = role.split(/\s+/)[0];
      if (!first) add('aria_role_invalid', e, `<${e.name}> has an empty role.`);
      else if (!ROLES.has(first)) add('aria_role_invalid', e, `role="${e.attrs.role}" is not a WAI-ARIA role.`);
    }
    for (const [k, v] of Object.entries(e.attrs)) {
      if (!k.startsWith('aria-')) continue;
      if (!ARIA_ATTRS.has(k)) { add('aria_attr_invalid', e, `${k} is not a WAI-ARIA attribute.`); continue; }
      const val = String(v).trim().toLowerCase();
      const bad = (TRUE_FALSE.has(k) && !['true', 'false'].includes(val)) || (TRISTATE.has(k) && !['true', 'false', 'mixed'].includes(val)) || (TF_UNDEF.has(k) && !['true', 'false', 'undefined'].includes(val)) || (ENUMS[k] && !ENUMS[k].includes(val));
      if (bad) add('aria_value_invalid', e, `${k}="${v}" is not an allowed value.`);
      if (IDREFS.includes(k)) {
        const missing = String(v).split(/\s+/).filter(Boolean).filter((id) => !ids.has(id));
        if (missing.length) add('aria_reference_missing', e, `${k} points at id(s) that do not exist: ${missing.join(', ')}.`);
      }
    }
    if (INTERACTIVE_ROLES.has(role) && !NATIVE_FOCUSABLE(e) && !/^-?\d+$/.test(e.attrs.tabindex || '')) add('aria_role_not_focusable', e, `<${e.name} role="${role}"> cannot be reached with the keyboard (no tabindex).`);
    if (['presentation', 'none'].includes(role) && isFocusable(e)) add('aria_presentation_focusable', e, `role="${role}" on a focusable <${e.name}> is ignored and confuses assistive technology.`);
    if (role === 'img' && !nameOf(e)) add('aria_img_name_missing', e, `<${e.name} role="img"> has no aria-label or aria-labelledby.`);
    if ((e.name === 'body' || e.name === 'html') && e.attrs['aria-hidden'] === 'true') add('aria_hidden_body', e, `aria-hidden="true" on <${e.name}> hides the whole page from assistive technology.`);
  }
  for (const e of els) {
    if (!isFocusable(e)) continue;
    for (let p = e.parent; p && p.name !== '#root'; p = p.parent) if (p.attrs && p.attrs['aria-hidden'] === 'true') { add('focusable_in_aria_hidden', e, `Focusable <${e.name}> is inside aria-hidden="true": keyboard users reach something screen readers cannot announce.`); break; }
  }
  return out;
}
