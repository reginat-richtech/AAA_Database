// Tech Request form schemas + helpers — ported from the AAA app's
// app/services/tech_request_form.py. Two declarative schemas (installation /
// event), autofill from a legal agreement, JotForm payload translation, and
// approval routing.

export const JOTFORM_IDS = { installation: '212985540502151', event: '241075943618158' };
export const FORM_TITLES = { installation: 'Technician Request Form', event: 'Event / Rental Form' };

// f(key, label, type, opts) — opts: { required, options, qid, kind }
const f = (key, label, type, opts = {}) => ({
  key, label, type,
  required: !!opts.required,
  options: opts.options || null,
  jotform_qid: opts.qid ?? null,
  jotform_kind: opts.kind ?? type,
});

export const SCHEMA_TECH = [
  { key: 'requester', title: 'Requester', fields: [
    f('requester_name', 'Name of Requester', 'text', { required: true, qid: 29, kind: 'fullname' }),
    f('requester_email', 'Requester Email', 'email', { qid: 30, kind: 'email' }),
    f('requester_phone', 'Requester Phone', 'tel', { qid: 49, kind: 'phone' }),
  ] },
  { key: 'client', title: 'Client', fields: [
    f('client_name', 'Client Contact Name', 'text', { required: true, qid: 38, kind: 'fullname' }),
    f('client_phone', 'Client Phone', 'tel', { required: true, qid: 39, kind: 'phone' }),
    f('client_email', 'Client Email', 'email', { required: true, qid: 43, kind: 'email' }),
    f('client_business', 'Client Business', 'text', { required: true, qid: 46, kind: 'text' }),
    f('client_address', 'Client Address', 'textarea', { required: true, qid: 40, kind: 'address' }),
    f('so_number', 'SO Number', 'text', { required: true, qid: 42, kind: 'text' }),
  ] },
  { key: 'request', title: 'Request', fields: [
    f('robot_types', 'Robot Types', 'multiselect', { required: true, qid: 48, kind: 'checkbox',
      options: ['ADAM', 'Scorpion', 'Matradee Plus', 'Matradee L', 'Titan 300', 'Titan 440', 'DUST-E S', 'Ascend/MedBot', 'ACE'] }),
    f('request_type', 'Request Type', 'select', { required: true, qid: 50, kind: 'radio',
      options: ['Installation (New Client)', 'Pilot/Demo', 'Event (fill out the event form too)', 'Service (Existing Client)'] }),
  ] },
  { key: 'install', title: 'Installation / Service', fields: [
    f('install_start', 'Install Start', 'date', { required: true, qid: 52, kind: 'datetime' }),
    f('install_first_day', 'Install First Day', 'date', { qid: 55, kind: 'datetime' }),
    f('install_end', 'Install End', 'date', { required: true, qid: 59, kind: 'datetime' }),
    f('starting_time', 'Starting Time', 'time', { qid: 63, kind: 'time' }),
    f('preferred_technician', 'Preferred Technician', 'text', { qid: 56, kind: 'text' }),
    f('demo_date', 'Demo Date', 'date', { qid: 60, kind: 'datetime' }),
    f('demo_time', 'Demo Time', 'time', { qid: 62, kind: 'time' }),
    f('installation_details', 'Installation Details', 'textarea', { qid: 58, kind: 'textarea' }),
  ] },
  { key: 'signoff', title: 'Sign-off', fields: [
    f('signature', 'Signature (type your name)', 'text', { required: true, qid: 57, kind: 'signature' }),
  ] },
];

export const SCHEMA_EVENT = [
  { key: 'submitter', title: 'Submitter', fields: [
    f('requester_name', 'Name of Requester', 'text', { required: true, qid: 95, kind: 'fullname' }),
    f('requester_email', 'Requester Email', 'email', { qid: 103, kind: 'email' }),
  ] },
  { key: 'client_event', title: 'Client & Event', fields: [
    f('direct_client', 'Direct Client', 'text', { required: true, qid: 74, kind: 'text' }),
    f('event_name', 'Event Name', 'text', { required: true, qid: 21, kind: 'text' }),
    f('event_date', 'Event Date', 'text', { required: true, qid: 47, kind: 'text' }),
    f('event_organizer', 'Event Organizer', 'text', { required: true, qid: 100, kind: 'text' }),
    f('client_email2', 'Client Email', 'email', { required: true, qid: 6, kind: 'email' }),
    f('phone', 'Phone', 'tel', { required: true, qid: 75, kind: 'text' }),
    f('delivery_address', 'Delivery Address', 'textarea', { required: true, qid: 4, kind: 'address' }),
    f('onsite_contact', 'On-site Contact', 'text', { required: true, qid: 38, kind: 'fullname' }),
  ] },
  { key: 'logistics', title: 'Logistics', fields: [
    f('load_in', 'Load In', 'text', { required: true, qid: 46, kind: 'text' }),
    f('load_out', 'Load Out', 'text', { required: true, qid: 48, kind: 'text' }),
    f('scheduled_setup', 'Scheduled Setup', 'text', { required: true, qid: 91, kind: 'text' }),
    f('serving_times', 'Serving Times', 'text', { required: true, qid: 92, kind: 'text' }),
    f('booth_number', 'Booth Number', 'text', { required: true, qid: 43, kind: 'text' }),
    f('advance_warehouse', 'Advance Warehouse', 'text', { required: true, qid: 49, kind: 'text' }),
    f('marshalling_yard', 'Marshalling Yard', 'text', { required: true, qid: 50, kind: 'text' }),
    f('richtech_moves', 'Richtech Moves Robots?', 'select', { required: true, qid: 102, kind: 'radio', options: ['Yes', 'No'] }),
    f('smallest_passageway', 'Smallest Passageway', 'text', { qid: 104, kind: 'text' }),
  ] },
  { key: 'robots', title: 'Robots, Drinks & Supplies', fields: [
    f('robot_types', 'Robot Types', 'multiselect', { required: true, qid: 78, kind: 'checkbox', options: ['ADAM', 'Scorpion'] }),
    f('drink_types', 'Drink Types', 'multiselect', { required: true, qid: 57, kind: 'checkbox', options: ['Coffee', 'Cocktail', 'Boba'] }),
    f('menu_type', 'Menu Type', 'multiselect', { required: true, qid: 94, kind: 'checkbox', options: ['Default Coffee Menu', 'Default Cocktail Menu', 'Wine Menu'] }),
    f('customizations', 'Customizations', 'multiselect', { required: true, qid: 98, kind: 'checkbox', options: ['ADAMs LED Lights', 'Custom Tablet Interface', 'Custom Voice Lines', 'Custom Cups'] }),
    f('ingredients', 'Ingredients', 'textarea', { qid: 101, kind: 'textarea' }),
  ] },
  { key: 'notes', title: 'Notes & Sign-off', fields: [
    f('special_requests', 'Special Requests', 'textarea', { qid: 36, kind: 'textarea' }),
    f('so_number', 'SO Number', 'text', { required: true, qid: 67, kind: 'text' }),
    f('general_notes', 'General Notes', 'textarea', { qid: 58, kind: 'textarea' }),
    f('signature', 'Signature (type your name)', 'text', { required: true, qid: 41, kind: 'signature' }),
  ] },
];

export const formTypeFor = (agreementType) =>
  agreementType === 'Event Rental Agreement' ? 'event' : 'installation';
export const schemaFor = (agreementType) =>
  formTypeFor(agreementType) === 'event' ? SCHEMA_EVENT : SCHEMA_TECH;
export const fieldsFlat = (schema) => schema.flatMap((s) => s.fields);

// Pre-fill from a legal agreement row (+ its extracted_json).
export function autofillFromAgreement(a) {
  const ex = a.extracted_json || a.extracted || {};
  const robotOptions = fieldsFlat(schemaFor(a.agreement_type)).find((x) => x.key === 'robot_types')?.options || [];
  const families = (a.robot_types || '').split(',').map((s) => s.trim()).filter(Boolean);
  const mappedRobots = robotOptions.filter((opt) =>
    families.some((fam) => opt.toLowerCase().includes(fam.toLowerCase()) || fam.toLowerCase().includes(opt.split(' ')[0].toLowerCase())));
  return {
    requester_name: a.salesman_name || '',
    requester_email: a.salesman_email || '',
    client_name: ex.client_contact_name || a.counterparty || '',
    client_email: ex.client_email || '',
    client_phone: ex.client_phone || '',
    client_address: ex.client_address || '',
    client_business: a.counterparty || '',
    direct_client: a.counterparty || '',
    robot_types: mappedRobots,
    install_first_day: ex.delivery_date || '',
    installation_details: a.summary || '',
    // so_number and signature are intentionally NOT auto-filled.
  };
}

export function missingRequired(agreementType, answers) {
  return fieldsFlat(schemaFor(agreementType))
    .filter((fl) => fl.required)
    .filter((fl) => {
      const v = answers[fl.key];
      if (Array.isArray(v)) return v.length === 0;
      return v === undefined || v === null || String(v).trim() === '';
    })
    .map((fl) => fl.label);
}

const two = (n) => String(n).padStart(2, '0');
// Translate in-platform answers → JotForm submission params.
export function buildJotformPayload(agreementType, answers) {
  const payload = {}; const skipped = [];
  for (const fl of fieldsFlat(schemaFor(agreementType))) {
    const v = answers[fl.key];
    if (v === undefined || v === null || v === '') continue;
    const qid = fl.jotform_qid; if (!qid) { skipped.push(fl.key); continue; }
    switch (fl.jotform_kind) {
      case 'fullname': {
        const [first, ...rest] = String(v).trim().split(' ');
        payload[`submission[${qid}_first]`] = first || '';
        payload[`submission[${qid}_last]`] = rest.join(' ');
        break;
      }
      case 'address':
        payload[`submission[${qid}_addr_line1]`] = String(v);
        break;
      case 'checkbox':
        (Array.isArray(v) ? v : [v]).forEach((opt, i) => { payload[`submission[${qid}][${i}]`] = opt; });
        break;
      case 'datetime': {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
        if (m) { payload[`submission[${qid}_year]`] = m[1]; payload[`submission[${qid}_month]`] = m[2]; payload[`submission[${qid}_day]`] = m[3]; }
        else { payload[`submission[${qid}]`] = String(v); }
        break;
      }
      case 'time': {
        const m = /^(\d{1,2}):(\d{2})/.exec(String(v));
        if (m) {
          let h = Number(m[1]); const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
          payload[`submission[${qid}_hourSelect]`] = two(h);
          payload[`submission[${qid}_minuteSelect]`] = m[2];
          payload[`submission[${qid}_ampm]`] = ampm;
        } else { payload[`submission[${qid}]`] = String(v); }
        break;
      }
      default:
        payload[`submission[${qid}]`] = String(v);
    }
  }
  if (formTypeFor(agreementType) === 'event') payload['submission[105]'] = 'Yes'; // "Is This Form Finalized?"
  return { payload, skipped };
}

// Manager routing on approval.
export function scheduleLeaderFor(agreementType, answers) {
  if (formTypeFor(agreementType) === 'event') return 'xinyu.z@richtechsystem.com';
  const robots = answers.robot_types || [];
  if (robots.some((r) => /scorpion|adam/i.test(r))) return 'justin.k@richtechsystem.com';
  return 'regina.t@richtechsystem.com';
}

export function scheduleDateFor(agreementType, answers) {
  const raw = formTypeFor(agreementType) === 'event' ? answers.event_date : answers.install_start;
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(raw || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Plain-text + HTML summary of a submission for notification emails.
export function renderSubmission(agreementType, answers, counterparty, calendar) {
  const lines = [`Tech Request — ${counterparty || ''} (${agreementType})`, ''];
  const htmlParts = [`<h2>Tech Request — ${counterparty || ''}</h2><p>${agreementType}</p>`];
  for (const section of schemaFor(agreementType)) {
    lines.push(`== ${section.title} ==`);
    htmlParts.push(`<h3>${section.title}</h3><ul>`);
    for (const fl of section.fields) {
      let v = answers[fl.key];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
      if (Array.isArray(v)) v = v.join(', ');
      lines.push(`${fl.label}: ${v}`);
      htmlParts.push(`<li><b>${fl.label}:</b> ${v}</li>`);
    }
    htmlParts.push('</ul>');
  }
  if (calendar?.html_link) {
    lines.push('', `Calendar: ${calendar.html_link}`);
    htmlParts.push(`<p><a href="${calendar.html_link}">Calendar event</a></p>`);
  }
  return { text: lines.join('\n'), html: htmlParts.join('\n') };
}
