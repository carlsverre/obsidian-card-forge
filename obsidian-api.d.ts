import "obsidian";

declare module "obsidian" {
  interface Vault {
    getConfig<T = unknown>(key: string): T | undefined;
  }
}
