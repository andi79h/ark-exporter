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
