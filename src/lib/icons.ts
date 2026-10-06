import { PALETTE } from "@/types";

export { PALETTE };

export const paletteColor = (i: number) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];
export const colorFor = paletteColor;
