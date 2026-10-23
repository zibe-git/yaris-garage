// Level catalogue: a hand-picked campaign (left-hand, driver-side assemblies where there is a choice)
// plus free play over every group and assembly in the manifest.
// select entries are "group/assembly"; "group/*" takes the whole group.

export const CAMPAIGN = [
  { id: 'wheel', title: 'Front wheel', blurb: 'Warm-up: tyre, brake disc and hub.', select: ['wheels/Front wheels & brakes L'] },
  { id: 'bumper', title: 'Front bumper', blurb: 'Plastic cover, steel beam and brackets — no order to worry about yet.', select: ['bumpers/Front bumper'] },
  { id: 'hood', title: 'Hood', blurb: 'Skin, inner panel and the lift brackets.', select: ['closures/Hood'] },
  { id: 'strut', title: 'Front strut', blurb: 'Shock, rod, spring seat and mounts.', select: ['suspension/Front struts L'] },
  { id: 'corner', title: 'Front corner', blurb: 'Wheel, strut, control arm and knuckle in one go.', select: ['wheels/Front wheels & brakes L', 'suspension/Front struts L', 'suspension/Lower control arms L', 'suspension/Uprights / knuckles L'] },
  { id: 'door', title: 'Front door', blurb: 'Trim, inner panel, foam, impact beams and the outer skin.', select: ['closures/Front door L'] },
  { id: 'rear-door', title: 'Rear door', blurb: 'Same idea, fewer handholds.', select: ['closures/Rear door L'] },
  { id: 'radiator', title: 'Cooling pack', blurb: 'Radiator, fan and the frame that holds them.', select: ['cooling/Radiator & fan', 'cooling/Radiator frame'] },
  { id: 'steering', title: 'Steering', blurb: 'Wheel, column and rack.', select: ['steering/Steering column & wheel', 'steering/Steering rack'] },
  { id: 'seat', title: 'Driver seat', blurb: 'Frame, rails, foam and covers.', select: ['interior/Front seats L'] },
  { id: 'side', title: 'Body side', blurb: 'Pillars, sill and side panel of the welded shell.', select: ['body/A-pillar L', 'body/B-pillar L', 'body/C-pillar L', 'body/Rocker / sill L', 'body/Side panel L'], maxParts: 22 },
  { id: 'dash', title: 'Dashboard', blurb: 'Instrument panel, cross-car beam and console.', select: ['interior/Dashboard', 'interior/Center console'], maxParts: 22 },
  { id: 'biw', title: 'Body-in-white', blurb: 'Boss level: the whole welded steel shell.', select: ['body/*'], maxParts: 36 },
];

const matches = (sel, p) => {
  const [g, a] = sel.split('/');
  return p.group === g && (a === '*' || p.assembly === a);
};

/** Attach the level's part ids; null when the model has fewer than two of its parts. */
export function resolveLevel(manifest, def) {
  const pids = manifest.parts.filter((p) => def.select.some((s) => matches(s, p))).map((p) => p.pid);
  return pids.length >= 2 ? { maxParts: 18, ...def, pids } : null;
}

export function campaign(manifest) {
  return CAMPAIGN.map((d) => resolveLevel(manifest, d)).filter(Boolean);
}

/** Free play: every group (as a whole) and each of its assemblies with at least three parts. */
export function freePlay(manifest) {
  const out = [];
  for (const g of manifest.groups) {
    const parts = manifest.parts.filter((p) => p.group === g.id);
    if (parts.length < 3) continue;
    const assemblies = [...new Set(parts.map((p) => p.assembly).filter(Boolean))].sort();
    const levels = assemblies
      .map((a) => resolveLevel(manifest, { id: `a:${g.id}/${a}`, title: a, blurb: g.label, select: [`${g.id}/${a}`] }))
      .filter((l) => l && l.pids.length >= 3);
    const whole = resolveLevel(manifest, { id: `g:${g.id}`, title: `All of ${g.label}`, blurb: g.label, select: [`${g.id}/*`], maxParts: 30 });
    out.push({ id: g.id, label: g.label, color: g.color, levels: levels.length > 1 || !levels.length ? [whole, ...levels] : levels });
  }
  return out;
}

export function findLevel(manifest, id) {
  const fromCampaign = CAMPAIGN.find((d) => d.id === id);
  if (fromCampaign) return resolveLevel(manifest, fromCampaign);
  for (const g of freePlay(manifest)) for (const l of g.levels) if (l.id === id) return l;
  return null;
}
