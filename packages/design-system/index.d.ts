/** Custom property name (e.g. `--s0`) to its CSS value. */
export type TokenMap = Record<`--${string}`, string>;

export interface Tokens {
  version: 1;
  source: string;
  themes: { base: TokenMap; dark: TokenMap; coarse: TokenMap; contrast: TokenMap };
}

declare const tokens: Tokens;
declare const cssString: string;

export { cssString, tokens };
export default { tokens, cssString };
