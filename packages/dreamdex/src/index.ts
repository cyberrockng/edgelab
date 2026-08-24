import { DREAMDEX_MARKETS_SDK_VERSION, SOMNIA_SHANNON_CHAIN_ID } from "@edgelab/domain";

export interface DreamDexReadConfig {
  readonly rpcUrl: string;
  readonly indexerUrl: string;
  readonly chainId: number;
  readonly sdkVersion: string;
}

export function validateDreamDexReadConfig(config: DreamDexReadConfig): DreamDexReadConfig {
  if (config.chainId !== SOMNIA_SHANNON_CHAIN_ID) {
    throw new Error(`DreamDEX reads must target Somnia Shannon chain ${String(SOMNIA_SHANNON_CHAIN_ID)}`);
  }
  if (config.sdkVersion !== DREAMDEX_MARKETS_SDK_VERSION) {
    throw new Error(`DreamDEX SDK must be pinned to ${DREAMDEX_MARKETS_SDK_VERSION}`);
  }
  return config;
}

export const dreamDexBoundaries = {
  writes: "browser-wallet-human-gated-only",
  historicalReplay: "forbidden",
  fabricatedFills: "forbidden"
} as const;
