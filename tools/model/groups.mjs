// Classify FE part names into vehicle assembly groups.
// Names in the CCSA Yaris look like "421_enginemountrearmain", "doorfrontimpactbarbrktR", "Rear_Dr_Brckt_Misc_L",
// so names are normalised (prefix number and separators removed, lower case) and matched as substrings.
// RULES are ordered: the first match wins. GROUPS defines display order, labels and colours.

export const GROUPS = [
  { id: 'body', label: 'Body-in-white', color: '#c9ced6' },
  { id: 'closures', label: 'Doors, hood & trunk', color: '#5a9e5a' },
  { id: 'glazing', label: 'Glazing', color: '#9cc9e8' },
  { id: 'bumpers', label: 'Bumpers & tow hooks', color: '#2f6db5' },
  { id: 'subframe', label: 'Subframe', color: '#b5552e' },
  { id: 'suspension', label: 'Suspension', color: '#d2a03c' },
  { id: 'wheels', label: 'Wheels, tires & brakes', color: '#4a5059' },
  { id: 'steering', label: 'Steering', color: '#c97b3a' },
  { id: 'powertrain', label: 'Engine & transmission', color: '#7b5cb8' },
  { id: 'cooling', label: 'Radiator & cooling', color: '#4f8fa3' },
  { id: 'exhaust', label: 'Exhaust', color: '#8a7b6c' },
  { id: 'fuel', label: 'Fuel tank', color: '#a33b3b' },
  { id: 'electrical', label: 'Electrical & lights', color: '#d4c440' },
  { id: 'interior', label: 'Interior & seats', color: '#c4a882' },
  { id: 'connections', label: 'Connectors & welds', color: '#8a8f98' },
  { id: 'other', label: 'Other', color: '#a0a6ad' },
];

export const RULES = [
  { id: 'connections', re: /connector|weld|adhesive|null|rigidlink|cnrb/ },
  { id: 'interior', re: /seat|headrest/ },
  { id: 'steering', re: /steering|tierod/ },
  { id: 'glazing', re: /windshield|window|glass|backlite/, not: /mech|motor|brkt|bkrt|rail|bar|glide|washing/ },
  { id: 'closures', re: /dooo?r|hood|bonnet|fender|hinge|trunk(lid|outer|inner|panel)|liftgate|tailgate|hatch|window|frtdr|reardr|frontdr/, not: /washing|drum/ },
  { id: 'wheels', re: /tire|tyre|rim|drum|hub|disk|disc|tread|caliper|rotor|brake(?!booster)/, not: /trim|wheelhouse|pillar|radiator|dash/ },
  { id: 'subframe', re: /subframe|subrame|cradle/ },
  { id: 'body', re: /shockhousing|wheelwell|wheelhouse|strut ?tower/ },
  { id: 'suspension', re: /shock|spring|antiroll|stabili|suspension|susp|aarm|upright|strut|knuckle|controlarm|torsion|trailingarm|damper/ },
  { id: 'powertrain', re: /engine|enine|transmission|gearbox|alternator|starter|intake|exhaustmanifold|oilpan|airfilter|beltwheel|brakebooster|driverod|driveshaft|halfshaft/ },
  { id: 'exhaust', re: /exhaust|muffler|catalyt|silencer|tailpipe/ },
  { id: 'fuel', re: /gastank|fuel/ },
  { id: 'cooling', re: /radiator|condenser|fan|intercooler/ },
  { id: 'bumpers', re: /bumper|crashbox|crushcan|tailhook|towhook|crowbar/ },
  { id: 'electrical', re: /battery|headlight|headlamp|taillig|lamp|fusebox|washer|washing|wiper|harness/ },
  { id: 'interior', re: /dash(?!panel)|trim|airbag|knee|glove|consol|ipbeam|instrument|emergencybreak|curtab|carpet|headliner|pedal/ },
  { id: 'body', re: /floor|pillar|rocker|rail|roof|panel|firewall|cowl|apron|xmember|member|tunnel|frame|housing|rearsection|support|suprt|sprt|brkt|plate|reinf|pan|sill|beam|body/ },
];

export function normalise(name) {
  return (name || '').toLowerCase().replace(/^\s*\d+[_\-\s]*/, '').replace(/[^a-z0-9]+/g, '');
}

export function classify(name) {
  const n = normalise(name);
  for (const r of RULES) if (r.re.test(n) && !(r.not && r.not.test(n))) return r.id;
  return 'other';
}

export function groupList() {
  return GROUPS.map(({ id, label, color }) => ({ id, label, color }));
}

// Second tree level: assemblies inside a group. Ordered; first match within the part's group wins.
// `sided` assemblies are split into L / R from the part centroid (CCSA models: +y = left).
const A = (group, label, re, sided = false) => ({ group, label, re, sided });
export const ASSEMBLIES = [
  A('body', 'Wheelhouses & strut towers', /wheelwell|wheelhouse|shockhousing|housingsupport/, true),
  A('body', 'A-pillar', /apillar/, true),
  A('body', 'B-pillar', /bpillar/, true),
  A('body', 'C-pillar', /cpillar/, true),
  A('body', 'Roof', /roof/),
  A('body', 'Rocker / sill', /rocker|sill/, true),
  A('body', 'Side panel', /sidepanel|quarter/, true),
  A('body', 'Firewall & cowl', /firewall|cowl|dash/),
  A('body', 'Floor & tunnel', /floor|tunnel|trunkfloor|trunkframe/),
  A('body', 'Front rails & frame', /rail|frame|aarm|susp/),
  A('body', 'Rear panel', /rear|back/),
  A('closures', 'Window regulators', /windowmech|windowmotor|windowfront|window.*(brkt|bkrt|rail|motor|glide|bar)/, true),
  A('closures', 'Front door', /doorfront|doorftont|frtdr|frontdr|doorwindowfront|doorframe/, true),
  A('closures', 'Rear door', /doorrear|dooorrear|reardr|reardoor|doorrrear/, true),
  A('closures', 'Hinges', /hinge/, true),
  A('closures', 'Hood', /hood|bonnet/),
  A('closures', 'Fenders', /fender/, true),
  A('closures', 'Trunk lid', /trunk/),
  A('glazing', 'Rear window', /windshieldrear|backlite/),
  A('glazing', 'Windshield', /windshield/),
  A('glazing', 'Door windows', /window/, true),
  A('bumpers', 'Rear bumper', /rear/),
  A('bumpers', 'Tow hooks', /tailhook|towhook|crowbar/),
  A('bumpers', 'Front bumper', /bumper/),
  A('suspension', 'Anti-roll bar', /antiroll|stabili/),
  A('suspension', 'Front struts', /shockfront|shockfont|shockbrktfront|shockhousingtop/, true),
  A('suspension', 'Rear shocks', /shockrear|shockleft/, true),
  A('suspension', 'Lower control arms', /aarm|controlarm/, true),
  A('suspension', 'Uprights / knuckles', /upright|knuckle/, true),
  A('suspension', 'Rear axle', /rear|axel|axle|torsion/),
  A('wheels', 'Tire treads', /tread/),
  A('wheels', 'Front wheels & brakes', /front|font/, true),
  A('wheels', 'Rear wheels & brakes', /rear|drum/, true),
  A('steering', 'Steering column & wheel', /colm|column|wheel/),
  A('steering', 'Steering rack', /mech|rack|tierod/),
  A('powertrain', 'Engine mounts', /mount|mouint|railengine/),
  A('powertrain', 'Intake & air filter', /intake|airfilter/),
  A('powertrain', 'Exhaust manifold', /exhaustmanifold/),
  A('powertrain', 'Brake booster', /brakebooster/),
  A('powertrain', 'Engine & transmission', /./),
  A('cooling', 'Radiator frame', /frame/),
  A('cooling', 'Radiator & fan', /./),
  A('electrical', 'Battery', /battery/),
  A('electrical', 'Headlights', /headl/, true),
  A('electrical', 'Tail lights', /taill/, true),
  A('interior', 'Seat belts', /seatbelt/, true),
  A('interior', 'Front seats', /seatfront|seatront|frontseat|seatfoam|seatfloor/, true),
  A('interior', 'Rear seat', /seatrear|rearseat|seatfoamback/),
  A('interior', 'Headrests', /headrest/, true),
  A('interior', 'Airbags', /airbag|curtab|knee/),
  A('interior', 'Pillar & panel trim', /trim/, true),
  A('interior', 'Center console', /consol|emergencybreak/),
  A('interior', 'Dashboard', /dash|ipbeam|instrument|glove/),
  A('connections', 'Seat covers (null shells)', /null/),
  A('connections', 'Connectors & adhesive', /./),
];

/** Assembly label for a part, e.g. "Front door L". Falls back to the group label. */
export function assemblyOf(name, group, centroid) {
  const n = normalise(name);
  const a = ASSEMBLIES.find((x) => x.group === group && x.re.test(n));
  const label = a ? a.label : GROUPS.find((g) => g.id === group)?.label || 'Other';
  if (!a?.sided || !centroid) return label;
  const y = centroid[1];
  return y > 150 ? `${label} L` : y < -150 ? `${label} R` : label;
}
