// Helpdesk questionnaire and likely-cause suggestions.
//
// Each product group has a short list of questions the helpdesk executive
// asks on the call, and a list of possible causes. Each cause has weighted
// evidence from the answers and from keywords in the customer's own words.
// Causes that technicians confirmed on earlier closed jobs get a small
// boost, so suggestions improve as history builds up.

import type { JobType, Priority, ProductCategory } from '../db/types';

export type ProductGroup = 'ac' | 'fridge' | 'washer' | 'tv' | 'cooker' | 'microwave' | 'other';

export interface Question {
  id: string;
  text: string;
  /** Options to choose from; omitted for free-text questions. */
  options?: string[];
}

interface Evidence {
  q: string;
  /** Answer(s) that support this cause. */
  a: string | string[];
  w: number;
}

export interface Cause {
  id: string;
  name: string;
  /** What the technician should check / do. */
  check: string;
  /** Something the customer can safely try while still on the call. */
  selfHelp?: string;
  /** Spares / consumables the technician should carry. */
  carry?: string[];
  jobType?: JobType;
  evidence: Evidence[];
  keywords: [RegExp, number][];
}

interface Urgency {
  q: string;
  a: string | string[];
  priority: Priority;
  advice: string;
}

interface GroupDef {
  label: string;
  questions: Question[];
  causes: Cause[];
  urgent?: Urgency[];
}

const YN = ['Yes', 'No'];
const YNU = ['Yes', 'No', "Don't know"];

const KB: Record<ProductGroup, GroupDef> = {
  // ------------------------------------------------------ air conditioners
  ac: {
    label: 'Air conditioner',
    questions: [
      { id: 'power', text: 'Does the indoor unit power on (display or light comes on)?', options: YN },
      { id: 'remote', text: 'Does the unit respond to the remote (beeps)?', options: YNU },
      { id: 'fan', text: 'Is air blowing from the indoor unit?', options: YN },
      { id: 'air', text: 'How does the air feel?', options: ['Cold', 'Slightly cool', 'Room temperature', 'Warm'] },
      { id: 'outdoor', text: 'Is the outdoor unit running (fan turning, humming)?', options: ['Yes', 'No', 'Starts then stops', "Don't know"] },
      { id: 'error', text: 'Error code or blinking light on the display? (note the code)' },
      { id: 'water', text: 'Is water dripping from the indoor unit?', options: YN },
      { id: 'ice', text: 'Is there ice or frost on the pipes or indoor coil?', options: YNU },
      { id: 'noise', text: 'Any unusual noise?', options: ['None', 'Indoor rattling', 'Outdoor loud / knocking', 'Clicking'] },
      { id: 'smell', text: 'Any smell?', options: ['None', 'Musty / bad smell', 'Burning smell'] },
      { id: 'trip', text: 'Does it trip the breaker or cut the stabiliser?', options: YN },
      { id: 'service', text: 'When was it last serviced / cleaned?', options: ['< 3 months', '3–12 months', '> 1 year', 'Never'] },
      { id: 'recent', text: 'Was it installed or shifted recently (last 3 months)?', options: YN },
      { id: 'regas', text: 'Has gas been refilled on this unit before?', options: YNU },
    ],
    urgent: [
      { q: 'smell', a: 'Burning smell', priority: 'Critical', advice: 'Ask the customer to switch off the unit and the breaker now, and not use it until the technician visits.' },
      { q: 'trip', a: 'Yes', priority: 'High', advice: 'Tell the customer not to keep resetting the breaker. Leave the unit off until the visit.' },
    ],
    causes: [
      {
        id: 'ac-gas-leak',
        name: 'Refrigerant leak / low gas',
        check: 'Check suction pressure and current, and do a soap/nitrogen leak test on the flare nuts, coils and service valves. Repair the leak, vacuum and weigh in the charge.',
        carry: ['Refrigerant (unit type)', 'Dry nitrogen', 'Brazing gas & rods', 'Flare nuts'],
        jobType: 'Leak Repair + Full Recharge',
        evidence: [
          { q: 'air', a: ['Slightly cool', 'Room temperature'], w: 3 },
          { q: 'outdoor', a: 'Yes', w: 1 },
          { q: 'ice', a: 'Yes', w: 2 },
          { q: 'regas', a: 'Yes', w: 3 },
          { q: 'fan', a: 'Yes', w: 1 },
        ],
        keywords: [[/gas|not cool|low cool|less cool|no cool|ice|frost|hiss/, 2]],
      },
      {
        id: 'ac-dirty',
        name: 'Dirty filters / coil (service due)',
        check: 'Clean the filters, indoor coil and blower, and wash the outdoor condenser. Check airflow and temperature drop.',
        selfHelp: 'Ask the customer to take out and wash the indoor filters, then try again after 15 minutes.',
        carry: ['Coil cleaner', 'Service pump'],
        jobType: 'Preventive Maintenance',
        evidence: [
          { q: 'air', a: 'Slightly cool', w: 2 },
          { q: 'service', a: ['> 1 year', 'Never'], w: 3 },
          { q: 'smell', a: 'Musty / bad smell', w: 2 },
          { q: 'ice', a: 'Yes', w: 1 },
          { q: 'water', a: 'Yes', w: 1 },
        ],
        keywords: [[/dust|dirty|smell|weak air|low air|service/, 2]],
      },
      {
        id: 'ac-capacitor',
        name: 'Outdoor unit not starting: capacitor / contactor / wiring',
        check: 'Check the supply at the outdoor unit, the run capacitor (µF), the contactor and the interconnect wiring.',
        carry: ['Run capacitor', 'Fan capacitor', 'Contactor'],
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'outdoor', a: 'No', w: 4 },
          { q: 'air', a: ['Room temperature', 'Warm'], w: 2 },
          { q: 'fan', a: 'Yes', w: 1 },
          { q: 'power', a: 'Yes', w: 1 },
        ],
        keywords: [[/outdoor.*(not|off|stopp)|hum|compressor not/, 2]],
      },
      {
        id: 'ac-compressor',
        name: 'Compressor failure / overload tripping',
        check: 'Measure the compressor winding resistance and insulation, and check the overload and running current. Confirm before ordering a compressor.',
        carry: ['Compressor (confirm model)', 'Refrigerant (unit type)', 'Filter drier', 'Brazing gas & rods', 'Dry nitrogen'],
        jobType: 'Compressor Replacement',
        evidence: [
          { q: 'outdoor', a: 'Starts then stops', w: 3 },
          { q: 'trip', a: 'Yes', w: 2 },
          { q: 'noise', a: 'Outdoor loud / knocking', w: 2 },
          { q: 'air', a: 'Warm', w: 2 },
          { q: 'smell', a: 'Burning smell', w: 1 },
        ],
        keywords: [[/compressor|trip|knock|burn/, 2]],
      },
      {
        id: 'ac-power',
        name: 'Power supply / voltage problem',
        check: 'Measure the supply voltage at the socket and isolator, check the stabiliser, breaker rating and cable size.',
        selfHelp: 'Ask the customer to check the breaker/isolator is on and the stabiliser display shows normal voltage.',
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'power', a: 'No', w: 3 },
          { q: 'trip', a: 'Yes', w: 2 },
          { q: 'outdoor', a: 'Starts then stops', w: 1 },
        ],
        keywords: [[/voltage|power cut|stabili[sz]er|breaker|trip|escom|low power/, 3]],
      },
      {
        id: 'ac-pcb',
        name: 'Indoor PCB / display board fault',
        check: 'Check the fuse and transformer on the indoor PCB, the display board and the communication with the outdoor unit. Look up the error code in the service manual.',
        carry: ['Indoor PCB (model specific)', 'Display board'],
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'power', a: 'No', w: 2 },
          { q: 'remote', a: 'No', w: 2 },
          { q: 'error', a: '*', w: 2 },
        ],
        keywords: [[/dead|no display|error|blink|code|e\d|p\d|f\d/, 2]],
      },
      {
        id: 'ac-remote',
        name: 'Remote control / batteries',
        check: 'Test the remote with a phone camera (IR), replace the batteries and check the IR receiver.',
        selfHelp: 'Ask the customer to replace the remote batteries, or use the manual/emergency button on the indoor unit.',
        carry: ['Universal remote'],
        jobType: 'Inspection / Diagnosis',
        evidence: [
          { q: 'remote', a: 'No', w: 3 },
          { q: 'power', a: 'Yes', w: 1 },
        ],
        keywords: [[/remote/, 4]],
      },
      {
        id: 'ac-fan-motor',
        name: 'Indoor fan motor fault',
        check: 'Check the indoor fan motor, its capacitor and hall sensor, and the blower wheel.',
        carry: ['Indoor fan motor', 'Fan capacitor'],
        jobType: 'Mechanical Repair',
        evidence: [
          { q: 'fan', a: 'No', w: 4 },
          { q: 'power', a: 'Yes', w: 1 },
          { q: 'ice', a: 'Yes', w: 1 },
        ],
        keywords: [[/no air|fan not|not blowing|no wind/, 3]],
      },
      {
        id: 'ac-drain',
        name: 'Blocked drain / drain pipe slope',
        check: 'Clear the drain tray and pipe with nitrogen or a pump, and check the slope of the drain pipe and the level of the unit.',
        jobType: 'Mechanical Repair',
        evidence: [
          { q: 'water', a: 'Yes', w: 4 },
          { q: 'recent', a: 'Yes', w: 1 },
        ],
        keywords: [[/water|drip|leak(ing)? water|wet wall/, 3]],
      },
      {
        id: 'ac-install',
        name: 'Installation fault (pipe length, vacuum, flare)',
        check: 'Check the installation: pipe length and extra charge, vacuum done, flare quality, insulation and drain slope.',
        carry: ['Refrigerant (unit type)', 'Flare nuts', 'Insulation tape'],
        jobType: 'Re-installation / Shifting',
        evidence: [
          { q: 'recent', a: 'Yes', w: 3 },
          { q: 'air', a: 'Slightly cool', w: 1 },
          { q: 'water', a: 'Yes', w: 1 },
        ],
        keywords: [[/install|shift|moved|new unit/, 2]],
      },
      {
        id: 'ac-sensor',
        name: 'Temperature sensor (thermistor) fault',
        check: 'Measure the room, coil and outdoor thermistor resistance against the service manual.',
        carry: ['Thermistor set'],
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'error', a: '*', w: 2 },
          { q: 'outdoor', a: 'Starts then stops', w: 1 },
        ],
        keywords: [[/sensor|thermistor|stops? by itself|switch(es)? off/, 2]],
      },
      {
        id: 'ac-noise',
        name: 'Loose panel / mounting / fan blade noise',
        check: 'Tighten panels and mounting, check the fan blades and blower wheel for damage, and fit anti-vibration pads.',
        jobType: 'Mechanical Repair',
        evidence: [{ q: 'noise', a: ['Indoor rattling', 'Outdoor loud / knocking'], w: 3 }],
        keywords: [[/noise|rattl|vibrat|sound/, 2]],
      },
    ],
  },

  // --------------------------------------------------- fridges / freezers
  fridge: {
    label: 'Refrigerator / freezer',
    questions: [
      { id: 'power', text: 'Does it power on (inside light / display)?', options: YN },
      { id: 'comp', text: 'Is the compressor running (humming, warm at the back)?', options: ['Yes', 'No', 'Clicks on and off', "Don't know"] },
      { id: 'cool', text: 'What is the cooling like?', options: ['Nothing cools', 'Freezer OK, fridge warm', 'Both weak', 'Over-freezing'] },
      { id: 'frost', text: 'Heavy ice build-up on the back wall / evaporator?', options: YNU },
      { id: 'water', text: 'Water inside or under the unit?', options: YN },
      { id: 'door', text: 'Does the door seal close properly?', options: YN },
      { id: 'noise', text: 'Any unusual noise?', options: ['None', 'Loud humming', 'Rattling', 'Clicking'] },
      { id: 'hot', text: 'Are the sides / back very hot?', options: YN },
      { id: 'moved', text: 'Was it recently moved, or is it overloaded / close to the wall?', options: YN },
      { id: 'regas', text: 'Has gas been refilled on this unit before?', options: YNU },
    ],
    causes: [
      {
        id: 'fr-gas-leak',
        name: 'Refrigerant leak / low gas',
        check: 'Check for oil marks, leak test with nitrogen, repair, replace the filter drier, vacuum and weigh in the nameplate charge.',
        carry: ['Refrigerant (unit type)', 'Filter drier', 'Dry nitrogen', 'Brazing gas & rods', 'Process tube'],
        jobType: 'Leak Repair + Full Recharge',
        evidence: [
          { q: 'comp', a: 'Yes', w: 2 },
          { q: 'cool', a: ['Nothing cools', 'Both weak'], w: 2 },
          { q: 'regas', a: 'Yes', w: 3 },
          { q: 'frost', a: 'No', w: 1 },
        ],
        keywords: [[/gas|not cool|no cool|warm|not freez/, 2]],
      },
      {
        id: 'fr-relay',
        name: 'Compressor starting relay / overload (or compressor)',
        check: 'Check the PTC relay, the overload and the compressor windings. Replace the relay first if the windings are OK.',
        carry: ['PTC relay', 'Overload protector', 'Start capacitor'],
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'comp', a: 'Clicks on and off', w: 4 },
          { q: 'comp', a: 'No', w: 2 },
          { q: 'power', a: 'Yes', w: 1 },
          { q: 'hot', a: 'Yes', w: 1 },
        ],
        keywords: [[/click|tick|compressor/, 2]],
      },
      {
        id: 'fr-thermostat',
        name: 'Thermostat / control board fault',
        check: 'Check the thermostat continuity and setting, or the control board and sensor on electronic models.',
        selfHelp: 'Ask the customer to check the thermostat knob is not on 0 / OFF, and set it to the middle.',
        carry: ['Thermostat (fridge/freezer)'],
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'cool', a: 'Over-freezing', w: 4 },
          { q: 'comp', a: 'No', w: 2 },
          { q: 'power', a: 'Yes', w: 1 },
        ],
        keywords: [[/too cold|over.?freez|freez(es|ing) everything|thermostat|knob/, 3]],
      },
      {
        id: 'fr-defrost',
        name: 'Defrost system fault (heater / timer / bimetal)',
        check: 'On frost-free models, check the defrost heater, timer or board, and the bimetal. Defrost the evaporator.',
        carry: ['Defrost heater', 'Defrost timer', 'Bimetal'],
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'cool', a: 'Freezer OK, fridge warm', w: 3 },
          { q: 'frost', a: 'Yes', w: 3 },
          { q: 'water', a: 'Yes', w: 1 },
        ],
        keywords: [[/ice|frost|block of ice|fridge (side|part) warm/, 2]],
      },
      {
        id: 'fr-gasket',
        name: 'Door gasket damaged / door not closing',
        check: 'Check the gasket seal (paper test), the door alignment and the hinges. Replace the gasket if torn.',
        selfHelp: 'Ask the customer to check that nothing is blocking the door and that it closes firmly.',
        carry: ['Door gasket (model specific)'],
        jobType: 'Mechanical Repair',
        evidence: [
          { q: 'door', a: 'No', w: 4 },
          { q: 'frost', a: 'Yes', w: 1 },
          { q: 'water', a: 'Yes', w: 1 },
          { q: 'cool', a: 'Both weak', w: 1 },
        ],
        keywords: [[/door|seal|gasket|rubber/, 3]],
      },
      {
        id: 'fr-choke',
        name: 'Capillary / filter drier choke',
        check: 'Look for frost at the drier outlet and a pressure imbalance. Replace the drier, clean the capillary with nitrogen, vacuum and recharge.',
        carry: ['Filter drier', 'Refrigerant (unit type)', 'Dry nitrogen', 'Brazing gas & rods'],
        jobType: 'Coil / Pipe Replacement',
        evidence: [
          { q: 'comp', a: 'Yes', w: 1 },
          { q: 'cool', a: 'Nothing cools', w: 2 },
          { q: 'hot', a: 'Yes', w: 1 },
          { q: 'regas', a: 'No', w: 1 },
        ],
        keywords: [[/not cool|no cool/, 1]],
      },
      {
        id: 'fr-ventilation',
        name: 'Poor ventilation / condenser fan / overloading',
        check: 'Check the clearance from the wall, the condenser fan (if fitted), and clean the condenser. Advise on loading.',
        selfHelp: 'Ask the customer to leave 10 cm of space behind the unit and avoid overloading it.',
        carry: ['Condenser fan motor'],
        jobType: 'Preventive Maintenance',
        evidence: [
          { q: 'hot', a: 'Yes', w: 2 },
          { q: 'cool', a: 'Both weak', w: 1 },
          { q: 'moved', a: 'Yes', w: 2 },
        ],
        keywords: [[/hot|overload|full|wall/, 2]],
      },
      {
        id: 'fr-power',
        name: 'Power supply / socket / voltage',
        check: 'Check the socket, plug, cord, voltage and stabiliser/guard.',
        selfHelp: 'Ask the customer to try another socket and check the fridge guard / stabiliser.',
        jobType: 'PCB / Electrical Repair',
        evidence: [{ q: 'power', a: 'No', w: 4 }],
        keywords: [[/dead|no power|voltage|socket|plug|guard/, 3]],
      },
      {
        id: 'fr-drain',
        name: 'Blocked defrost drain',
        check: 'Clear the drain hole and tube, and check the drip tray.',
        jobType: 'Mechanical Repair',
        evidence: [
          { q: 'water', a: 'Yes', w: 3 },
          { q: 'frost', a: 'Yes', w: 1 },
        ],
        keywords: [[/water|leak|puddle/, 2]],
      },
      {
        id: 'fr-noise',
        name: 'Levelling / loose parts / fan noise',
        check: 'Level the unit, fix the compressor mounting and pipe contact, and check the fans.',
        jobType: 'Mechanical Repair',
        evidence: [{ q: 'noise', a: ['Rattling', 'Loud humming'], w: 3 }],
        keywords: [[/noise|rattl|vibrat|sound/, 2]],
      },
    ],
  },

  // ------------------------------------------------------ washing machines
  washer: {
    label: 'Washing machine',
    questions: [
      { id: 'power', text: 'Does it power on (display / lights)?', options: YN },
      { id: 'fill', text: 'Does water fill into the drum?', options: ['Yes', 'No', 'Slowly', 'Overfills'] },
      { id: 'drain', text: 'Does it drain the water?', options: YN },
      { id: 'spin', text: 'Does the drum spin / wash?', options: ['Yes', 'No', 'Noisy'] },
      { id: 'error', text: 'Error code on the display? (note the code)' },
      { id: 'leak', text: 'Is water leaking onto the floor?', options: YN },
      { id: 'door', text: 'Is there a door / lid problem (won’t lock or won’t open)?', options: YN },
      { id: 'vibration', text: 'Does it shake or walk heavily?', options: YN },
      { id: 'smell', text: 'Any burning smell?', options: YN },
    ],
    urgent: [{ q: 'smell', a: 'Yes', priority: 'High', advice: 'Ask the customer to unplug the machine and not use it until the visit.' }],
    causes: [
      {
        id: 'wm-inlet',
        name: 'Water supply / inlet valve / filter blocked',
        check: 'Check the tap pressure, the inlet hose filter and the inlet valve coil.',
        selfHelp: 'Ask the customer to make sure the tap is fully open and there is water pressure.',
        carry: ['Inlet valve'],
        jobType: 'Mechanical Repair',
        evidence: [{ q: 'fill', a: ['No', 'Slowly'], w: 4 }],
        keywords: [[/no water|not fill|slow fill|tap/, 3]],
      },
      {
        id: 'wm-drain',
        name: 'Drain pump / filter blocked',
        check: 'Clean the pump filter, check the drain pump and the drain hose for kinks or blockage.',
        selfHelp: 'Ask the customer to check the drain hose is not kinked or raised too high.',
        carry: ['Washing machine drain pump'],
        jobType: 'Mechanical Repair',
        evidence: [
          { q: 'drain', a: 'No', w: 4 },
          { q: 'spin', a: 'No', w: 1 },
        ],
        keywords: [[/not drain|water stays|water remain|drain/, 3]],
      },
      {
        id: 'wm-drive',
        name: 'Belt / motor / carbon brushes / capacitor',
        check: 'Check the drive belt, the motor carbon brushes, the motor capacitor (semi-automatic models) and the gearbox.',
        carry: ['Drive belt', 'Carbon brushes', 'Motor capacitor'],
        jobType: 'Mechanical Repair',
        evidence: [
          { q: 'spin', a: 'No', w: 3 },
          { q: 'drain', a: 'Yes', w: 1 },
          { q: 'fill', a: 'Yes', w: 1 },
        ],
        keywords: [[/not spin|no spin|drum not|belt|motor/, 3]],
      },
      {
        id: 'wm-door',
        name: 'Door lock / lid switch fault',
        check: 'Check the door interlock or lid switch and its wiring.',
        carry: ['Door lock / lid switch'],
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'door', a: 'Yes', w: 4 },
          { q: 'power', a: 'Yes', w: 1 },
        ],
        keywords: [[/door|lid|lock/, 3]],
      },
      {
        id: 'wm-bearing',
        name: 'Drum bearing / shock absorbers / unbalanced load',
        check: 'Check the drum bearings and seal, the shock absorbers and suspension springs, and whether the transit bolts were removed.',
        selfHelp: 'Ask the customer to spread the load evenly and check the machine is level.',
        carry: ['Bearing & seal kit', 'Shock absorbers'],
        jobType: 'Mechanical Repair',
        evidence: [
          { q: 'spin', a: 'Noisy', w: 3 },
          { q: 'vibration', a: 'Yes', w: 3 },
        ],
        keywords: [[/noise|shak|vibrat|walk|bang|rumbl/, 3]],
      },
      {
        id: 'wm-leak',
        name: 'Hose / door seal / tub leak',
        check: 'Check the inlet and drain hose joints, the door bellow seal and the tub seal.',
        carry: ['Door seal (bellow)', 'Hose clamps'],
        jobType: 'Mechanical Repair',
        evidence: [{ q: 'leak', a: 'Yes', w: 4 }],
        keywords: [[/leak|floor|wet/, 3]],
      },
      {
        id: 'wm-pressure',
        name: 'Pressure (level) switch fault',
        check: 'Check the pressure switch and its air tube for blockage.',
        carry: ['Pressure switch'],
        jobType: 'PCB / Electrical Repair',
        evidence: [{ q: 'fill', a: 'Overfills', w: 4 }],
        keywords: [[/overfill|too much water|overflow/, 3]],
      },
      {
        id: 'wm-pcb',
        name: 'Control PCB / power supply',
        check: 'Check the supply, fuse and control PCB. Look up the error code.',
        carry: ['Control PCB (model specific)'],
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'power', a: 'No', w: 3 },
          { q: 'error', a: '*', w: 2 },
          { q: 'smell', a: 'Yes', w: 1 },
        ],
        keywords: [[/dead|no power|error|code|display/, 2]],
      },
    ],
  },

  // -------------------------------------------------------------- TVs
  tv: {
    label: 'Television',
    questions: [
      { id: 'standby', text: 'Is the standby light on?', options: YN },
      { id: 'picture', text: 'What is on the screen?', options: ['No picture', 'Lines / patches', 'Very dim', 'Stuck on logo / restarts', 'Normal'] },
      { id: 'sound', text: 'Is there sound?', options: YN },
      { id: 'remote', text: 'Does it respond to the remote?', options: YNU },
      { id: 'damage', text: 'Any physical damage (cracks, fall, water)?', options: YN },
      { id: 'signal', text: 'Does it show “No signal” on some inputs / channels only?', options: YN },
      { id: 'surge', text: 'Was there a power surge / lightning / power cut before it failed?', options: YN },
    ],
    causes: [
      {
        id: 'tv-psu',
        name: 'Power supply board',
        check: 'Check the power board outputs (standby 5 V, main rails) and the fuse, and look for bulged capacitors.',
        carry: ['Power board (model specific)'],
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'standby', a: 'No', w: 4 },
          { q: 'surge', a: 'Yes', w: 2 },
        ],
        keywords: [[/dead|no power|not (turn|switch)ing on|surge|lightning/, 2]],
      },
      {
        id: 'tv-backlight',
        name: 'LED backlight strips',
        check: 'Torch test on the screen. Check the LED strips and the backlight driver.',
        carry: ['LED backlight strip set'],
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'picture', a: ['No picture', 'Very dim'], w: 3 },
          { q: 'sound', a: 'Yes', w: 2 },
          { q: 'standby', a: 'Yes', w: 1 },
        ],
        keywords: [[/dark|dim|black screen|sound but no picture|no picture/, 3]],
      },
      {
        id: 'tv-panel',
        name: 'Panel / T-con board / cable',
        check: 'Check the T-con board, the LVDS cable and the panel COF bonds.',
        carry: ['T-con board'],
        jobType: 'PCB / Electrical Repair',
        evidence: [{ q: 'picture', a: 'Lines / patches', w: 4 }],
        keywords: [[/line|patch|half screen|colou?r/, 3]],
      },
      {
        id: 'tv-main',
        name: 'Main board / software',
        check: 'Try a factory reset or software update, then check the main board.',
        carry: ['Main board (model specific)'],
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'picture', a: 'Stuck on logo / restarts', w: 4 },
          { q: 'remote', a: 'No', w: 1 },
        ],
        keywords: [[/logo|restart|reboot|hang|stuck|app/, 3]],
      },
      {
        id: 'tv-remote',
        name: 'Remote / IR receiver',
        check: 'Test the remote IR with a phone camera and check the IR receiver board.',
        selfHelp: 'Ask the customer to replace the remote batteries and try the buttons on the TV.',
        carry: ['Remote control'],
        jobType: 'Inspection / Diagnosis',
        evidence: [
          { q: 'remote', a: 'No', w: 3 },
          { q: 'picture', a: 'Normal', w: 2 },
        ],
        keywords: [[/remote/, 4]],
      },
      {
        id: 'tv-source',
        name: 'Input / antenna / decoder setup',
        check: 'Check the source selection, cables, antenna and decoder, and re-tune the channels.',
        selfHelp: 'Guide the customer to press SOURCE/INPUT and select the right HDMI/AV, and check the decoder cable.',
        jobType: 'Inspection / Diagnosis',
        evidence: [
          { q: 'signal', a: 'Yes', w: 4 },
          { q: 'picture', a: 'Normal', w: 1 },
        ],
        keywords: [[/no signal|channel|decoder|hdmi|antenna|dstv|gotv/, 3]],
      },
      {
        id: 'tv-audio',
        name: 'Speaker / audio circuit',
        check: 'Check the audio settings (external output), the speakers and the audio amplifier.',
        selfHelp: 'Ask the customer to check that mute is off and the sound output is set to TV speakers.',
        carry: ['Speaker set'],
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'sound', a: 'No', w: 3 },
          { q: 'picture', a: 'Normal', w: 2 },
        ],
        keywords: [[/no sound|sound|speaker|audio/, 3]],
      },
      {
        id: 'tv-damage',
        name: 'Physical / panel damage',
        check: 'Inspect for a cracked panel or liquid damage. Quote for the panel, which is usually out of warranty.',
        jobType: 'Inspection / Diagnosis',
        evidence: [{ q: 'damage', a: 'Yes', w: 5 }],
        keywords: [[/crack|broke|fell|drop|water/, 3]],
      },
    ],
  },

  // ---------------------------------------------------------- gas cookers
  cooker: {
    label: 'Gas cooker',
    questions: [
      { id: 'smell', text: 'Can the customer smell gas when the cooker is off?', options: YN },
      { id: 'spark', text: 'Does the ignition spark (clicking)?', options: ['Yes', 'No', 'Weak'] },
      { id: 'flame', text: 'How is the flame?', options: ['Normal blue', 'Yellow / sooty', 'Low / weak', 'Uneven', 'No flame'] },
      { id: 'goesout', text: 'Does the flame go out when the knob is released?', options: YN },
      { id: 'oven', text: 'Is the oven affected?', options: ['No', 'Not heating', 'Uneven heating'] },
      { id: 'knob', text: 'Are the knobs stiff or broken?', options: YN },
      { id: 'cylinder', text: 'Is the gas cylinder new / recently refilled?', options: YNU },
    ],
    urgent: [
      {
        q: 'smell',
        a: 'Yes',
        priority: 'Critical',
        advice: 'Safety first: ask the customer to close the cylinder valve, open the windows, avoid flames and electrical switches, and stay out until the technician arrives.',
      },
    ],
    causes: [
      {
        id: 'gc-leak',
        name: 'Gas leak: hose / regulator / valve',
        check: 'Soap test the hose, the regulator and the valve joints. Replace the hose and regulator if they are old or cracked.',
        carry: ['Gas hose', 'Regulator', 'Hose clamps', 'Thread seal'],
        jobType: 'Mechanical Repair',
        evidence: [{ q: 'smell', a: 'Yes', w: 6 }],
        keywords: [[/smell|leak|gas escap/, 4]],
      },
      {
        id: 'gc-ignition',
        name: 'Ignition unit / igniter / battery',
        check: 'Check the ignition battery (if any), the spark module, the electrodes and the switch.',
        selfHelp: 'Ask the customer to replace the ignition battery (if fitted) and dry the burners.',
        carry: ['Gas cooker ignition unit', 'Spark electrode'],
        jobType: 'PCB / Electrical Repair',
        evidence: [{ q: 'spark', a: ['No', 'Weak'], w: 4 }],
        keywords: [[/spark|ignit|click|light/, 3]],
      },
      {
        id: 'gc-burner',
        name: 'Clogged burner / jet / wrong jet',
        check: 'Clean the burner caps and jets, and check the jet size for LPG and the air shutter.',
        selfHelp: 'Ask the customer to clean the burner caps and make sure they are seated correctly.',
        carry: ['Jet set'],
        jobType: 'Preventive Maintenance',
        evidence: [
          { q: 'flame', a: ['Yellow / sooty', 'Uneven'], w: 4 },
          { q: 'flame', a: 'Low / weak', w: 1 },
        ],
        keywords: [[/yellow|soot|black|uneven|blocked/, 3]],
      },
      {
        id: 'gc-ffd',
        name: 'Thermocouple / flame-failure device',
        check: 'Check the thermocouple position and output, and the valve magnet unit.',
        carry: ['Thermocouple'],
        jobType: 'Mechanical Repair',
        evidence: [{ q: 'goesout', a: 'Yes', w: 5 }],
        keywords: [[/goes off|goes out|off when (i )?release/, 3]],
      },
      {
        id: 'gc-pressure',
        name: 'Regulator / low cylinder pressure',
        check: 'Check the cylinder level, the regulator outlet pressure and the hose for kinks.',
        selfHelp: 'Ask the customer to check that the cylinder has gas and the valve is fully open.',
        carry: ['Regulator'],
        jobType: 'Inspection / Diagnosis',
        evidence: [
          { q: 'flame', a: ['Low / weak', 'No flame'], w: 3 },
          { q: 'cylinder', a: 'No', w: 1 },
        ],
        keywords: [[/low flame|weak|cylinder|regulator/, 2]],
      },
      {
        id: 'gc-oven',
        name: 'Oven thermostat / element / oven burner',
        check: 'Check the oven thermostat, element or burner, and the fan (electric ovens).',
        carry: ['Oven thermostat', 'Oven element'],
        jobType: 'PCB / Electrical Repair',
        evidence: [{ q: 'oven', a: ['Not heating', 'Uneven heating'], w: 4 }],
        keywords: [[/oven|bake|grill/, 3]],
      },
      {
        id: 'gc-knob',
        name: 'Gas valve stiff / knob broken',
        check: 'Service or replace the valve spindle and knob. Grease the valve with gas-rated grease.',
        carry: ['Knob set', 'Gas valve'],
        jobType: 'Mechanical Repair',
        evidence: [{ q: 'knob', a: 'Yes', w: 4 }],
        keywords: [[/knob|stiff|hard to turn/, 3]],
      },
    ],
  },

  // ------------------------------------------------------------ microwaves
  microwave: {
    label: 'Microwave',
    questions: [
      { id: 'power', text: 'Does the display / light come on?', options: YN },
      { id: 'heat', text: 'Does it heat food?', options: ['Yes', 'No', 'Weakly'] },
      { id: 'turntable', text: 'Does the turntable rotate?', options: YN },
      { id: 'sparks', text: 'Sparks or arcing inside?', options: YN },
      { id: 'noise', text: 'Loud buzzing / humming noise?', options: YN },
      { id: 'door', text: 'Did it stop after closing the door hard, or does the door not latch?', options: YN },
      { id: 'buttons', text: 'Do some buttons not respond?', options: YN },
    ],
    urgent: [{ q: 'sparks', a: 'Yes', priority: 'High', advice: 'Ask the customer to stop using the microwave and unplug it.' }],
    causes: [
      {
        id: 'mw-magnetron',
        name: 'Magnetron',
        check: 'Check the magnetron filament and insulation. Replace it if open or shorted.',
        carry: ['Microwave magnetron'],
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'heat', a: ['No', 'Weakly'], w: 3 },
          { q: 'power', a: 'Yes', w: 1 },
          { q: 'turntable', a: 'Yes', w: 1 },
        ],
        keywords: [[/not heat|no heat|cold food/, 3]],
      },
      {
        id: 'mw-hv',
        name: 'High-voltage diode / capacitor / transformer',
        check: 'Check the HV diode, capacitor and transformer. Discharge the HV capacitor first.',
        carry: ['HV diode', 'HV capacitor'],
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'heat', a: 'No', w: 2 },
          { q: 'noise', a: 'Yes', w: 3 },
        ],
        keywords: [[/buzz|hum|loud/, 3]],
      },
      {
        id: 'mw-interlock',
        name: 'Door interlock switch / main fuse',
        check: 'Check the door switches, the monitor switch and the main fuse. Replace them as a set if blown.',
        carry: ['Door switch set', 'Fuse'],
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'power', a: 'No', w: 3 },
          { q: 'door', a: 'Yes', w: 4 },
        ],
        keywords: [[/door|dead|fuse|latch/, 3]],
      },
      {
        id: 'mw-turntable',
        name: 'Turntable motor / coupler',
        check: 'Check the turntable motor, the coupler and the roller ring.',
        carry: ['Turntable motor'],
        jobType: 'Mechanical Repair',
        evidence: [{ q: 'turntable', a: 'No', w: 4 }],
        keywords: [[/turntable|plate|rotat/, 3]],
      },
      {
        id: 'mw-waveguide',
        name: 'Waveguide cover burnt / arcing',
        check: 'Replace the mica waveguide cover, clean the cavity and check the paint.',
        carry: ['Waveguide cover (mica)'],
        jobType: 'Mechanical Repair',
        evidence: [{ q: 'sparks', a: 'Yes', w: 5 }],
        keywords: [[/spark|arc|fire|burn/, 3]],
      },
      {
        id: 'mw-panel',
        name: 'Control panel / membrane keypad',
        check: 'Check the membrane keypad and the control board.',
        carry: ['Membrane keypad', 'Control board'],
        jobType: 'PCB / Electrical Repair',
        evidence: [{ q: 'buttons', a: 'Yes', w: 4 }],
        keywords: [[/button|key|touch|panel/, 3]],
      },
    ],
  },

  other: {
    label: 'Other product',
    questions: [
      { id: 'power', text: 'Does it power on?', options: YN },
      { id: 'damage', text: 'Any physical or liquid damage?', options: YN },
      { id: 'surge', text: 'Was there a power surge / lightning before it failed?', options: YN },
    ],
    causes: [
      {
        id: 'ot-power',
        name: 'Power supply / fuse',
        check: 'Check the supply, cord, fuse and power board.',
        jobType: 'PCB / Electrical Repair',
        evidence: [
          { q: 'power', a: 'No', w: 3 },
          { q: 'surge', a: 'Yes', w: 2 },
        ],
        keywords: [[/dead|power|fuse|surge/, 2]],
      },
      {
        id: 'ot-damage',
        name: 'Physical / liquid damage',
        check: 'Inspect and quote; usually not covered by warranty.',
        jobType: 'Inspection / Diagnosis',
        evidence: [{ q: 'damage', a: 'Yes', w: 4 }],
        keywords: [[/broke|crack|water|fell/, 2]],
      },
    ],
  },
};

export function productGroup(category: ProductCategory): ProductGroup {
  switch (category) {
    case 'Residential AC':
    case 'Commercial AC':
    case 'VRF / VRV':
    case 'Chiller':
      return 'ac';
    case 'Refrigerator':
    case 'Chest Freezer':
      return 'fridge';
    case 'Washing Machine':
      return 'washer';
    case 'Television':
      return 'tv';
    case 'Gas Cooker':
      return 'cooker';
    case 'Microwave':
      return 'microwave';
    default:
      return 'other';
  }
}

export function questionnaire(category: ProductCategory): Question[] {
  return KB[productGroup(category)].questions;
}

export function causeById(id: string): Cause | undefined {
  for (const g of Object.values(KB)) {
    const c = g.causes.find((x) => x.id === id);
    if (c) return c;
  }
  return undefined;
}

export function causesFor(category: ProductCategory): Cause[] {
  return KB[productGroup(category)].causes;
}

export type Answers = Record<string, string>;

export interface Suggestion {
  cause: Cause;
  score: number;
  /** Share of total evidence among the listed suggestions, 0–100. */
  likelihood: number;
  reasons: string[];
  /** How many past jobs confirmed this cause. */
  confirmedBefore: number;
}

export interface Diagnosis {
  suggestions: Suggestion[];
  priority?: Priority;
  advice: string[];
}

function matches(answer: string | undefined, want: string | string[]): boolean {
  if (!answer || !answer.trim()) return false;
  if (want === '*') {
    const a = answer.trim().toLowerCase();
    return a !== 'no' && a !== 'none';
  }
  return Array.isArray(want) ? want.includes(answer) : answer === want;
}

const PRIORITY_RANK: Priority[] = ['Low', 'Normal', 'High', 'Critical'];

/**
 * Ranks likely causes from the questionnaire answers and the customer's words.
 * `confirmed` maps cause id → number of past closed jobs where technicians
 * confirmed it for this product group.
 */
export function diagnose(
  category: ProductCategory,
  answers: Answers,
  customerText: string,
  confirmed: Record<string, number> = {},
  limit = 4,
): Diagnosis {
  const group = KB[productGroup(category)];
  const text = customerText.toLowerCase();
  const questionText = new Map(group.questions.map((q) => [q.id, q.text]));

  const scored: Omit<Suggestion, 'likelihood'>[] = group.causes.map((cause) => {
    let score = 0;
    const reasons: string[] = [];
    for (const e of cause.evidence) {
      if (matches(answers[e.q], e.a)) {
        score += e.w;
        reasons.push(`${questionText.get(e.q)?.replace(/\?.*$/, '')}: ${answers[e.q]}`);
      }
    }
    for (const [re, w] of cause.keywords) {
      const m = text.match(re);
      if (m) {
        score += w;
        reasons.push(`customer said “${m[0]}”`);
      }
    }
    const seen = confirmed[cause.id] ?? 0;
    // Only lets history break ties among causes the call already supports.
    if (score > 0 && seen > 0) {
      score += Math.min(2, Math.log2(1 + seen));
      reasons.push(`confirmed on ${seen} earlier job${seen === 1 ? '' : 's'}`);
    }
    return { cause, score, reasons, confirmedBefore: seen };
  });

  const top = scored
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const total = top.reduce((t, s) => t + s.score, 0);
  const suggestions = top.map((s) => ({ ...s, likelihood: total ? Math.round((s.score / total) * 100) : 0 }));

  let priority: Priority | undefined;
  const advice: string[] = [];
  for (const u of group.urgent ?? []) {
    if (matches(answers[u.q], u.a)) {
      advice.push(u.advice);
      if (!priority || PRIORITY_RANK.indexOf(u.priority) > PRIORITY_RANK.indexOf(priority)) priority = u.priority;
    }
  }
  for (const s of suggestions.slice(0, 2)) {
    if (s.cause.selfHelp) advice.push(`Try on the call: ${s.cause.selfHelp}`);
  }
  return { suggestions, priority, advice };
}
