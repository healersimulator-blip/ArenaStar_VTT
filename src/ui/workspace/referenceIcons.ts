import { faUser, faCrosshairs, faExpand, faRulerCombined, faPen, faLayerGroup, faDoorOpen,
  faLightbulb, faMusic, faMapPin, faShapes, faDiceD20, faComments, faUsers, faBookOpen,
  faFolderOpen, faImage, faList, faWandMagicSparkles, faGear, faChevronLeft, faChevronRight,
  faChevronDown, faEllipsis, faBars, faMagnifyingGlass, faArrowPointer, faHand, faSquare,
  faPalette, faArrowRotateLeft, faArrowRotateRight, faPlus, faFileExport, faXmark,
  faTableCellsLarge, faCloud, faMountain, faStairs, faVolumeHigh, faVolumeXmark } from "@fortawesome/free-solid-svg-icons";
export const referenceIcons: Record<string, typeof faUser> = {
  tokens: faUser, actors: faUsers, select: faArrowPointer, pan: faHand, measure: faRulerCombined,
  draw: faPen, text: faPen, wall: faDoorOpen, light: faLightbulb, lighting: faLightbulb,
  map: faLayerGroup, images: faImage, playlists: faMusic, sounds: faMusic, pin: faMapPin,
  raised: faMountain, stairs: faStairs, placeables: faShapes, dice: faDiceD20, chat: faComments,
  combat: faCrosshairs, journals: faBookOpen, compendia: faBookOpen, scenes: faFolderOpen,
  tables: faList, macros: faWandMagicSparkles, macro: faWandMagicSparkles, settings: faGear,
  more: faEllipsis, menu: faBars, search: faMagnifyingGlass, layout: faTableCellsLarge,
  chevronLeft: faChevronLeft, chevronRight: faChevronRight, chevronDown: faChevronDown,
  gm: faUser, fog: faCloud, fit: faExpand, palette: faPalette, undo: faArrowRotateLeft,
  redo: faArrowRotateRight, addToken: faPlus, export: faFileExport, x: faXmark, close: faXmark,
  square: faSquare, volume: faVolumeHigh, muted: faVolumeXmark,
};
