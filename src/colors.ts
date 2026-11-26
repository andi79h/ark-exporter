// Creature colours of ASE (game version 358): PrimalGameData ColorDefinitions and MasterDyeList.
//
// A creature keeps one colour ID per region in ColorSetIndices[0..5] (ByteProperty):
//   0          region unused (the property is left out of the save)
//   1..100     creature colours, ID = position in ColorDefinitions + 1 (1 = Red, 14 = Black)
//   201..226   dyes, ID = 201 + position in MasterDyeList
// Tamed creatures also keep ColorSetNames[0..5] (NameProperty). The game fills them with
// ColorDefinitions[ID], the colour one past the actual one (ID 13 Dark Grey is stored as "Black"),
// with "DyeIndex" for dyes and "Unused" past the end of the list. Wild creatures of a species carry
// exactly the IDs of its natural colours, so the IDs follow the table above and the names are off by one.
// Names as in arkutils/Obelisk data/asb/values.json (358.17); the game's spelling of a name can differ
// in case ("red", "Dragonfire"), names are case-insensitive.

export const COLOR_NAMES: readonly string[] = [
  'Red', 'Blue', 'Green', 'Yellow', 'Cyan', 'Magenta', 'Light Green', 'Light Grey', 'Light Brown', 'Light Orange',
  'Light Yellow', 'Light Red', 'Dark Grey', 'Black', 'Brown', 'Dark Green', 'Dark Red', 'White', 'Dino Light Red',
  'Dino Dark Red', 'Dino Light Orange', 'Dino Dark Orange', 'Dino Light Yellow', 'Dino Dark Yellow',
  'Dino Light Green', 'Dino Medium Green', 'Dino Dark Green', 'Dino Light Blue', 'Dino Dark Blue',
  'Dino Light Purple', 'Dino Dark Purple', 'Dino Light Brown', 'Dino Medium Brown', 'Dino Dark Brown',
  'Dino Darker Grey', 'Dino Albino', 'BigFoot0', 'BigFoot4', 'BigFoot5', 'WolfFur', 'DarkWolfFur', 'DragonBase0',
  'DragonBase1', 'DragonFire', 'DragonGreen0', 'DragonGreen1', 'DragonGreen2', 'DragonGreen3', 'WyvernPurple0',
  'WyvernPurple1', 'WyvernBlue0', 'WyvernBlue1', 'Dino Medium Blue', 'Dino Deep Blue', 'NearWhite', 'NearBlack',
  'DarkTurquoise', 'MediumTurquoise', 'Turquoise', 'GreenSlate', 'Sage', 'DarkWarmGray', 'MediumWarmGray',
  'LightWarmGray', 'DarkCement', 'LightCement', 'LightPink', 'DeepPink', 'DarkViolet', 'DarkMagenta', 'BurntSienna',
  'MediumAutumn', 'Vermillion', 'Coral', 'Orange', 'Peach', 'LightAutumn', 'Mustard', 'ActualBlack', 'MidnightBlue',
  'DarkBlue', 'BlackSands', 'LemonLime', 'Mint', 'Jade', 'PineGreen', 'SpruceGreen', 'LeafGreen', 'DarkLavender',
  'MediumLavender', 'Lavender', 'DarkTeal', 'MediumTeal', 'Teal', 'PowderBlue', 'Glacial', 'Cammo', 'DryMoss',
  'Custard', 'Cream',
];

export const DYE_NAMES: readonly string[] = [
  'Black Coloring', 'Blue Coloring', 'Brown Coloring', 'Cyan Coloring', 'Forest Coloring', 'Green Coloring',
  'Purple Coloring', 'Orange Coloring', 'Parchement Coloring', 'Pink Coloring', 'Purple Coloring', 'Red Coloring',
  'Royalty Coloring', 'Silver Coloring', 'Sky Coloring', 'Tan Coloring', 'Tangerine Coloring', 'White Coloring',
  'Yellow Coloring', 'Magenta Coloring', 'Brick Coloring', 'Cantaloupe Coloring', 'Mud Coloring', 'Navy Coloring',
  'Olive Coloring', 'Slate Coloring',
];

/**
 * Linear RGB of each colour as Dino Storage v2 writes it into the tooltip of a soul
 * (`<RichColor Color="r,g,b,1">[region:id]</>`), for 1..100 and the dyes 201..226. Taken from 34,745 souls
 * in the saves of a 15-map cluster (November 2026): every map gives the same value, except one whose mods
 * change the colour table (and one rounding difference). The tooltip only shows these; the game colours
 * the creature by ID.
 */
export const COLOR_LINEAR: Readonly<Record<number, string>> = {
  1: '1.0,0.0,0.0', 2: '0.0,0.0,1.0', 3: '0.0,1.0,0.0', 4: '1.0,1.0,0.0', 5: '0.0,1.0,1.0', 6: '1.0,0.0,1.0',
  7: '0.75637,1.0,0.735357', 8: '0.786396,0.797738,0.794275', 9: '0.473121,0.406406,0.347162',
  10: '1.0,0.709874,0.423583', 11: '1.0,0.978573,0.546854', 12: '1.0,0.462439,0.423583',
  13: '0.484529,0.484529,0.484529', 14: '0.220916,0.220916,0.220916', 15: '0.34919,0.217369,0.149434',
  16: '0.114026,0.282779,0.0', 17: '0.511668,0.108165,0.066844', 18: '1.0,1.0,1.0', 19: '1.0,0.665185,0.665185',
  20: '0.34919,0.151704,0.151704', 21: '1.0,0.718644,0.583831', 22: '0.537099,0.321261,0.171844',
  23: '0.797738,0.797738,0.634253', 24: '0.583831,0.583831,0.423583', 25: '0.880825,1.0,0.880825',
  26: '0.478868,0.583831,0.478868', 27: '0.114941,0.2478,0.114941', 28: '0.854306,0.880824,1.0',
  29: '0.213596,0.252997,0.388573', 30: '0.896244,0.854306,1.0', 31: '0.24441,0.189748,0.34919',
  32: '1.0,0.880825,0.735357', 33: '0.583831,0.527113,0.461356', 34: '0.34919,0.303532,0.2478',
  35: '0.34919,0.34919,0.34919', 36: '1.277043,1.277043,1.277043', 37: '0.722027,0.593,0.517964',
  38: '0.918737,0.856963,0.836888', 39: '0.818122,0.660154,0.585271', 40: '0.770482,0.707994,0.628172',
  41: '0.537099,0.467542,0.401256', 42: '0.634253,0.400783,0.288112', 43: '0.800691,0.476841,0.33317',
  44: '0.741905,0.308008,0.0', 45: '0.476235,0.522029,0.424114', 46: '0.570994,0.618031,0.475872',
  47: '0.653807,0.646445,0.54998', 48: '0.457511,0.580477,0.618031', 49: '0.474194,0.455654,0.592619',
  50: '0.695609,0.641499,0.757955', 51: '0.38478,0.510515,0.66142', 52: '0.278409,0.360021,0.461356',
  53: '0.374202,0.649649,0.918737', 54: '0.263678,0.408431,0.835078', 55: '0.930925,0.930925,0.930925',
  56: '0.313304,0.313304,0.313304', 57: '0.066663,0.262744,0.266666', 58: '0.0,0.443137,0.376471',
  59: '0.0,0.776471,0.67451', 60: '0.243138,0.34902,0.294117', 61: '0.235294,0.305882,0.243138',
  62: '0.223529,0.211763,0.207842', 63: '0.345097,0.329412,0.325489', 64: '0.611765,0.576471,0.568628',
  65: '0.317648,0.356862,0.337255', 66: '0.545098,0.635294,0.592157', 67: '0.909804,0.694117,1.0',
  68: '1.0,0.035297,0.607843', 69: '0.454901,0.0,0.270588', 70: '0.721568,0.0,0.250979',
  71: '0.498039,0.188236,0.094117', 72: '0.666667,0.17647,0.0', 73: '0.937255,0.180393,0.0',
  74: '1.0,0.345097,0.192155', 75: '1.0,0.501961,0.0', 76: '1.0,0.658824,0.219607', 77: '0.686275,0.443137,0.0',
  78: '0.584314,0.584314,0.137253', 79: '0.061009,0.061009,0.061009', 80: '0.07059,0.090195,0.200001',
  81: '0.054897,0.152943,0.215685', 82: '0.17647,0.125491,0.180393', 83: '0.662745,1.0,0.258823',
  84: '0.207842,0.913726,0.525491', 85: '0.0,0.537255,0.243138', 86: '0.027455,0.329412,0.164704',
  87: '0.0,0.356862,0.262744', 88: '0.356862,0.596079,0.125491', 89: '0.368627,0.137253,0.372548',
  90: '0.525491,0.196078,0.533333', 91: '0.745098,0.470589,0.74902', 92: '0.023527,0.243138,0.286275',
  93: '0.03137,0.329412,0.388236', 94: '0.047065,0.521569,0.615687', 95: '0.513726,0.658824,1.0',
  96: '0.678431,0.917647,1.0', 97: '0.309803,0.313726,0.066663', 98: '0.466667,0.435294,0.239215',
  99: '0.756862,0.745098,0.368627', 100: '0.956863,1.0,0.756862', 201: '0.099853,0.099853,0.099853',
  202: '0.0,0.0,1.0', 203: '0.461356,0.381092,0.2717', 204: '0.0,1.0,1.0', 205: '0.0,0.423583,0.0',
  206: '0.0,1.0,0.0', 207: '0.423583,0.0,0.735357', 208: '1.0,0.537099,0.0', 209: '1.0,1.0,0.735357',
  210: '1.0,0.484529,0.886004', 211: '0.484529,0.0,0.880825', 212: '1.0,0.0,0.0', 213: '0.484529,0.0,0.665185',
  214: '0.880825,0.880825,0.880825', 215: '0.735357,0.836007,1.0', 216: '1.0,0.928361,0.701411',
  217: '0.683609,0.395109,0.156992', 218: '0.995591,0.995591,0.995591', 219: '1.0,1.0,0.0',
  220: '0.906332,0.099853,0.854306', 221: '0.583831,0.189748,0.099853', 222: '1.0,0.609712,0.0',
  223: '0.2717,0.220916,0.151704', 224: '0.189748,0.189748,0.423583', 225: '0.735357,0.735357,0.34919',
  226: '0.34919,0.34919,0.34919',
};

export const FIRST_DYE = 201;
export const REGIONS = 6;

/** Name of a colour ID, null for 0 and unknown IDs. */
export function colorName(id: number): string | null {
  if (id >= 1 && id <= COLOR_NAMES.length) return COLOR_NAMES[id - 1];
  if (id >= FIRST_DYE && id < FIRST_DYE + DYE_NAMES.length) return DYE_NAMES[id - FIRST_DYE];
  return null;
}

/** 0 (unused), a creature colour or a dye. */
export const isKnownColor = (id: number): boolean => id === 0 || colorName(id) !== null;

/** What the game stores in ColorSetNames for a colour ID (see the note at the top). */
export function storedColorSetName(id: number): string {
  if (id >= FIRST_DYE) return 'DyeIndex';
  return COLOR_NAMES[id] ?? 'Unused';
}
