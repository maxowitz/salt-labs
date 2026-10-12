// FORGE exercise library — kettlebell, running, ergs, bodyweight, HYROX stations and mobility.
// Model per docs/PROMPT.md §6.5. loadRatio is × bodyweight PER BELL (used by coach.suggestWeight).
// Extra fields: `track` ('reps'|'time'|'distance') hints the logging UI; `equip` names gear beyond bells.

const E = (id, name, category, pattern, o = {}) => ({
  id, name, category, pattern,
  unilateral: !!o.uni,
  double: !!o.dbl,
  muscles: o.muscles || [],
  cues: o.cues || [],
  faults: o.faults || [],
  regression: o.reg || null,
  progression: o.prog || null,
  track: o.track || (category === 'run' || category === 'erg' ? 'distance' : 'reps'),
  ...(o.hyrox ? { hyrox: o.hyrox } : {}),
  ...(o.equip ? { equip: o.equip } : {}),
  ...(o.lr ? { loadRatio: { beginner: o.lr[0], intermediate: o.lr[1], advanced: o.lr[2] } } : {}),
});

const POST = ['glutes', 'hamstrings', 'lats', 'erectors', 'core'];

export const EXERCISES = [
  // ---------------- Kettlebell: ballistics ----------------
  E('kb-dead-swing', 'Dead-Stop Swing', 'kb', 'ballistic', {
    muscles: POST, lr: [0.2, 0.28, 0.36], prog: 'kb-swing',
    cues: ['Bell a foot in front of you, hike it back high between the thighs', 'Snap hips and squeeze glutes to float the bell to chest height', 'Let it fall back and park it on the floor every rep — reset your wedge'],
    faults: ['Squatting the bell instead of hinging', 'Lifting with the arms', 'Losing a flat back on the park'],
  }),
  E('kb-swing', 'Two-Hand Swing', 'kb', 'ballistic', {
    muscles: POST, lr: [0.22, 0.3, 0.4], reg: 'kb-dead-swing', prog: 'kb-swing-1h',
    cues: ['Hike pass: wrists high in the groin, forearms on the inner thighs', 'Hips snap, knees lock, glutes and abs brace hard — a vertical plank at the top', 'Bell floats to chest height on hip power, arms are just ropes', 'Exhale sharply at the top; wait for the bell before you hinge'],
    faults: ['Squatting rather than hinging (knees travel forward)', 'Leaning back at the top / hyperextending the low back', 'Hinging too early so the bell drags you forward', 'Bell below the knees on the backswing'],
  }),
  E('kb-swing-1h', 'One-Arm Swing', 'kb', 'ballistic', {
    uni: true, muscles: [...POST, 'obliques', 'grip'], lr: [0.18, 0.28, 0.36], reg: 'kb-swing', prog: 'kb-snatch',
    cues: ['Shoulder packed — pull it back into the socket, resist the rotation', 'Free hand mirrors the bell or guards the hip', 'Same hip snap as the two-hand swing; square shoulders to the front'],
    faults: ['Shoulder pulled forward out of the socket', 'Torso twisting with the bell', 'Gripping too tight — forearm burns out before the hips do'],
  }),
  E('kb-swing-double', 'Double Swing', 'kb', 'ballistic', {
    dbl: true, muscles: [...POST, 'upper back', 'grip'], lr: [0.14, 0.2, 0.26], reg: 'kb-swing', prog: 'kb-double-clean',
    cues: ['Wider stance so both bells pass between the knees', 'Hike high and tight — bells into the zipper', 'Snap and stand tall; bells float, they are not raised'],
    faults: ['Stance too narrow — bells hit the knees', 'Rounding the upper back under the load', 'Short, squatty backswing'],
  }),
  E('kb-swing-squat', 'Swing to Squat', 'kb', 'ballistic', {
    muscles: [...POST, 'quads'], lr: [0.16, 0.22, 0.28], reg: 'kb-swing', prog: 'kb-thruster',
    cues: ['Swing to chest height, catch the bell by the horns at the top', 'Drop straight into a goblet squat, elbows inside the knees', 'Stand, release back into the next swing'],
    faults: ['Catching with bent wrists and a soft core', 'Squat depth shrinking as you fatigue'],
  }),
  E('kb-high-pull', 'High Pull', 'kb', 'ballistic', {
    muscles: ['glutes', 'hamstrings', 'traps', 'rear delts', 'lats'], lr: [0.18, 0.26, 0.34], reg: 'kb-swing', prog: 'kb-snatch',
    cues: ['Swing it, then at float pull the elbow back and high', 'Elbow leads, bell stays close to the body', 'Hips still do 80% of the work'],
    faults: ['Turning it into an arm-only row', 'Shrugging into the neck', 'Leaning back to finish the pull'],
  }),
  E('kb-clean', 'Clean', 'kb', 'ballistic', {
    uni: true, muscles: [...POST, 'biceps', 'forearms'], lr: [0.16, 0.22, 0.3], reg: 'kb-swing-1h', prog: 'kb-double-clean',
    cues: ['Short swing, then zip the bell up the body like a jacket zipper', 'Hand spears through the handle, bell lands softly on the forearm', 'Rack: elbow on the hip, wrist straight, fist at the chin'],
    faults: ['Bell flipping over and banging the wrist', 'Casting the bell out wide', 'Rack elbow floating away from the ribs'],
  }),
  E('kb-double-clean', 'Double Clean', 'kb', 'ballistic', {
    dbl: true, muscles: [...POST, 'biceps', 'upper back'], lr: [0.12, 0.18, 0.26], reg: 'kb-clean', prog: 'kb-double-clean-press',
    cues: ['Wide stance, hike both bells back between the knees', 'Hips snap, elbows stay tight, bells zip up together', 'Land in a solid double rack — exhale and brace'],
    faults: ['Bells crashing on the forearms', 'Upper back collapsing in the rack', 'Using the arms to curl the bells up'],
  }),
  E('kb-snatch', 'Snatch', 'kb', 'ballistic', {
    uni: true, muscles: [...POST, 'shoulders', 'traps', 'grip'], lr: [0.14, 0.2, 0.28], reg: 'kb-high-pull', prog: 'kb-swing-double',
    cues: ['Swing, high pull, then punch through the handle at the top', 'Lock out overhead with biceps by the ear, wrist straight', 'Drop it over the top and hike back — keep the elbow close'],
    faults: ['Bell arcing wide and flipping onto the forearm', 'Pressing out the last few inches', 'Torn hands from a death grip — hook and relax'],
  }),

  // ---------------- Kettlebell: grinds ----------------
  E('kb-deadlift', 'Kettlebell Deadlift', 'kb', 'hinge', {
    muscles: POST, lr: [0.25, 0.38, 0.48], prog: 'kb-swing',
    cues: ['Bell between the mid-feet, shins near vertical', 'Push hips back, flat back, grab and pull the slack out', 'Drive the floor away and finish with glutes, not the low back'],
    faults: ['Squatting the bell up', 'Rounded lumbar spine', 'Bell too far in front of the feet'],
  }),
  E('kb-suitcase-deadlift', 'Suitcase Deadlift', 'kb', 'hinge', {
    uni: true, muscles: [...POST, 'obliques', 'grip'], lr: [0.22, 0.32, 0.42], reg: 'kb-deadlift', prog: 'kb-sl-rdl',
    cues: ['Bell beside one foot, square hips and shoulders', 'Pack the lat and resist leaning toward the bell', 'Stand tall, pause, lower under control'],
    faults: ['Side-bending toward the bell', 'Shoulder pulled down and forward'],
  }),
  E('kb-double-deadlift', 'Double Deadlift', 'kb', 'hinge', {
    dbl: true, muscles: [...POST, 'traps', 'grip'], lr: [0.2, 0.3, 0.4], reg: 'kb-deadlift', prog: 'kb-swing-double',
    cues: ['Bells inside the feet, handles aligned', 'Lats tight like squeezing oranges in the armpits', 'Push through the floor; lockout with glutes'],
    faults: ['Bells drifting forward', 'Hips shooting up first'],
  }),
  E('kb-rdl', 'Kettlebell RDL', 'kb', 'hinge', {
    muscles: ['hamstrings', 'glutes', 'erectors'], lr: [0.22, 0.32, 0.42], reg: 'kb-deadlift', prog: 'kb-sl-rdl',
    cues: ['Soft knees, push the hips straight back', 'Bell slides down the thighs to just below the knee', '3-second lowering; feel the hamstrings load'],
    faults: ['Turning it into a squat', 'Rounding to chase depth'],
  }),
  E('kb-sl-rdl', 'Single-Leg RDL', 'kb', 'hinge', {
    uni: true, muscles: ['hamstrings', 'glutes', 'adductors', 'feet'], lr: [0.12, 0.2, 0.28], reg: 'kb-rdl', prog: 'kb-suitcase-deadlift',
    cues: ['Bell in the hand opposite the standing leg', 'Reach the back heel to the wall; hips stay square', 'Long line head to heel, tripod foot grips the floor'],
    faults: ['Hip opening toward the ceiling', 'Rushing the balance — slow down'],
  }),
  E('kb-goblet-squat', 'Goblet Squat', 'kb', 'squat', {
    muscles: ['quads', 'glutes', 'adductors', 'core'], lr: [0.2, 0.3, 0.38], prog: 'kb-front-squat',
    cues: ['Hold the bell by the horns at the chest, elbows down', 'Sit between the heels, elbows track inside the knees', 'Chest tall, drive up through the whole foot'],
    faults: ['Heels lifting', 'Knees caving in', 'Bell drifting away from the chest'],
  }),
  E('kb-front-squat', 'Single Front Squat', 'kb', 'squat', {
    uni: true, muscles: ['quads', 'glutes', 'obliques'], lr: [0.16, 0.24, 0.32], reg: 'kb-goblet-squat', prog: 'kb-double-front-squat',
    cues: ['Clean to a tight rack; brace against the off-load', 'Pull yourself down with the hip flexors', 'Stand straight up — do not lean away from the bell'],
    faults: ['Rack elbow drifting off the ribs', 'Leaning toward the free side'],
  }),
  E('kb-double-front-squat', 'Double Front Squat', 'kb', 'squat', {
    dbl: true, muscles: ['quads', 'glutes', 'upper back', 'core'], lr: [0.14, 0.22, 0.3], reg: 'kb-front-squat', prog: 'kb-double-thruster',
    cues: ['Clean both bells, elbows tucked, forearms vertical', 'Big breath to the belt, descend under control', 'Drive up chest-first, power exhale at the top'],
    faults: ['Upper back rounding under the bells', 'Elbows flaring and bells sliding off the rack'],
  }),
  E('kb-press', 'Strict Press', 'kb', 'press', {
    uni: true, muscles: ['shoulders', 'triceps', 'lats', 'core'], lr: [0.12, 0.2, 0.28], reg: 'kb-bottoms-up-press', prog: 'kb-double-press',
    cues: ['Start from a perfect rack; squeeze glutes, quads and the fist', 'Press the bell up and slightly out, forearm vertical', 'Lockout with biceps by the ear; pull it back down with the lat'],
    faults: ['Leaning back to finish', 'Soft wrist bent back', 'Dropping the bell instead of pulling it down'],
  }),
  E('kb-double-press', 'Double Press', 'kb', 'press', {
    dbl: true, muscles: ['shoulders', 'triceps', 'upper back', 'core'], lr: [0.1, 0.16, 0.24], reg: 'kb-press', prog: 'kb-double-push-press',
    cues: ['Glutes locked, ribs down — no back bend', 'Press both bells up in a slight arc, finish together', 'Forearms vertical all the way'],
    faults: ['Excessive layback', 'One arm racing ahead'],
  }),
  E('kb-bottoms-up-press', 'Bottoms-Up Press', 'kb', 'press', {
    uni: true, muscles: ['shoulders', 'rotator cuff', 'grip', 'core'], lr: [0.06, 0.1, 0.14], prog: 'kb-press',
    cues: ['Crush grip, bell balanced upside down', 'Wrist straight, elbow under the bell', 'Press slowly — if it wobbles you are rushing'],
    faults: ['Loose grip so the bell topples', 'Elbow flaring wide'],
  }),
  E('kb-push-press', 'Push Press', 'kb', 'press', {
    uni: true, muscles: ['shoulders', 'triceps', 'quads', 'glutes'], lr: [0.14, 0.22, 0.3], reg: 'kb-press', prog: 'kb-jerk',
    cues: ['Short, quick dip — knees forward, heels down', 'Drive hard and let the legs launch the bell', 'Finish with a strict lockout overhead'],
    faults: ['Dip too deep and slow', 'Heels lifting in the dip', 'Pressing before the legs finish'],
  }),
  E('kb-double-push-press', 'Double Push Press', 'kb', 'press', {
    dbl: true, muscles: ['shoulders', 'triceps', 'quads', 'core'], lr: [0.1, 0.18, 0.26], reg: 'kb-double-press', prog: 'kb-double-thruster',
    cues: ['Elbows on the ribs to transfer leg drive', 'Dip-drive is one fast motion', 'Lock both elbows, ribs stay down'],
    faults: ['Elbows away from the body leaks the drive', 'Excess lumbar arch at lockout'],
  }),
  E('kb-jerk', 'Single Jerk', 'kb', 'press', {
    uni: true, muscles: ['shoulders', 'triceps', 'quads', 'calves'], lr: [0.14, 0.24, 0.32], reg: 'kb-push-press', prog: 'kb-clean-jerk',
    cues: ['Dip, drive, then drop under the bell with a second dip', 'Lock the arm while still in the undersquat', 'Stand up to a fixation before lowering'],
    faults: ['Pressing it out instead of dropping under', 'No pause at lockout'],
  }),
  E('kb-floor-press', 'Floor Press', 'kb', 'press', {
    uni: true, muscles: ['chest', 'triceps', 'shoulders'], lr: [0.14, 0.22, 0.3], reg: 'bw-pushup', prog: 'kb-press',
    cues: ['Roll to the side to get the bell into position safely', 'Upper arm at 45°, pause the triceps on the floor', 'Press up and slightly in, wrist straight'],
    faults: ['Bouncing the elbow off the floor', 'Wrist bent back'],
  }),
  E('kb-tgu', 'Turkish Get-Up', 'kb', 'core', {
    uni: true, muscles: ['shoulders', 'core', 'glutes', 'hips'], lr: [0.12, 0.2, 0.3], reg: 'kb-armbar', prog: 'kb-windmill',
    cues: ['Eyes on the bell until standing; arm locked to the ceiling', 'Roll to elbow, post to hand, high bridge, sweep the leg', 'Each position is a pause — slow is smooth'],
    faults: ['Bent working elbow', 'Rushing the transitions', 'Hand placed too close to the hip'],
  }),
  E('kb-armbar', 'Kettlebell Armbar', 'kb', 'mobility', {
    uni: true, lr: [0.1, 0.16, 0.24], muscles: ['rotator cuff', 'thoracic spine', 'lats'], prog: 'kb-tgu',
    cues: ['Lock the bell overhead, roll toward the opposite side', 'Top leg crosses, chest opens to the floor', 'Pack the shoulder; breathe into the stretch'],
    faults: ['Bell arm drifting off vertical', 'Rushing the roll'],
  }),
  E('kb-windmill', 'Windmill', 'kb', 'core', {
    uni: true, muscles: ['obliques', 'hamstrings', 'shoulders', 'glutes'], lr: [0.1, 0.16, 0.24], reg: 'kb-tgu', prog: 'kb-bottoms-up-press',
    cues: ['Bell locked overhead, feet turned 45° away from it', 'Push the hip toward the bell and hinge sideways', 'Free hand slides down the inside of the leg; eyes on the bell'],
    faults: ['Bending the overhead arm', 'Squatting instead of hinging'],
  }),
  E('kb-row', 'Bent-Over Row', 'kb', 'pull', {
    uni: true, muscles: ['lats', 'rhomboids', 'biceps', 'rear delts'], lr: [0.18, 0.28, 0.38], prog: 'kb-gorilla-row',
    cues: ['Staggered stance, free hand on the knee, flat back', 'Row the elbow to the back pocket', 'Pause at the top, lower all the way to a stretch'],
    faults: ['Twisting the torso to cheat the bell up', 'Shrugging toward the ear'],
  }),
  E('kb-gorilla-row', 'Gorilla Row', 'kb', 'pull', {
    dbl: true, muscles: ['lats', 'upper back', 'core', 'hamstrings'], lr: [0.16, 0.24, 0.32], reg: 'kb-row', prog: 'kb-renegade-row',
    cues: ['Wide stance, deep hinge, bells between the feet', 'Row one while pushing the other into the floor', 'Hips stay square and still'],
    faults: ['Rotating the hips', 'Standing up out of the hinge'],
  }),
  E('kb-renegade-row', 'Renegade Row', 'kb', 'pull', {
    dbl: true, muscles: ['lats', 'core', 'chest', 'shoulders'], lr: [0.1, 0.16, 0.22], reg: 'kb-gorilla-row', prog: 'kb-row',
    cues: ['High plank on two bells, feet wide', 'Row without the hips moving — squeeze glutes', 'Optional push-up between reps'],
    faults: ['Hips rotating open', 'Feet too narrow'],
  }),
  E('kb-towel-drag', 'Backward Towel Drag', 'kb', 'pull', {
    muscles: ['quads', 'lats', 'biceps', 'grip', 'upper back'], lr: [0.3, 0.4, 0.5], equip: 'Towel or rope', hyrox: 'sled-pull', reg: 'kb-row', prog: 'kb-gorilla-row',
    cues: ['Loop a towel through the handle, sit low in an athletic stance', 'Pull hand over hand, then walk backwards with short steps', 'Arms pull, legs drive — like the HYROX sled pull'],
    faults: ['Standing tall and pulling with the low back', 'Long, unstable steps'],
  }),
  E('kb-halo', 'Halo', 'kb', 'mobility', {
    muscles: ['shoulders', 'upper back', 'core'], lr: [0.08, 0.12, 0.16], prog: 'kb-around-world',
    cues: ['Hold the bell upside down by the horns', 'Circle close around the head, ribs stay down', 'Switch direction each rep'],
    faults: ['Arching the back to make room', 'Big wide circles far from the head'],
  }),
  E('kb-around-world', 'Around the World', 'kb', 'core', {
    muscles: ['core', 'grip', 'glutes'], lr: [0.1, 0.14, 0.2], reg: 'kb-halo',
    cues: ['Pass the bell hand to hand around the waist', 'Hips and shoulders stay still — brace like a pillar', 'Change direction each set'],
    faults: ['Hips swaying with the bell'],
  }),

  // ---------------- Kettlebell: lunges, thrusters, complexes ----------------
  E('kb-rack-lunge', 'Front-Rack Lunge', 'kb', 'lunge', {
    uni: true, muscles: ['quads', 'glutes', 'adductors', 'core'], lr: [0.12, 0.2, 0.26], reg: 'bw-lunge', prog: 'kb-rack-walking-lunge',
    cues: ['Bell racked on the same side as the stepping leg (or opposite for more core)', 'Step long enough to drop the back knee straight down', 'Push through the front heel to return'],
    faults: ['Front knee collapsing in', 'Torso folding forward'],
  }),
  E('kb-rack-reverse-lunge', 'Front-Rack Reverse Lunge', 'kb', 'lunge', {
    uni: true, muscles: ['glutes', 'quads', 'adductors'], lr: [0.12, 0.2, 0.26], reg: 'bw-lunge', prog: 'kb-rack-lunge',
    cues: ['Step back softly, knee kisses the floor', 'Weight stays in the front foot', 'Stand tall, glute squeeze at the top'],
    faults: ['Slamming the back knee', 'Narrow tightrope stance'],
  }),
  E('kb-rack-walking-lunge', 'Double Front-Rack Walking Lunge', 'kb', 'lunge', {
    dbl: true, muscles: ['quads', 'glutes', 'core', 'upper back'], lr: [0.1, 0.16, 0.22], reg: 'kb-goblet-walking-lunge', hyrox: 'sandbag-lunges',
    cues: ['Bells racked tight, elbows on the ribs', 'Back knee touches the ground every step (HYROX standard)', 'Steady rhythm — breathe out as you stand'],
    faults: ['Short steps that overload the knees', 'Rack collapsing as you tire'],
  }),
  E('kb-goblet-walking-lunge', 'Goblet Walking Lunge', 'kb', 'lunge', {
    muscles: ['quads', 'glutes', 'core'], lr: [0.16, 0.24, 0.3], reg: 'bw-lunge', prog: 'kb-rack-walking-lunge', hyrox: 'sandbag-lunges',
    cues: ['Bell by the horns at the chest', 'Knee touches the floor every rep, torso upright', 'Drive through the front foot straight into the next step'],
    faults: ['Leaning forward under the bell', 'Skipping the knee touch'],
  }),
  E('kb-lateral-lunge', 'Cossack / Lateral Lunge', 'kb', 'lunge', {
    uni: true, muscles: ['adductors', 'glutes', 'quads'], lr: [0.08, 0.14, 0.2], reg: 'mob-deep-squat', prog: 'kb-goblet-squat',
    cues: ['Wide stance, sit into one hip with the other leg straight', 'Goblet hold as a counterweight', 'Heel of the working leg stays down'],
    faults: ['Heel lifting', 'Rounding the back to get low'],
  }),
  E('kb-step-up', 'Goblet Step-Up', 'kb', 'lunge', {
    uni: true, muscles: ['quads', 'glutes'], lr: [0.12, 0.2, 0.26], reg: 'bw-lunge', prog: 'kb-rack-lunge', equip: 'Box or bench',
    cues: ['Whole foot on the box, knee-height or lower', 'Drive through the top leg — no push from the back foot', 'Control the step down'],
    faults: ['Bouncing off the bottom foot', 'Knee diving inward'],
  }),
  E('kb-thruster', 'Single Thruster', 'kb', 'squat', {
    uni: true, muscles: ['quads', 'glutes', 'shoulders', 'core'], lr: [0.1, 0.16, 0.22], reg: 'kb-goblet-thruster', prog: 'kb-double-thruster',
    cues: ['Front squat from the rack', 'Use the drive out of the bottom to send the bell overhead', 'Lower to the rack as you descend into the next rep'],
    faults: ['Pausing at the top of the squat and pressing strict', 'Leaning away from the bell'],
  }),
  E('kb-double-thruster', 'Double Thruster', 'kb', 'squat', {
    dbl: true, muscles: ['quads', 'glutes', 'shoulders', 'triceps'], lr: [0.08, 0.14, 0.2], reg: 'kb-thruster', hyrox: 'wall-balls',
    cues: ['Elbows tight in the rack, full-depth squat', 'One smooth drive — legs launch the bells', 'Breathe at the top, not at the bottom'],
    faults: ['Shallow squats', 'Bells drifting forward overhead'],
  }),
  E('kb-goblet-thruster', 'Goblet Thruster', 'kb', 'squat', {
    muscles: ['quads', 'glutes', 'shoulders'], lr: [0.1, 0.16, 0.22], reg: 'kb-goblet-squat', prog: 'kb-thruster', hyrox: 'wall-balls',
    cues: ['Goblet squat to full depth, bell at the chest', 'Explode up and press the bell overhead by the horns', 'Rhythm like wall balls: sets of 10–15 with short breaths'],
    faults: ['Squatting high as fatigue builds', 'Pressing with a soft core'],
  }),
  E('kb-clean-press', 'Clean & Press', 'kb', 'press', {
    uni: true, muscles: [...POST, 'shoulders', 'triceps'], lr: [0.12, 0.18, 0.24], reg: 'kb-clean', prog: 'kb-double-clean-press',
    cues: ['Clean to a quiet rack, pause for a breath', 'Strict press, then lower back to the rack', 'Swing down from the rack into the next clean'],
    faults: ['Pressing off a sloppy rack', 'Rushing reps so the press becomes a push press'],
  }),
  E('kb-double-clean-press', 'Double Clean & Press', 'kb', 'press', {
    dbl: true, muscles: [...POST, 'shoulders', 'triceps', 'upper back'], lr: [0.1, 0.16, 0.22], reg: 'kb-clean-press', prog: 'kb-clean-jerk',
    cues: ['Double clean, brace, double press', 'Lower to rack, then let the bells fall into the backswing', 'Tight lats on every transition'],
    faults: ['Bells crashing on the forearms', 'Back bending during the press'],
  }),
  E('kb-clean-jerk', 'Clean & Jerk (Long Cycle)', 'kb', 'press', {
    uni: true, muscles: [...POST, 'shoulders', 'quads', 'triceps'], lr: [0.14, 0.22, 0.3], reg: 'kb-clean-press', prog: 'kb-snatch',
    cues: ['Clean, settle, jerk — breathe at each station', 'Relax in the rack; let the bell rest on the body', 'Pace like a long-distance runner, not a sprinter'],
    faults: ['Gripping the bell in the rack', 'Pressing out the jerk'],
  }),

  // ---------------- Kettlebell: carries & crawls ----------------
  E('kb-farmers-carry', 'Farmers Carry', 'kb', 'carry', {
    dbl: true, track: 'distance', muscles: ['grip', 'traps', 'core', 'glutes'], lr: [0.2, 0.3, 0.4], reg: 'kb-suitcase-carry', hyrox: 'farmers',
    cues: ['Deadlift the bells, stand tall, shoulders packed', 'Short quick steps, eyes forward', 'Breathe behind the brace; put them down before the grip fails'],
    faults: ['Shrugging shoulders to ears', 'Over-striding so the bells swing'],
  }),
  E('kb-suitcase-carry', 'Suitcase Carry', 'kb', 'carry', {
    uni: true, track: 'distance', muscles: ['obliques', 'grip', 'glutes'], lr: [0.2, 0.3, 0.4], prog: 'kb-farmers-carry', hyrox: 'farmers',
    cues: ['One bell, stand perfectly upright', 'Resist the lean — the obliques do the work', 'Switch hands at halfway'],
    faults: ['Leaning away or toward the bell', 'Swinging the bell'],
  }),
  E('kb-rack-carry', 'Front-Rack Carry', 'kb', 'carry', {
    dbl: true, track: 'distance', muscles: ['core', 'upper back', 'quads', 'glutes'], lr: [0.14, 0.22, 0.3], reg: 'kb-suitcase-carry', hyrox: 'sled-push',
    cues: ['Bells in a tight rack, elbows on the ribs', 'Breathe shallow behind a braced trunk', 'Drive the floor — the sled-push substitute: lean slightly, short powerful steps'],
    faults: ['Leaning back to hold the bells', 'Holding the breath for the whole carry'],
  }),
  E('kb-overhead-carry', 'Overhead Carry', 'kb', 'carry', {
    uni: true, track: 'distance', muscles: ['shoulders', 'core', 'upper back'], lr: [0.1, 0.16, 0.22], reg: 'kb-rack-carry', prog: 'kb-tgu',
    cues: ['Lock the arm, biceps by the ear', 'Ribs down, glutes on, walk tall', 'Look forward, not at the bell'],
    faults: ['Elbow softening', 'Arching the low back'],
  }),
  E('kb-bear-crawl-drag', 'Bear Crawl Drag', 'kb', 'core', {
    track: 'distance', muscles: ['shoulders', 'core', 'quads', 'chest'], lr: [0.14, 0.2, 0.28], reg: 'bw-bear-crawl', hyrox: 'sled-push',
    cues: ['Bear position: knees an inch off the floor, back flat', 'Reach under and drag the bell through, then crawl past it', 'Hips stay level — balance a cup on your back'],
    faults: ['Hips rocking side to side', 'Knees touching the floor'],
  }),

  // ---------------- Running ----------------
  E('run', 'Run', 'run', 'cardio', { muscles: ['legs', 'heart & lungs'], cues: ['Tall posture, quick light feet', 'Relaxed shoulders and hands', 'Hit the prescribed pace, not more'], faults: ['Over-striding / heel braking', 'Starting too fast'] }),
  E('run-easy', 'Easy Run (Zone 2)', 'run', 'cardio', {
    track: 'time', muscles: ['legs', 'heart & lungs'], prog: 'run-long',
    cues: ['Conversational: you can speak full sentences', 'Nose breathing for most of it is a good check', 'Slow down on hills to keep HR in Zone 2'],
    faults: ['Drifting into Zone 3 "grey zone"', 'Racing your easy days'],
  }),
  E('run-recovery', 'Recovery Jog', 'run', 'cardio', {
    track: 'time', muscles: ['legs'], prog: 'run-easy',
    cues: ['Very easy — slower than easy pace', 'Short, soft steps; walk breaks are fine', 'Purpose: blood flow, not fitness'],
    faults: ['Turning it into a workout'],
  }),
  E('run-long', 'Long Run', 'run', 'cardio', {
    track: 'time', muscles: ['legs', 'heart & lungs'], reg: 'run-easy',
    cues: ['Start slower than you think', 'Fuel and hydrate if over 75 min', 'Finish feeling you could do 15 more minutes'],
    faults: ['Pace creeping up in the first half', 'Skipping it when time is short — shorten instead'],
  }),
  E('run-tempo', 'Tempo Run', 'run', 'cardio', {
    track: 'time', muscles: ['legs', 'heart & lungs'], reg: 'run-easy', prog: 'run-threshold',
    cues: ['Comfortably hard: a few words at a time', 'Even pacing — same split every km', 'Relax the face and shoulders'],
    faults: ['Going out at 5 km pace', 'Fading badly in the last third'],
  }),
  E('run-threshold', 'Threshold Run', 'run', 'cardio', {
    muscles: ['legs', 'heart & lungs'], reg: 'run-tempo', prog: 'run-1k',
    cues: ['Pace you could hold ~ 60 min in a race', 'Controlled discomfort; breathing deep and rhythmic', 'Short recoveries keep it threshold, not VO2'],
    faults: ['Running reps too fast and missing the point'],
  }),
  E('run-intervals', 'Run Intervals', 'run', 'cardio', {
    muscles: ['legs', 'heart & lungs'], reg: 'run-tempo', prog: 'run-1k',
    cues: ['Hard but repeatable — last rep as fast as the first', 'Drive the arms, stay tall', 'Jog or walk the recoveries'],
    faults: ['First rep too fast', 'Standing still in recoveries'],
  }),
  E('run-1k', '1 km Run', 'run', 'cardio', {
    muscles: ['legs', 'heart & lungs'], reg: 'run-intervals', prog: 'hx-ski',
    cues: ['The HYROX unit: every race run is 1 km', 'Lock in pace by 200 m and hold it', 'Practise running smoothly off fatigue'],
    faults: ['Sprinting the first 200 m', 'Letting pace drift late in the rep'],
  }),
  E('run-strides', 'Strides', 'run', 'cardio', {
    track: 'time', muscles: ['legs', 'hip flexors'], prog: 'run-hill-sprints',
    cues: ['15–20 s building to ~ 90% speed, smooth not straining', 'Fast feet, tall hips', 'Full recovery walk back'],
    faults: ['Sprinting all-out', 'Tensing the shoulders'],
  }),
  E('run-hill-sprints', 'Hill Sprints', 'run', 'cardio', {
    track: 'time', muscles: ['glutes', 'calves', 'quads', 'heart & lungs'], reg: 'run-strides', hyrox: 'sled-push',
    cues: ['8–12 s hard up a steep hill — high knees, powerful arms', 'Lean from the ankles like pushing a sled', 'Walk down, full recovery'],
    faults: ['Too long so it becomes a conditioning rep', 'Short recoveries'],
  }),
  E('run-fartlek', 'Fartlek', 'run', 'cardio', {
    track: 'time', muscles: ['legs', 'heart & lungs'], reg: 'run-easy', prog: 'run-intervals',
    cues: ['Alternate surges and floats by feel', 'Surges at 10 km–5 km effort', 'Floats stay a genuine jog'],
    faults: ['Floats too fast so surges die'],
  }),

  // ---------------- Ergs ----------------
  E('erg-row', 'Row Erg', 'erg', 'cardio', {
    equip: 'Rower', muscles: ['legs', 'back', 'arms', 'heart & lungs'], prog: 'hx-row',
    cues: ['Legs → body → arms; arms → body → legs on the return', 'Damper 4–6; power comes from the leg drive', 'Ratio: drive fast, recover 2× slower'],
    faults: ['Bending the knees before the hands pass them', 'Pulling with the arms first'],
  }),
  E('erg-ski', 'SkiErg', 'erg', 'cardio', {
    equip: 'SkiErg', muscles: ['lats', 'triceps', 'core', 'hips'], prog: 'hx-ski',
    cues: ['Tall, arms high, then crunch the lats and hips together', 'Hands finish by the thighs, hinge — do not squat', 'Let the handles pull you back up'],
    faults: ['Arms-only pulling', 'Squatting deep on every stroke'],
  }),
  E('erg-bike', 'Bike Erg / Air Bike', 'erg', 'cardio', {
    equip: 'Bike', muscles: ['quads', 'glutes', 'heart & lungs'],
    cues: ['Seat height: slight knee bend at the bottom', 'Steady cadence 80–95 rpm for aerobic work', 'Push and pull through the pedal stroke'],
    faults: ['Bouncing in the saddle', 'Grinding a cadence too low'],
  }),

  // ---------------- Bodyweight ----------------
  E('bw-burpee', 'Burpee', 'bodyweight', 'ballistic', {
    muscles: ['chest', 'quads', 'shoulders', 'heart & lungs'], prog: 'bw-bbj',
    cues: ['Chest and thighs to the floor', 'Snap the feet in, stand and clap overhead', 'Find a rhythm you can breathe through'],
    faults: ['Worm-like push-up with sagging hips', 'Landing feet wide and flat-footed'],
  }),
  E('bw-bbj', 'Burpee Broad Jump', 'bodyweight', 'ballistic', {
    track: 'distance', muscles: ['quads', 'glutes', 'chest', 'heart & lungs'], reg: 'bw-burpee', prog: 'hx-bbj', hyrox: 'bbj',
    cues: ['Chest to floor, step or jump feet in', 'Two-foot jump forward — moderate distance, land soft', 'Efficiency beats distance: step up, don’t pop up'],
    faults: ['Max-effort jumps that fry the legs early', 'Hands placed too far ahead of the feet'],
  }),
  E('bw-pushup', 'Push-Up', 'bodyweight', 'press', {
    muscles: ['chest', 'triceps', 'shoulders', 'core'], prog: 'kb-floor-press',
    cues: ['Hands under shoulders, body in one line', 'Elbows 45° from the body, chest to fist height', 'Screw the hands into the floor'],
    faults: ['Sagging hips', 'Elbows flared straight out'],
  }),
  E('bw-pullup', 'Pull-Up', 'bodyweight', 'pull', {
    equip: 'Pull-up bar', muscles: ['lats', 'biceps', 'upper back', 'grip'], reg: 'kb-row',
    cues: ['Dead hang, shoulders pulled down first', 'Drive the elbows to the hips, chin over the bar', 'Lower all the way under control'],
    faults: ['Kipping half reps', 'Shrugging into the bar'],
  }),
  E('bw-air-squat', 'Air Squat', 'bodyweight', 'squat', {
    muscles: ['quads', 'glutes'], prog: 'kb-goblet-squat',
    cues: ['Hips below knees, heels down', 'Knees track over the toes', 'Arms forward for balance'],
    faults: ['Heels rising', 'Partial range'],
  }),
  E('bw-jump-squat', 'Jump Squat', 'bodyweight', 'ballistic', {
    muscles: ['quads', 'glutes', 'calves'], reg: 'bw-air-squat',
    cues: ['Quarter to half squat, explode', 'Land quietly and absorb into the next rep'],
    faults: ['Stiff, loud landings', 'Knees caving on the land'],
  }),
  E('bw-lunge', 'Walking Lunge', 'bodyweight', 'lunge', {
    muscles: ['quads', 'glutes'], prog: 'kb-goblet-walking-lunge',
    cues: ['Knee touches the floor gently', 'Torso upright', 'Drive through the front heel'],
    faults: ['Short steps', 'Front knee caving'],
  }),
  E('bw-plank', 'Plank', 'bodyweight', 'core', {
    track: 'time', muscles: ['abs', 'glutes', 'shoulders'], prog: 'bw-hollow-hold',
    cues: ['Elbows under shoulders, squeeze glutes and quads', 'Pull elbows toward toes — RKC plank', 'Short, hard holds beat long sloppy ones'],
    faults: ['Hips sagging', 'Butt high'],
  }),
  E('bw-side-plank', 'Side Plank', 'bodyweight', 'core', {
    uni: true, track: 'time', muscles: ['obliques', 'glute med', 'shoulders'], prog: 'kb-suitcase-carry',
    cues: ['Elbow under shoulder, hips high', 'Body in one straight line'],
    faults: ['Hips dropping', 'Rolling forward'],
  }),
  E('bw-hollow-hold', 'Hollow Hold', 'bodyweight', 'core', {
    track: 'time', muscles: ['abs', 'hip flexors'], reg: 'bw-dead-bug',
    cues: ['Low back glued to the floor', 'Arms and legs long, as low as you can keep the back down'],
    faults: ['Low back arching off the floor'],
  }),
  E('bw-dead-bug', 'Dead Bug', 'bodyweight', 'core', {
    muscles: ['abs', 'hip flexors'], prog: 'bw-hollow-hold',
    cues: ['Ribs down, back flat', 'Extend opposite arm and leg slowly, exhale fully'],
    faults: ['Back arching as the leg lowers', 'Moving fast'],
  }),
  E('bw-mountain-climber', 'Mountain Climber', 'bodyweight', 'core', {
    muscles: ['abs', 'hip flexors', 'shoulders'], reg: 'bw-plank',
    cues: ['Strong plank, shoulders over hands', 'Drive knees to chest quickly, hips level'],
    faults: ['Hips bouncing high'],
  }),
  E('bw-bear-crawl', 'Bear Crawl', 'bodyweight', 'core', {
    track: 'distance', muscles: ['shoulders', 'core', 'quads'], prog: 'kb-bear-crawl-drag',
    cues: ['Knees hover an inch off the floor', 'Opposite hand and foot move together', 'Back flat, hips level'],
    faults: ['Hips high like a downward dog'],
  }),
  E('bw-jumping-jack', 'Jumping Jacks', 'bodyweight', 'cardio', { track: 'time', muscles: ['calves', 'shoulders'], cues: ['Light on the balls of the feet', 'Full arm range'], faults: ['Flat-footed landings'] }),
  E('bw-a-skip', 'A-Skips', 'bodyweight', 'cardio', {
    track: 'distance', muscles: ['hip flexors', 'calves'], prog: 'run-strides',
    cues: ['Drive the knee to hip height, opposite arm swing', 'Strike down under the hip — stiff ankle'],
    faults: ['Leaning back', 'Floppy ankles'],
  }),
  E('bw-band-pulldown', 'Band Straight-Arm Pulldown', 'bodyweight', 'pull', {
    equip: 'Resistance band', muscles: ['lats', 'triceps', 'core'], hyrox: 'skierg', prog: 'erg-ski',
    cues: ['Band anchored high, arms straight', 'Pull hands to the thighs with a slight hip hinge — SkiErg pattern', 'Control the return'],
    faults: ['Bending the elbows into a row'],
  }),

  // ---------------- HYROX stations (race spec in engine/hyrox.js STATIONS) ----------------
  E('hx-ski', 'SkiErg 1000 m', 'hyrox', 'cardio', {
    track: 'distance', equip: 'SkiErg', hyrox: 'skierg', muscles: ['lats', 'triceps', 'core', 'hips'], reg: 'erg-ski',
    cues: ['Settle into a long, strong stroke; do not blow up in the first 200 m', 'Hinge with the pull, hands to the thighs', 'Aim for a pace ~ 3–5 s/500 m slower than your 1 km test'],
    faults: ['Arm-dominant stroke that fries the triceps for the sleds'],
  }),
  E('hx-sled-push', 'Sled Push 50 m', 'hyrox', 'carry', {
    track: 'distance', equip: 'Sled', hyrox: 'sled-push', muscles: ['quads', 'glutes', 'calves', 'core'], reg: 'kb-rack-carry',
    cues: ['Arms long or bent, body at 45°, drive through the balls of the feet', 'Short powerful steps — never stop the sled moving', 'Turn efficiently at each 12.5 m length'],
    faults: ['Standing too upright', 'Stop-start pushing (restarting is the hardest part)'],
  }),
  E('hx-sled-pull', 'Sled Pull 50 m', 'hyrox', 'pull', {
    track: 'distance', equip: 'Sled + rope', hyrox: 'sled-pull', muscles: ['lats', 'biceps', 'grip', 'quads'], reg: 'kb-towel-drag',
    cues: ['Athletic stance, sit back, long hand-over-hand pulls', 'Use the legs: step back between pulls', 'Keep the rope tidy in the box'],
    faults: ['Pulling only with the arms', 'Standing tall — no leverage'],
  }),
  E('hx-bbj', 'Burpee Broad Jumps 80 m', 'hyrox', 'ballistic', {
    track: 'distance', hyrox: 'bbj', muscles: ['quads', 'glutes', 'chest', 'heart & lungs'], reg: 'bw-bbj',
    cues: ['Rhythm over distance: step-up burpee, moderate jump', 'Hands within a foot of your toes', 'Breathe on every rep'],
    faults: ['Big jumps early that crush the legs for the run'],
  }),
  E('hx-row', 'Row 1000 m', 'hyrox', 'cardio', {
    track: 'distance', equip: 'Rower', hyrox: 'row', muscles: ['legs', 'back', 'arms'], reg: 'erg-row',
    cues: ['Damper 5–6, 26–30 spm', 'Leg drive first — save the arms for later stations', 'Steady split ~ 5–8 s/500 m slower than your 1 km test'],
    faults: ['Sprinting the start', 'Arm-pulling'],
  }),
  E('hx-farmers', 'Farmers Carry 200 m', 'hyrox', 'carry', {
    track: 'distance', hyrox: 'farmers', muscles: ['grip', 'traps', 'core'], reg: 'kb-farmers-carry',
    cues: ['Fast short steps — almost a power walk', 'Set the bells down once, deliberately, if you must', 'Chalk / dry hands before you pick up'],
    faults: ['Shrugged shoulders', 'Multiple unplanned drops'],
  }),
  E('hx-sandbag-lunge', 'Sandbag Lunges 100 m', 'hyrox', 'lunge', {
    track: 'distance', equip: 'Sandbag', hyrox: 'sandbag-lunges', muscles: ['quads', 'glutes', 'core'], reg: 'kb-goblet-walking-lunge',
    cues: ['Bag high on the upper back/shoulders', 'Back knee touches every rep, stand fully each step', 'Steady, unbroken rhythm beats fast-and-stop'],
    faults: ['No-rep knee touches', 'Bag sliding down the back'],
  }),
  E('hx-wall-balls', 'Wall Balls', 'hyrox', 'squat', {
    hyrox: 'wall-balls', equip: 'Wall ball', muscles: ['quads', 'glutes', 'shoulders'], reg: 'kb-goblet-thruster',
    cues: ['Full squat below parallel, ball at the chin', 'Drive with the legs; the arms just guide it', 'Pre-planned sets (e.g. 25-25-20-15-15) with short breaks'],
    faults: ['Missing the target line', 'Shallow squats as you fatigue'],
  }),

  // ---------------- Mobility & warm-up ----------------
  E('mob-90-90', 'Hip 90/90 Switches', 'mobility', 'mobility', { muscles: ['hips', 'glutes'], cues: ['Sit tall with both knees at 90°', 'Rotate knees side to side without using hands', 'Pause and lean over the front shin'], faults: ['Collapsing the spine'] }),
  E('mob-wgs', "World's Greatest Stretch", 'mobility', 'mobility', { muscles: ['hips', 'hamstrings', 'thoracic spine'], cues: ['Long lunge, elbow to instep', 'Rotate and reach the same arm to the sky', 'Straighten the front leg to finish'], faults: ['Back knee collapsing'] }),
  E('mob-cat-cow', 'Cat-Cow', 'mobility', 'mobility', { muscles: ['spine'], cues: ['Move segment by segment', 'Exhale to round, inhale to extend'], faults: ['Only moving at the neck'] }),
  E('mob-t-spine', 'Thoracic Rotation (Open Book)', 'mobility', 'mobility', { uni: true, muscles: ['thoracic spine', 'chest'], cues: ['Side-lying, knees stacked at 90°', 'Open the top arm and follow it with the eyes', 'Exhale into the end range'], faults: ['Knees separating'] }),
  E('mob-ankle-rocks', 'Ankle Rocks', 'mobility', 'mobility', { uni: true, muscles: ['calves', 'ankles'], cues: ['Half-kneeling, drive the knee over the toes', 'Heel stays glued down'], faults: ['Heel lifting', 'Knee caving inward'] }),
  E('mob-glute-bridge', 'Glute Bridge', 'mobility', 'hinge', { muscles: ['glutes', 'hamstrings'], prog: 'kb-deadlift', cues: ['Heels close to the hips, ribs down', 'Squeeze glutes to lift, hold 2 s at the top'], faults: ['Arching the low back'] }),
  E('mob-band-pull-apart', 'Band Pull-Apart', 'mobility', 'pull', { equip: 'Resistance band', muscles: ['rear delts', 'rhomboids'], cues: ['Arms straight, pull the band to the chest', 'Squeeze the shoulder blades, no shrug'], faults: ['Elbows bending', 'Ribs flaring'] }),
  E('mob-ytw', 'Prone Y-T-W', 'mobility', 'pull', { muscles: ['lower traps', 'rear delts', 'rotator cuff'], cues: ['Face down, thumbs up', 'Lift arms into Y, T, then W — 2 s hold each'], faults: ['Shrugging', 'Lifting the chest instead of the arms'] }),
  E('mob-hip-flexor', 'Half-Kneeling Hip Flexor Stretch', 'mobility', 'mobility', { uni: true, track: 'time', muscles: ['hip flexors', 'quads'], cues: ['Tuck the pelvis and squeeze the back glute', 'Small shift forward — the stretch is at the front of the hip'], faults: ['Arching the low back to fake range'] }),
  E('mob-couch', 'Couch Stretch', 'mobility', 'mobility', { uni: true, track: 'time', muscles: ['quads', 'hip flexors'], reg: 'mob-hip-flexor', cues: ['Back shin up a wall or couch', 'Squeeze the glute and lift the chest slowly'], faults: ['Arching the back'] }),
  E('mob-pigeon', 'Pigeon Stretch', 'mobility', 'mobility', { uni: true, track: 'time', muscles: ['glutes', 'hip rotators'], cues: ['Front shin angled under you, back leg long', 'Square hips, fold over the front leg'], faults: ['Rolling onto the hip'] }),
  E('mob-childs-pose', "Child's Pose", 'mobility', 'mobility', { track: 'time', muscles: ['lats', 'low back'], cues: ['Knees wide, hips to heels, arms long', 'Breathe into the back of the ribs'], faults: [] }),
  E('mob-leg-swings', 'Leg Swings', 'mobility', 'mobility', { uni: true, muscles: ['hamstrings', 'hip flexors', 'adductors'], cues: ['Front-to-back then side-to-side', 'Grow the range gradually, stay tall'], faults: ['Rounding the back to swing higher'] }),
  E('mob-arm-circles', 'Arm Circles', 'mobility', 'mobility', { muscles: ['shoulders'], cues: ['Small to big, both directions'], faults: [] }),
  E('mob-calf-stretch', 'Calf Stretch', 'mobility', 'mobility', { uni: true, track: 'time', muscles: ['calves', 'achilles'], cues: ['Straight knee then bent knee', 'Heel down, hips forward'], faults: ['Foot turned out'] }),
  E('mob-thread-needle', 'Thread the Needle', 'mobility', 'mobility', { uni: true, muscles: ['thoracic spine', 'shoulders'], cues: ['From all fours, slide one arm under and rotate', 'Open back up to the ceiling'], faults: ['Hips shifting back'] }),
  E('mob-deep-squat', 'Deep Squat Hold', 'mobility', 'squat', { track: 'time', muscles: ['hips', 'ankles', 'adductors'], prog: 'kb-goblet-squat', cues: ['Sit in the bottom, heels down', 'Elbows pry the knees out gently'], faults: ['Heels lifting'] }),
  E('mob-hamstring-floss', 'Hamstring Floss', 'mobility', 'mobility', { uni: true, muscles: ['hamstrings', 'sciatic nerve'], cues: ['Seated or supine, extend the knee as you look up', 'Gentle, rhythmic — never forced'], faults: ['Bouncing hard into the stretch'] }),
  E('mob-foam-roll', 'Foam Roll', 'mobility', 'mobility', { track: 'time', equip: 'Foam roller', muscles: ['quads', 'calves', 'upper back'], cues: ['Slow passes, pause on tender spots', 'Breathe and relax into it'], faults: ['Rolling fast and hard'] }),
  E('mob-breathing', 'Crocodile Breathing', 'mobility', 'core', { track: 'time', muscles: ['diaphragm'], cues: ['Face down, forehead on hands', 'Breathe into the belly and low back — 4 s in, 6 s out', 'Down-regulate: let the heart rate settle'], faults: ['Chest-only breathing'] }),
  E('mob-walk', 'Easy Walk', 'mobility', 'cardio', { track: 'time', muscles: ['legs'], cues: ['Relaxed pace, nasal breathing', 'Great after hard sessions or on low-readiness days'], faults: [] }),
];

const BY_ID = new Map(EXERCISES.map((e) => [e.id, e]));

const pretty = (id) => String(id || 'exercise')
  .replace(/^(kb|bw|mob|hx|erg|run)-/, '')
  .replace(/[-_]+/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

// Safe lookup: unknown ids return a neutral placeholder so views never crash.
export function getExercise(id) {
  const ex = BY_ID.get(id);
  if (ex) return ex;
  return {
    id: String(id || 'unknown'), name: pretty(id), category: 'kb', pattern: 'core', unilateral: false, double: false,
    muscles: [], cues: [], faults: [], regression: null, progression: null, track: 'reps', unknown: true,
  };
}

export const hasExercise = (id) => BY_ID.has(id);
